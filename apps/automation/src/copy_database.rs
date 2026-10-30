use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize)]
pub struct Evidence {
    pub bytes: u64,
    pub sha256: String,
}

pub struct Backup {
    file: File,
    source: String,
    pub evidence: Evidence,
}

fn identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn verify(file: &mut File) -> Result<Evidence> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Backup is unavailable")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Unable to verify backup")?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or("Backup size overflow")?;
        hash.update(&buffer[..count]);
    }
    if bytes == 0 {
        return Err("The database backup is empty".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Backup is unavailable")?;
    Ok(Evidence {
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn run(mut command: Command, timeout: Duration, script: Option<&[u8]>) -> Result<()> {
    command.stderr(Stdio::null()).process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Unable to launch database operation")?;
    let outcome = (|| {
        if let Some(script) = script {
            child
                .stdin
                .take()
                .ok_or("Database script input unavailable")?
                .write_all(script)
                .map_err(|_| "Unable to send database operation")?;
        }
        let started = Instant::now();
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Unable to observe database operation")?
            {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Database operation failed; reconciliation is required".into())
                };
            }
            if started.elapsed() >= timeout {
                return Err("Database operation timed out; reconciliation is required".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if outcome.is_err() && !matches!(child.try_wait(), Ok(Some(_))) {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.wait();
    }
    outcome
}

pub fn capture(docker: &Path, source: &str, directory: &Path, timeout: Duration) -> Result<Backup> {
    if !docker.is_absolute() || !identity(source) {
        return Err("Invalid approved database identity".into());
    }
    let metadata =
        fs::symlink_metadata(directory).map_err(|_| "Private backup directory unavailable")?;
    if !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("Backup directory must be private and owned by the executor".into());
    }
    let partial = directory.join("database.sql.partial");
    let complete = directory.join("database.sql");
    if fs::symlink_metadata(&complete).is_ok() {
        return Err("Backup already exists".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&partial)
        .map_err(|_| "Unable to reserve private backup")?;
    let mut command = Command::new(docker);
    command
        .args(["exec", "-i", source, "sh", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::from(
            file.try_clone().map_err(|_| "Backup output unavailable")?,
        ));
    run(
        command,
        timeout,
        Some(include_bytes!("../recipes/files/mysql-backup.sh")),
    )?;
    file.sync_all()
        .map_err(|_| "Unable to persist database backup")?;
    let evidence = verify(&mut file)?;
    fs::hard_link(&partial, &complete).map_err(|_| "Unable to publish verified backup")?;
    fs::remove_file(&partial).map_err(|_| "Unable to finish database backup")?;
    File::open(directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "Unable to persist backup directory")?;
    Ok(Backup {
        file,
        source: source.into(),
        evidence,
    })
}

impl Backup {
    pub fn restore(&mut self, docker: &Path, destination: &str, timeout: Duration) -> Result<()> {
        if !docker.is_absolute() || !identity(destination) || destination == self.source {
            return Err("Restore requires an independent approved database container".into());
        }
        let actual = verify(&mut self.file)?;
        if actual.sha256 != self.evidence.sha256 || actual.bytes != self.evidence.bytes {
            return Err("Backup changed after verification".into());
        }
        let mut command = Command::new(docker);
        command
            .args([
                "exec",
                "-i",
                destination,
                "sh",
                "-c",
                include_str!("../recipes/files/mysql-restore.sh"),
            ])
            .stdin(Stdio::from(
                self.file
                    .try_clone()
                    .map_err(|_| "Backup input unavailable")?,
            ))
            .stdout(Stdio::null());
        run(command, timeout, None)
    }
}

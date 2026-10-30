use crate::{
    copy_database, copy_files,
    copy_model::{self, CopySpec, DatabaseCredentials, PreparedCopy},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub preview: copy_model::CopyPreview,
    pub source_database_id: String,
    pub configuration_sha256: String,
    pub files_sha256: String,
    pub specification_sha256: String,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Preparing,
    BackingUp,
    BackupVerified,
    CopyingFiles,
    FilesVerified,
    ConfigurationWritten,
    RestoringDatabase,
    DatabaseRestored,
    Failed,
}

#[derive(Serialize)]
struct Event<'a> {
    phase: Phase,
    time: u64,
    evidence: Option<&'a Evidence>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Evidence {
    Review {
        approval_sha256: String,
    },
    Backup {
        bytes: u64,
        sha256: String,
    },
    Files {
        files: u64,
        bytes: u64,
        sha256: String,
    },
    Configuration {
        project: String,
        database_service: String,
        web_service: String,
    },
}

pub struct PreparedOperation {
    directory: PathBuf,
    sequence: usize,
    phase: Phase,
    backup: copy_database::Backup,
    pub prepared: PreparedCopy,
}

pub struct Preparation<'a> {
    pub docker: &'a Path,
    pub operations: &'a Path,
    pub operation_id: &'a str,
    pub source: &'a Value,
    pub spec: &'a CopySpec,
    pub review: &'a Review,
    pub approved_hash: &'a str,
    pub timeout: Duration,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn json_hash(value: &impl Serialize) -> Result<String> {
    serde_json::to_vec(value)
        .map(|bytes| hash(&bytes))
        .map_err(|_| "Unable to fingerprint copy review".into())
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| "Copy clock unavailable".into())
}
fn database_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn destination_absent(spec: &CopySpec) -> Result<()> {
    if spec
        .source_root
        .canonicalize()
        .map_err(|_| "Source project unavailable")?
        != spec.source_root
    {
        return Err("The approved source root must be canonical".into());
    }
    let compose = fs::symlink_metadata(spec.source_root.join("app/docker-compose.yml"))
        .map_err(|_| "The initial adapter requires app/docker-compose.yml")?;
    if !compose.is_file() || compose.file_type().is_symlink() {
        return Err("The source Compose file must be a regular project file".into());
    }
    let destination = spec
        .source_root
        .parent()
        .ok_or("Invalid source project")?
        .join(&spec.destination_domain);
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("Copy destination already exists or is unavailable".into()),
    }
}

pub fn review(source: &Value, spec: &CopySpec, source_database_id: &str) -> Result<Review> {
    if !database_id(source_database_id) {
        return Err("An immutable source database identity is required".into());
    }
    let credentials = DatabaseCredentials::generate(&spec.destination_domain)?;
    let prepared = copy_model::prepare(source, spec, &credentials)?;
    destination_absent(spec)?;
    let snapshot = copy_files::inspect(&spec.source_root)?;
    Ok(Review {
        preview: prepared.preview,
        source_database_id: source_database_id.into(),
        configuration_sha256: json_hash(source)?,
        files_sha256: snapshot.summary.digest,
        specification_sha256: json_hash(spec)?,
        expires_at: now()?.checked_add(600).ok_or("Copy clock overflow")?,
    })
}

pub fn approval(review: &Review) -> Result<String> {
    json_hash(review)
}

fn private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Copy operation storage unavailable")?;
    if !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("Copy operation storage must be private and owned by the executor".into());
    }
    Ok(())
}
fn private_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Copy operation record already exists or is unavailable".into())
}
fn event(
    directory: &Path,
    sequence: usize,
    phase: Phase,
    evidence: Option<&Evidence>,
) -> Result<()> {
    let path = directory.join(format!("{sequence:04}.json"));
    let pending = path.with_extension("pending");
    let mut file = private_file(&pending)?;
    serde_json::to_writer(
        &mut file,
        &Event {
            phase,
            time: now()?,
            evidence,
        },
    )
    .map_err(|_| "Unable to write copy operation event")?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| "Unable to persist copy operation event")?;
    fs::hard_link(&pending, &path)
        .map_err(|_| "Copy event already exists or cannot be published")?;
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Unable to persist copy operation history")?;
    fs::remove_file(pending).map_err(|_| "Unable to finish copy operation event".into())
}

pub fn prepare(input: Preparation<'_>) -> Result<PreparedOperation> {
    let Preparation {
        docker,
        operations,
        operation_id,
        source,
        spec,
        review,
        approved_hash,
        timeout,
    } = input;
    if operation_id.is_empty()
        || operation_id.len() > 64
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid copy operation identity".into());
    }
    if !database_id(&review.source_database_id)
        || approval(review)? != approved_hash
        || review.expires_at <= now()?
        || review.expires_at > now()?.saturating_add(600)
    {
        return Err("Copy review is invalid or expired".into());
    }
    if json_hash(source)? != review.configuration_sha256
        || json_hash(spec)? != review.specification_sha256
    {
        return Err("Copy configuration changed after review".into());
    }
    let credentials = DatabaseCredentials::generate(&spec.destination_domain)?;
    let prepared = copy_model::prepare(source, spec, &credentials)?;
    if prepared.preview != review.preview {
        return Err("Copy destination resources changed after review".into());
    }
    destination_absent(spec)?;
    let snapshot = copy_files::inspect(&spec.source_root)?;
    if snapshot.summary.digest != review.files_sha256 {
        return Err("Source files changed after review".into());
    }
    private_directory(operations)?;
    let directory = operations.join(operation_id);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "Copy operation already exists or cannot be reserved".to_string())?;
    File::open(operations)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Unable to persist copy reservation")?;
    let mut sequence = 0;
    let mut record = |phase, evidence: Option<&Evidence>| {
        event(&directory, sequence, phase, evidence)?;
        sequence += 1;
        Ok::<(), String>(())
    };
    let result = (|| {
        record(
            Phase::Preparing,
            Some(&Evidence::Review {
                approval_sha256: approved_hash.into(),
            }),
        )?;
        record(Phase::BackingUp, None)?;
        let backup =
            copy_database::capture(docker, &review.source_database_id, &directory, timeout)?;
        record(
            Phase::BackupVerified,
            Some(&Evidence::Backup {
                bytes: backup.evidence.bytes,
                sha256: backup.evidence.sha256.clone(),
            }),
        )?;
        record(Phase::CopyingFiles, None)?;
        let copied = copy_files::copy(
            &snapshot,
            spec.source_root.parent().ok_or("Invalid project parent")?,
            &spec.destination_domain,
        )?;
        record(
            Phase::FilesVerified,
            Some(&Evidence::Files {
                files: copied.files,
                bytes: copied.bytes,
                sha256: copied.digest,
            }),
        )?;
        let mut config = private_file(&directory.join("compose.json"))?;
        prepared.write_private_compose(&mut config)?;
        config
            .sync_all()
            .map_err(|_| "Unable to persist destination configuration")?;
        let mut cloned_config = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(
                prepared
                    .preview
                    .destination_root
                    .join("app/docker-compose.yml"),
            )
            .map_err(|_| "Copied Compose file unavailable")?;
        let metadata = cloned_config
            .metadata()
            .map_err(|_| "Copied Compose file unavailable")?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("Copied Compose file must be private to the destination".into());
        }
        if (metadata.uid() != unsafe { libc::geteuid() }
            || metadata.gid() != unsafe { libc::getegid() })
            && unsafe { libc::fchown(cloned_config.as_raw_fd(), libc::geteuid(), libc::getegid()) }
                != 0
        {
            return Err("Unable to isolate destination database credentials".into());
        }
        cloned_config
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "Unable to protect destination configuration")?;
        cloned_config
            .set_len(0)
            .map_err(|_| "Unable to replace copied Compose configuration")?;
        prepared.write_private_compose(&mut cloned_config)?;
        cloned_config
            .sync_all()
            .map_err(|_| "Unable to persist copied Compose configuration")?;
        record(
            Phase::ConfigurationWritten,
            Some(&Evidence::Configuration {
                project: prepared.preview.compose_project.clone(),
                database_service: prepared.preview.database_service.clone(),
                web_service: prepared.preview.web_service.clone(),
            }),
        )?;
        Ok(backup)
    })();
    match result {
        Ok(backup) => Ok(PreparedOperation {
            directory,
            sequence,
            phase: Phase::ConfigurationWritten,
            backup,
            prepared,
        }),
        Err(error) => {
            let _ = event(&directory, sequence, Phase::Failed, None);
            Err(error)
        }
    }
}

impl PreparedOperation {
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    pub fn restore(
        &mut self,
        docker: &Path,
        destination_database_id: &str,
        timeout: Duration,
    ) -> Result<()> {
        if self.phase != Phase::ConfigurationWritten {
            return Err("Database restoration cannot be replayed".into());
        }
        event(
            &self.directory,
            self.sequence,
            Phase::RestoringDatabase,
            None,
        )?;
        self.sequence += 1;
        self.phase = Phase::RestoringDatabase;
        if let Err(error) = self
            .backup
            .restore(docker, destination_database_id, timeout)
        {
            self.phase = Phase::Failed;
            let _ = event(&self.directory, self.sequence, Phase::Failed, None);
            return Err(error);
        }
        event(
            &self.directory,
            self.sequence,
            Phase::DatabaseRestored,
            None,
        )?;
        self.sequence += 1;
        self.phase = Phase::DatabaseRestored;
        Ok(())
    }
}

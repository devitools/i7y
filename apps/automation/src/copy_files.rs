use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, DirBuilderExt, MetadataExt, OpenOptions, OpenOptionsExt},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom},
    os::unix::{
        fs::{MetadataExt as StdMetadataExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

pub type Result<T> = std::result::Result<T, String>;
struct Entry {
    path: PathBuf,
    directory: bool,
    mode: u32,
    size: u64,
    digest: String,
    uid: u32,
    gid: u32,
    modified: SystemTime,
}
#[derive(Clone, Debug, Serialize)]
pub struct Summary {
    pub files: u64,
    pub directories: u64,
    pub bytes: u64,
    pub digest: String,
}
pub struct Snapshot {
    root: PathBuf,
    source: Dir,
    entries: Vec<Entry>,
    pub summary: Summary,
}

fn file_hash(mut file: impl Read) -> Result<String> {
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let read = file
            .read(&mut bytes)
            .map_err(|_| "Unable to read project file")?;
        if read == 0 {
            break;
        }
        hash.update(&bytes[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn open(path: &Path) -> Result<Dir> {
    Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|_| "Unable to open approved project directory".into())
}
fn source_file(root: &Dir, path: &Path) -> Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    let file = root
        .open_with(path, &options)
        .map_err(|_| "Project file escaped its root or changed type")?;
    if !file
        .metadata()
        .map_err(|_| "Project file unavailable")?
        .is_file()
    {
        return Err("Only regular project files can be copied".into());
    }
    Ok(file)
}
fn preserve(file: &std::fs::File, entry: &Entry) -> Result<()> {
    let metadata = file
        .metadata()
        .map_err(|_| "Unable to inspect copied file ownership")?;
    if (metadata.uid() != entry.uid || metadata.gid() != entry.gid)
        && unsafe { libc::fchown(file.as_raw_fd(), entry.uid, entry.gid) } != 0
    {
        return Err("Unable to preserve project ownership".into());
    }
    file.set_permissions(std::fs::Permissions::from_mode(entry.mode))
        .map_err(|_| "Unable to preserve project permissions")?;
    file.set_times(std::fs::FileTimes::new().set_modified(entry.modified))
        .map_err(|_| "Unable to preserve project modification time")?;
    file.sync_all()
        .map_err(|_| "Unable to persist copied project metadata".into())
}
fn directory_file(directory: &Dir) -> Result<std::fs::File> {
    directory
        .open(".")
        .map(|file| file.into_std())
        .map_err(|_| "Unable to open directory for durable metadata updates".into())
}
fn inspect_entries(
    source: &Dir,
    relative: &Path,
    entries: &mut Vec<Entry>,
    summary: &mut Summary,
) -> Result<()> {
    let mut children = (if relative.as_os_str().is_empty() {
        source.entries()
    } else {
        source.read_dir(relative)
    })
    .map_err(|_| "Unable to inspect project files")?
    .collect::<std::io::Result<Vec<_>>>()
    .map_err(|_| "Unable to inspect project entry")?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        if entries.len() >= 1_000_000 {
            return Err("Project contains too many files for this adapter".into());
        }
        let path = relative.join(child.file_name());
        let metadata = source
            .symlink_metadata(&path)
            .map_err(|_| "Project changed during inspection")?;
        if metadata.is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err("Symbolic links and special files require a dedicated copy adapter".into());
        }
        if metadata.mode() & 0o6000 != 0 {
            return Err("Privileged file modes are not supported".into());
        }
        if path.to_str().is_none() {
            return Err("Project paths must be UTF-8".into());
        }
        let directory = metadata.is_dir();
        let size = if directory { 0 } else { metadata.len() };
        let digest = if directory {
            String::new()
        } else {
            file_hash(source_file(source, &path)?)?
        };
        if directory {
            summary.directories += 1;
        } else {
            summary.files += 1;
            summary.bytes = summary
                .bytes
                .checked_add(size)
                .ok_or("Project size overflow")?;
        }
        entries.push(Entry {
            path: path.clone(),
            directory,
            mode: metadata.mode() & 0o777,
            size,
            digest,
            uid: metadata.uid(),
            gid: metadata.gid(),
            modified: metadata
                .modified()
                .map_err(|_| "Unable to inspect project timestamp")?
                .into_std(),
        });
        if directory {
            inspect_entries(source, &path, entries, summary)?;
        }
    }
    Ok(())
}
pub fn inspect(source_root: &Path) -> Result<Snapshot> {
    if source_root.file_name().is_none() {
        return Err("The filesystem root is not a project".into());
    }
    let root = source_root
        .canonicalize()
        .map_err(|_| "Source project unavailable")?;
    let source = open(&root)?;
    let mut entries = Vec::new();
    let mut summary = Summary {
        files: 0,
        directories: 0,
        bytes: 0,
        digest: String::new(),
    };
    inspect_entries(&source, Path::new(""), &mut entries, &mut summary)?;
    let mut hash = Sha256::new();
    for entry in &entries {
        let path = entry
            .path
            .to_str()
            .ok_or("Invalid project path")?
            .as_bytes();
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path);
        hash.update([u8::from(entry.directory)]);
        hash.update(entry.mode.to_be_bytes());
        hash.update(entry.uid.to_be_bytes());
        hash.update(entry.gid.to_be_bytes());
        let modified = entry
            .modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Unsupported project timestamp")?;
        hash.update(modified.as_nanos().to_be_bytes());
        hash.update(entry.size.to_be_bytes());
        hash.update(entry.digest.as_bytes());
    }
    summary.digest = format!("{:x}", hash.finalize());
    Ok(Snapshot {
        root,
        source,
        entries,
        summary,
    })
}
pub fn copy(
    snapshot: &Snapshot,
    destination_parent: &Path,
    destination_name: &str,
) -> Result<Summary> {
    let leaf = Path::new(destination_name);
    if leaf.components().count() != 1
        || !matches!(leaf.components().next(), Some(Component::Normal(_)))
        || destination_name.contains(['\0', '\n', '\r', '/', '\\'])
    {
        return Err("Invalid destination directory name".into());
    }
    let parent = destination_parent
        .canonicalize()
        .map_err(|_| "Approved destination parent unavailable")?;
    if parent.starts_with(&snapshot.root) {
        return Err("The destination cannot be inside the source project".into());
    }
    let parent = open(&parent)?;
    match parent.symlink_metadata(leaf) {
        Ok(_) => return Err("Destination already exists".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Unable to inspect destination".into()),
    }
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    parent
        .create_dir_with(leaf, &builder)
        .map_err(|_| "Unable to reserve destination directory")?;
    directory_file(&parent)?
        .sync_all()
        .map_err(|_| "Unable to persist destination reservation")?;
    let destination = parent
        .open_dir(leaf)
        .map_err(|_| "Unable to open reserved destination")?;
    for entry in &snapshot.entries {
        let current = snapshot
            .source
            .symlink_metadata(&entry.path)
            .map_err(|_| "Project changed after inspection")?;
        if current.is_symlink()
            || current.is_dir() != entry.directory
            || (!entry.directory && !current.is_file())
        {
            return Err("Project changed after inspection; destination remains reserved".into());
        }
        if entry.directory {
            destination
                .create_dir(&entry.path)
                .map_err(|_| "Unable to create destination directory")?;
        } else {
            let mut input = source_file(&snapshot.source, &entry.path)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true).mode(0o600);
            let mut file = destination
                .open_with(&entry.path, &options)
                .map_err(|_| "Unable to reserve destination file")?;
            std::io::copy(&mut input, &mut file)
                .map_err(|_| "Unable to copy project file within approved roots")?;
            file.seek(SeekFrom::Start(0))
                .map_err(|_| "Unable to verify copied bytes")?;
            if file
                .metadata()
                .map_err(|_| "Unable to inspect copied file")?
                .len()
                != entry.size
                || file_hash(&mut file)? != entry.digest
            {
                return Err("Project changed after inspection; copied bytes do not match".into());
            }
            preserve(&file.into_std(), entry)?;
        }
    }
    for entry in snapshot.entries.iter().rev().filter(|e| e.directory) {
        let handle = destination
            .open_dir(&entry.path)
            .map_err(|_| "Unable to open copied directory")?;
        let directory = directory_file(&handle)?;
        preserve(&directory, entry)?;
    }
    directory_file(&destination)?
        .sync_all()
        .map_err(|_| "Unable to persist copied project")?;
    if inspect(&snapshot.root)?.summary.digest != snapshot.summary.digest {
        return Err("Source changed during copy; destination remains private".into());
    }
    Ok(snapshot.summary.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::symlink,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "i7y-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("source.example.com/app/public/empty")).unwrap();
            fs::create_dir_all(root.join("source.example.com/.security")).unwrap();
            fs::write(
                root.join("source.example.com/app/public/index.php"),
                b"<?php echo 'example';",
            )
            .unwrap();
            fs::write(
                root.join("source.example.com/app/public/image.bin"),
                [0u8, 255, 17, 0],
            )
            .unwrap();
            fs::write(
                root.join("source.example.com/.security/php.ini"),
                b"session.cookie_httponly=1",
            )
            .unwrap();
            Self(root)
        }
        fn source(&self) -> PathBuf {
            self.0.join("source.example.com")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn copies_files_hidden_configuration_modes_timestamps_and_empty_directories() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let readonly = source.join(".security/php.ini");
        fs::set_permissions(&readonly, fs::Permissions::from_mode(0o444)).unwrap();
        let snapshot = inspect(&source).unwrap();
        let before = snapshot.summary.digest.clone();
        let report = copy(&snapshot, &fixture.0, "copy.example.com").unwrap();
        assert_eq!(report.files, 3);
        assert_eq!(report.digest, before);
        let target = fixture.0.join("copy.example.com");
        assert_eq!(
            fs::read(target.join("app/public/image.bin")).unwrap(),
            [0u8, 255, 17, 0]
        );
        assert!(target.join("app/public/empty").is_dir());
        assert_eq!(
            fs::metadata(target.join(".security/php.ini"))
                .unwrap()
                .mode()
                & 0o777,
            0o444
        );
        assert_eq!(
            fs::metadata(&readonly).unwrap().modified().unwrap(),
            fs::metadata(target.join(".security/php.ini"))
                .unwrap()
                .modified()
                .unwrap()
        );
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o700);
        assert_eq!(inspect(&source).unwrap().summary.digest, before);
    }
    #[test]
    fn refuses_existing_destinations_traversal_and_copying_inside_source() {
        let fixture = Fixture::new();
        let snapshot = inspect(&fixture.source()).unwrap();
        fs::create_dir(fixture.0.join("existing")).unwrap();
        fs::write(fixture.0.join("existing/marker"), b"unchanged").unwrap();
        assert!(copy(&snapshot, &fixture.0, "existing").is_err());
        assert_eq!(
            fs::read(fixture.0.join("existing/marker")).unwrap(),
            b"unchanged"
        );
        for name in ["../escaped", "/absolute", ".", "..", "nested/copy"] {
            assert!(copy(&snapshot, &fixture.0, name).is_err());
        }
        assert!(copy(&snapshot, &fixture.source(), "copy.example.com").is_err());
    }
    #[test]
    fn changed_source_cannot_be_reported_as_a_successful_copy() {
        let fixture = Fixture::new();
        let snapshot = inspect(&fixture.source()).unwrap();
        fs::write(
            fixture.source().join("app/public/index.php"),
            b"modified after review",
        )
        .unwrap();
        let error = copy(&snapshot, &fixture.0, "copy.example.com").unwrap_err();
        assert!(error.contains("copied bytes"));
        assert!(fixture
            .0
            .join("copy.example.com/.security/php.ini")
            .exists());
        assert_eq!(
            fs::metadata(fixture.0.join("copy.example.com"))
                .unwrap()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::read(fixture.source().join("app/public/index.php")).unwrap(),
            b"modified after review"
        );
    }
    #[test]
    fn symlinks_special_files_and_post_inspection_escapes_are_rejected() {
        let fixture = Fixture::new();
        let path = fixture.source().join("app/public/index.php");
        let snapshot = inspect(&fixture.source()).unwrap();
        fs::write(fixture.0.join("outside-secret"), b"must stay outside").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(fixture.0.join("outside-secret"), &path).unwrap();
        assert!(inspect(&fixture.source()).is_err());
        let result = copy(&snapshot, &fixture.0, "copy.example.com");
        assert!(result.is_err());
        assert!(fixture
            .0
            .join("copy.example.com/.security/php.ini")
            .exists());
        assert!(!fixture
            .0
            .join("copy.example.com/app/public/index.php")
            .exists());
        assert_eq!(
            fs::read(fixture.0.join("outside-secret")).unwrap(),
            b"must stay outside"
        );
        fs::remove_file(&path).unwrap();
        let socket = std::os::unix::net::UnixListener::bind(fixture.source().join("s")).unwrap();
        assert!(inspect(&fixture.source()).is_err());
        drop(socket);
    }
}

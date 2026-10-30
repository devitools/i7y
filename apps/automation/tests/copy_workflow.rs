#![cfg(unix)]
use i7y_automation::{
    copy_files,
    copy_model::CopySpec,
    copy_workflow::{self, Preparation, Review},
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, PermissionsExt},
        io::AsRawFd,
    },
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    spec: CopySpec,
    model: Value,
    docker: PathBuf,
}
impl Fixture {
    fn new(body: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "i7y-workflow-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        let root = path.canonicalize().unwrap();
        let source = root.join("source.example.com");
        fs::create_dir_all(source.join("app/public")).unwrap();
        fs::write(
            source.join("app/public/wp-config.php"),
            "source application configuration",
        )
        .unwrap();
        fs::write(
            source.join("app/docker-compose.yml"),
            "source Compose credentials",
        )
        .unwrap();
        let model = json!({"services":{
            "source-db":{"image":"mysql:5.7","environment":{"MYSQL_DATABASE":"source_db","MYSQL_USER":"source_user","MYSQL_PASSWORD":"source-application-secret","MYSQL_ROOT_PASSWORD":"source-root-secret"},"volumes":["data:/var/lib/mysql"],"networks":["internal"]},
            "source-web":{"image":"example/php:8.3","environment":{"MYSQL_PASSWORD":"source-application-secret","WEB_DOCUMENT_ROOT":"/var/www/app/public"},"volumes":[format!("{}:/var/www/app:rw", source.join("app").display())],"networks":["internal"]}
        },"volumes":{"data":{}},"networks":{"internal":{"driver":"bridge"}}});
        let docker = root.join("docker");
        fs::write(
            &docker,
            format!("#!/bin/sh\nprintf 'called\\n' >> \"$0.calls\"\ncat >/dev/null\n{body}\n"),
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        let spec = CopySpec {
            source_root: source,
            source_domain: "source.example.com".into(),
            destination_domain: "copy.example.com".into(),
            database_image_id: format!("sha256:{}", "a".repeat(64)),
            web_image_id: format!("sha256:{}", "b".repeat(64)),
        };
        Self {
            root,
            spec,
            model,
            docker,
        }
    }
    fn review(&self) -> Review {
        copy_workflow::review(&self.model, &self.spec, &"a".repeat(64)).unwrap()
    }
    fn prepare(&self, review: &Review) -> Result<copy_workflow::PreparedOperation, String> {
        copy_workflow::prepare(Preparation {
            docker: &self.docker,
            operations: &self.root,
            operation_id: "operation01",
            source: &self.model,
            spec: &self.spec,
            review,
            approved_hash: &copy_workflow::approval(review).unwrap(),
            timeout: Duration::from_secs(2),
        })
    }
    fn events(&self) -> Vec<Value> {
        let mut paths: Vec<_> = fs::read_dir(self.root.join("operation01"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
                    && path.file_name().unwrap() != "compose.json"
            })
            .collect();
        paths.sort();
        paths
            .into_iter()
            .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn connected_backup_files_configuration_and_restore_have_private_immutable_evidence() {
    let fixture = Fixture::new("printf 'SQL fixture backup'");
    if unsafe { libc::geteuid() } == 0 {
        let source_config =
            fs::File::open(fixture.spec.source_root.join("app/docker-compose.yml")).unwrap();
        assert_eq!(
            unsafe { libc::fchown(source_config.as_raw_fd(), 1000, 1000) },
            0
        );
    }
    let review = fixture.review();
    let before = copy_files::inspect(&fixture.spec.source_root)
        .unwrap()
        .summary
        .digest;
    let mut operation = fixture.prepare(&review).unwrap();
    let directory = operation.directory().to_path_buf();
    let destination = fixture.root.join("copy.example.com");
    let config = fs::read_to_string(destination.join("app/docker-compose.yml")).unwrap();
    assert!(!config.contains("source-application-secret"));
    assert!(!config.contains("source-root-secret"));
    assert_eq!(
        config,
        fs::read_to_string(directory.join("compose.json")).unwrap()
    );
    let configuration_metadata = fs::metadata(destination.join("app/docker-compose.yml")).unwrap();
    assert_eq!(configuration_metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(configuration_metadata.mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(directory.join("database.sql")).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o777, 0o700);
    assert_eq!(
        copy_files::inspect(&fixture.spec.source_root)
            .unwrap()
            .summary
            .digest,
        before
    );
    operation
        .restore(&fixture.docker, &"b".repeat(64), Duration::from_secs(2))
        .unwrap();
    assert!(operation
        .restore(&fixture.docker, &"b".repeat(64), Duration::from_secs(2))
        .is_err());
    let events = fixture.events();
    let phases: Vec<_> = events
        .iter()
        .map(|event| event["phase"].as_str().unwrap())
        .collect();
    assert_eq!(
        phases,
        [
            "preparing",
            "backing_up",
            "backup_verified",
            "copying_files",
            "files_verified",
            "configuration_written",
            "restoring_database",
            "database_restored"
        ]
    );
    let history = serde_json::to_string(&events).unwrap();
    for secret in [
        "source-application-secret",
        "source-root-secret",
        "source_user",
        "SQL fixture backup",
    ] {
        assert!(!history.contains(secret));
    }
    assert!(fixture.prepare(&review).is_err());
}

#[test]
fn stale_review_is_rejected_before_any_operation_or_database_call() {
    for case in ["files", "configuration", "specification", "expired"] {
        let mut fixture = Fixture::new("printf backup");
        let mut review = fixture.review();
        match case {
            "files" => fs::write(
                fixture.spec.source_root.join("app/public/wp-config.php"),
                "changed",
            )
            .unwrap(),
            "configuration" => {
                fixture.model["services"]["source-web"]["environment"]["MYSQL_PASSWORD"] =
                    json!("changed secret")
            }
            "specification" => fixture.spec.destination_domain = "different.example.com".into(),
            "expired" => review.expires_at = 0,
            _ => unreachable!(),
        }
        assert!(fixture.prepare(&review).is_err(), "{case}");
        assert!(!fixture.root.join("operation01").exists());
        assert!(!fixture.docker.with_extension("calls").exists());
        assert!(!fixture.root.join("copy.example.com").exists());
    }
}

#[test]
fn failed_backup_preserves_evidence_and_never_copies_project_files() {
    let fixture = Fixture::new("printf partial; exit 1");
    let review = fixture.review();
    assert!(fixture.prepare(&review).is_err());
    assert!(!fixture.root.join("copy.example.com").exists());
    assert!(fixture
        .root
        .join("operation01/database.sql.partial")
        .exists());
    assert_eq!(fixture.events().last().unwrap()["phase"], "failed");
    assert!(fixture.prepare(&review).is_err());
}

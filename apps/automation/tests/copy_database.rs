#![cfg(unix)]
use i7y_automation::copy_database;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "i7y-backup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn docker(&self, body: &str) -> PathBuf {
        let path = self.0.join("docker");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn backup_is_private_verified_and_cannot_restore_into_origin_or_be_overwritten() {
    let fixture = Fixture::new();
    let docker = fixture.docker("cat >/dev/null; printf 'SQL fixture data'");
    let mut backup =
        copy_database::capture(&docker, &"a".repeat(64), &fixture.0, Duration::from_secs(2))
            .unwrap();
    assert_eq!(backup.evidence.bytes, 16);
    assert_eq!(
        fs::metadata(fixture.0.join("database.sql")).unwrap().mode() & 0o777,
        0o600
    );
    assert!(!fixture.0.join("database.sql.partial").exists());
    assert!(backup
        .restore(&docker, &"a".repeat(64), Duration::from_secs(2))
        .is_err());
    assert!(
        copy_database::capture(&docker, &"a".repeat(64), &fixture.0, Duration::from_secs(2))
            .is_err()
    );
    fs::write(fixture.0.join("database.sql"), "tampered backup").unwrap();
    assert!(backup
        .restore(&docker, &"b".repeat(64), Duration::from_secs(2))
        .is_err());
}

#[test]
fn failed_empty_and_timed_out_backups_are_never_published() {
    for body in [
        "cat >/dev/null; printf partial; exit 1",
        "cat >/dev/null",
        "cat >/dev/null; sleep 5",
    ] {
        let fixture = Fixture::new();
        let docker = fixture.docker(body);
        assert!(copy_database::capture(
            &docker,
            &"a".repeat(64),
            &fixture.0,
            Duration::from_millis(100)
        )
        .is_err());
        assert!(!fixture.0.join("database.sql").exists());
        assert!(fixture.0.join("database.sql.partial").exists());
    }
}

struct Container {
    docker: PathBuf,
    id: String,
    database: String,
}
impl Container {
    fn start(docker: &Path) -> Self {
        Self::with_environment(
            docker,
            &serde_json::json!({"MYSQL_DATABASE":"site","MYSQL_ROOT_PASSWORD":"disposable-test-password"}),
        )
    }
    fn with_environment(docker: &Path, environment: &serde_json::Value) -> Self {
        let mut command = Command::new(docker);
        command.args([
            "run",
            "--detach",
            "--network",
            "none",
            "--tmpfs",
            "/var/lib/mysql:rw,size=512m",
        ]);
        for (key, value) in environment.as_object().unwrap() {
            command.args(["-e", key]).env(key, value.as_str().unwrap());
        }
        let output = command.arg("mysql:5.7").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = Self {
            docker: docker.into(),
            id: String::from_utf8(output.stdout).unwrap().trim().into(),
            database: environment["MYSQL_DATABASE"].as_str().unwrap().into(),
        };
        for _ in 0..90 {
            if result.sql("SELECT 1").status.success() {
                return result;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        panic!("Disposable MySQL did not become ready");
    }
    fn sql(&self, sql: &str) -> std::process::Output {
        Command::new(&self.docker).args(["exec", &self.id, "sh", "-c", "export MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\"; exec mysql --no-defaults --protocol=tcp --host=127.0.0.1 --user=root --batch --skip-column-names --database=\"$2\" --execute=\"$1\"", "i7y-test", sql, &self.database]).output().unwrap()
    }
}

#[test]
#[ignore = "Requires local Docker and the mysql:5.7 image"]
fn real_preparation_restores_into_generated_destination_database_and_credentials() {
    use i7y_automation::{
        copy_model::CopySpec,
        copy_workflow::{self, Preparation},
    };
    use serde_json::json;
    let docker = std::env::var_os("PATH")
        .unwrap()
        .to_string_lossy()
        .split(':')
        .map(|part| Path::new(part).join("docker"))
        .find(|path| path.is_file())
        .unwrap()
        .canonicalize()
        .unwrap();
    let source = Container::start(&docker);
    assert!(source.sql("CREATE TABLE sample (id INT PRIMARY KEY, value LONGBLOB) ENGINE=InnoDB; INSERT INTO sample VALUES (1, UNHEX('00ffabcd'))").status.success());
    let fixture = Fixture::new();
    let root = fixture.0.canonicalize().unwrap();
    let source_root = root.join("source.example.com");
    fs::create_dir_all(source_root.join("app/public")).unwrap();
    fs::write(source_root.join("app/public/fixture.txt"), "source bytes").unwrap();
    fs::write(
        source_root.join("app/docker-compose.yml"),
        "source configuration",
    )
    .unwrap();
    let image = Command::new(&docker)
        .args(["inspect", "--format", "{{.Image}}", &source.id])
        .output()
        .unwrap();
    assert!(image.status.success());
    let spec = CopySpec {
        source_root: source_root.clone(),
        source_domain: "source.example.com".into(),
        destination_domain: "copy.example.com".into(),
        database_image_id: String::from_utf8(image.stdout).unwrap().trim().into(),
        web_image_id: format!("sha256:{}", "b".repeat(64)),
    };
    let model = json!({"services":{
        "source-db":{"image":"mysql:5.7","environment":{"MYSQL_DATABASE":"site","MYSQL_ROOT_PASSWORD":"disposable-test-password"},"volumes":["data:/var/lib/mysql"]},
        "source-web":{"image":"example/php:8.3","environment":{"WEB_DOCUMENT_ROOT":"/var/www/app/public"},"volumes":[format!("{}:/var/www/app:rw", source_root.join("app").display())]}
    },"volumes":{"data":{}}});
    let review = copy_workflow::review(&model, &spec, &source.id).unwrap();
    let mut operation = copy_workflow::prepare(Preparation {
        docker: &docker,
        operations: &root,
        operation_id: "real-copy",
        source: &model,
        spec: &spec,
        review: &review,
        approved_hash: &copy_workflow::approval(&review).unwrap(),
        timeout: Duration::from_secs(30),
    })
    .unwrap();
    let generated: serde_json::Value =
        serde_json::from_slice(&fs::read(operation.directory().join("compose.json")).unwrap())
            .unwrap();
    let environment =
        &generated["services"][&operation.prepared.preview.database_service]["environment"];
    assert_ne!(
        environment["MYSQL_ROOT_PASSWORD"],
        "disposable-test-password"
    );
    let destination = Container::with_environment(&docker, environment);
    operation
        .restore(&docker, &destination.id, Duration::from_secs(30))
        .unwrap();
    assert_eq!(
        destination.sql("SELECT HEX(value) FROM sample").stdout,
        b"00FFABCD\n"
    );
    assert!(destination
        .sql("UPDATE sample SET value='independent'")
        .status
        .success());
    assert_eq!(
        source.sql("SELECT HEX(value) FROM sample").stdout,
        b"00FFABCD\n"
    );
    assert_eq!(
        fs::read(root.join("copy.example.com/app/public/fixture.txt")).unwrap(),
        b"source bytes"
    );
}
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new(&self.docker)
            .args(["rm", "--force", &self.id])
            .output();
    }
}

#[test]
#[ignore = "Requires local Docker and the mysql:5.7 image"]
fn real_database_backup_and_restore_preserve_origin_and_refuse_nonempty_destination() {
    let docker = std::env::var_os("PATH")
        .unwrap()
        .to_string_lossy()
        .split(':')
        .map(|part| Path::new(part).join("docker"))
        .find(|path| path.is_file())
        .unwrap()
        .canonicalize()
        .unwrap();
    let source = Container::start(&docker);
    let destination = Container::start(&docker);
    assert!(source.sql("CREATE TABLE sample (id INT PRIMARY KEY, value LONGBLOB) ENGINE=InnoDB; INSERT INTO sample VALUES (1, UNHEX('0001ff'))").status.success());
    let fixture = Fixture::new();
    let mut backup =
        copy_database::capture(&docker, &source.id, &fixture.0, Duration::from_secs(30)).unwrap();
    backup
        .restore(&docker, &destination.id, Duration::from_secs(30))
        .unwrap();
    assert_eq!(
        destination.sql("SELECT HEX(value) FROM sample").stdout,
        b"0001FF\n"
    );
    assert!(backup
        .restore(&docker, &destination.id, Duration::from_secs(30))
        .is_err());
    assert!(destination
        .sql("UPDATE sample SET value='independent'")
        .status
        .success());
    assert_eq!(
        source.sql("SELECT HEX(value) FROM sample").stdout,
        b"0001FF\n"
    );
}

#![cfg(unix)]
use i7y_core::{operations, ssh::MAX_CONTROLLER_RESPONSE_BYTES};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    id: String,
}

impl Fixture {
    fn new(action: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "i7y-inspection-limits-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for directory in [
            "operators",
            "releases/test/targets",
            "releases/test/recipes",
        ] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(root.join("config.json"), json!({"active_release":"test","ansible_playbook":"/bin/false","execution_enabled":true}).to_string()).unwrap();
        fs::write(root.join("operators/operator01.json"), json!({"backend":"https://inventory.example.com/","organization":"org01","actions":[action.replace('_',".")],"targets":["server01"]}).to_string()).unwrap();
        fs::write(root.join("releases/test/targets/server01.json"), json!({"host":"web01","kind":"server","backend":"https://inventory.example.com/","organization":"org01"}).to_string()).unwrap();
        fs::write(
            root.join("releases/test/recipes")
                .join(format!("{}.yml", action.replace('_', "-"))),
            "fixture",
        )
        .unwrap();
        let fixture = Self {
            root,
            id: "inspection01".into(),
        };
        fixture.request(json!({"command":"plan","operation_id":fixture.id,"operation":{"action":action,"target":"server01"}}));
        let job = fixture.root.join("operations/jobs").join(&fixture.id);
        fs::create_dir(&job).unwrap();
        for (sequence, state) in ["queued", "running", "succeeded"].iter().enumerate() {
            let worker = if *state == "running" {
                json!({"pid":1,"identity":"test:1"})
            } else {
                Value::Null
            };
            fs::write(job.join(format!("{sequence:04}.json")), json!({"sequence":sequence,"time":sequence+1,"state":state,"worker":worker,"detail":null}).to_string()).unwrap();
        }
        fixture
    }

    fn evidence_path(&self) -> PathBuf {
        self.root
            .join("operations/jobs")
            .join(&self.id)
            .join("inspection.json")
    }

    fn request(&self, request: Value) -> (Value, usize) {
        let native: operations::Request = serde_json::from_value(request.clone()).unwrap();
        let mut process = Command::new(env!("CARGO_BIN_EXE_i7y-automation"))
            .arg("--root")
            .arg(&self.root)
            .args(["--principal", "operator01"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process.stdin.take().unwrap().write_all(json!({"version":1,"backend":"https://inventory.example.com/","organization":"org01","request":request}).to_string().as_bytes()).unwrap();
        let output = process.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.len() <= MAX_CONTROLLER_RESPONSE_BYTES);
        assert_eq!(output.stdout.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        let scope = operations::Scope {
            backend: "https://inventory.example.com/".into(),
            organization: "org01".into(),
        };
        operations::validate_response(&scope, &native, value.clone()).unwrap();
        (value, output.stdout.len())
    }

    fn status(&self) -> (Value, usize) {
        self.request(json!({"command":"status","operation_id":self.id}))
    }

    fn assert_omitted(&self, reason: &str) -> Value {
        let (value, _) = self.status();
        assert_eq!(value["state"], "succeeded");
        assert_eq!(value["events"].as_array().unwrap().len(), 3);
        assert!(value.get("inspection").is_none());
        assert_eq!(
            value["inspection_evidence"],
            json!({"state":"omitted","reason":reason,"limit_bytes":MAX_CONTROLLER_RESPONSE_BYTES})
        );
        value
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn disk_evidence(bytes: usize) -> Value {
    let mut rows = vec![String::new(); 32];
    let mut remaining = bytes - json!({"disks":rows}).to_string().len();
    for row in &mut rows {
        let size = remaining.min(2048);
        *row = "x".repeat(size);
        remaining -= size;
    }
    assert_eq!(remaining, 0);
    let value = json!({"disks":rows});
    assert_eq!(value.to_string().len(), bytes);
    value
}

#[test]
fn valid_inspection_roundtrips_without_omission() {
    let fixture = Fixture::new("server_disk");
    let evidence = json!({"disks":["Filesystem 1024-blocks Used Available Capacity Mounted on"]});
    fs::write(fixture.evidence_path(), evidence.to_string()).unwrap();
    let (value, _) = fixture.status();
    assert_eq!(value["inspection"], evidence);
    assert!(value.get("inspection_evidence").is_none());
}

#[test]
fn missing_invalid_and_unsafe_evidence_preserve_durable_status() {
    let fixture = Fixture::new("server_disk");
    fixture.assert_omitted("missing");
    fs::write(fixture.evidence_path(), "invalid JSON").unwrap();
    fixture.assert_omitted("invalid");
    fs::write(
        fixture.evidence_path(),
        json!({"password":"private"}).to_string(),
    )
    .unwrap();
    let value = fixture.assert_omitted("invalid");
    assert!(!value.to_string().contains("private"));
    fs::remove_file(fixture.evidence_path()).unwrap();
    let outside = fixture.root.join("private.json");
    fs::write(&outside, json!({"disks":["private"]}).to_string()).unwrap();
    symlink(outside, fixture.evidence_path()).unwrap();
    fixture.assert_omitted("invalid");
}

#[test]
fn large_container_list_preserves_successful_job_status() {
    let fixture = Fixture::new("container_list");
    let containers = (0..300).map(|i| json!({"ID":format!("{i:064x}"),"Names":format!("worker-{i}"),"Image":"registry.example.com/product/component:2026-10-30","State":"running","Status":"Up 3 days","Ports":"0.0.0.0:8080->8080/tcp"})).collect::<Vec<_>>();
    let evidence = json!({"containers":containers}).to_string();
    assert!(evidence.len() > MAX_CONTROLLER_RESPONSE_BYTES);
    fs::write(fixture.evidence_path(), evidence).unwrap();
    fixture.assert_omitted("too_large");
}

#[test]
fn exact_complete_frame_limit_is_returned_and_one_byte_more_is_omitted() {
    let fixture = Fixture::new("server_disk");
    let (mut base, _) = fixture.status();
    base.as_object_mut().unwrap().remove("inspection_evidence");
    base["inspection"] = Value::Null;
    let overhead = base.to_string().len() - 4;
    let payload_size = MAX_CONTROLLER_RESPONSE_BYTES - 1 - overhead;
    let evidence = disk_evidence(payload_size);
    fs::write(fixture.evidence_path(), evidence.to_string()).unwrap();
    let (value, frame_size) = fixture.status();
    assert_eq!(value["inspection"], evidence);
    assert_eq!(frame_size, MAX_CONTROLLER_RESPONSE_BYTES);
    let evidence = disk_evidence(payload_size + 1);
    assert!(evidence.to_string().len() < MAX_CONTROLLER_RESPONSE_BYTES);
    fs::write(fixture.evidence_path(), evidence.to_string()).unwrap();
    fixture.assert_omitted("too_large");
}

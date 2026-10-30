#![cfg(unix)]
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(script: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "i7y-protocol-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for dir in [
            "operators",
            "releases/test-v1/targets",
            "releases/test-v1/recipes",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let binary = root.join("ansible-test");
        let script=script.replacen("#!/bin/sh\n","#!/bin/sh\ncase \"$*\" in *--list-hosts*) /bin/cat >/dev/null; printf '    hosts (1):\\n      web01\\n'; exit 0;; esac\n",1);
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join("config.json"),
            json!({"active_release":"test-v1","ansible_playbook":binary,"execution_enabled":true})
                .to_string(),
        )
        .unwrap();
        fs::write(root.join("operators/operator01.json"),json!({"backend":"https://inventory.example.com/","organization":"org01","actions":["server.inspect","project.copy"],"targets":["server01","project01"]}).to_string()).unwrap();
        fs::write(root.join("operators/operator02.json"),json!({"backend":"https://inventory.example.com/","organization":"org02","actions":["server.inspect"],"targets":["server01"]}).to_string()).unwrap();
        fs::write(root.join("releases/test-v1/targets/server01.json"),json!({"host":"web01","kind":"server","backend":"https://inventory.example.com/","organization":"org01"}).to_string()).unwrap();
        fs::write(root.join("releases/test-v1/targets/project01.json"),json!({"host":"web01","kind":"project","backend":"https://inventory.example.com/","organization":"org01","source_domain":"source.example.com","source_path":"/srv/projects/source.example.com"}).to_string()).unwrap();
        fs::write(
            root.join("releases/test-v1/recipes/server-inspect.yml"),
            "fixture server recipe",
        )
        .unwrap();
        fs::write(
            root.join("releases/test-v1/recipes/copy-project.yml"),
            "fixture copy recipe",
        )
        .unwrap();
        fs::write(
            root.join("releases/test-v1/inventory.yml"),
            "all:\n  hosts:\n    web01:\n",
        )
        .unwrap();
        fs::write(
            root.join("releases/test-v1/ansible.cfg"),
            "[defaults]\nhost_key_checking=True\n",
        )
        .unwrap();
        Self { root }
    }
    fn request_as(&self, principal: &str, request: Value) -> (bool, Value) {
        let native_request =
            serde_json::from_value::<i7y_core::operations::Request>(request.clone());
        let result=self.envelope_as(principal,json!({"version":1,"backend":"https://inventory.example.com/","organization":"org01","request":request}));
        if result.0 {
            let native_request =
                native_request.expect("Controller accepted an unsupported native request");
            let scope = i7y_core::operations::Scope {
                backend: "https://inventory.example.com/".into(),
                organization: "org01".into(),
            };
            assert!(
                i7y_core::operations::validate_response(&scope, &native_request, result.1.clone())
                    .is_ok(),
                "Native/controller protocol mismatch: {}",
                result.1
            );
        }
        result
    }
    fn envelope_as(&self, principal: &str, envelope: Value) -> (bool, Value) {
        let mut process = Command::new(env!("CARGO_BIN_EXE_i7y-automation"))
            .arg("--root")
            .arg(&self.root)
            .args(["--principal", principal])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process
            .stdin
            .take()
            .unwrap()
            .write_all(envelope.to_string().as_bytes())
            .unwrap();
        let output = process.wait_with_output().unwrap();
        let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
            panic!(
                "Invalid executor output: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
        (output.status.success(), value)
    }
    fn request(&self, request: Value) -> Value {
        let (ok, result) = self.request_as("operator01", request);
        assert!(ok, "{result}");
        result
    }
    fn plan(&self, id: &str) -> Value {
        self.request(json!({"command":"plan","operation_id":id,"operation":{"action":"server_inspect","target":"server01"}}))
    }
    fn copy_plan(&self, id: &str) -> Value {
        self.request(json!({"command":"plan","operation_id":id,"operation":{"action":"project_copy","target":"project01","destination_domain":"new.example.com"}}))
    }
    fn status(&self, id: &str) -> Value {
        self.request(json!({"command":"status","operation_id":id}))
    }
    fn wait(&self, id: &str) -> Value {
        let started = Instant::now();
        loop {
            let status = self.status(id);
            if ["succeeded", "failed", "interrupted"].contains(&status["state"].as_str().unwrap()) {
                return status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "Worker did not finish: {status}"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn reject_unknown_fields_and_out_of_scope_targets() {
    let fixture = Fixture::new("#!/bin/sh\nexit 99\n");
    for request in [
        json!({"command":"plan","operation_id":"test","operation":{"action":"server_inspect","target":"../server01"}}),
        json!({"command":"plan","operation_id":"test","operation":{"action":"server_inspect","target":"server01","shell":"id"}}),
        json!({"command":"plan","operation_id":"test","operation":{"action":"server_inspect","target":"server01","destination_domain":"new.example.com"}}),
    ] {
        assert!(!fixture.request_as("operator01", request).0);
    }
    assert!(!fixture.request_as("operator02",json!({"command":"plan","operation_id":"test","operation":{"action":"server_inspect","target":"server01"}})).0);
    assert!(!fixture.request_as("operator01",json!({"command":"plan","operation_id":"test","operation":{"action":"project_copy","target":"project01","destination_domain":"source.example.com; id"}})).0);
    assert_eq!(
        fs::read_dir(fixture.root.join("operations/jobs"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn changed_release_invalidates_review_and_capabilities_obey_policy() {
    let fixture = Fixture::new("#!/bin/sh\nexit 99\n");
    let capabilities = fixture.request(json!({"command":"capabilities"}));
    let actions = capabilities["catalog"]["actions"].as_array().unwrap();
    assert!(actions
        .iter()
        .find(|a| a["id"] == "server.inspect")
        .unwrap()["enabled"]
        .as_bool()
        .unwrap());
    assert!(
        !actions.iter().find(|a| a["id"] == "server.disk").unwrap()["enabled"]
            .as_bool()
            .unwrap()
    );
    let plan = fixture.plan("reviewed");
    fs::write(
        fixture.root.join("releases/test-v1/inventory.yml"),
        "changed inventory",
    )
    .unwrap();
    assert!(
        !fixture
            .request_as(
                "operator01",
                json!({"command":"submit","operation_id":"reviewed","approval":plan["approval"]})
            )
            .0
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("operations/jobs"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn detached_execution_survives_request_exit_and_replay_does_not_run_again() {
    let fixture = Fixture::new(
        "#!/bin/sh\n/bin/cat >/dev/null\n/bin/sleep 0.2\nprintf 'fixture output'\nexit 0\n",
    );
    let plan = fixture.plan("durable");
    assert_eq!(fixture.plan("durable")["approval"], plan["approval"]);
    let submit = json!({"command":"submit","operation_id":"durable","approval":plan["approval"]});
    fixture.request(submit.clone());
    let status = fixture.wait("durable");
    assert_eq!(status["state"], "succeeded");
    assert_eq!(status["events"].as_array().unwrap().len(), 3);
    assert_eq!(fixture.request(submit)["state"], "succeeded");
    assert_eq!(
        fs::read_dir(fixture.root.join("operations/locks"))
            .unwrap()
            .count(),
        0
    );
    assert!(fixture
        .root
        .join("operations/jobs/durable/output.log")
        .exists());
    assert!(!status.to_string().contains("fixture output"));
    assert!(
        !fixture
            .request_as(
                "operator02",
                json!({"command":"status","operation_id":"durable"})
            )
            .0
    );
}
#[test]
fn failed_operation_keeps_resource_locked() {
    let fixture = Fixture::new("#!/bin/sh\n/bin/cat >/dev/null\nexit 2\n");
    let plan = fixture.copy_plan("failure");
    fixture
        .request(json!({"command":"submit","operation_id":"failure","approval":plan["approval"]}));
    let status = fixture.wait("failure");
    assert_eq!(status["state"], "failed");
    assert_eq!(status["reconciliation_required"], true);
    let next = fixture.copy_plan("another");
    assert!(
        !fixture
            .request_as(
                "operator01",
                json!({"command":"submit","operation_id":"another","approval":next["approval"]})
            )
            .0
    );
}
#[test]
fn interrupted_worker_is_observed_without_restarting_it() {
    let fixture = Fixture::new("#!/bin/sh\n/bin/cat >/dev/null\nkill -KILL $PPID\nexit 2\n");
    let plan = fixture.copy_plan("interrupted");
    fixture.request(
        json!({"command":"submit","operation_id":"interrupted","approval":plan["approval"]}),
    );
    let status = fixture.wait("interrupted");
    assert_eq!(status["state"], "interrupted");
    assert_eq!(status["reconciliation_required"], true);
    assert_eq!(status["events"].as_array().unwrap().len(), 2);
    assert!(
        fs::read_dir(fixture.root.join("operations/locks"))
            .unwrap()
            .count()
            > 0
    );
}

#[test]
fn context_mismatch_and_revoked_execution_permission_are_denied() {
    let fixture = Fixture::new("#!/bin/sh\nexit 99\n");
    for (backend, org, version) in [
        ("https://other.example.com/", "org01", 1),
        ("https://inventory.example.com/", "org02", 1),
        ("https://inventory.example.com/", "org01", 2),
    ] {
        assert!(!fixture.envelope_as("operator01",json!({"version":version,"backend":backend,"organization":org,"request":{"command":"capabilities"}})).0);
    }
    let plan = fixture.plan("revoked");
    fs::write(fixture.root.join("operators/operator01.json"),json!({"backend":"https://inventory.example.com/","organization":"org01","actions":[],"targets":["server01"]}).to_string()).unwrap();
    assert!(
        !fixture
            .request_as(
                "operator01",
                json!({"command":"submit","operation_id":"revoked","approval":plan["approval"]})
            )
            .0
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("operations/jobs"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn container_plan_records_live_preflight_and_passes_it_to_the_recipe() {
    let fixture = Fixture::new(
        r##"#!/bin/sh
input=$(/bin/cat)
case "$7" in
  */container-preflight.yml)
    output=$(printf '%s' "$input" | sed -n 's/.*"i7y_preflight_output":"\([^"]*\)".*/\1/p')
    printf '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"/example-app","image":"example/app:1","state":"exited"}' > "$output"
    ;;
  *) printf '%s' "$input" | grep -q '"i7y_expected_state":"exited"' || exit 42 ;;
esac
"##,
    );
    fs::write(fixture.root.join("operators/operator01.json"),json!({"backend":"https://inventory.example.com/","organization":"org01","actions":["container.start"],"targets":["container01"]}).to_string()).unwrap();
    fs::write(fixture.root.join("releases/test-v1/targets/container01.json"),json!({"host":"web01","kind":"container","backend":"https://inventory.example.com/","organization":"org01","container_id":"a".repeat(64)}).to_string()).unwrap();
    for name in ["container-preflight.yml", "container-start.yml"] {
        fs::write(
            fixture.root.join("releases/test-v1/recipes").join(name),
            "fixture recipe",
        )
        .unwrap();
    }
    let request = json!({"command":"plan","operation_id":"container-start","operation":{"action":"container_start","target":"container01"}});
    let plan = fixture.request(request.clone());
    assert_eq!(
        plan["plan"]["parameters"]["preflight"]["container"]["state"],
        "exited"
    );
    assert!(plan["plan"]["parameters"]["preflight"]["observed_at"].is_u64());
    assert_eq!(fixture.request(request)["approval"], plan["approval"]);
    fixture.request(
        json!({"command":"submit","operation_id":"container-start","approval":plan["approval"]}),
    );
    assert_eq!(fixture.wait("container-start")["state"], "succeeded");
    assert_eq!(
        fs::read_dir(fixture.root.join("operations/preflight"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn multiple_inventory_hosts_are_rejected_before_a_recipe_runs() {
    let fixture = Fixture::new("#!/bin/sh\nexit 99\n");
    let script="#!/bin/sh\n/bin/cat >/dev/null\ncase \"$*\" in *--list-hosts*) printf 'hosts (2):\\n web01\\n web02\\n'; exit 0;; esac\nexit 0\n";
    fs::write(fixture.root.join("ansible-test"), script).unwrap();
    let plan = fixture.plan("wrong-selection");
    fixture.request(
        json!({"command":"submit","operation_id":"wrong-selection","approval":plan["approval"]}),
    );
    assert_eq!(fixture.wait("wrong-selection")["state"], "failed");
    assert!(!fixture
        .root
        .join("operations/jobs/wrong-selection/output.log")
        .exists());
}

#[test]
fn ping_uses_ansible_and_explicit_target_permissions_without_enabling_mutations() {
    let fixture = Fixture::new(r##"#!/bin/sh
input=$(/bin/cat)
case "$7" in
  */server-ping.yml)
    output=$(printf '%s' "$input" | sed -n 's/.*"i7y_ping_output":"\([^"]*\)".*/\1/p')
    printf '{"ping":"pong"}' > "$output"
    ;;
  *) exit 45 ;;
esac
"##);
    fs::write(fixture.root.join("operators/operator01.json"),json!({"backend":"https://inventory.example.com/","organization":"org01","actions":["server.ping"],"targets":["server01"]}).to_string()).unwrap();
    let mut configuration:Value=serde_json::from_slice(&fs::read(fixture.root.join("config.json")).unwrap()).unwrap();
    configuration["execution_enabled"]=json!(false);
    fs::write(fixture.root.join("config.json"),configuration.to_string()).unwrap();
    fs::write(fixture.root.join("releases/test-v1/recipes/server-ping.yml"),"fixture ping recipe").unwrap();
    let result=fixture.request(json!({"command":"ping","target":"server01"}));
    assert_eq!(result["reachable"],true);
    assert_eq!(result["target"],"server01");
    let capabilities=fixture.request(json!({"command":"capabilities"}));
    let enabled:Vec<_>=capabilities["catalog"]["actions"].as_array().unwrap().iter().filter(|action|action["enabled"]==true).map(|action|action["id"].as_str().unwrap()).collect();
    assert_eq!(enabled,vec!["server.ping"]);
    assert!(!fixture.request_as("operator01",json!({"command":"ping","target":"other-server"})).0);
    assert!(!fixture.request_as("operator02",json!({"command":"ping","target":"server01"})).0);
    assert_eq!(fs::read_dir(fixture.root.join("operations/jobs")).unwrap().count(),0);
    assert_eq!(fs::read_dir(fixture.root.join("operations/preflight")).unwrap().count(),0);
}

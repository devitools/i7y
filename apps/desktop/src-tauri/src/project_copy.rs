use crate::controller::{directory, private_write, read_profile};
use i7y_core::ssh::{self, SshError};
use rand::RngCore;
use tauri::{Emitter, Manager};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CopyTarget {
    address: String,
    port: u16,
    source_path: String,
    source_domain: String,
    destination_domain: String,
}

impl CopyTarget {
    fn validate(&self) -> Result<(), SshError> {
        self.address
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| SshError::InvalidProfile)?;
        let domain = |value: &str| {
            value.len() <= 253
                && value.contains('.')
                && value.split('.').all(|part| {
                    !part.is_empty()
                        && part.len() <= 63
                        && !part.starts_with('-')
                        && !part.ends_with('-')
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
        };
        if self.port == 0
            || !domain(&self.source_domain)
            || !domain(&self.destination_domain)
            || self.source_domain == self.destination_domain
            || !self.source_path.starts_with('/')
            || self.source_path.len() > 4096
            || self.source_path.contains(['\0', '\n', '\r'])
            || Path::new(&self.source_path)
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(SshError::InvalidProfile);
        }
        Ok(())
    }
}

fn check_copy_context(app: &tauri::AppHandle, context: &i7y_mcp::Context, lock_epoch: u64) -> Result<(), SshError> {
    if crate::platform::locked() || crate::platform::lock_epoch() != lock_epoch {
        return Err(SshError::InvalidProfile);
    }
    let backend = app.state::<crate::backend::Backend>();
    let url = backend.url.lock().map_err(|_| SshError::LocalStorageFailed)?
        .clone().ok_or(SshError::InvalidProfile)?;
    let service = app.state::<crate::mcp::Service>();
    let inner = service.inner.lock().map_err(|_| SshError::LocalStorageFailed)?;
    if inner.context(url.to_string()).map_err(|_| SshError::InvalidProfile)? != *context {
        return Err(SshError::InvalidProfile);
    }
    Ok(())
}

fn record_matches_target(record: &Value, organization: &str, project_id: &str, target: &CopyTarget) -> bool {
    record["id"] == project_id && record["organization"] == organization
        && record["address"] == target.address && record["source_path"] == target.source_path
        && record["source_domain"] == target.source_domain && target.port == 10222
}

async fn authorize_copy(app: &tauri::AppHandle, organization: &str, project_id: &str, target: &CopyTarget) -> Result<(i7y_mcp::Context, u64), SshError> {
    if project_id.len() != 15 || !project_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) || target.port != 10222 {
        return Err(SshError::InvalidProfile);
    }
    let backend = app.state::<crate::backend::Backend>();
    let url = backend.url.lock().map_err(|_| SshError::LocalStorageFailed)?
        .clone().ok_or(SshError::InvalidProfile)?;
    let context = app.state::<crate::mcp::Service>().inner.lock().map_err(|_| SshError::LocalStorageFailed)?
        .context(url.to_string()).map_err(|_| SshError::InvalidProfile)?;
    let lock_epoch = crate::platform::lock_epoch();
    if context.organization != organization { return Err(SshError::InvalidProfile); }
    check_copy_context(app, &context, lock_epoch)?;
    let path = format!("api/i7y/project-copy/v1/projects/{project_id}");
    let record = crate::mcp::api(app, "GET", &path, vec![], None, None, None, Some(&context)).await.map_err(|error| {
        if error.starts_with("Transport outcome unknown") || error == "Response interrupted; outcome unknown" {
            SshError::ConnectionFailed
        } else {
            SshError::InvalidProfile
        }
    })?;
    if !record_matches_target(&record, organization, project_id, target) {
        return Err(SshError::InvalidProfile);
    }
    check_copy_context(app, &context, lock_epoch)?;
    Ok((context, lock_epoch))
}

fn release_files() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("ansible/filter_plugins/i7y_copy.py", include_str!("../../../automation/ansible/filter_plugins/i7y_copy.py")),
        ("ansible/callback_plugins/i7y_progress.py", include_str!("../../../automation/ansible/callback_plugins/i7y_progress.py")),
        (
            "ansible/actions.yml",
            include_str!("../../../automation/ansible/actions.yml"),
        ),
        (
            "ansible/ansible.cfg",
            include_str!("../../../automation/ansible/ansible.cfg"),
        ),
        (
            "ansible/playbooks/ping.yml",
            include_str!("../../../automation/ansible/playbooks/ping.yml"),
        ),
        (
            "ansible/files/run_release.py",
            include_str!("../../../automation/ansible/files/run_release.py"),
        ),
        (
            "ansible/playbooks/project-copy.yml",
            include_str!("../../../automation/ansible/playbooks/project-copy.yml"),
        ),
        (
            "ansible/files/project_copy.py",
            include_str!("../../../automation/ansible/files/project_copy.py"),
        ),
        (
            "recipes/files/mysql-backup.sh",
            include_str!("../../../automation/recipes/files/mysql-backup.sh"),
        ),
        (
            "recipes/files/mysql-restore.sh",
            include_str!("../../../automation/recipes/files/mysql-restore.sh"),
        ),
        (
            "recipes/files/wordpress-common.sh",
            include_str!("../../../automation/recipes/files/wordpress-common.sh"),
        ),
        (
            "recipes/files/wordpress-config-check.php",
            include_str!("../../../automation/recipes/files/wordpress-config-check.php"),
        ),
        (
            "recipes/files/wordpress-domain-contract.php",
            include_str!("../../../automation/recipes/files/wordpress-domain-contract.php"),
        ),
        (
            "recipes/files/wordpress-domain-replace.php",
            include_str!("../../../automation/recipes/files/wordpress-domain-replace.php"),
        ),
        (
            "recipes/files/wordpress-database-check.php",
            include_str!("../../../automation/recipes/files/wordpress-database-check.php"),
        ),
        (
            "recipes/files/wordpress-configure.sh",
            include_str!("../../../automation/recipes/files/wordpress-configure.sh"),
        ),
        (
            "recipes/files/wordpress-review.sh",
            include_str!("../../../automation/recipes/files/wordpress-review.sh"),
        ),
        (
            "recipes/files/wordpress-publish.sh",
            include_str!("../../../automation/recipes/files/wordpress-publish.sh"),
        ),
        (
            "recipes/files/wordpress-finalize.sh",
            include_str!("../../../automation/recipes/files/wordpress-finalize.sh"),
        ),
        (
            "recipes/files/wordpress-clone-guard.php",
            include_str!("../../../automation/recipes/files/wordpress-clone-guard.php"),
        ),
    ])
}

fn release_id(files: &BTreeMap<&str, &str>) -> String {
    let mut hash = Sha256::new();
    for (name, content) in files {
        hash.update(name);
        hash.update([0]);
        hash.update(content);
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

fn should_refresh_preview(was_started: bool, result: &Value) -> bool {
    !was_started && result["execution_started"] == false && result["error_code"] == "runtime_changed_before_execution"
}

fn record_execution_result(path: &Path, was_started: bool, result: &mut Value) -> Result<(), SshError> {
    let confirmed = result["execution_started"] == true;
    let refresh = should_refresh_preview(was_started, result);
    if confirmed {
        private_write(&path.join("execution-started"), b"remote")?;
    }
    if confirmed || refresh {
        match fs::remove_file(path.join("execution-pending")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SshError::LocalStorageFailed),
        }
    }
    if refresh {
        result["refresh_preview"] = json!(true);
    }
    Ok(())
}

fn release_change(was_started: bool) -> Value {
    if was_started {
        json!({"error": "The desktop release changed. Restore the original version before resuming this copy."})
    } else {
        json!({"error": "The desktop release changed. Review the copy again.", "refresh_preview": true})
    }
}

#[tauri::command]
pub async fn project_copy_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
    organization: String,
    project_id: String,
    target: CopyTarget,
) -> Result<Value, SshError> {
    target.validate()?;
    if organization.is_empty() || organization.len() > 128 {
        return Err(SshError::InvalidProfile);
    }
    let (context, lock_epoch) = authorize_copy(&app, &organization, &project_id, &target).await?;
    let path = directory(&app, &state)?;
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    for entry in fs::read_dir(&path).map_err(|_| SshError::LocalStorageFailed)? {
        let entry = entry.map_err(|_| SshError::LocalStorageFailed)?;
        let candidate = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("copy-")
            || !(candidate.join("execution-started").is_file() || candidate.join("execution-pending").is_file()) {
            continue;
        }
        let completed = fs::read(candidate.join("result.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .map(|value| value.get("error").is_none()).unwrap_or(false);
        if completed { continue; }
        if let Ok(bytes) = fs::read(candidate.join("review.json")) {
            if let Ok(review) = serde_json::from_slice::<Value>(&bytes) {
                if review["organization"] == organization
                    && review["project_id"] == project_id
                    && review["user"] == context.user
                    && review["backend"] == context.backend
                    && review["target"] == serde_json::to_value(&target).map_err(|_| SshError::InvalidProfile)?
                    && review["profile"] == serde_json::to_value(&profile).map_err(|_| SshError::InvalidProfile)? {
                    return Ok(review["preview"].clone());
                }
            }
        }
    }
    let mut entropy = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut entropy);
    let operation_id = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = path.join(format!("copy-{operation_id}"));
    fs::create_dir(&temporary).map_err(|_| SshError::LocalStorageFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
            .map_err(|_| SshError::LocalStorageFailed)?;
    }
    let request = json!({"operation_id": operation_id, "source_path": target.source_path, "source_domain": target.source_domain, "destination_domain": target.destination_domain});
    private_write(&temporary.join("progress.json"), &serde_json::to_vec(&json!({"organization": organization})).map_err(|_| SshError::LocalStorageFailed)?)?;
    let _ = app.emit("project-copy-started", json!({"operation_id": operation_id, "phase": "preview"}));
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let known_hosts = temporary.join("known_hosts");
        private_write(&known_hosts, profile.known_host_entry()?.as_bytes())?;
        let files = release_files();
        let payload = json!({"address": target.address, "port": target.port, "phase": "preview", "request": request, "files": files});
        check_copy_context(&worker_app, &context, lock_epoch)?;
        let result = ssh::run_ansible_release(&profile, &known_hosts, serde_json::to_vec(&payload).map_err(|_| SshError::InvalidProfile)?)?;
        if result.get("error").is_none() {
            if result["release"] != release_id(&files) || result["operation_id"] != operation_id || result["fingerprint"].as_str().map(|v| v.len()) != Some(64) { return Err(SshError::InvalidDiagnostic); }
            private_write(&temporary.join("review.json"), &serde_json::to_vec(&json!({"organization": organization, "project_id": project_id, "user": context.user, "backend": context.backend, "profile": profile, "target": target, "request": request, "preview": result})).map_err(|_| SshError::LocalStorageFailed)?)?;
        }
        Ok(result)
    }).await.map_err(|_| SshError::ConnectionFailed)?
}

#[tauri::command]
pub async fn project_copy_execute(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
    organization: String,
    operation_id: String,
    confirmation: String,
) -> Result<Value, SshError> {
    if operation_id.len() != 32 || !operation_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SshError::InvalidProfile);
    }
    let path = directory(&app, &state)?;
    let temporary = path.join(format!("copy-{operation_id}"));
    let review: Value = serde_json::from_slice(
        &fs::read(temporary.join("review.json")).map_err(|_| SshError::InvalidProfile)?,
    )
    .map_err(|_| SshError::InvalidProfile)?;
    let target: CopyTarget =
        serde_json::from_value(review["target"].clone()).map_err(|_| SshError::InvalidProfile)?;
    target.validate()?;
    let project_id = review["project_id"].as_str().ok_or(SshError::InvalidProfile)?;
    let (context, lock_epoch) = authorize_copy(&app, &organization, project_id, &target).await?;
    if review["user"] != context.user || review["backend"] != context.backend { return Err(SshError::InvalidProfile); }
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SshError::InvalidProfile)?
        .as_secs();
    if review["organization"] != organization
        || confirmation != target.destination_domain
        || review["profile"]
            != serde_json::to_value(&profile).map_err(|_| SshError::InvalidProfile)?
    {
        return Err(SshError::InvalidProfile);
    }
    let was_started = temporary.join("execution-started").exists();
    let was_pending = temporary.join("execution-pending").exists();
    if review["preview"]["release"] != release_id(&release_files()) {
        return Ok(release_change(was_started || was_pending));
    }
    if !was_started && !was_pending && review["preview"]["expires_at"].as_u64().unwrap_or(0) < now {
        return Ok(json!({"error": "The preview expired. Review the copy again.", "refresh_preview": true}));
    }
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        check_copy_context(&worker_app, &context, lock_epoch)?;
        private_write(&temporary.join("execution-pending"), b"pending")?;
        let _ = worker_app.emit("project-copy-started", json!({"operation_id": operation_id, "phase": "execute"}));
        let mut request = review["request"].clone();
        request["fingerprint"] = review["preview"]["fingerprint"].clone();
        let payload = json!({"address": target.address, "port": target.port, "phase": "execute", "request": request, "expected_runtime": review["preview"]["runtime"], "files": release_files()});
        if let Err(error) = check_copy_context(&worker_app, &context, lock_epoch) {
            if !was_pending { let _ = fs::remove_file(temporary.join("execution-pending")); }
            return Err(error);
        }
        let outcome = ssh::run_ansible_release(&profile, &temporary.join("known_hosts"), serde_json::to_vec(&payload).map_err(|_| SshError::InvalidProfile)?);
        let mut result = outcome?;
        record_execution_result(&temporary, was_started, &mut result)?;
        private_write(&temporary.join("result.json"), &serde_json::to_vec(&result).map_err(|_| SshError::LocalStorageFailed)?)?;
        Ok(result)
    }).await.map_err(|_| SshError::ConnectionFailed)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_includes_catalog_playbooks_and_execution_bootstrap() {
        let files = release_files();
        assert!(files.contains_key("ansible/files/run_release.py"));
        for line in files["ansible/actions.yml"].lines() {
            if let Some(path) = line.trim().strip_prefix("playbook: ") {
                assert!(files.contains_key(format!("ansible/{path}").as_str()));
            }
        }
        let first = release_id(&files);
        let mut changed = files.clone();
        changed.insert("ansible/files/run_release.py", "changed");
        assert_ne!(first, release_id(&changed));
    }
    #[test]
    fn refresh_only_when_runtime_rejection_precedes_first_execution() {
        let rejected = json!({"error_code": "runtime_changed_before_execution", "execution_started": false});
        assert!(should_refresh_preview(false, &rejected));
        assert!(!should_refresh_preview(true, &rejected));
        assert!(!should_refresh_preview(false, &json!({"error": "interrupted"})));
        assert!(!should_refresh_preview(false, &json!({})));
        assert!(!should_refresh_preview(false, &json!({"error_code": "runtime_changed_before_execution", "execution_started": true})));
        assert!(!should_refresh_preview(false, &json!({"error_code": "runtime_changed_before_execution"})));
    }
    #[test]
    fn execution_receipts_distinguish_unknown_rejected_and_started_requests() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("i7y-copy-receipt-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        private_write(&path.join("execution-pending"), b"pending").unwrap();
        record_execution_result(&path, false, &mut json!({"error": "interrupted"})).unwrap();
        assert!(path.join("execution-pending").exists());
        assert!(!path.join("execution-started").exists());
        let mut rejected = json!({"error_code": "runtime_changed_before_execution", "execution_started": false});
        record_execution_result(&path, false, &mut rejected).unwrap();
        assert_eq!(rejected["refresh_preview"], true);
        assert!(!path.join("execution-pending").exists());
        assert!(!path.join("execution-started").exists());
        private_write(&path.join("execution-pending"), b"pending").unwrap();
        let mut started = json!({"execution_started": true});
        record_execution_result(&path, false, &mut started).unwrap();
        record_execution_result(&path, true, &mut started).unwrap();
        assert!(path.join("execution-started").exists());
        assert!(!path.join("execution-pending").exists());
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn release_change_only_allows_refresh_before_execution() {
        assert_eq!(release_change(false)["refresh_preview"], true);
        assert!(release_change(true).get("refresh_preview").is_none());
        assert!(release_change(true)["error"].as_str().unwrap().contains("original version"));
    }
    #[test]
    fn authorized_inventory_must_match_copy_target() {
        let mut target = CopyTarget { address: "192.0.2.1".into(), port: 10222,
            source_path: "/srv/source.example.com".into(), source_domain: "source.example.com".into(),
            destination_domain: "copy.example.com".into() };
        let record = json!({"id":"project12345678","organization":"org-a","address":"192.0.2.1",
            "source_path":"/srv/source.example.com","source_domain":"source.example.com"});
        assert!(record_matches_target(&record, "org-a", "project12345678", &target));
        assert!(!record_matches_target(&record, "org-b", "project12345678", &target));
        target.address = "192.0.2.2".into();
        assert!(!record_matches_target(&record, "org-a", "project12345678", &target));
        target.address = "192.0.2.1".into();
        target.source_path = "/srv/other.example.com".into();
        assert!(!record_matches_target(&record, "org-a", "project12345678", &target));
    }
    #[test]
    fn copy_targets_reject_patterns_and_command_parameters() {
        let mut target = CopyTarget {
            address: "192.0.2.1".into(),
            port: 10222,
            source_path: "/projects/source.example.com/app".into(),
            source_domain: "source.example.com".into(),
            destination_domain: "copy.example.com".into(),
        };
        assert!(target.validate().is_ok());
        for address in ["all", "*", "192.0.2.1;id", "192.0.2.1,192.0.2.2"] {
            target.address = address.into();
            assert!(target.validate().is_err());
        }
        target.address = "192.0.2.1".into();
        target.source_path = "/projects/../etc".into();
        assert!(target.validate().is_err());
    }
}

#[tauri::command]
pub async fn project_copy_progress(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
    organization: String,
    operation_id: String,
    phase: String,
) -> Result<Value, SshError> {
    if operation_id.len() != 32 || !operation_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) || !["preview", "execute"].contains(&phase.as_str()) {
        return Err(SshError::InvalidProfile);
    }
    let path = directory(&app, &state)?;
    let temporary = path.join(format!("copy-{operation_id}"));
    let binding: Value = serde_json::from_slice(&fs::read(temporary.join("progress.json")).map_err(|_| SshError::InvalidProfile)?).map_err(|_| SshError::InvalidProfile)?;
    if binding["organization"] != organization { return Err(SshError::InvalidProfile); }
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    tauri::async_runtime::spawn_blocking(move || {
        let names: Vec<&str> = include_str!("../../../automation/ansible/playbooks/project-copy.yml").lines().filter_map(|line| line.trim().strip_prefix("- name: ")).collect();
        let payload = json!({"phase": "status", "operation_id": operation_id, "operation_phase": phase, "task_names": names});
        ssh::run_ansible_release(&profile, &temporary.join("known_hosts"), serde_json::to_vec(&payload).map_err(|_| SshError::InvalidProfile)?)
    }).await.map_err(|_| SshError::ConnectionFailed)?
}

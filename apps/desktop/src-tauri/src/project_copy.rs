use crate::controller::{directory, private_write, read_profile};
use i7y_core::ssh::{self, SshError};
use rand::RngCore;
use tauri::Emitter;
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
            || !Path::new(&self.source_path).is_absolute()
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
    !was_started && result["error_code"] == "runtime_changed_before_execution"
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
    target: CopyTarget,
) -> Result<Value, SshError> {
    target.validate()?;
    if organization.is_empty() || organization.len() > 128 {
        return Err(SshError::InvalidProfile);
    }
    let path = directory(&app, &state)?;
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    for entry in fs::read_dir(&path).map_err(|_| SshError::LocalStorageFailed)? {
        let entry = entry.map_err(|_| SshError::LocalStorageFailed)?;
        let candidate = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("copy-") || !candidate.join("execution-started").is_file() {
            continue;
        }
        let completed = fs::read(candidate.join("result.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .map(|value| value.get("error").is_none()).unwrap_or(false);
        if completed { continue; }
        if let Ok(bytes) = fs::read(candidate.join("review.json")) {
            if let Ok(review) = serde_json::from_slice::<Value>(&bytes) {
                if review["organization"] == organization
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
    tauri::async_runtime::spawn_blocking(move || {
        let known_hosts = temporary.join("known_hosts");
        private_write(&known_hosts, profile.known_host_entry()?.as_bytes())?;
        let files = release_files();
        let payload = json!({"address": target.address, "port": target.port, "phase": "preview", "request": request, "files": files});
        let result = ssh::run_ansible_release(&profile, &known_hosts, serde_json::to_vec(&payload).map_err(|_| SshError::InvalidProfile)?)?;
        if result.get("error").is_none() {
            if result["release"] != release_id(&files) || result["operation_id"] != operation_id || result["fingerprint"].as_str().map(|v| v.len()) != Some(64) { return Err(SshError::InvalidDiagnostic); }
            private_write(&temporary.join("review.json"), &serde_json::to_vec(&json!({"organization": organization, "profile": profile, "target": target, "request": request, "preview": result})).map_err(|_| SshError::LocalStorageFailed)?)?;
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
    if review["preview"]["release"] != release_id(&release_files()) {
        return Ok(release_change(was_started));
    }
    if !was_started && review["preview"]["expires_at"].as_u64().unwrap_or(0) < now {
        return Ok(json!({"error": "The preview expired. Review the copy again.", "refresh_preview": true}));
    }
    private_write(&temporary.join("execution-started"), b"started")?;
    let _ = app.emit("project-copy-started", json!({"operation_id": operation_id, "phase": "execute"}));
    tauri::async_runtime::spawn_blocking(move || {
        let mut request = review["request"].clone();
        request["fingerprint"] = review["preview"]["fingerprint"].clone();
        let payload = json!({"address": target.address, "port": target.port, "phase": "execute", "request": request, "expected_runtime": review["preview"]["runtime"], "files": release_files()});
        let outcome = ssh::run_ansible_release(&profile, &temporary.join("known_hosts"), serde_json::to_vec(&payload).map_err(|_| SshError::InvalidProfile)?);
        let _ = fs::remove_file(temporary.join("execution-running"));
        let mut result = outcome?;
        if should_refresh_preview(was_started, &result) {
            fs::remove_file(temporary.join("execution-started")).map_err(|_| SshError::LocalStorageFailed)?;
            result["refresh_preview"] = json!(true);
        }
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
        let rejected = json!({"error_code": "runtime_changed_before_execution"});
        assert!(should_refresh_preview(false, &rejected));
        assert!(!should_refresh_preview(true, &rejected));
        assert!(!should_refresh_preview(false, &json!({"error": "interrupted"})));
        assert!(!should_refresh_preview(false, &json!({})));
    }
    #[test]
    fn release_change_only_allows_refresh_before_execution() {
        assert_eq!(release_change(false)["refresh_preview"], true);
        assert!(release_change(true).get("refresh_preview").is_none());
        assert!(release_change(true)["error"].as_str().unwrap().contains("original version"));
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

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Read, Write}, path::PathBuf, process::{Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

const RUNNER: &str = include_str!("../../../automation/desktop/server_power.py");
const CATALOG: &str = include_str!("../../../automation/desktop/actions.json");

fn supported_action(action: &str) -> bool {
    serde_json::from_str::<Value>(CATALOG).ok().filter(|catalog|catalog["version"]==1).and_then(|catalog|catalog["actions"].as_array().map(|actions|actions.iter().any(|entry|entry["action"]==action&&entry["target"]=="server"&&entry["permission"]=="write"&&entry["handler"]=="server_power.py"))).unwrap_or(false)
}

fn check_context(app: &tauri::AppHandle, context: &i7y_mcp::Context, epoch: u64) -> Result<(), String> {
    if crate::platform::locked() || crate::platform::lock_epoch() != epoch { return Err("context_changed".into()); }
    let state = app.state::<crate::backend::Backend>();
    let backend = state.url.lock().map_err(|_| "context_changed")?.clone().ok_or("context_changed")?;
    let current = app.state::<crate::mcp::Service>().inner.lock().map_err(|_| "context_changed")?.context(backend.to_string()).map_err(|_| "context_changed")?;
    if current != *context { return Err("context_changed".into()); }
    Ok(())
}

async fn api(app: &tauri::AppHandle, context: &i7y_mcp::Context, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    crate::mcp::api(app, method, path, vec![], body, None, None, Some(context)).await
}

#[derive(Serialize)]
pub struct LocalSettings { supported: bool, identity_file: String, proxy_available: bool }

#[tauri::command]
pub fn server_power_local_settings(app: tauri::AppHandle) -> Result<LocalSettings, String> {
    let state = app.state::<crate::backend::Backend>();
    let directory = crate::controller::directory(&app, &state).map_err(|_| "context_changed")?;
    let profile = crate::controller::read_profile(&directory.join("profile.json")).map_err(|_| "invalid_target")?;
    let home = app.path().home_dir().map_err(|_| "runtime_unavailable")?;
    let identity_file = profile.as_ref().map(|p|p.identity_file.clone()).or_else(||["id_ed25519", "id_rsa"].iter().map(|p|home.join(".ssh").join(p)).find(|p|p.is_file()).map(|p|p.to_string_lossy().into_owned())).unwrap_or_default();
    Ok(LocalSettings { supported: cfg!(target_os = "macos"), identity_file, proxy_available: profile.is_some() })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message { kind: String, stage: String, status: Option<String>, reason: Option<String> }

fn message(line: &str) -> Result<Message, String> {
    let value: Message = serde_json::from_str(line).map_err(|_| "operation_interrupted")?;
    if !["progress", "result"].contains(&value.kind.as_str()) || !["checking_provider", "power_on_requested", "power_off_requested", "waiting_for_boot", "checking_boot", "unlocking_disk", "awaiting_agent", "powered_off", "requires_console", "provider_on", "provider_off", "unknown", "failed"].contains(&value.stage.as_str()) || value.status.as_ref().is_some_and(|s|!["observed", "failed", "unknown", "powered_off", "requires_console", "awaiting_agent"].contains(&s.as_str())) || value.reason.as_ref().is_some_and(|s|!["provider_unavailable", "provider_rejected", "provider_target_missing", "vault_unavailable", "boot_unavailable", "boot_identity_mismatch", "disk_key_rejected", "unlock_unconfirmed", "runtime_unavailable", "context_changed", "operation_interrupted", "invalid_target", "agent_timeout"].contains(&s.as_str())) { return Err("operation_interrupted".into()); }
    Ok(value)
}

fn run(app: &tauri::AppHandle, context: &i7y_mcp::Context, epoch: u64, path: &str, payload: &Value, request_id: &str, server_id: &str) -> Result<Value, String> {
    let python = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].iter().find(|p|std::path::Path::new(p).is_file()).ok_or("runtime_unavailable")?;
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", RUNNER]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    check_context(app, context, epoch)?;
    let mut child = command.spawn().map_err(|_| "runtime_unavailable")?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("operation_interrupted")?;
        let bytes = serde_json::to_vec(payload).map_err(|_| "invalid_target")?;
        if bytes.len() > 32768 { return Err("invalid_target".into()); }
        input.write_all(&bytes).and_then(|_|input.write_all(b"\n")).map_err(|_| "operation_interrupted")?;
        drop(input);
        let stdout = child.stdout.take().ok_or("operation_interrupted")?;
        let (sender, receiver) = mpsc::sync_channel(32);
        std::thread::spawn(move || { for line in BufReader::new(stdout.take(65537)).lines() { if sender.send(line).is_err() { break; } } });
        let deadline = Instant::now() + Duration::from_secs(540);
        let mut total = 0;
        while Instant::now() < deadline {
            check_context(app, context, epoch)?;
            let line = match receiver.recv_timeout(Duration::from_millis(200)) { Ok(Ok(line)) => line, Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => return Err("operation_interrupted".into()), Err(mpsc::RecvTimeoutError::Timeout) => continue };
            total += line.len();
            if total > 65536 || line.len() > 2048 { return Err("operation_interrupted".into()); }
            let event = message(&line)?;
            if event.kind == "result" { return Ok(json!({"status":event.status.ok_or("operation_interrupted")?,"stage":event.stage,"reason":event.reason.unwrap_or_default()})); }
            tauri::async_runtime::block_on(api(app, context, "POST", &format!("{path}/checkpoint"), Some(json!({"stage":event.stage})))).map_err(|_| "context_changed")?;
            let _ = app.emit("server-power-progress", json!({"server_id":server_id,"request_id":request_id,"stage":event.stage}));
        }
        Err("operation_interrupted".into())
    })();
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn identifier(value: &str) -> bool { value.len() == 15 && value.bytes().all(|b|b.is_ascii_lowercase() || b.is_ascii_digit()) }

#[tauri::command]
pub async fn server_power_run(app: tauri::AppHandle, organization: String, server_id: String, action: String, request_id: String, version: u64, identity_file: String, via_automation_host: bool, op_account: String) -> Result<Value, String> {
    if !cfg!(target_os = "macos") { return Err("runtime_unavailable".into()); }
    if !identifier(&server_id) || !identifier(&organization) || !supported_action(&action) || !(32..=36).contains(&request_id.len()) || !request_id.bytes().all(|b|b.is_ascii_hexdigit() || b==b'-') { return Err("invalid_target".into()); }
    let context = {
        let state = app.state::<crate::backend::Backend>();
        let backend = state.url.lock().map_err(|_| "context_changed")?.clone().ok_or("context_changed")?;
        app.state::<crate::mcp::Service>().inner.lock().map_err(|_| "context_changed")?.context(backend.to_string()).map_err(|_| "context_changed")?
    };
    if context.organization != organization { return Err("context_changed".into()); }
    let epoch = crate::platform::lock_epoch();
    check_context(&app, &context, epoch)?;
    let base = format!("api/i7y/server-power/v1/servers/{server_id}/jobs");
    let job = api(&app, &context, "POST", &base, Some(json!({"action":action,"request_id":request_id,"version":version}))).await?;
    if job["replayed"] == true { return Ok(job); }
    let id = job["id"].as_str().filter(|id|identifier(id)).ok_or("invalid_target")?;
    let path = format!("{base}/{id}");
    let result = (|| {
        let target = &job["target"];
        let mut payload = json!({"action":action,"target":target,"identity_file":identity_file,"op_account":op_account});
        if action == "start" && target["boot_host_key"].as_str().is_some_and(|k|!k.is_empty()) {
            i7y_core::ssh::canonical_key(target["boot_host_key"].as_str().ok_or("invalid_target")?).map_err(|_| "invalid_target")?;
            let identity = PathBuf::from(&identity_file);
            if !identity.is_absolute() || !identity.is_file() { return Err("invalid_target".to_string()); }
            if via_automation_host {
                let state = app.state::<crate::backend::Backend>();
                let directory = crate::controller::directory(&app, &state).map_err(|_| "invalid_target")?;
                let profile = crate::controller::read_profile(&directory.join("profile.json")).map_err(|_| "invalid_target")?.ok_or("invalid_target")?;
                payload["proxy"] = json!({"host":profile.host,"port":profile.port,"user":profile.user,"host_key":profile.host_key,"identity_file":profile.identity_file});
            }
        }
        Ok(payload)
    })();
    let outcome = match result {
        Ok(payload) => {
            let handle=app.clone(); let ctx=context.clone(); let job_path=path.clone(); let request=request_id.clone(); let server=server_id.clone();
            tauri::async_runtime::spawn_blocking(move ||run(&handle,&ctx,epoch,&job_path,&payload,&request,&server)).await.unwrap_or_else(|_|Err("operation_interrupted".into()))
        },
        Err(error) => Err(error),
    };
    let result = outcome.unwrap_or_else(|reason|{let status=if action=="inspect"||["invalid_target","runtime_unavailable"].contains(&reason.as_str()) {"failed"} else {"unknown"};json!({"status":status,"stage":status,"reason":reason})});
    check_context(&app,&context,epoch)?;
    api(&app,&context,"POST",&format!("{path}/finish"),Some(result)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_exposes_only_the_fixed_server_power_actions() {
        for action in ["inspect", "start", "shutdown"] { assert!(supported_action(action)); }
        for action in ["reboot", "force-stop", "project_copy", "sh", "start; touch /tmp/invalid"] { assert!(!supported_action(action)); }
    }
    #[test]
    fn runner_output_is_limited_to_public_states() {
        assert!(message(r#"{"kind":"progress","stage":"unlocking_disk"}"#).is_ok());
        assert!(message(r#"{"kind":"result","stage":"awaiting_agent","status":"awaiting_agent"}"#).is_ok());
        assert!(message(r#"{"kind":"result","stage":"awaiting_agent","status":"recovered"}"#).is_err());
        assert!(message(r#"{"kind":"result","stage":"failed","status":"failed","reason":"secret value"}"#).is_err());
        assert!(message(r#"{"kind":"progress","stage":"unlocking_disk","password":"secret"}"#).is_err());
    }
}

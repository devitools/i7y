use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::{BufRead, BufReader, Read, Write}, path::PathBuf, process::{Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

const RUNNER: &str = include_str!("../../../automation/desktop/server_power.py");
const VAULT_ADAPTER: &str = include_str!("../../../automation/desktop/i7y_vault.py");

fn vault_bootstrap() -> String {
    format!("import sys, types\nvault_module = types.ModuleType('i7y_vault')\nexec({}, vault_module.__dict__)\nsys.modules['i7y_vault'] = vault_module", serde_json::to_string(VAULT_ADAPTER).unwrap())
}

fn runner_source() -> String {
    format!("{}\n{}", vault_bootstrap(), RUNNER)
}

const CATALOG: &str = include_str!("../../../automation/desktop/actions.json");

fn supported_action(action: &str) -> bool {
    serde_json::from_str::<Value>(CATALOG).ok().filter(|catalog|catalog["version"]==1).and_then(|catalog|catalog["actions"].as_array().map(|actions|actions.iter().any(|entry|entry["action"]==action&&entry["target"]=="server"&&entry["permission"]=="write"&&entry["handler"]=="server_power.py"))).unwrap_or(false)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedSource {
    connection_id: String,
    backend: String,
    user: String,
    organization: String,
    session: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerContext {
    connection_id: String,
    connection_generation: u64,
    context: i7y_mcp::Context,
    lock_epoch: u64,
}

fn bind_context(registry: &crate::connections::Registry, inner: &crate::mcp::Inner, source: &ExpectedSource, lock_epoch: u64) -> Result<PowerContext, String> {
    if registry.selected.as_deref() != Some(&source.connection_id) {return Err("context_changed".into())}
    let (backend, connection_generation, session) = registry.snapshot(&source.connection_id).map_err(|_| "context_changed")?;
    let session = session.ok_or("context_changed")?;
    let context = inner.context(backend.to_string()).map_err(|_| "context_changed")?;
    if backend.as_str() != source.backend || context.user != source.user || context.organization != source.organization
        || session.record["id"] != source.user || session.public(connection_generation)["token"] != source.session {
        return Err("context_changed".into());
    }
    Ok(PowerContext {connection_id:source.connection_id.clone(),connection_generation,context,lock_epoch})
}

fn bound_session(registry: &crate::connections::Registry, inner: &crate::mcp::Inner, expected: &PowerContext) -> Result<(url::Url, crate::session::Session), String> {
    if registry.selected.as_deref() != Some(&expected.connection_id) {return Err("context_changed".into())}
    registry.current(&expected.connection_id, expected.connection_generation).map_err(|_| "context_changed")?;
    let (backend, _, session) = registry.snapshot(&expected.connection_id).map_err(|_| "context_changed")?;
    let session = session.ok_or("context_changed")?;
    if inner.context(backend.to_string()).map_err(|_| "context_changed")? != expected.context || session.record["id"] != expected.context.user {
        return Err("context_changed".into());
    }
    Ok((backend, session))
}

fn snapshot(app: &tauri::AppHandle, expected: &PowerContext) -> Result<(url::Url, crate::session::Session), String> {
    if crate::platform::locked() || crate::platform::lock_epoch() != expected.lock_epoch {return Err("context_changed".into())}
    let state = app.state::<crate::backend::Backend>();
    let registry = state.connections.lock().map_err(|_| "context_changed")?;
    let service = app.state::<crate::mcp::Service>();
    let inner = service.inner.lock().map_err(|_| "context_changed")?;
    bound_session(&registry, &inner, expected)
}

fn check_context(app: &tauri::AppHandle, expected: &PowerContext) -> Result<(), String> {snapshot(app, expected).map(|_| ())}

async fn api(app: &tauri::AppHandle, context: &PowerContext, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let (backend, session) = snapshot(app, context)?;
    let state = app.state::<crate::backend::Backend>();
    let target = backend.join(path).map_err(|_| "invalid_target")?;
    crate::backend::api_target(&backend, target.as_str()).map_err(|_| "invalid_target")?;
    let mut request = state.client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "invalid_target")?, target).bearer_auth(session.token).header("X-I7y-Organization", &context.context.organization);
    if let Some(body) = body {request = request.json(&body);}
    let mut response = request.send().await.map_err(|_| "operation_interrupted")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "operation_interrupted")? {
        if bytes.len() + chunk.len() > i7y_mcp::MAX_MESSAGE {return Err("operation_interrupted".into())}
        bytes.extend_from_slice(&chunk);
    }
    check_context(app, context)?;
    if status.as_u16() == 401 {
        crate::session::clear_if_current(app, &context.connection_id, context.connection_generation)?;
        return Err("context_changed".into());
    }
    if !status.is_success() {return Err(format!("Backend request rejected ({})", status.as_u16()))}
    serde_json::from_slice(&bytes).map_err(|_| "operation_interrupted".into())
}

fn controller_directory(app: &tauri::AppHandle, context: &PowerContext) -> Result<PathBuf, String> {
    let key = format!("{:x}", Sha256::digest(context.context.backend.as_bytes()));
    Ok(app.path().app_config_dir().map_err(|_| "context_changed")?.join("controllers").join(key))
}

#[derive(Serialize)]
pub struct LocalSettings { supported: bool, identity_file: String, proxy_available: bool, context: PowerContext }

#[tauri::command]
pub fn server_power_local_settings(app: tauri::AppHandle, expected_source: ExpectedSource) -> Result<LocalSettings, String> {
    if crate::platform::locked() {return Err("context_changed".into())}
    let context = {
        let state = app.state::<crate::backend::Backend>();
        let registry = state.connections.lock().map_err(|_| "context_changed")?;
        let service = app.state::<crate::mcp::Service>();
        let inner = service.inner.lock().map_err(|_| "context_changed")?;
        bind_context(&registry, &inner, &expected_source, crate::platform::lock_epoch())?
    };
    let directory = controller_directory(&app, &context)?;
    let profile = crate::controller::read_profile(&directory.join("profile.json")).map_err(|_| "invalid_target")?;
    let home = app.path().home_dir().map_err(|_| "runtime_unavailable")?;
    let identity_file = profile.as_ref().map(|p|p.identity_file.clone()).or_else(||["id_ed25519", "id_rsa"].iter().map(|p|home.join(".ssh").join(p)).find(|p|p.is_file()).map(|p|p.to_string_lossy().into_owned())).unwrap_or_default();
    check_context(&app, &context)?;
    Ok(LocalSettings { supported: cfg!(target_os = "macos"), identity_file, proxy_available: profile.is_some(), context })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message { kind: String, stage: String, status: Option<String>, reason: Option<String> }

fn message(line: &str) -> Result<Message, String> {
    let value: Message = serde_json::from_str(line).map_err(|_| "operation_interrupted")?;
    if !["progress", "result"].contains(&value.kind.as_str()) || !["checking_provider", "power_on_requested", "power_off_requested", "waiting_for_boot", "checking_boot", "unlocking_disk", "awaiting_agent", "powered_off", "requires_console", "provider_on", "provider_off", "unknown", "failed"].contains(&value.stage.as_str()) || value.status.as_ref().is_some_and(|s|!["observed", "failed", "unknown", "powered_off", "requires_console", "awaiting_agent"].contains(&s.as_str())) || value.reason.as_ref().is_some_and(|s|!["provider_unavailable", "provider_rejected", "provider_target_missing", "vault_unavailable", "vault_unsupported", "boot_unavailable", "boot_identity_mismatch", "disk_key_rejected", "unlock_unconfirmed", "runtime_unavailable", "context_changed", "operation_interrupted", "invalid_target", "agent_timeout"].contains(&s.as_str())) { return Err("operation_interrupted".into()); }
    Ok(value)
}

fn run(app: &tauri::AppHandle, context: &PowerContext, path: &str, payload: &Value, request_id: &str, server_id: &str) -> Result<Value, String> {
    let python = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].iter().find(|p|std::path::Path::new(p).is_file()).ok_or("runtime_unavailable")?;
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", &runner_source()]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    check_context(app, context)?;
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
            check_context(app, context)?;
            let line = match receiver.recv_timeout(Duration::from_millis(200)) { Ok(Ok(line)) => line, Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => return Err("operation_interrupted".into()), Err(mpsc::RecvTimeoutError::Timeout) => continue };
            total += line.len();
            if total > 65536 || line.len() > 2048 { return Err("operation_interrupted".into()); }
            let event = message(&line)?;
            if event.kind == "result" { return Ok(json!({"status":event.status.ok_or("operation_interrupted")?,"stage":event.stage,"reason":event.reason.unwrap_or_default()})); }
            tauri::async_runtime::block_on(api(app, context, "POST", &format!("{path}/checkpoint"), Some(json!({"stage":event.stage})))).map_err(|_| "context_changed")?;
            let _ = app.emit("server-power-progress", json!({"server_id":server_id,"request_id":request_id,"stage":event.stage,"context":context}));
        }
        Err("operation_interrupted".into())
    })();
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn identifier(value: &str) -> bool { value.len() == 15 && value.bytes().all(|b|b.is_ascii_lowercase() || b.is_ascii_digit()) }

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct VaultConfiguration {
    service_id: String,
    vm_id: String,
    boot_port: u16,
    boot_host_key: String,
    luks_uuid: String,
}

fn configuration_message(bytes: &[u8]) -> Result<VaultConfiguration, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "vault_metadata_invalid")?;
    if value["kind"] == "result" {
        let reason = value["reason"].as_str().unwrap_or("");
        return Err(if ["vault_unavailable","vault_unsupported","vault_metadata_missing","vault_metadata_invalid","vault_target_mismatch","runtime_unavailable","invalid_target"].contains(&reason) {reason} else {"vault_metadata_invalid"}.into());
    }
    if value["kind"] != "configuration" || value.as_object().map_or(true,|object|object.len()!=2) {return Err("vault_metadata_invalid".into())}
    let profile: VaultConfiguration = serde_json::from_value(value["profile"].clone()).map_err(|_| "vault_metadata_invalid")?;
    let numeric = |value: &str| !value.starts_with('0') && !value.is_empty() && value.len() <= 16 && value.bytes().all(|c|c.is_ascii_digit());
    if !numeric(&profile.service_id) || !numeric(&profile.vm_id) || profile.boot_port==0 || profile.boot_host_key.is_empty()!=profile.luks_uuid.is_empty() {return Err("vault_metadata_invalid".into())}
    if !profile.boot_host_key.is_empty() {
        i7y_core::ssh::canonical_key(&profile.boot_host_key).map_err(|_| "vault_metadata_invalid")?;
        let uuid=&profile.luks_uuid;
        if uuid.len()!=36 || !uuid.bytes().enumerate().all(|(i,c)|if [8,13,18,23].contains(&i) {c==b'-'} else {c.is_ascii_hexdigit()}) {return Err("vault_metadata_invalid".into())}
    }
    Ok(profile)
}

fn read_configuration(app: &tauri::AppHandle, context: &PowerContext, payload: Value) -> Result<VaultConfiguration, String> {
    let python=["/opt/homebrew/bin/python3","/usr/local/bin/python3","/usr/bin/python3"].iter().find(|path|std::path::Path::new(path).is_file()).ok_or("runtime_unavailable")?;
    let mut command=Command::new(python);
    command.args(["-I","-u","-c",&runner_source()]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
    check_context(app,context)?;
    let mut child=command.spawn().map_err(|_|"runtime_unavailable")?;
    let result=(||{
        let mut input=child.stdin.take().ok_or("vault_unavailable")?;
        let bytes=serde_json::to_vec(&payload).map_err(|_|"invalid_target")?;
        if bytes.len()>32768 {return Err("invalid_target".into())}
        input.write_all(&bytes).and_then(|_|input.write_all(b"\n")).map_err(|_|"vault_unavailable")?;drop(input);
        let stdout=child.stdout.take().ok_or("vault_unavailable")?;
        let (sender,receiver)=mpsc::sync_channel(1);
        std::thread::spawn(move||{let mut bytes=Vec::new();let result=stdout.take(32769).read_to_end(&mut bytes).map(|_|bytes);let _=sender.send(result);});
        let deadline=Instant::now()+Duration::from_secs(150);
        while Instant::now()<deadline {
            check_context(app,context)?;
            match receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(bytes)) if bytes.len()<=32768=>return configuration_message(&bytes),
                Err(mpsc::RecvTimeoutError::Timeout)=>{},
                _=>return Err("vault_unavailable".into()),
            }
        }
        Err("vault_unavailable".into())
    })();
    #[cfg(unix)] unsafe {libc::kill(-(child.id() as i32),libc::SIGKILL);}
    let _=child.kill();let _=child.wait();result
}

#[tauri::command]
pub async fn server_power_import_configuration(app: tauri::AppHandle, server_id: String, expected_context: PowerContext) -> Result<Value, String> {
    if !cfg!(target_os="macos") || !identifier(&server_id) {return Err("invalid_target".into())}
    let path=format!("api/i7y/server-power/v1/servers/{server_id}");
    let data=api(&app,&expected_context,"GET",&path,None).await?;
    if data["can_configure"]!=true || data["provider_supported"]!=true {return Err("invalid_target".into())}
    let configuration=&data["configuration"];
    if !configuration.is_object() {return Err("vault_reference_missing".into())}
    let payload=json!({"action":"configuration","target":{"address":data["address"],"disk_credential":configuration["disk_credential"]}});
    let handle=app.clone();let context=expected_context.clone();
    let profile=tauri::async_runtime::spawn_blocking(move||read_configuration(&handle,&context,payload)).await.map_err(|_|"vault_unavailable")??;
    check_context(&app,&expected_context)?;
    let mut body=serde_json::to_value(profile).map_err(|_|"vault_metadata_invalid")?;
    body["version"]=data["profile"]["version"].as_u64().unwrap_or(0).into();
    body["credential_binding"]=configuration["credential_binding"].clone();
    api(&app,&expected_context,"PUT",&path,Some(body)).await
}

#[tauri::command]
pub async fn server_power_run(app: tauri::AppHandle, organization: String, server_id: String, action: String, request_id: String, version: u64, identity_file: String, via_automation_host: bool, op_account: String, expected_context: PowerContext) -> Result<Value, String> {
    if !cfg!(target_os = "macos") { return Err("runtime_unavailable".into()); }
    if !identifier(&server_id) || !identifier(&organization) || !supported_action(&action) || !(32..=36).contains(&request_id.len()) || !request_id.bytes().all(|b|b.is_ascii_hexdigit() || b==b'-') { return Err("invalid_target".into()); }
    let context = expected_context;
    if context.context.organization != organization {return Err("context_changed".into())}
    check_context(&app, &context)?;
    let base = format!("api/i7y/server-power/v1/servers/{server_id}/jobs");
    let job = api(&app, &context, "POST", &base, Some(json!({"action":action,"request_id":request_id,"version":version}))).await?;
    if job["replayed"] == true { return Ok(job); }
    let id = job["id"].as_str().filter(|id|identifier(id)).ok_or("invalid_target")?;
    let path = format!("{base}/{id}");
    let result = (|| {
        let target = &job["target"];
        let _ = op_account;
        let mut payload = json!({"action":action,"target":target,"identity_file":identity_file});
        if action == "start" && target["boot_host_key"].as_str().is_some_and(|k|!k.is_empty()) {
            i7y_core::ssh::canonical_key(target["boot_host_key"].as_str().ok_or("invalid_target")?).map_err(|_| "invalid_target")?;
            let identity = PathBuf::from(&identity_file);
            if !identity.is_absolute() || !identity.is_file() { return Err("invalid_target".to_string()); }
            if via_automation_host {
                let directory = controller_directory(&app, &context)?;
                let profile = crate::controller::read_profile(&directory.join("profile.json")).map_err(|_| "invalid_target")?.ok_or("invalid_target")?;
                payload["proxy"] = json!({"host":profile.host,"port":profile.port,"user":profile.user,"host_key":profile.host_key,"identity_file":profile.identity_file});
            }
        }
        Ok(payload)
    })();
    let outcome = match result {
        Ok(payload) => {
            let handle=app.clone(); let ctx=context.clone(); let job_path=path.clone(); let request=request_id.clone(); let server=server_id.clone();
            tauri::async_runtime::spawn_blocking(move ||run(&handle,&ctx,&job_path,&payload,&request,&server)).await.unwrap_or_else(|_|Err("operation_interrupted".into()))
        },
        Err(error) => Err(error),
    };
    let result = outcome.unwrap_or_else(|reason|{let status=if action=="inspect"||["invalid_target","runtime_unavailable"].contains(&reason.as_str()) {"failed"} else {"unknown"};json!({"status":status,"stage":status,"reason":reason})});
    check_context(&app,&context)?;
    api(&app,&context,"POST",&format!("{path}/finish"),Some(result)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_vault_adapter_runs_without_cwd_modules_or_cli_access() {
        let python=["/opt/homebrew/bin/python3","/usr/local/bin/python3","/usr/bin/python3"].iter().find(|path|std::path::Path::new(path).is_file()).unwrap();
        let source=format!("{}\nvault_module.executable = lambda name: (_ for _ in ()).throw(RuntimeError('CLI forbidden in fixture'))\n{}",vault_bootstrap(),RUNNER);
        let mut child=Command::new(python).args(["-I","-u","-c",&source]).current_dir(std::env::temp_dir()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(br#"{"action":"configuration","target":{"address":"192.0.2.1","disk_credential":{"version":2,"vault":"future-manager","account":"Fixture","item":"Fixture"}}}"#).unwrap();
        let output=child.wait_with_output().unwrap();
        assert!(output.status.success());
        let result:Value=serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["reason"],"vault_unsupported");
        assert_eq!(configuration_message(&output.stdout).err().unwrap(),"vault_unsupported");
    }
    #[test]
    fn vault_configuration_filters_secrets_and_rejects_ambiguous_payloads() {
        let profile=json!({"service_id":"123","vm_id":"456","boot_port":2222,"boot_host_key":"","luks_uuid":""});
        let parsed=configuration_message(&serde_json::to_vec(&json!({"kind":"configuration","profile":profile})).unwrap()).unwrap();
        assert_eq!(parsed.vm_id,"456");
        for extra in [json!({"password":"secret"}),json!({"vm_id":"../other"}),json!({"boot_port":0}),json!({"luks_uuid":"00000000-0000-0000-0000-000000000000"})] {
            let mut value=profile.clone();for (key,value_part) in extra.as_object().unwrap() {value[key]=value_part.clone();}
            assert!(configuration_message(&serde_json::to_vec(&json!({"kind":"configuration","profile":value})).unwrap()).is_err());
        }
        let error=configuration_message(br#"{"kind":"result","status":"failed","stage":"failed","reason":"vault_metadata_missing"}"#).err().unwrap();
        assert_eq!(error,"vault_metadata_missing");
    }
    fn prepared() -> (crate::connections::Registry, crate::mcp::Inner, ExpectedSource) {
        let backend = crate::backend::normalize_backend("https://a.test/").unwrap();
        let mut registry = crate::connections::decode(None, Some(&backend)).unwrap();
        let id = registry.selected.clone().unwrap();
        let session = crate::session::Session {token:"header.expiry.secret-a".into(),record:json!({"id":"same-user","collectionName":"users"})};
        registry.runtime.get_mut(&id).unwrap().session = Some(session.clone());
        let mut inner = crate::mcp::Inner::default();
        inner.backend = backend.to_string();inner.organization = "same-org".into();inner.session = Some(session.clone());
        let source = ExpectedSource {connection_id:id,backend:backend.to_string(),user:"same-user".into(),organization:"same-org".into(),session:session.public(0)["token"].as_str().unwrap().into()};
        (registry,inner,source)
    }
    #[test]
    fn native_selection_before_frontend_apply_rejects_the_confirmed_origin() {
        let (mut registry, mut inner, source) = prepared();
        let expected = bind_context(&registry,&inner,&source,7).unwrap();
        let b = crate::backend::normalize_backend("https://b.test/").unwrap();
        registry.items.push(crate::connections::Connection {id:"b".into(),name:"B".into(),url:b.clone(),instance_id:None});
        registry.runtime.insert("b".into(),crate::connections::Runtime {session:inner.session.clone(),generation:0});
        registry.selected = Some("b".into());inner.invalidate();inner.backend = b.to_string();inner.organization = "same-org".into();
        assert!(bind_context(&registry,&inner,&source,7).is_err());
        assert!(bound_session(&registry,&inner,&expected).is_err());
    }
    #[test]
    fn confirmed_actions_reject_relogin_refresh_org_user_and_returned_selection() {
        for change in ["refresh","relogin","organization","user","selection"] {
            let (mut registry, mut inner, source) = prepared();
            let expected = bind_context(&registry,&inner,&source,7).unwrap();
            match change {
                "refresh" => {let session=inner.session.clone().unwrap();registry.set_session(&source.connection_id,0,session).unwrap();},
                "relogin" => {registry.clear(&source.connection_id).unwrap();registry.set_session(&source.connection_id,1,inner.session.clone().unwrap()).unwrap();},
                "organization" => inner.organization = "other-org".into(),
                "user" => inner.session.as_mut().unwrap().record["id"] = json!("other-user"),
                _ => inner.invalidate(),
            }
            assert!(bound_session(&registry,&inner,&expected).is_err(),"{change}");
        }
    }
    #[test]
    fn accepted_context_uses_only_its_native_session_and_serializes_no_credential() {
        let (registry,inner,source) = prepared();
        let expected = bind_context(&registry,&inner,&source,7).unwrap();
        let (backend,session) = bound_session(&registry,&inner,&expected).unwrap();
        assert_eq!(backend.as_str(),source.backend);
        assert_eq!(session.token,"header.expiry.secret-a");
        let event = serde_json::to_string(&expected).unwrap();
        assert!(event.contains(&source.connection_id));
        assert!(!event.contains("secret-a"));
        assert!(!event.contains("native.expiry.session"));
    }
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

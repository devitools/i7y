use crate::platform::{SecretStore, SystemSecretStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    pub record: Value,
}
impl Session {
    pub fn public(&self) -> Value {
        let payload = self.token.split('.').nth(1).unwrap_or("");
        json!({"token":format!("native.{payload}.session"),"record":self.record})
    }
}
pub fn account(app:&tauri::AppHandle,backend: &str) -> String {
    i7y_mcp::digest(&json!([app.config().identifier,cfg!(debug_assertions),backend]))
}
pub fn persist(app:&tauri::AppHandle,backend: &str, session: Option<&Session>) -> Result<(), String> {
    SystemSecretStore.write(
        &account(app,backend),
        session
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "Invalid session")?
            .as_deref(),
    )
}
pub fn store(
    app: &tauri::AppHandle,
    connection_id: &str,
    value: &mut Value,
    expected_generation: u64,
) -> Result<(), String> {
    let token = value["token"].as_str().ok_or("Invalid session response")?;
    let record = value.get("record").ok_or("Invalid session response")?;
    if record["collectionName"] != "users" {return Err("Only human user sessions are supported".into())}
    let session = Session {token: token.into(),record:record.clone()};
    let state = app.state::<crate::backend::Backend>();
    let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    registry.current(connection_id, expected_generation)?;
    let backend = registry.connection(connection_id)?.url.clone();
    persist(app, backend.as_str(), Some(&session))?;
    let selected = registry.selected.as_deref() == Some(connection_id);
    registry.set_session(connection_id, expected_generation, session.clone())?;
    if selected {
        let service = app.state::<crate::mcp::Service>();
        let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
        if inner.backend != backend.as_str() || inner.session.as_ref().map(|saved| &saved.record["id"]) != Some(&session.record["id"]) {inner.invalidate();inner.organization.clear();inner.organization_name.clear();}
        inner.backend = backend.to_string();
        inner.session = Some(session.clone());
    }
    *value = session.public();
    Ok(())
}
#[tauri::command]
pub async fn desktop_session_restore(
    app: tauri::AppHandle,
    connection_id: Option<String>,
    legacy_token: Option<String>,
) -> Result<Value, String> {
    let id = crate::connections::resolve(&app, connection_id.as_deref())?;
    let state = app.state::<crate::backend::Backend>();
    let (backend, generation, _) = state.connections.lock().map_err(|_| "Connections unavailable")?.snapshot(&id)?;
    let stored = SystemSecretStore.read(&account(&app, backend.as_str()))?;
    let token = if let Some(saved) = stored {serde_json::from_str::<Session>(&saved).map_err(|_| "Invalid stored session")?.token} else {legacy_token.unwrap_or_default()};
    if token.is_empty() {return Ok(Value::Null)}
    let response = state.client.post(backend.join("api/collections/users/auth-refresh").map_err(|_| "Invalid backend")?).bearer_auth(token).send().await.map_err(|_| "Unable to validate session")?;
    if !response.status().is_success() {
        if [400, 401, 403].contains(&response.status().as_u16()) {clear_if_current(&app, &id, generation)?;return Ok(Value::Null)}
        return Err("Unable to validate session".into());
    }
    let mut value = response.json::<Value>().await.map_err(|_| "Invalid session response")?;
    store(&app, &id, &mut value, generation)?;
    Ok(value)
}
fn clear(app: &tauri::AppHandle, id: &str, expected: Option<u64>) -> Result<(), String> {
    let state = app.state::<crate::backend::Backend>();
    let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    if let Some(expected) = expected {registry.current(id, expected)?;}
    let backend = registry.connection(id)?.url.clone();
    persist(app, backend.as_str(), None)?;
    registry.clear(id)?;
    if registry.selected.as_deref() == Some(id) {
        let service = app.state::<crate::mcp::Service>();
        let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
        inner.invalidate();inner.session = None;inner.organization.clear();inner.organization_name.clear();
    }
    Ok(())
}
pub fn clear_if_current(app: &tauri::AppHandle, id: &str, generation: u64) -> Result<(), String> {clear(app, id, Some(generation))}
#[tauri::command]
pub fn desktop_connection_logout(app: tauri::AppHandle, connection_id: String) -> Result<(), String> {clear(&app, &connection_id, None)}
#[tauri::command]
pub fn desktop_session_clear(app: tauri::AppHandle) -> Result<(), String> {
    match crate::connections::resolve(&app, None) {Ok(id) => clear(&app, &id, None),Err(_) => Ok(())}
}
fn begin_context(
    connections: &std::sync::Mutex<crate::connections::Registry>,
    session: &std::sync::Mutex<crate::mcp::Inner>,
    id: &str,
    organization: &str,
) -> Result<Option<(url::Url, u64, Option<Session>, u64)>, String> {
    let registry = connections.lock().map_err(|_| "Connections unavailable")?;
    if registry.selected.as_deref() != Some(id) {return Err("Selected connection changed".into())}
    let (backend, connection_generation, session_snapshot) = registry.snapshot(id)?;
    let mut inner = session.lock().map_err(|_| "Session unavailable")?;
    if inner.backend != backend.as_str() {return Err("Selected connection changed".into())}
    if inner.organization == organization {return Ok(None)}
    inner.invalidate();inner.organization.clear();inner.organization_name.clear();
    Ok(Some((backend, connection_generation, session_snapshot, inner.generation)))
}
#[tauri::command]
pub async fn desktop_session_context(
    app: tauri::AppHandle,
    connection_id: Option<String>,
    organization: Option<String>,
) -> Result<(), String> {
    let id = crate::connections::resolve(&app, connection_id.as_deref())?;
    let state = app.state::<crate::backend::Backend>();
    let organization = organization.unwrap_or_default();
    let service = app.state::<crate::mcp::Service>();
    let Some((backend, connection_generation, session, generation)) = begin_context(&state.connections, &service.inner, &id, &organization)? else {return Ok(())};
    let mut organization_name = String::new();
    if !organization.is_empty() {
        let session = session.ok_or("Sign in required")?;
        let response = state.client.get(backend.join("api/i7y/organizations").map_err(|_| "Invalid backend")?).bearer_auth(session.token).send().await.map_err(|_| "Unable to load organizations")?;
        if !response.status().is_success() {return Err("Organization access denied".into())}
        let response = response.json::<Value>().await.map_err(|_| "Invalid organizations response")?;
        organization_name = response["items"].as_array().and_then(|items| items.iter().find(|item| item["id"] == organization)).and_then(|item| item["name"].as_str()).ok_or("Organization access denied")?.to_owned();
    }
    let registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    registry.current(&id, connection_generation)?;
    if registry.selected.as_deref() != Some(&id) {return Err("Selected connection changed".into())}
    let service = app.state::<crate::mcp::Service>();
    let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
    if inner.generation != generation {return Err("Session context changed".into())}
    inner.organization = organization;inner.organization_name = organization_name;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_begin_holds_selection_lock_until_invalidation_and_rejects_stale_sources() {
        use std::sync::{Arc, Mutex, mpsc};
        let a_url = crate::backend::normalize_backend("https://a.test/").unwrap();
        let b_url = crate::backend::normalize_backend("https://b.test/").unwrap();
        let mut registry = crate::connections::decode(None, Some(&a_url)).unwrap();
        let a = registry.selected.clone().unwrap();
        registry.items.push(crate::connections::Connection {id:"b".into(),name:"B".into(),url:b_url.clone(),instance_id:None});
        registry.runtime.insert("b".into(), crate::connections::Runtime::default());
        let registry = Arc::new(Mutex::new(registry));
        let session = Arc::new(Mutex::new(crate::mcp::Inner::default()));
        let mut held = session.lock().unwrap();
        held.backend = a_url.to_string();held.organization = "org-a".into();
        let (started, waiting) = mpsc::channel();
        let worker_registry = registry.clone();let worker_session = session.clone();let worker_a = a.clone();
        let context = std::thread::spawn(move || {
            started.send(()).unwrap();
            begin_context(&worker_registry, &worker_session, &worker_a, "new-org-a")
        });
        waiting.recv().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while registry.try_lock().is_ok() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let switch_registry = registry.clone();let switch_session = session.clone();
        let (started, switching) = mpsc::channel();
        let selection = std::thread::spawn(move || {
            started.send(()).unwrap();
            let mut registry = switch_registry.lock().unwrap();
            let mut inner = switch_session.lock().unwrap();
            registry.selected = Some("b".into());
            inner.invalidate();inner.backend = b_url.to_string();inner.organization = "org-b".into();inner.organization_name = "B organization".into();
            inner.session = Some(Session {token:"b-secret".into(),record:json!({"id":"b-user"})});
            let context = inner.context(inner.backend.clone()).unwrap();
            inner.connections.insert("b-approval".into(), crate::mcp::Connection {id:"b-approval".into(),client:json!({}),context,authorized:true,authorization_expires_at:u64::MAX});
        });
        switching.recv().unwrap();
        assert!(registry.try_lock().is_err());
        drop(held);
        assert!(context.join().unwrap().unwrap().is_some());
        selection.join().unwrap();
        let generation = session.lock().unwrap().generation;
        assert!(begin_context(&registry, &session, &a, "stale-org-a").is_err());
        let inner = session.lock().unwrap();
        assert_eq!(inner.generation, generation);
        assert_eq!(inner.organization, "org-b");
        assert_eq!(inner.organization_name, "B organization");
        assert!(inner.connections.get("b-approval").unwrap().authorized);
    }
    #[test]
    fn frontend_marker_never_contains_a_usable_backend_token() {
        let session = Session {
            token: "header.expiry.signature-secret".into(),
            record: json!({"id":"human"}),
        };
        let view = session.public();
        assert_eq!(view["token"], "native.expiry.session");
        assert!(!view.to_string().contains("signature-secret"));
        assert_eq!(view["record"]["id"], "human");
    }
}

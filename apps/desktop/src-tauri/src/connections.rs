use crate::{backend::normalize_backend, session::Session};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(with = "url_value")]
    pub url: Url,
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Default)]
pub struct Runtime {
    pub session: Option<Session>,
    pub generation: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Registry {
    pub items: Vec<Connection>,
    pub selected: Option<String>,
    #[serde(skip)]
    pub runtime: HashMap<String, Runtime>,
}

impl Registry {
    pub fn connection(&self, id: &str) -> Result<&Connection, String> {
        self.items.iter().find(|item| item.id == id).ok_or_else(|| "Connection unavailable".into())
    }
    pub fn snapshot(&self, id: &str) -> Result<(Url, u64, Option<Session>), String> {
        let connection = self.connection(id)?;
        let runtime = self.runtime.get(id).ok_or("Connection unavailable")?;
        Ok((connection.url.clone(), runtime.generation, runtime.session.clone()))
    }
    pub fn current(&self, id: &str, generation: u64) -> Result<(), String> {
        self.connection(id)?;
        if self.runtime.get(id).map(|runtime| runtime.generation) != Some(generation) {
            return Err("Connection session changed".into());
        }
        Ok(())
    }
    pub fn set_session(&mut self, id: &str, generation: u64, session: Session) -> Result<(), String> {
        self.current(id, generation)?;
        let runtime = self.runtime.get_mut(id).ok_or("Connection unavailable")?;
        runtime.generation += 1;runtime.session = Some(session);
        Ok(())
    }
    pub fn remove(&mut self, id: &str) -> Result<bool, String> {
        self.connection(id)?;
        let selected = self.selected.as_deref() == Some(id);
        self.items.retain(|item| item.id != id);self.runtime.remove(id);
        if selected {self.selected = self.items.first().map(|item| item.id.clone());}
        Ok(selected)
    }
    pub fn clear(&mut self, id: &str) -> Result<(), String> {
        self.connection(id)?;
        let runtime = self.runtime.get_mut(id).ok_or("Connection unavailable")?;
        runtime.generation += 1;
        runtime.session = None;
        Ok(())
    }
}

fn file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|_| "Unable to locate application settings")?.join("connections.json"))
}

pub fn decode(contents: Option<&str>, legacy: Option<&Url>) -> Result<Registry, String> {
    let mut registry: Registry = match contents {
        Some(contents) => serde_json::from_str(contents).map_err(|_| "Invalid connection settings")?,
        None => Registry::default(),
    };
    if contents.is_none() {
        if let Some(url) = legacy {
            let id = i7y_mcp::digest(&serde_json::json!([url.as_str()]));
            registry.items.push(Connection {id: id.clone(), name: url.host_str().unwrap_or("i7y").into(), url: url.clone(), instance_id: None});
            registry.selected = Some(id);
        }
    }
    let mut urls = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for item in &mut registry.items {
        item.url = normalize_backend(item.url.as_str())?;
        if item.id.is_empty() || !ids.insert(item.id.clone()) || !urls.insert(item.url.clone()) {
            return Err("Invalid connection settings".into());
        }
        registry.runtime.insert(item.id.clone(), Runtime::default());
    }
    if !registry.items.iter().any(|item| Some(&item.id) == registry.selected.as_ref()) {
        registry.selected = registry.items.first().map(|item| item.id.clone());
    }
    Ok(registry)
}

pub fn load(app: &tauri::AppHandle, legacy: Option<&Url>) -> Result<Registry, String> {
    let path = file(app)?;
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Unable to read connection settings".into()),
    };
    let registry = decode(contents.as_deref(), legacy)?;
    if contents.is_none() { save(app, &registry)?; }
    Ok(registry)
}

pub fn save(app: &tauri::AppHandle, registry: &Registry) -> Result<(), String> {
    let path = file(app)?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|_| "Unable to save connections")?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(registry).map_err(|_| "Invalid connections")?).map_err(|_| "Unable to save connections")?;
    std::fs::rename(temporary, path).map_err(|_| "Unable to save connections".into())
}

pub fn resolve(app: &tauri::AppHandle, id: Option<&str>) -> Result<String, String> {
    let state = app.state::<crate::backend::Backend>();
    let registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    let id = id.map(str::to_owned).or_else(|| registry.selected.clone()).ok_or("Select a connection first")?;
    registry.connection(&id)?;
    Ok(id)
}

pub fn sync_selected(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<crate::backend::Backend>();
    let registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    if registry.selected.as_deref() != Some(id) {return Ok(())}
    let (url, _, session) = registry.snapshot(id)?;
    *state.url.lock().map_err(|_| "Backend unavailable")? = Some(url.clone());
    let service = app.state::<crate::mcp::Service>();
    let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
    inner.invalidate();
    inner.organization.clear();
    inner.organization_name.clear();
    inner.session = session;
    inner.backend = url.to_string();
    Ok(())
}

#[tauri::command]
pub fn get_connections(state: tauri::State<'_, crate::backend::Backend>) -> Result<serde_json::Value, String> {
    let registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    serde_json::to_value(&*registry).map_err(|_| "Invalid connections".into())
}

#[tauri::command]
pub async fn add_connection(app: tauri::AppHandle, backend_url: String, name: String) -> Result<Connection, String> {
    let url = normalize_backend(&backend_url)?;
    let state = app.state::<crate::backend::Backend>();
    let response = state.client.get(url.join("api/i7y/desktop").map_err(|_| "Invalid backend URL")?).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|_| "Unable to connect to the backend")?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 65536 {return Err("Browser sign-in is not available on this server yet".into())}
    let data: serde_json::Value = response.json().await.map_err(|_| "This address is not an i7y backend")?;
    if data["browser_login"] != true {return Err("Browser sign-in is not available on this server yet".into())}
    let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    if let Some(existing) = registry.items.iter().find(|item| item.url == url) {return Ok(existing.clone())}
    let name = name.trim();
    if name.len() > 160 {return Err("Connection name is too long".into())}
    let connection = Connection {id: i7y_mcp::digest(&serde_json::json!([url.as_str(), rand::random::<u64>()])),name: if name.is_empty() {url.host_str().unwrap_or("i7y").into()} else {name.into()},url,instance_id:data["instance_id"].as_str().map(str::to_owned)};
    registry.runtime.insert(connection.id.clone(), Runtime::default());
    registry.items.push(connection.clone());
    save(&app, &registry)?;
    Ok(connection)
}

#[tauri::command]
pub fn select_connection(app: tauri::AppHandle, connection_id: String) -> Result<(), String> {
    let state = app.state::<crate::backend::Backend>();
    let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    let (url, _, session) = registry.snapshot(&connection_id)?;
    if registry.selected.as_deref() == Some(&connection_id) {return Ok(())}
    let service = app.state::<crate::mcp::Service>();
    let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
    inner.invalidate();inner.organization.clear();inner.organization_name.clear();inner.session = session;inner.backend = url.to_string();
    *state.url.lock().map_err(|_| "Backend unavailable")? = Some(url);
    registry.selected = Some(connection_id);
    save(&app, &registry)
}

#[tauri::command]
pub fn rename_connection(app: tauri::AppHandle, connection_id: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 160 {return Err("Use a connection name of at most 160 characters".into())}
    let state = app.state::<crate::backend::Backend>();
    let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
    let connection = registry.items.iter_mut().find(|item| item.id == connection_id).ok_or("Connection unavailable")?;
    connection.name = name.into();
    save(&app, &registry)
}

#[tauri::command]
pub fn remove_connection(app: tauri::AppHandle, connection_id: String) -> Result<(), String> {
    crate::session::desktop_connection_logout(app.clone(), connection_id.clone())?;
    let state = app.state::<crate::backend::Backend>();
    let (changed, next) = {
        let mut registry = state.connections.lock().map_err(|_| "Connections unavailable")?;
        let changed = registry.remove(&connection_id)?;
        save(&app, &registry)?;
        (changed, registry.selected.clone())
    };
    if changed {if let Some(next) = next {sync_selected(&app, &next)?} else {*state.url.lock().map_err(|_| "Backend unavailable")? = None;}}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_url_preserves_keychain_identity_without_serializing_secrets() {
        let url = normalize_backend("https://example.test/i7y").unwrap();
        let mut registry = decode(None, Some(&url)).unwrap();
        let id = registry.selected.clone().unwrap();
        registry.runtime.get_mut(&id).unwrap().session = Some(Session {token:"secret".into(),record:serde_json::json!({"id":"a"})});
        assert_eq!(registry.snapshot(&id).unwrap().0, url);
        let disk = serde_json::to_string(&registry).unwrap();
        assert!(!disk.contains("secret"));
        assert_eq!(decode(Some(&disk), None).unwrap().selected, Some(id));
    }
    #[test]
    fn sessions_and_stale_completion_are_isolated_per_connection() {
        let mut registry = decode(None, Some(&normalize_backend("https://a.test").unwrap())).unwrap();
        let a = registry.selected.clone().unwrap();
        registry.items.push(Connection {id:"b".into(),name:"B".into(),url:normalize_backend("https://b.test").unwrap(),instance_id:None});
        registry.runtime.insert("b".into(), Runtime::default());
        registry.runtime.get_mut("b").unwrap().session = Some(Session {token:"b-secret".into(),record:serde_json::json!({"id":"b"})});
        let (_, generation, _) = registry.snapshot(&a).unwrap();
        registry.clear(&a).unwrap();
        assert!(registry.current(&a, generation).is_err());
        assert!(registry.set_session(&a, generation, Session {token:"stale-a".into(),record:serde_json::json!({"id":"old"})}).is_err());
        assert!(registry.snapshot(&a).unwrap().2.is_none());
        assert!(registry.current("b", 0).is_ok());
        assert_eq!(registry.snapshot("b").unwrap().2.unwrap().token,"b-secret");
        registry.selected = Some("b".into());
        assert!(!registry.remove(&a).unwrap());
        assert_eq!(registry.selected.as_deref(), Some("b"));
        assert!(registry.current(&a, 1).is_err());
        assert!(registry.current("b", 0).is_ok());
    }
}

mod url_value {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(url: &url::Url, serializer: S) -> Result<S::Ok, S::Error> {serializer.serialize_str(url.as_str())}
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<url::Url, D::Error> {url::Url::parse(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)}
}

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
    backend: &str,
    value: &mut Value,
    expected_generation: u64,
) -> Result<(), String> {
    if let (Some(token), Some(record)) = (value["token"].as_str(), value.get("record")) {
        if record["collectionName"] != "users" {
            return Err("Only human user sessions are supported".into());
        }
        let session = Session {
            token: token.into(),
            record: record.clone(),
        };
        let state = app.state::<crate::mcp::Service>();
        let mut inner = state.inner.lock().map_err(|_| "Session unavailable")?;
        if inner.generation != expected_generation {
            return Err("Session context changed".into());
        }
        persist(app,backend, Some(&session))?;
        if inner.session.as_ref().map(|s| &s.record["id"]) != Some(&session.record["id"]) {
            inner.invalidate();
        }
        inner.session = Some(session.clone());
        *value = session.public();
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_session_restore(
    app: tauri::AppHandle,
    legacy_token: Option<String>,
) -> Result<Value, String> {
    let state = app.state::<crate::backend::Backend>();
    let backend = state
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .clone()
        .ok_or("Select a backend first")?;
    let stored = SystemSecretStore.read(&account(&app,backend.as_str()))?;
    let generation = app
        .state::<crate::mcp::Service>()
        .inner
        .lock()
        .map_err(|_| "Session unavailable")?
        .generation;
    let token = if let Some(saved) = stored {
        serde_json::from_str::<Session>(&saved)
            .map_err(|_| "Invalid stored session")?
            .token
    } else {
        legacy_token.unwrap_or_default()
    };
    if token.is_empty() {
        return Ok(Value::Null);
    }
    let response = state
        .client
        .post(
            backend
                .join("api/collections/users/auth-refresh")
                .map_err(|_| "Invalid backend")?,
        )
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Unable to validate session")?;
    if !response.status().is_success() {
        if app
            .state::<crate::mcp::Service>()
            .inner
            .lock()
            .map_err(|_| "Session unavailable")?
            .generation
            != generation
        {
            return Err("Session context changed".into());
        }
        desktop_session_clear(app.clone())?;
        return Ok(Value::Null);
    }
    let mut value = response
        .json::<Value>()
        .await
        .map_err(|_| "Invalid session response")?;
    if state
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .as_ref()
        != Some(&backend)
    {
        return Err("Backend changed".into());
    }
    store(&app, backend.as_str(), &mut value, generation)?;
    Ok(value)
}
#[tauri::command]
pub fn desktop_session_clear(app: tauri::AppHandle) -> Result<(), String> {
    let backend = app
        .state::<crate::backend::Backend>()
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .clone();
    let service = app.state::<crate::mcp::Service>();
    let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
    inner.invalidate();
    inner.session = None;
    inner.organization.clear();
    inner.organization_name.clear();
    drop(inner);
    if let Some(backend) = backend {
        persist(&app,backend.as_str(), None)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_session_context(
    app: tauri::AppHandle,
    organization: Option<String>,
) -> Result<(), String> {
    let organization = organization.unwrap_or_default();
    let generation = {
        let service = app.state::<crate::mcp::Service>();
        let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
        if inner.organization == organization {
            return Ok(());
        }
        inner.invalidate();
        inner.organization.clear();
        inner.organization_name.clear();
        inner.generation
    };
    let mut organization_name = String::new();
    if !organization.is_empty() {
        let response = crate::mcp::api(
            &app,
            "GET",
            "api/i7y/organizations",
            vec![],
            None,
            None,
            None,
            None,
        )
        .await?;
        organization_name = response["items"].as_array().and_then(|items| items.iter().find(|item| item["id"] == organization)).and_then(|item| item["name"].as_str()).unwrap_or("").to_owned();
        if !response["items"]
            .as_array()
            .map(|items| items.iter().any(|item| item["id"] == organization))
            .unwrap_or(false)
        {
            return Err("Organization access denied".into());
        }
    }
    let service = app.state::<crate::mcp::Service>();
    let mut inner = service.inner.lock().map_err(|_| "Session unavailable")?;
    if inner.generation != generation {
        return Err("Session context changed".into());
    }
    inner.organization = organization;
    inner.organization_name = organization_name;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

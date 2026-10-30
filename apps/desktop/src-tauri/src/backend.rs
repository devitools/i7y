use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Manager;
use url::Url;

pub struct Backend {
    pub url: Mutex<Option<Url>>,
    pub client: reqwest::Client,
}

pub fn normalize_backend(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input.trim()).map_err(|_| "Invalid backend URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use a backend URL without credentials, query parameters or fragments".into());
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Remote backends must use HTTPS".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

pub fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
}

fn config_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "Unable to locate application settings")?
        .join("backend-url.txt"))
}

pub fn load(app: &tauri::AppHandle) -> Option<Url> {
    let contents = std::fs::read_to_string(config_file(app).ok()?).ok()?;
    normalize_backend(&contents).ok()
}

#[tauri::command]
pub fn get_backend(state: tauri::State<'_, Backend>) -> Result<Option<String>, String> {
    Ok(state
        .url
        .lock()
        .map_err(|_| "Unable to read backend settings")?
        .as_ref()
        .map(Url::to_string))
}

#[tauri::command]
pub async fn set_backend(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    backend_url: String,
) -> Result<String, String> {
    let url = normalize_backend(&backend_url)?;
    let response = state
        .client
        .get(
            url.join("api/i7y/desktop")
                .map_err(|_| "Invalid backend URL")?,
        )
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Unable to connect to the backend")?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 65536 {
        return Err("Browser sign-in is not available on this server yet".into());
    }
    let data = response
        .json::<HashMap<String, bool>>()
        .await
        .map_err(|_| "This address is not an i7y backend")?;
    if data.get("browser_login") != Some(&true) {
        return Err("Browser sign-in is not available on this server yet".into());
    }
    crate::session::desktop_session_clear(app.clone())?;
    let file = config_file(&app)?;
    std::fs::create_dir_all(file.parent().ok_or("Invalid settings path")?)
        .map_err(|_| "Unable to save backend settings")?;
    std::fs::write(&file, url.as_str()).map_err(|_| "Unable to save backend settings")?;
    *state
        .url
        .lock()
        .map_err(|_| "Unable to save backend settings")? = Some(url.clone());
    Ok(url.to_string())
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    body: String,
    content_type: String,
}

pub fn api_target(backend: &Url, input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "Invalid API URL")?;
    let prefix = format!("{}api/", backend.path());
    if url.origin() != backend.origin()
        || !url.path().starts_with(&prefix)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("API requests must use the selected backend".into());
    }
    Ok(url)
}

fn target_is_auth(backend: &Url, target: &Url) -> Result<bool, String> {
    let prefix = format!("{}api/", backend.path());
    let path = target
        .path()
        .strip_prefix(&prefix)
        .ok_or("API requests must use the selected backend")?;
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = bytes.next().and_then(|v| (v as char).to_digit(16));
            let low = bytes.next().and_then(|v| (v as char).to_digit(16));
            let (Some(high), Some(low)) = (high, low) else {
                return Err("Invalid API path encoding".into());
            };
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let segments: Vec<_> = decoded.split(|byte| *byte == b'/').collect();
    Ok(
        matches!(segments.as_slice(), [b"i7y", b"desktop", b"exchange"])
            || matches!(segments.as_slice(), [b"collections", collection, action]
            if !collection.is_empty() && action.starts_with(b"auth-")),
    )
}

fn contains_session_credential(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => {
            (value["token"].is_string() && value["record"]["collectionName"] == "users")
                || fields.values().any(contains_session_credential)
        }
        serde_json::Value::Array(items) => items.iter().any(contains_session_credential),
        _ => false,
    }
}

fn public_api_body(
    backend: &Url,
    target: &Url,
    status: u16,
    body: String,
    store: impl FnOnce(&mut serde_json::Value) -> Result<(), String>,
) -> Result<String, String> {
    let authentication = target_is_auth(backend, target)?;
    let successful = (200..300).contains(&status);
    let mut value: serde_json::Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) if authentication && successful => {
            return Err("Invalid authentication response".into());
        }
        Err(_) => return Ok(body),
    };
    if authentication && successful && value["token"].is_string() {
        if value["record"]["collectionName"] != "users"
            || value
                .as_object()
                .map(|fields| fields.values().any(contains_session_credential))
                .unwrap_or(false)
        {
            return Err("Invalid authentication response".into());
        }
        let public = crate::session::Session {
            token: value["token"].as_str().unwrap().into(),
            record: value["record"].clone(),
        }
        .public();
        store(&mut value)?;
        if value != public {
            return Err("Authentication credential was not isolated".into());
        }
        return Ok(value.to_string());
    }
    if contains_session_credential(&value) {
        return Err("Unexpected authentication response".into());
    }
    if authentication && value.get("token").is_some() {
        return Err("Invalid authentication response".into());
    }
    Ok(body)
}

#[tauri::command]
pub async fn backend_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    let backend = state
        .url
        .lock()
        .map_err(|_| "Unable to read backend settings")?
        .clone()
        .ok_or("Select a backend first")?;
    let generation = app
        .state::<crate::mcp::Service>()
        .inner
        .lock()
        .map_err(|_| "Session unavailable")?
        .generation;
    let target = api_target(&backend, &url)?;
    target_is_auth(&backend, &target)?;
    if !["GET", "POST", "PATCH", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err("Unsupported API method".into());
    }
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid API method")?;
    let mut request = state.client.request(method, target.clone());
    for (key, value) in headers {
        if ![
            "authorization",
            "content-type",
            "accept",
            "x-i7y-organization",
            "accept-language",
        ]
        .contains(&key.to_lowercase().as_str())
        {
            return Err("Unsupported API header".into());
        }
        if key.eq_ignore_ascii_case("authorization") {
            let token = app
                .state::<crate::mcp::Service>()
                .inner
                .lock()
                .map_err(|_| "Session unavailable")?
                .session
                .as_ref()
                .map(|s| s.token.clone());
            if let Some(token) = token {
                request = request.bearer_auth(token);
            } else if !value.is_empty() {
                return Err("Sign in required".into());
            }
        } else {
            request = request.header(key, value);
        }
    }
    if let Some(body) = body {
        request = request.body(body)
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Unable to reach the selected backend")?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unable to read API response")?
    {
        if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("API response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "Unsupported API response")?;
    if state
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .as_ref()
        != Some(&backend)
    {
        return Err("Backend changed".into());
    }
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
    let body = public_api_body(&backend, &target, status, body, |value| {
        crate::session::store(&app, backend.as_str(), value, generation)
    })?;
    if status == 401 {
        crate::session::desktop_session_clear(app)?;
    }
    Ok(ApiResponse {
        status,
        body,
        content_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_response() -> String {
        serde_json::json!({
            "token":"header.expiry.private-signature",
            "record":{"id":"human","collectionName":"users"}
        })
        .to_string()
    }

    fn isolate_session(value: &mut serde_json::Value) -> Result<(), String> {
        *value = crate::session::Session {
            token: value["token"].as_str().unwrap().into(),
            record: value["record"].clone(),
        }
        .public();
        Ok(())
    }

    #[test]
    fn canonical_and_encoded_authentication_responses_keep_credentials_native() {
        for base in ["https://example.test/", "https://example.test/inventory/"] {
            let backend = normalize_backend(base).unwrap();
            for path in [
                "collections/users/auth-refresh",
                "collections/users/%61uth-refresh",
                "collections/%75sers/auth-refresh",
                "collections/users/auth%2Drefresh",
                "collections/users%2Fauth-refresh",
                "collections/pbc_3142635823/auth-refresh",
                "i7y/desktop/exchange",
                "i7y/desktop/%65xchange",
            ] {
                let input = format!("{base}api/{path}?expand=organization&fields=token%2Crecord");
                let target = api_target(&backend, &input).unwrap();
                assert_eq!(target.as_str(), input);
                assert!(target_is_auth(&backend, &target).unwrap(), "{input}");
                let mut stored = false;
                let body = public_api_body(&backend, &target, 200, session_response(), |value| {
                    stored = true;
                    isolate_session(value)
                })
                .unwrap();
                assert!(stored);
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["token"], "native.expiry.session");
                assert!(!body.contains("private-signature"));
            }
        }
    }

    #[test]
    fn ordinary_api_targets_and_explicit_api_tokens_preserve_their_contents() {
        let backend = normalize_backend("https://example.test/inventory/").unwrap();
        for path in [
            "collections/users/records/auth-record1234?expand=organization",
            "collections/projects/records/example12345678?filter=name%3D%22auth-refresh%22",
            "files/example/record/a%20file.txt?download=1",
            "i7y/tokens?label=%2Fapi%2Fcollections%2Fusers%2Fauth-refresh",
            "i7y/tokens?label=/api/i7y/desktop/exchange",
        ] {
            let input = format!("{}api/{path}", backend.as_str());
            let target = api_target(&backend, &input).unwrap();
            assert_eq!(target.as_str(), input);
            assert!(!target_is_auth(&backend, &target).unwrap(), "{input}");
            let body =
                serde_json::json!({"id":"generated","token":"i7y_explicit-api-token"}).to_string();
            let visible = public_api_body(&backend, &target, 201, body.clone(), |_| {
                panic!("API token must not replace the native session")
            })
            .unwrap();
            assert_eq!(visible, body);
        }
        let target = api_target(
            &backend,
            "https://example.test/inventory/api/collections/users/auth-methods",
        )
        .unwrap();
        let methods = r#"{"password":{"enabled":true}}"#.to_owned();
        assert_eq!(
            public_api_body(&backend, &target, 200, methods.clone(), |_| panic!(
                "No session to store"
            ))
            .unwrap(),
            methods
        );
    }

    #[test]
    fn unexpected_or_unisolated_authentication_credentials_fail_closed() {
        let backend = normalize_backend("https://example.test/").unwrap();
        let ordinary = api_target(&backend, "https://example.test/api/i7y/tokens").unwrap();
        for body in [
            session_response(),
            format!(r#"{{"data":{}}}"#, session_response()),
            format!("[{}]", session_response()),
        ] {
            assert!(public_api_body(&backend, &ordinary, 200, body, |_| panic!(
                "Unexpected session must not be stored"
            ))
            .is_err());
        }
        let auth = api_target(
            &backend,
            "https://example.test/api/collections/users/%61uth-refresh",
        )
        .unwrap();
        assert!(public_api_body(&backend, &auth, 200, session_response(), |_| Ok(())).is_err());
        assert!(
            public_api_body(&backend, &auth, 200, session_response(), |_| Err(
                "Persistence failed".into()
            ))
            .is_err()
        );
        assert!(
            public_api_body(&backend, &auth, 400, session_response(), |_| panic!(
                "Failed response must not be stored"
            ))
            .is_err()
        );
        assert!(public_api_body(
            &backend,
            &auth,
            200,
            r#"{"token":"secret"}"#.into(),
            isolate_session
        )
        .is_err());
        assert!(public_api_body(
            &backend,
            &auth,
            400,
            r#"{"token":"secret"}"#.into(),
            isolate_session
        )
        .is_err());
        assert!(
            public_api_body(&backend, &auth, 200, "invalid JSON".into(), isolate_session).is_err()
        );
        let nested = format!(
            r#"{{"token":"header.expiry.private-signature","record":{{"collectionName":"users","nested":{}}}}}"#,
            session_response()
        );
        assert!(public_api_body(&backend, &auth, 200, nested, isolate_session).is_err());
    }

    #[test]
    fn validates_backend_and_isolates_api_requests() {
        for invalid in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/?key=secret",
            "https://example.com/#login",
            "file:///tmp/test",
        ] {
            assert!(normalize_backend(invalid).is_err());
        }
        for local in [
            "http://localhost:8097",
            "http://127.0.0.1:8097",
            "http://[::1]:8097",
        ] {
            assert!(normalize_backend(local).is_ok());
        }
        let backend = normalize_backend(" https://inventory.example.com/i7y ").unwrap();
        assert_eq!(backend.as_str(), "https://inventory.example.com/i7y/");
        assert!(api_target(&backend, "https://inventory.example.com/i7y/api/health").is_ok());
        for invalid in [
            "https://other.example.com/i7y/api/health",
            "https://inventory.example.com/api/health",
            "https://inventory.example.com/i7y/api/../private",
            "https://inventory.example.com/i7y/api/health#fragment",
        ] {
            assert!(api_target(&backend, invalid).is_err());
        }
    }
}

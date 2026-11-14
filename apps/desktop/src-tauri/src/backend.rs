use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::Manager;
use url::Url;

pub struct Backend {
    pub url: Mutex<Option<Url>>,
    pub client: reqwest::Client,
    pub connections: Mutex<crate::connections::Registry>,
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
    backend_url: String,
) -> Result<String, String> {
    let connection = crate::connections::add_connection(app.clone(), backend_url, String::new()).await?;
    crate::connections::select_connection(app, connection.id)?;
    Ok(connection.url.to_string())
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
    public_generation: u64,
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
        .public(public_generation);
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

fn request_headers(mut request: reqwest::RequestBuilder, headers: HashMap<String, String>, session: Option<&crate::session::Session>, generation: u64) -> Result<reqwest::RequestBuilder, String> {
    for (key, value) in headers {
        if ![
            "authorization",
            "content-type",
            "accept",
            "x-i7y-organization",
            "accept-language",
            "x-i7y-expected-revision",
        ]
        .contains(&key.to_lowercase().as_str())
        {
            return Err("Unsupported API header".into());
        }
        if key.eq_ignore_ascii_case("authorization") {
            let marker = value.trim();
            let marker = match marker.split_once(' ') {Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => token.trim(),_ => marker};
            if let Some(session) = session {
                if session.public(generation)["token"].as_str() != Some(marker) {return Err("Session context changed".into())}
                request = request.bearer_auth(&session.token);
            } else if !marker.is_empty() {
                return Err("Sign in required".into());
            }
        } else {
            request = request.header(key, value);
        }
    }
    Ok(request)
}

#[tauri::command]
pub async fn backend_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    connection_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    let (backend, generation, session) = state.connections.lock().map_err(|_| "Connections unavailable")?.snapshot(&connection_id)?;
    let target = api_target(&backend, &url)?;
    target_is_auth(&backend, &target)?;
    if !["GET", "POST", "PATCH", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err("Unsupported API method".into());
    }
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid API method")?;
    let mut request = request_headers(state.client.request(method, target.clone()), headers, session.as_ref(), generation)?;
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
    state.connections.lock().map_err(|_| "Connections unavailable")?.current(&connection_id, generation)?;
    let body = public_api_body(generation + 1,&backend, &target, status, body, |value| {
        crate::session::store(&app, &connection_id, value, generation)
    })?;
    if status == 401 {
        crate::session::clear_if_current(&app, &connection_id, generation)?;
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
        .public(1);
        Ok(())
    }

    #[test]
    fn expected_revision_reaches_the_backend_and_unapproved_headers_never_dispatch() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let capture = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {break}
                lines.push(line.trim().to_lowercase());
            }
            stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            lines
        });
        let backend = normalize_backend(&format!("http://{address}/")).unwrap();
        let target = api_target(&backend, &format!("http://{address}/api/i7y/alerts/v2/rules/memory")).unwrap();
        let client = client().unwrap();
        for denied in ["X-Api-Key", "Cookie", "Host", "X-Forwarded-Authorization"] {
            assert!(request_headers(client.put(target.clone()), HashMap::from([(denied.into(),"blocked".into())]), None, 0).is_err());
        }
        let session = crate::session::Session {token:"native-only-secret".into(),record:serde_json::json!({"id":"user"})};
        let request = request_headers(client.put(target), HashMap::from([
            ("X-I7y-Expected-Revision".into(),"17".into()),
            ("X-I7y-Organization".into(),"organization-a".into()),
            ("Authorization".into(),"bEaReR native..session-g4".into()),
        ]), Some(&session), 4).unwrap();
        let response = tauri::async_runtime::block_on(async {request.send().await}).unwrap();
        assert_eq!(response.status().as_u16(),204);
        let headers = capture.join().unwrap();
        assert!(headers.iter().any(|line|line == "x-i7y-expected-revision: 17"));
        assert!(headers.iter().any(|line|line == "x-i7y-organization: organization-a"));
        assert!(headers.iter().any(|line|line == "authorization: bearer native-only-secret"));
        assert!(!headers.iter().any(|line|line.contains("blocked") || line.contains("native.expiry.session")));
    }

    #[test]
    fn stale_or_foreign_authorization_never_selects_a_current_native_credential() {
        let client = client().unwrap();
        let target = "https://example.test/api/i7y/alerts/v1/incidents/same/resolve";
        let session = crate::session::Session {token:"header.expiry.same-backend-jwt".into(),record:serde_json::json!({"id":"same-user"})};
        let mut registry = crate::connections::decode(None,Some(&normalize_backend("https://example.test/").unwrap())).unwrap();
        let id = registry.selected.clone().unwrap();
        registry.set_session(&id,0,session.clone()).unwrap();
        let first = session.public(1)["token"].as_str().unwrap().to_owned();
        registry.clear(&id).unwrap();registry.set_session(&id,2,session.clone()).unwrap();
        let (_, generation, active) = registry.snapshot(&id).unwrap();
        assert_eq!(generation,3);
        for marker in [first,"Bearer native.expiry.session-g1".into(),"native.expiry.session-g99".into(),"native.other.session-g3".into(),"header.expiry.same-backend-jwt".into()] {
            assert!(request_headers(client.post(target),HashMap::from([("Authorization".into(),marker)]),active.as_ref(),generation).is_err());
        }
        for prefix in ["", "Bearer ", "bEaReR "] {
            let current = format!("{prefix}{}",session.public(generation)["token"].as_str().unwrap());
            let request = request_headers(client.post(target),HashMap::from([("Authorization".into(),current)]),active.as_ref(),generation).unwrap().build().unwrap();
            assert_eq!(request.headers()["authorization"],"Bearer header.expiry.same-backend-jwt");
        }
        assert!(request_headers(client.post(target),HashMap::from([("Authorization".into(),"native.expiry.session-g3".into())]),None,generation).is_err());
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
                let body = public_api_body(1,&backend, &target, 200, session_response(), |value| {
                    stored = true;
                    isolate_session(value)
                })
                .unwrap();
                assert!(stored);
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["token"], "native.expiry.session-g1");
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
            let visible = public_api_body(1,&backend, &target, 201, body.clone(), |_| {
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
            public_api_body(1,&backend, &target, 200, methods.clone(), |_| panic!(
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
            assert!(public_api_body(1,&backend, &ordinary, 200, body, |_| panic!(
                "Unexpected session must not be stored"
            ))
            .is_err());
        }
        let auth = api_target(
            &backend,
            "https://example.test/api/collections/users/%61uth-refresh",
        )
        .unwrap();
        assert!(public_api_body(1,&backend, &auth, 200, session_response(), |_| Ok(())).is_err());
        assert!(
            public_api_body(1,&backend, &auth, 200, session_response(), |_| Err(
                "Persistence failed".into()
            ))
            .is_err()
        );
        assert!(
            public_api_body(1,&backend, &auth, 400, session_response(), |_| panic!(
                "Failed response must not be stored"
            ))
            .is_err()
        );
        assert!(public_api_body(1,
            &backend,
            &auth,
            200,
            r#"{"token":"secret"}"#.into(),
            isolate_session
        )
        .is_err());
        assert!(public_api_body(1,
            &backend,
            &auth,
            400,
            r#"{"token":"secret"}"#.into(),
            isolate_session
        )
        .is_err());
        assert!(
            public_api_body(1,&backend, &auth, 200, "invalid JSON".into(), isolate_session).is_err()
        );
        let nested = format!(
            r#"{{"token":"header.expiry.private-signature","record":{{"collectionName":"users","nested":{}}}}}"#,
            session_response()
        );
        assert!(public_api_body(1,&backend, &auth, 200, nested, isolate_session).is_err());
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

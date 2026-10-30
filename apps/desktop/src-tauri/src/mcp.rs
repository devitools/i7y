use crate::{
    platform::{LocalAuthorizer, SystemAuthorizer},
    session::Session,
};
use i7y_mcp::{now, Context, Pending};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;

const READ_AUTHORIZATION_SECONDS: u64 = 300;

#[derive(Clone, Serialize)]
pub struct Connection {
    pub id: String,
    pub client: Value,
    pub context: Context,
    pub authorized: bool,
    pub authorization_expires_at: u64,
}
impl Connection {
    fn read_authorized(&self, at: u64) -> bool {
        self.authorized && at < self.authorization_expires_at
    }
    fn grant_read_access(&mut self, at: u64) {
        self.authorized = true;
        self.authorization_expires_at = at.saturating_add(READ_AUTHORIZATION_SECONDS);
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedPlan {
    pub context: Context,
    pub value: Value,
}
enum StatusAccess { Approval(Value), Ready(Option<Pending>) }
#[derive(Default)]
pub struct Inner {
    pub enabled: bool,
    pub generation: u64,
    pub lock_epoch: u64,
    pub session: Option<Session>,
    pub organization: String,
    pub organization_name: String,
    pub authenticating: Option<String>,
    pub connections: HashMap<String, Connection>,
    pub pending: HashMap<String, Pending>,
    pub plans: HashMap<String, SavedPlan>,
}
impl Inner {
    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.connections.clear();
        self.plans.clear();
        for p in self.pending.values_mut() {
            if matches!(p.state.as_str(), "approval_required" | "approved") {
                p.state = "cancelled".into();
            }
        }
    }
    pub fn context(&self, backend: String) -> Result<Context, String> {
        let session = self.session.as_ref().ok_or("Sign in to i7y desktop")?;
        if self.organization.is_empty() {
            return Err("Select an organization in i7y desktop".into());
        }
        Ok(Context {
            backend,
            organization: self.organization.clone(),
            user: session.record["id"].as_str().ok_or("Invalid user")?.into(),
            generation: self.generation,
        })
    }
    pub(crate) fn check_connection(&self, connection: &str, ctx: &Context, require_read: bool, at: u64) -> Result<(), String> {
        if self.context(ctx.backend.clone())? != *ctx {
            return Err("Authorization context changed".into());
        }
        let client = self.connections.get(connection).ok_or("Connection closed or revoked")?;
        if client.context != *ctx {
            return Err("Connection context changed".into());
        }
        if require_read && !client.read_authorized(at) {
            return Err("Read authorization expired; request access again".into());
        }
        Ok(())
    }
    fn begin_dispatch(&mut self, connection: &str, ctx: &Context, id: &str, at: u64) -> Result<(), String> {
        self.check_connection(connection, ctx, false, at)?;
        let pending = self.pending.get_mut(id).ok_or("Request not found")?;
        if pending.expires_at <= at && pending.state == "approved" {
            pending.state = "expired".into();
        }
        if pending.state != "approved" || pending.connection != connection || pending.context != *ctx
            || pending.expires_at <= at
            || pending.binding != i7y_mcp::digest(&json!([pending.context, pending.tool, pending.arguments])) {
            return Err("Approved request expired, changed or cancelled".into());
        }
        pending.state = "executing".into();
        Ok(())
    }
    fn recoverable_pending(&self, connection: &str, ctx: &Context, id: &str) -> Result<Option<Pending>, String> {
        let pending = self.pending.get(id).cloned();
        if let Some(pending) = &pending {
            let same_principal = pending.context.backend == ctx.backend
                && pending.context.organization == ctx.organization && pending.context.user == ctx.user;
            let original = pending.connection == connection && pending.context == *ctx;
            if !same_principal || (!original && (pending.tool == "authorize_connection"
                || matches!(pending.state.as_str(), "approval_required" | "approved"))) {
                return Err("Request not found".into());
            }
        }
        Ok(pending)
    }
    fn request_status_access(&mut self, connection: &str, ctx: &Context, id: &str) -> Result<StatusAccess, String> {
        self.prune();
        self.check_connection(connection, ctx, false, now())?;
        let pending = self.recoverable_pending(connection, ctx, id)?;
        if pending.as_ref().map(|p|p.tool.as_str()) != Some("authorize_connection") {
            if let Some(required) = self.require_read_authorization(connection, ctx)? {
                return Ok(StatusAccess::Approval(required));
            }
        }
        Ok(StatusAccess::Ready(pending))
    }
    fn revoke(&mut self, connection: &str) {
        self.connections.remove(connection);
        for pending in self.pending.values_mut() {
            if pending.connection == connection && matches!(pending.state.as_str(), "approval_required" | "approved") {
                pending.state = "cancelled".into();
            }
        }
    }
    fn finish_request(&mut self, id: &str, result: Result<Value, String>) -> Option<String> {
        let pending = self.pending.get_mut(id)?;
        if matches!(pending.state.as_str(), "denied" | "cancelled" | "expired" | "completed") {
            return Some(pending.state.clone());
        }
        let status = match &result {
            Ok(_) => "completed",
            Err(message) if pending.state == "executing" && !known_rejection(message) => "unknown",
            Err(_) => "failed",
        };
        pending.state = status.into();
        pending.result = Some(match result { Ok(value) => value, Err(error) => json!({"error":error}) });
        Some(status.into())
    }
    fn require_read_authorization(&mut self, connection: &str, ctx: &Context) -> Result<Option<Value>, String> {
        self.prune();
        let client = self.connections.get(connection).ok_or("Connection closed")?;
        if client.context != *ctx {
            return Err("Connection context changed".into());
        }
        if client.read_authorized(now()) {
            return Ok(None);
        }
        if let Some(p) = self.pending.values().find(|p| p.connection == connection && p.tool == "authorize_connection" && p.valid(ctx, now())) {
            return Ok(Some(json!({"state":"approval_required","request_id":p.id})));
        }
        if self.pending.len() >= 1000 {
            return Err("Too many retained requests; reconnect later".into());
        }
        let p = Pending::new(nonce(), connection.into(), ctx.clone(), "authorize_connection".into(), json!({"client":client.client,"duration_seconds":READ_AUTHORIZATION_SECONDS}), None);
        let id = p.id.clone();
        self.pending.insert(id.clone(), p);
        Ok(Some(json!({"state":"approval_required","request_id":id})))
    }
    fn next_approval(&self, ctx: &Context, at: u64) -> Option<String> {
        self.pending.values().filter(|p| p.valid(ctx, at) && self.connections.get(&p.connection).map(|c| c.context == *ctx).unwrap_or(false))
            .min_by_key(|p| (p.expires_at, p.id.clone())).map(|p| p.id.clone())
    }
    fn prune(&mut self) {
        for client in self.connections.values_mut() {
            if !client.read_authorized(now()) {
                client.authorized = false;
            }
        }
        for p in self.pending.values_mut() {
            if p.state == "approval_required" && p.expires_at <= now() {
                p.state = "expired".into();
            }
        }
        if self.pending.len() > 500 {
            self.pending.retain(|_, p| p.expires_at + 3600 > now());
        }
    }
}
#[derive(Clone, Default)]
pub struct Service {
    pub inner: Arc<Mutex<Inner>>,
}
pub fn nonce() -> String {
    rand::random::<[u8; 16]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn context(app: &tauri::AppHandle) -> Result<Context, String> {
    let backend = app
        .state::<crate::backend::Backend>()
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .clone()
        .ok_or("Select a backend")?
        .to_string();
    let service=app.state::<Service>();
    let mut inner=service.inner.lock().map_err(|_|"Session unavailable")?;
    let epoch=crate::platform::lock_epoch();
    if inner.lock_epoch!=epoch {inner.invalidate();inner.lock_epoch=epoch;}
    inner.context(backend)
}
fn current(app: &tauri::AppHandle, expected: &Context) -> Result<(), String> {
    if crate::platform::locked() || context(app)? != *expected {
        Err("Authorization context changed or system locked".into())
    } else {
        Ok(())
    }
}
#[derive(Clone)]
pub(crate) struct RequestGuard {
    pub connection: String,
    pub context: Context,
    pub request_id: Option<String>,
}
impl RequestGuard {
    pub fn check(&self, app: &tauri::AppHandle) -> Result<(), String> {
        current(app, &self.context)?;
        app.state::<Service>().inner.lock().map_err(|_| "MCP unavailable")?
            .check_connection(&self.connection, &self.context, self.request_id.is_none(), now())
    }
    pub fn dispatch(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.check(app)?;
        if let Some(id) = &self.request_id {
            app.state::<Service>().inner.lock().map_err(|_| "MCP unavailable")?
                .begin_dispatch(&self.connection, &self.context, id, now())?;
        }
        Ok(())
    }
}
fn settings_name() -> &'static str {
    if cfg!(debug_assertions) {
        "mcp-enabled-dev"
    } else {
        "mcp-enabled"
    }
}
pub async fn api(
    app: &tauri::AppHandle,
    method: &str,
    path: &str,
    query: Vec<(String, String)>,
    body: Option<Value>,
    request_id: Option<&str>,
    revision: Option<&str>,
    expected: Option<&Context>,
) -> Result<Value, String> {
    let backend = app.state::<crate::backend::Backend>();
    let url = backend
        .url
        .lock()
        .map_err(|_| "Backend unavailable")?
        .clone()
        .ok_or("Select a backend")?;
    let service = app.state::<Service>();
    let (token, org, generation) = {
        let inner = service.inner.lock().map_err(|_| "Session unavailable")?;
        if let Some(expected) = expected {
            if inner.context(url.to_string())? != *expected {
                return Err("Authorization context changed".into());
            }
        }
        (
            inner
                .session
                .as_ref()
                .ok_or("Sign in required")?
                .token
                .clone(),
            inner.organization.clone(),
            inner.generation,
        )
    };
    let mut request = backend
        .client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method")?,
            url.join(path).map_err(|_| "Invalid endpoint")?,
        )
        .bearer_auth(token)
        .header("X-I7y-Organization", org)
        .query(&query);
    if let Some(body) = body {
        request = request.json(&body);
    }
    if let Some(id) = request_id {
        request = request
            .header("Idempotency-Key", id)
            .header("X-I7y-MCP-Request", id);
    }
    if let Some(rev) = revision {
        request = request.header("X-I7y-Expected-Revision", rev);
    }
    let mut response = request.send().await.map_err(|_| {
        "Transport outcome unknown; check request or operation status before retrying"
    })?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Response interrupted; outcome unknown")?
    {
        if bytes.len() + chunk.len() > i7y_mcp::MAX_MESSAGE {
            return Err("Response too large; narrow the query".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if generation
        != service
            .inner
            .lock()
            .map_err(|_| "Session unavailable")?
            .generation
    {
        return Err("Authorization context changed".into());
    }
    if status.as_u16() == 401 {
        crate::session::desktop_session_clear(app.clone())?;
        return Err("Session expired; sign in to i7y desktop".into());
    }
    if !status.is_success() {
        return Err(format!("Backend request rejected ({})", status.as_u16()));
    }
    if status.as_u16() == 204 {
        return Ok(json!({"completed":true}));
    }
    serde_json::from_slice(&bytes).map_err(|_| "Backend returned an unsupported response".into())
}
fn decode_inventory(value: &mut Value) {
    if let Some(map) = value.as_object_mut() {
        if let Some(payload) = map.get("payload") {
            let mut decoded = if let Some(text) = payload.as_str() {
                serde_json::from_str(text).unwrap_or(Value::Null)
            } else {
                payload.clone()
            };
            i7y_mcp::sanitize(&mut decoded);
            *value = decoded;
            return;
        }
        for child in map.values_mut() {
            decode_inventory(child);
        }
    } else if let Some(items) = value.as_array_mut() {
        for child in items {
            decode_inventory(child);
        }
    }
}
async fn audit(app: &tauri::AppHandle, p: &Pending, state: &str) -> Result<(), String> {
    api(
        app,
        "POST",
        "api/i7y/mcp/v1/audit",
        vec![],
        Some(json!({"request_id":p.id,"tool":p.tool,"binding":p.binding,"state":state})),
        None,
        None,
        Some(&p.context),
    )
    .await
    .map(|_| ())
}
async fn execute(
    app: &tauri::AppHandle,
    connection: &str,
    ctx: &Context,
    name: &str,
    args: &Value,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let guard = RequestGuard { connection: connection.into(), context: ctx.clone(), request_id: request_id.map(str::to_owned) };
    guard.check(app)?;
    if name == "search_inventory" {
        let mut out = json!({});
        for resource in ["servers", "projects", "containers"] {
            out[resource] = Box::pin(execute(
                app,
                connection,
                ctx,
                &format!("list_{resource}"),
                args,
                None,
            ))
            .await?;
        }
        guard.check(app)?;
        return Ok(out);
    }
    if [
        "automation_capabilities",
        "inspect_resource",
        "plan_operation",
        "submit_operation",
        "get_operation",
    ]
    .contains(&name)
    {
        let mut result = crate::operational::execute(app, &guard, name, args).await?;
        guard.check(app)?;
        i7y_mcp::sanitize(&mut result);
        return Ok(result);
    }
    let call = i7y_mcp::tools::api_call(name, args)?;
    if matches!(name, "save_alert_rule" | "simulate_alert_rule")
        && args["rule"]["condition"].get("critical_value").is_some()
    {
        let metrics = api(
            app, "GET", "api/i7y/alerts/v1/metrics", vec![], None, None, None, Some(ctx),
        ).await?;
        guard.check(app)?;
        require_severity_escalation(&metrics, args["rule"]["condition"]["metric"].as_str().unwrap_or(""))?;
    }
    if request_id.is_some() { guard.dispatch(app)?; }
    let mut result = api(
        app,
        call.method,
        &call.path,
        call.query,
        call.body,
        request_id,
        call.revision.as_deref(),
        Some(ctx),
    )
    .await?;
    guard.check(app)?;
    decode_inventory(&mut result);
    i7y_mcp::sanitize(&mut result);
    i7y_mcp::observations(&mut result);
    Ok(
        json!({"data":result,"retrieved_at":now(),"stale_after_seconds":900,"observation_policy":"Use last_seen/observed_at for freshness; missing timestamps mean unknown freshness. This is not a live inspection."}),
    )
}
fn require_severity_escalation(metrics: &Value, metric: &str) -> Result<(), String> {
    if metrics["items"].as_array().is_some_and(|items| items.iter().any(|item|
        item["id"] == metric && item["supports_critical_value"] == true
    )) {
        Ok(())
    } else {
        Err("Backend does not support severity escalation for this metric; update the backend before saving or simulating this rule".into())
    }
}
pub async fn call(
    app: &tauri::AppHandle,
    connection: &str,
    name: &str,
    mut args: Value,
) -> Result<Value, String> {
    let write = i7y_mcp::tools::validate(name, &args)?;
    let ctx = context(app)?;
    current(app, &ctx)?;
    let service = app.state::<Service>();
    if name == "request_status" {
        return request_status(
            app,
            connection,
            &ctx,
            args["request_id"].as_str().unwrap_or(""),
        )
        .await;
    }
    {
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        inner.prune();
        let client = inner
            .connections
            .get(connection)
            .ok_or("Reconnect MCP and approve access in i7y desktop")?;
        if client.context != ctx {
            return Err("Connection context changed".into());
        }
        if name == "connection_status" {
            return Ok(
                json!({"connection_id":connection,"context":ctx,"authorized":client.read_authorized(now()),"authorization_expires_at":client.authorization_expires_at,"authorization_duration_seconds":READ_AUTHORIZATION_SECONDS,"pending":inner.pending.values().filter(|p|p.connection==connection&&p.state=="approval_required").collect::<Vec<_>>().iter().map(|p|json!({"request_id":p.id,"state":p.state,"expires_at":p.expires_at})).collect::<Vec<_>>()}),
            );
        }
        if let Some(required) = inner.require_read_authorization(connection, &ctx)? {
            return Ok(required);
        }
        if write {
            if inner.pending.len() >= 1000 {
                return Err("Too many retained requests; reconnect later".into());
            }
            let mut expiry = None;
            if name == "submit_operation" {
                let plan = inner
                    .plans
                    .get(args["operation_id"].as_str().unwrap_or(""))
                    .ok_or("Plan not found; prepare a plan first")?;
                if plan.context != ctx {
                    return Err("Plan context changed".into());
                }
                expiry = plan.value["plan"]["expires_at"].as_u64();
                args["__reviewed_plan"] = plan.value.clone();
            }
            let p = Pending::new(nonce(), connection.into(), ctx, name.into(), args, expiry);
            let id = p.id.clone();
            inner.pending.insert(id.clone(), p);
            return Ok(json!({"state":"approval_required","request_id":id}));
        }
    }
    execute(app, connection, &ctx, name, &args, None).await
}
async fn request_status(
    app: &tauri::AppHandle,
    connection: &str,
    ctx: &Context,
    id: &str,
) -> Result<Value, String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid request identity".into());
    }
    let pending = {
        let service = app.state::<Service>();
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        match inner.request_status_access(connection, ctx, id)? {
            StatusAccess::Approval(required) => return Ok(required),
            StatusAccess::Ready(pending) => pending,
        }
    };
    let guard = RequestGuard { connection: connection.into(), context: ctx.clone(), request_id: None };
    if let Some(p) = &pending {
        let original = p.connection == connection && p.context == *ctx;
        if p.tool == "authorize_connection" {
            return Ok(json!({"request_id":id,"state":p.state,"result":p.result,"expires_at":p.expires_at}));
        }
        guard.check(app)?;
        if p.tool == "submit_operation" || matches!(p.state.as_str(), "approval_required" | "approved" | "denied" | "cancelled" | "expired" | "failed")
            || (original && p.state != "unknown") {
            return Ok(json!({"request_id":id,"state":p.state,"result":if original { p.result.clone() } else { None },"operation_id":p.arguments.get("operation_id"),"expires_at":p.expires_at}));
        }
    }
    let mut recovered = api(
        app,
        "GET",
        &format!("api/i7y/mcp/v1/requests/{id}"),
        vec![],
        None,
        None,
        None,
        Some(ctx),
    )
    .await?;
    guard.check(app)?;
    i7y_mcp::sanitize(&mut recovered);
    let receipt_completed = recovered["state"] == "completed";
    if !receipt_completed {
        if let Some(p) = &pending {
            recovered["state"] = json!(p.state);
        }
    }
    if receipt_completed {
        let service = app.state::<Service>();
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        if let Some(p) = inner.pending.get_mut(id) {
            if p.context.backend == ctx.backend && p.context.organization == ctx.organization && p.context.user == ctx.user {
                p.state = "completed".into();
                p.result = Some(recovered["result"].clone());
            }
        }
    }
    Ok(recovered)
}
pub fn next_approval(app: &tauri::AppHandle) -> Option<String> {
    if crate::platform::locked() { return None; }
    let ctx = context(app).ok()?;
    let service = app.state::<Service>();
    let mut inner = service.inner.lock().ok()?;
    inner.prune();
    inner.next_approval(&ctx, now())
}

pub fn approval_view(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    let ctx = context(app)?;
    current(app, &ctx)?;
    let service = app.state::<Service>();
    let inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
    let Some(p) = inner.pending.get(id).filter(|p| p.valid(&ctx, now())) else { return Ok(json!(null)) };
    let Some(client) = inner.connections.get(&p.connection) else { return Ok(json!(null)) };
    let mut result = json!({"request":p,"client":client.client,"organization_name":inner.organization_name,"authorization_provider":if cfg!(target_os="macos"){ "macos_local_authentication" }else{"unavailable"},"user":inner.session.as_ref().map(|s| json!({"name":s.record["name"],"email":s.record["email"]}))});
    i7y_mcp::sanitize(&mut result);
    Ok(result)
}

#[tauri::command]
pub fn mcp_overview(app: tauri::AppHandle) -> Result<Value, String> {
    let selected = context(&app).ok();
    let service = app.state::<Service>();
    let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
    inner.prune();
    let executable = std::env::current_exe()
        .map_err(|_| "Connector path unavailable")?
        .with_file_name(if cfg!(windows) {
            "i7y-mcp.exe"
        } else {
            "i7y-mcp"
        });
    let visible = |ctx: &Context| {
        selected
            .as_ref()
            .map(|selected| {
                ctx.user == selected.user
                    && ctx.organization == selected.organization
                    && ctx.backend == selected.backend
            })
            .unwrap_or(false)
    };
    Ok(
        json!({"enabled":inner.enabled,"organization_name":inner.organization_name,"user_label":inner.session.as_ref().and_then(|s|s.record["email"].as_str().or_else(||s.record["name"].as_str())),"context":selected,"platform_supported":cfg!(target_os="macos"),"connections":inner.connections.values().filter(|c|visible(&c.context)).collect::<Vec<_>>(),"requests":inner.pending.values().filter(|p|visible(&p.context)).collect::<Vec<_>>(),"config":format!("[mcp_servers.i7y]\ncommand = {}\n",serde_json::to_string(&executable.to_string_lossy()).unwrap()),"authorization_provider":if cfg!(target_os="macos"){ "macos_local_authentication" }else if cfg!(windows){"windows_hello_unavailable"}else{"unavailable"}}),
    )
}
#[tauri::command]
pub fn mcp_enable(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && !cfg!(target_os = "macos") {
        return Err("Desktop MCP is not available on this platform yet".into());
    }
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Settings unavailable")?;
    std::fs::create_dir_all(&path).map_err(|_| "Settings unavailable")?;
    std::fs::write(
        path.join(settings_name()),
        if enabled { "yes" } else { "no" },
    )
    .map_err(|_| "Unable to save MCP settings")?;
    let service = app.state::<Service>();
    let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
    inner.enabled = enabled;
    inner.invalidate();
    Ok(())
}
#[tauri::command]
pub fn mcp_revoke(app: tauri::AppHandle, connection_id: String) -> Result<(), String> {
    let service = app.state::<Service>();
    let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
    inner.revoke(&connection_id);
    Ok(())
}
#[tauri::command]
pub async fn mcp_decide(
    app: tauri::AppHandle,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    let ctx = context(&app)?;
    let service = app.state::<Service>();
    let pending = {
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        let p = inner
            .pending
            .get_mut(&request_id)
            .ok_or("Request not found")?;
        if !p.valid(&ctx, now()) {
            return Err("Request expired or context changed".into());
        }
        if !approve {
            p.state = "denied".into();
        }
        p.clone()
    };
    if !approve {
        crate::platform::cancel_authentication(&request_id);
        audit(&app, &pending, "denied").await?;
        return Ok(());
    }
    let summary = if pending.tool == "authorize_connection" {
        let organization = service.inner.lock().map_err(|_| "MCP unavailable")?.organization_name.clone();
        let host = url::Url::parse(&ctx.backend).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_else(||ctx.backend.clone());
        format!("access the {} inventory at {} for 5 minutes", if organization.is_empty() { ctx.organization.as_str() } else { organization.as_str() }, host)
    } else {
        format!(
            "Authorize {} for organization {}",
            pending.tool, ctx.organization
        )
    };
    {
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        if !inner.pending.get(&request_id).map(|p|p.valid(&ctx, now())).unwrap_or(false) { return Err("Request expired or context changed".into()); }
        if inner.authenticating.is_some() { return Err("System authentication is already in progress".into()); }
        inner.authenticating = Some(request_id.clone());
    }
    let id = request_id.clone();
    let authentication = tauri::async_runtime::spawn_blocking(move || SystemAuthorizer.authorize(&id, &summary)).await;
    {
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        if inner.authenticating.as_deref() == Some(&request_id) { inner.authenticating = None; }
    }
    authentication.map_err(|_| "Local authentication failed")?.map_err(|e| format!("Local authentication: {e:?}"))?;
    current(&app, &ctx)?;
    {
        let mut inner = service.inner.lock().map_err(|_| "MCP unavailable")?;
        let p = inner
            .pending
            .get_mut(&request_id)
            .ok_or("Request not found")?;
        if !p.valid(&ctx, now()) {
            return Err("Request changed during authentication".into());
        }
        p.state = "approved".into();
    }
    let job_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            audit(&job_app, &pending, "approved").await?;
            if pending.tool == "authorize_connection" {
                let guard = RequestGuard { connection: pending.connection.clone(), context: ctx.clone(), request_id: Some(pending.id.clone()) };
                guard.dispatch(&job_app)?;
                let state = job_app.state::<Service>();
                let mut inner = state.inner.lock().map_err(|_| "MCP unavailable")?;
                inner.check_connection(&pending.connection, &ctx, false, now())?;
                inner
                    .connections
                    .get_mut(&pending.connection)
                    .ok_or("Connection closed")?
                    .grant_read_access(now());
                return Ok(json!({"authorized":true,"authorization_duration_seconds":READ_AUTHORIZATION_SECONDS}));
            }
            execute(
                &job_app,
                &pending.connection,
                &ctx,
                &pending.tool,
                &pending.arguments,
                Some(&pending.id),
            )
            .await
        }
        .await;
        let state = job_app.state::<Service>();
        let status = {
            let Ok(mut inner) = state.inner.lock() else { return };
            let Some(status) = inner.finish_request(&pending.id, result) else { return };
            status
        };
        let audit_status = if matches!(status.as_str(), "cancelled" | "expired") { "denied" } else { &status };
        let _ = audit(&job_app, &pending, audit_status).await;
    });
    Ok(())
}
fn known_rejection(message: &str) -> bool {
    if message == "Controller rejected the request" { return true; }
    message.strip_prefix("Backend request rejected (").and_then(|v|v.strip_suffix(')'))
        .and_then(|v|v.parse::<u16>().ok()).map(|status|(400..500).contains(&status)).unwrap_or(false)
}
#[tauri::command]
pub async fn desktop_tool_call(
    app: tauri::AppHandle,
    name: String,
    arguments: Value,
) -> Result<Value, String> {
    let ctx = context(&app)?;
    {
        let state = app.state::<Service>();
        let mut inner = state.inner.lock().map_err(|_| "MCP unavailable")?;
        inner.connections.insert(
            "desktop-ui".into(),
            Connection {
                id: "desktop-ui".into(),
                client: json!({"name":"i7y desktop"}),
                context: ctx,
                authorized: true,
                authorization_expires_at: now().saturating_add(READ_AUTHORIZATION_SECONDS),
            },
        );
    }
    call(&app, "desktop-ui", &name, arguments).await
}
pub fn start(app: tauri::AppHandle) {
    #[cfg(unix)]
    std::thread::spawn(move || {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            os::unix::{fs::PermissionsExt, net::UnixListener},
        };
        let path = i7y_mcp::socket_path();
        let Some(directory) = path.parent() else {
            return;
        };
        if std::fs::create_dir_all(directory).is_err() {
            return;
        }
        let metadata = match std::fs::symlink_metadata(directory) {
            Ok(m) => m,
            Err(_) => return,
        };
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            return;
        }
        if std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).is_err() {
            return;
        }
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                return;
            }
            if std::fs::remove_file(&path).is_err() {
                return;
            }
        }
        let listener = match UnixListener::bind(&path) {
            Ok(s) => s,
            Err(_) => return,
        };
        if std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_err() {
            return;
        }
        let state = app.state::<Service>();
        if let Ok(config) = app.path().app_config_dir() {
            if std::fs::read_to_string(config.join(settings_name()))
                .ok()
                .as_deref()
                == Some("yes")
                && cfg!(target_os = "macos")
            {
                state.inner.lock().unwrap().enabled = true;
            }
        }
        let monitor = app.clone();
        std::thread::spawn(move || loop {
            if crate::platform::locked() {
                let state = monitor.state::<Service>();
                if let Ok(mut inner) = state.inner.lock() {
                    if !inner.connections.is_empty() {
                        inner.invalidate();
                    }
                };
            }
            crate::approvals::synchronize(&monitor);
            std::thread::sleep(std::time::Duration::from_millis(500));
        });
        let workers = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            if workers.load(std::sync::atomic::Ordering::SeqCst) >= 16 {
                continue;
            }
            let enabled = app
                .state::<Service>()
                .inner
                .lock()
                .map(|s| s.enabled)
                .unwrap_or(false);
            if !enabled {
                continue;
            }
            let Ok(pid) = i7y_mcp::peer(&stream) else {
                continue;
            };
            if crate::platform::verify_peer(pid).is_err() {
                continue;
            }
            let app = app.clone();
            let workers = workers.clone();
            workers.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::spawn(move || {
                let connection = nonce();
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
                let Ok(clone) = stream.try_clone() else {
                    workers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    return;
                };
                let mut reader = BufReader::new(clone);
                loop {
                    let state = app.state::<Service>();
                    if !state.inner.lock().map(|s| s.enabled).unwrap_or(false) {
                        break;
                    }
                    let mut line = String::new();
                    let read = reader
                        .by_ref()
                        .take((i7y_mcp::MAX_MESSAGE + 1) as u64)
                        .read_line(&mut line);
                    match read {
                        Ok(0) => break,
                        Err(e)
                            if (e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut)
                                && line.is_empty() =>
                        {
                            continue
                        }
                        Err(_) => break,
                        _ => {}
                    }
                    if line.len() > i7y_mcp::MAX_MESSAGE || !line.ends_with('\n') {
                        break;
                    }
                    let response = (|| -> Result<Value, String> {
                        let msg: Value =
                            serde_json::from_str(&line).map_err(|_| "Invalid local request")?;
                        if msg["method"] == "connect" {
                            let ctx = context(&app)?;
                            current(&app, &ctx)?;
                            let client = &msg["client"];
                            if client.to_string().len() > 512 {
                                return Err("Client metadata too large".into());
                            }
                            let mut inner = state.inner.lock().map_err(|_| "MCP unavailable")?;
                            if inner.connections.contains_key(&connection) {
                                return Err("Connection already initialized".into());
                            }
                            if inner.pending.len() >= 1000 {
                                return Err("Too many pending requests".into());
                            }
                            inner.connections.insert(
                                connection.clone(),
                                Connection {
                                    id: connection.clone(),
                                    client: client.clone(),
                                    context: ctx.clone(),
                                    authorized: false,
                                    authorization_expires_at: 0,
                                },
                            );
                            let pending = Pending::new(
                                nonce(),
                                connection.clone(),
                                ctx,
                                "authorize_connection".into(),
                                json!({"client":client,"duration_seconds":READ_AUTHORIZATION_SECONDS}),
                                None,
                            );
                            let id = pending.id.clone();
                            inner.pending.insert(id.clone(), pending);
                            Ok(json!({"state":"approval_required","request_id":id}))
                        } else if msg["method"] == "call" {
                            tauri::async_runtime::block_on(call(
                                &app,
                                &connection,
                                msg["name"].as_str().unwrap_or(""),
                                msg["arguments"].clone(),
                            ))
                        } else {
                            Err("Unsupported local request".into())
                        }
                    })()
                    .unwrap_or_else(|error| json!({"error":error}));
                    let response = {
                        let valid = context(&app).and_then(|ctx| {
                            current(&app, &ctx)?;
                            app.state::<Service>().inner.lock().map_err(|_| "MCP unavailable")?
                                .check_connection(&connection, &ctx, false, now())
                        });
                        match valid { Ok(()) => response, Err(error) => json!({"error":error}) }
                    };
                    let encoded = response.to_string();
                    let encoded = if encoded.len() > i7y_mcp::MAX_MESSAGE {
                        json!({"error":"Response too large; narrow the query"}).to_string()
                    } else {
                        encoded
                    };
                    if writeln!(stream, "{encoded}").is_err() {
                        break;
                    }
                }
                let _ = mcp_revoke(app, connection);
                workers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn severity_escalation_requires_explicit_capability_for_the_requested_metric() {
        for metric in ["host.disk_percent", "host.cpu_percent", "host.memory_percent"] {
            for metrics in [json!(null), json!({}), json!({"items":[]}),
                json!({"items":[{"id":metric}]}),
                json!({"items":[{"id":metric,"supports_critical_value":false}]}),
                json!({"items":[{"id":metric,"supports_critical_value":"true"}]}),
                json!({"items":[{"id":"container.memory_percent","supports_critical_value":true}]})]
            {
                assert!(require_severity_escalation(&metrics, metric).is_err());
            }
            assert!(require_severity_escalation(&json!({"items":[
                {"id":metric,"supports_critical_value":true}
            ]}), metric).is_ok());
        }
        assert!(require_severity_escalation(&json!({"items":[
            {"id":"host.disk_percent","supports_critical_value":true}
        ]}), "host.cpu_percent").is_err());
        assert!(require_severity_escalation(&json!({"items":[
            {"id":"host.cpu_percent","supports_critical_value":true}
        ]}), "host.disk_percent").is_err());
        assert!(require_severity_escalation(&json!({"items":[
            {"id":"host.cpu_percent","supports_critical_value":true},
            {"id":"host.disk_percent","supports_critical_value":true}
        ]}), "host.memory_percent").is_err());
    }
    fn prepared() -> (Inner, Context) {
        let mut inner = Inner::default();
        inner.session = Some(Session {
            token: "private-session-token".into(),
            record: json!({"id":"user","collectionName":"users"}),
        });
        inner.organization = "org".into();
        let ctx = inner.context("https://example.test/".into()).unwrap();
        (inner, ctx)
    }
    fn connect(inner: &mut Inner, id: &str, ctx: &Context, authorized: bool) {
        inner.connections.insert(id.into(), Connection { id: id.into(), client: json!({}), context: ctx.clone(), authorized, authorization_expires_at: if authorized { now()+300 } else { 0 } });
    }
    fn retained(inner: &mut Inner, ctx: &Context, state: &str) {
        let mut pending = Pending::new("saved".into(), "original".into(), ctx.clone(), "create_incident".into(), json!({"title":"fixture","severity":"info"}), None);
        pending.state = state.into();
        inner.pending.insert("saved".into(), pending);
    }
    #[test]
    fn reconnect_requires_fresh_consent_but_recovers_retained_outcomes() {
        for status in ["executing", "unknown", "completed"] {
            let (mut inner, ctx) = prepared();
            retained(&mut inner, &ctx, status);
            connect(&mut inner, "new", &ctx, false);
            assert!(matches!(inner.request_status_access("new", &ctx, "saved").unwrap(), StatusAccess::Approval(_)));
            inner.connections.get_mut("new").unwrap().grant_read_access(now());
            let StatusAccess::Ready(Some(result)) = inner.request_status_access("new", &ctx, "saved").unwrap() else { panic!("retained request unavailable") };
            assert_eq!(result.state, status);
            assert_eq!(result.connection, "original");
        }
    }
    #[test]
    fn recovery_after_context_renewal_never_transfers_pending_consent_or_other_principals() {
        let (mut inner, ctx) = prepared();
        retained(&mut inner, &ctx, "unknown");
        inner.invalidate();
        let renewed = inner.context(ctx.backend.clone()).unwrap();
        connect(&mut inner, "new", &renewed, true);
        assert!(matches!(inner.request_status_access("new", &renewed, "saved").unwrap(), StatusAccess::Ready(Some(_))));
        for field in ["user", "backend", "organization"] {
            let mut other = ctx.clone();
            match field { "user" => other.user = "different".into(), "backend" => other.backend = "https://other.test/".into(), _ => other.organization = "different".into() }
            inner.pending.get_mut("saved").unwrap().context = other;
            assert!(inner.request_status_access("new", &renewed, "saved").is_err());
        }
        for state in ["approval_required", "approved"] {
            retained(&mut inner, &ctx, state);
            assert!(inner.request_status_access("new", &renewed, "saved").is_err());
        }
        retained(&mut inner, &ctx, "completed");
        inner.pending.get_mut("saved").unwrap().tool = "authorize_connection".into();
        assert!(inner.request_status_access("new", &renewed, "saved").is_err());
    }
    #[test]
    fn revoke_while_approved_audit_waits_prevents_dispatch() {
        use std::sync::{Arc,Mutex,mpsc};
        let (mut inner, ctx) = prepared();
        connect(&mut inner, "original", &ctx, true);
        retained(&mut inner, &ctx, "approved");
        let inner = Arc::new(Mutex::new(inner));
        let (release, waiting) = mpsc::channel();
        let worker = inner.clone();
        let task = std::thread::spawn(move || {
            waiting.recv().unwrap();
            worker.lock().unwrap().begin_dispatch("original", &ctx, "saved", now()).is_ok()
        });
        inner.lock().unwrap().revoke("original");
        release.send(()).unwrap();
        assert!(!task.join().unwrap());
        let mut inner = inner.lock().unwrap();
        assert_eq!(inner.finish_request("saved", Err("Connection closed".into())).unwrap(), "cancelled");
        assert!(inner.pending["saved"].result.is_none());
    }
    #[test]
    fn dispatch_rejects_drift_expiry_and_replay_and_keeps_accepted_jobs_recoverable() {
        let (mut inner, ctx) = prepared();
        connect(&mut inner, "original", &ctx, true);
        retained(&mut inner, &ctx, "approved");
        inner.pending.get_mut("saved").unwrap().arguments["title"] = json!("changed");
        assert!(inner.begin_dispatch("original", &ctx, "saved", now()).is_err());
        retained(&mut inner, &ctx, "approved");
        let expires = inner.pending["saved"].expires_at;
        assert!(inner.begin_dispatch("original", &ctx, "saved", expires).is_err());
        assert_eq!(inner.pending["saved"].state, "expired");
        retained(&mut inner, &ctx, "approved");
        inner.begin_dispatch("original", &ctx, "saved", now()).unwrap();
        assert!(inner.begin_dispatch("original", &ctx, "saved", now()).is_err());
        inner.revoke("original");
        assert_eq!(inner.pending["saved"].state, "executing");
        assert_eq!(inner.finish_request("saved", Err("Response interrupted".into())).unwrap(), "unknown");
        inner.pending.get_mut("saved").unwrap().state = "completed".into();
        inner.pending.get_mut("saved").unwrap().result = Some(json!({"receipt":"durable"}));
        assert_eq!(inner.finish_request("saved", Err("late transport failure".into())).unwrap(), "completed");
        assert_eq!(inner.pending["saved"].result.as_ref().unwrap()["receipt"], "durable");
    }
    #[test]
    fn explicit_rejection_is_failed_while_unconfirmed_dispatched_results_are_unknown() {
        let (mut inner, ctx) = prepared();
        for (error, expected) in [("Backend request rejected (409)", "failed"), ("Controller rejected the request", "failed"), ("Backend request rejected (500)", "unknown"), ("Controller response outcome unknown", "unknown")] {
            retained(&mut inner, &ctx, "executing");
            assert_eq!(inner.finish_request("saved", Err(error.into())).unwrap(), expected);
        }
        retained(&mut inner, &ctx, "approved");
        assert_eq!(inner.finish_request("saved", Err("Audit transport outcome unknown".into())).unwrap(), "failed");
    }
    #[test]
    fn delayed_result_is_not_released_after_context_or_connection_invalidation() {
        let (mut inner, ctx) = prepared();
        connect(&mut inner, "original", &ctx, true);
        assert!(inner.check_connection("original", &ctx, true, now()).is_ok());
        let deadline = inner.connections["original"].authorization_expires_at;
        assert!(inner.check_connection("original", &ctx, true, deadline).is_err());
        inner.revoke("original");
        assert!(inner.check_connection("original", &ctx, false, now()).is_err());
        connect(&mut inner, "original", &ctx, true);
        retained(&mut inner, &ctx, "approved");
        inner.invalidate();
        assert!(inner.check_connection("original", &ctx, false, now()).is_err());
        assert_eq!(inner.pending["saved"].state, "cancelled");
    }
    #[test]
    fn popup_queue_excludes_stale_disconnected_and_modified_requests() {
        let (mut inner, ctx) = prepared();
        inner.connections.insert("client".into(), Connection {
            id: "client".into(), client: json!({}), context: ctx.clone(),
            authorized: false, authorization_expires_at: 0,
        });
        let request = Pending::new("a".into(), "client".into(), ctx.clone(), "authorize_connection".into(), json!({"duration_seconds":300}), None);
        inner.pending.insert("a".into(), request.clone());
        assert_eq!(inner.next_approval(&ctx, now()), Some("a".into()));
        inner.pending.get_mut("a").unwrap().arguments["duration_seconds"] = json!(999);
        assert!(inner.next_approval(&ctx, now()).is_none());
        inner.pending.insert("a".into(), request.clone());
        assert!(inner.next_approval(&ctx, request.expires_at).is_none());
        inner.pending.get_mut("a").unwrap().state = "cancelled".into();
        assert!(inner.next_approval(&ctx, now()).is_none());
        inner.pending.insert("a".into(), request);
        let mut other = ctx.clone(); other.organization = "other".into();
        assert!(inner.next_approval(&other, now()).is_none());
        inner.connections.clear();
        assert!(inner.next_approval(&ctx, now()).is_none());
    }
    #[test]
    fn read_grant_expires_after_five_minutes_without_sliding() {
        let (_, ctx) = prepared();
        let mut client = Connection {
            id: "client".into(), client: json!({}), context: ctx,
            authorized: false, authorization_expires_at: 0,
        };
        client.grant_read_access(1000);
        assert!(client.read_authorized(1000));
        assert!(client.read_authorized(1299));
        assert!(!client.read_authorized(1300));
        assert_eq!(client.authorization_expires_at, 1300);
        client.grant_read_access(1400);
        assert_eq!(client.authorization_expires_at, 1700);
        client.authorized = false;
        assert!(!client.read_authorized(1401));
    }
    #[test]
    fn expired_connection_requires_one_new_context_bound_approval() {
        let (mut inner, ctx) = prepared();
        inner.connections.insert("client".into(), Connection {
            id: "client".into(), client: json!({"name":"declared"}), context: ctx.clone(),
            authorized: true, authorization_expires_at: now(),
        });
        let required = inner.require_read_authorization("client", &ctx).unwrap().unwrap();
        assert!(!inner.connections["client"].authorized);
        assert_eq!(required["state"], "approval_required");
        assert_eq!(inner.require_read_authorization("client", &ctx).unwrap(), Some(required.clone()));
        assert_eq!(inner.pending.len(), 1);
        let id = required["request_id"].as_str().unwrap();
        assert_eq!(inner.pending[id].arguments["duration_seconds"], 300);
        let mut other = ctx.clone(); other.organization = "other".into();
        assert!(inner.require_read_authorization("client", &other).is_err());
        inner.pending.get_mut(id).unwrap().state = "completed".into();
        inner.connections.get_mut("client").unwrap().grant_read_access(now());
        assert!(inner.require_read_authorization("client", &ctx).unwrap().is_none());
        inner.invalidate();
        assert!(inner.require_read_authorization("client", &ctx).is_err());
    }
    #[test]
    fn disabled_by_default_and_context_requires_identity() {
        let inner = Inner::default();
        assert!(!inner.enabled);
        assert!(inner.context("https://example.test/".into()).is_err());
        let (mut inner, _) = prepared();
        inner.organization.clear();
        assert!(inner.context("https://example.test/".into()).is_err());
    }
    #[test]
    fn invalidation_revokes_connections_and_cancels_pending_writes() {
        let (mut inner, ctx) = prepared();
        inner.connections.insert(
            "client".into(),
            Connection {
                id: "client".into(),
                client: json!({"name":"self-reported"}),
                context: ctx.clone(),
                authorized: true,
                authorization_expires_at: now().saturating_add(300),
            },
        );
        inner.pending.insert(
            "request".into(),
            Pending::new(
                "request".into(),
                "client".into(),
                ctx.clone(),
                "resolve_incident".into(),
                json!({"version":1}),
                None,
            ),
        );
        inner.invalidate();
        assert!(inner.connections.is_empty());
        assert_eq!(inner.pending["request"].state, "cancelled");
        assert!(!inner.pending["request"].valid(&ctx, now()));
        assert_ne!(inner.context(ctx.backend.clone()).unwrap(), ctx);
    }
    #[test]
    fn executed_requests_are_not_made_pending_again_by_reconnect() {
        let (mut inner, ctx) = prepared();
        let mut pending = Pending::new(
            "request".into(),
            "client".into(),
            ctx,
            "save_alert_rule".into(),
            json!({}),
            None,
        );
        pending.state = "executing".into();
        inner.pending.insert("request".into(), pending);
        inner.invalidate();
        assert_eq!(inner.pending["request"].state, "executing");
    }
    #[test]
    fn inventory_decodes_payload_before_redacting_secrets() {
        let mut response = json!({"items":[{"id":"example","payload":"{\"name\":\"safe\",\"server\":{\"credential\":{\"password\":\"hidden\"}}}"}]});
        decode_inventory(&mut response);
        assert_eq!(response["items"][0]["name"], "safe");
        assert!(!response.to_string().contains("hidden"));
    }
}

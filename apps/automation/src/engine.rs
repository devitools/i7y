use crate::store::{self, Plan, Result, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_RESPONSE_BYTES: usize = 65536;

fn response_fits(value: &Value) -> bool {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len() < MAX_RESPONSE_BYTES)
        .unwrap_or(false)
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .map(|object| {
            object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
        })
        .unwrap_or(false)
}

fn valid_inspection(action: &str, value: &Value) -> bool {
    match action {
        "server.inspect" => {
            exact_keys(value, &["kernel", "uptime_seconds"])
                && value["kernel"]
                    .as_str()
                    .map(|s| s.len() <= 1024)
                    .unwrap_or(false)
                && value["uptime_seconds"].is_number()
        }
        "server.disk" => {
            exact_keys(value, &["disks"])
                && value["disks"]
                    .as_array()
                    .map(|rows| {
                        rows.len() <= 256
                            && rows
                                .iter()
                                .all(|row| row.as_str().map(|s| s.len() <= 2048).unwrap_or(false))
                    })
                    .unwrap_or(false)
        }
        "container.list" => {
            exact_keys(value, &["containers"])
                && value["containers"]
                    .as_array()
                    .map(|rows| {
                        rows.len() <= 1000
                            && rows.iter().all(|row| {
                                exact_keys(
                                    row,
                                    &["ID", "Names", "Image", "State", "Status", "Ports"],
                                ) && row
                                    .as_object()
                                    .unwrap()
                                    .values()
                                    .all(|v| v.as_str().map(|s| s.len() <= 2048).unwrap_or(false))
                            })
                    })
                    .unwrap_or(false)
        }
        _ => false,
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    ServerPing,
    ServerInspect,
    ServerDisk,
    ContainerList,
    ProjectCopy,
    ContainerStart,
    ContainerStop,
    ContainerRestart,
}
impl OperationKind {
    pub fn id(&self) -> &'static str {
        match self {
            Self::ServerPing => "server.ping",
            Self::ServerInspect => "server.inspect",
            Self::ServerDisk => "server.disk",
            Self::ContainerList => "container.list",
            Self::ProjectCopy => "project.copy",
            Self::ContainerStart => "container.start",
            Self::ContainerStop => "container.stop",
            Self::ContainerRestart => "container.restart",
        }
    }
    fn recipe(&self) -> &'static str {
        match self {
            Self::ServerPing => "server-ping.yml",
            Self::ServerInspect => "server-inspect.yml",
            Self::ServerDisk => "server-disk.yml",
            Self::ContainerList => "container-list.yml",
            Self::ProjectCopy => "copy-project.yml",
            Self::ContainerStart => "container-start.yml",
            Self::ContainerStop => "container-stop.yml",
            Self::ContainerRestart => "container-restart.yml",
        }
    }
    fn target_kind(&self) -> &'static str {
        match self {
            Self::ProjectCopy => "project",
            Self::ContainerStart | Self::ContainerStop | Self::ContainerRestart => "container",
            _ => "server",
        }
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub action: OperationKind,
    pub target: String,
    pub destination_domain: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Capabilities,
    Ping {
        target: String,
    },
    Plan {
        operation_id: String,
        operation: Operation,
    },
    Submit {
        operation_id: String,
        approval: String,
    },
    SubmitAuthorized {
        operation_id: String,
        approval: String,
        authorization: String,
    },
    Status {
        operation_id: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u8,
    pub backend: String,
    pub organization: String,
    pub request: Request,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    active_release: String,
    ansible_playbook: PathBuf,
    execution_enabled: bool,
    #[serde(default)]
    central_authorization_key_file: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    backend: String,
    organization: String,
    actions: Vec<String>,
    targets: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Target {
    host: String,
    kind: String,
    backend: String,
    organization: String,
    source_path: Option<String>,
    source_domain: Option<String>,
    container_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Parameters {
    operation: Operation,
    target: Target,
    preflight: Option<ContainerPreflight>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ContainerObservation {
    id: String,
    name: String,
    image: String,
    state: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ContainerPreflight {
    observed_at: u64,
    container: ContainerObservation,
}
struct RecipeOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub struct Engine {
    root: PathBuf,
    principal: String,
    config: Config,
    policy: Policy,
    pub store: Store,
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Controller configuration unavailable")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err("Invalid controller configuration".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Controller configuration unavailable")?)
        .map_err(|_| "Invalid controller configuration".into())
}
fn domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|v| {
            !v.is_empty()
                && v.len() <= 63
                && !v.starts_with('-')
                && !v.ends_with('-')
                && v.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn source_path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() > 1
        && value.len() <= 4096
        && !value.contains(['\0', '\r', '\n'])
        && value.split('/').all(|v| v != ".." && v != ".")
}
fn release_digest(root: &Path) -> Result<String> {
    fn walk(root: &Path, path: &Path, entries: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(path).map_err(|_| "Release unavailable")? {
            let path = entry.map_err(|_| "Release unavailable")?.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| "Release unavailable")?;
            if meta.file_type().is_symlink() {
                return Err("Release cannot contain symbolic links".into());
            }
            if meta.is_dir() {
                walk(root, &path, entries)?;
            } else if meta.is_file() {
                entries.push(
                    path.strip_prefix(root)
                        .map_err(|_| "Invalid release path")?
                        .into(),
                );
            } else {
                return Err("Invalid release entry".into());
            }
            if entries.len() > 1024 {
                return Err("Release is too large".into());
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(root, root, &mut entries)?;
    entries.sort();
    let mut bytes = Vec::new();
    for path in entries {
        let data = fs::read(root.join(&path)).map_err(|_| "Release unavailable")?;
        if bytes.len() + data.len() > 16 * 1024 * 1024 {
            return Err("Release is too large".into());
        }
        let name = path.to_str().ok_or("Invalid release path")?.as_bytes();
        bytes.extend_from_slice(&(name.len() as u64).to_be_bytes());
        bytes.extend_from_slice(name);
        bytes.extend_from_slice(&(data.len() as u64).to_be_bytes());
        bytes.extend(data);
    }
    Ok(store::digest(&bytes))
}
impl Engine {
    pub fn open(root: PathBuf, principal: String) -> Result<Self> {
        if !store::valid_id(&principal) {
            return Err("Invalid operator identity".into());
        }
        let config: Config = read(&root.join("config.json"))?;
        if !store::valid_id(&config.active_release) || !config.ansible_playbook.is_absolute() {
            return Err("Invalid controller configuration".into());
        }
        let policy: Policy = read(&root.join("operators").join(format!("{principal}.json")))?;
        if policy.backend.is_empty()
            || policy.backend.len() > 2048
            || !store::valid_id(&policy.organization)
            || policy.targets.iter().any(|t| !store::valid_id(t))
        {
            return Err("Invalid operator policy".into());
        }
        let store = Store::open(root.join("operations"))?;
        Ok(Self {
            root,
            principal,
            config,
            policy,
            store,
        })
    }
    fn release(&self, id: &str) -> Result<PathBuf> {
        if !store::valid_id(id) {
            return Err("Invalid release ID".into());
        }
        Ok(self.root.join("releases").join(id))
    }
    fn authorize(&self, operation: &Operation) -> Result<Target> {
        if !store::valid_id(&operation.target)
            || !self.policy.targets.contains(&operation.target)
            || !self
                .policy
                .actions
                .iter()
                .any(|a| a == operation.action.id())
        {
            return Err("Operation access denied".into());
        }
        let target: Target = read(
            &self
                .release(&self.config.active_release)?
                .join("targets")
                .join(format!("{}.json", operation.target)),
        )?;
        if target.backend != self.policy.backend
            || target.organization != self.policy.organization
            || target.kind != operation.action.target_kind()
            || !store::valid_id(&target.host)
            || matches!(target.host.as_str(), "all" | "ungrouped")
        {
            return Err("Operation target is outside operator scope".into());
        }
        match operation.action {
            OperationKind::ProjectCopy => {
                let destination = operation
                    .destination_domain
                    .as_deref()
                    .ok_or("A destination domain is required")?;
                if !domain(destination)
                    || target.source_domain.as_deref() == Some(destination)
                    || !target.source_domain.as_deref().map(domain).unwrap_or(false)
                    || !target
                        .source_path
                        .as_deref()
                        .map(source_path)
                        .unwrap_or(false)
                {
                    return Err("Invalid copy source or destination".into());
                }
            }
            OperationKind::ContainerStart
            | OperationKind::ContainerStop
            | OperationKind::ContainerRestart => {
                if operation.destination_domain.is_some()
                    || !target
                        .container_id
                        .as_deref()
                        .map(|v| {
                            v.len() == 64
                                && v.bytes()
                                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        })
                        .unwrap_or(false)
                {
                    return Err("Invalid container target".into());
                }
            }
            _ => {
                if operation.destination_domain.is_some() {
                    return Err("Unexpected operation parameter".into());
                }
            }
        }
        Ok(target)
    }
    fn verified(&self, plan: &Plan) -> Result<Parameters> {
        let parameters: Parameters =
            serde_json::from_value(plan.parameters.clone()).map_err(|_| "Invalid saved plan")?;
        let current = self.authorize(&parameters.operation)?;
        if plan.expires_at <= store::now()?
            || !self.config.execution_enabled
            || plan.release != self.config.active_release
            || plan.release_digest != release_digest(&self.release(&plan.release)?)?
            || serde_json::to_value(current).map_err(|_| "Invalid target")?
                != serde_json::to_value(&parameters.target).map_err(|_| "Invalid target")?
        {
            return Err("Controller release or permission changed; create a new plan".into());
        }
        Ok(parameters)
    }
    pub fn check_scope(&self, backend: &str, organization: &str) -> Result<()> {
        if backend != self.policy.backend || organization != self.policy.organization {
            return Err("Controller backend or organization mismatch".into());
        }
        Ok(())
    }
    pub fn handle(&self, request: Request) -> Result<Value> {
        let value = self.handle_request(request)?;
        if !response_fits(&value) {
            return Err("Controller response exceeds the protocol limit".into());
        }
        Ok(value)
    }
    fn handle_request(&self, request: Request) -> Result<Value> {
        match request {
            Request::Ping { target } => {
                let selected = self.authorize(&Operation {
                    action: OperationKind::ServerPing,
                    target: target.clone(),
                    destination_domain: None,
                })?;
                let release = self.release(&self.config.active_release)?;
                let digest = release_digest(&release)?;
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "Clock unavailable")?
                    .as_nanos();
                let directory = self
                    .root
                    .join("operations/preflight")
                    .join(format!("ping-{nonce}"));
                let mut builder = fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder
                    .create(&directory)
                    .map_err(|_| "Unable to prepare server ping")?;
                let result = (|| {
                    let output = directory.join("result.json");
                    let execution = self.run_recipe(
                        &release,
                        "server-ping.yml",
                        &selected.host,
                        &json!({"i7y_ping_output":output}),
                        Duration::from_secs(20),
                    )?;
                    let reachable = if execution.success {
                        let observed: Value = read(&output)?;
                        if observed != json!({"ping":"pong"}) {
                            return Err("Invalid Ansible ping response".into());
                        }
                        true
                    } else {
                        false
                    };
                    if release_digest(&release)? != digest {
                        return Err("Controller release changed during ping".into());
                    }
                    Ok(
                        json!({"version":1,"backend":self.policy.backend,"organization":self.policy.organization,"target":target,"reachable":reachable,"checked_at":store::now()?}),
                    )
                })();
                let _ = fs::remove_dir_all(directory);
                result
            }
            Request::Capabilities => {
                let mut catalog: Value = serde_json::from_str(include_str!("../actions.json"))
                    .map_err(|_| "Invalid action catalog")?;
                let implemented = [
                    OperationKind::ServerPing,
                    OperationKind::ServerInspect,
                    OperationKind::ServerDisk,
                    OperationKind::ContainerList,
                    OperationKind::ProjectCopy,
                    OperationKind::ContainerStart,
                    OperationKind::ContainerStop,
                    OperationKind::ContainerRestart,
                ];
                for action in catalog["actions"]
                    .as_array_mut()
                    .ok_or("Invalid action catalog")?
                {
                    let id = action["id"].as_str().unwrap_or("");
                    let enabled = (self.config.execution_enabled || id == "server.ping")
                        && self.policy.actions.iter().any(|a| a == id)
                        && implemented.iter().any(|a| {
                            a.id() == id
                                && self
                                    .release(&self.config.active_release)
                                    .map(|p| {
                                        p.join("recipes").join(a.recipe()).is_file()
                                            && (a.target_kind() != "container"
                                                || p.join("recipes/container-preflight.yml")
                                                    .is_file())
                                    })
                                    .unwrap_or(false)
                        });
                    action["enabled"] = json!(enabled);
                }
                Ok(
                    json!({"version":1,"principal":self.principal,"backend":self.policy.backend,"organization":self.policy.organization,"catalog":catalog}),
                )
            }
            Request::Plan {
                operation_id,
                operation,
            } => {
                if !store::valid_id(&operation_id) {
                    return Err("Invalid operation ID".into());
                }
                let target = self.authorize(&operation)?;
                let release = self.release(&self.config.active_release)?;
                if !release
                    .join("recipes")
                    .join(operation.action.recipe())
                    .is_file()
                {
                    return Err("A reviewed operation recipe is not installed".into());
                }
                let digest = release_digest(&release)?;
                if let Ok(saved) = self.store.plan(&operation_id, &self.principal) {
                    let parameters: Parameters = serde_json::from_value(saved.parameters.clone())
                        .map_err(|_| "Invalid saved plan")?;
                    if parameters.operation != operation
                        || saved.release_digest != digest
                        || saved.release != self.config.active_release
                    {
                        return Err("Operation ID already belongs to another plan".into());
                    }
                    let approval = self.store.prepare(&saved)?;
                    return Ok(json!({"plan":saved,"approval":approval,"execution_started":false}));
                }
                let preflight = if operation.action.target_kind() == "container" {
                    Some(self.container_preflight(&operation_id, &release, &target)?)
                } else {
                    None
                };
                if let Some(observed) = &preflight {
                    let state = observed.container.state.as_str();
                    if !matches!(state, "running" | "created" | "exited")
                        || (operation.action == OperationKind::ContainerRestart
                            && state != "running")
                    {
                        return Err("The container state does not support this operation".into());
                    }
                }
                if release_digest(&release)? != digest {
                    return Err("Controller release changed during preflight".into());
                }
                let parameters = serde_json::to_value(Parameters {
                    operation: operation.clone(),
                    target: target.clone(),
                    preflight,
                })
                .map_err(|_| "Invalid operation parameters")?;
                let expires_at = store::now()? + 600;
                let mut resources = if matches!(
                    operation.action,
                    OperationKind::ServerInspect
                        | OperationKind::ServerPing
                        | OperationKind::ServerDisk
                        | OperationKind::ContainerList
                ) {
                    Vec::new()
                } else {
                    vec![format!("host/{}", target.host)]
                };
                if let Some(destination) = &operation.destination_domain {
                    resources.push(format!("host/{}/domain/{destination}", target.host));
                }
                let plan = Plan {
                    version: 1,
                    operation_id,
                    principal: self.principal.clone(),
                    action: operation.action.id().into(),
                    target: operation.target,
                    parameters,
                    release: self.config.active_release.clone(),
                    release_digest: digest,
                    resources,
                    expires_at,
                };
                let approval = self.store.prepare(&plan)?;
                Ok(json!({"plan":plan,"approval":approval,"execution_started":false}))
            }
            Request::SubmitAuthorized {
                operation_id,
                approval,
                authorization,
            } => {
                let plan = self.store.plan(&operation_id, &self.principal)?;
                self.verified(&plan)?;
                if self
                    .store
                    .status(&operation_id, &self.principal, worker_alive)
                    .is_err()
                {
                    self.consume_ticket(&plan, &approval, &authorization)?;
                }
                self.submit_plan(&operation_id, &approval)
            }
            Request::Submit {
                operation_id,
                approval,
            } => {
                if self.config.central_authorization_key_file.is_some() {
                    return Err("Central authorization is required".into());
                }
                self.submit_plan(&operation_id, &approval)
            }
            Request::Status { operation_id } => self.operation_status(&operation_id),
        }
    }
    fn submit_plan(&self, operation_id: &str, approval: &str) -> Result<Value> {
        let plan = self.store.plan(&operation_id, &self.principal)?;
        self.verified(&plan)?;
        let created = self
            .store
            .submit(&operation_id, &self.principal, &approval)?;
        if created && self.launch(&operation_id).is_err() {
            self.store.launch_failed(&operation_id, &self.principal)?;
            return Err("Unable to launch operation; inspect status".into());
        }
        Ok(serde_json::to_value(
            self.store
                .status(&operation_id, &self.principal, worker_alive)?,
        )
        .map_err(|_| "Unable to encode operation status")?)
    }
    fn consume_ticket(&self, plan: &Plan, approval: &str, ticket: &str) -> Result<()> {
        if !ticket.starts_with("i7yo_") || ticket.len() != 69 {
            return Err("Invalid central authorization".into());
        }
        let backend = reqwest::Url::parse(&self.policy.backend)
            .map_err(|_| "Invalid central authorization backend")?;
        if !backend.username().is_empty()
            || backend.password().is_some()
            || backend.query().is_some()
            || backend.fragment().is_some()
            || !(backend.scheme() == "https"
                || (backend.scheme() == "http"
                    && matches!(
                        backend.host_str(),
                        Some("127.0.0.1" | "localhost" | "[::1]")
                    )))
        {
            return Err("Central authorization requires a trusted HTTPS backend".into());
        }
        let path = self
            .config
            .central_authorization_key_file
            .as_ref()
            .ok_or("Central authorization is not configured")?;
        let meta = fs::symlink_metadata(path).map_err(|_| "Controller credential unavailable")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 256 {
            return Err("Unsafe controller credential".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != 0 || meta.mode() & 0o077 != 0 {
                return Err("Controller credential must be root-owned and private".into());
            }
        }
        let token = fs::read_to_string(path).map_err(|_| "Controller credential unavailable")?;
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Authorization transport unavailable")?;
        let response=client.post(format!("{}api/i7y/operations/v1/consume",self.policy.backend)).bearer_auth(token.trim()).json(&json!({"ticket":ticket,"principal":self.principal,"operation_id":plan.operation_id,"action":plan.action,"target":plan.target,"approval":approval})).send().map_err(|_|"Central authorization outcome unknown")?;
        if !response.status().is_success() {
            return Err("Central authorization denied".into());
        }
        let value: Value = response
            .json()
            .map_err(|_| "Invalid central authorization response")?;
        if value["authorized"] != true {
            return Err("Central authorization denied".into());
        }
        Ok(())
    }
    fn operation_status(&self, id: &str) -> Result<Value> {
        let mut value =
            serde_json::to_value(self.store.status(id, &self.principal, worker_alive)?)
                .map_err(|_| "Invalid job status")?;
        let plan = self.store.plan(id, &self.principal)?;
        if value["state"] == "succeeded"
            && matches!(
                plan.action.as_str(),
                "server.inspect" | "server.disk" | "container.list"
            )
        {
            let path = self
                .root
                .join("operations/jobs")
                .join(id)
                .join("inspection.json");
            let inspection = (|| -> std::result::Result<Value, &'static str> {
                let meta = fs::symlink_metadata(&path).map_err(|_| "missing")?;
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err("invalid");
                }
                if meta.len() > MAX_RESPONSE_BYTES as u64 {
                    return Err("too_large");
                }
                let result: Value = read(&path).map_err(|_| "invalid")?;
                if !valid_inspection(&plan.action, &result) {
                    return Err("invalid");
                }
                Ok(result)
            })();
            let reason = match inspection {
                Ok(inspection) => {
                    value["inspection"] = inspection;
                    if response_fits(&value) {
                        None
                    } else {
                        value.as_object_mut().unwrap().remove("inspection");
                        Some("too_large")
                    }
                }
                Err(reason) => Some(reason),
            };
            if let Some(reason) = reason {
                value["inspection_evidence"] =
                    json!({"state":"omitted","reason":reason,"limit_bytes":MAX_RESPONSE_BYTES});
            }
        }
        Ok(value)
    }
    fn launch(&self, id: &str) -> Result<()> {
        let mut command =
            Command::new(std::env::current_exe().map_err(|_| "Executor unavailable")?);
        command
            .arg("--root")
            .arg(&self.root)
            .arg("--principal")
            .arg(&self.principal)
            .arg("--worker")
            .arg(id)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .current_dir("/")
            .env_clear();
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        command.spawn().map_err(|_| "Unable to launch worker")?;
        Ok(())
    }
    pub fn work(&self, id: &str) -> Result<()> {
        let identity = worker_identity(std::process::id())?.ok_or("Worker identity unavailable")?;
        let plan = self.store.claim(
            id,
            &self.principal,
            store::Worker {
                pid: std::process::id(),
                identity,
            },
        )?;
        let result = (|| {
            let parameters = self.verified(&plan)?;
            self.execute(&plan, &parameters)
        })();
        let (success, detail) = match result {
            Ok(success) => (
                success,
                if success {
                    None
                } else {
                    Some("recipe_failed".into())
                },
            ),
            Err(_) => (false, Some("worker_failed".into())),
        };
        self.store.finish(id, &self.principal, success, detail)
    }
    fn container_preflight(
        &self,
        id: &str,
        release: &Path,
        target: &Target,
    ) -> Result<ContainerPreflight> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Clock unavailable")?
            .as_nanos();
        let path = self
            .root
            .join("operations/preflight")
            .join(format!("{id}-{nonce}"));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|_| "Unable to prepare container inspection")?;
        let result = (|| {
            let output = path.join("observed.json");
            let variables =
                json!({"i7y_container_id":target.container_id,"i7y_preflight_output":output});
            if !self
                .run_recipe(
                    release,
                    "container-preflight.yml",
                    &target.host,
                    &variables,
                    Duration::from_secs(20),
                )?
                .success
            {
                return Err("Unable to inspect the selected container".into());
            }
            let container: ContainerObservation = read(&output)?;
            if Some(container.id.as_str()) != target.container_id.as_deref()
                || container.name.len() > 256
                || container.image.len() > 1024
                || !matches!(
                    container.state.as_str(),
                    "running"
                        | "exited"
                        | "created"
                        | "paused"
                        | "restarting"
                        | "removing"
                        | "dead"
                )
            {
                return Err("Invalid container observation".into());
            }
            Ok(ContainerPreflight {
                observed_at: store::now()?,
                container,
            })
        })();
        let _ = fs::remove_dir_all(path);
        result
    }
    fn run_recipe(
        &self,
        release: &Path,
        recipe: &str,
        host: &str,
        variables: &Value,
        timeout: Duration,
    ) -> Result<RecipeOutput> {
        let selection = self.invoke_recipe(
            release,
            recipe,
            host,
            variables,
            Duration::from_secs(5),
            true,
        )?;
        if !selection.success || !single_host(&selection.stdout, host) {
            return Err("Inventory target must resolve to exactly one host".into());
        }
        self.invoke_recipe(release, recipe, host, variables, timeout, false)
    }
    fn invoke_recipe(
        &self,
        release: &Path,
        recipe: &str,
        host: &str,
        variables: &Value,
        timeout: Duration,
        list_hosts: bool,
    ) -> Result<RecipeOutput> {
        let mut command = Command::new(&self.config.ansible_playbook);
        command
            .arg("--inventory")
            .arg(release.join("inventory.yml"))
            .arg("--limit")
            .arg(host)
            .arg("--extra-vars")
            .arg("@/dev/stdin")
            .arg(release.join("recipes").join(recipe))
            .current_dir(release)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", self.root.join("operations"))
            .env("ANSIBLE_CONFIG", release.join("ansible.cfg"))
            .env("ANSIBLE_HOST_KEY_CHECKING", "True")
            .env("ANSIBLE_NOCOLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if list_hosts {
            command.arg("--list-hosts");
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Unable to start reviewed recipe")?;
        let stdout = child.stdout.take().ok_or("Missing worker output")?;
        let stderr = child.stderr.take().ok_or("Missing worker output")?;
        let stop = Arc::new(AtomicBool::new(false));
        let out_stop = stop.clone();
        let err_stop = stop.clone();
        let out = thread::spawn(move || bounded(stdout, out_stop));
        let err = thread::spawn(move || bounded(stderr, err_stop));
        let sent =
            child.stdin.take().ok_or("Missing worker input")?.write_all(
                &serde_json::to_vec(&variables).map_err(|_| "Invalid recipe parameters")?,
            );
        let status = wait_for(&mut child, timeout);
        stop.store(true, Ordering::Release);
        let output = out.join().map_err(|_| "Unable to collect recipe output")?;
        let errors = err.join().map_err(|_| "Unable to collect recipe output")?;
        Ok(RecipeOutput {
            success: sent.is_ok() && status.map(|s| s.success()).unwrap_or(false),
            stdout: output,
            stderr: errors,
        })
    }
    fn execute(&self, plan: &Plan, parameters: &Parameters) -> Result<bool> {
        let release = self.release(&plan.release)?;
        let variables = json!({"i7y_copy":{"operation_id":plan.operation_id,"source_path":parameters.target.source_path,"source_domain":parameters.target.source_domain,"destination_domain":parameters.operation.destination_domain},"i7y_container_id":parameters.target.container_id,"i7y_expected_state":parameters.preflight.as_ref().map(|p|p.container.state.as_str()),"i7y_result_output":self.root.join("operations/jobs").join(&plan.operation_id).join("inspection.json")});
        let timeout = if matches!(
            parameters.operation.action,
            OperationKind::ServerInspect | OperationKind::ServerDisk | OperationKind::ContainerList
        ) {
            60
        } else {
            3600
        };
        let result = self.run_recipe(
            &release,
            parameters.operation.action.recipe(),
            &parameters.target.host,
            &variables,
            Duration::from_secs(timeout),
        )?;
        let path = self
            .root
            .join("operations/jobs")
            .join(&plan.operation_id)
            .join("output.log");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut log = options
            .open(path)
            .map_err(|_| "Unable to store recipe output")?;
        log.write_all(&result.stdout)
            .and_then(|_| log.write_all(&result.stderr))
            .and_then(|_| log.sync_all())
            .map_err(|_| "Unable to persist recipe output")?;
        Ok(result.success)
    }
}
fn single_host(output: &[u8], host: &str) -> bool {
    let Ok(text) = std::str::from_utf8(output) else {
        return false;
    };
    let mut lines = text.lines().map(str::trim);
    let mut count = 0;
    while let Some(line) = lines.next() {
        if line.starts_with("hosts (") {
            if line != "hosts (1):" || lines.next() != Some(host) {
                return false;
            }
            count += 1;
        }
    }
    count == 1
}
fn wait_for(child: &mut Child, timeout: Duration) -> Result<ExitStatus> {
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Unable to observe recipe result")?
        {
            return Ok(status);
        }
        if started.elapsed() >= timeout {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("Recipe execution deadline exceeded; reconcile remote resources".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}
#[cfg(unix)]
fn bounded(mut input: impl Read + std::os::fd::AsRawFd, stop: Arc<AtomicBool>) -> Vec<u8> {
    let fd = input.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Vec::new();
        }
    }
    let mut kept = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(n) => {
                let remaining = 512 * 1024usize - kept.len();
                kept.extend_from_slice(&buffer[..n.min(remaining)]);
            }
        }
    }
    kept
}
pub fn worker_identity(pid: u32) -> Result<Option<String>> {
    #[cfg(target_os = "linux")]
    {
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Worker observation unavailable".into()),
        };
        let tail = stat.rsplit_once(')').ok_or("Invalid worker observation")?.1;
        let fields: Vec<_> = tail.split_whitespace().collect();
        if matches!(fields.first(), Some(&"Z") | Some(&"X")) {
            return Ok(None);
        }
        let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| "Worker observation unavailable")?;
        Ok(Some(format!(
            "{}:{}",
            boot.trim(),
            fields.get(19).ok_or("Invalid worker observation")?
        )))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat=,lstart="])
            .output()
            .map_err(|_| "Worker observation unavailable")?;
        let value = String::from_utf8(output.stdout).map_err(|_| "Invalid worker observation")?;
        if !output.status.success() || value.trim().is_empty() || value.trim().starts_with('Z') {
            Ok(None)
        } else {
            Ok(Some(
                value
                    .split_whitespace()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join(" "),
            ))
        }
    }
}
pub fn worker_alive(worker: &store::Worker) -> Option<bool> {
    worker_identity(worker.pid)
        .ok()
        .map(|identity| identity.as_deref() == Some(&worker.identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enforce_recipe_deadline_and_bound_output() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 20"])
            .process_group(0)
            .spawn()
            .unwrap();
        let started = Instant::now();
        assert!(wait_for(&mut child, Duration::from_millis(50)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut output = Command::new("/bin/sh")
            .args(["-c", "head -c 1048576 /dev/zero"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let data = bounded(
            output.stdout.take().unwrap(),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(data.len(), 512 * 1024);
        assert!(output.wait().unwrap().success());
    }
}

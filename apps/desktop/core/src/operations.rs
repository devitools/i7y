use crate::ssh::{self, ControllerProfile, SshError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    ServerPing,
    ServerInspect,
    ServerDisk,
    ContainerList,
    ProjectCopy,
    ContainerStart,
    ContainerStop,
    ContainerRestart,
}
impl Kind {
    fn id(&self) -> &'static str {
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
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub action: Kind,
    pub target: String,
    pub destination_domain: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
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
#[derive(Serialize)]
pub struct Scope {
    pub backend: String,
    pub organization: String,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum Error {
    Transport(SshError),
    InvalidRequest,
    InvalidResponse,
    ScopeMismatch,
    Denied(String),
    ExecutionDisabled,
}
impl From<SshError> for Error {
    fn from(error: SshError) -> Self {
        Self::Transport(error)
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}
impl Request {
    pub fn validate(&self) -> Result<(), Error> {
        let valid = match self {
            Self::Capabilities => true,
            Self::Ping { target } => identifier(target),
            Self::Status { operation_id } => identifier(operation_id),
            Self::SubmitAuthorized {
                operation_id,
                approval,
                authorization,
            } => {
                identifier(operation_id)
                    && hash(approval)
                    && authorization.starts_with("i7yo_")
                    && authorization.len() == 69
                    && authorization[5..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric())
            }
            Self::Submit {
                operation_id,
                approval,
            } => identifier(operation_id) && hash(approval),
            Self::Plan {
                operation_id,
                operation,
            } => {
                identifier(operation_id)
                    && identifier(&operation.target)
                    && if operation.action == Kind::ProjectCopy {
                        operation
                            .destination_domain
                            .as_deref()
                            .map(domain)
                            .unwrap_or(false)
                    } else {
                        operation.destination_domain.is_none()
                    }
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::InvalidRequest)
        }
    }
    pub fn is_submission(&self) -> bool {
        matches!(self, Self::Submit { .. } | Self::SubmitAuthorized { .. })
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::InvalidResponse)
}
fn exact_keys(value: &Value, required: &[&str]) -> bool {
    value
        .as_object()
        .map(|obj| obj.len() == required.len() && required.iter().all(|key| obj.contains_key(*key)))
        .unwrap_or(false)
}
pub fn validate_response(
    scope: &Scope,
    request: &Request,
    mut value: Value,
) -> Result<Value, Error> {
    if value.to_string().len() >= ssh::MAX_CONTROLLER_RESPONSE_BYTES {
        return Err(Error::InvalidResponse);
    }
    let evidence = value
        .as_object_mut()
        .and_then(|v| v.remove("inspection_evidence"));
    let inspection = value.as_object_mut().and_then(|v| v.remove("inspection"));
    if let Some(metadata) = &evidence {
        if inspection.is_some()
            || !matches!(
                request,
                Request::Status { .. } | Request::Submit { .. } | Request::SubmitAuthorized { .. }
            )
            || value["state"] != "succeeded"
            || !exact_keys(metadata, &["state", "reason", "limit_bytes"])
            || metadata["state"] != "omitted"
            || !matches!(
                metadata["reason"].as_str(),
                Some("missing" | "invalid" | "too_large")
            )
            || metadata["limit_bytes"] != ssh::MAX_CONTROLLER_RESPONSE_BYTES
        {
            return Err(Error::InvalidResponse);
        }
    }
    if let Some(result) = &inspection {
        if !matches!(
            request,
            Request::Status { .. } | Request::Submit { .. } | Request::SubmitAuthorized { .. }
        ) || result.to_string().len() > 65536
            || !result.is_object()
        {
            return Err(Error::InvalidResponse);
        }
        let valid = if exact_keys(result, &["kernel", "uptime_seconds"]) {
            result["kernel"]
                .as_str()
                .map(|s| s.len() <= 1024)
                .unwrap_or(false)
                && result["uptime_seconds"].is_number()
        } else if exact_keys(result, &["disks"]) {
            result["disks"]
                .as_array()
                .map(|a| {
                    a.len() <= 256
                        && a.iter()
                            .all(|v| v.as_str().map(|s| s.len() <= 2048).unwrap_or(false))
                })
                .unwrap_or(false)
        } else if exact_keys(result, &["containers"]) {
            result["containers"]
                .as_array()
                .map(|a| {
                    a.len() <= 1000
                        && a.iter().all(|v| {
                            exact_keys(v, &["ID", "Names", "Image", "State", "Status", "Ports"])
                                && v.as_object()
                                    .unwrap()
                                    .values()
                                    .all(|v| v.as_str().map(|s| s.len() <= 2048).unwrap_or(false))
                        })
                })
                .unwrap_or(false)
        } else {
            false
        };
        if !valid {
            return Err(Error::InvalidResponse);
        }
    }
    if exact_keys(&value, &["error"]) {
        let message = string(&value, "error")?;
        if message.len() > 256 || message.chars().any(char::is_control) {
            return Err(Error::InvalidResponse);
        }
        return Err(Error::Denied(message.into()));
    }
    match request {
        Request::Ping { target } => {
            if !exact_keys(
                &value,
                &[
                    "version",
                    "backend",
                    "organization",
                    "target",
                    "reachable",
                    "checked_at",
                ],
            ) || value["version"] != 1
                || value["target"] != target.as_str()
                || !value["reachable"].is_boolean()
                || !value["checked_at"].is_u64()
            {
                return Err(Error::InvalidResponse);
            }
            if value["backend"] != scope.backend || value["organization"] != scope.organization {
                return Err(Error::ScopeMismatch);
            }
        }
        Request::Capabilities => {
            if !exact_keys(
                &value,
                &["version", "principal", "backend", "organization", "catalog"],
            ) || value["version"] != 1
                || !identifier(string(&value, "principal")?)
                || !value["catalog"]["actions"].is_array()
            {
                return Err(Error::InvalidResponse);
            }
            if value["backend"] != scope.backend || value["organization"] != scope.organization {
                return Err(Error::ScopeMismatch);
            }
            let actions = value["catalog"]["actions"]
                .as_array()
                .ok_or(Error::InvalidResponse)?;
            if !exact_keys(&value["catalog"], &["version", "actions"])
                || value["catalog"]["version"] != 1
                || actions.len() > 64
                || actions.iter().any(|a| {
                    !exact_keys(
                        a,
                        &[
                            "id",
                            "target",
                            "permission",
                            "recipe",
                            "legacy",
                            "title",
                            "status",
                            "enabled",
                        ],
                    ) || !a["enabled"].is_boolean()
                        || !a["id"].as_str().map(|v| v.len() <= 64).unwrap_or(false)
                        || !a["title"].as_str().map(|v| v.len() <= 128).unwrap_or(false)
                })
            {
                return Err(Error::InvalidResponse);
            }
        }
        Request::Plan {
            operation_id,
            operation,
        } => {
            if !exact_keys(&value, &["plan", "approval", "execution_started"])
                || value["execution_started"] != false
                || !hash(string(&value, "approval")?)
            {
                return Err(Error::InvalidResponse);
            }
            let plan = &value["plan"];
            if !exact_keys(
                plan,
                &[
                    "version",
                    "operation_id",
                    "principal",
                    "action",
                    "target",
                    "parameters",
                    "release",
                    "release_digest",
                    "resources",
                    "expires_at",
                ],
            ) || !exact_keys(&plan["parameters"], &["operation", "target", "preflight"])
                || !exact_keys(
                    &plan["parameters"]["target"],
                    &[
                        "host",
                        "kind",
                        "backend",
                        "organization",
                        "source_path",
                        "source_domain",
                        "container_id",
                    ],
                )
            {
                return Err(Error::InvalidResponse);
            }
            if plan["version"] != 1
                || plan["operation_id"] != *operation_id
                || plan["target"] != operation.target
                || plan["action"] != operation.action.id()
                || plan["parameters"]["operation"]
                    != serde_json::to_value(operation).map_err(|_| Error::InvalidRequest)?
                || !plan["expires_at"].is_u64()
            {
                return Err(Error::InvalidResponse);
            }
            let target = &plan["parameters"]["target"];
            let preflight = &plan["parameters"]["preflight"];
            if matches!(
                operation.action,
                Kind::ContainerStart | Kind::ContainerStop | Kind::ContainerRestart
            ) {
                let observed = &preflight["container"];
                if !exact_keys(preflight, &["observed_at", "container"])
                    || !preflight["observed_at"].is_u64()
                    || !exact_keys(observed, &["id", "name", "image", "state"])
                    || observed["id"] != target["container_id"]
                    || !hash(string(observed, "id")?)
                    || string(observed, "name")?.len() > 256
                    || string(observed, "image")?.len() > 1024
                    || !matches!(string(observed, "state")?, "running" | "exited" | "created")
                {
                    return Err(Error::InvalidResponse);
                }
                if operation.action == Kind::ContainerRestart && observed["state"] != "running" {
                    return Err(Error::InvalidResponse);
                }
            } else if !preflight.is_null() {
                return Err(Error::InvalidResponse);
            }
            if plan["parameters"]["target"]["backend"] != scope.backend
                || plan["parameters"]["target"]["organization"] != scope.organization
            {
                return Err(Error::ScopeMismatch);
            }
        }
        Request::SubmitAuthorized { operation_id, .. }
        | Request::Submit { operation_id, .. }
        | Request::Status { operation_id } => {
            if !exact_keys(
                &value,
                &[
                    "operation_id",
                    "state",
                    "events",
                    "reconciliation_required",
                    "worker_observation",
                ],
            ) || value["operation_id"] != *operation_id
                || !matches!(
                    string(&value, "state")?,
                    "queued" | "running" | "succeeded" | "failed" | "interrupted"
                )
                || !value["reconciliation_required"].is_boolean()
            {
                return Err(Error::InvalidResponse);
            }
            let events = value["events"].as_array().ok_or(Error::InvalidResponse)?;
            if events.is_empty() || events.len() > 3 {
                return Err(Error::InvalidResponse);
            }
            let mut previous = "";
            for (i, event) in events.iter().enumerate() {
                let state = string(event, "state")?;
                if !exact_keys(event, &["sequence", "time", "state", "worker", "detail"])
                    || event["sequence"] != i
                    || !event["time"].is_u64()
                    || !matches!(
                        (previous, state),
                        ("", "queued")
                            | ("queued", "running")
                            | ("queued", "failed")
                            | ("running", "succeeded")
                            | ("running", "failed")
                    )
                {
                    return Err(Error::InvalidResponse);
                }
                if !event["detail"].is_null()
                    && !event["detail"]
                        .as_str()
                        .map(|v| v.len() <= 128 && !v.chars().any(char::is_control))
                        .unwrap_or(false)
                {
                    return Err(Error::InvalidResponse);
                }
                if state == "running" {
                    let worker = &event["worker"];
                    if !exact_keys(worker, &["pid", "identity"])
                        || !worker["pid"].is_u64()
                        || !worker["identity"]
                            .as_str()
                            .map(|v| v.len() <= 256)
                            .unwrap_or(false)
                    {
                        return Err(Error::InvalidResponse);
                    }
                } else if !event["worker"].is_null() {
                    return Err(Error::InvalidResponse);
                }
                previous = state;
            }
            let reported = string(&value, "state")?;
            if reported == "interrupted" {
                if previous != "running" || value["worker_observation"] != "exited" {
                    return Err(Error::InvalidResponse);
                }
            } else if reported != previous {
                return Err(Error::InvalidResponse);
            }
            if reported == "running" {
                if !matches!(
                    value["worker_observation"].as_str(),
                    Some("alive" | "unknown")
                ) {
                    return Err(Error::InvalidResponse);
                }
            } else if reported != "interrupted" && !value["worker_observation"].is_null() {
                return Err(Error::InvalidResponse);
            }
        }
    }
    if let Some(inspection) = inspection {
        value["inspection"] = inspection;
    }
    if let Some(evidence) = evidence {
        value["inspection_evidence"] = evidence;
    }
    Ok(value)
}
pub fn exchange(
    profile: &ControllerProfile,
    identity: &Path,
    known_hosts: &Path,
    scope: Scope,
    request: Request,
) -> Result<Value, Error> {
    request.validate()?;
    if scope.backend.len() > 2048 || !identifier(&scope.organization) {
        return Err(Error::InvalidRequest);
    }
    let input=serde_json::to_vec(&serde_json::json!({"version":1,"backend":scope.backend,"organization":scope.organization,"request":request})).map_err(|_|Error::InvalidRequest)?;
    if input.len() > 16384 {
        return Err(Error::InvalidRequest);
    }
    let (success, output, stderr) = ssh::run(profile, identity, known_hosts, true, Some(input))?;
    let value: Value = match serde_json::from_str(&output) {
        Ok(value) => value,
        Err(_) => {
            return Err(if success {
                Error::InvalidResponse
            } else {
                Error::Transport(ssh::classify_failure(&stderr))
            })
        }
    };
    let response = validate_response(&scope, &request, value)?;
    if !success {
        return Err(Error::Transport(ssh::classify_failure(&stderr)));
    }
    Ok(response)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn scope() -> Scope {
        Scope {
            backend: "https://inventory.example.com/".into(),
            organization: "org01".into(),
        }
    }
    #[test]
    fn reject_arbitrary_commands_options_and_invalid_domains() {
        assert!(serde_json::from_value::<Request>(json!({"command":"plan","operation_id":"one","operation":{"action":"server_inspect","target":"server01","shell":"id"}})).is_err());
        for target in ["-option", "../host", "host;id"] {
            assert!(Request::Plan {
                operation_id: "one".into(),
                operation: Operation {
                    action: Kind::ServerInspect,
                    target: target.into(),
                    destination_domain: None
                }
            }
            .validate()
            .is_err());
        }
        for value in [
            "https://new.example.com",
            "new.example.com;id",
            "-new.example.com",
            "a..com",
        ] {
            assert!(Request::Plan {
                operation_id: "one".into(),
                operation: Operation {
                    action: Kind::ProjectCopy,
                    target: "project01".into(),
                    destination_domain: Some(value.into())
                }
            }
            .validate()
            .is_err());
        }
        assert!(Request::Plan {
            operation_id: "one".into(),
            operation: Operation {
                action: Kind::ProjectCopy,
                target: "project01".into(),
                destination_domain: Some("new.example.com".into())
            }
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn require_reply_identity_and_exclude_unexpected_logs() {
        let scope = scope();
        let request = Request::Status {
            operation_id: "one".into(),
        };
        let valid = json!({"operation_id":"one","state":"succeeded","events":[{"sequence":0,"time":10,"state":"queued","worker":null,"detail":null},{"sequence":1,"time":11,"state":"running","worker":{"pid":10,"identity":"boot:1"},"detail":null},{"sequence":2,"time":12,"state":"succeeded","worker":null,"detail":null}],"reconciliation_required":false,"worker_observation":null});
        assert!(validate_response(&scope, &request, valid.clone()).is_ok());
        let mut wrong = valid.clone();
        wrong["operation_id"] = json!("two");
        assert!(validate_response(&scope, &request, wrong).is_err());
        let mut logs = valid;
        logs["output"] = json!("private output");
        assert!(validate_response(&scope, &request, logs).is_err());
        let other = json!({"version":1,"principal":"operator01","backend":"https://other.example.com/","organization":"org01","catalog":{"actions":[]}});
        assert!(matches!(
            validate_response(&scope, &Request::Capabilities, other),
            Err(Error::ScopeMismatch)
        ));
    }

    #[test]
    fn omitted_inspection_requires_explicit_bounded_metadata() {
        let request = Request::Status { operation_id: "one".into() };
        let status = json!({"operation_id":"one","state":"succeeded","events":[{"sequence":0,"time":10,"state":"queued","worker":null,"detail":null},{"sequence":1,"time":11,"state":"running","worker":{"pid":10,"identity":"boot:1"},"detail":null},{"sequence":2,"time":12,"state":"succeeded","worker":null,"detail":null}],"reconciliation_required":false,"worker_observation":null});
        for reason in ["missing", "invalid", "too_large"] {
            let mut value = status.clone();
            value["inspection_evidence"] = json!({"state":"omitted","reason":reason,"limit_bytes":ssh::MAX_CONTROLLER_RESPONSE_BYTES});
            assert_eq!(validate_response(&scope(), &request, value.clone()).unwrap(), value);
            value["inspection"] = json!({"disks":[]});
            assert!(validate_response(&scope(), &request, value).is_err());
        }
        for metadata in [
            json!({"state":"omitted","reason":"unknown","limit_bytes":ssh::MAX_CONTROLLER_RESPONSE_BYTES}),
            json!({"state":"omitted","reason":"invalid","limit_bytes":1}),
            json!({"state":"omitted","reason":"invalid","limit_bytes":ssh::MAX_CONTROLLER_RESPONSE_BYTES,"raw_output":"private"}),
        ] {
            let mut value = status.clone();
            value["inspection_evidence"] = metadata;
            assert!(validate_response(&scope(), &request, value).is_err());
        }
    }
    #[test]
    fn ping_requires_matching_target_scope_and_structured_result() {
        let scope=scope();
        let request=Request::Ping { target:"server01".into() };
        assert!(request.validate().is_ok());
        assert!(!request.is_submission());
        assert!(Request::Ping { target:"../other".into() }.validate().is_err());
        let valid=json!({"version":1,"backend":scope.backend,"organization":scope.organization,"target":"server01","reachable":true,"checked_at":123});
        assert!(validate_response(&scope,&request,valid.clone()).is_ok());
        for (key,value) in [("target",json!("other")),("reachable",json!("pong")),("output",json!("private output")),("organization",json!("other"))] {
            let mut response=valid.clone();response[key]=value;
            assert!(validate_response(&scope,&request,response).is_err());
        }
    }
}

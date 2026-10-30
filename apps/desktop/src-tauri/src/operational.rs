use crate::mcp::{self, SavedPlan, Service};
use i7y_core::operations::{Kind, Operation, Request};
use i7y_mcp::Context;
use serde_json::{json, Value};
use tauri::Manager;
async fn exchange(
    app: &tauri::AppHandle,
    guard: &mcp::RequestGuard,
    request: Request,
) -> Result<Value, String> {
    guard.check(app)?;
    let operation_id = match &request {
        Request::Plan { operation_id, .. } | Request::Submit { operation_id, .. }
            | Request::SubmitAuthorized { operation_id, .. } | Request::Status { operation_id } => Some(operation_id.clone()),
        _ => None,
    };
    let result = crate::controller::exchange_request(app.clone(), guard.context.organization.clone(), request, Some(guard.clone()))
        .await;
    guard.check(app)?;
    result.map_err(|error| controller_failure(error, operation_id.as_deref()))
}
fn controller_failure(error: i7y_core::operations::Error, operation_id: Option<&str>) -> String {
    match error {
        i7y_core::operations::Error::Denied(_) | i7y_core::operations::Error::InvalidRequest | i7y_core::operations::Error::ExecutionDisabled => "Controller rejected the request".into(),
        _ => format!("Controller transport or response outcome unknown{}; query get_operation before retrying", operation_id.map(|id|format!(" for operation {id}")).unwrap_or_default()),
    }
}
async fn permission(
    app: &tauri::AppHandle,
    ctx: &Context,
    action: &str,
    target: &str,
) -> Result<(), String> {
    mcp::api(
        app,
        "POST",
        "api/i7y/operations/v1/check",
        vec![],
        Some(json!({"action":action,"target":target})),
        None,
        None,
        Some(ctx),
    )
    .await
    .map(|_| ())
}
pub async fn execute(
    app: &tauri::AppHandle,
    guard: &mcp::RequestGuard,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    guard.check(app)?;
    let ctx = &guard.context;
    if name == "automation_capabilities" {
        let mut value = exchange(app, guard, Request::Capabilities).await?;
        value["central_permission_required"] = json!(true);
        return Ok(value);
    }
    if name == "plan_operation" || name == "inspect_resource" {
        let action = args["action"].as_str().ok_or("Missing action")?;
        let target = args["target"].as_str().ok_or("Missing target")?;
        let kind: Kind = serde_json::from_value(json!(action)).map_err(|_| "Unsupported action")?;
        let dotted = action.replace('_', ".");
        permission(app, ctx, &dotted, target).await?;
        let id = mcp::nonce();
        let response = exchange(
            app,
            guard,
            Request::Plan {
                operation_id: id.clone(),
                operation: Operation {
                    action: kind,
                    target: target.into(),
                    destination_domain: None,
                },
            },
        )
        .await?;
        guard.check(app)?;
        {
            let state = app.state::<Service>();
            let mut inner = state.inner.lock().map_err(|_| "Operation state unavailable")?;
            inner.check_connection(&guard.connection, ctx, guard.request_id.is_none(), i7y_mcp::now())?;
            persist_plan(app, ctx, &id, &response)?;
            inner.plans.insert(id.clone(), SavedPlan { context: ctx.clone(), value: response.clone() });
        }
        if name == "inspect_resource" {
            return Box::pin(execute(
                app,
                guard,
                "submit_operation",
                &json!({"operation_id":id}),
            ))
            .await;
        }
        return Ok(response);
    }
    let id = args["operation_id"]
        .as_str()
        .ok_or("Missing operation ID")?;
    if name == "get_operation" {
        mcp::api(
            app,
            "POST",
            "api/i7y/operations/v1/status-access",
            vec![],
            Some(json!({"operation_id":id})),
            None,
            None,
            Some(ctx),
        )
        .await?;
        return exchange(
            app,
            guard,
            Request::Status {
                operation_id: id.into(),
            },
        )
        .await;
    }
    let saved = app
        .state::<Service>()
        .inner
        .lock()
        .map_err(|_| "Operation state unavailable")?
        .plans
        .get(id)
        .cloned()
        .ok_or("Operation not found in this desktop session")?;
    if saved.context != *ctx {
        return Err("Operation context changed".into());
    }
    if name != "submit_operation" {
        return Err("Unsupported operation tool".into());
    }
    if let Some(reviewed) = args.get("__reviewed_plan") {
        if *reviewed != saved.value {
            return Err("Reviewed plan changed".into());
        }
    }
    let plan = &saved.value["plan"];
    if plan["expires_at"].as_u64().unwrap_or(0) <= i7y_mcp::now() {
        return Err("Plan expired; prepare a new plan".into());
    }
    let action = plan["action"].as_str().ok_or("Invalid saved plan")?;
    let target = plan["target"].as_str().ok_or("Invalid saved target")?;
    let ticket=mcp::api(app,"POST","api/i7y/operations/v1/tickets",vec![],Some(json!({"principal":plan["principal"],"operation_id":id,"action":action,"target":target,"approval":saved.value["approval"]})),None,None,Some(ctx)).await?;
    exchange(
        app,
        guard,
        Request::SubmitAuthorized {
            operation_id: id.into(),
            approval: saved.value["approval"]
                .as_str()
                .ok_or("Invalid plan approval")?
                .into(),
            authorization: ticket["ticket"]
                .as_str()
                .ok_or("Invalid central authorization")?
                .into(),
        },
    )
    .await
}

fn persist_plan(
    app: &tauri::AppHandle,
    ctx: &Context,
    id: &str,
    value: &Value,
) -> Result<(), String> {
    let scope = i7y_mcp::digest(&json!([ctx.backend, ctx.organization, ctx.user]));
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Operation storage unavailable")?
        .join("mcp-operations")
        .join(scope);
    std::fs::create_dir_all(&directory).map_err(|_| "Operation storage unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Operation storage unavailable")?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options
        .open(directory.join(format!("{id}.json")))
        .map_err(|_| "Unable to retain operation identity")?;
    file.write_all(serde_json::to_string(&json!({"operation_id":id,"action":value["plan"]["action"],"target":value["plan"]["target"],"user":ctx.user,"organization":ctx.organization})).map_err(|_|"Invalid operation identity")?.as_bytes()).and_then(|_|file.sync_all()).map_err(|_|"Unable to retain operation identity".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controller_denial_is_distinct_from_unconfirmed_transport_and_response() {
        use i7y_core::operations::Error;
        assert_eq!(controller_failure(Error::Denied("private diagnostic".into()), Some("job")), "Controller rejected the request");
        for error in [Error::InvalidResponse, Error::ScopeMismatch, Error::Transport(i7y_core::ssh::SshError::TimedOut)] {
            let message = controller_failure(error, Some("job"));
            assert!(message.contains("unknown for operation job"));
            assert!(!message.contains("private diagnostic"));
        }
    }
}

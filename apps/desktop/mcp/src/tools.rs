use serde_json::{json, Value};

fn string() -> Value {
    json!({"type":"string","maxLength":240,"minLength":1})
}
fn id() -> Value {
    json!({"type":"string","maxLength":15,"minLength":15,"pattern":"^[a-z0-9]{15}$"})
}
fn integer(min: i64, max: i64) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn list() -> Value {
    object(
        json!({"page":integer(1,1000000),"perPage":integer(1,100),"search":string(),"workspace":string(),"server":id(),"project":id()}),
        &[],
    )
}
fn rule() -> Value {
    object(
        json!({"name":string(),"scope_type":{"type":"string","enum":["workspace","server","container"]},"scope_id":id(),"condition":object(json!({"metric":string(),"operator":string(),"value":{"anyOf":[{"type":"number"},{"type":"string","maxLength":32}]},"critical_value":{"type":"number","minimum":0,"maximum":100,"description":"Optional critical threshold for warning CPU, memory or disk gt/gte rules; must exceed value."},"disk_path":string(),"state":string()}),&["metric","operator"]),"severity":{"type":"string","enum":["info","warning","critical"]},"duration_seconds":{"type":"integer","minimum":0,"maximum":604800,"description":"Sustained seconds before initial entry. CPU and memory thresholds require this duration independently per severity. Simulation ignores duration."},"reminder_seconds":integer(60,604800),"enabled":{"type":"boolean"}}),
        &[
            "name",
            "scope_type",
            "scope_id",
            "condition",
            "severity",
            "duration_seconds",
            "reminder_seconds",
            "enabled",
        ],
    )
}
pub fn catalog() -> Vec<Value> {
    let mut out = Vec::new();
    let mut add = |name: &str, description: &str, schema: Value, write: bool| {
        out.push(json!({"name":name,"description":description,"inputSchema":schema,"annotations":{"readOnlyHint":!write,"destructiveHint":write,"openWorldHint":true}}))
    };
    add(
        "connection_status",
        "Connection context and available capabilities. Client names are self-reported.",
        object(json!({}), &[]),
        false,
    );
    add(
        "request_status",
        "Read a request result. Approvals can only be granted in the desktop.",
        object(json!({"request_id":string()}), &["request_id"]),
        false,
    );
    for resource in ["workspaces", "servers", "projects", "containers", "images"] {
        let mut schema = list();
        if resource == "images" {
            schema["required"] = json!(["workspace"]);
        }
        add(
            &format!("list_{resource}"),
            "Read paginated inventory. Observations may be stale; this is not a live inspection.",
            schema,
            false,
        );
    }
    for resource in ["server", "project", "container"] {
        add(
            &format!("get_{resource}"),
            "Read an inventory record and its observed state.",
            object(json!({"id":id()}), &["id"]),
            false,
        );
    }
    add(
        "search_inventory",
        "Search servers, projects and containers, with pagination per resource.",
        list(),
        false,
    );
    add(
        "get_resource_telemetry",
        "Read timestamped server/container metrics, not credentials or live logs.",
        object(
            json!({"resource_type":{"type":"string","enum":["server","container"]},"id":id(),"since":string(),"until":string(),"page":integer(1,1000000),"perPage":integer(1,100)}),
            &["resource_type", "id"],
        ),
        false,
    );
    add(
        "list_alert_metrics",
        "Discover supported metrics and conditions.",
        object(json!({}), &[]),
        false,
    );
    add(
        "list_alert_rules",
        "Read paginated rules.",
        object(
            json!({"page":integer(1,1000000),"perPage":integer(1,100)}),
            &[],
        ),
        false,
    );
    add(
        "get_alert_rule",
        "Read an alert rule.",
        object(json!({"key":string()}), &["key"]),
        false,
    );
    add(
        "simulate_alert_rule",
        "Simulate a draft against current observations, without saving it or enforcing minimum duration.",
        object(json!({"rule":rule()}), &["rule"]),
        false,
    );
    add("save_alert_rule","Create or update a rule after local review. Use its edit_version as expected_version, or 0 for a new rule.",object(json!({"key":string(),"expected_version":integer(0,i32::MAX as i64),"rule":rule()}),&["key","expected_version","rule"]),true);
    add(
        "archive_alert_rule",
        "Archive a rule after local review.",
        object(
            json!({"key":string(),"expected_version":integer(1,i32::MAX as i64)}),
            &["key", "expected_version"],
        ),
        true,
    );
    add(
        "list_incidents",
        "Read incidents and their workflow state.",
        object(
            json!({"status":{"type":"string","enum":["open","resolved","all"]},"severity":{"type":"string","enum":["info","warning","critical"]},"search":string(),"server_id":id(),"workspace_id":id(),"assignee":id(),"page":integer(1,1000000),"perPage":integer(1,100)}),
            &[],
        ),
        false,
    );
    add(
        "get_incident",
        "Read an incident including evidence and audit events.",
        object(json!({"id":id()}), &["id"]),
        false,
    );
    add(
        "create_incident",
        "Create an incident after local review.",
        object(
            json!({"title":string(),"severity":{"type":"string","enum":["info","warning","critical"]},"resource_type":{"type":"string","enum":["workspace","server","container"]},"resource_id":id(),"resource_name":string(),"reminder_seconds":integer(60,604800),"evidence":{"type":"object"}}),
            &["title", "severity"],
        ),
        true,
    );
    add(
        "claim_incident",
        "Claim or extend an incident as the signed-in user, after local review.",
        object(
            json!({"id":id(),"version":integer(1,i32::MAX as i64),"claim_until":string()}),
            &["id", "version", "claim_until"],
        ),
        true,
    );
    add(
        "resolve_incident",
        "Record manual resolution after review; this does not fix the infrastructure.",
        object(
            json!({"id":id(),"version":integer(1,i32::MAX as i64)}),
            &["id", "version"],
        ),
        true,
    );
    add(
        "automation_capabilities",
        "List controller actions. Availability also requires central permission for a target.",
        object(json!({"target":id()}), &[]),
        false,
    );
    add(
        "inspect_resource",
        "Inspect a live server, disks or containers through a fixed controller recipe.",
        object(
            json!({"target":id(),"action":{"type":"string","enum":["server_inspect","server_disk","container_list"]}}),
            &["target", "action"],
        ),
        false,
    );
    add(
        "plan_operation",
        "Prepare a release-bound controller plan for a container action.",
        object(
            json!({"target":id(),"action":{"type":"string","enum":["container_start","container_stop","container_restart"]}}),
            &["target", "action"],
        ),
        false,
    );
    add(
        "submit_operation",
        "Request local review and execution of an existing immutable plan.",
        object(json!({"operation_id":string()}), &["operation_id"]),
        true,
    );
    add(
        "get_operation",
        "Read the durable status of a controller job; never retries it.",
        object(json!({"operation_id":string()}), &["operation_id"]),
        false,
    );
    out
}
pub fn validate(name: &str, args: &Value) -> Result<bool, String> {
    let tool = catalog()
        .into_iter()
        .find(|t| t["name"] == name)
        .ok_or("Unknown tool")?;
    check(&tool["inputSchema"], args)?;
    if matches!(name, "save_alert_rule" | "simulate_alert_rule") {
        let rule = &args["rule"];
        let condition = &rule["condition"];
        if let Some(critical) = condition.get("critical_value") {
            let ordered = critical.as_f64().zip(condition["value"].as_f64())
                .map(|(critical, warning)| warning >= 0.0 && critical > warning && critical <= 100.0)
                .unwrap_or(false);
            if !matches!(condition["metric"].as_str(), Some("host.cpu_percent" | "host.memory_percent" | "host.disk_percent")) || rule["severity"] != "warning"
                || !matches!(condition["operator"].as_str(), Some("gt" | "gte")) || !ordered {
                return Err("Critical threshold requires a warning CPU, memory or disk gt/gte rule and must exceed its warning threshold".into());
            }
        }
    }
    Ok(tool["annotations"]["readOnlyHint"] == false)
}
fn check(schema: &Value, v: &Value) -> Result<(), String> {
    if let Some(choices) = schema["anyOf"].as_array() {
        return if choices.iter().any(|s| check(s, v).is_ok()) {
            Ok(())
        } else {
            Err("Invalid condition value".into())
        };
    }
    let valid = match schema["type"].as_str() {
        Some("object") => v.is_object(),
        Some("string") => v.is_string(),
        Some("integer") => v.is_i64() || v.is_u64(),
        Some("number") => v.is_number(),
        Some("boolean") => v.is_boolean(),
        _ => false,
    };
    if !valid {
        return Err("Invalid argument type".into());
    }
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(v) {
            return Err("Invalid argument value".into());
        }
    }
    if let Some(map) = v.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for key in required {
                if !map.contains_key(key.as_str().unwrap_or("")) {
                    return Err("Missing required argument".into());
                }
            }
        }
        for (key, value) in map {
            if let Some(prop) = schema["properties"].get(key) {
                check(prop, value)?;
            } else if schema["additionalProperties"] == false {
                return Err("Unknown argument".into());
            }
        }
    }
    if let Some(text) = v.as_str() {
        if text.len() > schema["maxLength"].as_u64().unwrap_or(4096) as usize
            || text.len() < schema["minLength"].as_u64().unwrap_or(0) as usize
            || text.chars().any(char::is_control)
        {
            return Err("Invalid text argument".into());
        }
        if schema.get("pattern").is_some()
            && !(text.len() == 15
                && text
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
        {
            return Err("Invalid record ID".into());
        }
    }
    if let Some(n) = v.as_f64() {
        if n < schema["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY)
            || n > schema["maximum"].as_f64().unwrap_or(f64::INFINITY)
        {
            return Err("Argument outside supported bounds".into());
        }
    }
    Ok(())
}
pub struct ApiCall {
    pub method: &'static str,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    pub revision: Option<String>,
}
fn escaped(v: &str) -> String {
    serde_json::to_string(v).unwrap()
}
fn segment(v: &Value) -> Result<&str, String> {
    let s = v.as_str().ok_or("Missing identifier")?;
    if !crate::identifier(s) {
        return Err("Invalid identifier".into());
    }
    Ok(s)
}
pub fn api_call(name: &str, args: &Value) -> Result<ApiCall, String> {
    validate(name, args)?;
    let mut c = ApiCall {
        method: "GET",
        path: String::new(),
        query: vec![],
        body: None,
        revision: None,
    };
    let alerts = "api/i7y/alerts/v1";
    if let Some(resource) = name
        .strip_prefix("list_")
        .filter(|r| ["workspaces", "servers", "projects", "containers", "images"].contains(r))
    {
        c.path = format!("api/collections/i7y_{resource}/records");
        let mut filters = vec![];
        for (key, field) in [
            ("workspace", "workspace_login"),
            ("server", "server_id"),
            ("project", "project_id"),
        ] {
            if let Some(v) = args[key].as_str() {
                filters.push(format!("{field} = {}", escaped(v)));
            }
        }
        if let Some(search) = args["search"].as_str() {
            filters.push(format!("search_text ~ {}", escaped(search)));
        }
        c.query.push(("filter".into(), filters.join(" && ")));
        c.query.push(("fields".into(), "id,payload".into()));
    } else if ["get_server", "get_project", "get_container"].contains(&name) {
        c.path = format!(
            "api/collections/i7y_{}s/records/{}",
            name.trim_start_matches("get_"),
            segment(&args["id"])?
        );
        c.query.push(("fields".into(), "id,payload".into()));
    } else {
        match name {
            "get_resource_telemetry" => {
                if args.get("since").is_some() || args.get("until").is_some() {
                    if args["resource_type"] != "server" {
                        return Err("Historical metrics require a server target".into());
                    }
                    c.path = "api/collections/telemetry_samples/records".into();
                    let mut filter = format!("server = {}", escaped(segment(&args["id"])?));
                    for (key, op) in [("since", ">="), ("until", "<=")] {
                        if let Some(v) = args[key].as_str() {
                            filter.push_str(&format!(" && observed_at {op} {}", escaped(v)));
                        }
                    }
                    c.query.push(("filter".into(), filter));
                    c.query
                        .push(("fields".into(), "id,server,observed_at,payload.host".into()));
                    c.query.push(("sort".into(), "-observed_at,id".into()));
                } else {
                    c.path = format!(
                        "api/collections/{}s/records/{}",
                        args["resource_type"].as_str().unwrap(),
                        segment(&args["id"])?
                    );
                    c.query
                        .push(("fields".into(), "id,name,last_seen,telemetry".into()));
                }
            }
            "list_alert_metrics" => c.path = format!("{alerts}/metrics"),
            "list_alert_rules" => c.path = format!("{alerts}/rules"),
            "get_alert_rule" | "save_alert_rule" | "archive_alert_rule" => {
                c.path = format!("{alerts}/rules/{}", segment(&args["key"])?);
                if name != "get_alert_rule" {
                    c.method = if name == "save_alert_rule" {
                        "PUT"
                    } else {
                        "DELETE"
                    };
                    c.revision = Some(args["expected_version"].to_string());
                    if c.method == "PUT" {
                        c.body = Some(args["rule"].clone());
                    }
                }
            }
            "simulate_alert_rule" => {
                c.path = format!("{alerts}/rules/simulate");
                c.method = "POST";
                c.body = Some(args["rule"].clone());
            }
            "list_incidents" => {
                c.path = format!("{alerts}/incidents");
                for key in [
                    "status",
                    "severity",
                    "search",
                    "server_id",
                    "workspace_id",
                    "assignee",
                ] {
                    if let Some(v) = args[key].as_str() {
                        c.query.push((key.into(), v.into()));
                    }
                }
            }
            "get_incident" => c.path = format!("{alerts}/incidents/{}", segment(&args["id"])?),
            "create_incident" => {
                c.path = format!("{alerts}/incidents");
                c.method = "POST";
                c.body = Some(args.clone());
            }
            "claim_incident" | "resolve_incident" => {
                c.path = format!(
                    "{alerts}/incidents/{}/{}",
                    segment(&args["id"])?,
                    if name == "claim_incident" {
                        "claim"
                    } else {
                        "resolve"
                    }
                );
                c.method = "POST";
                let mut body = args.clone();
                body.as_object_mut().unwrap().remove("id");
                c.body = Some(body);
            }
            _ => return Err("This tool is not an API query".into()),
        }
    }
    if name.starts_with("list_") || c.path.contains("telemetry_samples") {
        c.query.push((
            "page".into(),
            args["page"].as_u64().unwrap_or(1).to_string(),
        ));
        c.query.push((
            "perPage".into(),
            args["perPage"].as_u64().unwrap_or(50).to_string(),
        ));
        if c.path.contains("/collections/") && !c.path.contains("telemetry_samples") {
            c.query.push(("sort".into(), "id".into()));
        }
    }
    Ok(c)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_arbitrary_queries() {
        assert!(validate("list_servers", &json!({"perPage":101})).is_err());
        assert!(validate("list_servers", &json!({"filter":"true"})).is_err());
        assert!(validate(
            "submit_operation",
            &json!({"operation_id":"a","approval":"fake"})
        )
        .is_err());
        assert!(validate("get_server", &json!({"id":"../../private"})).is_err());
    }
    #[test]
    fn escapes_search_and_retains_pagination() {
        let c = api_call("list_servers", &json!({"search":"\" || true","page":2})).unwrap();
        assert!(c.query.iter().any(|(k, v)| k == "page" && v == "2"));
        assert!(c.query[0].1.contains("\\\""));
    }
    #[test]
    fn mutations_require_preconditions() {
        assert!(validate("save_alert_rule", &json!({"key":"disk"})).is_err());
        let c = api_call(
            "claim_incident",
            &json!({"id":"abcdefghijklmno","version":3,"claim_until":"2026-12-01T00:00:00Z"}),
        )
        .unwrap();
        assert_eq!(c.body.unwrap()["version"], 3);
    }
    #[test]
    fn disk_escalation_schema_preserves_typed_thresholds_and_rejects_invalid_bands() {
        let rule = json!({"name":"Disk","scope_type":"server","scope_id":"abcdefghijklmno","condition":{"metric":"host.disk_percent","operator":"gt","value":80,"critical_value":90,"disk_path":"*"},"severity":"warning","duration_seconds":0,"reminder_seconds":900,"enabled":true});
        for operator in ["gt", "gte"] {
            let mut rule = rule.clone();
            rule["condition"]["operator"] = json!(operator);
            let args = json!({"key":"disk","expected_version":0,"rule":rule});
            assert!(validate("save_alert_rule", &args).is_ok());
            assert!(validate("simulate_alert_rule", &json!({"rule":args["rule"]})).is_ok());
            assert_eq!(api_call("save_alert_rule", &args).unwrap().body.unwrap()["condition"]["critical_value"], 90);
        }
        for critical in [json!(80), json!(79), json!(100.1), json!("90"), Value::Null] {
            let mut invalid = rule.clone();
            invalid["condition"]["critical_value"] = critical;
            assert!(validate("simulate_alert_rule", &json!({"rule":invalid})).is_err());
        }
        for (field, value) in [("metric", "container.memory_percent"), ("operator", "lt")] {
            let mut invalid = rule.clone();
            invalid["condition"][field] = json!(value);
            assert!(validate("simulate_alert_rule", &json!({"rule":invalid})).is_err());
        }
        let mut invalid = rule.clone();
        invalid["severity"] = json!("critical");
        assert!(validate("simulate_alert_rule", &json!({"rule":invalid})).is_err());
        let mut legacy = rule;
        legacy["condition"].as_object_mut().unwrap().remove("critical_value");
        assert!(validate("simulate_alert_rule", &json!({"rule":legacy})).is_ok());
    }
    #[test]
    fn cpu_escalation_keeps_typed_thresholds_and_independent_confirmation_duration() {
        let rule = json!({"name":"CPU","scope_type":"server","scope_id":"abcdefghijklmno","condition":{"metric":"host.cpu_percent","operator":"gt","value":80,"critical_value":90},"severity":"warning","duration_seconds":300,"reminder_seconds":900,"enabled":true});
        let args = json!({"key":"cpu","expected_version":0,"rule":rule});
        assert!(validate("save_alert_rule", &args).is_ok());
        assert!(validate("simulate_alert_rule", &json!({"rule":args["rule"]})).is_ok());
        let body = api_call("save_alert_rule", &args).unwrap().body.unwrap();
        assert_eq!(body["condition"]["critical_value"], 90);
        assert_eq!(body["duration_seconds"], 300);
        for (field, value) in [("value", json!("80")), ("critical_value", json!("90")), ("critical_value", json!(80))] {
            let mut invalid = args.clone();
            invalid["rule"]["condition"][field] = value;
            assert!(validate("save_alert_rule", &invalid).is_err());
        }
        let mut invalid = args;
        invalid["rule"]["duration_seconds"] = json!("300");
        assert!(validate("save_alert_rule", &invalid).is_err());
    }
    #[test]
    fn memory_escalation_validates_both_actions_and_preserves_confirmation() {
        let rule = json!({"name":"Memory","scope_type":"server","scope_id":"abcdefghijklmno","condition":{"metric":"host.memory_percent","operator":"gt","value":80,"critical_value":90},"severity":"warning","duration_seconds":300,"reminder_seconds":900,"enabled":true});
        for operator in ["gt", "gte"] {
            let mut rule = rule.clone();
            rule["condition"]["operator"] = json!(operator);
            for tool in ["save_alert_rule", "simulate_alert_rule"] {
                let args = if tool == "save_alert_rule" { json!({"key":"memory","expected_version":0,"rule":rule}) } else { json!({"rule":rule}) };
                assert!(validate(tool, &args).is_ok());
                let body = api_call(tool, &args).unwrap().body.unwrap();
                assert_eq!(body["condition"]["metric"], "host.memory_percent");
                assert_eq!(body["condition"]["value"], 80);
                assert_eq!(body["condition"]["critical_value"], 90);
                assert_eq!(body["duration_seconds"], 300);
                for (field, value) in [("value", json!("80")), ("value", json!(-1)), ("critical_value", json!("90")), ("critical_value", json!(80)), ("critical_value", json!(101)), ("metric", json!("container.memory_percent")), ("operator", json!("lt"))] {
                    let mut invalid = args.clone();
                    invalid["rule"]["condition"][field] = value;
                    assert!(validate(tool, &invalid).is_err());
                }
                for (field, value) in [("severity", json!("critical")), ("duration_seconds", json!("300"))] {
                    let mut invalid = args.clone();
                    invalid["rule"][field] = value;
                    assert!(validate(tool, &invalid).is_err());
                }
            }
        }
    }

}

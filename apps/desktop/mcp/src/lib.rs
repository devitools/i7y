use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
pub mod tools;
pub mod transport;

pub const MAX_MESSAGE: usize = 262144;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.len() <= 120
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_- .".contains(&c))
        && !value.contains(' ')
}
pub fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}
pub fn socket_path() -> PathBuf {
    #[cfg(unix)]
    let identity = unsafe { libc::geteuid() }.to_string();
    #[cfg(not(unix))]
    let identity = "current-user".to_owned();
    let mode = if cfg!(debug_assertions) { "dev" } else { "app" };
    let installation=std::env::current_exe().ok().and_then(|path|path.parent().map(|parent|parent.to_string_lossy().into_owned())).unwrap_or_default();
    let scope=digest(&json!(installation));
    std::env::temp_dir()
        .join(format!("i7y-{identity}-{mode}-{}",&scope[..8]))
        .join("mcp.sock")
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub backend: String,
    pub organization: String,
    pub user: String,
    pub generation: u64,
}
#[derive(Clone, Serialize)]
pub struct Pending {
    pub id: String,
    pub connection: String,
    pub context: Context,
    pub tool: String,
    pub arguments: Value,
    pub expires_at: u64,
    pub state: String,
    pub result: Option<Value>,
    pub binding: String,
}
impl Pending {
    pub fn new(
        id: String,
        connection: String,
        context: Context,
        tool: String,
        arguments: Value,
        expiry: Option<u64>,
    ) -> Self {
        let binding = digest(&json!([context, tool, arguments]));
        Self {
            id,
            connection,
            context,
            tool,
            arguments,
            expires_at: expiry.unwrap_or(u64::MAX).min(now() + 300),
            state: "approval_required".into(),
            result: None,
            binding,
        }
    }
    pub fn valid(&self, context: &Context, time: u64) -> bool {
        self.state == "approval_required"
            && self.context == *context
            && self.expires_at > time
            && self.binding == digest(&json!([self.context, self.tool, self.arguments]))
    }
}
pub fn sanitize(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "credential",
                "password",
                "token",
                "token_hash",
                "env",
                "environment",
                "config",
                "stdout",
                "stderr",
                "raw_output",
            ] {
                map.remove(key);
            }
            for value in map.values_mut() {
                sanitize(value);
            }
        }
        Value::Array(items) => {
            for value in items {
                sanitize(value);
            }
        }
        _ => {}
    }
}
pub fn observations(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for child in map.values_mut() {
                observations(child);
            }
            if map.contains_key("id")
                && (map.contains_key("telemetry")
                    || map.contains_key("name")
                    || map.contains_key("observed_at"))
            {
                let timestamp = map
                    .get("observed_at")
                    .or_else(|| map.get("last_seen"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let normalized = timestamp.replace(' ', "T");
                let age = time::OffsetDateTime::parse(
                    &normalized,
                    &time::format_description::well_known::Rfc3339,
                )
                .ok()
                .map(|date| now().saturating_sub(date.unix_timestamp().max(0) as u64));
                let status = match age {
                    Some(age) if age > 900 => "stale",
                    Some(_) => "fresh",
                    None => "unknown",
                };
                let observation =
                    json!({"status":status,"observed_at":timestamp,"age_seconds":age});
                map.insert("observation".into(), observation);
            }
        }
        Value::Array(items) => {
            for child in items {
                observations(child);
            }
        }
        _ => {}
    }
}
#[cfg(unix)]
pub fn peer(stream: &std::os::unix::net::UnixStream) -> Result<u32, String> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    unsafe {
        let mut uid = 0;
        let mut gid = 0;
        if libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) != 0 || uid != libc::geteuid() {
            return Err("Local peer denied".into());
        }
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
        if libc::getsockopt(
            stream.as_raw_fd(),
            0,
            2,
            &mut pid as *mut _ as *mut _,
            &mut size,
        ) != 0
            || pid <= 0
        {
            return Err("Local peer identity unavailable".into());
        }
        Ok(pid as u32)
    }
    #[cfg(not(target_os = "macos"))]
    unsafe {
        let mut cred: libc::ucred = std::mem::zeroed();
        let mut size = std::mem::size_of_val(&cred) as libc::socklen_t;
        if libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut _,
            &mut size,
        ) != 0
            || cred.uid != libc::geteuid()
        {
            return Err("Local peer denied".into());
        }
        Ok(cred.pid as u32)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approvals_bind_context_and_expire() {
        let c = Context {
            backend: "https://example.test/".into(),
            organization: "org".into(),
            user: "user".into(),
            generation: 1,
        };
        let mut p = Pending::new(
            "one".into(),
            "client".into(),
            c.clone(),
            "save_alert_rule".into(),
            json!({"key":"disk"}),
            None,
        );
        assert!(p.valid(&c, now()));
        assert!(!p.valid(&c, p.expires_at));
        let mut other = c.clone();
        other.generation += 1;
        assert!(!p.valid(&other, now()));
        p.arguments["key"] = json!("other");
        assert!(!p.valid(&c, now()));
    }
    #[test]
    fn secrets_are_removed_recursively() {
        let mut v = json!({"server":{"credential":{"password":"secret"}},"token":"secret","items":[{"env":"secret","name":"ok"}]});
        sanitize(&mut v);
        assert!(!v.to_string().contains("secret"));
    }
    #[test]
    fn observation_age_does_not_confuse_retrieval_with_freshness() {
        let mut value = json!({"items":[{"id":"old","observed_at":"2000-01-01T00:00:00Z"},{"id":"unknown","name":"example"}]});
        observations(&mut value);
        assert_eq!(value["items"][0]["observation"]["status"], "stale");
        assert_eq!(value["items"][1]["observation"]["status"], "unknown");
    }
}

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Queued,
    Running,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub version: u8,
    pub operation_id: String,
    pub principal: String,
    pub action: String,
    pub target: String,
    pub parameters: Value,
    pub release: String,
    pub release_digest: String,
    pub resources: Vec<String>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Worker {
    pub pid: u32,
    pub identity: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub sequence: usize,
    pub time: u64,
    pub state: State,
    pub worker: Option<Worker>,
    pub detail: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    pub operation_id: String,
    pub state: State,
    pub events: Vec<Event>,
    pub reconciliation_required: bool,
    pub worker_observation: Option<String>,
}

pub struct Store {
    root: PathBuf,
}

pub fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| "Clock unavailable".into())
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err("Unsafe operation storage".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("Unable to create operation storage".into()),
            }
            let meta =
                fs::symlink_metadata(path).map_err(|_| "Unable to inspect operation storage")?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("Unsafe operation storage".into());
            }
        }
        Err(_) => return Err("Unable to inspect operation storage".into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map_err(|_| "Unable to inspect operation storage")?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err("Operation storage must be private".into());
        }
    }
    Ok(())
}
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Unable to sync operation storage".into())
}
fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Unable to create operation record".into())
}
fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    let pending = path.with_extension(format!("pending-{}", std::process::id()));
    let result = (|| {
        let mut file = private_file(&pending)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Unable to persist operation record")?;
        fs::hard_link(&pending, path)
            .map_err(|_| "Operation record already exists or cannot be published")?;
        sync_dir(path.parent().ok_or("Invalid operation path")?)
    })();
    let _ = fs::remove_file(pending);
    result
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Operation record unavailable")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return Err("Invalid operation record".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Operation record unavailable")?)
        .map_err(|_| "Invalid operation record".into())
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        directory(&root)?;
        for name in ["plans", "jobs", "locks", "preflight"] {
            directory(&root.join(name))?;
        }
        Ok(Self { root })
    }
    fn gate(&self) -> Result<File> {
        let path = self.root.join("gate");
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink() || !m.is_file())
            .unwrap_or(false)
        {
            return Err("Unsafe operation gate".into());
        }
        let file = options
            .open(path)
            .map_err(|_| "Unable to open operation gate")?;
        file.lock_exclusive()
            .map_err(|_| "Unable to lock operation gate")?;
        Ok(file)
    }
    fn path(&self, kind: &str, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err("Invalid operation ID".into());
        }
        Ok(self.root.join(kind).join(id))
    }
    pub fn prepare(&self, plan: &Plan) -> Result<String> {
        if plan.version != 1
            || !valid_id(&plan.principal)
            || plan.resources.len() > 16
            || plan.resources.iter().any(|r| r.len() > 4096)
        {
            return Err("Invalid operation plan".into());
        }
        let _gate = self.gate()?;
        let path = self.path("plans", &plan.operation_id)?;
        let bytes = serde_json::to_vec(plan).map_err(|_| "Invalid operation plan")?;
        if path.exists() {
            let saved: Plan = read(&path)?;
            if serde_json::to_vec(&saved).map_err(|_| "Invalid operation plan")? != bytes {
                return Err("Operation ID already belongs to another plan".into());
            }
        } else {
            publish(&path, &bytes)?;
        }
        Ok(digest(&bytes))
    }
    pub fn plan(&self, id: &str, principal: &str) -> Result<Plan> {
        let plan: Plan = read(&self.path("plans", id)?)?;
        if plan.principal != principal {
            return Err("Operation access denied".into());
        }
        Ok(plan)
    }
    pub fn submit(&self, id: &str, principal: &str, approval: &str) -> Result<bool> {
        let _gate = self.gate()?;
        let plan = self.plan(id, principal)?;
        if digest(&serde_json::to_vec(&plan).map_err(|_| "Invalid operation plan")?) != approval {
            return Err("Plan approval does not match".into());
        }
        let job = self.path("jobs", id)?;
        if job.exists() {
            self.events(id)?;
            return Ok(false);
        }
        if plan.expires_at <= now()? {
            return Err("Plan expired; create a new plan".into());
        }
        let mut resources = plan.resources.clone();
        resources.sort();
        resources.dedup();
        let paths: Vec<_> = resources
            .iter()
            .map(|r| self.root.join("locks").join(digest(r.as_bytes())))
            .collect();
        if paths.iter().any(|p| p.exists()) {
            return Err("Operation resource is locked".into());
        }
        let mut acquired = Vec::new();
        for path in &paths {
            if let Err(error) = publish(path, id.as_bytes()) {
                for path in acquired {
                    let _ = fs::remove_file(path);
                }
                return Err(error);
            }
            acquired.push(path.clone());
        }
        if let Err(error) = directory(&job)
            .and_then(|_| sync_dir(&self.root.join("jobs")))
            .and_then(|_| self.append(id, State::Queued, None, None))
        {
            for path in acquired {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        Ok(true)
    }
    fn events(&self, id: &str) -> Result<Vec<Event>> {
        let path = self.path("jobs", id)?;
        let mut events = Vec::new();
        for sequence in 0..16 {
            let event_path = path.join(format!("{sequence:04}.json"));
            if !event_path.exists() {
                break;
            }
            let event: Event = read(&event_path)?;
            if event.sequence != sequence {
                return Err("Operation journal is inconsistent".into());
            }
            events.push(event);
        }
        if events.is_empty() {
            return Err("Operation has no durable status; reconciliation required".into());
        }
        Ok(events)
    }
    fn append(
        &self,
        id: &str,
        state: State,
        worker: Option<Worker>,
        detail: Option<String>,
    ) -> Result<()> {
        let path = self.path("jobs", id)?;
        let events = self.events(id).unwrap_or_default();
        let previous = events.last().map(|e| &e.state);
        let allowed = matches!(
            (previous, &state),
            (None, State::Queued)
                | (Some(State::Queued), State::Running)
                | (Some(State::Queued), State::Failed)
                | (Some(State::Running), State::Succeeded)
                | (Some(State::Running), State::Failed)
        );
        if !allowed {
            return Err("Invalid operation transition".into());
        }
        let event = Event {
            sequence: events.len(),
            time: now()?,
            state,
            worker,
            detail,
        };
        publish(
            &path.join(format!("{:04}.json", event.sequence)),
            &serde_json::to_vec(&event).map_err(|_| "Unable to encode operation event")?,
        )
    }
    pub fn claim(&self, id: &str, principal: &str, worker: Worker) -> Result<Plan> {
        let _gate = self.gate()?;
        let plan = self.plan(id, principal)?;
        if self.events(id)?.last().map(|e| &e.state) != Some(&State::Queued) {
            return Err("Operation already claimed".into());
        }
        self.append(id, State::Running, Some(worker), None)?;
        Ok(plan)
    }
    pub fn finish(
        &self,
        id: &str,
        principal: &str,
        success: bool,
        detail: Option<String>,
    ) -> Result<()> {
        let _gate = self.gate()?;
        let plan = self.plan(id, principal)?;
        self.append(
            id,
            if success {
                State::Succeeded
            } else {
                State::Failed
            },
            None,
            detail,
        )?;
        if success {
            let mut resources = plan.resources;
            resources.sort();
            resources.dedup();
            for resource in resources {
                let path = self.root.join("locks").join(digest(resource.as_bytes()));
                if fs::read(&path).map_err(|_| "Resource lock unavailable")? != id.as_bytes() {
                    return Err("Resource lock owner mismatch".into());
                }
                fs::remove_file(path).map_err(|_| "Unable to release operation resource")?;
            }
            sync_dir(&self.root.join("locks"))?;
        }
        Ok(())
    }
    pub fn launch_failed(&self, id: &str, principal: &str) -> Result<()> {
        let _gate = self.gate()?;
        self.plan(id, principal)?;
        self.append(id, State::Failed, None, Some("worker_launch_failed".into()))
    }
    pub fn status(
        &self,
        id: &str,
        principal: &str,
        alive: impl Fn(&Worker) -> Option<bool>,
    ) -> Result<Status> {
        let _gate = self.gate()?;
        let plan = self.plan(id, principal)?;
        let events = self.events(id)?;
        let latest = events.last().ok_or("Operation journal unavailable")?;
        let mut state = latest.state.clone();
        let observation = if state == State::Running {
            latest.worker.as_ref().and_then(alive)
        } else {
            None
        };
        let worker_observation = if state == State::Running {
            Some(
                match observation {
                    Some(true) => "alive",
                    Some(false) => "exited",
                    None => "unknown",
                }
                .into(),
            )
        } else {
            None
        };
        if state == State::Running && observation == Some(false) {
            state = State::Interrupted;
        }
        let uncertain_worker = state == State::Running && observation.is_none();
        let retained_locks = state == State::Succeeded
            && plan.resources.iter().any(|resource| {
                fs::read(self.root.join("locks").join(digest(resource.as_bytes())))
                    .map(|owner| owner == id.as_bytes())
                    .unwrap_or(false)
            });
        let stalled_queue = state == State::Queued && now()?.saturating_sub(latest.time) > 30;
        let reconciliation_required = matches!(state, State::Failed | State::Interrupted)
            || uncertain_worker
            || retained_locks
            || stalled_queue;
        Ok(Status {
            operation_id: id.into(),
            state,
            events,
            reconciliation_required,
            worker_observation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "i7y-store-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            directory(&root).unwrap();
            Self(root)
        }
        fn store(&self) -> Store {
            Store::open(self.0.clone()).unwrap()
        }
        fn plan(&self, id: &str) -> Plan {
            Plan {
                version: 1,
                operation_id: id.into(),
                principal: "operator01".into(),
                action: "project.copy".into(),
                target: "project01".into(),
                parameters: serde_json::json!({}),
                release: "test-v1".into(),
                release_digest: "digest".into(),
                resources: vec![
                    "host/web01".into(),
                    "host/web01/domain/new.example.com".into(),
                ],
                expires_at: now().unwrap() + 600,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn journal_is_durable_and_transitions_are_validated() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let plan = fixture.plan("durable");
        let approval = store.prepare(&plan).unwrap();
        assert!(store.submit("durable", "operator01", &approval).unwrap());
        assert!(store.finish("durable", "operator01", true, None).is_err());
        store
            .claim(
                "durable",
                "operator01",
                Worker {
                    pid: 10,
                    identity: "start-1".into(),
                },
            )
            .unwrap();
        assert!(store
            .claim(
                "durable",
                "operator01",
                Worker {
                    pid: 11,
                    identity: "start-2".into()
                }
            )
            .is_err());
        store.finish("durable", "operator01", true, None).unwrap();
        drop(store);
        let reopened = fixture.store();
        let status = reopened
            .status("durable", "operator01", |_| Some(false))
            .unwrap();
        assert_eq!(status.state, State::Succeeded);
        assert_eq!(status.events.len(), 3);
        assert!(!status.reconciliation_required);
        assert!(!reopened.submit("durable", "operator01", &approval).unwrap());
        assert!(reopened
            .finish("durable", "operator01", false, None)
            .is_err());
    }
    #[test]
    fn expiry_approval_and_principal_are_enforced_before_submission() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let mut plan = fixture.plan("expired");
        plan.expires_at = now().unwrap() - 1;
        let approval = store.prepare(&plan).unwrap();
        assert!(store.submit("expired", "operator01", &approval).is_err());
        assert!(store.submit("expired", "operator02", &approval).is_err());
        assert!(store.submit("expired", "operator01", "wrong").is_err());
        assert_eq!(fs::read_dir(fixture.0.join("jobs")).unwrap().count(), 0);
    }
    #[test]
    fn shared_resources_lock_different_project_ids_and_keep_locks_after_failure() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = fixture.plan("one");
        let mut second = fixture.plan("two");
        second.target = "another-project".into();
        let one = store.prepare(&first).unwrap();
        let two = store.prepare(&second).unwrap();
        store.submit("one", "operator01", &one).unwrap();
        assert!(store.submit("two", "operator01", &two).is_err());
        store
            .claim(
                "one",
                "operator01",
                Worker {
                    pid: 10,
                    identity: "start-1".into(),
                },
            )
            .unwrap();
        let status = store.status("one", "operator01", |_| Some(false)).unwrap();
        assert_eq!(status.state, State::Interrupted);
        assert!(status.reconciliation_required);
        store
            .finish("one", "operator01", false, Some("recipe_failed".into()))
            .unwrap();
        assert!(store.submit("two", "operator01", &two).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuse_public_or_symlinked_operation_storage() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = Fixture::new();
        let target = fixture.0.join("target");
        directory(&target).unwrap();
        symlink(&target, fixture.0.join("linked")).unwrap();
        assert!(Store::open(fixture.0.join("linked")).is_err());
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Store::open(target).is_err());
    }
    #[test]
    fn uncertain_worker_observation_is_not_reported_as_process_exit() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let plan = fixture.plan("uncertain");
        let approval = store.prepare(&plan).unwrap();
        store.submit("uncertain", "operator01", &approval).unwrap();
        store
            .claim(
                "uncertain",
                "operator01",
                Worker {
                    pid: 10,
                    identity: "start-1".into(),
                },
            )
            .unwrap();
        let status = store.status("uncertain", "operator01", |_| None).unwrap();
        assert_eq!(status.state, State::Running);
        assert_eq!(status.worker_observation.as_deref(), Some("unknown"));
        assert!(status.reconciliation_required);
        assert_eq!(status.events.len(), 2);
    }
}

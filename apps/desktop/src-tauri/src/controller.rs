use i7y_core::ssh::{self, ControllerProfile, Diagnostic, SshError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::Manager;

#[derive(Serialize)]
pub struct ControllerSettings {
    profile: Option<ControllerProfile>,
    default_identity_file: String,
    host_fingerprint: Option<String>,
    identity_fingerprint: Option<String>,
    execution_enabled: bool,
}

fn directory(app: &tauri::AppHandle, state: &crate::backend::Backend) -> Result<PathBuf, SshError> {
    let backend = state
        .url
        .lock()
        .map_err(|_| SshError::LocalStorageFailed)?
        .clone()
        .ok_or(SshError::InvalidProfile)?;
    let key = format!("{:x}", Sha256::digest(backend.as_str().as_bytes()));
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| SshError::LocalStorageFailed)?
        .join("controllers")
        .join(key))
}

fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), SshError> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| SshError::LocalStorageFailed)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| SshError::LocalStorageFailed)
}

fn read_profile(path: &std::path::Path) -> Result<Option<ControllerProfile>, SshError> {
    match fs::read(path) {
        Ok(bytes) => {
            let mut profile: ControllerProfile =
                serde_json::from_slice(&bytes).map_err(|_| SshError::InvalidProfile)?;
            if profile.identity_file.is_empty() {
                let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or(SshError::InvalidProfile)?;
                let expected = ssh::canonical_key(&profile.public_key)?;
                for entry in fs::read_dir(PathBuf::from(home).join(".ssh")).map_err(|_| SshError::InvalidProfile)? {
                    let entry = entry.map_err(|_| SshError::InvalidProfile)?;
                    let public = entry.path();
                    if public.extension().and_then(|v| v.to_str()) != Some("pub") { continue; }
                    let identity = public.with_extension("");
                    if identity.is_file() && fs::read_to_string(&public).ok().and_then(|value| ssh::canonical_key(&value).ok()).as_ref() == Some(&expected) {
                        profile.identity_file = identity.to_string_lossy().to_string();
                        break;
                    }
                }
                if profile.identity_file.is_empty() { return Err(SshError::InvalidProfile); }
            }
            profile.validate()?;
            Ok(Some(profile))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SshError::LocalStorageFailed),
    }
}

#[tauri::command]
pub fn controller_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
) -> Result<ControllerSettings, SshError> {
    let profile = read_profile(&directory(&app, &state)?.join("profile.json"))?;
    let identity = app.path().home_dir().map_err(|_| SshError::LocalStorageFailed)?
        .join(".ssh/id_ed25519").to_string_lossy().to_string();
    Ok(ControllerSettings {
        host_fingerprint: profile
            .as_ref()
            .map(|p| ssh::fingerprint(&p.host_key))
            .transpose()?,
        identity_fingerprint: profile
            .as_ref()
            .map(|p| ssh::fingerprint(&p.public_key))
            .transpose()?,
        profile,
        default_identity_file: identity,
        execution_enabled: false,
    })
}

#[tauri::command]
pub fn save_controller_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
    mut profile: ControllerProfile,
    host_key_reviewed: bool,
) -> Result<(), SshError> {
    if !host_key_reviewed {
        return Err(SshError::HostKeyMismatch);
    }
    profile.public_key = ssh::canonical_key(&fs::read_to_string(format!("{}.pub", profile.identity_file)).map_err(|_| SshError::InvalidPublicKey)?)?;
    profile.host_key = ssh::canonical_key(&profile.host_key)?;
    profile.validate()?;
    let path = directory(&app, &state)?;
    fs::create_dir_all(&path).map_err(|_| SshError::LocalStorageFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| SshError::LocalStorageFailed)?;
    }
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|_| SshError::LocalStorageFailed)?;
    let temporary = path.join("profile.pending");
    private_write(&temporary, &bytes)?;
    fs::rename(temporary, path.join("profile.json")).map_err(|_| SshError::LocalStorageFailed)?;
    Ok(())
}

#[tauri::command]
pub async fn diagnose_controller(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::backend::Backend>,
    mut profile: ControllerProfile,
    host_key_reviewed: bool,
) -> Result<Diagnostic, SshError> {
    if !host_key_reviewed {
        return Err(SshError::HostKeyMismatch);
    }
    profile.public_key = ssh::canonical_key(&fs::read_to_string(format!("{}.pub", profile.identity_file)).map_err(|_| SshError::InvalidPublicKey)?)?;
    profile.host_key = ssh::canonical_key(&profile.host_key)?;
    profile.validate()?;
    let path = directory(&app, &state)?;
    fs::create_dir_all(&path).map_err(|_| SshError::LocalStorageFailed)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SshError::LocalStorageFailed)?
        .as_nanos();
    let temporary = path.join(format!("diagnostic-{nonce}"));
    fs::create_dir(&temporary).map_err(|_| SshError::LocalStorageFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
            .map_err(|_| SshError::LocalStorageFailed)?;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let identity = temporary.join("identity.pub");
            let known_hosts = temporary.join("known_hosts");
            private_write(&identity, profile.public_key.as_bytes())?;
            private_write(&known_hosts, profile.known_host_entry()?.as_bytes())?;
            ssh::diagnose(&profile, &identity, &known_hosts)
        })();
        let _ = fs::remove_dir_all(temporary);
        result
    })
    .await
    .map_err(|_| SshError::ConnectionFailed)?;
    result
}

pub(crate) async fn exchange_request(
    app: tauri::AppHandle,
    organization: String,
    request: i7y_core::operations::Request,
    guard: Option<crate::mcp::RequestGuard>,
) -> Result<serde_json::Value, i7y_core::operations::Error> {
    use i7y_core::operations::{self, Error, Scope};
    request.validate()?;
    if let Some(guard) = &guard { guard.check(&app).map_err(|_| Error::ScopeMismatch)?; }
    let generation = app.state::<crate::mcp::Service>().inner.lock().map_err(|_| Error::ScopeMismatch)?.generation;
    let lock_epoch = crate::platform::lock_epoch();
    let state = app.state::<crate::backend::Backend>();
    let backend = state
        .url
        .lock()
        .map_err(|_| SshError::LocalStorageFailed)?
        .clone()
        .ok_or(SshError::InvalidProfile)?;
    let path = directory(&app, &state)?;
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SshError::LocalStorageFailed)?
        .as_nanos();
    let temporary = path.join(format!("executor-{nonce}"));
    fs::create_dir(&temporary).map_err(|_| SshError::LocalStorageFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))
            .map_err(|_| SshError::LocalStorageFailed)?;
    }
    let scope = Scope {
        backend: backend.to_string(),
        organization,
    };
    let worker_app = app.clone();
    let worker_guard = guard.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let identity = temporary.join("identity.pub");
            let known_hosts = temporary.join("known_hosts");
            private_write(&identity, profile.public_key.as_bytes())?;
            private_write(&known_hosts, profile.known_host_entry()?.as_bytes())?;
            if crate::platform::locked() || crate::platform::lock_epoch() != lock_epoch
                || worker_app.state::<crate::mcp::Service>().inner.lock().map_err(|_| Error::ScopeMismatch)?.generation != generation {
                return Err(Error::ScopeMismatch);
            }
            if let Some(guard) = &worker_guard {
                if request.is_submission() { guard.dispatch(&worker_app) } else { guard.check(&worker_app) }
                    .map_err(|_| Error::ScopeMismatch)?;
            }
            operations::exchange(&profile, &identity, &known_hosts, scope, request)
        })();
        let _ = fs::remove_dir_all(temporary);
        result
    })
    .await
    .map_err(|_| Error::Transport(SshError::ConnectionFailed))?;
    if state
        .url
        .lock()
        .map_err(|_| SshError::LocalStorageFailed)?
        .as_ref()
        != Some(&backend)
    {
        return Err(Error::ScopeMismatch);
    }
    if crate::platform::locked() || crate::platform::lock_epoch() != lock_epoch
        || app.state::<crate::mcp::Service>().inner.lock().map_err(|_| Error::ScopeMismatch)?.generation != generation {
        return Err(Error::ScopeMismatch);
    }
    if let Some(guard) = &guard { guard.check(&app).map_err(|_| Error::ScopeMismatch)?; }
    result
}

#[tauri::command]
pub async fn controller_request(
    app: tauri::AppHandle,
    organization: String,
    request: i7y_core::operations::Request,
) -> Result<serde_json::Value, i7y_core::operations::Error> {
    if request.is_submission() {
        return Err(i7y_core::operations::Error::ExecutionDisabled);
    }
    exchange_request(app, organization, request, None).await
}

#[tauri::command]
pub async fn ping_server(app: tauri::AppHandle, state: tauri::State<'_, crate::backend::Backend>, address: String, port: u16) -> Result<bool, SshError> {
    let path = directory(&app, &state)?;
    let profile = read_profile(&path.join("profile.json"))?.ok_or(SshError::InvalidProfile)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| SshError::LocalStorageFailed)?.as_nanos();
    let temporary = path.join(format!("ping-{nonce}"));
    fs::create_dir(&temporary).map_err(|_| SshError::LocalStorageFailed)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let known_hosts = temporary.join("known_hosts");
            private_write(&known_hosts, profile.known_host_entry()?.as_bytes())?;
            ssh::ansible_ping(&profile, &known_hosts, &address, port)
        })();
        let _ = fs::remove_dir_all(temporary);
        result
    }).await.map_err(|_| SshError::ConnectionFailed)?;
    result
}

use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationError {
    Cancelled,
    Unavailable,
    Failed,
}
pub trait LocalAuthorizer: Send + Sync {
    fn authorize(&self, request_id: &str, summary: &str) -> Result<(), AuthorizationError>;
}
pub struct SystemAuthorizer;
#[cfg(target_os = "windows")]
pub struct WindowsHelloAuthorizer;
#[cfg(target_os = "windows")]
impl LocalAuthorizer for WindowsHelloAuthorizer {
    fn authorize(&self, _request_id: &str, _summary: &str) -> Result<(), AuthorizationError> {
        Err(AuthorizationError::Unavailable)
    }
}
#[cfg(target_os = "macos")]
extern "C" {
    fn i7y_auth(reason: *const std::ffi::c_char, request: *const std::ffi::c_char) -> i32;
    fn i7y_auth_window_set(window: *mut std::ffi::c_void, request: *const std::ffi::c_char);
    fn i7y_auth_cancel(request: *const std::ffi::c_char);
    fn i7y_locked() -> i32;
    fn i7y_lock_epoch() -> u64;
    fn i7y_secret_read(account: *const std::ffi::c_char) -> *mut std::ffi::c_char;
    fn i7y_secret_write(account: *const std::ffi::c_char, value: *const std::ffi::c_char) -> i32;
    fn i7y_verify_peer(pid: i32, expected: *const std::ffi::c_char, development: i32) -> i32;
}
impl LocalAuthorizer for SystemAuthorizer {
    fn authorize(&self, _request_id: &str, summary: &str) -> Result<(), AuthorizationError> {
        #[cfg(target_os = "macos")]
        {
            let text = std::ffi::CString::new(summary).map_err(|_| AuthorizationError::Failed)?;
            let request = std::ffi::CString::new(_request_id).map_err(|_| AuthorizationError::Failed)?;
            match unsafe { i7y_auth(text.as_ptr(), request.as_ptr()) } {
                0 => Ok(()),
                1 => Err(AuthorizationError::Cancelled),
                2 => Err(AuthorizationError::Unavailable),
                _ => Err(AuthorizationError::Failed),
            }
        }
        #[cfg(target_os = "windows")]
        {
            WindowsHelloAuthorizer.authorize(_request_id, summary)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = summary;
            Err(AuthorizationError::Unavailable)
        }
    }
}
pub trait SecretStore {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, value: Option<&str>) -> Result<(), String>;
}
pub struct SystemSecretStore;
impl SecretStore for SystemSecretStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            let key = std::ffi::CString::new(account).map_err(|_| "Invalid account")?;
            let pointer = unsafe { i7y_secret_read(key.as_ptr()) };
            if pointer.is_null() {
                return Ok(None);
            }
            let result = unsafe { std::ffi::CStr::from_ptr(pointer) }
                .to_string_lossy()
                .into_owned();
            unsafe { libc::free(pointer as *mut _) };
            Ok(Some(result))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = account;
            Ok(None)
        }
    }
    fn write(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let key = std::ffi::CString::new(account).map_err(|_| "Invalid account")?;
            let value = value
                .map(std::ffi::CString::new)
                .transpose()
                .map_err(|_| "Invalid session")?;
            if unsafe {
                i7y_secret_write(
                    key.as_ptr(),
                    value
                        .as_ref()
                        .map(|v| v.as_ptr())
                        .unwrap_or(std::ptr::null()),
                )
            } == 0
            {
                Ok(())
            } else {
                Err("Unable to persist secure session".into())
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (account, value);
            Ok(())
        }
    }
}
pub fn locked() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { i7y_locked() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
pub fn lock_epoch()->u64 {
    #[cfg(target_os="macos")]{unsafe{i7y_lock_epoch()}}
    #[cfg(not(target_os="macos"))]{0}
}
pub fn verify_peer(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = std::env::current_exe()
            .map_err(|_| "Application path unavailable")?
            .with_file_name("i7y-mcp");
        let expected = std::ffi::CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "Invalid connector path")?;
        if unsafe {
            i7y_verify_peer(
                pid as i32,
                expected.as_ptr(),
                i32::from(cfg!(debug_assertions)),
            )
        } == 0
        {
            Ok(())
        } else {
            Err("Connector signature or path is not trusted".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        Err("Local peer verification unavailable".into())
    }
}

pub fn authentication_window(window: Option<&tauri::WebviewWindow>, request: Option<&str>) {
    #[cfg(target_os = "macos")]
    {
        let pointer = window.and_then(|w| w.ns_window().ok()).unwrap_or(std::ptr::null_mut());
        let identifier = request.and_then(|id| std::ffi::CString::new(id).ok());
        unsafe { i7y_auth_window_set(pointer, identifier.as_ref().map(|id| id.as_ptr()).unwrap_or(std::ptr::null())) };
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, request);
}
pub fn cancel_authentication(request: &str) {
    #[cfg(target_os = "macos")]
    if let Ok(identifier) = std::ffi::CString::new(request) {
        unsafe { i7y_auth_cancel(identifier.as_ptr()) };
    }
    #[cfg(not(target_os = "macos"))]
    let _ = request;
}

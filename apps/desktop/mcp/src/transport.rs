use std::io::{Read, Write};

#[cfg(target_os = "macos")]
extern "C" {
    fn i7y_mcp_verify_desktop(pid: i32, expected: *const std::ffi::c_char, development: i32)
        -> i32;
}

#[cfg(target_os = "macos")]
fn verify_desktop_identity(
    pid: u32,
    expected: &std::path::Path,
    development: bool,
) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let pid = i32::try_from(pid).map_err(|_| "Desktop peer identity unavailable")?;
    let expected = std::ffi::CString::new(expected.as_os_str().as_bytes())
        .map_err(|_| "Invalid desktop path")?;
    if unsafe { i7y_mcp_verify_desktop(pid, expected.as_ptr(), i32::from(development)) } == 0 {
        Ok(())
    } else {
        Err("Desktop peer signature or path is not trusted".into())
    }
}

#[cfg(unix)]
fn verify_desktop_peer(stream: &std::os::unix::net::UnixStream) -> Result<(), String> {
    let pid = crate::peer(stream)?;
    #[cfg(target_os = "macos")]
    {
        let expected = std::env::current_exe()
            .map_err(|_| "Connector path unavailable")?
            .with_file_name("i7y-desktop");
        verify_desktop_identity(pid, &expected, cfg!(debug_assertions))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        Err("Desktop peer identity verification is unavailable on this platform".into())
    }
}

pub trait LocalTransport {
    type Stream: Read + Write;
    fn connect() -> Result<Self::Stream, String>;
}
#[cfg(unix)]
pub struct UnixSocketTransport;
#[cfg(unix)]
impl LocalTransport for UnixSocketTransport {
    type Stream = std::os::unix::net::UnixStream;
    fn connect() -> Result<Self::Stream, String> {
        let stream = Self::Stream::connect(crate::socket_path())
            .map_err(|_| "Open i7y desktop and enable MCP before connecting")?;
        verify_desktop_peer(&stream)?;
        Ok(stream)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn same_user_socket_server_is_not_automatically_trusted() {
        let (client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(crate::peer(&client).unwrap(), std::process::id());
        assert!(verify_desktop_peer(&client).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn development_identity_requires_the_exact_running_executable() {
        let current = std::env::current_exe().unwrap();
        assert!(verify_desktop_identity(std::process::id(), &current, true).is_ok());
        assert!(verify_desktop_identity(
            std::process::id(),
            &current.with_file_name("i7y-desktop"),
            true
        )
        .is_err());
        assert!(verify_desktop_identity(0, &current, true).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn release_identity_does_not_accept_a_path_only_match() {
        let current = std::env::current_exe().unwrap();
        assert!(verify_desktop_identity(std::process::id(), &current, false).is_err());
    }
}
#[cfg(windows)]
pub struct WindowsNamedPipeTransport;
#[cfg(windows)]
impl LocalTransport for WindowsNamedPipeTransport {
    type Stream = std::fs::File;
    fn connect() -> Result<Self::Stream, String> {
        Err("Windows named-pipe identity verification is not available yet".into())
    }
}

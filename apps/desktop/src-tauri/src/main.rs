#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approvals;
mod backend;
mod controller;
mod mcp;
mod operational;
mod platform;
mod session;
use tauri::Manager;

#[tauri::command]
fn open_browser_login(
    state: tauri::State<'_, backend::Backend>,
    request: String,
    challenge: String,
) -> Result<(), String> {
    if request.len() != 64
        || challenge.len() != 64
        || !request
            .chars()
            .chain(challenge.chars())
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("Invalid desktop request".into());
    }
    let mut target = state
        .url
        .lock()
        .map_err(|_| "Unable to read backend settings")?
        .clone()
        .ok_or("Select a backend first")?;
    target.set_fragment(Some(&format!(
        "/desktop-authorize?request={request}&challenge={challenge}"
    )));
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open")
        .arg(target.as_str())
        .status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", target.as_str()])
        .status();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(target.as_str())
        .status();
    match result {
        Ok(status) if status.success() => Ok(()),
        _ => Err("Unable to open the browser".into()),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(mcp::Service::default());
            app.manage(approvals::State::default());
            let url = backend::load(app.handle());
            app.manage(backend::Backend {
                url: std::sync::Mutex::new(url),
                client: backend::client()?,
            });
            mcp::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "mcp-approval" {
                    api.prevent_close();
                    let _ = window.hide();
                    approvals::cancel_active(window.app_handle());
                } else if window.label() == "main" {
                    let keep_running = cfg!(target_os = "macos") || window.state::<mcp::Service>().inner.lock().map(|s| s.enabled).unwrap_or(false);
                    if keep_running {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            approvals::mcp_approval_current,
            approvals::mcp_approval_decide,
            approvals::mcp_approval_layout,
            open_browser_login,
            session::desktop_session_restore,
            session::desktop_session_clear,
            session::desktop_session_context,
            mcp::mcp_overview,
            mcp::mcp_enable,
            mcp::mcp_revoke,
            mcp::mcp_decide,
            mcp::desktop_tool_call,
            backend::get_backend,
            backend::set_backend,
            backend::backend_request,
            controller::controller_settings,
            controller::save_controller_settings,
            controller::diagnose_controller,
            controller::ping_server,
            controller::controller_request
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build the i7y desktop application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

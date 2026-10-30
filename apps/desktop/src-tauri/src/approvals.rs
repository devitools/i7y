use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct State {
    active: Mutex<Option<String>>,
}

fn active(app: &tauri::AppHandle) -> Option<String> {
    app.state::<State>().active.lock().ok()?.clone()
}

fn window_height(reading: bool, expanded: bool, technical: bool) -> f64 {
    let base = if reading { 390.0 } else { 460.0 };
    base + if expanded { if reading { 180.0 } else { 220.0 } } else { 0.0 } + if expanded && technical { 100.0 } else { 0.0 }
}

pub fn synchronize(app: &tauri::AppHandle) {
    if !cfg!(target_os = "macos") { return; }
    let next = crate::mcp::next_approval(app);
    let state = app.state::<State>();
    let Ok(mut current) = state.active.lock() else { return };
    if *current == next {
        return;
    }
    let previous = current.clone();
    *current = next.clone();
    drop(current);
    if let Some(id) = previous { crate::platform::cancel_authentication(&id); }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if active(&handle) != next {
            return;
        }
        if next.is_none() {
            crate::platform::authentication_window(None, None);
            if let Some(window) = handle.get_webview_window("mcp-approval") {
                let _ = window.hide();
            }
            return;
        }
        let window = if let Some(window) = handle.get_webview_window("mcp-approval") {
            window
        } else {
            let Ok(window) = tauri::WebviewWindowBuilder::new(
                &handle,
                "mcp-approval",
                tauri::WebviewUrl::App("approval.html".into()),
            )
            .title("i7y — Access request")
            .inner_size(400.0, 390.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .center()
            .build() else { return };
            window
        };
        let reading = next.as_ref().and_then(|id| crate::mcp::approval_view(&handle, id).ok()).map(|v| v["request"]["tool"] == "authorize_connection").unwrap_or(false);
        let _ = window.set_size(tauri::LogicalSize::new(400.0, window_height(reading, false, false)));
        let _ = window.center();
        crate::platform::authentication_window(Some(&window), next.as_deref());
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    });
}

#[tauri::command]
pub fn mcp_approval_layout(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    expanded: bool,
    technical: bool,
) -> Result<(), String> {
    if window.label() != "mcp-approval" || active(&app).as_deref() != Some(&request_id) {
        return Err("Access request changed".into());
    }
    let detail = crate::mcp::approval_view(&app, &request_id)?;
    let reading = detail["request"]["tool"] == "authorize_connection";
    let height = window_height(reading, expanded, technical);
    let height = match window.current_monitor() {
        Ok(Some(monitor)) => height.min(monitor.work_area().size.height as f64 / monitor.scale_factor() - 32.0),
        _ => height,
    };
    window.set_size(tauri::LogicalSize::new(400.0, height))
        .map_err(|_| "Unable to resize access request".to_string())?;
    window.center().map_err(|_| "Unable to position access request".to_string())
}

pub fn cancel_active(app: &tauri::AppHandle) {
    if let Some(id) = active(app) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::mcp::mcp_decide(handle, id, false).await;
        });
    }
}

#[tauri::command]
pub fn mcp_approval_current(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    if window.label() != "mcp-approval" {
        return Err("Approval window required".into());
    }
    match active(&app) {
        Some(id) => crate::mcp::approval_view(&app, &id),
        None => Ok(json!(null)),
    }
}

#[tauri::command]
pub async fn mcp_approval_decide(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    if window.label() != "mcp-approval" || active(&app).as_deref() != Some(&request_id) {
        return Err("Access request changed".into());
    }
    crate::mcp::mcp_decide(app, request_id, approve).await
}

use tauri::{AppHandle, Emitter, Manager, State};

use crate::autostart;
use crate::config::{self, Anchor, AppConfig, NewTool, PlaceholderSpec, StyleSettings, ToolItem};
use crate::host::TauriHost;
use crate::paths::detect_git_bash;
use crate::runner::{RunContext, RunOutput};
use crate::state::{self, AppState};
use crate::template::{self, has_placeholders};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub config: AppConfig,
    pub warning: Option<String>,
    pub config_path: String,
    pub git_bash_detected: Option<String>,
    pub git_bash_error: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub autostart: bool,
    pub git_bash_path: Option<String>,
}

#[tauri::command]
pub fn get_snapshot(state: State<'_, AppState>) -> AppSnapshot {
    build_snapshot(&state)
}

#[tauri::command]
pub fn add_bucket(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let mut config = state::lock(&state.config).clone();
    config.add_bucket(&name).map_err(|err| err.to_string())?;
    commit(&app, &state, config)
}

#[tauri::command]
pub fn add_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    tool: NewTool,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let item = tool.into_item().map_err(|err| err.to_string())?;
    let mut config = state::lock(&state.config).clone();
    config
        .add_item(&bucket_id, item)
        .map_err(|err| err.to_string())?;
    commit(&app, &state, config)
}

#[tauri::command]
pub fn update_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    item_id: String,
    tool: NewTool,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let mut item = tool.into_item().map_err(|err| err.to_string())?;
    item.id = item_id.clone();
    let mut config = state::lock(&state.config).clone();
    config
        .update_item(&bucket_id, &item_id, item)
        .map_err(|err| err.to_string())?;
    commit(&app, &state, config)
}

#[tauri::command]
pub fn remove_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    item_id: String,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let mut config = state::lock(&state.config).clone();
    config
        .remove_item(&bucket_id, &item_id)
        .map_err(|err| err.to_string())?;
    commit(&app, &state, config)
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SettingsUpdate,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let git_bash_path = blank_to_none(settings.git_bash_path);
    if let Some(path) = git_bash_path.as_deref() {
        detect_git_bash(Some(path))?;
    }
    autostart::apply(&app, settings.autostart)?;
    let mut config = state::lock(&state.config).clone();
    config.autostart = settings.autostart;
    config.git_bash_path = git_bash_path;
    let _ = state.autostart_item.set_checked(settings.autostart);
    commit(&app, &state, config)
}

#[tauri::command]
pub fn update_style(
    app: AppHandle,
    state: State<'_, AppState>,
    style: StyleSettings,
) -> Result<AppSnapshot, String> {
    ensure_writable(&state)?;
    let mut config = state::lock(&state.config).clone();
    config.style = style.normalized();
    commit(&app, &state, config)
}

#[tauri::command]
pub fn set_shell_bounds(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
) -> Result<(), String> {
    if !(x.is_finite() && y.is_finite() && width.is_finite() && height.is_finite())
        || width < 1.0
        || height < 1.0
    {
        return Err("窗口尺寸无效".into());
    }
    apply_shell_bounds(&window, x, y, width, height, preserve_client)?;
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn cursor_position(window: tauri::WebviewWindow) -> Result<CursorPoint, String> {
    let pos = window.cursor_position().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    if !(scale.is_finite() && scale > 0.0 && pos.x.is_finite() && pos.y.is_finite()) {
        return Err("无法读取光标位置".into());
    }
    Ok(CursorPoint {
        x: pos.x / scale,
        y: pos.y / scale,
    })
}

#[derive(serde::Serialize)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub round: bool,
}

#[tauri::command]
pub fn set_hit_rects(window: tauri::WebviewWindow, rects: Vec<HitRect>) -> Result<(), String> {
    apply_hit_rects(&window, &rects)
}

fn apply_hit_rects(window: &tauri::WebviewWindow, rects: &[HitRect]) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_hit_rects_windows(window, rects)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, rects);
        Ok(())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_hit_rects_windows(window: &tauri::WebviewWindow, rects: &[HitRect]) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateEllipticRgn, CreateRectRgn, DeleteObject, RGN_OR, SetWindowRgn,
    };

    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    if !(scale.is_finite() && scale > 0.0) {
        return Err("缩放无效".into());
    }
    let mut region = None;
    for rect in rects {
        if !(rect.w.is_finite() && rect.h.is_finite() && rect.w > 0.0 && rect.h > 0.0) {
            continue;
        }
        let left = (rect.x * scale).round() as i32;
        let top = (rect.y * scale).round() as i32;
        let right = ((rect.x + rect.w) * scale).round() as i32;
        let bottom = ((rect.y + rect.h) * scale).round() as i32;
        let part = unsafe {
            if rect.round {
                CreateEllipticRgn(left, top, right, bottom)
            } else {
                CreateRectRgn(left, top, right, bottom)
            }
        };
        if part.is_invalid() {
            continue;
        }
        region = Some(match region {
            None => part,
            Some(previous) => {
                unsafe {
                    CombineRgn(Some(previous), Some(previous), Some(part), RGN_OR);
                    let _ = DeleteObject(part.into());
                }
                previous
            }
        });
    }
    let Some(region) = region else {
        return Ok(());
    };
    let applied = unsafe { SetWindowRgn(hwnd, Some(region), false) };
    if applied == 0 {
        unsafe {
            let _ = DeleteObject(region.into());
        }
        return Err("无法设置点击区域".into());
    }
    Ok(())
}

fn apply_shell_bounds(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_bounds_windows(window, x, y, width, height, preserve_client)
    }
    #[cfg(not(windows))]
    {
        let _ = preserve_client;
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|err| err.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|err| err.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_bounds_windows(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    use windows::Win32::UI::WindowsAndMessaging::{
        SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOZORDER, SetWindowPos,
    };

    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let position: tauri::PhysicalPosition<i32> = LogicalPosition::new(x, y).to_physical(scale);
    let size: tauri::PhysicalSize<i32> = LogicalSize::new(width, height).to_physical(scale);
    // Resizes copy the old client into the new rect, so the sphere appears to jump until the
    // next paint. Discard those bits only when the size changes; pure drags keep the client.
    let flags = if preserve_client {
        SWP_NOZORDER | SWP_NOACTIVATE
    } else {
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS
    };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            position.x,
            position.y,
            size.width,
            size.height,
            flags,
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_anchor(state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("坐标无效".into());
    }
    ensure_writable(&state)?;
    let mut config = state::lock(&state.config).clone();
    config.anchor = Some(Anchor { x, y });
    config::save(&state.config_path, &config).map_err(|err| err.to_string())?;
    *state::lock(&state.config) = config;
    Ok(())
}

#[tauri::command]
pub fn run_item(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    item_id: String,
) -> Result<RunOutput, String> {
    let (item, config) = {
        let config = state::lock(&state.config);
        let item = find_item(&config, &bucket_id, &item_id)?.clone();
        (item, config.clone())
    };
    if item.kind == "command" {
        let command = item
            .params
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if has_placeholders(command) {
            return Err("这个指令含有参数，请填写后再运行".into());
        }
    }
    execute(&app, &state, &config, &item)
}

#[tauri::command]
pub fn run_filled(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    item_id: String,
    values: std::collections::HashMap<String, String>,
) -> Result<RunOutput, String> {
    ensure_writable(&state)?;
    let mut config = state::lock(&state.config).clone();
    let item = find_item(&config, &bucket_id, &item_id)?.clone();
    if item.kind != "command" {
        return Err("只有指令需要填写参数".into());
    }
    let shell = item
        .params
        .get("shell")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let template = item
        .params
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let mut specs = read_placeholders(&item);
    let expanded = template::substitute(&template, &values, &specs, &shell)?;
    for (name, value) in &values {
        let kind = specs
            .iter()
            .find(|spec| spec.name == *name)
            .map(|spec| spec.kind.clone())
            .unwrap_or_else(|| "text".into());
        remember(&mut specs, name, &kind, value);
    }
    let mut stored = item.clone();
    if !specs.is_empty() {
        stored.params.insert(
            "placeholders".into(),
            serde_json::to_value(&specs).map_err(|err| err.to_string())?,
        );
    }
    config
        .update_item(&bucket_id, &item_id, stored)
        .map_err(|err| err.to_string())?;
    config::save(&state.config_path, &config).map_err(|err| err.to_string())?;
    *state::lock(&state.config) = config.clone();
    let snapshot = build_snapshot(&state);
    let _ = app.emit("config-updated", &snapshot);

    let mut runnable = item;
    runnable
        .params
        .insert("command".into(), serde_json::Value::String(expanded));
    execute(&app, &state, &config, &runnable)
}

fn execute(
    app: &AppHandle,
    state: &AppState,
    config: &AppConfig,
    item: &ToolItem,
) -> Result<RunOutput, String> {
    let host = TauriHost { app: app.clone() };
    state
        .runners
        .run(
            &RunContext {
                config,
                host: &host,
            },
            item,
        )
        .map_err(|err| err.to_string())
}

fn read_placeholders(item: &ToolItem) -> Vec<PlaceholderSpec> {
    item.params
        .get("placeholders")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

fn remember(specs: &mut Vec<PlaceholderSpec>, name: &str, kind: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    if let Some(spec) = specs.iter_mut().find(|spec| spec.name == name) {
        spec.kind = kind.to_string();
        spec.recent.retain(|existing| existing != value);
        spec.recent.insert(0, value.to_string());
        spec.recent.truncate(8);
        return;
    }
    specs.push(PlaceholderSpec {
        name: name.to_string(),
        kind: kind.to_string(),
        recent: vec![value.to_string()],
    });
}

pub fn toggle_autostart(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    ensure_writable(&state)?;
    let enabled = !state::lock(&state.config).autostart;
    autostart::apply(app, enabled)?;
    let mut config = state::lock(&state.config).clone();
    config.autostart = enabled;
    let _ = state.autostart_item.set_checked(enabled);
    commit(app, &state, config).map(|_| ())
}

fn commit(app: &AppHandle, state: &AppState, config: AppConfig) -> Result<AppSnapshot, String> {
    config::save(&state.config_path, &config).map_err(|err| err.to_string())?;
    *state::lock(&state.config) = config;
    let snapshot = build_snapshot(state);
    let _ = app.emit("config-updated", &snapshot);
    Ok(snapshot)
}

fn build_snapshot(state: &AppState) -> AppSnapshot {
    let config = state::lock(&state.config).clone();
    let warning = state::lock(&state.load_warning).clone();
    let (git_bash_detected, git_bash_error) = match detect_git_bash(config.git_bash_path.as_deref())
    {
        Ok(path) => (path.map(|path| path.display().to_string()), None),
        Err(err) => (None, Some(err)),
    };
    AppSnapshot {
        config,
        warning,
        config_path: state.config_path.display().to_string(),
        git_bash_detected,
        git_bash_error,
    }
}

fn ensure_writable(state: &AppState) -> Result<(), String> {
    if let Some(warning) = state::lock(&state.load_warning).as_ref() {
        return Err(format!("配置未能加载，已暂停写入：{warning}"));
    }
    Ok(())
}

fn find_item<'a>(
    config: &'a AppConfig,
    bucket_id: &str,
    item_id: &str,
) -> Result<&'a ToolItem, String> {
    let bucket = config
        .buckets
        .iter()
        .find(|bucket| bucket.id == bucket_id)
        .ok_or_else(|| format!("找不到分组：{bucket_id}"))?;
    bucket
        .items
        .iter()
        .find(|item| item.id == item_id)
        .ok_or_else(|| format!("找不到工具：{item_id}"))
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

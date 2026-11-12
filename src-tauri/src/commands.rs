use tauri::{AppHandle, Emitter, Manager, State};

use crate::autostart;
use crate::config::{self, Anchor, AppConfig, NewTool, ToolItem};
use crate::host::TauriHost;
use crate::paths::detect_git_bash;
use crate::runner::{RunContext, RunOutput};
use crate::state::{self, AppState};

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
    let host = TauriHost { app };
    state
        .runners
        .run(
            &RunContext {
                config: &config,
                host: &host,
            },
            &item,
        )
        .map_err(|err| err.to_string())
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

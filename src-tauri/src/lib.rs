#![deny(unsafe_code)]

mod autostart;
mod commands;
mod config;
mod host;
mod paths;
mod plugins;
mod runner;
mod runners;
mod state;
mod template;
mod tray;

use std::error::Error;

use tauri::{Manager, WindowEvent};

/// Composition root: window, tray, autostart, config, and the runner registry.
///
/// Tool behavior does not live here. Items in the JSON config are dispatched
/// through [`runner::RunnerRegistry`].
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::add_bucket,
            commands::add_tool,
            commands::update_tool,
            commands::remove_tool,
            commands::update_settings,
            commands::update_style,
            commands::run_filled,
            commands::set_anchor,
            commands::set_shell_bounds,
            commands::cursor_position,
            commands::run_item,
        ])
        .run(tauri::generate_context!())
        .expect("PowerSphere failed to start");
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let dir = paths::ensure_layout()?;
    let config_path = dir.join(paths::CONFIG_FILE);
    let (config, warning) = match config::load_or_create(&config_path) {
        Ok(config) => (config, None),
        Err(err) => {
            eprintln!("PowerSphere config: {err}");
            (config::AppConfig::fresh(), Some(err.to_string()))
        }
    };

    if warning.is_none()
        && let Err(err) = autostart::apply(app.handle(), config.autostart)
    {
        eprintln!("PowerSphere autostart: {err}");
    }

    let autostart_item = tauri::menu::CheckMenuItem::with_id(
        app.handle(),
        "autostart",
        "登录时启动",
        true,
        config.autostart,
        None::<&str>,
    )?;

    let app_state = state::AppState {
        config_path,
        config: std::sync::Mutex::new(config),
        runners: runner::RunnerRegistry::with_builtins(),
        load_warning: std::sync::Mutex::new(warning),
        autostart_item,
    };
    app.manage(app_state);

    if let Err(err) = tray::install(app.handle()) {
        eprintln!("PowerSphere tray: {err}");
    }

    if let Some(window) = app.get_webview_window("main") {
        let hidden = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hidden.hide();
            }
        });
    }

    Ok(())
}

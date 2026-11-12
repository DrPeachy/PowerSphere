use std::sync::{Mutex, MutexGuard};

use tauri::Wry;
use tauri::menu::CheckMenuItem;

use crate::config::AppConfig;
use crate::runner::RunnerRegistry;

pub struct AppState {
    pub config_path: std::path::PathBuf,
    pub config: Mutex<AppConfig>,
    pub runners: RunnerRegistry,
    pub load_warning: Mutex<Option<String>>,
    pub autostart_item: CheckMenuItem<Wry>,
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

use std::process::{Command, Stdio};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::runner::{Host, RunError, SpawnPlan};

pub struct TauriHost {
    pub app: AppHandle,
}

impl Host for TauriHost {
    fn open_url(&self, url: &str) -> Result<(), RunError> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|err| RunError::new(err.to_string()))
    }

    fn open_path(&self, path: &str) -> Result<(), RunError> {
        self.app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|err| RunError::new(err.to_string()))
    }

    fn spawn(&self, plan: &SpawnPlan) -> Result<u32, RunError> {
        spawn_plan(plan)
    }
}

pub fn spawn_plan(plan: &SpawnPlan) -> Result<u32, RunError> {
    let mut command = Command::new(&plan.program);
    command.args(&plan.args);
    if let Some(cwd) = &plan.cwd {
        if !cwd.is_dir() {
            return Err(RunError::new(format!("工作目录不存在：{}", cwd.display())));
        }
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    let child = command
        .spawn()
        .map_err(|err| RunError::new(format!("无法启动 {}：{err}", plan.program)))?;
    Ok(child.id())
}

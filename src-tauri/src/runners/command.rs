use std::path::{Path, PathBuf};

use crate::config::{AppConfig, ToolItem};
use crate::paths::{detect_git_bash, expand_env, to_msys_path};
use crate::runner::{RunContext, RunError, RunOutput, Runner, SpawnPlan};

pub struct CommandRunner;

impl Runner for CommandRunner {
    fn type_id(&self) -> &'static str {
        "command"
    }

    fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
        let plan = build_command_plan(ctx.config, item)?;
        let pid = ctx.host.spawn(&plan)?;
        Ok(RunOutput {
            message: format!("已启动（pid {pid}）"),
            pid: Some(pid),
        })
    }
}

pub(crate) fn build_command_plan(
    config: &AppConfig,
    item: &ToolItem,
) -> Result<SpawnPlan, RunError> {
    let shell = text_param(item, "shell")?;
    let command = text_param(item, "command")?;
    if command.is_empty() {
        return Err(RunError::new("命令为空"));
    }
    let cwd = cwd_param(item)?;
    match shell {
        "git-bash" => {
            let bash = detect_git_bash(config.git_bash_path.as_deref()).map_err(RunError::new)?;
            let Some(bash) = bash else {
                return Err(RunError::new(
                    "未找到 Git Bash。请安装 Git for Windows，或在设置里填写 gitBashPath。",
                ));
            };
            let script = bash_script(cwd.as_deref(), command);
            Ok(SpawnPlan {
                program: bash.display().to_string(),
                args: vec!["-lc".into(), script],
                cwd: None,
            })
        }
        "powershell" | "cmd" => {
            let (program, args) = shell_invocation(shell, command, cfg!(windows))?;
            Ok(SpawnPlan { program, args, cwd })
        }
        other => Err(RunError::new(format!("不支持的 shell：{other}"))),
    }
}

fn text_param<'a>(item: &'a ToolItem, key: &str) -> Result<&'a str, RunError> {
    item.params
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RunError::new(format!("command 缺少 {key}")))
}

fn cwd_param(item: &ToolItem) -> Result<Option<PathBuf>, RunError> {
    let Some(raw) = item
        .params
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let expanded = expand_env(raw);
    let path = PathBuf::from(&expanded);
    if !path.is_dir() {
        return Err(RunError::new(format!("工作目录不存在：{expanded}")));
    }
    Ok(Some(path))
}

/// `windows` is a parameter so Linux tests can assert the Windows argv.
pub(crate) fn shell_invocation(
    shell: &str,
    command: &str,
    windows: bool,
) -> Result<(String, Vec<String>), RunError> {
    match shell {
        "powershell" => {
            let program = if windows { "powershell.exe" } else { "pwsh" };
            Ok((
                program.into(),
                vec![
                    "-NoExit".into(),
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-Command".into(),
                    command.into(),
                ],
            ))
        }
        "cmd" => {
            if windows {
                Ok(("cmd.exe".into(), vec!["/K".into(), command.into()]))
            } else {
                Ok(("sh".into(), vec!["-c".into(), command.into()]))
            }
        }
        other => Err(RunError::new(format!("不支持的 shell：{other}"))),
    }
}

/// Git Bash is started as a login shell, which may reset the working directory.
/// The `cd` inside the script is what actually applies `cwd`.
pub(crate) fn bash_script(cwd: Option<&Path>, command: &str) -> String {
    match cwd {
        Some(dir) => {
            let posix = to_msys_path(dir).replace('\'', r"'\''");
            format!("cd '{posix}' && {command}")
        }
        None => command.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, Value};

    fn command_item(shell: &str, command: &str, cwd: Option<&str>) -> ToolItem {
        let mut params = Map::new();
        params.insert("shell".into(), Value::String(shell.into()));
        params.insert("command".into(), Value::String(command.into()));
        if let Some(cwd) = cwd {
            params.insert("cwd".into(), Value::String(cwd.into()));
        }
        ToolItem {
            id: "cmd".into(),
            label: "命令".into(),
            kind: "command".into(),
            params,
        }
    }

    #[test]
    fn powershell_on_windows_is_one_argument() {
        let (program, args) =
            shell_invocation("powershell", "Write-Output \"hi there\"", true).unwrap();
        assert_eq!(program, "powershell.exe");
        assert_eq!(
            args,
            vec![
                "-NoExit",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Write-Output \"hi there\"",
            ]
        );
    }

    #[test]
    fn cmd_on_windows_keeps_the_console() {
        let (program, args) = shell_invocation("cmd", "echo hello", true).unwrap();
        assert_eq!(program, "cmd.exe");
        assert_eq!(args, vec!["/K", "echo hello"]);
    }

    #[test]
    fn git_bash_cds_into_the_working_directory() {
        let dir = std::env::temp_dir().join(format!(
            "powersphere-bash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let bash = dir.join("bash.exe");
        std::fs::write(&bash, b"not a real shell").unwrap();
        let mut config = AppConfig::fresh();
        config.git_bash_path = Some(bash.display().to_string());
        let plan = build_command_plan(
            &config,
            &command_item(
                "git-bash",
                "git status --short",
                Some(&dir.display().to_string()),
            ),
        )
        .unwrap();
        assert_eq!(plan.program, bash.display().to_string());
        assert_eq!(plan.args[0], "-lc");
        assert!(plan.args[1].contains("git status --short"));
        assert!(plan.args[1].contains("cd '"));
        assert!(plan.cwd.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_shell_is_rejected() {
        let config = AppConfig::fresh();
        let error = build_command_plan(&config, &command_item("zsh", "true", None)).unwrap_err();
        assert!(error.to_string().contains("zsh"));
    }
}

use std::path::PathBuf;

use crate::config::ToolItem;
use crate::paths::expand_env;
use crate::runner::{RunContext, RunError, RunOutput, Runner, SpawnPlan};

pub struct BatRunner;

impl Runner for BatRunner {
    fn type_id(&self) -> &'static str {
        "bat"
    }

    fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
        let plan = build_bat_plan(item)?;
        let pid = ctx.host.spawn(&plan)?;
        Ok(RunOutput {
            message: format!("已启动批处理（pid {pid}）"),
            pid: Some(pid),
        })
    }
}

pub(crate) fn build_bat_plan(item: &ToolItem) -> Result<SpawnPlan, RunError> {
    let raw = item
        .params
        .get("target")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RunError::new("请选择批处理文件"))?;
    let expanded = expand_env(raw);
    let path = PathBuf::from(&expanded);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "bat" && extension != "cmd" {
        return Err(RunError::new("请选择 .bat 或 .cmd 文件"));
    }
    if !path.is_file() {
        return Err(RunError::new(format!("找不到批处理：{expanded}")));
    }
    let args = item
        .params
        .get("args")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let quoted = format!("\"{}\"", expanded.replace('"', "\"\""));
    let command = match args {
        Some(extra) => format!("call {quoted} {extra}"),
        None => format!("call {quoted}"),
    };
    let cwd = match item
        .params
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => {
            let dir = PathBuf::from(expand_env(raw));
            if !dir.is_dir() {
                return Err(RunError::new(format!("工作目录不存在：{}", dir.display())));
            }
            Some(dir)
        }
        None => path.parent().filter(|dir| dir.is_dir()).map(PathBuf::from),
    };
    Ok(SpawnPlan {
        program: "cmd.exe".into(),
        args: vec!["/K".into(), command],
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::build_bat_plan;
    use crate::config::ToolItem;
    use serde_json::{Map, Value};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn item(target: &str, cwd: Option<&str>, args: Option<&str>) -> ToolItem {
        let mut params = Map::new();
        params.insert("target".into(), Value::String(target.into()));
        if let Some(cwd) = cwd {
            params.insert("cwd".into(), Value::String(cwd.into()));
        }
        if let Some(args) = args {
            params.insert("args".into(), Value::String(args.into()));
        }
        ToolItem {
            id: "bat-1".into(),
            label: "备份".into(),
            kind: "bat".into(),
            params,
        }
    }

    #[test]
    fn quotes_a_path_with_spaces_and_defaults_cwd_to_the_script_folder() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("powersphere-bat-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("my script.bat");
        fs::write(&script, "@echo off\r\n").unwrap();
        let plan = build_bat_plan(&item(
            script.to_str().unwrap(),
            None,
            Some("--name \"demo set\""),
        ))
        .unwrap();
        assert_eq!(plan.program, "cmd.exe");
        assert_eq!(plan.args[0], "/K");
        assert!(plan.args[1].contains("call \""));
        assert!(plan.args[1].contains("my script.bat\""));
        assert!(plan.args[1].contains("--name \"demo set\""));
        assert_eq!(plan.cwd.unwrap(), dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_script_is_an_error() {
        let error = build_bat_plan(&item(r"C:\no\such\backup.bat", None, None)).unwrap_err();
        assert!(error.to_string().contains("找不到批处理"));
    }

    #[test]
    fn rejects_a_non_script() {
        let error = build_bat_plan(&item(r"C:\Windows\notepad.exe", None, None)).unwrap_err();
        assert!(error.to_string().contains(".bat"));
    }
}

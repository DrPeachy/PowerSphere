use std::path::Path;

use crate::config::ToolItem;
use crate::paths::{expand_env, is_url};
use crate::runner::{RunContext, RunError, RunOutput, Runner};

pub struct OpenPathRunner;

impl Runner for OpenPathRunner {
    fn type_id(&self) -> &'static str {
        "open-path"
    }

    fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
        let target = item
            .params
            .get("target")
            .and_then(|value| value.as_str())
            .ok_or_else(|| RunError::new("open-path 缺少 target"))?;
        let expanded = expand_env(target).trim().to_string();
        if expanded.is_empty() {
            return Err(RunError::new("路径为空"));
        }
        if is_url(&expanded) {
            ctx.host.open_url(&expanded)?;
        } else if Path::new(&expanded).exists() {
            ctx.host.open_path(&expanded)?;
        } else {
            return Err(RunError::new(format!("找不到路径：{expanded}")));
        }
        Ok(RunOutput {
            message: format!("已打开 {expanded}"),
            pid: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::runner::{Host, RunContext, SpawnPlan};
    use serde_json::{Map, Value};
    use std::sync::Mutex;

    struct RecordingHost {
        opens: Mutex<Vec<String>>,
    }

    impl Host for RecordingHost {
        fn open_url(&self, url: &str) -> Result<(), RunError> {
            self.opens.lock().expect("opens").push(url.to_string());
            Ok(())
        }
        fn open_path(&self, path: &str) -> Result<(), RunError> {
            self.opens.lock().expect("opens").push(path.to_string());
            Ok(())
        }
        fn spawn(&self, _plan: &SpawnPlan) -> Result<u32, RunError> {
            Err(RunError::new("open-path does not spawn"))
        }
    }

    fn item(target: &str) -> ToolItem {
        let mut params = Map::new();
        params.insert("target".into(), Value::String(target.into()));
        ToolItem {
            id: "doc".into(),
            label: "文档".into(),
            kind: "open-path".into(),
            params,
        }
    }

    #[test]
    fn opens_urls_without_touching_the_filesystem() {
        let host = RecordingHost {
            opens: Mutex::new(Vec::new()),
        };
        let config = AppConfig::fresh();
        OpenPathRunner
            .run(
                &RunContext {
                    config: &config,
                    host: &host,
                },
                &item("https://v2.tauri.app"),
            )
            .unwrap();
        assert_eq!(
            host.opens.lock().unwrap().as_slice(),
            ["https://v2.tauri.app"]
        );
    }

    #[test]
    fn missing_path_is_an_error() {
        let host = RecordingHost {
            opens: Mutex::new(Vec::new()),
        };
        let config = AppConfig::fresh();
        let error = OpenPathRunner
            .run(
                &RunContext {
                    config: &config,
                    host: &host,
                },
                &item(r"C:\this\path\does\not\exist\powersphere"),
            )
            .unwrap_err();
        assert!(error.to_string().contains("找不到路径"));
        assert!(host.opens.lock().unwrap().is_empty());
    }
}

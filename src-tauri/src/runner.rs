use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::{AppConfig, ToolItem};
use crate::runners;

/// Side effects a runner is allowed to ask the core to perform.
///
/// Runners do not touch the window. A future file picker (for example an
/// `adb-install` runner that chooses an APK) should be a new method here with
/// a default body that returns [`RunError`], so existing hosts keep compiling.
pub trait Host {
    fn open_url(&self, url: &str) -> Result<(), RunError>;
    fn open_path(&self, path: &str) -> Result<(), RunError>;
    fn spawn(&self, plan: &SpawnPlan) -> Result<u32, RunError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

/// One config `type` maps to one runner. Register it; do not branch in the UI.
pub trait Runner: Send + Sync {
    fn type_id(&self) -> &'static str;
    fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError>;
}

pub struct RunContext<'a> {
    pub config: &'a AppConfig,
    pub host: &'a dyn Host,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub message: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunError {
    message: String,
}

impl RunError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RunError {}

pub struct RunnerRegistry {
    runners: HashMap<String, Box<dyn Runner>>,
}

impl RunnerRegistry {
    pub fn new() -> Self {
        Self {
            runners: HashMap::new(),
        }
    }

    pub fn register(&mut self, runner: Box<dyn Runner>) {
        self.runners.insert(runner.type_id().to_string(), runner);
    }

    pub fn with_builtins() -> Self {
        let mut registry = Self::new();
        runners::register_builtins(&mut registry);
        registry
    }

    pub fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
        let Some(runner) = self.runners.get(&item.kind) else {
            return Err(RunError::new(format!(
                "没有注册类型为「{}」的 Runner。添加步骤见 README「添加 Runner」。",
                item.kind
            )));
        };
        runner.run(ctx, item)
    }
}

impl Default for RunnerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoRunner;

    impl Runner for EchoRunner {
        fn type_id(&self) -> &'static str {
            "echo"
        }

        fn run(&self, _ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
            Ok(RunOutput {
                message: item.label.clone(),
                pid: None,
            })
        }
    }

    struct UnusedHost;

    impl Host for UnusedHost {
        fn open_url(&self, _url: &str) -> Result<(), RunError> {
            Err(RunError::new("unused"))
        }
        fn open_path(&self, _path: &str) -> Result<(), RunError> {
            Err(RunError::new("unused"))
        }
        fn spawn(&self, _plan: &SpawnPlan) -> Result<u32, RunError> {
            Err(RunError::new("unused"))
        }
    }

    #[test]
    fn builtins_are_registered_and_unknown_types_are_not() {
        let registry = RunnerRegistry::with_builtins();
        let host = UnusedHost;
        let config = AppConfig::fresh();
        let ctx = RunContext {
            config: &config,
            host: &host,
        };
        let open = registry
            .run(&ctx, &item("open-path", "打开"))
            .unwrap_err()
            .to_string();
        assert!(open.contains("target"));
        let command = registry
            .run(&ctx, &item("command", "命令"))
            .unwrap_err()
            .to_string();
        assert!(command.contains("shell"));
        let missing = registry
            .run(&ctx, &item("adb-install", "插件"))
            .unwrap_err()
            .to_string();
        assert!(missing.contains("adb-install"));
    }

    fn item(kind: &str, label: &str) -> crate::config::ToolItem {
        crate::config::ToolItem {
            id: kind.into(),
            label: label.into(),
            kind: kind.into(),
            params: serde_json::Map::new(),
        }
    }

    #[test]
    fn unknown_type_names_the_missing_runner() {
        let registry = RunnerRegistry::new();
        let host = UnusedHost;
        let config = AppConfig::fresh();
        let item = crate::config::ToolItem {
            id: "x".into(),
            label: "插件".into(),
            kind: "adb-install".into(),
            params: serde_json::Map::new(),
        };
        let error = registry
            .run(
                &RunContext {
                    config: &config,
                    host: &host,
                },
                &item,
            )
            .unwrap_err();
        assert!(error.to_string().contains("adb-install"));
    }

    #[test]
    fn registered_runner_receives_the_item() {
        let mut registry = RunnerRegistry::new();
        registry.register(Box::new(EchoRunner));
        let host = UnusedHost;
        let config = AppConfig::fresh();
        let item = crate::config::ToolItem {
            id: "e".into(),
            label: "回声".into(),
            kind: "echo".into(),
            params: serde_json::Map::new(),
        };
        let output = registry
            .run(
                &RunContext {
                    config: &config,
                    host: &host,
                },
                &item,
            )
            .unwrap();
        assert_eq!(output.message, "回声");
    }
}

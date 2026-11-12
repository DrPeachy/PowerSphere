use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Json(serde_json::Error),
    MissingVersion,
    UnsupportedVersion(u64),
    Invalid(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(formatter, "读写配置失败：{err}"),
            Self::Json(err) => write!(formatter, "配置 JSON 无效：{err}"),
            Self::MissingVersion => formatter.write_str("配置缺少 schemaVersion"),
            Self::UnsupportedVersion(version) => write!(
                formatter,
                "配置 schemaVersion 为 {version}，当前应用只支持 {SCHEMA_VERSION}"
            ),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<std::io::Error> for ConfigError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

fn default_autostart() -> bool {
    true
}

fn default_snap_inset() -> f64 {
    16.0
}

fn default_gap() -> f64 {
    12.0
}

fn default_sphere_size() -> f64 {
    64.0
}

fn default_animation_ms() -> f64 {
    220.0
}

fn default_unfocused_opacity() -> f64 {
    0.38
}

fn default_text_kind() -> String {
    "text".into()
}

fn finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub schema_version: u32,
    #[serde(default = "default_autostart")]
    pub autostart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_bash_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    #[serde(default)]
    pub style: StyleSettings,
    pub buckets: Vec<Bucket>,
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema_doc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleSettings {
    #[serde(default = "default_snap_inset")]
    pub snap_inset: f64,
    #[serde(default = "default_gap")]
    pub gap: f64,
    #[serde(default = "default_sphere_size")]
    pub sphere_size: f64,
    #[serde(default = "default_animation_ms")]
    pub animation_ms: f64,
    #[serde(default = "default_unfocused_opacity")]
    pub unfocused_opacity: f64,
}

impl Default for StyleSettings {
    fn default() -> Self {
        Self {
            snap_inset: default_snap_inset(),
            gap: default_gap(),
            sphere_size: default_sphere_size(),
            animation_ms: default_animation_ms(),
            unfocused_opacity: default_unfocused_opacity(),
        }
    }
}

impl StyleSettings {
    pub fn normalized(mut self) -> Self {
        self.snap_inset = finite(self.snap_inset, default_snap_inset()).clamp(0.0, 80.0);
        self.gap = finite(self.gap, default_gap()).clamp(0.0, 48.0);
        self.sphere_size = finite(self.sphere_size, default_sphere_size()).clamp(44.0, 96.0);
        self.animation_ms = finite(self.animation_ms, default_animation_ms()).clamp(0.0, 600.0);
        self.unfocused_opacity =
            finite(self.unfocused_opacity, default_unfocused_opacity()).clamp(0.15, 1.0);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaceholderSpec {
    pub name: String,
    #[serde(default = "default_text_kind")]
    pub kind: String,
    #[serde(default)]
    pub recent: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bucket {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub items: Vec<ToolItem>,
}

/// A tool. `kind` is the JSON `type`. Extra fields are kept so a future runner
/// can own an item this version of the app does not execute yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolItem {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub params: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum NewTool {
    #[serde(rename = "open-path")]
    OpenPath {
        label: String,
        target: String,
        #[serde(default)]
        icon: Option<String>,
    },
    #[serde(rename = "command")]
    Command {
        label: String,
        shell: String,
        #[serde(default)]
        cwd: Option<String>,
        command: String,
        #[serde(default)]
        icon: Option<String>,
        #[serde(default)]
        placeholders: Vec<PlaceholderSpec>,
    },
    #[serde(rename = "bat")]
    Bat {
        label: String,
        target: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        args: Option<String>,
        #[serde(default)]
        icon: Option<String>,
    },
}

impl AppConfig {
    pub fn fresh() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            autostart: true,
            git_bash_path: None,
            anchor: None,
            style: StyleSettings::default(),
            buckets: default_buckets(),
            schema_doc: None,
        }
    }

    pub fn add_bucket(&mut self, name: &str) -> Result<String, ConfigError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ConfigError::Invalid("分组名称不能为空".into()));
        }
        if name.chars().count() > 40 {
            return Err(ConfigError::Invalid("分组名称过长".into()));
        }
        let id = new_id("bucket");
        self.buckets.push(Bucket {
            id: id.clone(),
            name: name.to_string(),
            items: Vec::new(),
        });
        Ok(id)
    }

    pub fn add_item(&mut self, bucket_id: &str, item: ToolItem) -> Result<(), ConfigError> {
        validate_item(&item)?;
        if self
            .buckets
            .iter()
            .flat_map(|bucket| bucket.items.iter())
            .any(|existing| existing.id == item.id)
        {
            return Err(ConfigError::Invalid(format!("工具 id 重复：{}", item.id)));
        }
        let bucket = self
            .buckets
            .iter_mut()
            .find(|bucket| bucket.id == bucket_id)
            .ok_or_else(|| ConfigError::Invalid(format!("找不到分组：{bucket_id}")))?;
        bucket.items.push(item);
        Ok(())
    }

    pub fn update_item(
        &mut self,
        bucket_id: &str,
        item_id: &str,
        mut item: ToolItem,
    ) -> Result<(), ConfigError> {
        item.id = item_id.to_string();
        validate_item(&item)?;
        let bucket = self
            .buckets
            .iter_mut()
            .find(|bucket| bucket.id == bucket_id)
            .ok_or_else(|| ConfigError::Invalid(format!("找不到分组：{bucket_id}")))?;
        let slot = bucket
            .items
            .iter_mut()
            .find(|existing| existing.id == item_id)
            .ok_or_else(|| ConfigError::Invalid(format!("找不到工具：{item_id}")))?;
        *slot = item;
        Ok(())
    }

    pub fn remove_item(&mut self, bucket_id: &str, item_id: &str) -> Result<(), ConfigError> {
        let bucket = self
            .buckets
            .iter_mut()
            .find(|bucket| bucket.id == bucket_id)
            .ok_or_else(|| ConfigError::Invalid(format!("找不到分组：{bucket_id}")))?;
        let before = bucket.items.len();
        bucket.items.retain(|item| item.id != item_id);
        if bucket.items.len() == before {
            return Err(ConfigError::Invalid(format!("找不到工具：{item_id}")));
        }
        Ok(())
    }
}

impl NewTool {
    pub fn into_item(self) -> Result<ToolItem, ConfigError> {
        let label = match &self {
            Self::OpenPath { label, .. }
            | Self::Command { label, .. }
            | Self::Bat { label, .. } => label.trim().to_string(),
        };
        if label.is_empty() {
            return Err(ConfigError::Invalid("名称不能为空".into()));
        }
        if label.chars().count() > 80 {
            return Err(ConfigError::Invalid("名称过长".into()));
        }
        let (kind, params) = match self {
            Self::OpenPath { target, icon, .. } => {
                let target = target.trim().to_string();
                if target.is_empty() {
                    return Err(ConfigError::Invalid("路径或网址不能为空".into()));
                }
                let mut params = Map::new();
                params.insert("target".into(), Value::String(target));
                insert_icon(&mut params, icon)?;
                ("open-path", params)
            }
            Self::Command {
                shell,
                cwd,
                command,
                icon,
                placeholders,
                ..
            } => {
                let mut params = Map::new();
                params.insert("shell".into(), Value::String(shell.trim().to_string()));
                params.insert("command".into(), Value::String(command.trim().to_string()));
                if let Some(cwd) = cwd
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    params.insert("cwd".into(), Value::String(cwd));
                }
                insert_icon(&mut params, icon)?;
                insert_placeholders(&mut params, placeholders)?;
                ("command", params)
            }
            Self::Bat {
                target,
                cwd,
                args,
                icon,
                ..
            } => {
                let target = target.trim().to_string();
                if !is_batch_path(&target) {
                    return Err(ConfigError::Invalid("请选择 .bat 或 .cmd 文件".into()));
                }
                let mut params = Map::new();
                params.insert("target".into(), Value::String(target));
                if let Some(cwd) = cwd
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    params.insert("cwd".into(), Value::String(cwd));
                }
                if let Some(args) = args
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    params.insert("args".into(), Value::String(args));
                }
                insert_icon(&mut params, icon)?;
                ("bat", params)
            }
        };
        let item = ToolItem {
            id: new_id("item"),
            label,
            kind: kind.to_string(),
            params,
        };
        validate_item(&item)?;
        Ok(item)
    }
}

pub fn load_or_create(path: &Path) -> Result<AppConfig, ConfigError> {
    if !path.exists() {
        let config = AppConfig::fresh();
        save(path, &config)?;
        return Ok(config);
    }
    parse_config(&fs::read_to_string(path)?)
}

pub fn parse_config(text: &str) -> Result<AppConfig, ConfigError> {
    let mut value: Value = serde_json::from_str(text)?;
    let version = value
        .get("schemaVersion")
        .ok_or(ConfigError::MissingVersion)?;
    let version = version
        .as_u64()
        .ok_or_else(|| ConfigError::Invalid("schemaVersion 必须是整数".into()))?;
    if version == 0 || version > u64::from(SCHEMA_VERSION) {
        return Err(ConfigError::UnsupportedVersion(version));
    }
    if version < u64::from(SCHEMA_VERSION) {
        value = migrate(value, version)?;
    }
    let mut config: AppConfig = serde_json::from_value(value)?;
    config.style = config.style.normalized();
    validate_config(&config)?;
    Ok(config)
}

pub fn save(path: &Path, config: &AppConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    validate_config(config)?;
    let mut data = serde_json::to_vec_pretty(config)?;
    data.push(b'\n');
    let tmp = temp_sibling(path);
    fs::write(&tmp, &data)?;
    replace_file(&tmp, path)?;
    Ok(())
}

/// Identity for v1. The next schema version transforms `value` and bumps
/// `schemaVersion` before the struct parser sees it.
pub fn migrate(value: Value, from: u64) -> Result<Value, ConfigError> {
    if from == 0 || from > u64::from(SCHEMA_VERSION) {
        return Err(ConfigError::UnsupportedVersion(from));
    }
    Ok(value)
}

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    path.with_file_name(format!(".{name}.tmp"))
}

fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    match fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(dest);
            fs::rename(tmp, dest).map_err(|_| err)
        }
    }
}

fn default_buckets() -> Vec<Bucket> {
    vec![
        Bucket {
            id: "navigation".into(),
            name: "导航".into(),
            items: Vec::new(),
        },
        Bucket {
            id: "command".into(),
            name: "指令".into(),
            items: Vec::new(),
        },
    ]
}

fn validate_config(config: &AppConfig) -> Result<(), ConfigError> {
    if config.schema_version != SCHEMA_VERSION {
        return Err(ConfigError::UnsupportedVersion(u64::from(
            config.schema_version,
        )));
    }
    let mut bucket_ids = HashSet::new();
    let mut item_ids = HashSet::new();
    for bucket in &config.buckets {
        if bucket.id.trim().is_empty() || bucket.name.trim().is_empty() {
            return Err(ConfigError::Invalid("分组的 id 和 name 不能为空".into()));
        }
        if !bucket_ids.insert(bucket.id.clone()) {
            return Err(ConfigError::Invalid(format!("分组 id 重复：{}", bucket.id)));
        }
        for item in &bucket.items {
            if !item_ids.insert(item.id.clone()) {
                return Err(ConfigError::Invalid(format!("工具 id 重复：{}", item.id)));
            }
            validate_item(item)?;
        }
    }
    Ok(())
}

fn validate_item(item: &ToolItem) -> Result<(), ConfigError> {
    if item.id.trim().is_empty() || item.label.trim().is_empty() || item.kind.trim().is_empty() {
        return Err(ConfigError::Invalid(
            "工具的 id、label、type 不能为空".into(),
        ));
    }
    match item.kind.as_str() {
        "open-path" => {
            let target = param_str(item, "target").unwrap_or("");
            if target.trim().is_empty() {
                return Err(ConfigError::Invalid(format!(
                    "open-path 缺少 target：{}",
                    item.id
                )));
            }
        }
        "command" => {
            let shell = param_str(item, "shell").unwrap_or("");
            if !matches!(shell, "git-bash" | "powershell" | "cmd") {
                return Err(ConfigError::Invalid(format!("command shell 无效：{shell}")));
            }
            let command = param_str(item, "command").unwrap_or("");
            if command.trim().is_empty() {
                return Err(ConfigError::Invalid(format!(
                    "command 缺少 command：{}",
                    item.id
                )));
            }
        }
        "bat" => {
            let target = param_str(item, "target").unwrap_or("");
            if !is_batch_path(target) {
                return Err(ConfigError::Invalid(format!(
                    "bat 需要 .bat 或 .cmd 路径：{}",
                    item.id
                )));
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_batch_path(path: &str) -> bool {
    let lower = path.trim().to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

fn insert_icon(params: &mut Map<String, Value>, icon: Option<String>) -> Result<(), ConfigError> {
    let Some(icon) = icon
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if icon.chars().count() > 4 {
        return Err(ConfigError::Invalid("图标最多 4 个字符".into()));
    }
    params.insert("icon".into(), Value::String(icon));
    Ok(())
}

fn insert_placeholders(
    params: &mut Map<String, Value>,
    placeholders: Vec<PlaceholderSpec>,
) -> Result<(), ConfigError> {
    if placeholders.is_empty() {
        return Ok(());
    }
    let mut clean = Vec::new();
    for spec in placeholders {
        let name = spec.name.trim().to_string();
        if name.is_empty() {
            return Err(ConfigError::Invalid("占位符名称不能为空".into()));
        }
        if spec.kind != "text" && spec.kind != "file" {
            return Err(ConfigError::Invalid(format!(
                "占位符类型无效：{}",
                spec.kind
            )));
        }
        let mut recent = Vec::new();
        for value in spec.recent {
            let value = value.trim().to_string();
            if value.is_empty() || recent.iter().any(|existing| existing == &value) {
                continue;
            }
            recent.push(value);
            if recent.len() == 8 {
                break;
            }
        }
        clean.push(PlaceholderSpec {
            name,
            kind: spec.kind,
            recent,
        });
    }
    params.insert(
        "placeholders".into(),
        serde_json::to_value(clean).map_err(ConfigError::from)?,
    );
    Ok(())
}

fn param_str<'a>(item: &'a ToolItem, key: &str) -> Option<&'a str> {
    item.params.get(key).and_then(Value::as_str)
}

fn new_id(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{millis:x}-{seq}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_has_empty_default_buckets() {
        let config = AppConfig::fresh();
        let raw = serde_json::to_string(&config).unwrap();
        assert_eq!(config.schema_version, 1);
        assert!(config.autostart);
        assert!(config.git_bash_path.is_none());
        assert_eq!(config.buckets.len(), 2);
        assert!(config.buckets.iter().all(|bucket| bucket.items.is_empty()));
        assert!(!raw.contains("D:\\"));
        assert!(!raw.contains("D:/"));
    }

    #[test]
    fn round_trip_keeps_unknown_item_fields() {
        let raw = r#"{
          "schemaVersion": 1,
          "buckets": [{
            "id": "custom",
            "name": "自定义",
            "items": [{
              "id": "apk",
              "label": "安装 APK",
              "type": "adb-install",
              "apk": "sample.apk"
            }]
          }]
        }"#;
        let config = parse_config(raw).unwrap();
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(
            saved["buckets"][0]["items"][0]["apk"],
            Value::String("sample.apk".into())
        );
        assert_eq!(saved["buckets"][0]["items"][0]["type"], "adb-install");
    }

    #[test]
    fn rejects_a_newer_schema() {
        let error = parse_config(r#"{ "schemaVersion": 99, "buckets": [] }"#).unwrap_err();
        assert!(matches!(error, ConfigError::UnsupportedVersion(99)));
    }

    #[test]
    fn example_file_parses() {
        let raw = include_str!("../../examples/config.example.json");
        let config = parse_config(raw).unwrap();
        assert_eq!(config.schema_version, SCHEMA_VERSION);
        assert!(
            config
                .buckets
                .iter()
                .any(|bucket| bucket.id == "navigation")
        );
        assert!(config.buckets.iter().any(|bucket| !bucket.items.is_empty()));
    }

    #[test]
    fn save_load_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "powersphere-cfg-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let mut config = AppConfig::fresh();
        config
            .add_item(
                "navigation",
                NewTool::OpenPath {
                    label: "文档".into(),
                    target: "%USERPROFILE%\\Documents".into(),
                    icon: None,
                }
                .into_item()
                .unwrap(),
            )
            .unwrap();
        save(&path, &config).unwrap();
        let loaded = load_or_create(&path).unwrap();
        assert_eq!(loaded.buckets[0].items.len(), 1);
        assert_eq!(loaded.buckets[0].items[0].kind, "open-path");
        let _ = fs::remove_dir_all(&dir);
    }
}

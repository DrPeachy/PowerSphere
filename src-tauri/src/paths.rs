use std::path::{Path, PathBuf};

use crate::plugins;

pub const CONFIG_FILE: &str = "config.json";

/// Windows: `%APPDATA%\PowerSphere`.
/// Elsewhere: `$XDG_CONFIG_HOME/PowerSphere` or `~/.config/PowerSphere`,
/// so the same binary can be developed off Windows.
pub fn config_dir() -> PathBuf {
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA")
        && !appdata.is_empty()
    {
        return PathBuf::from(appdata).join("PowerSphere");
    }

    #[cfg(not(windows))]
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME")
        && !xdg.is_empty()
    {
        return PathBuf::from(xdg).join("PowerSphere");
    }
    #[cfg(not(windows))]
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return PathBuf::from(home).join(".config").join("PowerSphere");
    }

    PathBuf::from("PowerSphere")
}

pub fn ensure_layout() -> std::io::Result<PathBuf> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(plugins::plugins_dir(&dir))?;
    Ok(dir)
}

pub fn expand_env(input: &str) -> String {
    expand_with(input, |key| std::env::var(key).ok())
}

fn expand_with(input: &str, mut lookup: impl FnMut(&str) -> Option<String>) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '%'
            && let Some(end) = chars[index + 1..].iter().position(|ch| *ch == '%')
        {
            let key: String = chars[index + 1..index + 1 + end].iter().collect();
            if is_env_key(&key)
                && let Some(value) = lookup(&key)
            {
                out.push_str(&value);
                index += end + 2;
                continue;
            }
        }
        if chars[index] == '$'
            && chars.get(index + 1) == Some(&'{')
            && let Some(end) = chars[index + 2..].iter().position(|ch| *ch == '}')
        {
            let key: String = chars[index + 2..index + 2 + end].iter().collect();
            if is_env_key(&key)
                && let Some(value) = lookup(&key)
            {
                out.push_str(&value);
                index += end + 3;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn is_env_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '(' || ch == ')')
}

pub fn is_url(value: &str) -> bool {
    let value = value.trim();
    if value
        .get(.."mailto:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
        && value.len() > "mailto:".len()
    {
        return true;
    }
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    scheme.len() > 1 && scheme.chars().all(|ch| ch.is_ascii_alphabetic()) && rest.starts_with("//")
}

/// `C:\Users\me` -> `/c/Users/me`, which Git Bash understands.
pub fn to_msys_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        format!("/{drive}{}", &raw[2..])
    } else {
        raw
    }
}

pub fn git_bash_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(root) = std::env::var(key)
            && !root.is_empty()
        {
            paths.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA")
        && !local.is_empty()
    {
        paths.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Ok(home) = std::env::var("USERPROFILE")
        && !home.is_empty()
    {
        let home = PathBuf::from(home);
        paths.push(
            home.join("scoop")
                .join("apps")
                .join("git")
                .join("current")
                .join("bin")
                .join("bash.exe"),
        );
    }
    paths.push(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"));
    paths.push(PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"));
    paths
}

/// `override_path` wins when it points at a file.
/// A configured path that does not exist is an error, so a typo is not silently ignored.
pub fn detect_git_bash(override_path: Option<&str>) -> Result<Option<PathBuf>, String> {
    if let Some(raw) = override_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(expand_env(raw));
        if path.is_file() {
            return Ok(Some(path));
        }
        return Err(format!("配置的 gitBashPath 不存在：{}", path.display()));
    }
    Ok(git_bash_candidates()
        .into_iter()
        .find(|path| path.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_windows_and_braced_vars() {
        let text = expand_with("%USERPROFILE%\\Documents ${HOME}/src", |key| match key {
            "USERPROFILE" => Some("C:\\Users\\me".into()),
            "HOME" => Some("/home/me".into()),
            _ => None,
        });
        assert_eq!(text, "C:\\Users\\me\\Documents /home/me/src");
    }

    #[test]
    fn leaves_unknown_vars_in_place() {
        let text = expand_with("%MISSING% and $NOT_BRACED", |_| None);
        assert_eq!(text, "%MISSING% and $NOT_BRACED");
    }

    #[test]
    fn drive_letters_are_not_urls() {
        assert!(!is_url(r"C:\Users\me"));
        assert!(is_url("https://v2.tauri.app"));
        assert!(is_url("mailto:dev@example.com"));
        assert!(is_url("file:///C:/Users/me"));
    }

    #[test]
    fn msys_paths_rewrite_the_drive() {
        assert_eq!(to_msys_path(Path::new(r"C:\Users\me")), "/c/Users/me");
        assert_eq!(to_msys_path(Path::new("/usr/bin")), "/usr/bin");
    }
}

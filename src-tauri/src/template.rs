use std::collections::HashMap;

use crate::config::PlaceholderSpec;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub name: String,
    pub kind: String,
}

pub fn parse_template(command: &str) -> Vec<Slot> {
    let mut slots = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = command;
    while let Some(start) = rest.find('{') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('}') else {
            break;
        };
        let body = &rest[..end];
        rest = &rest[end + 1..];
        let (name, hinted) = body.split_once(':').unwrap_or((body, ""));
        if is_name(name) && seen.insert(name.to_string()) {
            let kind = if hinted == "file" || hinted == "text" {
                hinted.to_string()
            } else {
                infer_kind(name).to_string()
            };
            slots.push(Slot {
                name: name.to_string(),
                kind,
            });
        }
    }
    slots
}

pub fn has_placeholders(command: &str) -> bool {
    !parse_template(command).is_empty()
}

pub fn substitute(
    template: &str,
    values: &HashMap<String, String>,
    specs: &[PlaceholderSpec],
    shell: &str,
) -> Result<String, String> {
    let slots = parse_template(template);
    if slots.is_empty() {
        return Ok(template.to_string());
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push('{');
            out.push_str(after);
            return Ok(out);
        };
        let body = &after[..end];
        let name = body.split_once(':').map(|(name, _)| name).unwrap_or(body);
        if !is_name(name) {
            out.push('{');
            rest = after;
            continue;
        }
        let value = values
            .get(name)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("请填写 {name}"))?;
        let kind = specs
            .iter()
            .find(|spec| spec.name == name)
            .map(|spec| spec.kind.as_str())
            .unwrap_or_else(|| infer_kind(name));
        out.push_str(&quote_for_shell(shell, value, kind == "file"));
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn quote_for_shell(shell: &str, value: &str, force: bool) -> String {
    let needs = force
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '"' | '\''));
    if !needs {
        return value.to_string();
    }
    match shell {
        "git-bash" => {
            let escaped = value.replace('\'', "'\\''");
            format!("'{escaped}'")
        }
        "powershell" => {
            let escaped = value.replace('`', "``").replace('"', "`\"");
            format!("\"{escaped}\"")
        }
        _ => {
            let escaped = value.replace('"', "\\\"");
            format!("\"{escaped}\"")
        }
    }
}

fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {
            chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        }
        _ => false,
    }
}

fn infer_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("apk")
        || lower.contains("path")
        || lower.contains("file")
        || lower.contains("dir")
        || lower.contains("folder")
        || lower.contains("exe")
    {
        "file"
    } else {
        "text"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_named_placeholders_and_file_hints() {
        let slots = parse_template("git merge {branch} --verbose && adb install {apk:file}");
        assert_eq!(slots[0].name, "branch");
        assert_eq!(slots[0].kind, "text");
        assert_eq!(slots[1].name, "apk");
        assert_eq!(slots[1].kind, "file");
    }

    #[test]
    fn infers_file_kind_from_the_name() {
        let slots = parse_template("adb install {apk}");
        assert_eq!(slots[0].kind, "file");
    }

    #[test]
    fn quotes_paths_that_contain_spaces() {
        let mut values = HashMap::new();
        values.insert("apk".into(), r"C:\My Apps\demo.apk".into());
        let command = substitute("adb install {apk}", &values, &[], "cmd").unwrap();
        assert_eq!(command, r#"adb install "C:\My Apps\demo.apk""#);

        let mut branch = HashMap::new();
        branch.insert("branch".into(), "feature".into());
        let git = substitute("git merge {branch} --verbose", &branch, &[], "git-bash").unwrap();
        assert_eq!(git, "git merge feature --verbose");
    }

    #[test]
    fn quotes_bash_paths_with_single_quotes() {
        let mut values = HashMap::new();
        values.insert("apk".into(), "/tmp/my app/a.apk".into());
        let specs = vec![PlaceholderSpec {
            name: "apk".into(),
            kind: "file".into(),
            recent: Vec::new(),
        }];
        let command = substitute("adb install {apk:file}", &values, &specs, "git-bash").unwrap();
        assert_eq!(command, "adb install '/tmp/my app/a.apk'");
    }
}

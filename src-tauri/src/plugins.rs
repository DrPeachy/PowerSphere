use std::path::{Path, PathBuf};

/// WASM plugin extension point. Not loaded in v1.
///
/// Built-in tools (`open-path`, `command`) and any later tool such as
/// `adb-install` are Rust types that implement [`crate::runner::Runner`] and
/// are registered on [`crate::runner::RunnerRegistry`]. A WASM plugin should
/// adapt into that same trait so core (window, tray, autostart, IPC, config
/// loading) stays unchanged.
///
/// Intended guest contract:
///
/// ```text
/// package powersphere:runner@1;
///
/// interface runner {
///   type-id: func() -> string;
///   run: func(item-json: string, config-json: string) -> result<string, string>;
/// }
/// ```
///
/// Load path, when this is implemented: every `*.wasm` file in
/// [`plugins_dir`]. On Windows that is `%APPDATA%\PowerSphere\plugins`.
/// The host adapter would:
///
/// 1. Read the guest `type-id`.
/// 2. Register an adapter as a [`crate::runner::Runner`].
/// 3. On `run`, pass the item JSON. Effects (open a path, spawn a process,
///    later a file picker) go through [`crate::runner::Host`], not through
///    the window directly.
///
/// Add a new host capability as a default method on `Host` that returns
/// "not supported", so existing runners and test doubles keep compiling.
/// One failing plugin must not take down the tray; give it a timeout.
pub fn plugins_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugins_live_next_to_the_config() {
        let dir = plugins_dir(Path::new("/tmp/PowerSphere"));
        assert_eq!(dir, PathBuf::from("/tmp/PowerSphere/plugins"));
    }
}

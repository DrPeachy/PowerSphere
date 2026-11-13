use crate::runner::RunnerRegistry;

mod bat;
mod command;
mod open_path;

/// Register every runner that ships with this version.
///
/// To add a runner:
/// 1. Implement [`crate::runner::Runner`] in a new module.
/// 2. Call `registry.register` here.
/// 3. Describe the item fields in `schema/powersphere.config.schema.json`.
/// 4. Add a form branch in the frontend only if people should create it from the plus button.
///    Items can also be written straight into the JSON config.
///
/// `adb-install` is intentionally not registered. It would be a new runner that
/// picks an APK, not a change to the window or the config loader.
pub fn register_builtins(registry: &mut RunnerRegistry) {
    registry.register(Box::new(open_path::OpenPathRunner));
    registry.register(Box::new(command::CommandRunner));
    registry.register(Box::new(bat::BatRunner));
}

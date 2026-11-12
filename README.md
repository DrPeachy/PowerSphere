# PowerSphere

PowerSphere 是一个独立安装的 Windows 桌面启动器。它在屏幕上放一颗始终置顶的小球：松手后贴到屏幕边缘，悬停时分组沿着这条边展开，再悬停某个分组，动作朝屏幕内侧展开。点击动作就执行。安装之后不需要 Node、Rust 或其他开发环境。

当前仓库是可运行的骨架：窗口、托盘、开机启动、版本化 JSON 配置和 Runner 接口已经接好。默认分组是 **导航** 和 **指令**，里面是空的，避免在一台新电脑上写死某个人的路径。

界面只包住球体周围的一小块区域，不是全屏透明遮罩。空闲时没有动画循环，也没有轮询。

## 环境要求

开发机：

- Rust stable（1.90 或更新）
- Node.js 20 或更新
- pnpm 10
- Windows 上还需要已安装的 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)。Windows 10/11 的现行系统一般已经带了。NSIS 安装包会在缺失时下载引导程序。

最终用户只需要 Windows，以及系统里的 WebView2。

发布流水线目前只打 Windows 包。Rust 核心和 Tauri 配置没有把 macOS / Linux 排除掉，以后可以加对应的打包目标。

## 本地开发

```bash
pnpm install
pnpm tauri dev
```

常用检查：

```bash
pnpm lint
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

`pnpm tauri dev` 会打开那颗小球。按住球体拖动，松手后贴到屏幕边缘，位置写进配置里的 `anchor`。贴边距离和球体间距在「设置」球里改。轻点球体（加号）打开添加工具；拖动不会把面板打开。展开时主球体停在贴边后的位置。右键动作球可以编辑它。

托盘图标：左键显示窗口，右键有「显示 / 登录时启动 / 打开配置目录 / 退出」。关掉窗口只会藏到托盘，退出从托盘菜单走。

## 怎么用这颗球

1. 松手后主球会贴到当前屏幕工作区最近的一条边。悬停时，分组（最后一颗固定是「设置」）沿着这条边展开：左右边是竖列，上下边是横排。
2. 悬停某个分组，它保持清楚，其余分组变淡。动作朝屏幕内侧、与分组垂直展开。没有 `{参数}` 的指令会直接运行；带 `{branch}` 或 `{apk:file}` 的指令会先弹出填写面板。文件参数可以用系统文件选择器。
3. 轻点主球体上的加号：
   - **导航**：填一个文件、文件夹、exe 或 URL，用系统默认程序打开。
   - **指令**：选 Git Bash、PowerShell 或 CMD，可以填工作目录，再填要跑的命令。命令会在新的控制台里执行，窗口会留下来，方便看输出。
   - **分组**：再加一个桶。已有的分组不会从界面上删掉；要删分组就直接改 JSON。

登录时启动默认是开的。设置球里的「登录时启动」，或者托盘菜单的同一项，可以关掉。这个开关走 Tauri 官方的 `tauri-plugin-autostart`，Windows 上写入当前用户的 Run 注册表项。偏好存在配置的 `autostart` 字段里，下次启动会按这个字段再同步一次，所以关掉之后不会被下一次启动悄悄打开。

## 配置

Windows 上文件在：

```text
%APPDATA%\PowerSphere\config.json
```

其他系统上开发时用 `$XDG_CONFIG_HOME/PowerSphere/config.json`，没有该变量时用 `~/.config/PowerSphere/config.json`。同级的 `plugins/` 目录先留着，给以后的 WASM 插件用。

第一次启动如果文件不存在，程序会写入下面这种空配置，而不是 `examples/config.example.json`：

```json
{
  "schemaVersion": 1,
  "autostart": true,
  "buckets": [
    { "id": "navigation", "name": "导航", "items": [] },
    { "id": "command", "name": "指令", "items": [] }
  ]
}
```

`schemaVersion` 必须是 `1`。缺了、不是整数、或者比程序认识的版本更新，程序不会覆盖原文件，界面上会提示，并且暂停写入。比 1 旧的版本会先走过 `config::migrate`（现在还是恒等变换），再解析。

JSON Schema 在 [`schema/powersphere.config.schema.json`](schema/powersphere.config.schema.json)。示例在 [`examples/config.example.json`](examples/config.example.json)，可以抄进自己的配置，但不要把它当成新安装的默认值。

配置里的命令会在本机执行。这个文件就是你的启动器，只放你信任的内容。

路径里可以写 `%USERPROFILE%` 或 `${USERPROFILE}`。Git Bash 的工作目录会转成 MSYS 路径（`C:\Users\me` 变成 `/c/Users/me`），因为 `bash -lc` 可能会把进程的当前目录重置掉。

### 打开文件夹

```json
{
  "id": "open-documents",
  "label": "文档",
  "type": "open-path",
  "target": "%USERPROFILE%\\Documents"
}
```

### 打开网址

```json
{
  "id": "open-tauri-docs",
  "label": "Tauri 文档",
  "type": "open-path",
  "target": "https://v2.tauri.app"
}
```

### 在 Git Bash 里跑 git

把 `cwd` 换成你的仓库目录。

```json
{
  "id": "git-status",
  "label": "git status",
  "type": "command",
  "shell": "git-bash",
  "cwd": "%USERPROFILE%\\src\\PowerSphere",
  "command": "git status --short"
}
```

`shell` 只接受 `git-bash`、`powershell`、`cmd`。Git Bash 的查找顺序是：

1. 配置里的 `gitBashPath`（填了但文件不存在会报错，不会悄悄换一个）
2. `%ProgramW6432%\Git\bin\bash.exe`
3. `%ProgramFiles%\Git\bin\bash.exe`
4. `%ProgramFiles(x86)%\Git\bin\bash.exe`
5. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
6. `%USERPROFILE%\scoop\apps\git\current\bin\bash.exe`
7. `C:\Program Files\Git\bin\bash.exe`
8. `C:\Program Files (x86)\Git\bin\bash.exe`

界面不写死具体工具。分组和动作都从这份 JSON 画出来，点击只调用 `run_item`。加号面板只负责采集 v1 的两种类型；新类型可以先写进 JSON，等对应 Runner 注册之后就能跑。

## Runner

核心只做窗口、托盘、开机启动、IPC，以及按 `type` 把一条配置交给 Runner。

```text
src-tauri/src/runner.rs          Runner / Host / RunnerRegistry
src-tauri/src/runners/mod.rs     内置 Runner 的注册表
src-tauri/src/runners/open_path.rs
src-tauri/src/runners/command.rs
src-tauri/src/plugins.rs         以后的 WASM 适配层（现在不加载）
```

`Host` 是 Runner 能使用的副作用：打开 URL、打开路径、启动进程。Runner 不直接碰窗口。测试可以用一个记录调用的 `Host`，不用把 Tauri 拉起来。

### 添加一个 Runner

例如以后要做 `adb-install`（选一个 APK 再安装），加一个新 Runner，而不是改窗口或配置加载：

1. 在 `src-tauri/src/runners/` 新建模块，实现 `Runner`：

```rust
impl Runner for AdbInstallRunner {
    fn type_id(&self) -> &'static str {
        "adb-install"
    }

    fn run(&self, ctx: &RunContext<'_>, item: &ToolItem) -> Result<RunOutput, RunError> {
        let _apk = item.params.get("apk");
        // 需要文件选择器时，给 Host 加一个带默认实现的方法，
        // 让现有的 Runner 和测试 Host 不用改。
        Ok(RunOutput { message: "已安装".into(), pid: None })
    }
}
```

2. 在 `register_builtins` 里 `registry.register(Box::new(AdbInstallRunner))`。
3. 在 JSON Schema 里为 `"type": "adb-install"` 补上字段说明。未知字段现在会被保留，不会在保存时丢掉。
4. 如果希望加号面板能创建它，再在 `src/lib/AddPanel.svelte` 加一个表单分支。只写 JSON 也可以，界面会照常把 `label` 画成小球。

### WASM

`plugins.rs` 里写了计划中的加载方式，v1 不实现。插件文件放在配置目录的 `plugins/*.wasm`，导出和 `Runner` 相同的 `type-id` + `run`。宿主把它们注册进同一个 `RunnerRegistry`，所以配置、IPC 和界面都不用为插件分叉。插件要打开文件或启动进程时，仍然走 `Host`。

## 发布

发布前把这三处版本改成同一个号，例如 `0.1.0`：

- `package.json` 的 `version`
- `src-tauri/Cargo.toml` 的 `version`
- `src-tauri/tauri.conf.json` 的 `version`

然后打 tag 并推送：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` 会在 `windows-latest` 上构建 NSIS 安装包，并把 release 目录里的 exe 打成 `PowerSphere-v0.1.0-windows-x64-portable.zip`，附到 GitHub Release。

现在不做代码签名。用户可能会看到 SmartScreen 提示。以后可以在 `src-tauri/tauri.conf.json` 的 `bundle.windows` 里加 `certificateThumbprint`，或者加 `signCommand`（参数里用 `%1` 表示待签名文件）。不要把证书放进仓库。

拉取请求和推送到 `main` 时，`.github/workflows/ci.yml` 会跑前端的 lint、类型检查、构建，以及 Tauri crate 的 `cargo check`、`cargo test` 和 `clippy`。这些跑在 Linux 上，不要求本机或 CI 做出 Windows 安装包。

## 目录

```text
src/                         Svelte 5 界面
src/lib/layout.ts            球体布局（窗口只包住这些球）
src/lib/api.ts               前端 IPC
src-tauri/src/               Rust 核心
src-tauri/capabilities/      Tauri 权限
src-tauri/icons/source.png   图标源图。重新生成：`pnpm tauri icon src-tauri/icons/source.png -o src-tauri/icons`
schema/                      配置 JSON Schema
examples/config.example.json 示例配置，不是首次安装的默认值
.github/workflows/ci.yml
.github/workflows/release.yml
```

## 许可

[GNU GPL v3](LICENSE)。

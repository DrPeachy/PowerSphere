import { mergePlaceholders, parseTemplate, substituteCommand } from "./template";
import type {
  AppConfig,
  AppSnapshot,
  NewTool,
  PlaceholderSpec,
  RunOutput,
  StyleSettings,
  ToolItem,
} from "./types";

const FALLBACK: AppConfig = {
  schemaVersion: 1,
  autostart: true,
  gitBashPath: null,
  anchor: null,
  style: {
    snapInset: 16,
    gap: 12,
    sphereSize: 64,
    animationMs: 220,
    unfocusedOpacity: 0.38,
  },
  buckets: [
    { id: "navigation", name: "导航", items: [] },
    {
      id: "command",
      name: "指令",
      items: [
        {
          id: "preview-merge",
          label: "merge",
          type: "command",
          shell: "git-bash",
          command: "git merge {branch} --verbose",
          placeholders: [{ name: "branch", kind: "text", recent: ["main"] }],
        },
        {
          id: "preview-apk",
          label: "安装",
          type: "command",
          shell: "cmd",
          command: "adb install {apk}",
          placeholders: [{ name: "apk", kind: "file", recent: [] }],
        },
        {
          id: "preview-bat",
          label: "备份",
          type: "bat",
          target: "C:\\Scripts\\backup.bat",
          args: "",
        },
      ],
    },
  ],
};

const preview: AppConfig = structuredClone(FALLBACK);
let previewSeq = 1;

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function messageFrom(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "操作失败";
}

export async function getSnapshot(): Promise<AppSnapshot> {
  if (!inTauri()) {
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("get_snapshot");
}

export async function addBucket(name: string): Promise<AppSnapshot> {
  if (!inTauri()) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("分组名称不能为空");
    }
    preview.buckets.push({ id: `bucket-preview-${previewSeq++}`, name: trimmed, items: [] });
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("add_bucket", { name });
}

export async function addTool(bucketId: string, tool: NewTool): Promise<AppSnapshot> {
  if (!inTauri()) {
    const bucket = preview.buckets.find((entry) => entry.id === bucketId);
    if (!bucket) {
      throw new Error("找不到分组");
    }
    bucket.items.push({
      id: `item-preview-${previewSeq++}`,
      label: tool.label,
      type: tool.type,
      icon: tool.icon,
      ...storedFields(tool),
    });
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("add_tool", { bucketId, tool });
}

export async function updateTool(
  bucketId: string,
  itemId: string,
  tool: NewTool,
): Promise<AppSnapshot> {
  if (!inTauri()) {
    const bucket = preview.buckets.find((entry) => entry.id === bucketId);
    const item = bucket?.items.find((entry) => entry.id === itemId);
    if (!bucket || !item) {
      throw new Error("找不到工具");
    }
    Object.assign(item, {
      label: tool.label,
      type: tool.type,
      icon: tool.icon,
      target: undefined,
      shell: undefined,
      cwd: undefined,
      command: undefined,
      args: undefined,
      placeholders: undefined,
      ...storedFields(tool),
    });
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("update_tool", { bucketId, itemId, tool });
}

export async function removeTool(bucketId: string, itemId: string): Promise<AppSnapshot> {
  if (!inTauri()) {
    const bucket = preview.buckets.find((entry) => entry.id === bucketId);
    if (!bucket) {
      throw new Error("找不到分组");
    }
    bucket.items = bucket.items.filter((item) => item.id !== itemId);
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("remove_tool", { bucketId, itemId });
}

export async function updateSettings(settings: {
  autostart: boolean;
  gitBashPath: string | null;
}): Promise<AppSnapshot> {
  if (!inTauri()) {
    preview.autostart = settings.autostart;
    preview.gitBashPath = settings.gitBashPath;
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("update_settings", { settings });
}

export async function updateStyle(style: StyleSettings): Promise<AppSnapshot> {
  if (!inTauri()) {
    preview.style = { ...style };
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("update_style", { style });
}

let dialogDepth = 0;

export function isNativeDialogOpen(): boolean {
  return dialogDepth > 0;
}

export async function pickPath(
  directory: boolean,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (!inTauri()) {
    dialogDepth += 1;
    try {
      const value = window.prompt(directory ? "文件夹路径" : "文件路径");
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    } finally {
      dialogDepth -= 1;
    }
  }
  dialogDepth += 1;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory,
      multiple: false,
      filters: filters && filters.length > 0 ? filters : undefined,
    });
    if (selected === null) {
      return null;
    }
    return Array.isArray(selected) ? selected[0] : selected;
  } finally {
    dialogDepth -= 1;
  }
}

export async function setShellBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
  preserveClient: boolean;
}): Promise<void> {
  if (!inTauri()) {
    return;
  }
  await invoke("set_shell_bounds", { ...bounds });
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  return invoke("cursor_position");
}

export async function setHitRects(
  rects: { x: number; y: number; w: number; h: number; round: boolean }[],
  generation: number,
): Promise<void> {
  if (!inTauri()) {
    return;
  }
  await invoke("set_hit_rects", { rects, generation });
}

export async function setAnchor(anchor: { x: number; y: number }): Promise<void> {
  if (!inTauri()) {
    preview.anchor = anchor;
    return;
  }
  await invoke("set_anchor", anchor);
}

export async function runFilled(
  bucketId: string,
  itemId: string,
  values: Record<string, string>,
): Promise<RunOutput> {
  if (!inTauri()) {
    const bucket = preview.buckets.find((entry) => entry.id === bucketId);
    const item = bucket?.items.find((entry) => entry.id === itemId);
    if (!item?.command) {
      throw new Error("找不到指令");
    }
    const specs = mergePlaceholders(item.command, item.placeholders);
    for (const spec of specs) {
      const value = values[spec.name]?.trim();
      if (!value) {
        throw new Error(`请填写 ${spec.name}`);
      }
      const recent = [value, ...(spec.recent ?? []).filter((entry) => entry !== value)].slice(0, 8);
      spec.recent = recent;
    }
    item.placeholders = specs;
    const command = substituteCommand(item.command, values, specs, item.shell ?? "cmd");
    if (parseTemplate(command).length > 0) {
      throw new Error("还有未填写的参数");
    }
    return { message: `预览：${command}`, pid: null };
  }
  return invoke<RunOutput>("run_filled", { bucketId, itemId, values });
}

export async function runItem(bucketId: string, itemId: string): Promise<RunOutput> {
  if (!inTauri()) {
    return { message: "预览模式不会真正执行", pid: null };
  }
  return invoke<RunOutput>("run_item", { bucketId, itemId });
}

function storedFields(tool: NewTool): Partial<ToolItem> {
  if (tool.type === "open-path") {
    return { target: tool.target };
  }
  if (tool.type === "bat") {
    return { target: tool.target, cwd: tool.cwd, args: tool.args };
  }
  return {
    shell: tool.shell,
    cwd: tool.cwd,
    command: tool.command,
    placeholders: plainPlaceholders(tool.placeholders),
  };
}

function plainPlaceholders(specs: PlaceholderSpec[] | undefined): PlaceholderSpec[] | undefined {
  return specs?.map((spec) => ({
    name: spec.name,
    kind: spec.kind,
    recent: [...(spec.recent ?? [])],
  }));
}

function previewSnapshot(): AppSnapshot {
  return {
    config: structuredClone(preview),
    warning: null,
    configPath: "预览模式（未连接 Tauri）",
    gitBashDetected: null,
    gitBashError: null,
  };
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

import type { AppConfig, AppSnapshot, NewTool, RunOutput } from "./types";

const FALLBACK: AppConfig = {
  schemaVersion: 1,
  autostart: true,
  gitBashPath: null,
  anchor: null,
  buckets: [
    { id: "navigation", name: "导航", items: [] },
    { id: "command", name: "指令", items: [] },
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
      ...(tool.type === "open-path"
        ? { target: tool.target }
        : { shell: tool.shell, cwd: tool.cwd, command: tool.command }),
    });
    return previewSnapshot();
  }
  return invoke<AppSnapshot>("add_tool", { bucketId, tool });
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

export async function setAnchor(anchor: { x: number; y: number }): Promise<void> {
  if (!inTauri()) {
    preview.anchor = anchor;
    return;
  }
  await invoke("set_anchor", anchor);
}

export async function runItem(bucketId: string, itemId: string): Promise<RunOutput> {
  if (!inTauri()) {
    return { message: "预览模式不会真正执行", pid: null };
  }
  return invoke<RunOutput>("run_item", { bucketId, itemId });
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

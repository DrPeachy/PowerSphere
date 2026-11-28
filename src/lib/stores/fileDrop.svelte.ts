import { addTool, inTauri, messageFrom } from "../api";
import {
  batchBucket,
  isBatchPath,
  labelFromPath,
  navigationBucket,
  normalizePath,
  overMainSphere,
  usedTargets,
} from "../fileDrop";
import { appConfig } from "./appConfig.svelte";
import { cluster } from "./cluster.svelte";
import { shellMotion } from "./shellMotion.svelte";

function toClientPoint(physicalX: number, physicalY: number): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return { x: physicalX / scale, y: physicalY / scale };
}

class FileDropStore {
  fileOver = $state(false);
  fileDragActive = false;

  noteFileDrag(kind: string, paths: string[] = [], physicalX = 0, physicalY = 0): void {
    if (shellMotion.snapping) {
      if (kind === "leave" || kind === "drop") {
        this.fileDragActive = false;
        this.fileOver = false;
      }
      return;
    }
    if (kind === "leave") {
      this.fileDragActive = false;
      this.fileOver = false;
      cluster.scheduleCollapse(true);
      return;
    }
    const point = toClientPoint(physicalX, physicalY);
    const hot = !shellMotion.dragging && overMainSphere(point.x, point.y);
    this.fileDragActive = kind !== "drop";
    this.fileOver = hot && kind !== "drop";
    if (hot && kind !== "drop") {
      cluster.showBuckets();
    }
    if (kind === "drop") {
      this.fileDragActive = false;
      this.fileOver = false;
      if (hot) {
        void this.acceptDroppedFiles(paths);
      }
    }
  }

  onFileDragOver = (event: DragEvent): void => {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    const hot = overMainSphere(event.clientX, event.clientY);
    if (!hot) {
      if (!inTauri()) {
        this.fileOver = false;
      }
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    this.fileOver = true;
    cluster.showBuckets();
  };

  onFileDrop = (event: DragEvent): void => {
    if (shellMotion.snapping) {
      return;
    }
    const hot = overMainSphere(event.clientX, event.clientY);
    if (!hot) {
      this.fileOver = false;
      return;
    }
    event.preventDefault();
    this.fileOver = false;
    this.fileDragActive = false;
    if (inTauri()) {
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    void this.acceptDroppedFiles(
      files.map((file) => {
        const withPath = file as File & { path?: string };
        return withPath.path || file.name;
      }),
    );
  };

  async acceptDroppedFiles(paths: string[]): Promise<void> {
    const list = appConfig.buckets;
    const nav = navigationBucket(list);
    const scripts = batchBucket(list);
    if (!nav || !scripts) {
      appConfig.showNotice("还没有可以放入的分组");
      return;
    }
    const seen = usedTargets(list);
    let added = 0;
    let skipped = 0;
    let latest = appConfig.snapshot;
    for (const raw of paths) {
      const target = raw.trim();
      if (!target) {
        continue;
      }
      const key = normalizePath(target);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const label = labelFromPath(target);
      const tool = isBatchPath(target)
        ? { type: "bat" as const, label, target }
        : { type: "open-path" as const, label, target };
      try {
        latest = await addTool(isBatchPath(target) ? scripts.id : nav.id, tool);
        added += 1;
      } catch (cause) {
        appConfig.showNotice(messageFrom(cause));
        return;
      }
    }
    if (latest) {
      appConfig.setSnapshot(latest);
    }
    if (added > 0 && skipped > 0) {
      appConfig.showNotice(`已添加 ${added} 个，跳过 ${skipped} 个重复`);
    } else if (added > 0) {
      appConfig.showNotice(added === 1 ? "已添加到球体" : `已添加 ${added} 个`);
    } else if (skipped > 0) {
      appConfig.showNotice("这些文件已经在列表里");
    }
  }

  async listenTauriDrops(): Promise<() => void> {
    if (!inTauri()) {
      return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const stopDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") {
        this.noteFileDrag("leave");
        return;
      }
      this.noteFileDrag(
        payload.type,
        "paths" in payload ? payload.paths : [],
        payload.position.x,
        payload.position.y,
      );
    });
    const unlistenFileDrag = await listen<{
      kind: "enter" | "over" | "drop" | "leave";
      paths: string[];
      x: number;
      y: number;
    }>("powersphere://file-drag", (event) => {
      const payload = event.payload;
      this.noteFileDrag(payload.kind, payload.paths, payload.x, payload.y);
    });
    return () => {
      stopDrop();
      unlistenFileDrag();
    };
  }
}

export const fileDrop = new FileDropStore();

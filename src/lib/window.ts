import { cursorPosition, inTauri, setShellBounds } from "./api";
import { windowOrigin, type Layout } from "./layout";
import type { Anchor } from "./types";

interface ShellBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  preserveClient: boolean;
}

let dragLock = false;
let suppressMoves = 0;
let inflight = false;
let pending: ShellBounds | null = null;
let applied: ShellBounds | null = null;
let waiters: Array<() => void> = [];

export function setDragLock(locked: boolean): void {
  dragLock = locked;
}

function movesIgnored(): boolean {
  return dragLock || suppressMoves > 0 || inflight || pending !== null;
}

function sameBounds(a: ShellBounds, b: ShellBounds): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function shellBounds(layout: Layout, anchor: Anchor, preserveClient: boolean): ShellBounds {
  const origin = windowOrigin(layout, anchor);
  return {
    x: origin.x,
    y: origin.y,
    width: layout.width,
    height: layout.height,
    preserveClient,
  };
}

function rememberMove(): void {
  suppressMoves += 1;
  setTimeout(() => {
    suppressMoves = Math.max(0, suppressMoves - 1);
  }, 80);
}

function finishWaiters(): void {
  const done = waiters;
  waiters = [];
  for (const resolve of done) {
    resolve();
  }
}

function pump(): void {
  if (inflight || !pending) {
    return;
  }
  const bounds = pending;
  pending = null;
  if (applied && sameBounds(applied, bounds)) {
    if (pending) {
      pump();
      return;
    }
    finishWaiters();
    return;
  }
  inflight = true;
  void setShellBounds(bounds)
    .catch(() => {})
    .finally(() => {
      applied = bounds;
      inflight = false;
      rememberMove();
      if (pending) {
        pump();
        return;
      }
      finishWaiters();
    });
}

/**
 * Move and resize the shell to the latest layout only.
 * Older in-flight positions are dropped so a slow IPC cannot snap the sphere backwards.
 */
export function syncWindow(layout: Layout, anchor: Anchor, preserveClient = true): Promise<void> {
  if (!inTauri()) {
    return Promise.resolve();
  }
  const next = shellBounds(layout, anchor, preserveClient);
  if (applied && sameBounds(applied, next) && !pending && !inflight) {
    return Promise.resolve();
  }
  pending = next;
  return new Promise((resolve) => {
    waiters.push(resolve);
    pump();
  });
}

export async function readCursor(): Promise<{ x: number; y: number } | null> {
  if (!inTauri()) {
    return null;
  }
  try {
    return await cursorPosition();
  } catch {
    return null;
  }
}

export async function readWorkArea(): Promise<{
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null> {
  if (!inTauri()) {
    return null;
  }
  const { currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  if (!monitor) {
    return null;
  }
  const scale = monitor.scaleFactor || 1;
  const left = monitor.workArea.position.x / scale;
  const top = monitor.workArea.position.y / scale;
  return {
    left,
    top,
    right: left + monitor.workArea.size.width / scale,
    bottom: top + monitor.workArea.size.height / scale,
  };
}

export async function defaultAnchor(): Promise<Anchor> {
  const area = await readWorkArea();
  if (!area) {
    return { x: 180, y: 220 };
  }
  return {
    x: area.right - 80,
    y: (area.top + area.bottom) / 2,
  };
}

export async function installMoveSaver(
  getLayout: () => Layout,
  anchor: Anchor,
  save: (next: Anchor) => Promise<void>,
): Promise<() => void> {
  if (!inTauri()) {
    return () => {};
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisten = await win.onMoved(async () => {
    if (movesIgnored()) {
      return;
    }
    const position = await win.outerPosition();
    if (movesIgnored()) {
      return;
    }
    const scale = await win.scaleFactor();
    const layout = getLayout();
    const next = {
      x: position.x / scale + layout.mainCx,
      y: position.y / scale + layout.mainCy,
    };
    if (Math.hypot(next.x - anchor.x, next.y - anchor.y) < 1.5) {
      return;
    }
    anchor.x = next.x;
    anchor.y = next.y;
    if (timer) {
      clearTimeout(timer);
    }
    const saved = { x: anchor.x, y: anchor.y };
    timer = setTimeout(() => {
      void save(saved).catch(() => {});
    }, 280);
  });
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    unlisten();
  };
}

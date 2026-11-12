import { inTauri } from "./api";
import type { Layout } from "./layout";
import type { Anchor } from "./types";

let programmaticMoves = 0;

export async function defaultAnchor(): Promise<Anchor> {
  const { currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  if (!monitor) {
    return { x: 180, y: 220 };
  }
  const scale = monitor.scaleFactor || 1;
  const left = monitor.workArea.position.x / scale;
  const top = monitor.workArea.position.y / scale;
  const width = monitor.workArea.size.width / scale;
  const height = monitor.workArea.size.height / scale;
  return {
    x: left + width - 72,
    y: top + height / 2,
  };
}

export async function syncWindow(layout: Layout, anchor: Anchor): Promise<void> {
  if (!inTauri()) {
    return;
  }
  const { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize, primaryMonitor } =
    await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  let x = anchor.x - layout.main.cx;
  let y = anchor.y - layout.main.cy;
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  if (monitor) {
    const scale = monitor.scaleFactor || 1;
    const left = monitor.workArea.position.x / scale;
    const top = monitor.workArea.position.y / scale;
    const right = left + monitor.workArea.size.width / scale;
    const bottom = top + monitor.workArea.size.height / scale;
    x = clamp(x, left, Math.max(left, right - layout.width));
    y = clamp(y, top, Math.max(top, bottom - layout.height));
  }
  programmaticMoves += 1;
  try {
    await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    await win.setSize(new LogicalSize(layout.width, layout.height));
    await win.show();
  } finally {
    window.setTimeout(() => {
      programmaticMoves = Math.max(0, programmaticMoves - 1);
    }, 180);
  }
}

export async function installMoveSaver(
  getLayout: () => Layout,
  anchor: Anchor,
  save: (anchor: Anchor) => Promise<void>,
): Promise<() => void> {
  if (!inTauri()) {
    return () => {};
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unlisten = await win.onMoved(async () => {
    if (programmaticMoves > 0) {
      return;
    }
    const position = await win.outerPosition();
    const scale = await win.scaleFactor();
    const layout = getLayout();
    anchor.x = position.x / scale + layout.main.cx;
    anchor.y = position.y / scale + layout.main.cy;
    if (timer) {
      clearTimeout(timer);
    }
    const next = { x: anchor.x, y: anchor.y };
    timer = setTimeout(() => {
      void save(next).catch(() => {});
    }, 280);
  });
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    unlisten();
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

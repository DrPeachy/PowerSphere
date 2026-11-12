import { inTauri, setShellBounds } from "./api";
import { windowOrigin, type Layout } from "./layout";
import type { Anchor } from "./types";

let ticket = 0;
let ignoreMovesUntil = 0;

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

export async function syncWindow(layout: Layout, anchor: Anchor): Promise<void> {
  if (!inTauri()) {
    return;
  }
  const origin = windowOrigin(layout, anchor);
  const mine = ++ticket;
  ignoreMovesUntil = Date.now() + 120;
  await setShellBounds({
    x: origin.x,
    y: origin.y,
    width: layout.width,
    height: layout.height,
  });
  if (mine === ticket) {
    ignoreMovesUntil = Date.now() + 80;
  }
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
    if (Date.now() < ignoreMovesUntil) {
      return;
    }
    const position = await win.outerPosition();
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

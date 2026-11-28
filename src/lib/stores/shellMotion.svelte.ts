import { tick } from "svelte";
import {
  animateShellPosition,
  inTauri,
  setAnchor,
  setHitRects,
  setInputSuspended,
  setPointerHold,
} from "../api";
import { setGlassAway, setGlassDrag } from "../glassGl";
import {
  computeLayout,
  hitShapes,
  pinShift,
  windowOrigin,
  type Layout,
} from "../layout";
import { choosePlacement, snapAnchor, type Placement, type WorkArea } from "../placement";
import {
  bumpShellEpoch,
  defaultAnchor,
  installMoveSaver,
  noteShellApplied,
  readCursor,
  readWorkArea,
  setDragLock,
  syncWindow,
} from "../window";
import { appConfig } from "./appConfig.svelte";
import { cluster } from "./cluster.svelte";
import { fileDrop } from "./fileDrop.svelte";

interface DragState {
  pointerId: number;
  sx: number;
  sy: number;
  lastSx: number;
  lastSy: number;
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  grabX: number;
  grabY: number;
  os: boolean;
  moved: boolean;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function viewportWork(): WorkArea {
  return {
    left: 8,
    top: 8,
    right: Math.max(200, window.innerWidth - 8),
    bottom: Math.max(200, window.innerHeight - 8),
  };
}

class ShellMotionStore {
  readonly preview = !inTauri();
  private readonly snapGlideMs = 180;

  ready = $state(false);
  dragging = $state(false);
  snapping = $state(false);
  anchor = $state({ x: 180, y: 220 });
  work = $state<WorkArea>({ left: 0, top: 0, right: 1280, bottom: 800 });
  lockedPlacement = $state<Placement | null>(null);
  pin = $state({ x: 0, y: 0 });
  holding = $state(false);
  nativeHover = $state<boolean | null>(null);

  placement = $derived(
    this.lockedPlacement ??
      choosePlacement(this.anchor, this.work, appConfig.buckets.length + 1, appConfig.metrics),
  );
  layout: Layout = $derived(
    computeLayout(
      appConfig.buckets,
      cluster.mode,
      cluster.activeBucketId,
      cluster.panelSize,
      appConfig.metrics,
      this.placement,
      appConfig.clockOn,
    ),
  );
  origin = $derived(windowOrigin(this.layout, this.anchor));
  shown = $derived.by(() => {
    const live = this.layout.nodes.map((node) => ({
      ...node,
      open:
        node.kind === "main" ||
        (node.kind === "action" ? cluster.mode === "actions" : cluster.mode !== "idle"),
    }));
    const keys = new Set(live.map((node) => node.key));
    const extra = cluster.ghostActions
      .filter((node) => !keys.has(node.key))
      .map((node) => ({ ...node, open: false }));
    return [...live, ...extra];
  });
  noticePos = $derived.by(() => {
    const gap = 8;
    const radius = appConfig.metrics.main / 2;
    if (this.placement.along === "up") {
      return {
        left: this.layout.mainCx,
        top: this.layout.mainCy + radius + gap,
        transform: "translate(-50%, 0)",
      };
    }
    if (this.placement.along === "down") {
      return {
        left: this.layout.mainCx,
        top: this.layout.mainCy - radius - gap,
        transform: "translate(-50%, -100%)",
      };
    }
    if (this.placement.along === "left") {
      return {
        left: this.layout.mainCx + radius + gap,
        top: this.layout.mainCy,
        transform: "translate(0, -50%)",
      };
    }
    return {
      left: this.layout.mainCx - radius - gap,
      top: this.layout.mainCy,
      transform: "translate(-100%, -50%)",
    };
  });

  private drag: DragState | null = null;
  private cursorBusy = false;
  private cursorAgain = false;
  private suppressClick = false;
  private pinX = 0;
  private pinY = 0;
  private placed: { cx: number; cy: number; w: number; h: number } | null = null;
  private layoutGen = 0;
  private hitKey = "";
  private hitGen = 0;
  private snapKey = "";

  syncLayoutEffect(): void {
    if (!this.ready || this.preview || this.snapping) {
      return;
    }
    const next = this.layout;
    const point = { x: this.anchor.x, y: this.anchor.y };
    const gen = ++this.layoutGen;
    const shift = pinShift(
      this.placed ? { mainCx: this.placed.cx, mainCy: this.placed.cy } : null,
      next,
    );
    const resized =
      this.placed !== null && (this.placed.w !== next.width || this.placed.h !== next.height);
    const shouldHold = shift.x !== 0 || shift.y !== 0 || resized;
    if (shift.x !== this.pinX || shift.y !== this.pinY) {
      this.pinX = shift.x;
      this.pinY = shift.y;
      this.pin = shift;
    }
    if (shouldHold) {
      this.holding = true;
      cluster.pointerInside = true;
      cluster.clearCollapseTimer();
      if (this.nativeHover === false) {
        cluster.collapseAfterHold = true;
      }
    }
    const preserveClient = shift.x === 0 && shift.y === 0;
    void syncWindow(next, point, preserveClient).finally(() => {
      if (gen !== this.layoutGen) {
        return;
      }
      this.placed = { cx: next.mainCx, cy: next.mainCy, w: next.width, h: next.height };
      if (this.pinX !== 0 || this.pinY !== 0) {
        this.pinX = 0;
        this.pinY = 0;
        this.pin = { x: 0, y: 0 };
      }
      if (shouldHold) {
        this.holding = false;
        if (!cluster.flushCollapseAfterHold()) {
          void this.settleHover();
        }
      }
    });
  }

  publishHits(shapes: ReturnType<typeof hitShapes>, key: string): void {
    if (key === this.hitKey) {
      return;
    }
    this.hitKey = key;
    void setHitRects(shapes, ++this.hitGen);
  }

  flushHits = (): void => {
    if (!this.ready || this.preview || this.snapping) {
      return;
    }
    const shapes = hitShapes(
      this.layout,
      cluster.mode,
      cluster.panelSize !== null,
      appConfig.metrics.label,
    );
    this.publishHits(shapes, JSON.stringify(shapes));
  };

  publishHitsEffect(): (() => void) | void {
    if (!this.ready || this.preview || this.snapping) {
      return;
    }
    const shapes = hitShapes(
      this.layout,
      cluster.mode,
      cluster.panelSize !== null,
      appConfig.metrics.label,
    );
    const key = JSON.stringify(shapes);
    const timer = setTimeout(() => this.publishHits(shapes, key), 32);
    return () => clearTimeout(timer);
  }

  snapToWorkAreaEffect(): void {
    const m = appConfig.metrics;
    const key = `${m.snapInset}:${m.main}:${this.work.left}:${this.work.top}:${this.work.right}:${this.work.bottom}`;
    if (!this.ready || this.dragging || this.snapping) {
      return;
    }
    if (this.snapKey === key) {
      return;
    }
    this.snapKey = key;
    const snapped = snapAnchor(this.anchor, this.work, m.snapInset, m.main / 2);
    if (Math.abs(snapped.x - this.anchor.x) < 0.5 && Math.abs(snapped.y - this.anchor.y) < 0.5) {
      return;
    }
    this.anchor.x = snapped.x;
    this.anchor.y = snapped.y;
    void setAnchor({ x: this.anchor.x, y: this.anchor.y }).catch(() => {});
  }

  initPreview(): () => void {
    this.work = viewportWork();
    this.anchor.x = Math.max(120, window.innerWidth - 88);
    this.anchor.y = window.innerHeight / 2;
    const snapped = snapAnchor(
      this.anchor,
      this.work,
      appConfig.metrics.snapInset,
      appConfig.metrics.main / 2,
    );
    this.anchor.x = snapped.x;
    this.anchor.y = snapped.y;
    const onResize = () => {
      this.work = viewportWork();
    };
    window.addEventListener("resize", onResize);
    this.ready = true;
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }

  async initTauriAnchor(savedAnchor?: { x: number; y: number } | null): Promise<void> {
    const area = await readWorkArea();
    if (area) {
      this.work = area;
    }
    if (savedAnchor) {
      this.anchor.x = savedAnchor.x;
      this.anchor.y = savedAnchor.y;
    } else {
      const initial = await defaultAnchor();
      this.anchor.x = initial.x;
      this.anchor.y = initial.y;
    }
    const snapped = snapAnchor(
      this.anchor,
      this.work,
      appConfig.metrics.snapInset,
      appConfig.metrics.main / 2,
    );
    this.anchor.x = snapped.x;
    this.anchor.y = snapped.y;
    await setAnchor({ x: this.anchor.x, y: this.anchor.y });
  }

  async listenTauriEvents(): Promise<() => void> {
    if (this.preview) {
      return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const stopMoves = await installMoveSaver(
      () => this.layout,
      this.anchor,
      async (next) => {
        this.anchor.x = next.x;
        this.anchor.y = next.y;
        await setAnchor(next);
      },
    );
    const unlistenHover = await listen<{ inside: boolean }>("powersphere://hover", (event) => {
      this.onNativeHover(event.payload.inside);
    });
    const stopFocus = await getCurrentWindow().onFocusChanged((event) => {
      if (!event.payload) {
        cluster.dismissPanelsFromOutside();
      }
    });
    return () => {
      stopMoves();
      unlistenHover();
      stopFocus();
    };
  }

  onNativeHover(inside: boolean): void {
    if (this.nativeHover === inside) {
      return;
    }
    this.nativeHover = inside;
    setGlassAway(!inside);
    if (inside) {
      cluster.cancelCollapse();
    } else {
      cluster.scheduleCollapse();
    }
  }

  onStageEnter = (): void => {
    if (this.nativeHover === false) {
      return;
    }
    cluster.cancelCollapse();
  };

  onStageLeave = (): void => {
    cluster.scheduleCollapse();
  };

  async settleHover(): Promise<void> {
    if (this.preview || this.dragging || this.holding || cluster.hasOpenPanel) {
      return;
    }
    const cursor = await readCursor();
    if (this.dragging || this.holding || cluster.hasOpenPanel) {
      return;
    }
    if (!cursor) {
      return;
    }
    const originNow = windowOrigin(this.layout, this.anchor);
    const margin = 12;
    const inside =
      cursor.x >= originNow.x - margin &&
      cursor.x <= originNow.x + this.layout.width + margin &&
      cursor.y >= originNow.y - margin &&
      cursor.y <= originNow.y + this.layout.height + margin;
    if (!inside) {
      this.onNativeHover(false);
      cluster.scheduleCollapse(true);
    }
  }

  private screenDelta(event: PointerEvent): { x: number; y: number; useScreen: boolean } {
    if (!this.drag) {
      return { x: 0, y: 0, useScreen: false };
    }
    const screenDx = event.screenX - this.drag.sx;
    const screenDy = event.screenY - this.drag.sy;
    const useScreen = Math.hypot(screenDx, screenDy) > 0;
    const unit = !this.preview && useScreen ? window.devicePixelRatio || 1 : 1;
    return {
      x: useScreen ? screenDx / unit : event.clientX - this.drag.cx,
      y: useScreen ? screenDy / unit : event.clientY - this.drag.cy,
      useScreen,
    };
  }

  private async pullCursor(): Promise<void> {
    const current = this.drag;
    if (!current?.moved || !current.os) {
      return;
    }
    if (this.cursorBusy) {
      this.cursorAgain = true;
      return;
    }
    this.cursorBusy = true;
    try {
      const cursor = await readCursor();
      if (!cursor || this.snapping || this.drag !== current || !current.moved) {
        return;
      }
      this.anchor.x = cursor.x - current.grabX;
      this.anchor.y = cursor.y - current.grabY;
    } finally {
      this.cursorBusy = false;
      if (this.cursorAgain) {
        this.cursorAgain = false;
        if (!this.snapping && this.drag?.moved && this.drag.os) {
          void this.pullCursor();
        }
      }
    }
  }

  onMainPointerDown = (event: PointerEvent): void => {
    if (this.snapping || event.button !== 0 || fileDrop.fileDragActive) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    this.drag = {
      pointerId: event.pointerId,
      sx: event.screenX,
      sy: event.screenY,
      lastSx: event.screenX,
      lastSy: event.screenY,
      cx: event.clientX,
      cy: event.clientY,
      ax: this.anchor.x,
      ay: this.anchor.y,
      grabX: 0,
      grabY: 0,
      os: false,
      moved: false,
    };
    if (!this.preview) {
      const current = this.drag;
      void readCursor().then((cursor) => {
        if (!cursor || this.drag !== current) {
          return;
        }
        const unit = window.devicePixelRatio || 1;
        const screenNowX = current.lastSx / unit;
        const screenNowY = current.lastSy / unit;
        const screenDownX = current.sx / unit;
        const screenDownY = current.sy / unit;
        current.grabX = cursor.x - (screenNowX - screenDownX) - current.ax;
        current.grabY = cursor.y - (screenNowY - screenDownY) - current.ay;
        current.os = true;
        if (current.moved) {
          void this.pullCursor();
        }
      });
    }
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable for some synthetic events.
    }
    if (!this.preview) {
      void setPointerHold(true);
    }
  };

  onMainPointerMove = (event: PointerEvent): void => {
    if (this.snapping || !this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }
    this.drag.lastSx = event.screenX;
    this.drag.lastSy = event.screenY;
    const delta = this.screenDelta(event);
    if (!this.drag.moved && Math.hypot(delta.x, delta.y) < 4) {
      return;
    }
    if (!this.drag.moved) {
      this.drag.moved = true;
      this.dragging = true;
      cluster.collapseForDrag();
      this.lockedPlacement = this.placement;
      if (!this.preview) {
        setDragLock(true);
      }
    }
    setGlassDrag(true);
    if (!this.preview && this.drag.os) {
      void this.pullCursor();
      return;
    }
    this.anchor.x = this.drag.ax + delta.x;
    this.anchor.y = this.drag.ay + delta.y;
  };

  onMainPointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }
    if (!this.preview) {
      void setPointerHold(false);
    }
    const moved = this.drag.moved;
    this.drag = null;
    this.dragging = false;
    setGlassDrag(false);
    if (moved) {
      this.suppressClick = true;
      this.snapping = true;
      void this.finishDrag();
      return;
    }
    this.lockedPlacement = null;
  };

  private slidePin(dx: number, dy: number): { stop: () => void } {
    let stopped = false;
    const start = performance.now();
    const step = (now: number) => {
      if (stopped) {
        return;
      }
      const t = Math.min(1, (now - start) / this.snapGlideMs);
      const remain = 1 - easeOut(t);
      this.pinX = dx * remain;
      this.pinY = dy * remain;
      this.pin = { x: this.pinX, y: this.pinY };
      if (t < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
    return {
      stop: () => {
        stopped = true;
        this.pinX = 0;
        this.pinY = 0;
        this.pin = { x: 0, y: 0 };
      },
    };
  }

  private glidePreview(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / this.snapGlideMs);
        const eased = easeOut(t);
        this.anchor.x = from.x + (to.x - from.x) * eased;
        this.anchor.y = from.y + (to.y - from.y) * eased;
        if (t < 1) {
          requestAnimationFrame(step);
          return;
        }
        resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async finishDrag(): Promise<void> {
    const release = { x: this.anchor.x, y: this.anchor.y };
    let motion: { stop: () => void } | null = null;
    let settled = false;
    try {
      if (!this.preview) {
        await setInputSuspended(true);
        const area = await readWorkArea();
        if (area) {
          this.work = area;
        }
      }
      const m = appConfig.metrics;
      const snapped = snapAnchor(release, this.work, m.snapInset, m.main / 2);
      const nextPlacement = choosePlacement(
        snapped,
        this.work,
        appConfig.buckets.length + 1,
        m,
      );
      const previous = {
        cx: this.layout.mainCx,
        cy: this.layout.mainCy,
        w: this.layout.width,
        h: this.layout.height,
      };
      this.lockedPlacement = nextPlacement;
      if (this.preview) {
        const distance = Math.hypot(snapped.x - release.x, snapped.y - release.y);
        if (distance >= 1) {
          await this.glidePreview(release, snapped);
        }
        this.anchor.x = snapped.x;
        this.anchor.y = snapped.y;
        this.lockedPlacement = null;
        await setAnchor({ x: snapped.x, y: snapped.y }).catch(() => {});
        settled = true;
        return;
      }
      const next = this.layout;
      const dx = previous.cx - next.mainCx;
      const dy = previous.cy - next.mainCy;
      const offset = Math.hypot(dx, dy);
      const target = windowOrigin(next, snapped);
      const windowDelta = Math.hypot(
        target.x - (release.x - previous.cx),
        target.y - (release.y - previous.cy),
      );
      const glide = windowDelta >= 1 || offset >= 1;
      this.pinX = dx;
      this.pinY = dy;
      this.pin = { x: dx, y: dy };
      await tick();
      const epoch = bumpShellEpoch();
      if (offset >= 1) {
        motion = this.slidePin(dx, dy);
      }
      await animateShellPosition({
        x: target.x,
        y: target.y,
        width: next.width,
        height: next.height,
        durationMs: glide ? this.snapGlideMs : 1,
        epoch,
      });
      motion?.stop();
      motion = null;
      this.pinX = 0;
      this.pinY = 0;
      this.pin = { x: 0, y: 0 };
      this.anchor.x = snapped.x;
      this.anchor.y = snapped.y;
      this.lockedPlacement = null;
      const finalLayout = this.layout;
      const sameGeometry =
        finalLayout.mainCx === next.mainCx &&
        finalLayout.mainCy === next.mainCy &&
        finalLayout.width === next.width &&
        finalLayout.height === next.height;
      if (!sameGeometry) {
        this.lockedPlacement = nextPlacement;
      }
      const settledLayout = sameGeometry ? finalLayout : next;
      this.placed = {
        cx: settledLayout.mainCx,
        cy: settledLayout.mainCy,
        w: settledLayout.width,
        h: settledLayout.height,
      };
      noteShellApplied(settledLayout, snapped);
      await setAnchor({ x: snapped.x, y: snapped.y }).catch(() => {});
      settled = true;
    } finally {
      motion?.stop();
      if (!settled) {
        this.pinX = 0;
        this.pinY = 0;
        this.pin = { x: 0, y: 0 };
        this.lockedPlacement = null;
      }
      this.snapping = false;
      this.flushHits();
      if (!this.preview) {
        setDragLock(false);
        await setInputSuspended(false);
      }
    }
  }

  onMainClick = (): void => {
    if (this.snapping || this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    cluster.togglePanel();
  };
}

export const shellMotion = new ShellMotionStore();

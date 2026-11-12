import type { Bucket } from "./types";

export type ClusterMode = "idle" | "buckets" | "actions";
export type Edge = "left" | "right" | "top" | "bottom";
export type Dir = "up" | "down" | "left" | "right";

export interface WorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Metrics {
  main: number;
  gap: number;
  pad: number;
  label: number;
  snapInset: number;
  animationMs: number;
  unfocusedOpacity: number;
}

export interface Placement {
  edge: Edge;
  along: Dir;
  inward: Dir;
}

export interface SphereNode {
  key: string;
  kind: "main" | "bucket" | "action" | "settings";
  bucketId?: string;
  itemId?: string;
  label: string;
  icon?: string;
  left: number;
  top: number;
  size: number;
  delay: number;
  fromX: number;
  fromY: number;
}

export interface PanelBox {
  left: number;
  top: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  mainCx: number;
  mainCy: number;
  nodes: SphereNode[];
  panel: PanelBox | null;
  labelAbove: boolean;
}

export interface PanelSize {
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

const DEFAULT_METRICS: Metrics = {
  main: 64,
  gap: 12,
  pad: 16,
  label: 16,
  snapInset: 16,
  animationMs: 220,
  unfocusedOpacity: 0.38,
};

export function metricsFrom(style?: {
  snapInset?: number;
  gap?: number;
  sphereSize?: number;
  animationMs?: number;
  unfocusedOpacity?: number;
}): Metrics {
  return {
    main: clamp(style?.sphereSize ?? DEFAULT_METRICS.main, 44, 96),
    gap: clamp(style?.gap ?? DEFAULT_METRICS.gap, 0, 48),
    pad: DEFAULT_METRICS.pad,
    label: DEFAULT_METRICS.label,
    snapInset: clamp(style?.snapInset ?? DEFAULT_METRICS.snapInset, 0, 80),
    animationMs: clamp(style?.animationMs ?? DEFAULT_METRICS.animationMs, 0, 600),
    unfocusedOpacity: clamp(style?.unfocusedOpacity ?? DEFAULT_METRICS.unfocusedOpacity, 0.15, 1),
  };
}

export function bucketSize(metrics: Metrics): number {
  return Math.round(metrics.main * 0.8125);
}

export function actionSize(metrics: Metrics): number {
  return Math.round(metrics.main * 0.6875);
}

export function nearestEdge(anchor: Point, work: WorkArea): Edge {
  const scores: [Edge, number][] = [
    ["left", anchor.x - work.left],
    ["right", work.right - anchor.x],
    ["top", anchor.y - work.top],
    ["bottom", work.bottom - anchor.y],
  ];
  scores.sort((a, b) => a[1] - b[1]);
  return scores[0][0];
}

export function snapAnchor(
  point: Point,
  work: WorkArea,
  inset: number,
  radius: number,
): { x: number; y: number; edge: Edge } {
  const edge = nearestEdge(point, work);
  const minX = work.left + inset + radius;
  const maxX = Math.max(minX, work.right - inset - radius);
  const minY = work.top + inset + radius;
  const maxY = Math.max(minY, work.bottom - inset - radius);
  const x = clamp(point.x, minX, maxX);
  const y = clamp(point.y, minY, maxY);
  switch (edge) {
    case "left":
      return { x: minX, y, edge };
    case "right":
      return { x: maxX, y, edge };
    case "top":
      return { x, y: minY, edge };
    case "bottom":
      return { x, y: maxY, edge };
  }
}

export function inwardDir(edge: Edge): Dir {
  switch (edge) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "down";
    case "bottom":
      return "up";
  }
}

export function choosePlacement(
  anchor: Point,
  work: WorkArea,
  childCount: number,
  metrics: Metrics,
): Placement {
  const edge = nearestEdge(anchor, work);
  const verticalEdge = edge === "left" || edge === "right";
  const need = alongReach(childCount, metrics, verticalEdge);
  let along: Dir;
  if (verticalEdge) {
    const above = anchor.y - work.top;
    const below = work.bottom - anchor.y;
    along = above >= below ? "up" : "down";
    if (along === "up" && above < need && below >= need) {
      along = "down";
    } else if (along === "down" && below < need && above >= need) {
      along = "up";
    }
  } else {
    const left = anchor.x - work.left;
    const right = work.right - anchor.x;
    along = left >= right ? "left" : "right";
    if (along === "left" && left < need && right >= need) {
      along = "right";
    } else if (along === "right" && right < need && left >= need) {
      along = "left";
    }
  }
  return { edge, along, inward: inwardDir(edge) };
}

/** Largest editor. The window always reserves this slot so opening a panel does not move spheres. */
export const RESERVED_PANEL: PanelSize = { w: 300, h: 600 };

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  round: boolean;
}

export function computeLayout(
  buckets: Bucket[],
  mode: ClusterMode,
  activeBucketId: string | null,
  panel: PanelSize | null,
  metrics: Metrics,
  placement: Placement,
): Layout {
  const child = bucketSize(metrics);
  const action = actionSize(metrics);
  const labelAbove = placement.edge === "bottom";
  const showChildren = mode !== "idle";
  const active =
    mode === "actions" && !panel
      ? buckets.find((bucket) => bucket.id === activeBucketId)
      : undefined;
  const alongFrom = vector(placement.along);
  const inwardFrom = vector(placement.inward);
  const entries = [
    ...buckets.map((bucket) => ({
      key: `bucket:${bucket.id}`,
      kind: "bucket" as const,
      bucketId: bucket.id,
      label: bucket.name,
    })),
    { key: "settings", kind: "settings" as const, bucketId: "settings", label: "设置" },
  ];
  const children = entries.map((entry, index) => {
    const center = childCenter(index, placement.along, metrics.main / 2, child / 2, metrics);
    return { ...entry, cx: center.x, cy: center.y, size: child };
  });
  const boxes: Array<SphereNode & { cx: number; cy: number }> = [
    {
      key: "main",
      kind: "main",
      label: "",
      left: 0,
      top: 0,
      size: metrics.main,
      delay: 0,
      fromX: 0,
      fromY: 0,
      cx: 0,
      cy: 0,
    },
  ];
  if (showChildren) {
    for (const entry of children) {
      boxes.push({
        key: entry.key,
        kind: entry.kind,
        bucketId: entry.bucketId,
        label: entry.label,
        left: 0,
        top: 0,
        size: entry.size,
        delay: boxes.length,
        fromX: -alongFrom.x * 10,
        fromY: -alongFrom.y * 10,
        cx: entry.cx,
        cy: entry.cy,
      });
    }
  }
  if (active) {
    const host = children.find((entry) => entry.bucketId === active.id);
    active.items.forEach((item, index) => {
      const delta = childCenter(index, placement.inward, child / 2, action / 2, metrics);
      boxes.push({
        key: `action:${item.id}`,
        kind: "action",
        bucketId: active.id,
        itemId: item.id,
        label: item.label,
        icon: item.icon,
        left: 0,
        top: 0,
        size: action,
        delay: index,
        fromX: -inwardFrom.x * 10,
        fromY: -inwardFrom.y * 10,
        cx: (host?.cx ?? 0) + delta.x,
        cy: (host?.cy ?? 0) + delta.y,
      });
    });
  }

  const panelBox = panel
    ? placePanel(placement, metrics.main / 2, metrics.gap, panel.w, panel.h)
    : null;
  const reservedPanel = placePanel(
    placement,
    metrics.main / 2,
    metrics.gap,
    RESERVED_PANEL.w,
    RESERVED_PANEL.h,
  );

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (left: number, top: number, right: number, bottom: number) => {
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  };
  const occupy = (cx: number, cy: number, size: number, labeled: boolean) => {
    grow(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2);
    if (!labeled) {
      return;
    }
    const labelTop = labelAbove ? cy - size / 2 - metrics.label : cy + size / 2;
    grow(cx - 40, labelTop, cx + 40, labelTop + metrics.label);
  };
  occupy(0, 0, metrics.main, false);
  for (const entry of children) {
    occupy(entry.cx, entry.cy, entry.size, true);
  }
  const reach = maxActionCount(buckets);
  if (reach > 0) {
    const delta = childCenter(reach - 1, placement.inward, child / 2, action / 2, metrics);
    for (const entry of children) {
      if (entry.kind !== "bucket") {
        continue;
      }
      occupy(entry.cx + delta.x, entry.cy + delta.y, action, true);
    }
  }
  grow(reservedPanel.x, reservedPanel.y, reservedPanel.x + reservedPanel.w, reservedPanel.y + reservedPanel.h);
  minX -= metrics.pad;
  minY -= metrics.pad;
  maxX += metrics.pad;
  maxY += metrics.pad;

  const nodes: SphereNode[] = boxes.map((box) => ({
    key: box.key,
    kind: box.kind,
    bucketId: box.bucketId,
    itemId: box.itemId,
    label: box.label,
    icon: box.icon,
    left: box.cx - box.size / 2 - minX,
    top: box.cy - box.size / 2 - minY,
    size: box.size,
    delay: box.delay,
    fromX: box.fromX,
    fromY: box.fromY,
  }));

  return {
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
    mainCx: 0 - minX,
    mainCy: 0 - minY,
    nodes,
    panel: panelBox
      ? {
          left: panelBox.x - minX,
          top: panelBox.y - minY,
          w: panelBox.w,
          h: panelBox.h,
        }
      : null,
    labelAbove,
  };
}

export function hitRects(layout: Layout, mode: ClusterMode, panelOpen: boolean): HitRect[] {
  const pad = 16;
  const rects: HitRect[] = [];
  const main = layout.nodes.find((node) => node.kind === "main");
  if (main) {
    rects.push(ellipse(main.left, main.top, main.size, pad));
  }
  if (mode !== "idle") {
    const kids = layout.nodes.filter((node) => node.kind === "bucket" || node.kind === "settings");
    const box = unionRect(kids, pad);
    if (box) {
      rects.push({ ...box, round: false });
    }
  }
  if (mode === "actions") {
    const actions = layout.nodes.filter((node) => node.kind === "action");
    const box = unionRect(actions, pad);
    if (box) {
      rects.push({ ...box, round: false });
    }
  }
  if (panelOpen && layout.panel) {
    rects.push({
      x: layout.panel.left,
      y: layout.panel.top,
      w: layout.panel.w,
      h: layout.panel.h,
      round: false,
    });
  }
  return rects;
}

export function windowOrigin(layout: Layout, anchor: Point): Point {
  return {
    x: anchor.x - layout.mainCx,
    y: anchor.y - layout.mainCy,
  };
}

/** Keeps the main sphere visually still while its CSS position changes and the window has not caught up. */
export function pinShift(
  previous: { mainCx: number; mainCy: number } | null,
  next: { mainCx: number; mainCy: number },
): { x: number; y: number } {
  if (!previous) {
    return { x: 0, y: 0 };
  }
  return {
    x: previous.mainCx - next.mainCx,
    y: previous.mainCy - next.mainCy,
  };
}

export function mark(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ?? "•";
}

export function maxActionCount(buckets: Bucket[]): number {
  return buckets.reduce((max, bucket) => Math.max(max, bucket.items.length), 0);
}

function alongReach(count: number, metrics: Metrics, vertical: boolean): number {
  if (count <= 0) {
    return metrics.pad + metrics.main / 2;
  }
  const child = bucketSize(metrics);
  const step = vertical ? metrics.label + child + metrics.gap : child + metrics.gap;
  const lead = vertical ? metrics.label : 0;
  const dist = metrics.main / 2 + metrics.gap + lead + child / 2 + (count - 1) * step;
  return dist + child / 2 + metrics.pad;
}

function childCenter(
  index: number,
  dir: Dir,
  parentRadius: number,
  childRadius: number,
  metrics: Metrics,
): Point {
  const vertical = dir === "up" || dir === "down";
  const step = vertical
    ? metrics.label + childRadius * 2 + metrics.gap
    : childRadius * 2 + metrics.gap;
  const lead = vertical ? metrics.label : 0;
  const dist = parentRadius + metrics.gap + lead + childRadius + index * step;
  const way = vector(dir);
  return { x: way.x * dist, y: way.y * dist };
}

function placePanel(placement: Placement, mainRadius: number, gap: number, w: number, h: number) {
  const along = placement.along;
  if (placement.inward === "left") {
    return {
      x: -(mainRadius + gap + w),
      y: along === "down" ? -mainRadius : mainRadius - h,
      w,
      h,
    };
  }
  if (placement.inward === "right") {
    return {
      x: mainRadius + gap,
      y: along === "down" ? -mainRadius : mainRadius - h,
      w,
      h,
    };
  }
  if (placement.inward === "down") {
    return {
      x: along === "left" ? mainRadius - w : -mainRadius,
      y: mainRadius + gap,
      w,
      h,
    };
  }
  return {
    x: along === "left" ? mainRadius - w : -mainRadius,
    y: -(mainRadius + gap + h),
    w,
    h,
  };
}

function vector(dir: Dir): Point {
  switch (dir) {
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

function ellipse(left: number, top: number, size: number, pad: number): HitRect {
  return { x: left - pad, y: top - pad, w: size + pad * 2, h: size + pad * 2, round: true };
}

function unionRect(
  nodes: Array<{ left: number; top: number; size: number }>,
  pad: number,
): { x: number; y: number; w: number; h: number } | null {
  if (nodes.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.left - pad);
    minY = Math.min(minY, node.top - pad - 18);
    maxX = Math.max(maxX, node.left + node.size + pad);
    maxY = Math.max(maxY, node.top + node.size + pad + 18);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

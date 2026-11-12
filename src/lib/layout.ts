import type { Bucket } from "./types";

export type ClusterMode = "idle" | "buckets" | "actions";
export type ColumnSide = "up" | "down";
export type RowSide = "left" | "right";
export type PinX = "left" | "right";
export type PinY = "top" | "bottom";

export interface WorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  column: ColumnSide;
  row: RowSide;
}

export interface SphereNode {
  key: string;
  kind: "main" | "bucket" | "action";
  bucketId?: string;
  itemId?: string;
  label: string;
  /** Distance from the pinned horizontal edge to this circle's corresponding edge. */
  insetX: number;
  /** Distance from the pinned vertical edge to this circle's corresponding edge. */
  insetY: number;
  size: number;
  delay: number;
  fromX: number;
  fromY: number;
}

export interface PanelBox {
  insetX: number;
  insetY: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  pinX: PinX;
  pinY: PinY;
  /** Main-sphere center measured from the window's top-left. */
  mainCx: number;
  mainCy: number;
  nodes: SphereNode[];
  panel: PanelBox | null;
  noticeAtFarEnd: boolean;
}

export const MAIN_D = 64;
export const BUCKET_D = 52;
export const ACTION_D = 44;
export const GAP = 12;
export const PAD = 16;
export const LABEL_H = 16;
export const PANEL_W = 300;
export const PANEL_H = 436;
const NOTICE_BAND = 40;
const STEP = LABEL_H + BUCKET_D + GAP;

export function columnReach(bucketCount: number): number {
  if (bucketCount <= 0) {
    return PAD + MAIN_D / 2;
  }
  const last = bucketCount - 1;
  const center = MAIN_D / 2 + GAP + LABEL_H + BUCKET_D / 2 + last * STEP;
  return center + BUCKET_D / 2 + PAD;
}

export function rowReach(actionCount: number, panelOpen: boolean): number {
  let reach = PAD + MAIN_D / 2;
  if (actionCount > 0) {
    const last = actionCount - 1;
    const center =
      BUCKET_D / 2 + GAP + ACTION_D / 2 + last * (ACTION_D + GAP);
    reach = Math.max(reach, center + ACTION_D / 2 + PAD);
  }
  if (panelOpen) {
    reach = Math.max(reach, MAIN_D / 2 + GAP + PANEL_W + PAD);
  }
  return reach;
}

export function choosePlacement(
  anchor: { x: number; y: number },
  work: WorkArea,
  bucketCount: number,
  maxActions: number,
): Placement {
  const needY = columnReach(bucketCount);
  const needX = rowReach(maxActions, true);
  const above = anchor.y - work.top;
  const below = work.bottom - anchor.y;
  const left = anchor.x - work.left;
  const right = work.right - anchor.x;

  let column: ColumnSide = above >= below ? "up" : "down";
  if (column === "up" && above < needY && below >= needY) {
    column = "down";
  } else if (column === "down" && below < needY && above >= needY) {
    column = "up";
  }

  let row: RowSide = left >= right ? "left" : "right";
  if (row === "left" && left < needX && right >= needX) {
    row = "right";
  } else if (row === "right" && right < needX && left >= needX) {
    row = "left";
  }

  return { column, row };
}

export function computeLayout(
  buckets: Bucket[],
  mode: ClusterMode,
  activeBucketId: string | null,
  panelOpen: boolean,
  showNotice: boolean,
  placement: Placement,
): Layout {
  const pinX: PinX = placement.row === "left" ? "right" : "left";
  const pinY: PinY = placement.column === "up" ? "bottom" : "top";
  const showBuckets = mode !== "idle";
  const active =
    mode === "actions" && !panelOpen
      ? buckets.find((bucket) => bucket.id === activeBucketId)
      : undefined;

  let up = PAD + MAIN_D / 2;
  let down = PAD + MAIN_D / 2;
  let left = PAD + MAIN_D / 2;
  let right = PAD + MAIN_D / 2;

  const nodes: SphereNode[] = [
    {
      key: "main",
      kind: "main",
      label: "",
      insetX: PAD,
      insetY: PAD,
      size: MAIN_D,
      delay: 0,
      fromX: 0,
      fromY: 0,
    },
  ];

  if (showBuckets) {
    buckets.forEach((bucket, index) => {
      const lead = placement.column === "up" ? LABEL_H : 0;
      const center = MAIN_D / 2 + GAP + lead + BUCKET_D / 2 + index * STEP;
      const insetY = PAD + MAIN_D / 2 + center - BUCKET_D / 2;
      const tail = placement.column === "down" ? LABEL_H : 0;
      const far = center + BUCKET_D / 2 + tail + PAD;
      if (placement.column === "up") {
        up = Math.max(up, far);
      } else {
        down = Math.max(down, far);
      }
      nodes.push({
        key: `bucket:${bucket.id}`,
        kind: "bucket",
        bucketId: bucket.id,
        label: bucket.name,
        insetX: PAD + (MAIN_D - BUCKET_D) / 2,
        insetY,
        size: BUCKET_D,
        delay: index,
        fromX: 0,
        fromY: placement.column === "up" ? 8 : -8,
      });
    });
  }

  if (active) {
    const index = buckets.findIndex((bucket) => bucket.id === active.id);
    const lead = placement.column === "up" ? LABEL_H : 0;
    const bucketCenter =
      MAIN_D / 2 + GAP + lead + BUCKET_D / 2 + Math.max(index, 0) * STEP;
    active.items.forEach((item, actionIndex) => {
      const centerX = BUCKET_D / 2 + GAP + ACTION_D / 2 + actionIndex * (ACTION_D + GAP);
      const insetX = PAD + MAIN_D / 2 + centerX - ACTION_D / 2;
      const insetY = PAD + MAIN_D / 2 + bucketCenter - ACTION_D / 2;
      const farX = centerX + ACTION_D / 2 + PAD;
      const farY = bucketCenter + BUCKET_D / 2 + LABEL_H + PAD;
      if (placement.row === "left") {
        left = Math.max(left, farX);
      } else {
        right = Math.max(right, farX);
      }
      if (placement.column === "up") {
        up = Math.max(up, farY);
      } else {
        down = Math.max(down, farY);
      }
      nodes.push({
        key: `action:${item.id}`,
        kind: "action",
        bucketId: active.id,
        itemId: item.id,
        label: item.label,
        insetX,
        insetY,
        size: ACTION_D,
        delay: actionIndex,
        fromX: placement.row === "left" ? 8 : -8,
        fromY: 0,
      });
    });
  }

  let panel: PanelBox | null = null;
  if (panelOpen) {
    panel = {
      insetX: PAD + MAIN_D + GAP,
      insetY: PAD,
      w: PANEL_W,
      h: PANEL_H,
    };
    const farX = MAIN_D / 2 + GAP + PANEL_W + PAD;
    const farY = PANEL_H - MAIN_D / 2 + PAD;
    if (placement.row === "left") {
      left = Math.max(left, farX);
    } else {
      right = Math.max(right, farX);
    }
    if (placement.column === "up") {
      up = Math.max(up, farY);
    } else {
      down = Math.max(down, farY);
    }
  }

  if (showNotice) {
    if (placement.column === "up") {
      up += NOTICE_BAND;
    } else {
      down += NOTICE_BAND;
    }
  }

  const width = Math.ceil(left + right);
  const height = Math.ceil(up + down);
  const mainCx = pinX === "left" ? PAD + MAIN_D / 2 : width - (PAD + MAIN_D / 2);
  const mainCy = pinY === "top" ? PAD + MAIN_D / 2 : height - (PAD + MAIN_D / 2);

  return {
    width,
    height,
    pinX,
    pinY,
    mainCx,
    mainCy,
    nodes,
    panel,
    noticeAtFarEnd: showNotice,
  };
}

export function windowOrigin(
  layout: Layout,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.round(anchor.x - layout.mainCx),
    y: Math.round(anchor.y - layout.mainCy),
  };
}

export function mark(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ?? "•";
}

export function maxActionCount(buckets: Bucket[]): number {
  return buckets.reduce((max, bucket) => Math.max(max, bucket.items.length), 0);
}

import type { Bucket } from "./types";

export type ClusterMode = "idle" | "buckets" | "actions";

export interface SphereNode {
  key: string;
  kind: "main" | "bucket" | "action";
  bucketId?: string;
  itemId?: string;
  label: string;
  cx: number;
  cy: number;
  r: number;
}

export interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: SphereNode[];
  main: SphereNode;
  panel: PanelBox | null;
}

const MAIN_R = 34;
const BUCKET_R = 26;
const ACTION_R = 22;
const PAD = 16;
const PANEL_W = 304;
const PANEL_H = 468;
const PANEL_GAP = 12;

export function computeLayout(
  buckets: Bucket[],
  mode: ClusterMode,
  activeBucketId: string | null,
  panelOpen: boolean,
  showNotice: boolean,
): Layout {
  const nodes: SphereNode[] = [
    {
      key: "main",
      kind: "main",
      label: "",
      cx: 0,
      cy: 0,
      r: MAIN_R,
    },
  ];

  if (mode !== "idle") {
    const orbit = bucketOrbit(buckets.length);
    buckets.forEach((bucket, index) => {
      const angle = bucketAngle(index, buckets.length);
      nodes.push({
        key: `bucket:${bucket.id}`,
        kind: "bucket",
        bucketId: bucket.id,
        label: bucket.name,
        cx: Math.cos(angle) * orbit,
        cy: Math.sin(angle) * orbit,
        r: BUCKET_R,
      });
    });
  }

  if (mode === "actions" && activeBucketId) {
    const bucket = nodes.find((node) => node.kind === "bucket" && node.bucketId === activeBucketId);
    const items = buckets.find((entry) => entry.id === activeBucketId)?.items ?? [];
    if (bucket && items.length > 0) {
      const away = Math.atan2(bucket.cy, bucket.cx);
      const orbit = actionOrbit(items.length);
      items.forEach((item, index) => {
        const spread = Math.min(Math.PI * 0.9, 0.62 * Math.max(items.length - 1, 1));
        const offset = items.length === 1 ? 0 : (index / (items.length - 1) - 0.5) * spread;
        const angle = away + offset;
        nodes.push({
          key: `action:${item.id}`,
          kind: "action",
          bucketId: activeBucketId,
          itemId: item.id,
          label: item.label,
          cx: bucket.cx + Math.cos(angle) * orbit,
          cy: bucket.cy + Math.sin(angle) * orbit,
          r: ACTION_R,
        });
      });
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.cx - node.r);
    minY = Math.min(minY, node.cy - node.r);
    maxX = Math.max(maxX, node.cx + node.r);
    maxY = Math.max(maxY, node.cy + node.r);
  }
  if (nodes.length > 1) {
    maxY += 16;
  }
  if (showNotice) {
    maxY += 28;
  }

  let panel: PanelBox | null = null;
  if (panelOpen) {
    panel = {
      x: minX - PANEL_GAP - PANEL_W,
      y: minY,
      w: PANEL_W,
      h: PANEL_H,
    };
    minX = panel.x;
    minY = Math.min(minY, panel.y);
    maxX = Math.max(maxX, panel.x + panel.w);
    maxY = Math.max(maxY, panel.y + panel.h);
  }

  const dx = PAD - minX;
  const dy = PAD - minY;
  for (const node of nodes) {
    node.cx += dx;
    node.cy += dy;
  }
  if (panel) {
    panel.x += dx;
    panel.y += dy;
  }

  const main = nodes[0];
  return {
    width: Math.ceil(maxX - minX + PAD * 2),
    height: Math.ceil(maxY - minY + PAD * 2),
    nodes,
    main,
    panel,
  };
}

function bucketOrbit(count: number): number {
  const arc = (140 / 360) * Math.PI * 2;
  const needed = (Math.max(count, 1) * (BUCKET_R * 2 + 8)) / arc;
  return Math.max(92, needed);
}

function actionOrbit(count: number): number {
  const needed = Math.max(count, 1) * (ACTION_R * 2 + 6) * 0.45;
  return Math.max(74, needed);
}

function bucketAngle(index: number, count: number): number {
  // Screen space: 0 is east and y grows downward, so 270° is up.
  const start = (200 * Math.PI) / 180;
  const end = (340 * Math.PI) / 180;
  if (count <= 1) {
    return (270 * Math.PI) / 180;
  }
  return start + ((end - start) * index) / (count - 1);
}

export function mark(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ?? "•";
}

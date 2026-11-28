import { bucketSize, clamp, type Metrics } from "./layout";

export type Edge = "left" | "right" | "top" | "bottom";
export type Dir = "up" | "down" | "left" | "right";

export interface WorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  edge: Edge;
  along: Dir;
  inward: Dir;
}

export interface Point {
  x: number;
  y: number;
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

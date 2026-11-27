import type { Bucket } from "./types";

export function isBatchPath(path: string): boolean {
  return /\.(bat|cmd)$/i.test(path.trim());
}

export function normalizePath(path: string): string {
  return path.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

export function labelFromPath(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path.trim();
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() || base || "未命名";
}

export function usedTargets(buckets: Bucket[]): Set<string> {
  const used = new Set<string>();
  for (const bucket of buckets) {
    for (const item of bucket.items) {
      if (item.target) {
        used.add(normalizePath(item.target));
      }
    }
  }
  return used;
}

export function navigationBucket(buckets: Bucket[]): Bucket | undefined {
  return (
    buckets.find((bucket) => bucket.id === "navigation" || bucket.name === "导航") ?? buckets[0]
  );
}

export function batchBucket(buckets: Bucket[]): Bucket | undefined {
  return (
    buckets.find((bucket) => bucket.id === "bat" || bucket.name === "批处理") ??
    buckets.find((bucket) => bucket.id === "command" || bucket.name === "指令") ??
    navigationBucket(buckets)
  );
}

export function overMainSphere(clientX: number, clientY: number, pad = 18): boolean {
  const sphere = document.querySelector(".orb.main .sphere");
  if (!(sphere instanceof HTMLElement)) {
    return false;
  }
  const rect = sphere.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = Math.max(rect.width, rect.height) / 2 + pad;
  const dx = clientX - cx;
  const dy = clientY - cy;
  return dx * dx + dy * dy <= radius * radius;
}

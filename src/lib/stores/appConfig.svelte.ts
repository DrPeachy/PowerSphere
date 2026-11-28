import { inTauri } from "../api";
import { resolveGlyph, normalizeStyle } from "../jewel";
import { metricsFrom } from "../layout";
import type { AppSnapshot, Bucket, ToolItem } from "../types";

export const fallbackBuckets: Bucket[] = [
  { id: "navigation", name: "导航", items: [] },
  { id: "command", name: "指令", items: [] },
];

class AppConfigStore {
  snapshot = $state<AppSnapshot | null>(null);
  notice = $state<string | null>(null);

  buckets = $derived(this.snapshot?.config.buckets ?? fallbackBuckets);
  metrics = $derived(metricsFrom(this.snapshot?.config.style));
  clockOn = $derived(this.snapshot?.config.clock?.enabled ?? true);
  clockTimezone = $derived(this.snapshot?.config.clock?.timezone ?? "local");
  sphereLook = $derived(normalizeStyle(this.snapshot?.config.style?.sphereStyle));
  sphereGlyph = $derived(resolveGlyph(this.sphereLook, this.snapshot?.config.style?.centerGlyph));

  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  setSnapshot(next: AppSnapshot | null): void {
    this.snapshot = next;
  }

  showNotice(text: string): void {
    this.notice = text;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
    }, 3200);
  }

  findItem(bucketId?: string, itemId?: string): ToolItem | undefined {
    if (!bucketId || !itemId) {
      return undefined;
    }
    return this.buckets
      .find((bucket) => bucket.id === bucketId)
      ?.items.find((item) => item.id === itemId);
  }

  async listenUpdates(): Promise<() => void> {
    if (!inTauri()) {
      return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AppSnapshot>("config-updated", (event) => {
      this.snapshot = event.payload;
    });
  }

  destroy(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
  }
}

export const appConfig = new AppConfigStore();

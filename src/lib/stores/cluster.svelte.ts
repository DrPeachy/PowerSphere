import { isNativeDialogOpen, messageFrom, runFilled, runItem } from "../api";
import { PANEL_SIZES, type ClusterMode, type SphereNode } from "../layout";
import { parseTemplate } from "../template";
import { appConfig } from "./appConfig.svelte";
import { shellMotion } from "./shellMotion.svelte";

class ClusterStore {
  mode = $state<ClusterMode>("idle");
  activeBucketId = $state<string | null>(null);
  editor = $state<{ bucketId: string; itemId?: string } | null>(null);
  fill = $state<{ bucketId: string; itemId: string } | null>(null);
  settingsOpen = $state(false);
  ghostActions = $state<SphereNode[]>([]);

  panelSize = $derived(
    this.settingsOpen
      ? PANEL_SIZES.settings
      : this.fill
        ? PANEL_SIZES.fill
        : this.editor
          ? PANEL_SIZES.editor
          : null,
  );
  editingItem = $derived(appConfig.findItem(this.editor?.bucketId, this.editor?.itemId));
  fillItem = $derived(appConfig.findItem(this.fill?.bucketId, this.fill?.itemId));
  hasOpenPanel = $derived(this.editor !== null || this.settingsOpen || this.fill !== null);

  pointerInside = false;
  collapseAfterHold = false;
  private collapseTimer: ReturnType<typeof setTimeout> | undefined;
  private panelOpenedAt = 0;

  clearCollapseTimer(): void {
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = undefined;
    }
  }

  cancelCollapse(): void {
    this.pointerInside = true;
    this.collapseAfterHold = false;
    this.clearCollapseTimer();
  }

  scheduleCollapse(force = false): void {
    if (!force && shellMotion.nativeHover === true) {
      return;
    }
    if (shellMotion.dragging) {
      return;
    }
    if (shellMotion.holding) {
      this.collapseAfterHold = true;
      return;
    }
    this.pointerInside = false;
    if (this.editor || this.settingsOpen || this.fill) {
      return;
    }
    this.clearCollapseTimer();
    this.collapseTimer = setTimeout(() => {
      this.mode = "idle";
      this.activeBucketId = null;
    }, 220);
  }

  flushCollapseAfterHold(): boolean {
    if (!this.collapseAfterHold) {
      return false;
    }
    this.collapseAfterHold = false;
    this.scheduleCollapse();
    return true;
  }

  syncGhostActions(nodes: SphereNode[]): void {
    const actions = nodes.filter((node) => node.kind === "action");
    if (actions.length === 0) {
      return;
    }
    const incoming = new Set(actions.map((node) => node.key));
    const kept = this.ghostActions.filter((node) => !incoming.has(node.key));
    const next = [...actions, ...kept];
    const same =
      next.length === this.ghostActions.length &&
      next.every(
        (node, index) =>
          node.key === this.ghostActions[index]?.key &&
          node.left === this.ghostActions[index]?.left &&
          node.top === this.ghostActions[index]?.top,
      );
    if (!same) {
      this.ghostActions = next.map((node) => ({ ...node }));
    }
  }

  retireAction(key: string, currentNodes: SphereNode[]): void {
    if (currentNodes.some((node) => node.key === key)) {
      return;
    }
    this.ghostActions = this.ghostActions.filter((node) => node.key !== key);
  }

  showBuckets(): void {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    this.cancelCollapse();
    if (this.mode === "buckets" && this.activeBucketId === null) {
      return;
    }
    this.activeBucketId = null;
    this.mode = "buckets";
  }

  showActions(bucketId: string): void {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    this.cancelCollapse();
    if (this.mode === "actions" && this.activeBucketId === bucketId) {
      return;
    }
    this.activeBucketId = bucketId;
    this.mode = "actions";
  }

  markPanelOpened(): void {
    this.panelOpenedAt = performance.now();
  }

  closePanels = (): void => {
    this.editor = null;
    this.fill = null;
    this.settingsOpen = false;
    if (!this.pointerInside) {
      this.mode = "idle";
      this.activeBucketId = null;
    }
  };

  dismissPanelsFromOutside = (): void => {
    if (shellMotion.dragging || isNativeDialogOpen()) {
      return;
    }
    if (performance.now() - this.panelOpenedAt < 280) {
      return;
    }
    if (!this.editor && !this.settingsOpen && !this.fill) {
      return;
    }
    this.closePanels();
  };

  togglePanel(): void {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    if (this.editor) {
      this.closePanels();
      return;
    }
    this.settingsOpen = false;
    this.fill = null;
    this.editor = { bucketId: appConfig.buckets[0]?.id ?? "" };
    this.activeBucketId = null;
    this.mode = "buckets";
    this.markPanelOpened();
  }

  openSettings(): void {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    this.editor = null;
    this.fill = null;
    this.settingsOpen = true;
    this.mode = "buckets";
    this.markPanelOpened();
  }

  openEditor(bucketId: string, itemId: string): void {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    this.fill = null;
    this.settingsOpen = false;
    this.editor = { bucketId, itemId };
    this.mode = "buckets";
    this.markPanelOpened();
  }

  collapseForDrag(): void {
    this.editor = null;
    this.fill = null;
    this.settingsOpen = false;
    this.mode = "idle";
    this.activeBucketId = null;
    this.clearCollapseTimer();
  }

  async activate(bucketId: string, itemId: string): Promise<void> {
    if (shellMotion.dragging || shellMotion.snapping) {
      return;
    }
    const item = appConfig.findItem(bucketId, itemId);
    if (item?.type === "command" && parseTemplate(item.command ?? "").length > 0) {
      this.editor = null;
      this.settingsOpen = false;
      this.fill = { bucketId, itemId };
      this.mode = "buckets";
      this.markPanelOpened();
      return;
    }
    try {
      const result = await runItem(bucketId, itemId);
      appConfig.showNotice(result.message);
    } catch (cause) {
      appConfig.showNotice(messageFrom(cause));
    }
  }

  runPrompt = async (values: Record<string, string>): Promise<void> => {
    if (!this.fill) {
      return;
    }
    const result = await runFilled(this.fill.bucketId, this.fill.itemId, values);
    this.fill = null;
    appConfig.showNotice(result.message);
  };

  onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && (this.editor || this.settingsOpen || this.fill)) {
      this.closePanels();
    }
  };

  onStagePointerDown = (event: PointerEvent): void => {
    if (shellMotion.dragging || (!this.editor && !this.settingsOpen && !this.fill)) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(".panel") ||
      target?.closest(".orb.main") ||
      target?.closest(".orb.settings")
    ) {
      return;
    }
    if (event.button === 2 && target?.closest(".orb.action")) {
      return;
    }
    this.dismissPanelsFromOutside();
  };

  destroy(): void {
    this.clearCollapseTimer();
  }
}

export const cluster = new ClusterStore();

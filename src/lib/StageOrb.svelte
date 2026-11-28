<script lang="ts">
  import MainJewel from "./MainJewel.svelte";
  import SphereMark from "./SphereMark.svelte";
  import type { SphereNode } from "./layout";
  import { appConfig } from "./stores/appConfig.svelte";
  import { cluster } from "./stores/cluster.svelte";
  import { fileDrop } from "./stores/fileDrop.svelte";
  import { shellMotion } from "./stores/shellMotion.svelte";

  let { node }: { node: SphereNode & { open: boolean } } = $props();

  let focused = $derived(
    (node.kind === "bucket" || node.kind === "settings") &&
      node.bucketId === cluster.activeBucketId,
  );
  let dim = $derived(
    (node.kind === "bucket" || node.kind === "settings") &&
      cluster.activeBucketId !== null &&
      node.bucketId !== cluster.activeBucketId,
  );

  function sphereHint(target: SphereNode): string {
    if (target.kind !== "action" || !target.bucketId || !target.itemId) {
      return target.label;
    }
    const item = appConfig.findItem(target.bucketId, target.itemId);
    if (!item) {
      return target.label;
    }
    return [item.label, item.target, item.command, item.type, item.shell].filter(Boolean).join(" ");
  }
</script>

<div
  class="orb {node.kind}"
  class:open={node.open}
  class:dim
  class:focused
  ontransitionend={(event) => {
    if (event.propertyName === "opacity" || event.propertyName === "transform") {
      shellMotion.flushHits();
    }
    if (event.propertyName === "opacity" && node.kind === "action" && !node.open) {
      cluster.retireAction(node.key, shellMotion.layout.nodes);
    }
  }}
  style:left="{node.left}px"
  style:top="{node.top}px"
  style:width="{node.size}px"
  style:height="{node.size}px"
  style:--dx="{node.fromX}px"
  style:--dy="{node.fromY}px"
  style:animation-delay="{node.delay * 28}ms"
>
  {#if node.kind === "main"}
    <button
      class="sphere main jewel {appConfig.sphereLook}"
      class:drop-hot={fileDrop.fileOver && !shellMotion.dragging}
      type="button"
      aria-label="添加工具"
      aria-pressed={cluster.editor !== null}
      onpointerenter={() => cluster.showBuckets()}
      onpointerdown={shellMotion.onMainPointerDown}
      onpointermove={shellMotion.onMainPointerMove}
      onpointerup={shellMotion.onMainPointerUp}
      onpointercancel={shellMotion.onMainPointerUp}
      onclick={shellMotion.onMainClick}
    >
      <MainJewel sphereStyle={appConfig.sphereLook} glyph={appConfig.sphereGlyph} />
    </button>
  {:else}
    <button
      class="sphere {node.kind}"
      type="button"
      title={node.label}
      aria-label={node.label}
      onpointerenter={() => {
        if (node.bucketId) {
          cluster.showActions(node.bucketId);
        }
      }}
      onclick={() => {
        if (node.kind === "settings") {
          cluster.openSettings();
        } else if (node.kind === "action" && node.bucketId && node.itemId) {
          void cluster.activate(node.bucketId, node.itemId);
        }
      }}
      oncontextmenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (node.kind === "action" && node.bucketId && node.itemId) {
          cluster.openEditor(node.bucketId, node.itemId);
        }
      }}
    >
      {#if node.kind === "settings"}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.2 6.2l1.6 1.6M16.2 16.2l1.6 1.6M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6"
          />
        </svg>
      {:else}
        <SphereMark icon={node.icon} label={node.label} hint={sphereHint(node)} />
      {/if}
    </button>
    <span class="caption" class:above={shellMotion.layout.labelAbove}>{node.label}</span>
  {/if}
</div>

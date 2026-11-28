<script lang="ts">
  import { onMount } from "svelte";
  import AddPanel from "./lib/AddPanel.svelte";
  import Clock from "./lib/Clock.svelte";
  import FillPanel from "./lib/FillPanel.svelte";
  import MainJewel from "./lib/MainJewel.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import SphereMark from "./lib/SphereMark.svelte";
  import { getSnapshot, messageFrom } from "./lib/api";
  import type { SphereNode } from "./lib/layout";
  import { appConfig } from "./lib/stores/appConfig.svelte";
  import { cluster } from "./lib/stores/cluster.svelte";
  import { fileDrop } from "./lib/stores/fileDrop.svelte";
  import { shellMotion } from "./lib/stores/shellMotion.svelte";
  import { mergePlaceholders } from "./lib/template";

  $effect(() => shellMotion.syncLayoutEffect());
  $effect(() => shellMotion.publishHitsEffect());
  $effect(() => shellMotion.snapToWorkAreaEffect());
  $effect(() => cluster.syncGhostActions(shellMotion.layout.nodes));

  onMount(() => {
    let cancelled = false;
    let stopListening = () => {};
    document.addEventListener("pointerdown", cluster.onStagePointerDown);
    document.addEventListener("dragover", fileDrop.onFileDragOver);
    document.addEventListener("drop", fileDrop.onFileDrop);

    if (shellMotion.preview) {
      document.body.classList.add("preview");
      const stopPreview = shellMotion.initPreview();
      void getSnapshot().then((next) => {
        appConfig.setSnapshot(next);
      });
      return () => {
        document.removeEventListener("pointerdown", cluster.onStagePointerDown);
        document.removeEventListener("dragover", fileDrop.onFileDragOver);
        document.removeEventListener("drop", fileDrop.onFileDrop);
        stopPreview();
        appConfig.destroy();
        cluster.destroy();
      };
    }

    void (async () => {
      try {
        const next = await getSnapshot();
        if (cancelled) {
          return;
        }
        appConfig.setSnapshot(next);
        if (next.warning) {
          appConfig.showNotice(next.warning);
        }
        await shellMotion.initTauriAnchor(next.config.anchor);
      } catch (cause) {
        appConfig.showNotice(messageFrom(cause));
      } finally {
        if (!cancelled) {
          shellMotion.ready = true;
        }
      }
      if (!cancelled) {
        const [stopConfig, stopShell, stopDrops] = await Promise.all([
          appConfig.listenUpdates(),
          shellMotion.listenTauriEvents(),
          fileDrop.listenTauriDrops(),
        ]);
        if (cancelled) {
          stopConfig();
          stopShell();
          stopDrops();
          return;
        }
        stopListening = () => {
          stopConfig();
          stopShell();
          stopDrops();
        };
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", cluster.onStagePointerDown);
      document.removeEventListener("dragover", fileDrop.onFileDragOver);
      document.removeEventListener("drop", fileDrop.onFileDrop);
      stopListening();
      appConfig.destroy();
      cluster.destroy();
    };
  });

  function sphereHint(node: SphereNode): string {
    if (node.kind !== "action" || !node.bucketId || !node.itemId) {
      return node.label;
    }
    const item = appConfig.findItem(node.bucketId, node.itemId);
    if (!item) {
      return node.label;
    }
    return [item.label, item.target, item.command, item.type, item.shell].filter(Boolean).join(" ");
  }
</script>

<svelte:window onkeydown={cluster.onKeydown} onblur={cluster.dismissPanelsFromOutside} />

<main
  class="stage"
  class:preview={shellMotion.preview}
  class:dragging={shellMotion.dragging}
  class:holding={shellMotion.holding}
  class:pointer-out={shellMotion.nativeHover === false}
  style:transform={shellMotion.pin.x !== 0 || shellMotion.pin.y !== 0
    ? `translate3d(${shellMotion.pin.x}px, ${shellMotion.pin.y}px, 0)`
    : undefined}
  style:width="{shellMotion.layout.width}px"
  style:height="{shellMotion.layout.height}px"
  style:left="{shellMotion.preview ? `${shellMotion.origin.x}px` : '0px'}"
  style:top="{shellMotion.preview ? `${shellMotion.origin.y}px` : '0px'}"
  style:--motion="{appConfig.metrics.animationMs}ms"
  style:--dim="{appConfig.metrics.unfocusedOpacity}"
  onpointerenter={shellMotion.onStageEnter}
  onpointerleave={shellMotion.onStageLeave}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each shellMotion.shown as node (node.key)}
    {@const focused =
      (node.kind === "bucket" || node.kind === "settings") &&
      node.bucketId === cluster.activeBucketId}
    {@const dim =
      (node.kind === "bucket" || node.kind === "settings") &&
      cluster.activeBucketId !== null &&
      node.bucketId !== cluster.activeBucketId}
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
  {/each}

  {#if shellMotion.layout.clock}
    <div
      class="clock"
      class:away={cluster.mode !== "idle"}
      style:left="{shellMotion.layout.clock.left}px"
      style:top="{shellMotion.layout.clock.top}px"
      style:width="{shellMotion.layout.clock.w}px"
      style:height="{shellMotion.layout.clock.h}px"
    >
      <Clock timezone={appConfig.clockTimezone} />
    </div>
  {/if}

  {#if appConfig.notice}
    <p
      class="notice"
      style:left="{shellMotion.noticePos.left}px"
      style:top="{shellMotion.noticePos.top}px"
      style:transform={shellMotion.noticePos.transform}
    >
      {appConfig.notice}
    </p>
  {/if}

  {#if shellMotion.layout.panel && appConfig.snapshot}
    <div
      class="panel"
      style:left="{shellMotion.layout.panel.left}px"
      style:top="{shellMotion.layout.panel.top}px"
      style:width="{shellMotion.layout.panel.w}px"
      style:height="{shellMotion.layout.panel.h}px"
    >
      {#if cluster.settingsOpen}
        <SettingsPanel
          snapshot={appConfig.snapshot}
          onClose={cluster.closePanels}
          onChange={(next) => appConfig.setSnapshot(next)}
        />
      {:else if cluster.fill && cluster.fillItem}
        <FillPanel
          item={cluster.fillItem}
          specs={mergePlaceholders(cluster.fillItem.command ?? "", cluster.fillItem.placeholders)}
          onRun={cluster.runPrompt}
          onClose={cluster.closePanels}
        />
      {:else if cluster.editor}
        <AddPanel
          snapshot={appConfig.snapshot}
          editing={cluster.editingItem
            ? { bucketId: cluster.editor.bucketId, item: cluster.editingItem }
            : null}
          onClose={cluster.closePanels}
          onChange={(next) => appConfig.setSnapshot(next)}
          onNotice={(text) => appConfig.showNotice(text)}
        />
      {/if}
    </div>
  {/if}
</main>

<script lang="ts">
  import { onMount } from "svelte";
  import Clock from "./lib/Clock.svelte";
  import PanelHost from "./lib/PanelHost.svelte";
  import StageOrb from "./lib/StageOrb.svelte";
  import { getSnapshot, messageFrom } from "./lib/api";
  import { appConfig } from "./lib/stores/appConfig.svelte";
  import { cluster } from "./lib/stores/cluster.svelte";
  import { fileDrop } from "./lib/stores/fileDrop.svelte";
  import { shellMotion } from "./lib/stores/shellMotion.svelte";

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
    <StageOrb {node} />
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

  <PanelHost />
</main>

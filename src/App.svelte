<script lang="ts">
  import { onMount } from "svelte";
  import AddPanel from "./lib/AddPanel.svelte";
  import {
    getSnapshot,
    inTauri,
    messageFrom,
    runItem,
    setAnchor,
  } from "./lib/api";
  import {
    choosePlacement,
    computeLayout,
    mark,
    maxActionCount,
    windowOrigin,
    type ClusterMode,
    type Layout,
    type Placement,
    type WorkArea,
  } from "./lib/layout";
  import type { AppSnapshot, Bucket } from "./lib/types";
  import { defaultAnchor, installMoveSaver, readWorkArea, syncWindow } from "./lib/window";

  const fallbackBuckets: Bucket[] = [
    { id: "navigation", name: "导航", items: [] },
    { id: "command", name: "指令", items: [] },
  ];

  const preview = !inTauri();

  let snapshot = $state<AppSnapshot | null>(null);
  let mode = $state<ClusterMode>("idle");
  let activeBucketId = $state<string | null>(null);
  let panelOpen = $state(false);
  let notice = $state<string | null>(null);
  let ready = $state(false);
  let pointerInside = false;
  let dragging = $state(false);
  let anchor = $state({ x: 180, y: 220 });
  let work = $state<WorkArea>({ left: 0, top: 0, right: 1280, bottom: 800 });
  let lockedPlacement = $state<Placement | null>(null);

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  let drag: {
    pointerId: number;
    sx: number;
    sy: number;
    cx: number;
    cy: number;
    ax: number;
    ay: number;
    moved: boolean;
    useScreen: boolean;
  } | null = null;
  let suppressClick = false;

  let buckets = $derived(snapshot?.config.buckets ?? fallbackBuckets);
  let placement = $derived(
    lockedPlacement ??
      choosePlacement(anchor, work, buckets.length, maxActionCount(buckets)),
  );
  let layout: Layout = $derived(
    computeLayout(buckets, mode, activeBucketId, panelOpen, notice !== null, placement),
  );
  let origin = $derived(windowOrigin(layout, anchor));

  $effect(() => {
    if (!ready || preview) {
      return;
    }
    void syncWindow(layout, anchor);
  });

  onMount(() => {
    let cancelled = false;
    let stopListening = () => {};
    if (preview) {
      document.body.classList.add("preview");
      work = viewportWork();
      anchor.x = Math.max(120, window.innerWidth - 88);
      anchor.y = window.innerHeight / 2;
      void getSnapshot().then((next) => {
        snapshot = next;
      });
      const onResize = () => {
        work = viewportWork();
      };
      window.addEventListener("resize", onResize);
      ready = true;
      return () => window.removeEventListener("resize", onResize);
    }

    void (async () => {
      try {
        const next = await getSnapshot();
        if (cancelled) {
          return;
        }
        snapshot = next;
        if (next.warning) {
          showNotice(next.warning);
        }
        const area = await readWorkArea();
        if (area) {
          work = area;
        }
        if (next.config.anchor) {
          anchor.x = next.config.anchor.x;
          anchor.y = next.config.anchor.y;
        } else {
          const initial = await defaultAnchor();
          anchor.x = initial.x;
          anchor.y = initial.y;
          await setAnchor(initial);
        }
      } catch (cause) {
        showNotice(messageFrom(cause));
      } finally {
        if (!cancelled) {
          ready = true;
        }
      }
      if (!cancelled) {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<AppSnapshot>("config-updated", (event) => {
          snapshot = event.payload;
        });
        const stopMoves = await installMoveSaver(
          () => layout,
          anchor,
          async (next) => {
            anchor.x = next.x;
            anchor.y = next.y;
            await setAnchor(next);
          },
        );
        stopListening = () => {
          unlisten();
          stopMoves();
        };
      }
    })();
    return () => {
      cancelled = true;
      stopListening();
      if (noticeTimer) {
        clearTimeout(noticeTimer);
      }
      if (collapseTimer) {
        clearTimeout(collapseTimer);
      }
    };
  });

  function viewportWork(): WorkArea {
    return {
      left: 8,
      top: 8,
      right: Math.max(200, window.innerWidth - 8),
      bottom: Math.max(200, window.innerHeight - 8),
    };
  }

  function showNotice(text: string) {
    notice = text;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
      notice = null;
    }, 3200);
  }

  function cancelCollapse() {
    pointerInside = true;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = undefined;
    }
  }

  function scheduleCollapse() {
    pointerInside = false;
    if (panelOpen || dragging) {
      return;
    }
    if (collapseTimer) {
      clearTimeout(collapseTimer);
    }
    collapseTimer = setTimeout(() => {
      mode = "idle";
      activeBucketId = null;
    }, 220);
  }

  function showBuckets() {
    if (dragging) {
      return;
    }
    cancelCollapse();
    activeBucketId = null;
    mode = "buckets";
  }

  function showActions(bucketId: string) {
    if (dragging) {
      return;
    }
    cancelCollapse();
    activeBucketId = bucketId;
    mode = "actions";
  }

  function closePanel() {
    panelOpen = false;
    if (!pointerInside) {
      mode = "idle";
      activeBucketId = null;
    }
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    if (panelOpen) {
      activeBucketId = null;
      mode = "buckets";
    } else if (!pointerInside) {
      mode = "idle";
      activeBucketId = null;
    }
  }

  function onMainPointerDown(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    drag = {
      pointerId: event.pointerId,
      sx: event.screenX,
      sy: event.screenY,
      cx: event.clientX,
      cy: event.clientY,
      ax: anchor.x,
      ay: anchor.y,
      moved: false,
      useScreen: false,
    };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable for some synthetic events.
    }
  }

  function onMainPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const screenDx = event.screenX - drag.sx;
    const screenDy = event.screenY - drag.sy;
    if (!drag.useScreen && Math.hypot(screenDx, screenDy) > 0) {
      drag.useScreen = true;
    }
    const unit = drag.useScreen && inTauri() ? window.devicePixelRatio || 1 : 1;
    const dx = drag.useScreen ? screenDx / unit : event.clientX - drag.cx;
    const dy = drag.useScreen ? screenDy / unit : event.clientY - drag.cy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      dragging = true;
      lockedPlacement = placement;
    }
    anchor.x = drag.ax + dx;
    anchor.y = drag.ay + dy;
  }

  function onMainPointerUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const moved = drag.moved;
    drag = null;
    dragging = false;
    lockedPlacement = null;
    if (moved) {
      suppressClick = true;
      const next = { x: anchor.x, y: anchor.y };
      void setAnchor(next).catch(() => {});
      if (!preview) {
        void readWorkArea().then((area) => {
          if (area) {
            work = area;
          }
        });
      }
      return;
    }
  }

  function onMainClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    togglePanel();
  }

  async function activate(bucketId: string, itemId: string) {
    try {
      const result = await runItem(bucketId, itemId);
      showNotice(result.message);
    } catch (cause) {
      showNotice(messageFrom(cause));
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && panelOpen) {
      closePanel();
    }
  }

  function pinStyle(insetX: number, insetY: number, width: number, height: number): string {
    const x = layout.pinX === "right" ? `right:${insetX}px;left:auto;` : `left:${insetX}px;right:auto;`;
    const y = layout.pinY === "bottom" ? `bottom:${insetY}px;top:auto;` : `top:${insetY}px;bottom:auto;`;
    return `${x}${y}width:${width}px;height:${height}px;`;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<main
  class="stage"
  class:preview
  class:dragging
  style:width="{layout.width}px"
  style:height="{layout.height}px"
  style:left="{preview ? `${origin.x}px` : '0px'}"
  style:top="{preview ? `${origin.y}px` : '0px'}"
  onpointerenter={cancelCollapse}
  onpointerleave={scheduleCollapse}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each layout.nodes as node (node.key)}
    {@const focused = node.kind === "bucket" && node.bucketId === activeBucketId}
    {@const dim = node.kind === "bucket" && activeBucketId !== null && node.bucketId !== activeBucketId}
    <div
      class="orb {node.kind}"
      class:dim
      class:focused
      style={pinStyle(node.insetX, node.insetY, node.size, node.size)}
      style:--dx="{node.fromX}px"
      style:--dy="{node.fromY}px"
      style:animation-delay="{node.delay * 32}ms"
    >
      {#if node.kind === "main"}
        <button
          class="sphere main"
          type="button"
          aria-label="添加工具"
          aria-pressed={panelOpen}
          onpointerenter={showBuckets}
          onpointerdown={onMainPointerDown}
          onpointermove={onMainPointerMove}
          onpointerup={onMainPointerUp}
          onclick={onMainClick}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5.25v13.5M5.25 12h13.5" />
          </svg>
        </button>
      {:else}
        <button
          class="sphere {node.kind}"
          type="button"
          title={node.label}
          aria-label={node.label}
          onpointerenter={() => {
            if (node.kind === "bucket" && node.bucketId) {
              showActions(node.bucketId);
            }
          }}
          onclick={() => {
            if (node.kind === "action" && node.bucketId && node.itemId) {
              void activate(node.bucketId, node.itemId);
            }
          }}
        >
          <span class="glyph">{mark(node.label)}</span>
        </button>
        <span class="caption">{node.label}</span>
      {/if}
    </div>
  {/each}

  {#if notice}
    <p
      class="notice"
      class:far={layout.pinY === "bottom"}
      style:right={layout.pinX === "right" ? `${16 + 32}px` : "auto"}
      style:left={layout.pinX === "left" ? `${16 + 32}px` : "auto"}
    >
      {notice}
    </p>
  {/if}

  {#if panelOpen && layout.panel && snapshot}
    <div
      class="panel"
      style={pinStyle(layout.panel.insetX, layout.panel.insetY, layout.panel.w, layout.panel.h)}
    >
      <AddPanel
        {snapshot}
        onClose={closePanel}
        onChange={(next) => (snapshot = next)}
        onNotice={showNotice}
      />
    </div>
  {/if}
</main>

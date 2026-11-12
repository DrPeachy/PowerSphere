<script lang="ts">
  import { onMount } from "svelte";
  import AddPanel from "./lib/AddPanel.svelte";
  import FillPanel from "./lib/FillPanel.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import {
    getSnapshot,
    inTauri,
    messageFrom,
    runFilled,
    runItem,
    setAnchor,
    setHitRects,
  } from "./lib/api";
  import {
    choosePlacement,
    computeLayout,
    hitRects,
    mark,
    metricsFrom,
    pinShift,
    snapAnchor,
    windowOrigin,
    type ClusterMode,
    type Layout,
    type Placement,
    type WorkArea,
  } from "./lib/layout";
  import { mergePlaceholders, parseTemplate } from "./lib/template";
  import type { AppSnapshot, Bucket, ToolItem } from "./lib/types";
  import { defaultAnchor, installMoveSaver, readCursor, readWorkArea, setDragLock, syncWindow } from "./lib/window";

  const fallbackBuckets: Bucket[] = [
    { id: "navigation", name: "导航", items: [] },
    { id: "command", name: "指令", items: [] },
  ];

  const preview = !inTauri();

  let snapshot = $state<AppSnapshot | null>(null);
  let mode = $state<ClusterMode>("idle");
  let activeBucketId = $state<string | null>(null);
  let editor = $state<{ bucketId: string; itemId?: string } | null>(null);
  let fill = $state<{ bucketId: string; itemId: string } | null>(null);
  let settingsOpen = $state(false);
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
    lastSx: number;
    lastSy: number;
    cx: number;
    cy: number;
    ax: number;
    ay: number;
    grabX: number;
    grabY: number;
    os: boolean;
    moved: boolean;
  } | null = null;
  let cursorBusy = false;
  let cursorAgain = false;
  let suppressClick = false;
  let pin = $state({ x: 0, y: 0 });
  let pinX = 0;
  let pinY = 0;
  let holding = $state(false);
  let placed: { cx: number; cy: number; w: number; h: number } | null = null;
  let layoutGen = 0;

  let buckets = $derived(snapshot?.config.buckets ?? fallbackBuckets);
  let metrics = $derived(metricsFrom(snapshot?.config.style));
  let placement = $derived(
    lockedPlacement ?? choosePlacement(anchor, work, buckets.length + 1, metrics),
  );
  let panelSize = $derived(
    settingsOpen
      ? { w: 300, h: 470 }
      : fill
        ? { w: 280, h: 320 }
        : editor
          ? { w: 300, h: 600 }
          : null,
  );
  let layout: Layout = $derived(
    computeLayout(buckets, mode, activeBucketId, panelSize, metrics, placement),
  );
  let origin = $derived(windowOrigin(layout, anchor));
  let editingItem = $derived(findItem(buckets, editor?.bucketId, editor?.itemId));
  let fillItem = $derived(findItem(buckets, fill?.bucketId, fill?.itemId));
  let noticePos = $derived.by(() => {
    const gap = 8;
    const radius = metrics.main / 2;
    if (placement.along === "up") {
      return { left: layout.mainCx, top: layout.mainCy + radius + gap, transform: "translate(-50%, 0)" };
    }
    if (placement.along === "down") {
      return { left: layout.mainCx, top: layout.mainCy - radius - gap, transform: "translate(-50%, -100%)" };
    }
    if (placement.along === "left") {
      return { left: layout.mainCx + radius + gap, top: layout.mainCy, transform: "translate(0, -50%)" };
    }
    return { left: layout.mainCx - radius - gap, top: layout.mainCy, transform: "translate(-100%, -50%)" };
  });

  $effect(() => {
    if (!ready || preview) {
      return;
    }
    const next = layout;
    const point = { x: anchor.x, y: anchor.y };
    const gen = ++layoutGen;
    const shift = pinShift(placed ? { mainCx: placed.cx, mainCy: placed.cy } : null, next);
    const resized = placed !== null && (placed.w !== next.width || placed.h !== next.height);
    const shouldHold = shift.x !== 0 || shift.y !== 0 || resized;
    if (shift.x !== pinX || shift.y !== pinY) {
      pinX = shift.x;
      pinY = shift.y;
      pin = shift;
    }
    if (shouldHold) {
      holding = true;
      pointerInside = true;
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = undefined;
      }
    }
    const preserveClient = shift.x === 0 && shift.y === 0;
    void syncWindow(next, point, preserveClient).finally(() => {
      if (gen !== layoutGen) {
        return;
      }
      placed = { cx: next.mainCx, cy: next.mainCy, w: next.width, h: next.height };
      if (pinX !== 0 || pinY !== 0) {
        pinX = 0;
        pinY = 0;
        pin = { x: 0, y: 0 };
      }
      if (shouldHold) {
        holding = false;
        void settleHover();
      }
    });
  });

  let hitKey = "";
  $effect(() => {
    if (!ready || preview) {
      return;
    }
    const rects = hitRects(layout, mode, panelSize !== null);
    const key = JSON.stringify(rects);
    if (key === hitKey) {
      return;
    }
    hitKey = key;
    void setHitRects(rects);
  });

  let snapKey = "";
  $effect(() => {
    const key = `${metrics.snapInset}:${metrics.main}:${work.left}:${work.top}:${work.right}:${work.bottom}`;
    if (!ready || dragging) {
      return;
    }
    if (snapKey === key) {
      return;
    }
    snapKey = key;
    const snapped = snapAnchor(anchor, work, metrics.snapInset, metrics.main / 2);
    if (Math.abs(snapped.x - anchor.x) < 0.5 && Math.abs(snapped.y - anchor.y) < 0.5) {
      return;
    }
    anchor.x = snapped.x;
    anchor.y = snapped.y;
    void setAnchor({ x: anchor.x, y: anchor.y }).catch(() => {});
  });

  onMount(() => {
    let cancelled = false;
    let stopListening = () => {};
    if (preview) {
      document.body.classList.add("preview");
      work = viewportWork();
      anchor.x = Math.max(120, window.innerWidth - 88);
      anchor.y = window.innerHeight / 2;
      const snapped = snapAnchor(anchor, work, metrics.snapInset, metrics.main / 2);
      anchor.x = snapped.x;
      anchor.y = snapped.y;
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
        }
        const snapped = snapAnchor(anchor, work, metrics.snapInset, metrics.main / 2);
        anchor.x = snapped.x;
        anchor.y = snapped.y;
        await setAnchor({ x: anchor.x, y: anchor.y });
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
    if (dragging || holding) {
      return;
    }
    pointerInside = false;
    if (editor || settingsOpen || fill) {
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
    if (mode === "buckets" && activeBucketId === null) {
      return;
    }
    activeBucketId = null;
    mode = "buckets";
  }

  function showActions(bucketId: string) {
    if (dragging) {
      return;
    }
    cancelCollapse();
    if (mode === "actions" && activeBucketId === bucketId) {
      return;
    }
    activeBucketId = bucketId;
    mode = "actions";
  }

  async function settleHover() {
    if (preview || dragging || holding || editor || settingsOpen || fill) {
      return;
    }
    const cursor = await readCursor();
    if (dragging || holding || editor || settingsOpen || fill) {
      return;
    }
    if (!cursor) {
      return;
    }
    const originNow = windowOrigin(layout, anchor);
    const margin = 12;
    const inside =
      cursor.x >= originNow.x - margin &&
      cursor.x <= originNow.x + layout.width + margin &&
      cursor.y >= originNow.y - margin &&
      cursor.y <= originNow.y + layout.height + margin;
    if (!inside) {
      scheduleCollapse();
    }
  }

  function screenDelta(event: PointerEvent): { x: number; y: number; useScreen: boolean } {
    if (!drag) {
      return { x: 0, y: 0, useScreen: false };
    }
    const screenDx = event.screenX - drag.sx;
    const screenDy = event.screenY - drag.sy;
    const useScreen = Math.hypot(screenDx, screenDy) > 0;
    const unit = !preview && useScreen ? window.devicePixelRatio || 1 : 1;
    return {
      x: useScreen ? screenDx / unit : event.clientX - drag.cx,
      y: useScreen ? screenDy / unit : event.clientY - drag.cy,
      useScreen,
    };
  }

  async function pullCursor() {
    const current = drag;
    if (!current?.moved || !current.os) {
      return;
    }
    if (cursorBusy) {
      cursorAgain = true;
      return;
    }
    cursorBusy = true;
    try {
      const cursor = await readCursor();
      if (!cursor || drag !== current || !current.moved) {
        return;
      }
      anchor.x = cursor.x - current.grabX;
      anchor.y = cursor.y - current.grabY;
    } finally {
      cursorBusy = false;
      if (cursorAgain) {
        cursorAgain = false;
        if (drag?.moved && drag.os) {
          void pullCursor();
        }
      }
    }
  }

  function closePanels() {
    editor = null;
    fill = null;
    settingsOpen = false;
    if (!pointerInside) {
      mode = "idle";
      activeBucketId = null;
    }
  }

  function togglePanel() {
    if (editor) {
      closePanels();
      return;
    }
    settingsOpen = false;
    fill = null;
    editor = { bucketId: buckets[0]?.id ?? "" };
    activeBucketId = null;
    mode = "buckets";
  }

  function openSettings() {
    editor = null;
    fill = null;
    settingsOpen = true;
    mode = "buckets";
  }

  function openEditor(bucketId: string, itemId: string) {
    fill = null;
    settingsOpen = false;
    editor = { bucketId, itemId };
    mode = "buckets";
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
      lastSx: event.screenX,
      lastSy: event.screenY,
      cx: event.clientX,
      cy: event.clientY,
      ax: anchor.x,
      ay: anchor.y,
      grabX: 0,
      grabY: 0,
      os: false,
      moved: false,
    };
    if (!preview) {
      const current = drag;
      void readCursor().then((cursor) => {
        if (!cursor || drag !== current) {
          return;
        }
        const unit = window.devicePixelRatio || 1;
        const screenNowX = current.lastSx / unit;
        const screenNowY = current.lastSy / unit;
        const screenDownX = current.sx / unit;
        const screenDownY = current.sy / unit;
        current.grabX = cursor.x - (screenNowX - screenDownX) - current.ax;
        current.grabY = cursor.y - (screenNowY - screenDownY) - current.ay;
        current.os = true;
        if (current.moved) {
          void pullCursor();
        }
      });
    }
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
    drag.lastSx = event.screenX;
    drag.lastSy = event.screenY;
    const delta = screenDelta(event);
    if (!drag.moved && Math.hypot(delta.x, delta.y) < 4) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      dragging = true;
      lockedPlacement = placement;
      if (!preview) {
        setDragLock(true);
      }
    }
    if (!preview && drag.os) {
      void pullCursor();
      return;
    }
    anchor.x = drag.ax + delta.x;
    anchor.y = drag.ay + delta.y;
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
      void finishDrag();
    }
  }

  async function finishDrag() {
    try {
      if (!preview) {
        const area = await readWorkArea();
        if (area) {
          work = area;
        }
      }
      const snapped = snapAnchor(anchor, work, metrics.snapInset, metrics.main / 2);
      anchor.x = snapped.x;
      anchor.y = snapped.y;
      lockedPlacement = null;
      await setAnchor({ x: anchor.x, y: anchor.y }).catch(() => {});
      if (!preview) {
        const preserveClient = !placed || (placed.cx === layout.mainCx && placed.cy === layout.mainCy);
        await syncWindow(layout, anchor, preserveClient);
      }
    } finally {
      if (!preview) {
        setDragLock(false);
      }
    }
  }

  function onMainClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    togglePanel();
  }

  function findOwned(bucketId: string, itemId: string): ToolItem | undefined {
    return findItem(buckets, bucketId, itemId);
  }

  async function activate(bucketId: string, itemId: string) {
    const item = findOwned(bucketId, itemId);
    if (item?.type === "command" && parseTemplate(item.command ?? "").length > 0) {
      editor = null;
      settingsOpen = false;
      fill = { bucketId, itemId };
      mode = "buckets";
      return;
    }
    try {
      const result = await runItem(bucketId, itemId);
      showNotice(result.message);
    } catch (cause) {
      showNotice(messageFrom(cause));
    }
  }

  async function runPrompt(values: Record<string, string>) {
    if (!fill) {
      return;
    }
    const result = await runFilled(fill.bucketId, fill.itemId, values);
    fill = null;
    showNotice(result.message);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && (editor || settingsOpen || fill)) {
      closePanels();
    }
  }

  function onStagePointerDown(event: PointerEvent) {
    if (!fill) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest(".panel") || target?.closest(".orb.action")) {
      return;
    }
    fill = null;
  }

  function findItem(list: Bucket[], bucketId?: string, itemId?: string): ToolItem | undefined {
    if (!bucketId || !itemId) {
      return undefined;
    }
    return list.find((bucket) => bucket.id === bucketId)?.items.find((item) => item.id === itemId);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<main
  class="stage"
  class:preview
  class:dragging
  class:holding
  style:transform={pin.x !== 0 || pin.y !== 0 ? `translate3d(${pin.x}px, ${pin.y}px, 0)` : undefined}
  style:width="{layout.width}px"
  style:height="{layout.height}px"
  style:left="{preview ? `${origin.x}px` : '0px'}"
  style:top="{preview ? `${origin.y}px` : '0px'}"
  style:--motion="{metrics.animationMs}ms"
  style:--dim="{metrics.unfocusedOpacity}"
  onpointerdown={onStagePointerDown}
  onpointerenter={cancelCollapse}
  onpointerleave={scheduleCollapse}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each layout.nodes as node (node.key)}
    {@const focused =
      (node.kind === "bucket" || node.kind === "settings") && node.bucketId === activeBucketId}
    {@const dim =
      (node.kind === "bucket" || node.kind === "settings") &&
      activeBucketId !== null &&
      node.bucketId !== activeBucketId}
    <div
      class="orb {node.kind}"
      class:dim
      class:focused
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
          class="sphere main"
          type="button"
          aria-label="添加工具"
          aria-pressed={editor !== null}
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
            if (node.bucketId) {
              showActions(node.bucketId);
            }
          }}
          onclick={() => {
            if (node.kind === "settings") {
              openSettings();
            } else if (node.kind === "action" && node.bucketId && node.itemId) {
              void activate(node.bucketId, node.itemId);
            }
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (node.kind === "action" && node.bucketId && node.itemId) {
              openEditor(node.bucketId, node.itemId);
            }
          }}
        >
          {#if node.kind === "settings"}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.2 6.2l1.6 1.6M16.2 16.2l1.6 1.6M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6" />
            </svg>
          {:else}
            <span class="glyph">{node.icon || mark(node.label)}</span>
          {/if}
        </button>
        <span class="caption" class:above={layout.labelAbove}>{node.label}</span>
      {/if}
    </div>
  {/each}

  {#if notice}
    <p class="notice" style:left="{noticePos.left}px" style:top="{noticePos.top}px" style:transform={noticePos.transform}>{notice}</p>
  {/if}

  {#if layout.panel && snapshot}
    <div
      class="panel"
      style:left="{layout.panel.left}px"
      style:top="{layout.panel.top}px"
      style:width="{layout.panel.w}px"
      style:height="{layout.panel.h}px"
    >
      {#if settingsOpen}
        <SettingsPanel {snapshot} onClose={closePanels} onChange={(next) => (snapshot = next)} />
      {:else if fill && fillItem}
        <FillPanel
          item={fillItem}
          specs={mergePlaceholders(fillItem.command ?? "", fillItem.placeholders)}
          onRun={runPrompt}
          onClose={closePanels}
        />
      {:else if editor}
        <AddPanel
          {snapshot}
          editing={editingItem ? { bucketId: editor.bucketId, item: editingItem } : null}
          onClose={closePanels}
          onChange={(next) => (snapshot = next)}
          onNotice={showNotice}
        />
      {/if}
    </div>
  {/if}
</main>

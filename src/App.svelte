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
  import { computeLayout, mark, type ClusterMode, type Layout } from "./lib/layout";
  import type { AppSnapshot, Bucket } from "./lib/types";
  import { defaultAnchor, installMoveSaver, syncWindow } from "./lib/window";

  const fallbackBuckets: Bucket[] = [
    { id: "navigation", name: "导航", items: [] },
    { id: "command", name: "指令", items: [] },
  ];

  let snapshot = $state<AppSnapshot | null>(null);
  let mode = $state<ClusterMode>("idle");
  let activeBucketId = $state<string | null>(null);
  let panelOpen = $state(false);
  let notice = $state<string | null>(null);
  let ready = $state(false);
  let pointerInside = false;

  const anchor = { x: 180, y: 220 };
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;

  let buckets = $derived(snapshot?.config.buckets ?? fallbackBuckets);
  let layout: Layout = $derived(
    computeLayout(buckets, mode, activeBucketId, panelOpen, notice !== null),
  );

  $effect(() => {
    const current = layout;
    if (!ready) {
      return;
    }
    void syncWindow(current, anchor);
  });

  onMount(() => {
    let cancelled = false;
    let stopListening = () => {};
    void (async () => {
      if (!inTauri()) {
        document.body.classList.add("preview");
      }
      try {
        const next = await getSnapshot();
        if (cancelled) {
          return;
        }
        snapshot = next;
        if (next.warning) {
          showNotice(next.warning);
        }
        if (next.config.anchor) {
          anchor.x = next.config.anchor.x;
          anchor.y = next.config.anchor.y;
        } else if (inTauri()) {
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
      if (inTauri() && !cancelled) {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<AppSnapshot>("config-updated", (event) => {
          snapshot = event.payload;
        });
        const stopMoves = await installMoveSaver(() => layout, anchor, setAnchor);
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
    if (panelOpen) {
      return;
    }
    if (collapseTimer) {
      clearTimeout(collapseTimer);
    }
    collapseTimer = setTimeout(() => {
      mode = "idle";
      activeBucketId = null;
    }, 260);
  }

  function expandBuckets() {
    cancelCollapse();
    if (mode === "idle") {
      mode = "buckets";
    }
  }

  function expandActions(bucketId: string) {
    cancelCollapse();
    activeBucketId = bucketId;
    mode = "actions";
  }

  function togglePanel(event: MouseEvent) {
    event.stopPropagation();
    panelOpen = !panelOpen;
    if (panelOpen) {
      mode = mode === "idle" ? "buckets" : mode;
    } else if (!pointerInside) {
      mode = "idle";
      activeBucketId = null;
    }
  }

  function closePanel() {
    panelOpen = false;
    if (!pointerInside) {
      mode = "idle";
      activeBucketId = null;
    }
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
</script>

<svelte:window onkeydown={onKeydown} />

<main
  class="stage"
  style:width="{layout.width}px"
  style:height="{layout.height}px"
  onpointerenter={cancelCollapse}
  onpointerleave={scheduleCollapse}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each layout.nodes as node (node.key)}
    {#if node.kind === "main"}
      <div
        class="sphere main"
        role="group"
        aria-label="PowerSphere"
        data-tauri-drag-region
        style:left="{node.cx - node.r}px"
        style:top="{node.cy - node.r}px"
        style:width="{node.r * 2}px"
        style:height="{node.r * 2}px"
        onpointerenter={expandBuckets}
      >
        <button class="plus" type="button" aria-label="添加工具" onmousedown={(event) => event.stopPropagation()} onclick={togglePanel}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11 4.5h2v15h-2zM4.5 11h15v2h-15z" />
          </svg>
        </button>
      </div>
    {:else}
      <button
        class="sphere {node.kind}"
        type="button"
        title={node.label}
        aria-label={node.label}
        style:left="{node.cx - node.r}px"
        style:top="{node.cy - node.r}px"
        style:width="{node.r * 2}px"
        style:height="{node.r * 2}px"
        onpointerenter={() => {
          if (node.kind === "bucket" && node.bucketId) {
            expandActions(node.bucketId);
          }
        }}
        onclick={() => {
          if (node.kind === "action" && node.bucketId && node.itemId) {
            void activate(node.bucketId, node.itemId);
          }
        }}
      >
        <span class="mark">{mark(node.label)}</span>
      </button>
      <span class="caption" style:left="{node.cx}px" style:top="{node.cy + node.r}px">
        {node.label}
      </span>
    {/if}
  {/each}

  {#if notice}
    <p class="notice" style:top="{layout.height - 26}px">{notice}</p>
  {/if}

  {#if panelOpen && layout.panel && snapshot}
    <div
      class="panel"
      style:left="{layout.panel.x}px"
      style:top="{layout.panel.y}px"
      style:width="{layout.panel.w}px"
      style:height="{layout.panel.h}px"
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

<script lang="ts">
  import { updateSettings, updateStyle } from "./api";
  import { GLYPHS, SPHERE_STYLES, defaultGlyph, normalizeGlyph, normalizeStyle } from "./jewel";
  import MainJewel from "./MainJewel.svelte";
  import type { AppSnapshot, StyleSettings } from "./types";

  let {
    snapshot,
    onClose,
    onChange,
  }: {
    snapshot: AppSnapshot;
    onClose: () => void;
    onChange: (snapshot: AppSnapshot) => void;
  } = $props();

  const current = $derived<StyleSettings>({
    snapInset: snapshot.config.style?.snapInset ?? 16,
    gap: snapshot.config.style?.gap ?? 12,
    sphereSize: snapshot.config.style?.sphereSize ?? 64,
    animationMs: snapshot.config.style?.animationMs ?? 220,
    unfocusedOpacity: snapshot.config.style?.unfocusedOpacity ?? 0.38,
    sphereStyle: normalizeStyle(snapshot.config.style?.sphereStyle),
    centerGlyph: normalizeGlyph(snapshot.config.style?.centerGlyph),
  });

  let snapInset = $state(16);
  let gap = $state(12);
  let sphereSize = $state(64);
  let animationMs = $state(220);
  let unfocusedOpacity = $state(0.38);
  let sphereStyle = $state("glass");
  let glyphChoice = $state<string | null>(null);
  let autostart = $state(true);
  let gitBashPath = $state("");
  let error = $state<string | null>(null);
  let seeded = false;
  let styleTicket = 0;

  $effect(() => {
    if (seeded) {
      return;
    }
    snapInset = current.snapInset;
    gap = current.gap;
    sphereSize = current.sphereSize;
    animationMs = current.animationMs;
    unfocusedOpacity = current.unfocusedOpacity;
    sphereStyle = current.sphereStyle ?? "glass";
    glyphChoice = current.centerGlyph ?? null;
    autostart = snapshot.config.autostart;
    gitBashPath = snapshot.config.gitBashPath ?? "";
    seeded = true;
  });

  function draft(): StyleSettings {
    return {
      snapInset: Number(snapInset),
      gap: Number(gap),
      sphereSize: Number(sphereSize),
      animationMs: Number(animationMs),
      unfocusedOpacity: Number(unfocusedOpacity),
      sphereStyle,
      centerGlyph: glyphChoice,
    };
  }

  function persistChoice(kind: "sphereStyle" | "glyph", value: string) {
    if (kind === "sphereStyle") {
      sphereStyle = value;
    } else {
      glyphChoice = value;
    }
    const ticket = ++styleTicket;
    void updateStyle(draft())
      .then((saved) => {
        if (ticket === styleTicket) {
          onChange(saved);
        }
      })
      .catch((cause: unknown) => {
        error = cause instanceof Error ? cause.message : "保存失败";
      });
  }

  async function persistStyle(event: Event) {
    error = null;
    const input = event.currentTarget as HTMLInputElement;
    const key = input.dataset.key ?? "";
    const numeric = Number(input.value);
    const next = draft();
    if (key === "snapInset") {
      snapInset = numeric;
      next.snapInset = numeric;
    } else if (key === "gap") {
      gap = numeric;
      next.gap = numeric;
    } else if (key === "sphereSize") {
      sphereSize = numeric;
      next.sphereSize = numeric;
    } else if (key === "animationMs") {
      animationMs = numeric;
      next.animationMs = numeric;
    } else if (key === "unfocusedOpacity") {
      unfocusedOpacity = numeric;
      next.unfocusedOpacity = numeric;
    }
    const ticket = ++styleTicket;
    try {
      const saved = await updateStyle(next);
      if (ticket === styleTicket) {
        onChange(saved);
      }
    } catch (cause) {
      if (ticket === styleTicket) {
        error = cause instanceof Error ? cause.message : "保存失败";
      }
    }
  }

  async function persistAutostart(checked = autostart) {
    autostart = checked;
    try {
      onChange(
        await updateSettings({
          autostart: checked,
          gitBashPath: gitBashPath.trim() ? gitBashPath.trim() : null,
        }),
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "保存失败";
    }
  }
</script>

<div class="panel-head">
  <h2>设置</h2>
  <button class="icon-button" type="button" aria-label="关闭" onclick={onClose}>×</button>
</div>
<div class="preview-stage" aria-hidden="true">
  <div class="sphere main jewel {sphereStyle}">
    <MainJewel {sphereStyle} glyph={glyphChoice} />
  </div>
</div>
<p class="hint">悬停预览。符号未指定时会跟随样式。</p>
<label class="field">
  <span>主球样式</span>
  <div class="choice-row">
    {#each SPHERE_STYLES as entry (entry.id)}
      <button
        type="button"
        aria-pressed={sphereStyle === entry.id}
        onclick={() => persistChoice("sphereStyle", entry.id)}
      >
        {entry.label}
      </button>
    {/each}
  </div>
</label>
<label class="field">
  <span>中心符号{glyphChoice ? "" : `（跟随：${GLYPHS.find((entry) => entry.id === defaultGlyph(sphereStyle))?.label}）`}</span>
  <div class="choice-row">
    {#each GLYPHS as entry (entry.id)}
      <button
        type="button"
        aria-pressed={(glyphChoice ?? defaultGlyph(sphereStyle)) === entry.id}
        onclick={() => persistChoice("glyph", entry.id)}
      >
        {entry.label}
      </button>
    {/each}
  </div>
</label>
<label class="field">
  <span>贴边距离 {snapInset}px</span>
    <input data-key="snapInset" type="range" min="0" max="80" bind:value={snapInset} oninput={persistStyle} />
</label>
<label class="field">
  <span>球体间距 {gap}px</span>
    <input data-key="gap" type="range" min="0" max="48" bind:value={gap} oninput={persistStyle} />
</label>
<label class="field">
  <span>球体大小 {sphereSize}px</span>
    <input data-key="sphereSize" type="range" min="44" max="96" bind:value={sphereSize} oninput={persistStyle} />
</label>
<label class="field">
  <span>动画时长 {animationMs}ms</span>
  <input data-key="animationMs" type="range" min="0" max="600" bind:value={animationMs} oninput={persistStyle} />
</label>
<label class="field">
  <span>未选中透明度 {unfocusedOpacity}</span>
  <input
    type="range"
    min="0.15"
    max="1"
    step="0.01"
    data-key="unfocusedOpacity"
    bind:value={unfocusedOpacity}
    oninput={persistStyle}
  />
</label>
<label class="check">
    <input
      type="checkbox"
      checked={autostart}
      onchange={(event) => persistAutostart((event.currentTarget as HTMLInputElement).checked)}
    />
  登录时启动
</label>
<label class="field">
  <span>Git Bash 路径</span>
  <input bind:value={gitBashPath} placeholder="留空则自动检测" onchange={() => persistAutostart()} />
</label>
<p class="hint">
  {#if snapshot.gitBashDetected}
    检测到：{snapshot.gitBashDetected}
  {:else if snapshot.gitBashError}
    {snapshot.gitBashError}
  {:else}
    未检测到 Git Bash
  {/if}
</p>
{#if error}
  <p class="error">{error}</p>
{/if}
<p class="path">{snapshot.configPath}</p>

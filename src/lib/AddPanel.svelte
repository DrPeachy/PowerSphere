<script lang="ts">
  import { untrack } from "svelte";
  import {
    addBucket,
    addTool,
    messageFrom,
    removeTool,
    updateSettings,
  } from "./api";
  import { SHELLS, type AppSnapshot } from "./types";

  let {
    snapshot,
    onClose,
    onChange,
    onNotice,
  }: {
    snapshot: AppSnapshot;
    onClose: () => void;
    onChange: (snapshot: AppSnapshot) => void;
    onNotice: (message: string) => void;
  } = $props();

  let kind = $state<"open-path" | "command" | "bucket">("open-path");
  let label = $state("");
  let target = $state("");
  let shell = $state("powershell");
  let cwd = $state("");
  let command = $state("");
  let bucketName = $state("");
  let bucketId = $state(untrack(() => snapshot.config.buckets[0]?.id ?? ""));
  let gitBashPath = $state(untrack(() => snapshot.config.gitBashPath ?? ""));
  let busy = $state(false);
  let error = $state<string | null>(null);

  let autostart = $derived(snapshot.config.autostart);
  let buckets = $derived(snapshot.config.buckets);
  let selectedItems = $derived(
    buckets.find((bucket) => bucket.id === bucketId)?.items ?? [],
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      if (kind === "bucket") {
        const next = await addBucket(bucketName);
        bucketName = "";
        onChange(next);
        onNotice("已添加分组");
        return;
      }
      if (!bucketId) {
        throw new Error("先添加一个分组");
      }
      const next =
        kind === "open-path"
          ? await addTool(bucketId, { type: "open-path", label, target })
          : await addTool(bucketId, {
              type: "command",
              label,
              shell,
              cwd: cwd.trim() ? cwd : undefined,
              command,
            });
      label = "";
      target = "";
      command = "";
      onChange(next);
      onNotice(kind === "open-path" ? "已添加导航" : "已添加指令");
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

  async function saveAutostart(event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    await saveSettings(checked, gitBashPath);
  }

  async function saveGitBash() {
    await saveSettings(autostart, gitBashPath);
  }

  async function saveSettings(enabled: boolean, path: string) {
    busy = true;
    error = null;
    try {
      const next = await updateSettings({
        autostart: enabled,
        gitBashPath: path.trim() ? path.trim() : null,
      });
      gitBashPath = next.config.gitBashPath ?? "";
      onChange(next);
      onNotice(enabled ? "已开启登录时启动" : "已关闭登录时启动");
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

  async function remove(itemBucketId: string, itemId: string) {
    busy = true;
    error = null;
    try {
      const next = await removeTool(itemBucketId, itemId);
      onChange(next);
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="panel-head">
  <h2>添加工具</h2>
  <button class="icon-button" type="button" aria-label="关闭" onclick={onClose}>×</button>
</div>

<div class="modes" role="tablist">
  <button type="button" aria-pressed={kind === "open-path"} onclick={() => (kind = "open-path")}>
    导航
  </button>
  <button type="button" aria-pressed={kind === "command"} onclick={() => (kind = "command")}>
    指令
  </button>
  <button type="button" aria-pressed={kind === "bucket"} onclick={() => (kind = "bucket")}>
    分组
  </button>
</div>

<form onsubmit={submit}>
  {#if kind === "bucket"}
    <label class="field">
      <span>分组名称</span>
      <input bind:value={bucketName} maxlength="40" placeholder="例如：开发" />
    </label>
  {:else}
    <label class="field">
      <span>名称</span>
      <input bind:value={label} maxlength="80" placeholder="显示在球体上" />
    </label>
    {#if kind === "open-path"}
      <label class="field">
        <span>路径或网址</span>
        <input bind:value={target} placeholder="%USERPROFILE%\Documents 或 https://..." />
      </label>
    {:else}
      <label class="field">
        <span>Shell</span>
        <select bind:value={shell}>
          {#each SHELLS as entry (entry.id)}
            <option value={entry.id}>{entry.label}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span>工作目录（可选）</span>
        <input bind:value={cwd} placeholder="留空则使用默认目录" />
      </label>
      <label class="field">
        <span>命令</span>
        <textarea bind:value={command} placeholder="git status --short"></textarea>
      </label>
    {/if}
    <label class="field">
      <span>放入分组</span>
      <select bind:value={bucketId}>
        {#each buckets as bucket (bucket.id)}
          <option value={bucket.id}>{bucket.name}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <button class="primary" type="submit" disabled={busy}>添加</button>
</form>

<section class="settings">
  <h3>设置</h3>
  <label class="check">
    <input type="checkbox" checked={autostart} onchange={saveAutostart} />
    登录时启动
  </label>
  <label class="field">
    <span>Git Bash 路径</span>
    <input bind:value={gitBashPath} placeholder="留空则自动检测" />
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
  <button class="text-button" type="button" disabled={busy} onclick={saveGitBash}>保存路径</button>
  <p class="path">{snapshot.configPath}</p>
</section>

<section>
  <h3>已有工具</h3>
  {#if selectedItems.length === 0}
    <p class="hint">这个分组还是空的。悬停主球体可以展开分组。</p>
  {:else}
    <div class="tools">
      {#each selectedItems as item (item.id)}
        <div class="tool-row">
          <span title={item.label}>{item.label}</span>
          <button class="text-button" type="button" disabled={busy} onclick={() => remove(bucketId, item.id)}>
            删除
          </button>
        </div>
      {/each}
    </div>
  {/if}
</section>

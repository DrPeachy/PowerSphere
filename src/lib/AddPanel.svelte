<script lang="ts">
  import { addBucket, addTool, messageFrom, pickPath, removeTool, updateTool } from "./api";
  import { mergePlaceholders, type PlaceholderSpec } from "./template";
  import { SHELLS, type AppSnapshot, type ToolItem } from "./types";

  let {
    snapshot,
    editing = null,
    onClose,
    onChange,
    onNotice,
  }: {
    snapshot: AppSnapshot;
    editing?: { bucketId: string; item: ToolItem } | null;
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
  let icon = $state("");
  let bucketName = $state("");
  let bucketId = $state("");
  let kinds = $state<Record<string, "text" | "file">>({});
  let busy = $state(false);
  let error = $state<string | null>(null);
  let seededId = "";

  let buckets = $derived(snapshot.config.buckets);
  let selectedItems = $derived(buckets.find((bucket) => bucket.id === bucketId)?.items ?? []);
  let parsed = $derived(
    mergePlaceholders(command, editing?.item.placeholders).map((spec) => ({
      ...spec,
      kind: kinds[spec.name] ?? spec.kind,
    })),
  );

  $effect(() => {
    const item = editing?.item;
    if (!item) {
      seededId = "";
      if (!bucketId) {
        bucketId = snapshot.config.buckets[0]?.id ?? "";
      }
      return;
    }
    if (seededId === item.id) {
      return;
    }
    seededId = item.id;
    kind = item.type === "command" ? "command" : "open-path";
    label = item.label;
    target = item.target ?? "";
    shell = item.shell ?? "powershell";
    cwd = item.cwd ?? "";
    command = item.command ?? "";
    icon = item.icon ?? "";
    bucketId = editing?.bucketId ?? bucketId;
    const next: Record<string, "text" | "file"> = {};
    for (const spec of item.placeholders ?? []) {
      next[spec.name] = spec.kind;
    }
    kinds = next;
  });

  function setKind(name: string, value: "text" | "file") {
    kinds = { ...kinds, [name]: value };
  }

  async function chooseFolder() {
    const selected = await pickPath(true);
    if (selected) {
      cwd = selected;
    }
  }

  function placeholderPayload(): PlaceholderSpec[] {
    return parsed.map((spec) => ({
      name: spec.name,
      kind: spec.kind,
      recent: [...(spec.recent ?? [])],
    }));
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      if (!editing && kind === "bucket") {
        const next = await addBucket(bucketName);
        bucketName = "";
        onChange(next);
        onNotice("已添加分组");
        return;
      }
      if (!bucketId) {
        throw new Error("先添加一个分组");
      }
      const tool =
        kind === "open-path"
          ? { type: "open-path" as const, label, target, icon: icon.trim() || undefined }
          : {
              type: "command" as const,
              label,
              shell,
              cwd: cwd.trim() || undefined,
              command,
              icon: icon.trim() || undefined,
              placeholders: placeholderPayload(),
            };
      const next = editing
        ? await updateTool(bucketId, editing.item.id, tool)
        : await addTool(bucketId, tool);
      if (!editing) {
        label = "";
        target = "";
        command = "";
        icon = "";
      }
      onChange(next);
      onNotice(editing ? "已保存" : kind === "open-path" ? "已添加导航" : "已添加指令");
      if (editing) {
        onClose();
      }
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!editing) {
      return;
    }
    busy = true;
    error = null;
    try {
      onChange(await removeTool(editing.bucketId, editing.item.id));
      onClose();
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="panel-head">
  <h2>{editing ? "编辑工具" : "添加工具"}</h2>
  <button class="icon-button" type="button" aria-label="关闭" onclick={onClose}>×</button>
</div>

{#if !editing}
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
{/if}

<form onsubmit={submit}>
  {#if !editing && kind === "bucket"}
    <label class="field">
      <span>分组名称</span>
      <input bind:value={bucketName} maxlength="40" placeholder="例如：开发" />
    </label>
  {:else}
    <label class="field">
      <span>名称</span>
      <input bind:value={label} maxlength="80" placeholder="显示在球体上" />
    </label>
    <label class="field">
      <span>图标</span>
      <input bind:value={icon} maxlength="4" placeholder="一个字或 emoji，可留空" />
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
        <div class="inline">
          <input bind:value={cwd} placeholder="git 仓库目录" />
          <button class="text-button" type="button" onclick={chooseFolder}>选择</button>
        </div>
      </label>
      <label class="field">
        <span>命令模板</span>
        <textarea bind:value={command} placeholder="git merge {'{branch}'} --verbose"></textarea>
      </label>
      <p class="hint">用 {'{branch}'} 或 {'{apk:file}'} 标记每次运行要填的参数。</p>
      {#each parsed as spec (spec.name)}
        <label class="field">
          <span>{spec.name}</span>
          <select value={spec.kind} onchange={(event) => setKind(spec.name, (event.currentTarget as HTMLSelectElement).value as "text" | "file")}>
            <option value="text">文本</option>
            <option value="file">文件</option>
          </select>
        </label>
      {/each}
    {/if}
    {#if !editing}
      <label class="field">
        <span>放入分组</span>
        <select bind:value={bucketId}>
          {#each buckets as bucket (bucket.id)}
            <option value={bucket.id}>{bucket.name}</option>
          {/each}
        </select>
      </label>
    {/if}
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <button class="primary" type="submit" disabled={busy}>{editing ? "保存" : "添加"}</button>
  {#if editing}
    <button class="text-button danger" type="button" disabled={busy} onclick={remove}>删除</button>
  {/if}
</form>

{#if !editing}
  <section>
    <h3>已有工具</h3>
    {#if selectedItems.length === 0}
      <p class="hint">这个分组还是空的。悬停主球体可以展开分组。</p>
    {:else}
      <div class="tools">
        {#each selectedItems as item (item.id)}
          <div class="tool-row">
            <span title={item.label}>{item.label}</span>
            <button class="text-button" type="button" disabled={busy} onclick={() => removeTool(bucketId, item.id).then(onChange)}>
              删除
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}

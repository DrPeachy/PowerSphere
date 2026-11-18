<script lang="ts">
  import { pickPath } from "./api";
  import type { PlaceholderSpec, ToolItem } from "./types";

  let {
    item,
    specs,
    onRun,
    onClose,
  }: {
    item: ToolItem;
    specs: PlaceholderSpec[];
    onRun: (values: Record<string, string>) => Promise<void>;
    onClose: () => void;
  } = $props();

  let values = $state<Record<string, string>>({});
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function chooseFile(name: string) {
    const selected = await pickPath(false);
    if (selected) {
      values[name] = selected;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await onRun(values);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "运行失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="panel-head">
  <h2>{item.label}</h2>
  <button class="icon-button" type="button" aria-label="关闭" onclick={onClose}>×</button>
</div>
<p class="hint template">{item.command}</p>
<form onsubmit={submit}>
  {#each specs as spec (spec.name)}
    <label class="field">
      <span>{spec.name}</span>
      <div class="inline">
        <input
          bind:value={values[spec.name]}
          placeholder={spec.kind === "file" ? "文件路径" : "填写后运行"}
        />
        {#if spec.kind === "file"}
          <button class="text-button" type="button" onclick={() => chooseFile(spec.name)}>选择</button>
        {/if}
      </div>
    </label>
    {#if spec.recent && spec.recent.length > 0}
      <div class="chips">
        {#each spec.recent as recent (recent)}
          <button type="button" class="chip" onclick={() => (values[spec.name] = recent)}>{recent}</button>
        {/each}
      </div>
    {/if}
  {/each}
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <button class="primary" type="submit" disabled={busy}>运行</button>
</form>

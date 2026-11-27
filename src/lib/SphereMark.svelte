<script lang="ts">
  import { resolveSphereMark } from "./icons";

  let { icon = "", label, hint }: { icon?: string; label: string; hint: string } = $props();

  let shown = $derived(resolveSphereMark(icon, hint || label, label));
  let Icon = $derived(shown.icon);
</script>

{#if Icon}
  <Icon strokeWidth={1.6} />
{:else}
  <span class="glyph">{shown.text}</span>
{/if}

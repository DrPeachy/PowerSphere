<script lang="ts">
  import { SPHERE_ICONS, type SphereIconName } from "./icons";

  let { value = $bindable("") }: { value?: string } = $props();

  const names = Object.keys(SPHERE_ICONS) as SphereIconName[];
</script>

<div class="icon-grid" aria-label="图标">
  <button type="button" class="icon-cell auto" aria-pressed={value === ""} onclick={() => (value = "")}>
    自动
  </button>
  {#each names as name (name)}
    {@const Icon = SPHERE_ICONS[name]}
    <button
      type="button"
      class="icon-cell"
      aria-pressed={value === name}
      aria-label={name}
      title={name}
      onclick={() => (value = name)}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  {/each}
</div>

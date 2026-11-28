<script lang="ts">
  import AddPanel from "./AddPanel.svelte";
  import FillPanel from "./FillPanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import { appConfig } from "./stores/appConfig.svelte";
  import { cluster } from "./stores/cluster.svelte";
  import { shellMotion } from "./stores/shellMotion.svelte";
  import { mergePlaceholders } from "./template";
</script>

{#if shellMotion.layout.panel && appConfig.snapshot}
  <div
    class="panel"
    style:left="{shellMotion.layout.panel.left}px"
    style:top="{shellMotion.layout.panel.top}px"
    style:width="{shellMotion.layout.panel.w}px"
    style:height="{shellMotion.layout.panel.h}px"
  >
    {#if cluster.settingsOpen}
      <SettingsPanel
        snapshot={appConfig.snapshot}
        onClose={cluster.closePanels}
        onChange={(next) => appConfig.setSnapshot(next)}
      />
    {:else if cluster.fill && cluster.fillItem}
      <FillPanel
        item={cluster.fillItem}
        specs={mergePlaceholders(cluster.fillItem.command ?? "", cluster.fillItem.placeholders)}
        onRun={cluster.runPrompt}
        onClose={cluster.closePanels}
      />
    {:else if cluster.editor}
      <AddPanel
        snapshot={appConfig.snapshot}
        editing={cluster.editingItem
          ? { bucketId: cluster.editor.bucketId, item: cluster.editingItem }
          : null}
        onClose={cluster.closePanels}
        onChange={(next) => appConfig.setSnapshot(next)}
        onNotice={(text) => appConfig.showNotice(text)}
      />
    {/if}
  </div>
{/if}

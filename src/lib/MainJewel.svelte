<script lang="ts">
  import { resolveGlyph } from "./jewel";

  let {
    sphereStyle = "glass",
    glyph = null,
  }: {
    sphereStyle?: string | null;
    glyph?: string | null;
  } = $props();

  let mark = $derived(resolveGlyph(sphereStyle ?? "glass", glyph));
</script>

<div class="body glass" class:on={sphereStyle === "glass" || !sphereStyle}>
  <i class="layer caus"></i>
  <i class="layer rim"></i>
  <i class="layer spec"></i>
</div>
<div class="body pearl" class:on={sphereStyle === "pearl"}>
  <i class="layer iri"></i>
  <i class="layer spec"></i>
</div>
<div class="body obsidian" class:on={sphereStyle === "obsidian"}>
  <i class="layer halo"></i>
  <i class="layer gloss"></i>
  <i class="core"></i>
</div>

<div class="sigil plus" class:on={mark === "plus"}>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="arm" pathLength="1" d="M12 12V4.8" />
    <path class="arm" pathLength="1" d="M12 12V19.2" />
    <path class="arm" pathLength="1" d="M12 12H4.8" />
    <path class="arm" pathLength="1" d="M12 12H19.2" />
  </svg>
</div>
<div class="sigil dots" class:on={mark === "dots"} aria-hidden="true">
  <i></i><i></i><i></i><i></i>
</div>
<div class="sigil petals" class:on={mark === "petals"} aria-hidden="true">
  <i class="petal p1"></i>
  <i class="petal p2"></i>
  <i class="petal p3"></i>
  <i class="petal p4"></i>
</div>
<div class="sigil power" class:on={mark === "power"}>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="arc" pathLength="1" d="M7.2 8.1a5.6 5.6 0 1 0 9.6 0" />
    <path class="stem" pathLength="1" d="M12 11.2V3.4" />
  </svg>
</div>
<div class="sigil spark" class:on={mark === "spark"} aria-hidden="true">
  <i class="spark"></i>
</div>

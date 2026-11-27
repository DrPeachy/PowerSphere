export const SPHERE_STYLES = [
  { id: "glass", label: "液态玻璃" },
  { id: "pearl", label: "珍珠" },
  { id: "obsidian", label: "黑曜石" },
] as const;

export const GLYPHS = [
  { id: "plus", label: "细线加号" },
  { id: "dots", label: "四点" },
  { id: "petals", label: "花瓣" },
  { id: "power", label: "电源" },
  { id: "spark", label: "光点" },
  { id: "none", label: "无" },
] as const;

export type SphereStyle = (typeof SPHERE_STYLES)[number]["id"];
export type GlyphId = (typeof GLYPHS)[number]["id"];

export function normalizeStyle(value: string | null | undefined): SphereStyle {
  if (value === "pearl" || value === "obsidian") {
    return value;
  }
  return "glass";
}

export function defaultGlyph(style: string): GlyphId {
  if (style === "pearl") {
    return "dots";
  }
  if (style === "obsidian") {
    return "petals";
  }
  return "plus";
}

export function normalizeGlyph(value: string | null | undefined): GlyphId | null {
  if (value === "plus" || value === "dots" || value === "petals" || value === "power" || value === "spark" || value === "none") {
    return value;
  }
  return null;
}

export function resolveGlyph(style: string, glyph: string | null | undefined): GlyphId {
  return normalizeGlyph(glyph) ?? defaultGlyph(normalizeStyle(style));
}

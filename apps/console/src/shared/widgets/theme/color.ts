// sRGB colors as the theme engine stores them: canonical lowercase hex,
// `#rrggbb` when opaque and `#rrggbbaa` otherwise.

/** Channels 0..255 (integers after parsing; compositing may produce fractions), alpha 0..1. */
export type Rgba = { r: number; g: number; b: number; a: number };

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa`; null for anything else. */
export function parseHexColor(text: string): Rgba | null {
  if (!HEX_COLOR_PATTERN.test(text)) return null;
  let hex = text.slice(1).toLowerCase();
  if (hex.length === 3) hex = hex.replace(/./g, (char) => char + char);
  const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
}

/** Canonical hex: `#rrggbb`, plus `aa` when alpha rounds below 255. Channels are clamped and rounded. */
export function formatHexColor(color: Rgba): string {
  const byte = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  const alpha = Math.min(255, Math.max(0, Math.round(color.a * 255)));
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha < 255 ? byte(alpha) : ""}`;
}

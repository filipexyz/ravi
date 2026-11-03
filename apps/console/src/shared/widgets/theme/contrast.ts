// WCAG 2.x contrast for theme tokens. The checks are the pairs the pieces
// stylesheet draws: text on the page surface (background.primary) and on the
// secondary one (subtle cards, lanes, badges, steps, hover), status text and
// links on both and on their own tint, avatar initials on background.tertiary,
// option pills, control borders, focus rings and the accent button on both
// surfaces. A theme with any failing pair does not publish.

import type { ContrastCheck, ContrastReport, ThemeMode } from "../types";
import { OPTION_COLORS } from "../types";
import { parseHexColor, type Rgba } from "./color";

export type ContrastPair = { fg: string; bg: string; min: 3 | 4.5 };

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** Pairs checked in one mode, as full token paths (`color.<mode>.…`). */
export function themeContrastPairs(mode: ThemeMode): ContrastPair[] {
  const p = (path: string) => `color.${mode}.${path}`;
  const pairs: ContrastPair[] = [];
  for (const text of ["primary", "secondary", "tertiary"]) {
    for (const background of ["primary", "secondary"]) {
      pairs.push({ fg: p(`text.${text}`), bg: p(`background.${background}`), min: 4.5 });
    }
  }
  // Avatar initials (and an image's alt text while it loads).
  pairs.push({ fg: p("text.primary"), bg: p("background.tertiary"), min: 4.5 });
  // Tone text, links (text.info), stars and the danger button.
  for (const status of ["info", "success", "warning", "danger"]) {
    pairs.push({ fg: p(`text.${status}`), bg: p("background.primary"), min: 4.5 });
    pairs.push({ fg: p(`text.${status}`), bg: p("background.secondary"), min: 4.5 });
    pairs.push({ fg: p(`text.${status}`), bg: p(`background.${status}`), min: 4.5 });
  }
  pairs.push({ fg: p("text.inverse"), bg: p("background.inverse"), min: 4.5 });
  pairs.push({ fg: p("accent.text"), bg: p("accent.base"), min: 4.5 });
  for (const color of OPTION_COLORS) {
    pairs.push({ fg: p(`option.${color}.text`), bg: p(`option.${color}.background`), min: 4.5 });
  }
  for (const background of ["primary", "secondary"]) {
    pairs.push({ fg: p("border.primary"), bg: p(`background.${background}`), min: 3 });
    pairs.push({ fg: p("ring.primary"), bg: p(`background.${background}`), min: 3 });
    pairs.push({ fg: p("accent.base"), bg: p(`background.${background}`), min: 3 });
  }
  return pairs;
}

/** WCAG 2.x relative luminance of an opaque color. */
export function relativeLuminance(color: Rgba): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** `top` over `bottom` (source-over in sRGB, like browsers paint). `bottom` must be opaque. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function luminanceRatio(first: Rgba, second: Rgba) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Contrast ratio (1..21) of `fg` drawn on `bg`, both hex colors. A
 * translucent `bg` is composited over `base` (default white) and a
 * translucent `fg` over the result. Returns 0 when a color does not parse.
 */
export function contrastRatio(fg: string, bg: string, base = "#ffffff"): number {
  const fgColor = parseHexColor(fg);
  const bgColor = parseHexColor(bg);
  if (!fgColor || !bgColor) return 0;
  const baseColor = compositeOver(parseHexColor(base) ?? WHITE, WHITE);
  const background = compositeOver(bgColor, baseColor);
  return luminanceRatio(compositeOver(fgColor, background), background);
}

/**
 * Runs every check of both modes on resolved tokens (path → canonical hex).
 * Translucent colors are composited over the mode's `background.primary`
 * (itself over white in light, black in dark). `ok` compares the unrounded
 * ratio; the report rounds to 2 decimals and never rounds a failure up to
 * its minimum.
 */
export function checkThemeContrast(tokens: Record<string, string>): ContrastReport {
  const checks: ContrastCheck[] = [];
  for (const mode of ["light", "dark"] as const) {
    const page = parseHexColor(tokens[`color.${mode}.background.primary`] ?? "");
    const base = compositeOver(page ?? WHITE, mode === "light" ? WHITE : BLACK);
    for (const { fg, bg, min } of themeContrastPairs(mode)) {
      const fgColor = parseHexColor(tokens[fg] ?? "");
      const bgColor = parseHexColor(tokens[bg] ?? "");
      let ratio = 0;
      if (fgColor && bgColor) {
        const background = compositeOver(bgColor, base);
        ratio = luminanceRatio(compositeOver(fgColor, background), background);
      }
      const ok = ratio >= min;
      checks.push({ mode, pair: [fg, bg], ratio: reportedRatio(ratio, ok, min), min, ok });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

function reportedRatio(ratio: number, ok: boolean, min: number) {
  const rounded = Math.round(ratio * 100) / 100;
  return !ok && rounded >= min ? Math.floor(ratio * 100) / 100 : rounded;
}

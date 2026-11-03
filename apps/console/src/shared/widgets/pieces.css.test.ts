import { describe, expect, test } from "bun:test";

import { PIECES_CSS, PIECES_CSS_FALLBACKS } from "./pieces.css";
import { PIECES } from "./template/catalog";
import { defaultCompiledTheme } from "./theme/default";

const VAR_WITH_FALLBACK = /var\((--[a-z0-9-]+), ([^()]*)\)/g;

describe("PIECES_CSS", () => {
  test("is one balanced @layer ravi.pieces block", () => {
    expect(PIECES_CSS.startsWith("@layer ravi.pieces {")).toBe(true);
    expect(PIECES_CSS.trimEnd().endsWith("}")).toBe(true);
    let depth = 0;
    for (const char of PIECES_CSS) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(PIECES_CSS).not.toContain("<");
  });

  test("every theme variable has a fallback equal to the default light theme", () => {
    const theme = defaultCompiledTheme();
    const defaults: Record<string, string> = { ...theme.vars.base, ...theme.vars.light };
    for (const [name, fallback] of Object.entries(PIECES_CSS_FALLBACKS)) {
      expect({ name, value: defaults[name] }).toEqual({ name, value: fallback });
    }
    const used = new Set<string>();
    for (const match of PIECES_CSS.matchAll(VAR_WITH_FALLBACK)) {
      // `--ravi-progress` and `--ravi-canvas-height` are the renderer's own inline variables, not theme tokens.
      if (match[1] === "--ravi-progress" || match[1] === "--ravi-canvas-height") continue;
      used.add(match[1] as string);
      expect({ name: match[1], fallback: match[2] }).toEqual({ name: match[1], fallback: PIECES_CSS_FALLBACKS[match[1] as string] });
    }
    expect([...PIECES_CSS.matchAll(/var\((--[a-z0-9-]+)\)/g)]).toEqual([]);
    expect(PIECES_CSS).toContain("var(--ravi-progress, 0%)");
    expect(PIECES_CSS).toContain("var(--ravi-canvas-height, 16rem)");
    expect(used.has("--color-text-primary")).toBe(true);
    expect(used.has("--ravi-option-red-bg")).toBe(true);
  });

  test("no colors outside theme variables (system colors only for forced colors)", () => {
    const withoutVars = PIECES_CSS.replace(VAR_WITH_FALLBACK, "VAR");
    expect(withoutVars).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutVars).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|lab)\(/i);
    expect(withoutVars).not.toMatch(/:\s*(?:white|black|red|blue|green|gray|grey)\b/i);
  });

  test("accessibility rules: focus, targets, reduced motion, forced colors, hidden text", () => {
    expect(PIECES_CSS).toMatch(/:focus-visible[^{]*\{\s*outline: var\(--ravi-focus-width, 2px\) solid var\(--color-ring-primary, #14635a\)/);
    expect(PIECES_CSS).toContain("min-block-size: max(var(--ravi-touch-target, 24px), 2rem)");
    expect(PIECES_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(PIECES_CSS).toContain("transition: none !important");
    expect(PIECES_CSS).toContain("@media (forced-colors: active)");
    expect(PIECES_CSS).toContain("CanvasText");
    expect(PIECES_CSS).toContain("outline: 2px solid Highlight");
    expect(PIECES_CSS).toMatch(/\.ravi-sr-only, \.ravi-live \{[^}]*clip-path: inset\(50%\)/);
  });

  test("reflow: narrow containers and a 320px screen", () => {
    expect(PIECES_CSS).toContain("@container (max-width: 16rem)");
    expect(PIECES_CSS).toContain("@media (max-width: 20rem)");
    expect(PIECES_CSS).toContain("@media (max-width: 30rem)");
    expect(PIECES_CSS).toContain("overflow-wrap: anywhere");
    expect(PIECES_CSS).toContain("inline-size: max(15rem, var(--ravi-lane-width, 18rem))");
  });

  test("styles every piece class and the runtime layout classes", () => {
    const classes = [
      ...Object.values(PIECES).map((piece) => piece.className),
      "ravi-list",
      "ravi-board",
      "ravi-lane",
      "ravi-lane-header",
      "ravi-count",
      "ravi-table",
      "ravi-gallery",
      "ravi-status",
      "ravi-live",
      "ravi-sr-only",
      "ravi-menu",
      "ravi-dialog",
      "ravi-pending",
      "ravi-error",
      "ravi-form",
      "ravi-input",
      "ravi-pill",
      "ravi-steps",
      "ravi-meter",
      "ravi-rating",
      "ravi-avatar",
      "ravi-empty",
    ];
    for (const name of classes) expect(PIECES_CSS).toMatch(new RegExp(`\\.${name}[\\s,{.:>\\[]`));
    for (const color of ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]) {
      expect(PIECES_CSS).toContain(`.ravi-option-${color} { background: var(--ravi-option-${color}-bg,`);
    }
    expect(PIECES_CSS).toContain("ravi-view, ravi-widget, ravi-form { display: block; }");
  });

  test("badges and status steps keep the option colors: their rules come after the base ones and are more specific", () => {
    const at = (text: string) => {
      const index = PIECES_CSS.indexOf(text);
      expect({ text, found: index >= 0 }).toEqual({ text, found: true });
      return index;
    };
    const badge = at("  .ravi-badge { background:");
    const step = at("  .ravi-step {");
    for (const color of ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]) {
      const option = at(`  .ravi-option-${color} { background:`);
      const surface = at(
        `  .ravi-badge.ravi-option-${color}, .ravi-step.ravi-option-${color} { background: var(--ravi-option-${color}-bg, ${PIECES_CSS_FALLBACKS[`--ravi-option-${color}-bg`]}); color: var(--ravi-option-${color}-text,`,
      );
      expect(option).toBeLessThan(badge);
      expect(surface).toBeGreaterThan(badge);
      expect(surface).toBeGreaterThan(step);
    }
    expect(PIECES_CSS).toMatch(/\.ravi-badge\.ravi-option-red[^{]*\{ border-color: transparent; \}/);
    // Dots stay `currentColor` (the option text) after the plain option rules.
    expect(at("  .ravi-dot {")).toBeGreaterThan(at("  .ravi-option-red {"));
  });

  test("the tags that set the theme's text color also set its background", () => {
    expect(PIECES_CSS).toContain(":where(ravi-view, ravi-widget, ravi-form, ravi-chart) { background: var(--color-background-primary, #fbfcfd); }");
    // Every other rule that sets text.primary as the color draws its own surface or sits inside one of those.
    for (const rule of [".ravi-card {", ".ravi-dialog {", ".ravi-menu {", ".ravi-button {", ".ravi-avatar {"]) {
      const block = PIECES_CSS.slice(PIECES_CSS.indexOf(rule), PIECES_CSS.indexOf("}", PIECES_CSS.indexOf(rule)));
      expect({ rule, background: /background:/.test(block) }).toEqual({ rule, background: true });
    }
  });
});

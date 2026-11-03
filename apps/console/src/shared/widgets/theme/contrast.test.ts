import { describe, expect, test } from "bun:test";

import { checkThemeContrast, contrastRatio, relativeLuminance, themeContrastPairs } from "./contrast";
import { defaultThemeTokens } from "./tokens";

describe("contrastRatio", () => {
  test("WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#14635a", "#14635a")).toBe(1);
    // #767676 is the classic lightest gray passing 4.5:1 on white; #777777 fails.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 10);
  });

  test("composites translucent colors before measuring", () => {
    // 50% black over white paints #808080 (127.5 per channel).
    expect(contrastRatio("#00000080", "#ffffff")).toBeCloseTo(contrastRatio("#7f7f7f", "#ffffff"), 1);
    // A translucent background is composited over the base first.
    expect(contrastRatio("#000000", "#ffffff00", "#000000")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff00")).toBeCloseTo(21, 5);
  });

  test("returns 0 for colors that do not parse", () => {
    expect(contrastRatio("red", "#ffffff")).toBe(0);
  });
});

describe("checkThemeContrast", () => {
  test("covers the pairs the pieces draw, in both modes", () => {
    const report = checkThemeContrast(defaultThemeTokens());
    expect(report.checks).toHaveLength(72);
    for (const mode of ["light", "dark"] as const) {
      const checks = report.checks.filter((check) => check.mode === mode);
      expect(checks).toHaveLength(themeContrastPairs(mode).length);
      expect(checks.filter((check) => check.min === 3).map((check) => check.pair)).toEqual([
        [`color.${mode}.border.primary`, `color.${mode}.background.primary`],
        [`color.${mode}.ring.primary`, `color.${mode}.background.primary`],
        [`color.${mode}.accent.base`, `color.${mode}.background.primary`],
        [`color.${mode}.border.primary`, `color.${mode}.background.secondary`],
        [`color.${mode}.ring.primary`, `color.${mode}.background.secondary`],
        [`color.${mode}.accent.base`, `color.${mode}.background.secondary`],
      ]);
      const pairs = checks.map((check) => check.pair.join(" on "));
      // Avatar initials, and links and tone text in subtle cards and lanes.
      expect(pairs).toContain(`color.${mode}.text.primary on color.${mode}.background.tertiary`);
      for (const status of ["info", "success", "warning", "danger"]) {
        expect(pairs).toContain(`color.${mode}.text.${status} on color.${mode}.background.secondary`);
      }
      expect(pairs).toContain(`color.${mode}.text.tertiary on color.${mode}.background.secondary`);
      expect(pairs).toContain(`color.${mode}.text.warning on color.${mode}.background.warning`);
      expect(pairs).toContain(`color.${mode}.text.danger on color.${mode}.background.primary`);
      expect(pairs).toContain(`color.${mode}.text.inverse on color.${mode}.background.inverse`);
      expect(pairs).toContain(`color.${mode}.accent.text on color.${mode}.accent.base`);
      expect(pairs).toContain(`color.${mode}.option.purple.text on color.${mode}.option.purple.background`);
    }
  });

  test("the default theme passes every check in light and dark", () => {
    const report = checkThemeContrast(defaultThemeTokens());
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a failing pair fails the report; ratios round to 2 decimals", () => {
    const tokens = { ...defaultThemeTokens(), "color.dark.text.tertiary": "#4a5560" };
    const report = checkThemeContrast(tokens);
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((check) => !check.ok);
    expect(failed.map((check) => check.pair[1])).toEqual(["color.dark.background.primary", "color.dark.background.secondary"]);
    for (const check of report.checks) expect(Math.round(check.ratio * 100) / 100).toBe(check.ratio);
  });

  test("compares unrounded ratios and never reports a failure rounded up to its minimum", () => {
    // #647c72 on white is 4.4988:1, which rounds to 4.5.
    const tokens = { ...defaultThemeTokens(), "color.light.background.primary": "#ffffff", "color.light.text.secondary": "#647c72" };
    const check = checkThemeContrast(tokens).checks.find(
      (item) => item.pair[0] === "color.light.text.secondary" && item.pair[1] === "color.light.background.primary",
    )!;
    expect(check.ok).toBe(false);
    expect(check.ratio).toBe(4.49);
  });

  test("pairs a theme used to pass unchecked: avatar initials and status text on the secondary surface", () => {
    const failing = (tokens: Record<string, string>) =>
      checkThemeContrast({ ...defaultThemeTokens(), ...tokens })
        .checks.filter((check) => !check.ok)
        .map((check) => check.pair.join(" on "));
    // Initials at 1.66:1 (light) and 1.29:1 (dark).
    expect(failing({ "color.light.background.tertiary": "#3a4450", "color.dark.background.tertiary": "#c9d1da" })).toEqual([
      "color.light.text.primary on color.light.background.tertiary",
      "color.dark.text.primary on color.dark.background.tertiary",
    ]);
    // A link (text.info) in a subtle card at 3.97:1; every other check passes.
    expect(
      failing({
        "color.light.background.primary": "#ffffff",
        "color.light.background.secondary": "#e4e4e4",
        "color.light.background.info": "#f7faff",
        "color.light.text.secondary": "#444444",
        "color.light.text.tertiary": "#4a4a4a",
        "color.light.text.info": "#2f6fc0",
        "color.light.border.primary": "#6b7480",
      }),
    ).toEqual(["color.light.text.info on color.light.background.secondary"]);
  });

  test("translucent tokens are composited over background.primary", () => {
    const tokens = {
      ...defaultThemeTokens(),
      "color.light.background.primary": "#ffffff",
      // 10% ink over white is a very light gray, so primary text still passes on it.
      "color.light.background.secondary": "#17202a1a",
      // A border at 20% alpha is far below 3:1 once composited.
      "color.light.border.primary": "#17202a33",
    };
    const report = checkThemeContrast(tokens);
    const byPair = (fg: string, bg: string) =>
      report.checks.find((check) => check.pair[0] === `color.light.${fg}` && check.pair[1] === `color.light.${bg}`)!;
    expect(byPair("text.primary", "background.secondary").ok).toBe(true);
    expect(byPair("border.primary", "background.primary").ok).toBe(false);
    expect(byPair("border.primary", "background.primary").ratio).toBeLessThan(2);
  });
});

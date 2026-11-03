import { describe, expect, test } from "bun:test";

import { OPTION_COLORS } from "../types";
import { parseHexColor } from "./color";
import { compileTheme } from "./compile";
import { contrastRatio } from "./contrast";
import { DEFAULT_THEME_FILES, defaultCompiledTheme } from "./default";
import { defaultFieldDisplayRules, parseFieldsJson } from "./fields";
import { defaultThemeTokens, parseThemeDocument, THEME_TOKENS } from "./tokens";

const themeJson = DEFAULT_THEME_FILES.find((file) => file.path === "theme.json")!.content;
const fieldsJson = DEFAULT_THEME_FILES.find((file) => file.path === "fields.json")!.content;

function hue(hex: string) {
  const { r, g, b } = parseHexColor(hex)!;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

describe("DEFAULT_THEME_FILES", () => {
  test("theme.json sets every token, the description and the name", () => {
    expect(DEFAULT_THEME_FILES.map((file) => file.path)).toEqual(["theme.json", "fields.json"]);
    const document = parseThemeDocument(themeJson);
    expect(document.diagnostics).toEqual([]);
    expect(document.explicit.size).toBe(THEME_TOKENS.length);
    expect(document.tokens).toEqual(defaultThemeTokens());
    expect(document.meta.name).toBe("Ravi");
    expect(document.meta.description).toBeTruthy();
    expect(document.meta.locale).toBe("pt-BR");
    expect(JSON.parse(themeJson).$extensions.ravi.name).toBe("Ravi");
  });

  test("fields.json lists every default display", () => {
    expect(parseFieldsJson(fieldsJson)).toEqual({ rules: defaultFieldDisplayRules(), diagnostics: [] });
  });

  test("light palette follows Ravi's site", () => {
    const tokens = defaultThemeTokens();
    expect(tokens["color.light.text.primary"]).toBe("#17202a");
    expect(tokens["color.light.background.primary"]).toBe("#fbfcfd");
    expect(tokens["color.light.text.secondary"]).toBe("#5f6f80");
    expect(tokens["color.light.accent.base"]).toBe("#14635a");
    expect(tokens["color.light.accent.text"]).toBe("#ffffff");
    expect(Object.fromEntries(OPTION_COLORS.map((color) => [color, tokens[`color.light.option.${color}.background`]]))).toEqual({
      gray: "#eceff3",
      brown: "#efe3d7",
      orange: "#fde7d3",
      yellow: "#fdf3c7",
      green: "#dcf3e3",
      blue: "#dde9fb",
      purple: "#ebe2fb",
      pink: "#fbe2ef",
      red: "#fbdcdc",
    });
  });

  test("option text keeps its background's hue and passes 4.5:1 in both modes", () => {
    const tokens = defaultThemeTokens();
    for (const mode of ["light", "dark"] as const) {
      for (const color of OPTION_COLORS) {
        const background = tokens[`color.${mode}.option.${color}.background`]!;
        const text = tokens[`color.${mode}.option.${color}.text`]!;
        expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(4.5);
        const difference = Math.abs(hue(text) - hue(background));
        expect(Math.min(difference, 360 - difference)).toBeLessThan(15);
      }
    }
  });

  test("dark palette: dark backgrounds, light text", () => {
    const tokens = defaultThemeTokens();
    const lightness = (hex: string) => {
      const { r, g, b } = parseHexColor(hex)!;
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
    };
    for (const name of ["primary", "secondary", "tertiary", "info", "success", "warning", "danger"]) {
      expect(lightness(tokens[`color.dark.background.${name}`]!)).toBeLessThan(0.25);
      expect(lightness(tokens[`color.dark.text.${name}`]!)).toBeGreaterThan(0.5);
    }
    for (const color of OPTION_COLORS) {
      expect(lightness(tokens[`color.dark.option.${color}.background`]!)).toBeLessThan(0.25);
      expect(lightness(tokens[`color.dark.option.${color}.text`]!)).toBeGreaterThan(0.6);
    }
  });

  test("uses system font stacks only", () => {
    const tokens = defaultThemeTokens();
    expect(tokens["font.sans"]).toStartWith("system-ui, -apple-system,");
    expect(tokens["font.sans"]).toEndWith('sans-serif, "Apple Color Emoji", "Segoe UI Emoji"');
    expect(tokens["font.mono"]).toStartWith("ui-monospace,");
    expect(tokens["font.mono"]).toEndWith("monospace");
  });
});

describe("defaultCompiledTheme", () => {
  test("is the compiled default theme, memoized and frozen", () => {
    const theme = defaultCompiledTheme();
    expect(defaultCompiledTheme()).toBe(theme);
    expect(theme.hash).toBe(compileTheme(DEFAULT_THEME_FILES).theme!.hash);
    expect(theme.contrast.ok).toBe(true);
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.vars.light)).toBe(true);
    expect(Object.isFrozen(theme.contrast.checks[0])).toBe(true);
  });
});

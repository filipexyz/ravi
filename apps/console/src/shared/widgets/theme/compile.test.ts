import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../hash";
import type { LibraryFileText } from "../types";
import { compileTheme, THEME_FIXED_VARS } from "./compile";
import { DEFAULT_THEME_FILES } from "./default";
import { defaultThemeTokens, THEME_TOKENS } from "./tokens";

const themeFile = (document: Record<string, unknown>): LibraryFileText => ({
  path: "theme.json",
  content: JSON.stringify(document, null, 2),
});

/** The block of `css` that starts at the line `selector {` (selector exact), up to its closing brace. */
function block(css: string, selector: string) {
  const lines = css.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${selector} {`);
  if (start === -1) return null;
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  const end = lines.findIndex((line, index) => index > start && line === `${" ".repeat(indent)}}`);
  return lines.slice(start + 1, end).map((line) => line.trim());
}

describe("compileTheme", () => {
  test("the default theme compiles with zero diagnostics and passes every contrast check", () => {
    const { theme, diagnostics, draft } = compileTheme(DEFAULT_THEME_FILES);
    expect(diagnostics).toEqual([]);
    expect(theme).not.toBeNull();
    expect(draft).toBe(theme!);
    expect(theme!.contrast.ok).toBe(true);
    expect(theme!.contrast.checks.filter((check) => check.mode === "light").every((check) => check.ok)).toBe(true);
    expect(theme!.contrast.checks.filter((check) => check.mode === "dark").every((check) => check.ok)).toBe(true);
    expect(theme!.name).toBe("Ravi");
    expect(theme!.description).toBeTruthy();
    expect(theme!.locale).toBe("pt-BR");
    expect(theme!.density).toBe("comfortable");
    expect(theme!.logo).toBeNull();
    expect(theme!.v).toBe(1);
  });

  test("CSS shape: layer order first, light on :root, dark under the media query and data-theme", () => {
    const { theme } = compileTheme(DEFAULT_THEME_FILES);
    const css = theme!.css;
    expect(css.startsWith("@layer ravi.theme, ravi.pieces;\n@layer ravi.theme {\n  :root {\n    --")).toBe(true);
    expect(css.endsWith("\n}\n")).toBe(true);
    expect(theme!.hash).toBe(sha256Hex(css));
    expect(theme!.hash).toMatch(/^[0-9a-f]{64}$/);

    const tokens = defaultThemeTokens();
    const root = block(css, ":root")!;
    expect(root).toContain("--ravi-focus-width: 2px;");
    expect(root).toContain("--ravi-touch-target: 24px;");
    expect(root).toContain(`--color-text-primary: ${tokens["color.light.text.primary"]};`);
    expect(root).toContain("--ravi-option-red-bg: #fbdcdc;");
    expect(root).toContain("--ravi-space-4: 1rem;");
    expect(root).toContain('--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";');
    expect(root.filter((line) => line.startsWith("--"))).toHaveLength(2 + 31 + 39);

    const media = block(css, '@media (prefers-color-scheme: dark)')!;
    expect(media[0]).toBe(':root:not([data-theme="light"]) {');
    expect(media).toContain(`--color-text-primary: ${tokens["color.dark.text.primary"]};`);
    const forcedDark = block(css, ':root[data-theme="dark"]')!;
    expect(forcedDark).toEqual(media.slice(1, 40));
    expect(forcedDark).toHaveLength(39);
    expect(block(css, ':root[data-theme="light"]')).toBeNull();
  });

  test("color-scheme is set on the tags and runtime dialogs only, switching with the dark values", () => {
    const css = compileTheme(DEFAULT_THEME_FILES).theme!.css;
    const tags = ":where(ravi-view, ravi-widget, ravi-form, .ravi-dialog)";
    // The page's own canvas and default text stay as the page sets them.
    expect(css.split("\n").filter((line) => line.trim().startsWith("color-scheme:")).length).toBe(3);
    expect(block(css, ":root")!.some((line) => line.startsWith("color-scheme"))).toBe(false);
    expect(block(css, tags)).toEqual(["color-scheme: light;"]);
    expect(block(css, `:root:not([data-theme="light"]) ${tags}`)).toEqual(["color-scheme: dark;"]);
    expect(block(css, `:root[data-theme="dark"] ${tags}`)).toEqual(["color-scheme: dark;"]);
    // The dark tag rule sits inside the media query, after the dark values.
    const media = block(css, "@media (prefers-color-scheme: dark)")!;
    expect(media.slice(-3)).toEqual([`:root:not([data-theme="light"]) ${tags} {`, "color-scheme: dark;", "}"]);

    expect(block(css, ':root[data-ravi-density="compact"]')).toEqual([
      "--ravi-space-1: 0.1875rem;",
      "--ravi-space-2: 0.375rem;",
      "--ravi-space-3: 0.5625rem;",
      "--ravi-space-4: 0.75rem;",
      "--ravi-space-5: 1.125rem;",
      "--ravi-space-6: 1.5rem;",
    ]);
    expect(block(css, ':root[data-ravi-density="comfortable"]')).toBeNull();
  });

  test("vars mirror the stylesheet", () => {
    const { theme } = compileTheme(DEFAULT_THEME_FILES);
    expect(Object.keys(theme!.vars.light)).toHaveLength(39);
    expect(Object.keys(theme!.vars.dark)).toEqual(Object.keys(theme!.vars.light));
    expect(theme!.vars.base).toMatchObject(THEME_FIXED_VARS);
    expect(theme!.vars.base["--shadow-sm"]).toBe("0px 1px 2px 0px #17202a14");
    for (const token of THEME_TOKENS) {
      const map = token.mode ? theme!.vars[token.mode] : theme!.vars.base;
      expect(theme!.css).toContain(`${token.cssVar}: ${map[token.cssVar]};`);
    }
  });

  test("density compact scales the space variables by default and can be switched back", () => {
    const { theme, diagnostics } = compileTheme([
      themeFile({ $description: "Compacto.", $extensions: { ravi: { density: "compact" } }, space: { "4": { $type: "dimension", $value: "16px" } } }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(theme!.density).toBe("compact");
    expect(theme!.vars.base["--ravi-space-4"]).toBe("12px");
    expect(theme!.vars.base["--ravi-space-1"]).toBe("0.1875rem");
    expect(block(theme!.css, ":root")).toContain("--ravi-space-4: 12px;");
    expect(block(theme!.css, ':root[data-ravi-density="compact"]')).toContain("--ravi-space-4: 12px;");
    expect(block(theme!.css, ':root[data-ravi-density="comfortable"]')).toContain("--ravi-space-4: 16px;");
    // Not scaled: the focus width and target size are fixed.
    expect(theme!.vars.base["--ravi-touch-target"]).toBe("24px");
  });

  test("a small theme changes only what it sets", () => {
    const { theme, diagnostics } = compileTheme([
      themeFile({
        $description: "Acme.",
        $extensions: { ravi: { name: "Acme", locale: "en" } },
        color: { light: { accent: { base: { $type: "color", $value: "#0a5c8a" } } } },
      }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(theme!.vars.light["--ravi-color-accent"]).toBe("#0a5c8a");
    expect(theme!.vars.light["--color-text-primary"]).toBe("#17202a");
    expect(theme!.locale).toBe("en");
    expect(theme!.name).toBe("Acme");
  });

  test("failing contrast gives THEME_CONTRAST errors naming the pair and ratio", () => {
    const content = [
      "{",
      '  "$description": "Pouco contraste.",',
      '  "color": {',
      '    "light": {',
      '      "text": { "tertiary": { "$type": "color", "$value": "#b0b8c0" } },',
      '      "option": { "yellow": { "text": { "$type": "color", "$value": "#c9a227" } } }',
      "    },",
      '    "dark": { "ring": { "primary": { "$type": "color", "$value": "#2a3440" } } }',
      "  }",
      "}",
    ].join("\n");
    const { theme, diagnostics, draft } = compileTheme([{ path: "theme.json", content }]);
    expect(theme).toBeNull();
    expect(draft).not.toBeNull();
    expect(draft!.contrast.ok).toBe(false);
    const errors = diagnostics.filter((diagnostic) => diagnostic.code === "THEME_CONTRAST");
    expect(errors.map((error) => [error.severity, error.file, error.line])).toEqual([
      ["error", "theme.json", 5],
      ["error", "theme.json", 5],
      ["error", "theme.json", 6],
      ["error", "theme.json", 8],
      ["error", "theme.json", 8],
    ]);
    const tertiary = draft!.contrast.checks.find((check) => check.pair[0] === "color.light.text.tertiary")!;
    expect(errors[0]!.message).toBe(
      `color.light.text.tertiary on color.light.background.primary has contrast ${tertiary.ratio}:1 in light mode; it needs at least 4.5:1.`,
    );
    expect(errors[3]!.message).toContain("color.dark.ring.primary on color.dark.background.primary");
    expect(errors[3]!.message).toContain("at least 3:1");
    expect(diagnostics).toHaveLength(errors.length);
  });

  test("injection attempts never reach the CSS", () => {
    const { theme, diagnostics, draft } = compileTheme([
      themeFile({
        $description: "Ataque.",
        color: {
          light: {
            text: { primary: { $type: "color", $value: "#000;}</style><script>alert(1)</script>" } },
            background: { primary: { $type: "color", $value: "url(https://evil.example/bg.png)" } },
          },
        },
        font: { sans: { $type: "fontFamily", $value: ["Inter\"; } @import url(https://evil.example/x.css); a{"] } },
        space: { "1": { $type: "dimension", $value: "1px\\3b color:red" } },
        radius: { sm: { $type: "dimension", $value: "{radius.md}}" } },
      }),
    ]);
    expect(theme).toBeNull();
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "THEME_UNSAFE_VALUE",
      "THEME_UNSAFE_VALUE",
      "THEME_UNSAFE_VALUE",
      "THEME_UNSAFE_VALUE",
      "THEME_UNSAFE_VALUE",
    ]);
    for (const banned of ["url(", "@import", "</style", "<script", "\\", "evil", "alert", "}}"]) {
      expect(draft!.css).not.toContain(banned);
    }
    // Invalid tokens fell back to the defaults.
    expect(draft!.vars.light["--color-text-primary"]).toBe("#17202a");
  });

  test("fields.json and logo.svg are compiled in", () => {
    const { theme, diagnostics } = compileTheme([
      themeFile({ $description: "Com logo." }),
      { path: "fields.json", content: '{"types": {"status": "steps"}}' },
      { path: "logo.svg", content: '<svg viewBox="0 0 1 1" onload="x()"><rect width="1" height="1"/></svg>' },
      { path: "README.md", content: "# Tema" },
    ]);
    expect(diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.code])).toEqual([["warning", "LOGO_SANITIZED"]]);
    expect(theme!.fields.types.status).toBe("steps");
    expect(theme!.fields.types.select).toBe("pill");
    expect(theme!.logo).toStartWith("data:image/svg+xml;base64,");
    expect(Buffer.from(theme!.logo!.split(",")[1]!, "base64").toString()).not.toContain("onload");
  });

  test("fields.json and logo.svg errors reject the theme", () => {
    const { theme, diagnostics } = compileTheme([
      themeFile({ $description: "Erros." }),
      { path: "fields.json", content: '{"types": {"status": "badge"}}' },
      { path: "logo.svg", content: "<html></html>" },
    ]);
    expect(theme).toBeNull();
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["FIELDS_UNKNOWN_DISPLAY", "LOGO_INVALID"]);
  });

  test("missing theme.json, missing description and unknown files", () => {
    expect(compileTheme([{ path: "fields.json", content: "{}" }])).toEqual({
      theme: null,
      draft: null,
      diagnostics: [expect.objectContaining({ severity: "error", code: "THEME_FILE_MISSING", file: "theme.json" })],
    });
    const { theme, diagnostics } = compileTheme([themeFile({}), { path: "notes.txt", content: "x" }]);
    expect(theme).not.toBeNull();
    expect(diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.code])).toEqual([
      ["warning", "THEME_UNKNOWN_FILE"],
      ["warning", "THEME_DESCRIPTION_MISSING"],
    ]);
  });

  test("the same files always produce the same CSS and hash", () => {
    const first = compileTheme(DEFAULT_THEME_FILES).theme!;
    const second = compileTheme(DEFAULT_THEME_FILES.map((file) => ({ ...file }))).theme!;
    expect(second.css).toBe(first.css);
    expect(second.hash).toBe(first.hash);
  });
});

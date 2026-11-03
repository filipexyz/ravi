import { describe, expect, test } from "bun:test";

import { OPTION_COLORS, type Diagnostic } from "../types";
import { DEFAULT_TOKEN_VALUES } from "./default-tokens";
import {
  defaultThemeTokens,
  parseThemeDocument,
  parseThemeJson,
  parseThemeTokenValue,
  THEME_MAX_ALIAS_DEPTH,
  THEME_TOKEN_BY_PATH,
  THEME_TOKENS,
  themeJsonFromTokens,
} from "./tokens";

/** Builds a theme.json from dotted paths → `$value` (and optional `$type`). */
function themeText(values: Record<string, unknown>, root: Record<string, unknown> = {}) {
  const document: Record<string, unknown> = { ...root };
  for (const [path, value] of Object.entries(values)) {
    const parts = path.split(".");
    let node = document;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = { $type: THEME_TOKEN_BY_PATH.get(path)?.type ?? "color", $value: value };
  }
  return JSON.stringify(document, null, 2);
}

const codes = (diagnostics: Diagnostic[]) => diagnostics.map((diagnostic) => diagnostic.code);
const defaults = defaultThemeTokens();

describe("THEME_TOKENS", () => {
  test("is the closed table of the contract", () => {
    const paths = THEME_TOKENS.map((token) => token.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Per mode: 8 backgrounds, 8 texts, 2 borders, ring, accent pair, 9 option pairs.
    expect(THEME_TOKENS.filter((token) => token.mode === "light")).toHaveLength(39);
    expect(THEME_TOKENS.filter((token) => token.mode === "dark")).toHaveLength(39);
    // Fonts 2, weights 4, text sizes 4, heading sizes 4, radii 6, border 1, shadows 3, spaces 6, lane 1.
    expect(THEME_TOKENS.filter((token) => token.mode === null)).toHaveLength(31);
    for (const color of OPTION_COLORS) {
      expect(THEME_TOKEN_BY_PATH.get(`color.dark.option.${color}.background`)?.cssVar).toBe(`--ravi-option-${color}-bg`);
    }
    expect(THEME_TOKEN_BY_PATH.get("color.light.accent.text")?.cssVar).toBe("--ravi-color-on-accent");
    expect(THEME_TOKEN_BY_PATH.get("font.size.heading.xl")).toEqual({
      path: "font.size.heading.xl",
      type: "dimension",
      cssVar: "--font-heading-xl-size",
      mode: null,
    });
    expect(THEME_TOKEN_BY_PATH.get("layout.laneWidth")?.cssVar).toBe("--ravi-lane-width");
  });

  test("every token has exactly one default value", () => {
    expect(Object.keys(DEFAULT_TOKEN_VALUES).sort()).toEqual(THEME_TOKENS.map((token) => token.path).sort());
    expect(Object.keys(defaults)).toHaveLength(THEME_TOKENS.length);
  });
});

describe("parseThemeJson", () => {
  test("an empty theme is the default theme", () => {
    const result = parseThemeJson("{}");
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens).toEqual(defaults);
    expect(result.meta).toEqual({ name: null, description: null, locale: "pt-BR", density: "comfortable" });
  });

  test("reads root metadata", () => {
    const result = parseThemeJson(
      JSON.stringify({
        $schema: "https://example.com/schema.json",
        $description: "  Tema da Acme  ",
        $extensions: { ravi: { name: "Acme", locale: "en-us", density: "compact" }, "com.figma": { anything: 1 } },
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.meta).toEqual({ name: "Acme", description: "Tema da Acme", locale: "en-US", density: "compact" });
  });

  test.each([
    [{ $description: "" }, "THEME_META_INVALID"],
    [{ $description: 3 }, "THEME_META_INVALID"],
    [{ $extensions: { ravi: { locale: "not a locale" } } }, "THEME_META_INVALID"],
    [{ $extensions: { ravi: { locale: "pt-BR</style>" } } }, "THEME_META_INVALID"],
    [{ $extensions: { ravi: { density: "cozy" } } }, "THEME_META_INVALID"],
    [{ $extensions: { ravi: { name: "x".repeat(121) } } }, "THEME_META_INVALID"],
    [{ $extensions: { ravi: { accent: "#fff" } } }, "THEME_UNKNOWN_KEY"],
    [{ $extensions: "ravi" }, "THEME_META_INVALID"],
    [{ $comment: "x" }, "THEME_UNKNOWN_KEY"],
  ])("rejects invalid metadata %j", (root, code) => {
    expect(codes(parseThemeJson(JSON.stringify(root)).diagnostics)).toEqual([code]);
  });

  test("invalid JSON reports the line and falls back to defaults", () => {
    const result = parseThemeJson('{\n  "color": {\n    "light": }\n}');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "THEME_JSON_INVALID", file: "theme.json", line: 3, column: 14 }),
    ]);
    expect(result.tokens).toEqual(defaults);
    expect(codes(parseThemeJson("[]").diagnostics)).toEqual(["THEME_JSON_INVALID"]);
  });

  test("missing tokens fall back to the default theme", () => {
    const result = parseThemeJson(themeText({ "color.light.accent.base": "#0055AA" }));
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens["color.light.accent.base"]).toBe("#0055aa");
    expect(result.tokens["color.dark.accent.base"]).toBe(defaults["color.dark.accent.base"]!);
    expect(result.tokens["space.4"]).toBe("1rem");
  });

  test("accepts tokens without $type (inferred from the path) and group $type", () => {
    const text = JSON.stringify({
      color: { $type: "color", light: { text: { primary: { $value: "#111" } } } },
      space: { "1": { $value: "3px", $description: "tiny", $extensions: { "x.y": 1 }, $deprecated: false } },
    });
    const result = parseThemeJson(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens["color.light.text.primary"]).toBe("#111111");
    expect(result.tokens["space.1"]).toBe("3px");
  });

  test("unknown token paths are errors with the key's line", () => {
    const text = '{\n  "color": {\n    "light": {\n      "text": {\n        "brand": { "$type": "color", "$value": "#000" }\n      }\n    }\n  },\n  "colour": {}\n}';
    const { diagnostics } = parseThemeJson(text);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "THEME_UNKNOWN_TOKEN", file: "theme.json", line: 5 }),
      expect.objectContaining({ code: "THEME_UNKNOWN_TOKEN", line: 9 }),
    ]);
    expect(diagnostics[0]!.message).toContain("color.light.text.brand");
    expect(diagnostics[0]!.message).toContain("primary, secondary");
  });

  test("names with dots or braces are refused (DTCG), even when they spell a known path", () => {
    const text = JSON.stringify({ "color.light.text.primary": { $type: "color", $value: "#000" }, space: { "{1}": { $value: "1px" } } });
    const result = parseThemeJson(text);
    expect(codes(result.diagnostics)).toEqual(["THEME_UNKNOWN_TOKEN", "THEME_UNKNOWN_TOKEN"]);
    expect(result.tokens["color.light.text.primary"]).toBe(defaults["color.light.text.primary"]!);
  });

  test("structural errors", () => {
    const text = JSON.stringify({
      font: { size: { $type: "dimension", $value: "12px" }, sans: "Inter" },
      radius: { sm: { $type: "dimension", $value: "4px", extra: true } },
    });
    expect(codes(parseThemeJson(text).diagnostics)).toEqual([
      "THEME_VALUE_INVALID",
      "THEME_VALUE_INVALID",
      "THEME_UNKNOWN_KEY",
    ]);
  });

  test("$type must match the token's type", () => {
    const direct = parseThemeJson(JSON.stringify({ color: { light: { text: { primary: { $type: "dimension", $value: "4px" } } } } }));
    expect(codes(direct.diagnostics)).toEqual(["THEME_TYPE_MISMATCH"]);
    expect(direct.tokens["color.light.text.primary"]).toBe(defaults["color.light.text.primary"]!);
    const inherited = parseThemeJson(JSON.stringify({ font: { $type: "fontFamily", weight: { bold: { $value: 700 } } } }));
    expect(codes(inherited.diagnostics)).toEqual(["THEME_TYPE_MISMATCH"]);
    const unsupported = parseThemeJson(JSON.stringify({ space: { "1": { $type: "duration", $value: "4px" } } }));
    expect(codes(unsupported.diagnostics)).toContain("THEME_TYPE_MISMATCH");
  });
});

describe("token values", () => {
  test.each([
    ["#ABC", "#aabbcc"],
    ["#14635A", "#14635a"],
    ["#11223380", "#11223380"],
    ["#112233ff", "#112233"],
    [{ colorSpace: "srgb", components: [1, 0.5, 0] }, "#ff8000"],
    [{ colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5, hex: "#000000" }, "#00000080"],
  ])("color %j → %s", (raw, css) => {
    expect(parseThemeTokenValue("color", raw)).toEqual({ ok: true, css });
  });

  test.each([
    "red",
    "#12345",
    "rgb(0, 0, 0)",
    "#abcd",
    { colorSpace: "display-p3", components: [1, 0, 0] },
    { colorSpace: "srgb", components: [2, 0, 0] },
    { colorSpace: "srgb", components: [0, 0, 0], alpha: 2 },
    { colorSpace: "srgb", components: [0, 0, 0], extra: 1 },
    12,
  ])("rejects color %j", (raw) => {
    expect(parseThemeTokenValue("color", raw).ok).toBe(false);
  });

  test.each([
    ["12px", "12px"],
    ["0.750rem", "0.75rem"],
    [".5rem", "0.5rem"],
    [" 3px ", "3px"],
    [{ value: 1.123456, unit: "rem" }, "1.1235rem"],
    [{ value: 0, unit: "px" }, "0px"],
  ])("dimension %j → %s", (raw, css) => {
    expect(parseThemeTokenValue("dimension", raw)).toEqual({ ok: true, css });
  });

  test.each(["12", "12em", "1e2px", "-4px", "calc(1px + 2px)", { value: "12", unit: "px" }, { value: 1, unit: "%" }, { value: 20000, unit: "px" }])(
    "rejects dimension %j",
    (raw) => {
      expect(parseThemeTokenValue("dimension", raw).ok).toBe(false);
    },
  );

  test("font families are quoted only when needed", () => {
    expect(parseThemeTokenValue("fontFamily", "Inter")).toEqual({ ok: true, css: "Inter" });
    expect(parseThemeTokenValue("fontFamily", ["Open Sans", "-apple-system", "Sans-Serif", "inherit", "1Up"])).toEqual({
      ok: true,
      css: '"Open Sans", -apple-system, sans-serif, "inherit", "1Up"',
    });
    expect(parseThemeTokenValue("fontFamily", ["  Segoe   UI "])).toEqual({ ok: true, css: '"Segoe UI"' });
  });

  test.each([['"Inter"'], ["Inter, sans-serif"], [["Inter's"]], [[]], [["x".repeat(65)]], [["Inter!"]], [[1]]])(
    "rejects font family %j",
    (raw) => {
      expect(parseThemeTokenValue("fontFamily", raw).ok).toBe(false);
    },
  );

  test("font weights", () => {
    expect(parseThemeTokenValue("fontWeight", 600)).toEqual({ ok: true, css: "600" });
    expect(parseThemeTokenValue("fontWeight", 450)).toEqual({ ok: true, css: "450" });
    expect(parseThemeTokenValue("fontWeight", "semi-bold")).toEqual({ ok: true, css: "600" });
    for (const raw of [50, 950, 450.5, "600", "extra-black", "bolder"]) {
      expect(parseThemeTokenValue("fontWeight", raw).ok).toBe(false);
    }
  });

  test("shadows", () => {
    const layer = { color: "#00000033", offsetX: "0px", offsetY: { value: 2, unit: "px" }, blur: "4px", spread: "-1px" };
    expect(parseThemeTokenValue("shadow", layer)).toEqual({ ok: true, css: "0px 2px 4px -1px #00000033" });
    expect(parseThemeTokenValue("shadow", [layer, { ...layer, inset: true, color: "#fff" }])).toEqual({
      ok: true,
      css: "0px 2px 4px -1px #00000033, inset 0px 2px 4px -1px #ffffff",
    });
    for (const raw of [
      "0 1px 2px #000",
      { ...layer, blur: "-1px" },
      { ...layer, spread: undefined },
      { ...layer, color: "{color.light.border.primary}" },
      { ...layer, inset: "yes" },
      { ...layer, glow: true },
      [],
      [layer, layer, layer, layer, layer],
    ]) {
      expect(parseThemeTokenValue("shadow", raw).ok).toBe(false);
    }
  });
});

describe("injection attempts", () => {
  test.each([
    ["color.light.text.primary", "#000; } body { background: red"],
    ["color.light.text.primary", "url(https://evil.example/x.png)"],
    ["color.light.text.primary", "#000\\3b"],
    ["color.light.text.primary", "</style><script>alert(1)</script>"],
    ["color.light.text.primary", "#000 }"],
    ["color.light.text.primary", "#000\u0007"],
    ["space.1", "@import 'x.css'"],
    ["space.1", "1px; --x: url(a)"],
    ["font.sans", ["Inter;}@import url(x);"]],
    ["font.sans", ["Inter\\22"]],
    ["font.mono", ['Menlo", monospace; } body { x: "']],
    ["shadow.sm", { color: "#000", offsetX: "0px", offsetY: "0px", blur: "url(x)", spread: "0px" }],
    ["shadow.sm", { color: "#000</style>", offsetX: "0px", offsetY: "0px", blur: "0px", spread: "0px" }],
  ])("%s: %j is rejected and falls back to the default", (path, value) => {
    const result = parseThemeJson(themeText({ [path]: value }));
    expect(result.diagnostics).toHaveLength(1);
    expect(["THEME_UNSAFE_VALUE", "THEME_VALUE_INVALID"]).toContain(result.diagnostics[0]!.code);
    expect(result.tokens[path]).toBe(defaults[path]!);
  });

  test("unsafe content is reported as THEME_UNSAFE_VALUE", () => {
    for (const value of ["url(x)", "@import", "a;b", "a\\b", "</style>", "a{b}", "\u0000"]) {
      const result = parseThemeTokenValue("color", value);
      expect(result.ok === false && result.code).toBe("THEME_UNSAFE_VALUE");
    }
  });
});

describe("aliases", () => {
  test("resolve through the file and the defaults before validation", () => {
    const result = parseThemeJson(
      themeText({
        "color.light.accent.base": "#0a5c8a",
        "color.light.ring.primary": "{color.light.accent.base}",
        "color.dark.ring.primary": "{color.dark.accent.base}",
        "color.light.text.info": "{color.light.option.blue.text}",
        "radius.full": "{radius.xl}",
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens["color.light.ring.primary"]).toBe("#0a5c8a");
    expect(result.tokens["color.dark.ring.primary"]).toBe(defaults["color.dark.accent.base"]!);
    expect(result.tokens["color.light.text.info"]).toBe(defaults["color.light.option.blue.text"]!);
    expect(result.tokens["radius.full"]).toBe("12px");
  });

  test("an alias to an invalid token falls back without a second error", () => {
    const result = parseThemeJson(themeText({ "color.light.accent.base": "nope", "color.light.ring.primary": "{color.light.accent.base}" }));
    expect(codes(result.diagnostics)).toEqual(["THEME_VALUE_INVALID"]);
    expect(result.tokens["color.light.ring.primary"]).toBe(defaults["color.light.ring.primary"]!);
  });

  test("cycles are errors", () => {
    const result = parseThemeJson(
      themeText({ "space.1": "{space.2}", "space.2": "{space.3}", "space.3": "{space.1}", "space.4": "{space.4}" }),
    );
    expect(codes(result.diagnostics)).toEqual(["THEME_ALIAS_CYCLE", "THEME_ALIAS_CYCLE"]);
    expect(result.diagnostics[0]!.message).toContain("space.1 -> space.2 -> space.3 -> space.1");
    expect(result.tokens["space.1"]).toBe(defaults["space.1"]!);
    expect(result.tokens["space.4"]).toBe(defaults["space.4"]!);
  });

  test(`at most ${THEME_MAX_ALIAS_DEPTH} hops`, () => {
    // Option texts alias the next one (gray → brown → …); the last holds the value.
    const paths = OPTION_COLORS.map((color) => `color.light.option.${color}.text`).slice(0, THEME_MAX_ALIAS_DEPTH + 1);
    const chain = Object.fromEntries(
      paths.map((path, index) => [path, index === paths.length - 1 ? "#123456" : `{${paths[index + 1]}}`]),
    );
    const atLimit = parseThemeJson(themeText(chain));
    expect(atLimit.diagnostics).toEqual([]);
    expect(atLimit.tokens[paths[0]!]).toBe("#123456");

    const overLimit = parseThemeJson(themeText({ ...chain, "color.light.text.info": `{${paths[0]}}` }));
    expect(codes(overLimit.diagnostics)).toEqual(["THEME_ALIAS_DEPTH"]);
    expect(overLimit.tokens["color.light.text.info"]).toBe(defaults["color.light.text.info"]!);
  });

  test("unknown targets, wrong types and non-whole aliases", () => {
    const result = parseThemeJson(
      themeText({
        "color.light.text.primary": "{color.light.text.brand}",
        "color.light.text.secondary": "{space.1}",
        "color.light.text.tertiary": "{color.light.text.primary} ",
        "space.2": "{space}",
      }),
    );
    expect(codes(result.diagnostics)).toEqual([
      "THEME_ALIAS_UNKNOWN",
      "THEME_ALIAS_TYPE",
      "THEME_UNSAFE_VALUE",
      "THEME_ALIAS_UNKNOWN",
    ]);
  });
});

describe("parseThemeDocument", () => {
  test("reports explicit paths and key lines", () => {
    const text = '{\n  "space": {\n    "2": { "$value": "6px" }\n  }\n}';
    const result = parseThemeDocument(text);
    expect([...result.explicit]).toEqual(["space.2"]);
    expect(result.lines.get("space.2")).toBe(3);
  });
});

describe("themeJsonFromTokens", () => {
  test("round-trips every default token and the metadata", () => {
    const meta = { name: "Acme", description: "Tema da Acme.", locale: "en", density: "compact" as const };
    const text = themeJsonFromTokens(defaults, meta);
    const parsed = parseThemeDocument(text);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens).toEqual(defaults);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.explicit.size).toBe(THEME_TOKENS.length);
    expect(text).toContain('"primary": { "$type": "color", "$value": "#17202a" }');
  });

  test("converts values typed in the editor and keeps aliases", () => {
    const text = themeJsonFromTokens({
      "font.sans": "'Open Sans', Inter, sans-serif",
      "font.weight.bold": "800",
      "shadow.sm": "inset 0 1px 2px #00000033, 0px 4px 8px -2px #0000001a",
      "color.light.ring.primary": "{color.light.accent.base}",
      "color.light.accent.base": "#0A5C8A",
      unknown: "x",
    });
    const result = parseThemeJson(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens["font.sans"]).toBe('"Open Sans", Inter, sans-serif');
    expect(result.tokens["font.weight.bold"]).toBe("800");
    expect(result.tokens["shadow.sm"]).toBe("inset 0px 1px 2px 0px #00000033, 0px 4px 8px -2px #0000001a");
    expect(result.tokens["color.light.ring.primary"]).toBe("#0a5c8a");
    expect(text).not.toContain("unknown");
  });

  test("writes what it cannot convert as typed, so parsing reports it", () => {
    const result = parseThemeJson(themeJsonFromTokens({ "shadow.md": "0 1px", "space.1": "4 px", "color.light.text.primary": "url(x)" }));
    expect(codes(result.diagnostics)).toEqual(["THEME_UNSAFE_VALUE", "THEME_VALUE_INVALID", "THEME_VALUE_INVALID"]);
  });
});

import { describe, expect, test } from "bun:test";

import { compileTheme } from "@/shared/widgets/theme/compile";
import { DEFAULT_THEME_FILES } from "@/shared/widgets/theme/default";
import { parseFieldsJson } from "@/shared/widgets/theme/fields";
import { parseThemeDocument, THEME_TOKENS } from "@/shared/widgets/theme/tokens";

import {
  BASE_GROUPS,
  colorGroups,
  colorPickerValue,
  contrastPairLabel,
  parseTokenInput,
  readThemeSource,
  tokenFieldError,
  tokenFieldName,
  tokenFieldText,
  tokenInputErrors,
  tokenInputText,
  tokenLabel,
  tokenMode,
  typedTokenInput,
  withPickedColor,
  writeFieldsDisplay,
  writeThemeMeta,
  writeThemeToken,
} from "./theme-form";

const DEFAULT_THEME_JSON = DEFAULT_THEME_FILES.find((file) => file.path === "theme.json")!.content;

describe("groups", () => {
  test("every color token of a mode is in exactly one color group", () => {
    for (const mode of ["light", "dark"] as const) {
      const grouped = colorGroups(mode).flatMap((group) => group.paths);
      const expected = THEME_TOKENS.filter((token) => token.mode === mode).map((token) => token.path);
      expect(grouped.sort()).toEqual(expected.sort());
    }
  });

  test("base groups hold fonts, radii and spaces only", () => {
    const paths = BASE_GROUPS.flatMap((group) => group.paths);
    expect(paths).toContain("font.sans");
    expect(paths).toContain("font.size.heading.xl");
    expect(paths).toContain("radius.full");
    expect(paths).toContain("space.6");
    expect(paths.some((path) => path.startsWith("shadow.") || path.startsWith("color."))).toBe(false);
  });
});

describe("names", () => {
  test("names tokens in PT-BR without the mode", () => {
    expect(tokenLabel("color.light.background.primary")).toBe("Fundo principal");
    expect(tokenLabel("color.dark.text.danger")).toBe("Texto de perigo");
    expect(tokenLabel("color.dark.border.secondary")).toBe("Borda secundária");
    expect(tokenLabel("color.light.ring.primary")).toBe("Anel de foco");
    expect(tokenLabel("color.light.accent.text")).toBe("Texto sobre o destaque");
    expect(tokenLabel("color.light.option.blue.background")).toBe("Opção azul: fundo");
    expect(tokenLabel("font.size.heading.md")).toBe("Tamanho do título md");
    expect(tokenLabel("font.size.sm")).toBe("Tamanho do texto sm");
    expect(tokenLabel("space.3")).toBe("Espaço 3");
    expect(tokenLabel("unknown.path")).toBe("unknown.path");
  });

  test("names every token the form shows", () => {
    for (const token of THEME_TOKENS) expect(tokenLabel(token.path)).not.toBe(token.path);
  });

  test("names contrast pairs", () => {
    expect(contrastPairLabel(["color.light.text.primary", "color.light.background.primary"])).toBe("Texto principal sobre fundo principal");
    expect(contrastPairLabel(["color.dark.option.red.text", "color.dark.option.red.background"])).toBe("Opção vermelho: texto sobre o fundo");
  });

  test("reads the mode of a color path", () => {
    expect(tokenMode("color.dark.text.primary")).toBe("dark");
    expect(tokenMode("font.sans")).toBeNull();
  });
});

describe("readThemeSource", () => {
  test("reads raw values and metadata, keeping aliases", () => {
    const text = JSON.stringify({
      $description: "Tema da Acme",
      $extensions: { ravi: { name: "Acme", locale: "en", density: "compact" } },
      color: { light: { text: { primary: { $type: "color", $value: "#112233" }, secondary: { $type: "color", $value: "{color.light.text.primary}" } } } },
    });
    const source = readThemeSource(text)!;
    expect(source.values).toEqual({ "color.light.text.primary": "#112233", "color.light.text.secondary": "{color.light.text.primary}" });
    expect(source.meta).toEqual({ name: "Acme", description: "Tema da Acme", locale: "en", density: "compact" });
  });

  test("is null when theme.json is not a JSON object", () => {
    expect(readThemeSource("{")).toBeNull();
    expect(readThemeSource("[]")).toBeNull();
  });
});

describe("writeThemeToken and writeThemeMeta", () => {
  test("changes one token and keeps every other value", () => {
    const next = writeThemeToken(DEFAULT_THEME_JSON, "color.light.accent.base", "#0b5d50")!;
    const before = parseThemeDocument(DEFAULT_THEME_JSON);
    const after = parseThemeDocument(next);
    expect(after.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(after.tokens["color.light.accent.base"]).toBe("#0b5d50");
    for (const token of THEME_TOKENS) {
      if (token.path !== "color.light.accent.base") expect(after.tokens[token.path]).toBe(before.tokens[token.path]!);
    }
    expect(after.meta).toEqual(before.meta);
  });

  test("removing a token lets the default apply", () => {
    const small = JSON.stringify({ $description: "x", color: { light: { text: { primary: { $type: "color", $value: "#000000" } } } } });
    const next = writeThemeToken(small, "color.light.text.primary", undefined)!;
    expect(parseThemeDocument(next).explicit.has("color.light.text.primary")).toBe(false);
  });

  test("keeps an alias written in the file", () => {
    const text = JSON.stringify({ color: { light: { text: { secondary: { $type: "color", $value: "{color.light.text.primary}" } } } } });
    const next = writeThemeToken(text, "color.light.text.primary", "#101010")!;
    expect(next).toContain('"{color.light.text.primary}"');
    expect(parseThemeDocument(next).tokens["color.light.text.secondary"]).toBe("#101010");
  });

  test("changes the metadata", () => {
    const next = writeThemeMeta(DEFAULT_THEME_JSON, { name: "Acme", description: "Tema da Acme", density: "compact" })!;
    const { meta } = parseThemeDocument(next);
    expect(meta).toEqual({ name: "Acme", description: "Tema da Acme", locale: "pt-BR", density: "compact" });
    expect(compileTheme([{ path: "theme.json", content: next }]).theme?.density).toBe("compact");
  });

  test("refuses text that is not a JSON object", () => {
    expect(writeThemeToken("nope", "font.sans", ["Inter"])).toBeNull();
    expect(writeThemeMeta("nope", { name: "x" })).toBeNull();
  });
});

describe("edits keep the rest of theme.json", () => {
  // A Tokens Studio or Figma style export: what the compiler accepts beyond the tokens, plus a typo it reports.
  const exportText = JSON.stringify(
    {
      $schema: "https://example.com/tokens.schema.json",
      $description: "Tema Acme",
      $extensions: { ravi: { name: "Acme", locale: "pt-BR", density: "comfortable" }, "com.figma": { fileKey: "abc" } },
      color: {
        $description: "Brand colors",
        light: {
          background: {
            primary: { $type: "color", $value: "#ffffff", $description: "Brand white", $extensions: { "com.figma": { id: "1:2" } } },
            secondary: { $type: "color", $value: "{color.light.background.primary}", $deprecated: true },
          },
          backgroud: { tertiary: { $type: "color", $value: "#f0f0f0" } },
        },
      },
    },
    null,
    2,
    // A "__proto__" key stays a plain key of the file.
  ).replace(/\n}$/, ',\n  "__proto__": { "kept": true }\n}');
  // The compiler's report of the typo (and of the "__proto__" key), which an edit must not make disappear.
  const unknownTokens = (text: string) =>
    compileTheme([{ path: "theme.json", content: text }])
      .diagnostics.filter((diagnostic) => diagnostic.code === "THEME_UNKNOWN_TOKEN")
      .map((diagnostic) => diagnostic.message);
  const reported = unknownTokens(exportText);

  /** The parsed file with one `$value` (or nothing) changed must equal the parsed edit. */
  const expectOnlyChanged = (before: string, after: string, change: (document: Record<string, any>) => void) => {
    const expected = JSON.parse(before);
    change(expected);
    expect(JSON.parse(after)).toEqual(expected);
  };

  test("a token edit sets only that $value", () => {
    const next = writeThemeToken(exportText, "color.light.background.primary", "#fafafa")!;
    expectOnlyChanged(exportText, next, (document) => {
      document.color.light.background.primary.$value = "#fafafa";
    });
    const parsed = JSON.parse(next);
    expect(Object.hasOwn(parsed, "__proto__") && parsed.__proto__).toEqual({ kept: true });
    expect(reported.some((message) => message.includes("color.light.backgroud"))).toBe(true);
    expect(unknownTokens(next)).toEqual(reported);
  });

  test("a new token joins its group as { $type, $value }", () => {
    const next = writeThemeToken(exportText, "color.light.text.primary", "#101010")!;
    expectOnlyChanged(exportText, next, (document) => {
      document.color.light.text = { primary: { $type: "color", $value: "#101010" } };
    });
    expect(parseThemeDocument(next).tokens["color.light.text.primary"]).toBe("#101010");
  });

  test("a metadata edit sets only that key", () => {
    const named = writeThemeMeta(exportText, { name: "Acmex" })!;
    expectOnlyChanged(exportText, named, (document) => {
      document.$extensions.ravi.name = "Acmex";
    });
    const described = writeThemeMeta(named, { description: "  Tema da Acme  ", density: "compact", locale: "en" })!;
    expectOnlyChanged(named, described, (document) => {
      document.$description = "Tema da Acme";
      document.$extensions.ravi.density = "compact";
      document.$extensions.ravi.locale = "en";
    });
    expect(unknownTokens(described)).toEqual(reported);
  });

  test("clearing the name or description removes only that key", () => {
    const next = writeThemeMeta(exportText, { name: "", description: null })!;
    expectOnlyChanged(exportText, next, (document) => {
      delete document.$description;
      delete document.$extensions.ravi.name;
    });
  });

  test("metadata a file lacks goes after $schema and $description", () => {
    const bare = '{\n  "$schema": "x",\n  "font": { "sans": { "$type": "fontFamily", "$value": "Inter" } }\n}\n';
    const next = writeThemeMeta(bare, { description: "Tema", name: "Acme" })!;
    expect(Object.keys(JSON.parse(next))).toEqual(["$schema", "$description", "$extensions", "font"]);
    expect(JSON.parse(next).$extensions).toEqual({ ravi: { name: "Acme" } });
    // Removing what is not there changes nothing.
    expect(writeThemeMeta(bare, { name: null })).toBe(writeThemeMeta(bare, {})!);
  });

  test("removing a token takes out only it and the groups it empties", () => {
    const text = JSON.stringify({
      color: { $description: "Cores", light: { text: { primary: { $type: "color", $value: "#000000", $description: "Tinta" } } } },
      font: { sans: { $type: "fontFamily", $value: "Inter" } },
    });
    const next = writeThemeToken(text, "color.light.text.primary", undefined)!;
    expect(JSON.parse(next)).toEqual({ color: { $description: "Cores" }, font: { sans: { $type: "fontFamily", $value: "Inter" } } });
  });

  test("writes two-space JSON with each token on one line, so the default theme changes on the edited line only", () => {
    expect(writeThemeMeta(DEFAULT_THEME_JSON, {})).toBe(DEFAULT_THEME_JSON);
    const next = writeThemeToken(DEFAULT_THEME_JSON, "color.light.accent.base", "#0b5d50")!;
    const before = DEFAULT_THEME_JSON.split("\n");
    const after = next.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toEqual(['        "base": { "$type": "color", "$value": "#0b5d50" },']);
    expect(writeThemeToken('{"space":{"1":{"$type":"dimension","$value":"4px"}}}', "space.2", "8px")).toBe(
      '{\n  "space": {\n    "1": { "$type": "dimension", "$value": "4px" },\n    "2": { "$type": "dimension", "$value": "8px" }\n  }\n}\n',
    );
  });
});

describe("token drafts", () => {
  const PATH = "color.light.background.primary";
  const themeWith = (value: string) => JSON.stringify({ $description: "x", color: { light: { background: { primary: { $type: "color", $value: value } } } } });

  test("typing a color key by key writes only what parses and keeps the rest as a draft", () => {
    let text = themeWith("#ffffff");
    const drafts: Record<string, { source: string; text: string }> = {};
    for (const typed of ["#1", "#12", "#123", "#1234", "#12345"]) {
      const css = parseThemeDocument(text).tokens[PATH]!;
      const input = typedTokenInput("color", css, typed);
      drafts[PATH] = input.draft;
      if (input.ok) text = writeThemeToken(text, PATH, input.raw)!;
    }
    const css = parseThemeDocument(text).tokens[PATH]!;
    // "#123" parsed and was written; "#12345" is on screen, with its hint, and stops a save.
    expect(css).toBe("#112233");
    expect(tokenFieldText("color", css, drafts[PATH])).toBe("#12345");
    expect(tokenFieldError("color", css, "#12345")).toBe("Use #rgb, #rrggbb ou #rrggbbaa.");
    expect(tokenInputErrors(text, drafts)).toEqual([{ path: PATH, message: "Use #rgb, #rrggbb ou #rrggbbaa." }]);
  });

  test("a valid draft keeps the person's spelling and is no error", () => {
    const input = typedTokenInput("color", "#ffffff", "#ABC");
    expect(input).toMatchObject({ ok: true, raw: "#ABC", draft: { source: "#aabbcc", text: "#ABC" } });
    const text = writeThemeToken(themeWith("#ffffff"), PATH, "#ABC")!;
    expect(tokenFieldText("color", "#aabbcc", input.draft)).toBe("#ABC");
    expect(tokenInputErrors(text, { [PATH]: input.draft })).toEqual([]);
  });

  test("a change made elsewhere replaces the draft", () => {
    const drafts = { [PATH]: { source: "#ffffff", text: "#12345" } };
    expect(tokenInputErrors(themeWith("#ffffff"), drafts)).toHaveLength(1);
    // The JSON tab set the token to another value: the field shows it, and nothing stops the save.
    expect(tokenFieldText("color", "#000000", drafts[PATH])).toBe("#000000");
    expect(tokenInputErrors(themeWith("#000000"), drafts)).toEqual([]);
  });

  test("text fields: a dimension typed past a valid value", () => {
    const text = JSON.stringify({ space: { 3: { $type: "dimension", $value: "12px" } } });
    const css = parseThemeDocument(text).tokens["space.3"]!;
    const input = typedTokenInput("dimension", css, "12pxx");
    expect(input.ok).toBe(false);
    expect(tokenInputErrors(text, { "space.3": input.draft })).toEqual([{ path: "space.3", message: "Use um número com px ou rem, como 12px ou 0.75rem." }]);
  });

  test("no errors while the form is not shown", () => {
    expect(tokenInputErrors("{", { [PATH]: { source: "#ffffff", text: "#12345" } })).toEqual([]);
  });

  test("names a field with its mode", () => {
    expect(tokenFieldName(PATH)).toBe("Fundo principal (claro)");
    expect(tokenFieldName("color.dark.text.danger")).toBe("Texto de perigo (escuro)");
    expect(tokenFieldName("space.3")).toBe("Espaço 3");
  });
});

describe("token inputs", () => {
  test("turns typed text into DTCG values the engine accepts", () => {
    expect(parseTokenInput("color", " #ABC ")).toEqual({ ok: true, raw: "#ABC", css: "#aabbcc" });
    expect(parseTokenInput("dimension", "0.75rem")).toEqual({ ok: true, raw: "0.75rem", css: "0.75rem" });
    expect(parseTokenInput("fontWeight", "600")).toEqual({ ok: true, raw: 600, css: "600" });
    expect(parseTokenInput("fontFamily", "Inter, system-ui, sans-serif")).toEqual({
      ok: true,
      raw: ["Inter", "system-ui", "sans-serif"],
      css: "Inter, system-ui, sans-serif",
    });
    expect(parseTokenInput("color", "{color.light.text.primary}")).toEqual({ ok: true, raw: "{color.light.text.primary}", css: null });
  });

  test("refuses invalid and unsafe values with a PT-BR hint", () => {
    expect(parseTokenInput("color", "red")).toEqual({ ok: false, message: "Use #rgb, #rrggbb ou #rrggbbaa." });
    expect(parseTokenInput("dimension", "12")).toMatchObject({ ok: false });
    expect(parseTokenInput("fontWeight", "950")).toMatchObject({ ok: false });
    expect(parseTokenInput("fontFamily", 'Inter"; x')).toMatchObject({ ok: false });
    expect(parseTokenInput("dimension", "url(x)")).toMatchObject({ ok: false });
    expect(parseTokenInput("color", "  ")).toMatchObject({ ok: false });
  });

  test("shows font stacks without quotes", () => {
    expect(tokenInputText("fontFamily", '"IBM Plex Sans", system-ui')).toBe("IBM Plex Sans, system-ui");
    expect(tokenInputText("dimension", "12px")).toBe("12px");
  });

  test("color picker values drop and keep alpha", () => {
    expect(colorPickerValue("#11223380")).toBe("#112233");
    expect(colorPickerValue("{alias}")).toBe("#000000");
    expect(withPickedColor("#11223380", "#AABBCC")).toBe("#aabbcc80");
    expect(withPickedColor("#112233", "#aabbcc")).toBe("#aabbcc");
  });
});

describe("writeFieldsDisplay", () => {
  test("changes one display and keeps the rest", () => {
    const next = writeFieldsDisplay(undefined, "types", "status", "steps");
    const { rules, diagnostics } = parseFieldsJson(next);
    expect(diagnostics).toEqual([]);
    expect(rules.types.status).toBe("steps");
    expect(rules.roles.rating).toBe("stars");
    const again = writeFieldsDisplay(next, "roles", "rating", "number");
    expect(parseFieldsJson(again).rules).toMatchObject({ types: { status: "steps" }, roles: { rating: "number" } });
  });
});

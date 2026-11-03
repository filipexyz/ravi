// `theme.json`: a closed subset of W3C Design Tokens (DTCG). Every accepted
// path is listed in THEME_TOKENS with its type and CSS variable; anything
// else is an error, so the compiler can check every value. Values are parsed
// by type and rewritten from the parsed form (never copied from the input),
// which is what keeps a theme from injecting CSS into the pages that use it.

import type { Diagnostic, ThemeDensity, ThemeMode } from "../types";
import { OPTION_COLORS } from "../types";
import { formatHexColor, parseHexColor } from "./color";
import { DEFAULT_TOKEN_VALUES } from "./default-tokens";
import { isJsonObject, parseJsonWithLines, type JsonPath } from "./json";

export const THEME_TOKEN_TYPES = ["color", "dimension", "fontFamily", "fontWeight", "shadow"] as const;
export type ThemeTokenType = (typeof THEME_TOKEN_TYPES)[number];

export type ThemeTokenSpec = {
  /** Dotted DTCG path, e.g. `color.light.text.primary`. */
  path: string;
  type: ThemeTokenType;
  /** Custom property it compiles to. Light and dark tokens share the variable. */
  cssVar: string;
  /** Color scheme block it belongs to; null for mode-independent tokens. */
  mode: ThemeMode | null;
};

export type ThemeMeta = {
  name: string | null;
  description: string | null;
  /** Canonical BCP 47. */
  locale: string;
  density: ThemeDensity;
};

export type ThemeMetaInput = {
  name?: string | null;
  description?: string | null;
  locale?: string | null;
  density?: ThemeDensity | null;
};

export const THEME_FILE = "theme.json";
export const THEME_DEFAULT_LOCALE = "pt-BR";
export const THEME_DENSITIES: readonly ThemeDensity[] = ["comfortable", "compact"];
export const THEME_MAX_ALIAS_DEPTH = 8;
const THEME_NAME_MAX = 120;
const THEME_DESCRIPTION_MAX = 1024;
const DIMENSION_MAX = 10_000;
const FONT_STACK_MAX = 16;
const SHADOW_LAYERS_MAX = 4;

const SURFACES = ["primary", "secondary", "tertiary", "inverse"] as const;
const STATUSES = ["info", "success", "warning", "danger"] as const;

function colorTokens(mode: ThemeMode): ThemeTokenSpec[] {
  const tokens: ThemeTokenSpec[] = [];
  const add = (path: string, cssVar: string) => tokens.push({ path: `color.${mode}.${path}`, type: "color", cssVar, mode });
  for (const name of [...SURFACES, ...STATUSES]) add(`background.${name}`, `--color-background-${name}`);
  for (const name of [...SURFACES, ...STATUSES]) add(`text.${name}`, `--color-text-${name}`);
  add("border.primary", "--color-border-primary");
  add("border.secondary", "--color-border-secondary");
  add("ring.primary", "--color-ring-primary");
  add("accent.base", "--ravi-color-accent");
  add("accent.text", "--ravi-color-on-accent");
  for (const color of OPTION_COLORS) {
    add(`option.${color}.background`, `--ravi-option-${color}-bg`);
    add(`option.${color}.text`, `--ravi-option-${color}-text`);
  }
  return tokens;
}

function baseTokens(): ThemeTokenSpec[] {
  const token = (path: string, type: ThemeTokenType, cssVar: string): ThemeTokenSpec => ({ path, type, cssVar, mode: null });
  return [
    token("font.sans", "fontFamily", "--font-sans"),
    token("font.mono", "fontFamily", "--font-mono"),
    ...["normal", "medium", "semibold", "bold"].map((weight) =>
      token(`font.weight.${weight}`, "fontWeight", `--font-weight-${weight}`),
    ),
    ...["xs", "sm", "md", "lg"].map((size) => token(`font.size.${size}`, "dimension", `--font-text-${size}-size`)),
    ...["sm", "md", "lg", "xl"].map((size) =>
      token(`font.size.heading.${size}`, "dimension", `--font-heading-${size}-size`),
    ),
    ...["xs", "sm", "md", "lg", "xl", "full"].map((size) => token(`radius.${size}`, "dimension", `--border-radius-${size}`)),
    token("border.width.regular", "dimension", "--border-width-regular"),
    ...["sm", "md", "lg"].map((size) => token(`shadow.${size}`, "shadow", `--shadow-${size}`)),
    ...["1", "2", "3", "4", "5", "6"].map((step) => token(`space.${step}`, "dimension", `--ravi-space-${step}`)),
    token("layout.laneWidth", "dimension", "--ravi-lane-width"),
  ];
}

/** The closed token table, in output order: light colors, dark colors, then mode-independent tokens. */
export const THEME_TOKENS: readonly ThemeTokenSpec[] = [...colorTokens("light"), ...colorTokens("dark"), ...baseTokens()];

export const THEME_TOKEN_BY_PATH: ReadonlyMap<string, ThemeTokenSpec> = new Map(
  THEME_TOKENS.map((token) => [token.path, token]),
);

/** Group path (`""` for the root) → child keys allowed under it. */
const GROUP_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const children = new Map<string, Set<string>>();
  for (const { path } of THEME_TOKENS) {
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      const group = parts.slice(0, i).join(".");
      let set = children.get(group);
      if (!set) children.set(group, (set = new Set()));
      set.add(parts[i]!);
    }
  }
  return children;
})();

// ---------------------------------------------------------------------------
// Value parsing

export type ThemeValueResult =
  | { ok: true; css: string }
  | { ok: false; code: "THEME_UNSAFE_VALUE" | "THEME_VALUE_INVALID"; message: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ALIAS_PATTERN = /^\{([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\}$/;
const DIMENSION_PATTERN = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)$/;
const FONT_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,64}$/;
const CSS_IDENT_PATTERN = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

/** DTCG named weights inside 100..900. */
const FONT_WEIGHT_NAMES: Record<string, number> = {
  thin: 100,
  hairline: 100,
  "extra-light": 200,
  "ultra-light": 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  "semi-bold": 600,
  "demi-bold": 600,
  bold: 700,
  "extra-bold": 800,
  "ultra-bold": 800,
  black: 900,
  heavy: 900,
};

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** The alias target path when `value` is exactly `{a.b.c}`, else null. */
export function themeAliasTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ALIAS_PATTERN.exec(value)?.[1] ?? null;
}

function hasControlCharacter(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Why a string may not appear in a theme value, or null. Whole-value aliases may use braces. */
function unsafeReason(value: string): string | null {
  if (hasControlCharacter(value)) return "control characters";
  if (/url\s*\(/i.test(value)) return "url()";
  if (value.includes("@")) return "'@'";
  if (value.includes(";")) return "';'";
  if (value.includes("\\")) return "a backslash";
  if (value.includes("<") || value.includes(">")) return "'<' or '>'";
  if ((value.includes("{") || value.includes("}")) && !ALIAS_PATTERN.test(value)) return "braces outside an alias";
  return null;
}

function findUnsafe(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return unsafeReason(value);
  if (depth > 4 || typeof value !== "object" || value === null) return null;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const reason = findUnsafe(item, depth + 1);
    if (reason) return reason;
  }
  return null;
}

/** Number for CSS: at most 4 decimals, no exponent, no `-0`. */
function formatNumber(value: number) {
  const rounded = Math.round(value * 10_000) / 10_000;
  return String(rounded === 0 ? 0 : rounded);
}

type Dimension = { value: number; unit: "px" | "rem" };

function parseDimension(raw: unknown, allowNegative: boolean): Parsed<Dimension> {
  let dimension: Dimension;
  if (typeof raw === "string") {
    const match = DIMENSION_PATTERN.exec(raw.trim());
    if (!match) return err(`"${raw}" is not a dimension; write a number with px or rem, like "12px" or "0.75rem"`);
    dimension = { value: Number(match[1]), unit: match[2] as Dimension["unit"] };
  } else if (isJsonObject(raw)) {
    const extra = Object.keys(raw).filter((key) => key !== "value" && key !== "unit");
    if (extra.length) return err(`a dimension takes only "value" and "unit", not ${quoteList(extra)}`);
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return err("a dimension needs a numeric \"value\"");
    if (raw.unit !== "px" && raw.unit !== "rem") return err('a dimension "unit" must be "px" or "rem"');
    dimension = { value: raw.value, unit: raw.unit };
  } else {
    return err('a dimension is { "value": number, "unit": "px" | "rem" } or a string like "12px"');
  }
  if (!allowNegative && dimension.value < 0) return err("a dimension here cannot be negative");
  if (Math.abs(dimension.value) > DIMENSION_MAX) return err(`a dimension must be within ±${DIMENSION_MAX}`);
  return ok(dimension);
}

function formatDimension(dimension: Dimension) {
  return `${formatNumber(dimension.value)}${dimension.unit}`;
}

function parseColor(raw: unknown): Parsed<string> {
  if (typeof raw === "string") {
    const color = parseHexColor(raw.trim());
    if (!color) return err(`"${raw}" is not a color; write #rgb, #rrggbb or #rrggbbaa`);
    return ok(formatHexColor(color));
  }
  if (isJsonObject(raw)) {
    const extra = Object.keys(raw).filter((key) => !["colorSpace", "components", "alpha", "hex"].includes(key));
    if (extra.length) return err(`a color object takes colorSpace, components, alpha and hex, not ${quoteList(extra)}`);
    if (raw.colorSpace !== "srgb") return err('only "colorSpace": "srgb" is supported');
    const components = raw.components;
    if (
      !Array.isArray(components) ||
      components.length !== 3 ||
      !components.every((component) => typeof component === "number" && component >= 0 && component <= 1)
    ) {
      return err('"components" must be three numbers from 0 to 1');
    }
    const alpha = raw.alpha ?? 1;
    if (typeof alpha !== "number" || alpha < 0 || alpha > 1) return err('"alpha" must be a number from 0 to 1');
    if (raw.hex !== undefined && typeof raw.hex !== "string") return err('"hex" must be a string');
    const [r, g, b] = components as [number, number, number];
    return ok(formatHexColor({ r: r * 255, g: g * 255, b: b * 255, a: alpha }));
  }
  return err('a color is a hex string like "#14635a" or { "colorSpace": "srgb", "components": [r, g, b] }');
}

function quoteFontName(name: string) {
  const lower = name.toLowerCase();
  if (GENERIC_FONT_FAMILIES.has(lower)) return lower;
  if (CSS_IDENT_PATTERN.test(name) && !CSS_WIDE_KEYWORDS.has(lower)) return name;
  return `"${name}"`;
}

function parseFontFamily(raw: unknown): Parsed<string> {
  const names = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(names) || names.length === 0 || names.length > FONT_STACK_MAX) {
    return err(`a font family is a name or an array of 1 to ${FONT_STACK_MAX} names`);
  }
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") return err("font names must be strings");
    if (name.includes('"') || name.includes("'")) return err("font names cannot contain quotes; write the bare name");
    if (name.includes(",")) return err("list several fonts as an array of names, not one comma-separated string");
    const clean = name.trim().replace(/\s+/g, " ");
    if (!FONT_NAME_PATTERN.test(clean)) {
      return err(`"${name}" is not a valid font name (letters, digits, spaces, '-' and '_', up to 64)`);
    }
    out.push(quoteFontName(clean));
  }
  return ok(out.join(", "));
}

function parseFontWeight(raw: unknown): Parsed<string> {
  const weight = typeof raw === "string" ? FONT_WEIGHT_NAMES[raw.trim().toLowerCase()] : raw;
  if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 100 || weight > 900) {
    return err("a font weight is a whole number from 100 to 900");
  }
  return ok(String(weight));
}

const SHADOW_KEYS = ["color", "offsetX", "offsetY", "blur", "spread", "inset"];

function parseShadowLayer(raw: unknown): Parsed<string> {
  if (!isJsonObject(raw)) return err("a shadow is { color, offsetX, offsetY, blur, spread } or an array of them");
  const extra = Object.keys(raw).filter((key) => !SHADOW_KEYS.includes(key));
  if (extra.length) return err(`a shadow takes ${SHADOW_KEYS.join(", ")}, not ${quoteList(extra)}`);
  if (themeAliasTarget(raw.color) !== null) return err("aliases are only allowed as a whole token value, not inside a shadow");
  const color = parseColor(raw.color);
  if (!color.ok) return err(`shadow color: ${color.message}`);
  const parts: string[] = [];
  for (const key of ["offsetX", "offsetY", "blur", "spread"] as const) {
    if (raw[key] === undefined) return err(`a shadow needs "${key}"`);
    const dimension = parseDimension(raw[key], key !== "blur");
    if (!dimension.ok) return err(`shadow ${key}: ${dimension.message}`);
    parts.push(formatDimension(dimension.value));
  }
  if (raw.inset !== undefined && typeof raw.inset !== "boolean") return err('shadow "inset" must be true or false');
  return ok(`${raw.inset ? "inset " : ""}${parts.join(" ")} ${color.value}`);
}

function parseShadow(raw: unknown): Parsed<string> {
  const layers = Array.isArray(raw) ? raw : [raw];
  if (layers.length === 0 || layers.length > SHADOW_LAYERS_MAX) {
    return err(`a shadow has 1 to ${SHADOW_LAYERS_MAX} layers`);
  }
  const out: string[] = [];
  for (const layer of layers) {
    const parsed = parseShadowLayer(layer);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out.join(", "));
}

/**
 * Parses one `$value` (not an alias) of the given type into its canonical CSS
 * text. Strings that could inject CSS or load resources are refused first.
 */
export function parseThemeTokenValue(type: ThemeTokenType, raw: unknown): ThemeValueResult {
  const unsafe = findUnsafe(raw);
  if (unsafe) return { ok: false, code: "THEME_UNSAFE_VALUE", message: `the value contains ${unsafe}, which theme values cannot hold` };
  let parsed: Parsed<string>;
  switch (type) {
    case "color":
      parsed = parseColor(raw);
      break;
    case "dimension": {
      const dimension = parseDimension(raw, false);
      parsed = dimension.ok ? ok(formatDimension(dimension.value)) : dimension;
      break;
    }
    case "fontFamily":
      parsed = parseFontFamily(raw);
      break;
    case "fontWeight":
      parsed = parseFontWeight(raw);
      break;
    case "shadow":
      parsed = parseShadow(raw);
      break;
  }
  return parsed.ok ? { ok: true, css: parsed.value } : { ok: false, code: "THEME_VALUE_INVALID", message: parsed.message };
}

/** Scales a canonical dimension (`12px`, `0.75rem`) by `factor`; null when it is not one. */
export function scaleThemeDimension(css: string, factor: number): string | null {
  const match = DIMENSION_PATTERN.exec(css);
  if (!match) return null;
  return formatDimension({ value: Number(match[1]) * factor, unit: match[2] as Dimension["unit"] });
}

/** Canonical BCP 47 tag, or null when `value` is not one. */
export function canonicalizeLocale(value: string): string | null {
  if (!LOCALE_PATTERN.test(value)) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical && LOCALE_PATTERN.test(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function quoteList(keys: string[]) {
  return keys.map((key) => `"${key}"`).join(", ");
}

// ---------------------------------------------------------------------------
// Defaults

let defaultTokensCache: Readonly<Record<string, string>> | null = null;

function defaultTokenMap(): Readonly<Record<string, string>> {
  if (!defaultTokensCache) {
    const tokens: Record<string, string> = {};
    for (const spec of THEME_TOKENS) {
      const parsed = parseThemeTokenValue(spec.type, DEFAULT_TOKEN_VALUES[spec.path]);
      if (!parsed.ok) throw new Error(`Default theme token ${spec.path} is invalid: ${parsed.message}`);
      tokens[spec.path] = parsed.css;
    }
    defaultTokensCache = Object.freeze(tokens);
  }
  return defaultTokensCache;
}

/** The default theme's tokens (path → canonical CSS value), every path present. */
export function defaultThemeTokens(): Record<string, string> {
  return { ...defaultTokenMap() };
}

export function defaultThemeMeta(): ThemeMeta {
  return { name: null, description: null, locale: THEME_DEFAULT_LOCALE, density: "comfortable" };
}

// ---------------------------------------------------------------------------
// Document parsing

export type ParsedThemeDocument = {
  /** Every path of THEME_TOKENS → canonical CSS value; missing or invalid tokens take the default. */
  tokens: Record<string, string>;
  meta: ThemeMeta;
  diagnostics: Diagnostic[];
  /** Token paths the file sets (valid or not). */
  explicit: ReadonlySet<string>;
  /** Token path → line of its key in theme.json. */
  lines: ReadonlyMap<string, number>;
};

type Collected = { raw: unknown; line: number | undefined };

/** `parseThemeJson` plus the explicit paths and key lines (for compile diagnostics and the editor). */
export function parseThemeDocument(text: string): ParsedThemeDocument {
  const diagnostics: Diagnostic[] = [];
  const meta = defaultThemeMeta();
  const collected = new Map<string, Collected>();
  const report = (code: string, message: string, line?: number) =>
    diagnostics.push({ severity: "error", code, message, file: THEME_FILE, ...(line ? { line } : {}) });

  const done = (): ParsedThemeDocument => {
    const tokens = resolveTokens(collected, report);
    const lines = new Map<string, number>();
    for (const [path, entry] of collected) if (entry.line) lines.set(path, entry.line);
    return { tokens, meta, diagnostics, explicit: new Set(collected.keys()), lines };
  };

  const parsed = parseJsonWithLines(text);
  if (!parsed.ok) {
    diagnostics.push({
      severity: "error",
      code: "THEME_JSON_INVALID",
      message: `theme.json is not valid JSON: ${parsed.message}.`,
      file: THEME_FILE,
      line: parsed.line,
      column: parsed.column,
    });
    return done();
  }
  if (!isJsonObject(parsed.value)) {
    report("THEME_JSON_INVALID", "theme.json must be a JSON object of token groups.");
    return done();
  }
  const keyLine = parsed.keyLine;
  const root = parsed.value;

  const readType = (node: Record<string, unknown>, path: JsonPath, dotted: string): ThemeTokenType | undefined => {
    const type = node.$type;
    if (type === undefined) return undefined;
    if (typeof type === "string" && (THEME_TOKEN_TYPES as readonly string[]).includes(type)) return type as ThemeTokenType;
    report(
      "THEME_TYPE_MISMATCH",
      `${dotted || "The root"} has $type ${JSON.stringify(type)}; supported types are ${THEME_TOKEN_TYPES.join(", ")}.`,
      keyLine([...path, "$type"]),
    );
    return undefined;
  };

  const checkMetaKey = (node: Record<string, unknown>, key: string, path: JsonPath, dotted: string, allowed: string[]) => {
    const value = node[key];
    const where = dotted ? `${dotted}.${key}` : key;
    if (!allowed.includes(key)) {
      report("THEME_UNKNOWN_KEY", `Unknown key ${where}; tokens and groups take ${allowed.join(", ")}.`, keyLine([...path, key]));
    } else if (key === "$description" && typeof value !== "string") {
      report("THEME_META_INVALID", `${where} must be a string.`, keyLine([...path, key]));
    } else if (key === "$extensions" && !isJsonObject(value)) {
      report("THEME_META_INVALID", `${where} must be an object.`, keyLine([...path, key]));
    }
  };

  const walkToken = (node: Record<string, unknown>, path: string[], dotted: string, inherited: ThemeTokenType | undefined) => {
    const spec = THEME_TOKEN_BY_PATH.get(dotted)!;
    for (const key of Object.keys(node)) {
      if (key !== "$value" && key !== "$type") {
        checkMetaKey(node, key, path, dotted, ["$value", "$type", "$description", "$extensions", "$deprecated"]);
      }
    }
    const declared = readType(node, path, dotted) ?? inherited;
    if (declared && declared !== spec.type) {
      report("THEME_TYPE_MISMATCH", `Token ${dotted} is a ${spec.type}, not a ${declared}.`, keyLine(path));
      return;
    }
    collected.set(dotted, { raw: node.$value, line: keyLine(path) });
  };

  const walkGroup = (node: Record<string, unknown>, path: string[], inherited: ThemeTokenType | undefined) => {
    const dotted = path.join(".");
    const type = readType(node, path, dotted) ?? inherited;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("$")) {
        if (key === "$type") continue;
        if (path.length === 0 && (key === "$description" || key === "$extensions" || key === "$schema")) continue;
        checkMetaKey(node, key, path, dotted, ["$type", "$description", "$extensions", "$deprecated"]);
        continue;
      }
      const childPath = [...path, key];
      const childDotted = childPath.join(".");
      const line = keyLine(childPath);
      if (/[.{}]/.test(key)) {
        report("THEME_UNKNOWN_TOKEN", `Name "${key}" cannot contain '.', '{' or '}'; nest groups instead.`, line);
      } else if (THEME_TOKEN_BY_PATH.has(childDotted)) {
        if (!isJsonObject(value) || !("$value" in value)) {
          report("THEME_VALUE_INVALID", `Token ${childDotted} must be an object with "$value" (and "$type").`, line);
        } else {
          walkToken(value, childPath, childDotted, type);
        }
      } else if (GROUP_CHILDREN.has(childDotted)) {
        if (!isJsonObject(value) || "$value" in value) {
          const known = [...GROUP_CHILDREN.get(childDotted)!].join(", ");
          report("THEME_VALUE_INVALID", `${childDotted} is a group, not a token; set its tokens (${known}).`, line);
        } else {
          walkGroup(value, childPath, type);
        }
      } else {
        const known = [...(GROUP_CHILDREN.get(dotted) ?? [])].join(", ");
        report(
          "THEME_UNKNOWN_TOKEN",
          `Unknown token path ${childDotted}; ${dotted ? `${dotted} accepts` : "the root accepts"} ${known}.`,
          line,
        );
      }
    }
  };

  readRootMeta(root, meta, keyLine, report);
  walkGroup(root, [], undefined);
  return done();
}

function readRootMeta(
  root: Record<string, unknown>,
  meta: ThemeMeta,
  keyLine: (path: JsonPath) => number | undefined,
  report: (code: string, message: string, line?: number) => void,
) {
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    report("THEME_META_INVALID", "$schema must be a string.", keyLine(["$schema"]));
  }
  if (root.$description !== undefined) {
    const description = typeof root.$description === "string" ? root.$description.trim() : null;
    if (!description || description.length > THEME_DESCRIPTION_MAX || hasControlCharacter(description.replace(/[\n\r\t]/g, ""))) {
      report(
        "THEME_META_INVALID",
        `$description must be text of 1 to ${THEME_DESCRIPTION_MAX} characters without control characters.`,
        keyLine(["$description"]),
      );
    } else {
      meta.description = description;
    }
  }
  const extensions = root.$extensions;
  if (extensions === undefined) return;
  if (!isJsonObject(extensions)) {
    report("THEME_META_INVALID", "$extensions must be an object.", keyLine(["$extensions"]));
    return;
  }
  if (extensions.ravi === undefined) return;
  const ravi = extensions.ravi;
  const line = (key?: string) => keyLine(key ? ["$extensions", "ravi", key] : ["$extensions", "ravi"]);
  if (!isJsonObject(ravi)) {
    report("THEME_META_INVALID", '$extensions.ravi must be an object with "name", "locale" and "density".', line());
    return;
  }
  for (const [key, value] of Object.entries(ravi)) {
    if (key === "name") {
      const name = typeof value === "string" ? value.trim() : "";
      if (!name || name.length > THEME_NAME_MAX || hasControlCharacter(name)) {
        report("THEME_META_INVALID", `$extensions.ravi.name must be text of 1 to ${THEME_NAME_MAX} characters.`, line(key));
      } else {
        meta.name = name;
      }
    } else if (key === "locale") {
      const locale = typeof value === "string" ? canonicalizeLocale(value.trim()) : null;
      if (!locale) {
        report("THEME_META_INVALID", '$extensions.ravi.locale must be a BCP 47 tag like "pt-BR" or "en".', line(key));
      } else {
        meta.locale = locale;
      }
    } else if (key === "density") {
      if (value !== "comfortable" && value !== "compact") {
        report("THEME_META_INVALID", '$extensions.ravi.density must be "comfortable" or "compact".', line(key));
      } else {
        meta.density = value;
      }
    } else {
      report("THEME_UNKNOWN_KEY", `Unknown key $extensions.ravi.${key}; it takes name, locale and density.`, line(key));
    }
  }
}

/**
 * Resolves aliases (whole-value `{path}` references to other tokens of the
 * same type, through the file and then the defaults, at most
 * THEME_MAX_ALIAS_DEPTH hops, no cycles) and parses every value. Invalid
 * tokens report once, where the problem is, and fall back to the default.
 */
function resolveTokens(
  collected: ReadonlyMap<string, Collected>,
  report: (code: string, message: string, line?: number) => void,
): Record<string, string> {
  const defaults = defaultTokenMap();
  const memo = new Map<string, { css: string | null; hops: number }>();
  const resolving: string[] = [];

  const resolve = (path: string): { css: string | null; hops: number } => {
    const cached = memo.get(path);
    if (cached) return cached;
    const spec = THEME_TOKEN_BY_PATH.get(path)!;
    const entry = collected.get(path);
    let result: { css: string | null; hops: number };
    if (!entry) {
      result = { css: defaults[path] ?? null, hops: 0 };
    } else {
      const target = themeAliasTarget(entry.raw);
      const targetSpec = target === null ? undefined : THEME_TOKEN_BY_PATH.get(target);
      if (target === null) {
        const parsed = parseThemeTokenValue(spec.type, entry.raw);
        if (!parsed.ok) report(parsed.code, `Token ${path}: ${parsed.message}.`, entry.line);
        result = { css: parsed.ok ? parsed.css : null, hops: 0 };
      } else if (!targetSpec) {
        report("THEME_ALIAS_UNKNOWN", `Token ${path} refers to {${target}}, which is not a theme token.`, entry.line);
        result = { css: null, hops: 0 };
      } else if (targetSpec.type !== spec.type) {
        report(
          "THEME_ALIAS_TYPE",
          `Token ${path} is a ${spec.type} but refers to {${target}}, a ${targetSpec.type}.`,
          entry.line,
        );
        result = { css: null, hops: 0 };
      } else if (target === path || resolving.includes(target)) {
        const cycle = [...resolving.slice(resolving.indexOf(target)), path, target];
        report("THEME_ALIAS_CYCLE", `Alias cycle: ${cycle.join(" -> ")}; point one of them at a value.`, entry.line);
        result = { css: null, hops: 0 };
      } else {
        resolving.push(path);
        const resolved = resolve(target);
        resolving.pop();
        const hops = resolved.hops + 1;
        if (resolved.css !== null && hops > THEME_MAX_ALIAS_DEPTH) {
          report(
            "THEME_ALIAS_DEPTH",
            `Token ${path} goes through ${hops} aliases; at most ${THEME_MAX_ALIAS_DEPTH} are allowed.`,
            entry.line,
          );
          result = { css: null, hops };
        } else {
          result = { css: resolved.css, hops };
        }
      }
    }
    memo.set(path, result);
    return result;
  };

  const tokens: Record<string, string> = {};
  for (const spec of THEME_TOKENS) tokens[spec.path] = resolve(spec.path).css ?? defaults[spec.path]!;
  return tokens;
}

/**
 * Parses theme.json into canonical token values (every path present; missing
 * or invalid tokens take the default theme's value) and its root metadata.
 */
export function parseThemeJson(text: string): {
  tokens: Record<string, string>;
  meta: ThemeMeta;
  diagnostics: Diagnostic[];
} {
  const { tokens, meta, diagnostics } = parseThemeDocument(text);
  return { tokens, meta, diagnostics };
}

// ---------------------------------------------------------------------------
// Writing theme.json (Console theme editor, default theme)

/**
 * Pretty theme.json for `tokens` (path → CSS value as the editor holds it;
 * unknown paths are skipped). Values are written in DTCG form; a value the
 * writer cannot convert is written as typed, so `parseThemeJson` reports it.
 */
export function themeJsonFromTokens(tokens: Record<string, string>, meta: ThemeMetaInput = {}): string {
  return writeThemeJson(meta, (spec) => {
    const value = tokens[spec.path];
    return value === undefined ? undefined : dtcgValueFromCss(spec.type, value);
  });
}

/** Same as themeJsonFromTokens, from raw DTCG `$value`s by path (the default theme's source). */
export function themeJsonFromValues(values: Readonly<Record<string, unknown>>, meta: ThemeMetaInput = {}): string {
  return writeThemeJson(meta, (spec) => values[spec.path]);
}

function writeThemeJson(meta: ThemeMetaInput, valueOf: (spec: ThemeTokenSpec) => unknown): string {
  const document: Record<string, unknown> = {};
  const description = meta.description?.trim();
  if (description) document.$description = description;
  const ravi: Record<string, unknown> = {};
  const name = meta.name?.trim();
  if (name) ravi.name = name;
  ravi.locale = meta.locale ?? THEME_DEFAULT_LOCALE;
  ravi.density = meta.density ?? "comfortable";
  document.$extensions = { ravi };
  for (const spec of THEME_TOKENS) {
    const value = valueOf(spec);
    if (value !== undefined) setNested(document, spec.path.split("."), { $type: spec.type, $value: value });
  }
  return `${stringifyThemeNode(document, "")}\n`;
}

/** Groups are indented; each token stays on one line (`{ "$type": ..., "$value": ... }`). */
function stringifyThemeNode(value: unknown, indent: string): string {
  if (!isJsonObject(value) || "$value" in value) return stringifyInline(value);
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  const inner = `${indent}  `;
  const body = entries.map(([key, child]) => `${inner}${JSON.stringify(key)}: ${stringifyThemeNode(child, inner)}`);
  return `{\n${body.join(",\n")}\n${indent}}`;
}

function stringifyInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stringifyInline).join(", ")}]`;
  if (isJsonObject(value)) {
    const entries = Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${stringifyInline(child)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value) ?? "null";
}

function setNested(target: Record<string, unknown>, parts: string[], value: unknown) {
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isJsonObject(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

/** Converts a CSS value (canonical or typed by a person) back to its DTCG `$value`. */
function dtcgValueFromCss(type: ThemeTokenType, css: string): unknown {
  const value = css.trim();
  if (themeAliasTarget(value) !== null) return value;
  switch (type) {
    case "color":
    case "dimension":
      return value;
    case "fontFamily": {
      const names = value
        .split(",")
        .map((name) => name.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
        .filter(Boolean);
      return names.length ? names : value;
    }
    case "fontWeight":
      return /^\d+$/.test(value) ? Number(value) : value;
    case "shadow": {
      const layers = splitTopLevel(value).map(shadowLayerFromCss);
      if (!layers.length || layers.some((layer) => layer === null)) return value;
      return layers.length === 1 ? layers[0] : layers;
    }
  }
}

function splitTopLevel(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function shadowLayerFromCss(layer: string): Record<string, unknown> | null {
  const words = layer.split(/\s+/).filter(Boolean);
  const inset = words[0] === "inset";
  if (inset) words.shift();
  const colorIndex = words.findIndex((word) => word.startsWith("#"));
  if (colorIndex === -1) return null;
  const [color] = words.splice(colorIndex, 1);
  if (words.length < 2 || words.length > 4) return null;
  const [offsetX, offsetY, blur = "0px", spread = "0px"] = words.map((word) => (word === "0" ? "0px" : word));
  return { color, offsetX, offsetY, blur, spread, ...(inset ? { inset: true } : {}) };
}

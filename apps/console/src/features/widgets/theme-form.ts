// The theme editor's form over theme.json: which tokens it shows in which
// group, their PT-BR names, how a typed value becomes a DTCG `$value`, and how
// one change is written back. theme.json stays the source of truth: a form
// change sets that one `$value` (or metadata key) in the parsed file and
// keeps everything else as written (aliases, `$description`, `$extensions`,
// `$schema`, unknown paths the compiler reports), so the JSON tab and the
// compiler always see the person's whole file.

import { parseFieldsJson, fieldsJsonFromRules } from "@/shared/widgets/theme/fields";
import {
  parseThemeDocument,
  parseThemeTokenValue,
  THEME_TOKENS,
  themeAliasTarget,
  type ThemeMetaInput,
  type ThemeTokenType,
} from "@/shared/widgets/theme/tokens";
import { OPTION_COLORS, type FieldDisplayRules, type ThemeDensity, type ThemeMode } from "@/shared/widgets/types";

export const MODE_WORDS: Record<ThemeMode, string> = { light: "Claro", dark: "Escuro" };

export type TokenGroup = { id: string; title: string; paths: string[] };

const COLOR_GROUPS: { id: string; title: string; prefix: string }[] = [
  { id: "background", title: "Cores de fundo", prefix: "background." },
  { id: "text", title: "Texto", prefix: "text." },
  { id: "border", title: "Borda", prefix: "border." },
  { id: "ring", title: "Foco", prefix: "ring." },
  { id: "accent", title: "Destaque", prefix: "accent." },
  { id: "option", title: "Opções", prefix: "option." },
];

/** Color groups of one mode, in token order. */
export function colorGroups(mode: ThemeMode): TokenGroup[] {
  return COLOR_GROUPS.map((group) => ({
    id: `${mode}-${group.id}`,
    title: group.title,
    paths: THEME_TOKENS.filter((token) => token.path.startsWith(`color.${mode}.${group.prefix}`)).map((token) => token.path),
  }));
}

/** Mode-independent groups the form shows; shadows, border width and lane width stay in the JSON tab. */
export const BASE_GROUPS: TokenGroup[] = [
  { id: "font", title: "Fontes", paths: THEME_TOKENS.filter((token) => token.path.startsWith("font.")).map((token) => token.path) },
  { id: "radius", title: "Raios", paths: THEME_TOKENS.filter((token) => token.path.startsWith("radius.")).map((token) => token.path) },
  { id: "space", title: "Espaços", paths: THEME_TOKENS.filter((token) => token.path.startsWith("space.")).map((token) => token.path) },
];

export function tokenType(path: string): ThemeTokenType | null {
  return THEME_TOKENS.find((token) => token.path === path)?.type ?? null;
}

// ---------------------------------------------------------------------------
// Names

const SURFACE_WORDS: Record<string, { m: string; f: string }> = {
  primary: { m: "principal", f: "principal" },
  secondary: { m: "secundário", f: "secundária" },
  tertiary: { m: "terciário", f: "terciária" },
  inverse: { m: "invertido", f: "invertida" },
  info: { m: "de informação", f: "de informação" },
  success: { m: "de sucesso", f: "de sucesso" },
  warning: { m: "de alerta", f: "de alerta" },
  danger: { m: "de perigo", f: "de perigo" },
};

export const OPTION_COLOR_WORDS: Record<(typeof OPTION_COLORS)[number], string> = {
  gray: "cinza",
  brown: "marrom",
  orange: "laranja",
  yellow: "amarelo",
  green: "verde",
  blue: "azul",
  purple: "roxo",
  pink: "rosa",
  red: "vermelho",
};

const BASE_WORDS: Record<string, string> = {
  "font.sans": "Fonte do texto",
  "font.mono": "Fonte de código",
  "font.weight.normal": "Peso normal",
  "font.weight.medium": "Peso médio",
  "font.weight.semibold": "Peso seminegrito",
  "font.weight.bold": "Peso negrito",
  "radius.full": "Raio total (pílula)",
  "border.width.regular": "Espessura da borda",
  "layout.laneWidth": "Largura da coluna do quadro",
};

/** PT-BR name of a token without its mode: "Fundo principal", "Opção azul: texto", "Tamanho do título md". */
export function tokenLabel(path: string): string {
  const parts = path.split(".");
  if (parts[0] === "color" && parts.length >= 4) {
    const [, , group, name, part] = parts as [string, string, string, string, string | undefined];
    const word = SURFACE_WORDS[name];
    if (group === "background" && word) return `Fundo ${word.m}`;
    if (group === "text" && word) return `Texto ${word.m}`;
    if (group === "border" && word) return `Borda ${word.f}`;
    if (group === "ring") return "Anel de foco";
    if (group === "accent") return name === "text" ? "Texto sobre o destaque" : "Destaque";
    if (group === "option") {
      const color = OPTION_COLOR_WORDS[name as keyof typeof OPTION_COLOR_WORDS] ?? name;
      return `Opção ${color}: ${part === "text" ? "texto" : "fundo"}`;
    }
  }
  if (BASE_WORDS[path]) return BASE_WORDS[path]!;
  if (path.startsWith("font.size.heading.")) return `Tamanho do título ${parts[3]}`;
  if (path.startsWith("font.size.")) return `Tamanho do texto ${parts[2]}`;
  if (path.startsWith("radius.")) return `Raio ${parts[1]}`;
  if (path.startsWith("space.")) return `Espaço ${parts[1]}`;
  if (path.startsWith("shadow.")) return `Sombra ${parts[1]}`;
  return path;
}

/** "Texto principal sobre fundo principal"; option pills read "Opção azul: texto sobre o fundo". */
export function contrastPairLabel(pair: readonly [string, string]) {
  const [fg, bg] = pair;
  const fgParts = fg.split(".");
  const bgParts = bg.split(".");
  if (fgParts[2] === "option" && bgParts[2] === "option" && fgParts[3] === bgParts[3]) {
    return `${tokenLabel(fg)} sobre o fundo`;
  }
  const background = tokenLabel(bg);
  return `${tokenLabel(fg)} sobre ${background.charAt(0).toLowerCase()}${background.slice(1)}`;
}

/** A token's name with its mode, as the form's group legends give it: "Fundo principal (claro)", "Espaço 3". */
export function tokenFieldName(path: string) {
  const mode = tokenMode(path);
  return mode ? `${tokenLabel(path)} (${MODE_WORDS[mode].toLowerCase()})` : tokenLabel(path);
}

/** The mode a color token path belongs to, or null for mode-independent tokens. */
export function tokenMode(path: string): ThemeMode | null {
  const mode = path.split(".")[1];
  return path.startsWith("color.") && (mode === "light" || mode === "dark") ? mode : null;
}

// ---------------------------------------------------------------------------
// Reading and writing theme.json

export type ThemeSource = {
  /** Raw DTCG `$value` by token path, as written (aliases kept). */
  values: Record<string, unknown>;
  meta: ThemeMetaInput;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** theme.json's raw token values and root metadata, or null when it is not a JSON object. */
export function readThemeSource(text: string): ThemeSource | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(document)) return null;
  const values: Record<string, unknown> = {};
  for (const spec of THEME_TOKENS) {
    let node: unknown = document;
    for (const part of spec.path.split(".")) node = isObject(node) && Object.hasOwn(node, part) ? node[part] : undefined;
    if (isObject(node) && Object.hasOwn(node, "$value")) values[spec.path] = node.$value;
  }
  const extensions = isObject(document.$extensions) ? document.$extensions : {};
  const ravi = isObject(extensions.ravi) ? extensions.ravi : {};
  const asText = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    values,
    meta: {
      name: asText(ravi.name),
      description: asText(document.$description),
      locale: asText(ravi.locale),
      // Kept as written so an invalid density still reaches the compiler's diagnostic.
      density: (asText(ravi.density) as ThemeDensity | null) ?? null,
    },
  };
}

/** theme.json parsed for an edit, or null when it is not a JSON object. */
function parseThemeObject(text: string): JsonObject | null {
  try {
    const document: unknown = JSON.parse(text);
    return isObject(document) ? document : null;
  } catch {
    return null;
  }
}

/**
 * theme.json with one token's `$value` set to `raw` and every other key kept
 * (its `$type`, `$description` and `$extensions` too); a token the file does
 * not have yet is added as `{ $type, $value }`. `raw` undefined removes the
 * token, so the default applies. Null when theme.json is not a JSON object.
 */
export function writeThemeToken(text: string, path: string, raw: unknown): string | null {
  const document = parseThemeObject(text);
  if (!document) return null;
  const parts = path.split(".");
  const name = parts.pop()!;
  if (raw === undefined) {
    removeThemeToken(document, parts, name);
    return stringifyThemeJson(document);
  }
  let group = document;
  for (const part of parts) {
    const next = ownValue(group, part);
    if (isObject(next)) {
      group = next;
    } else {
      // Missing (or not a group, which the compiler already reports): the token needs its group.
      const created: JsonObject = {};
      setOwn(group, part, created);
      group = created;
    }
  }
  const token = ownValue(group, name);
  if (isObject(token)) {
    setOwn(token, "$value", raw);
  } else {
    const type = tokenType(path);
    setOwn(group, name, type ? { $type: type, $value: raw } : { $value: raw });
  }
  return stringifyThemeJson(document);
}

/** Deletes the token at `groups`.`name` and the groups it leaves empty. */
function removeThemeToken(document: JsonObject, groups: string[], name: string) {
  const chain: JsonObject[] = [document];
  for (const part of groups) {
    const next = ownValue(chain[chain.length - 1]!, part);
    if (!isObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1]![name];
  for (let index = chain.length - 1; index > 0 && Object.keys(chain[index]!).length === 0; index--) {
    delete chain[index - 1]![groups[index - 1]!];
  }
}

/**
 * theme.json with its name, description, locale or density changed (a key
 * left out of `patch` stays as written; null or blank removes it) and every
 * other key kept. Null when theme.json is not a JSON object.
 */
export function writeThemeMeta(text: string, patch: ThemeMetaInput): string | null {
  let document = parseThemeObject(text);
  if (!document) return null;
  if (patch.description !== undefined) {
    const description = patch.description?.trim();
    if (description) document = withKeyAt(document, "$description", description, Object.hasOwn(document, "$schema") ? 1 : 0);
    else delete document.$description;
  }
  const ravi: Partial<Record<"name" | "locale" | "density", string | null>> = {};
  if (patch.name !== undefined) ravi.name = patch.name?.trim() || null;
  if (patch.locale !== undefined) ravi.locale = patch.locale || null;
  if (patch.density !== undefined) ravi.density = patch.density || null;

  const found = ownValue(document, "$extensions");
  let extensions: JsonObject | null = isObject(found) ? found : null;
  let target = extensions ? ownValue(extensions, "ravi") : undefined;
  if (!extensions || !isObject(target)) {
    // No `$extensions.ravi` yet: nothing to remove, and setting a key creates it after `$schema` and `$description`.
    if (Object.values(ravi).every((value) => value === null)) return stringifyThemeJson(document);
    if (!extensions) {
      extensions = {};
      const at = ["$schema", "$description"].filter((key) => Object.hasOwn(document!, key)).length;
      document = withKeyAt(document, "$extensions", extensions, at);
    }
    target = {};
    setOwn(extensions, "ravi", target);
  }
  const fields = target as JsonObject;
  let removed = false;
  for (const [key, value] of Object.entries(ravi)) {
    if (value !== null) setOwn(fields, key, value);
    else if (Object.hasOwn(fields, key)) removed = delete fields[key];
  }
  // A removal that empties `ravi` takes it out, and `$extensions` with it when nothing else is there.
  if (removed && !Object.keys(fields).length) {
    delete extensions.ravi;
    if (!Object.keys(extensions).length) delete document.$extensions;
  }
  return stringifyThemeJson(document);
}

type JsonObject = Record<string, unknown>;

function ownValue(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** Sets an own data property (a "__proto__" key from the file stays a key, never a prototype). */
function setOwn(object: JsonObject, key: string, value: unknown) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `object` with `key` set to `value`: in place when it exists, else inserted at `index` among the keys. */
function withKeyAt(object: JsonObject, key: string, value: unknown, index: number): JsonObject {
  if (Object.hasOwn(object, key)) {
    setOwn(object, key, value);
    return object;
  }
  const entries = Object.entries(object);
  entries.splice(index, 0, [key, value]);
  const next: JsonObject = {};
  for (const [entryKey, entryValue] of entries) setOwn(next, entryKey, entryValue);
  return next;
}

/**
 * The layout the engine writes theme.json in (`themeJsonFromValues`): groups
 * indented two spaces, each token (an object with `$value`) on one line. A
 * file the editor or `ravi themes init` wrote changes only on the edited line.
 */
function stringifyThemeJson(document: JsonObject): string {
  return `${stringifyThemeNode(document, "")}\n`;
}

function stringifyThemeNode(value: unknown, indent: string): string {
  if (!isObject(value) || "$value" in value) return stringifyInline(value);
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  const inner = `${indent}  `;
  const body = entries.map(([key, child]) => `${inner}${JSON.stringify(key)}: ${stringifyThemeNode(child, inner)}`);
  return `{\n${body.join(",\n")}\n${indent}}`;
}

function stringifyInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stringifyInline).join(", ")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${stringifyInline(child)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// Form inputs

/** What a token input shows for a canonical CSS value: font stacks without quotes. */
export function tokenInputText(type: ThemeTokenType, css: string) {
  if (type !== "fontFamily") return css;
  return css
    .split(",")
    .map((name) => name.trim().replace(/^(["'])(.*)\1$/, "$2"))
    .filter(Boolean)
    .join(", ");
}

const INPUT_HINTS: Record<ThemeTokenType, string> = {
  color: "Use #rgb, #rrggbb ou #rrggbbaa.",
  dimension: "Use um número com px ou rem, como 12px ou 0.75rem.",
  fontFamily: "Use nomes de fontes separados por vírgula, sem aspas.",
  fontWeight: "Use um número inteiro de 100 a 900.",
  shadow: "Edite as sombras na aba JSON.",
};

export type TokenInputResult = { ok: true; raw: unknown; css: string | null } | { ok: false; message: string };

/**
 * A typed value → the DTCG `$value` the form writes, checked with the
 * engine's own parser. `css` is the canonical value (null for an alias,
 * which only the compiler resolves).
 */
export function parseTokenInput(type: ThemeTokenType, text: string): TokenInputResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: INPUT_HINTS[type] };
  if (themeAliasTarget(trimmed) !== null) return { ok: true, raw: trimmed, css: null };
  let raw: unknown = trimmed;
  if (type === "fontFamily") raw = trimmed.split(",").map((name) => name.trim()).filter(Boolean);
  if (type === "fontWeight") raw = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
  const parsed = parseThemeTokenValue(type, raw);
  return parsed.ok ? { ok: true, raw, css: parsed.css } : { ok: false, message: INPUT_HINTS[type] };
}

/**
 * Text typed into a token field, kept while the token still has the value it
 * had then (`source`, its CSS value), so an edit elsewhere (the JSON tab)
 * replaces it. Text that does not parse stays here, never in theme.json.
 */
export type TokenDraft = { source: string; text: string };
export type TokenDrafts = Readonly<Record<string, TokenDraft>>;

/** What a token field shows for the token's CSS value: the person's text while it still applies, else the value. */
export function tokenFieldText(type: ThemeTokenType, css: string, draft: TokenDraft | undefined) {
  return draft && draft.source === css ? draft.text : tokenInputText(type, css);
}

/** The hint a token field shows while its text cannot be written to theme.json, else null. */
export function tokenFieldError(type: ThemeTokenType, css: string, text: string): string | null {
  if (text === tokenInputText(type, css)) return null;
  const result = parseTokenInput(type, text);
  return result.ok ? null : result.message;
}

/** Text typed into a token field: the draft to keep and, when it parses, the `$value` to write. */
export function typedTokenInput(type: ThemeTokenType, css: string, text: string): { draft: TokenDraft } & ({ ok: true; raw: unknown } | { ok: false }) {
  const parsed = parseTokenInput(type, text);
  // An alias has no CSS value of its own here; the field shows what it resolves to once the compiler runs.
  if (parsed.ok) return { ok: true, raw: parsed.raw, draft: { source: parsed.css ?? css, text } };
  return { ok: false, draft: { source: css, text } };
}

/**
 * Token fields whose text could not be written to theme.json, in form
 * order: each one stops a save. Empty when the form is not shown (theme.json
 * is not a JSON object).
 */
export function tokenInputErrors(themeText: string, drafts: TokenDrafts): { path: string; message: string }[] {
  const specs = THEME_TOKENS.filter((spec) => Object.hasOwn(drafts, spec.path));
  if (!specs.length || !parseThemeObject(themeText)) return [];
  const { tokens } = parseThemeDocument(themeText);
  const errors: { path: string; message: string }[] = [];
  for (const spec of specs) {
    const css = tokens[spec.path] ?? "";
    const text = tokenFieldText(spec.type, css, drafts[spec.path]);
    const message = tokenFieldError(spec.type, css, text);
    if (message) errors.push({ path: spec.path, message });
  }
  return errors;
}

/** `#rrggbb` for `<input type="color">`, which takes no alpha. */
export function colorPickerValue(css: string) {
  return /^#[0-9a-f]{6}/i.test(css) ? css.slice(0, 7).toLowerCase() : "#000000";
}

/** A picked `#rrggbb`, keeping the alpha the token had. */
export function withPickedColor(css: string, picked: string) {
  const alpha = /^#[0-9a-f]{8}$/i.test(css) ? css.slice(7) : "";
  return `${picked.toLowerCase()}${alpha}`;
}

// ---------------------------------------------------------------------------
// fields.json

/** fields.json with one type or role display changed (absent file → the defaults plus the change). */
export function writeFieldsDisplay(text: string | undefined, section: "types" | "roles", key: string, display: string): string {
  const { rules } = parseFieldsJson(text);
  const next: FieldDisplayRules = { types: { ...rules.types }, roles: { ...rules.roles } };
  (next[section] as Record<string, string>)[key] = display;
  return fieldsJsonFromRules(next);
}

// The Library's kinds: skills and agent definitions (text an agent reads),
// themes (an organization's design tokens) and widgets (templates that render
// records on Pages). Each kind has its URL segment, its files and its reserved
// route words; themes and widgets also compile with the shared engine
// (`@/shared/widgets`), and any error diagnostic rejects the write before a
// version or proposal is stored. See `.ravi/specs/console/library`.

import { cliApiError } from "@/server/cli/errors";
import { compileWidget } from "@/shared/widgets/template/compile";
import { compileTheme } from "@/shared/widgets/theme/compile";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";
import type { Diagnostic } from "@/shared/widgets/types";

import { LIBRARY_ENTRY_FILES, LIBRARY_LIMITS, prepareLibraryFiles, type LibraryFileInput, type LibraryItemKind } from "./files";
import { isReservedLibrarySlug, RESERVED_KIND_ROUTE_SLUGS } from "./reserved";

export type LibraryKind = LibraryItemKind;
export type CompiledLibraryKind = "theme" | "widget";

export const LIBRARY_KINDS = ["skill", "agent", "theme", "widget"] as const satisfies readonly LibraryKind[];

export const LIBRARY_KIND_SEGMENTS: Record<LibraryKind, string> = {
  skill: "skills",
  agent: "agents",
  theme: "themes",
  widget: "widgets",
};

const KIND_BY_SEGMENT: ReadonlyMap<string, LibraryKind> = new Map(
  LIBRARY_KINDS.map((kind) => [LIBRARY_KIND_SEGMENTS[kind], kind] as const),
);

/** The kind a URL segment (`skills`, `agents`, `themes`, `widgets`) names. */
export function kindFromSegment(segment: string | undefined): LibraryKind | null {
  return segment ? (KIND_BY_SEGMENT.get(segment) ?? null) : null;
}

const KIND_NOUNS: Record<LibraryKind, string> = { skill: "skill", agent: "agent", theme: "theme", widget: "widget" };

export function kindNoun(kind: LibraryKind) {
  return KIND_NOUNS[kind];
}

export function isCompiledKind(kind: LibraryKind): kind is CompiledLibraryKind {
  return kind === "theme" || kind === "widget";
}

/** Files a theme or widget version may hold; `required` includes the entry file. */
export const KIND_FILE_RULES: Record<CompiledLibraryKind, { required: readonly string[]; allowed: ReadonlySet<string> }> = {
  theme: { required: ["theme.json"], allowed: new Set(["theme.json", "fields.json", "logo.svg", "README.md"]) },
  widget: {
    required: ["widget.html", "widget.json"],
    allowed: new Set(["widget.html", "widget.json", "example.json", "widget.js", "README.md"]),
  },
};

/** Organization roles that may publish a widget version with `widget.js` (JS-CONTRACT J4), for org and project widgets alike. */
export const SCRIPT_PUBLISHING_ORG_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Whether a version's files hold code: a widget's `widget.js`. */
export function hasWidgetScript(kind: LibraryKind, files: readonly { path: string }[]) {
  return kind === "widget" && files.some((file) => file.path === WIDGET_SCRIPT_FILE);
}

/**
 * J4: a widget version with `widget.js` reaches pages only when an
 * organization owner or admin publishes it, in org and project scope alike.
 * Proposing stays open to whoever proposes today; publishing it (directly,
 * from a proposal or by revert) is `403 LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN`.
 */
export function assertScriptPublisher(role: string, kind: LibraryKind, files: readonly { path: string }[]) {
  if (hasWidgetScript(kind, files) && !SCRIPT_PUBLISHING_ORG_ROLES.has(role)) {
    throw cliApiError(
      403,
      "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN",
      "This widget has widget.js: only an organization owner or admin publishes code. Propose it instead; an admin publishes it from the Console.",
    );
  }
}

/** Name and description a theme or widget declares in its files. */
export type KindMeta = { name: string | null; description: string | null };

/**
 * `prepareLibraryFiles` plus the kind's own rules: themes and widgets hold only
 * their files and must compile. Warnings come back in `diagnostics`.
 */
export function prepareKindFiles(kind: LibraryKind, input: readonly LibraryFileInput[]) {
  const prepared = prepareLibraryFiles(input, kind);
  if (isCompiledKind(kind)) {
    const rules = KIND_FILE_RULES[kind];
    const extra = prepared.files.filter((file) => !rules.allowed.has(file.path)).map((file) => file.path);
    if (extra.length > 0) {
      throw invalid(`A ${kind} holds only ${[...rules.allowed].join(", ")}; remove ${extra.slice(0, 5).join(", ")}.`);
    }
    const missing = rules.required.filter((path) => !prepared.files.some((file) => file.path === path));
    if (missing.length > 0) throw invalid(`A ${kind} needs ${missing.join(" and ")}.`);
  }
  return { ...prepared, ...compileKindFiles(kind, prepared.files) };
}

/**
 * Compiles a theme's or widget's stored files with the current engine; skills
 * and agents have nothing to compile. Any error is `400 PAYLOAD_INVALID` with
 * every diagnostic in `details.diagnostics`.
 */
export function compileKindFiles(kind: LibraryKind, files: readonly { path: string; content: string }[]): { diagnostics: Diagnostic[]; meta: KindMeta } {
  const texts = files.map((file) => ({ path: file.path, content: file.content }));
  if (kind === "theme") {
    const result = compileTheme(texts);
    assertCompiles(kind, result.diagnostics);
    return { diagnostics: result.diagnostics, meta: { name: result.theme?.name ?? null, description: result.theme?.description ?? null } };
  }
  if (kind === "widget") {
    const result = compileWidget(texts);
    assertCompiles(kind, result.diagnostics);
    return { diagnostics: result.diagnostics, meta: { name: result.manifest?.name ?? null, description: result.manifest?.description ?? null } };
  }
  return { diagnostics: [], meta: { name: null, description: null } };
}

function assertCompiles(kind: CompiledLibraryKind, diagnostics: readonly Diagnostic[]) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const first = errors[0];
  if (!first) return;
  const where = [first.file, first.line, first.column].filter((part) => part !== undefined).join(":");
  throw cliApiError(
    400,
    "PAYLOAD_INVALID",
    `The ${kind} has ${errors.length} error${errors.length === 1 ? "" : "s"}. ${where ? `${where}: ` : ""}${first.message}`,
    { diagnostics },
  );
}

/**
 * The name and description a write stores: the body's; for themes and widgets
 * the files' when the body omits them (`$extensions.ravi.name` and
 * `$description` in theme.json, `name` and `description` in widget.json). The
 * name falls back to `fallbackName`; a missing description is
 * `400 PAYLOAD_INVALID`, as it is for skills and agents.
 */
export function kindText(input: {
  kind: LibraryKind;
  name: string | undefined;
  description: string | undefined;
  meta: KindMeta;
  fallbackName: string;
  what: string;
}): { name: string; description: string } {
  const { kind, meta } = input;
  const fromFiles = (value: string | null, max: number, what: string) => {
    const text = isCompiledKind(kind) ? value?.trim() : null;
    if (!text) return null;
    if (text.length > max) throw invalid(`The ${kind}'s ${what} is longer than ${max} characters.`);
    return text;
  };
  const name = input.name ?? fromFiles(meta.name, LIBRARY_LIMITS.maxNameLength, "name") ?? input.fallbackName;
  const description = input.description ?? fromFiles(meta.description, LIBRARY_LIMITS.maxDescriptionLength, "description");
  if (!description) throw invalid(`Invalid ${input.what} request: description.`);
  return { name, description };
}

/**
 * The search vector's body (weight C): the entry file for skills and agents,
 * README.md for themes, and for widgets every field's key, label, type, role
 * and description from widget.json plus README.md.
 */
export function kindSearchBody(kind: LibraryKind, files: readonly { path: string; content: string }[]) {
  const content = (path: string) => files.find((file) => file.path === path)?.content ?? "";
  switch (kind) {
    case "skill":
    case "agent":
      return content(LIBRARY_ENTRY_FILES[kind]);
    case "theme":
      return content("README.md");
    case "widget":
      return [widgetFieldsSearchText(content("widget.json")), content("README.md")].filter(Boolean).join("\n");
  }
}

/** One line per widget.json field: key, label, type, role and description. Files were validated when written. */
export function widgetFieldsSearchText(manifest: string) {
  let value: unknown;
  try {
    value = JSON.parse(manifest);
  } catch {
    return "";
  }
  const fields = value && typeof value === "object" ? (value as { fields?: unknown }).fields : null;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "";
  return Object.entries(fields as Record<string, unknown>)
    .map(([key, spec]) => {
      const record = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
      const parts = [record.label, record.type, record.role, record.description].filter((part): part is string => typeof part === "string");
      return [key, ...parts].join(" ");
    })
    .join("\n");
}

/**
 * Refuses a slug the kind may not take: Ravi's own skill names (skills), and
 * the words theme and widget routes use after `themes/` and `widgets/`.
 */
export function assertSlugAllowed(kind: LibraryKind, slug: string) {
  if (kind === "skill" && isReservedLibrarySlug(slug)) {
    throw slugReserved(`"${slug}" is the name of a skill that ships with Ravi. Pick another slug.`);
  }
  if (isCompiledKind(kind) && RESERVED_KIND_ROUTE_SLUGS[kind].has(slug)) {
    throw slugReserved(`"${slug}" is a word the Library's ${kind} routes use. Pick another slug.`);
  }
}

function slugReserved(message: string) {
  return cliApiError(409, "CONFLICT", message, { reason: "slug_reserved", conflict: "slug_reserved" });
}

function invalid(message: string) {
  return cliApiError(400, "PAYLOAD_INVALID", message);
}

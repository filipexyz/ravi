// Page kit step of `ravi pages ship` and the `ravi pages outdated` listing.
// Transport only: the Console compiles themes and widgets, rewrites the HTML
// and derives the `uses` ids. This module sends the HTML files of the private
// ship copy, writes back the files the Console changed, and passes the
// presentation metadata through unchanged.

import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { normalizePageUses } from "./assertion-audiences.js";
import { createAuthenticatedPagesContext, type PagesClientDeps } from "./client.js";

export const PAGES_KIT_PATH = "/api/cli/pages/kit";
export const PAGES_OUTDATED_PATH = "/api/cli/pages/outdated";
export const PAGE_KIT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** The Console's page kit body limit; a bigger request skips the kit instead of failing the ship. */
export const PAGE_KIT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const PAGE_KIT_THEME_NONE = "none";

const HTML_FILE_PATTERN = /\.html?$/i;
const THEME_REF_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const KIT_SKIPPED_EFFECT = "Shipped the HTML unchanged: no theme, widgets or derived --uses.";

export interface PageKitFile {
  path: string;
  html: string;
}

export interface PageKitDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
  /**
   * Console page that fixes it, when the Console names one: for
   * `KIT_WIDGET_UNAUDITED`, the widget version where an org owner or admin runs
   * the accessibility audit.
   */
  url?: string;
  /** The widget a widget diagnostic is about (`org/<slug>@<version>`), when the Console names it. */
  widget?: string;
}

/** A widget with `widget.js` whose version has no passing accessibility audit yet. */
export const KIT_WIDGET_UNAUDITED = "KIT_WIDGET_UNAUDITED";

/** `applied`: the Console answered; `unavailable`: older Console; `skipped`: nothing sent. */
export type PageKitStatus = "applied" | "unavailable" | "skipped";

export interface PageKitSummary {
  status: PageKitStatus;
  changedFiles: string[];
  warnings: string[];
  theme: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
}

export interface PageKitResult {
  kit: PageKitSummary;
  /** Ids the Console derived from the tags, already normalized. */
  uses: string[];
  presentation: Record<string, unknown> | null;
}

export type PageKitOutcome = { ok: true; result: PageKitResult } | { ok: false; diagnostics: PageKitDiagnostic[] };

export interface PageKitInput {
  /** Root of the private ship copy. Changed files are written back here. */
  root: string;
  project: string;
  site: string;
  route: string;
  visibility: string;
  /** null = effective theme pointer, `none` = no theme, else a theme ref. */
  theme: string | null;
  console?: string;
}

/** `--theme <ref|none>`: null when absent, `none` for no theme, else the ref. */
export function normalizeShipTheme(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing --theme value. Pass a theme ref (slug, org/<slug>) or none.");
  }
  if (trimmed.toLowerCase() === PAGE_KIT_THEME_NONE) return PAGE_KIT_THEME_NONE;
  if (!THEME_REF_PATTERN.test(trimmed)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid --theme value "${trimmed}". Use slug, org/<slug>, or none.`);
  }
  return trimmed;
}

/** Declared `--uses` first, then the ids the kit derived; normalized and deduplicated. */
export function mergePageUses(
  declared: readonly string[] | undefined,
  derived: readonly string[],
): string[] | undefined {
  return normalizePageUses([...(declared ?? []), ...derived]);
}

/** One diagnostic as `path:line:column severity code message`. */
export function formatPageKitDiagnostic(diagnostic: PageKitDiagnostic): string {
  const location = [diagnostic.path ?? "-", diagnostic.line, diagnostic.column]
    .filter((part) => part !== null)
    .join(":");
  const url = diagnostic.url && !diagnostic.message.includes(diagnostic.url) ? ` ${diagnostic.url}` : "";
  return `${location} ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}${url}`;
}

export type PageKitCollection = { files: PageKitFile[] } | { skipped: string };

/**
 * Every `.html`/`.htm` file under the root, as package paths. Symlinks and
 * paths the package cannot publish (dot segments, `_ravi`) are left out.
 */
export async function collectPageKitFiles(root: string): Promise<PageKitCollection> {
  const files: PageKitFile[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const dir = pending.shift() as string;
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "_ravi") continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !HTML_FILE_PATTERN.test(entry.name)) continue;
      const info = await lstat(join(root, path));
      if (info.size > PAGE_KIT_FILE_MAX_BYTES) {
        return {
          skipped: `KIT_TOO_LARGE: ${path} is larger than ${mebibytes(PAGE_KIT_FILE_MAX_BYTES)}, the page kit limit per HTML file. ${KIT_SKIPPED_EFFECT}`,
        };
      }
      files.push({ path, html: await readFile(join(root, path), "utf8") });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files };
}

/**
 * Send the HTML files to the Console page kit and write back what changed.
 * A Console without the route skips the kit with `KIT_UNAVAILABLE`; a 422
 * returns the diagnostics so the caller exits 2. Other failures throw.
 */
export async function applyPageKit(input: PageKitInput, deps: PagesClientDeps = {}): Promise<PageKitOutcome> {
  const collected = await collectPageKitFiles(input.root);
  if ("skipped" in collected) return { ok: true, result: unchangedKit("skipped", [collected.skipped]) };
  if (collected.files.length === 0) return { ok: true, result: unchangedKit("skipped", []) };

  const body = {
    project: input.project,
    site: input.site,
    route: input.route,
    visibility: input.visibility,
    theme: input.theme,
    files: collected.files,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > PAGE_KIT_REQUEST_MAX_BYTES) {
    return {
      ok: true,
      result: unchangedKit("skipped", [
        `KIT_TOO_LARGE: the HTML files add up to more than ${mebibytes(PAGE_KIT_REQUEST_MAX_BYTES)}, the page kit request limit. ${KIT_SKIPPED_EFFECT}`,
      ]),
    };
  }

  const auth = await createAuthenticatedPagesContext({ console: input.console }, deps);
  let payload: unknown;
  try {
    payload = await auth.client.requestJson<unknown>("POST", PAGES_KIT_PATH, body, auth.accessToken);
  } catch (error) {
    if (error instanceof CloudAuthError && isKitRouteMissing(error)) {
      return {
        ok: true,
        result: unchangedKit("unavailable", [
          `KIT_UNAVAILABLE: this Console has no page kit (older Console). ${KIT_SKIPPED_EFFECT}`,
        ]),
      };
    }
    if (error instanceof CloudAuthError && (error.status === 422 || error.consoleCode === KIT_WIDGET_UNAUDITED)) {
      return { ok: false, diagnostics: kitInvalidDiagnostics(error) };
    }
    throw error;
  }

  const response = normalizeKitResponse(payload);
  const sent = new Set(collected.files.map((file) => file.path));
  const changedFiles: string[] = [];
  for (const file of response.files) {
    // An unchanged file comes back without `html`: the local copy is already right.
    if (!file.changed || !sent.has(file.path) || changedFiles.includes(file.path)) continue;
    if (file.html === null) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `The Console page kit changed ${file.path} but sent no HTML.`);
    }
    await writeFile(join(input.root, file.path), file.html, "utf8");
    changedFiles.push(file.path);
  }
  // A 200 never blocks: every diagnostic it carries (a code this CLI does not
  // know included, such as KIT_THEME_DEFAULT or KIT_ACTIONS_NEED_VIEW) is a
  // warning printed with its code and message.
  const warnings = dedupe([...response.warnings, ...response.diagnostics.map(formatPageKitDiagnostic)]);
  return {
    ok: true,
    result: {
      kit: {
        status: "applied",
        changedFiles,
        warnings,
        theme: objectValue(response.presentation?.theme),
        widgets: arrayValue(response.presentation?.widgets).flatMap((item) => {
          const record = objectValue(item);
          return record ? [record] : [];
        }),
      },
      uses: normalizePageUses(response.uses) ?? [],
      presentation: response.presentation,
    },
  };
}

/** The kit did not run: files ship as they are, with no presentation and no derived uses. */
function unchangedKit(status: "skipped" | "unavailable", warnings: string[]): PageKitResult {
  return {
    kit: { status, changedFiles: [], warnings, theme: null, widgets: [] },
    uses: [],
    presentation: null,
  };
}

/** An older Console answers the unknown route with a bare 404 (or 405), never a coded NOT_FOUND. */
function isKitRouteMissing(error: CloudAuthError): boolean {
  return (error.status === 404 && error.code !== "NOT_FOUND") || error.status === 405;
}

function kitInvalidDiagnostics(error: CloudAuthError): PageKitDiagnostic[] {
  const diagnostics = arrayValue(error.details?.diagnostics).flatMap((item) => {
    const diagnostic = normalizeDiagnostic(item);
    return diagnostic ? [diagnostic] : [];
  });
  if (diagnostics.length > 0) return diagnostics;
  // The Console may answer the unaudited widget as its own error code, with
  // the audit page in `details`.
  if (error.consoleCode === KIT_WIDGET_UNAUDITED) {
    const url = consoleUrl(error.details);
    const widget = stringValue(error.details?.widget);
    return [
      {
        severity: "error",
        code: KIT_WIDGET_UNAUDITED,
        message: error.message,
        path: stringValue(error.details?.path),
        line: null,
        column: null,
        ...(url ? { url } : {}),
        ...(widget ? { widget } : {}),
      },
    ];
  }
  return [{ severity: "error", code: "KIT_INVALID", message: error.message, path: null, line: null, column: null }];
}

interface PageKitResponse {
  /** `html` is null when the Console omits it, as it does for `changed: false`. */
  files: Array<{ path: string; html: string | null; changed: boolean }>;
  uses: string[];
  presentation: Record<string, unknown> | null;
  diagnostics: PageKitDiagnostic[];
  warnings: string[];
}

function normalizeKitResponse(payload: unknown): PageKitResponse {
  const record = objectValue(payload) ?? {};
  return {
    files: arrayValue(record.files).flatMap((item) => {
      const file = objectValue(item);
      const path = stringValue(file?.path);
      if (!file || !path) return [];
      return [{ path, html: typeof file.html === "string" ? file.html : null, changed: file.changed === true }];
    }),
    uses: arrayValue(record.uses).filter((value): value is string => typeof value === "string"),
    presentation: objectValue(record.presentation),
    diagnostics: arrayValue(record.diagnostics).flatMap((item) => {
      const diagnostic = normalizeDiagnostic(item);
      return diagnostic ? [diagnostic] : [];
    }),
    warnings: arrayValue(record.warnings).flatMap((value) => {
      if (typeof value === "string") return value.trim() ? [value.trim()] : [];
      // A warning sent as an object `{ code, message, path?, line?, column? }`.
      const diagnostic = normalizeDiagnostic(value, "warning");
      return diagnostic ? [formatPageKitDiagnostic(diagnostic)] : [];
    }),
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeDiagnostic(
  value: unknown,
  fallbackSeverity: PageKitDiagnostic["severity"] = "error",
): PageKitDiagnostic | null {
  const record = objectValue(value);
  const warning = fallbackSeverity === "warning";
  const rawCode = stringValue(record?.code);
  const rawMessage = stringValue(record?.message);
  // A warning is never dropped for a missing field: it keeps whichever it has.
  const code = rawCode ?? (warning && rawMessage ? "KIT_WARNING" : null);
  const message = rawMessage ?? (warning && rawCode ? "(the Console sent no message)" : null);
  if (!record || !code || !message) return null;
  const url = consoleUrl(record);
  const widget = stringValue(record.widget);
  return {
    severity: diagnosticSeverity(record.severity, fallbackSeverity),
    code,
    message,
    path: stringValue(record.path) ?? stringValue(record.file),
    line: positiveInteger(record.line),
    column: positiveInteger(record.column),
    ...(url ? { url } : {}),
    ...(widget ? { widget } : {}),
  };
}

/** `error` blocks; `warning`, `info` and `notice` do not. Anything else takes the fallback. */
function diagnosticSeverity(value: unknown, fallback: PageKitDiagnostic["severity"]): PageKitDiagnostic["severity"] {
  if (value === "error") return "error";
  if (value === "warning" || value === "info" || value === "notice") return "warning";
  return fallback;
}

/** The Console page a diagnostic points to (`url`, `auditUrl` or `consoleUrl`), only when it is http(s). */
function consoleUrl(record: Record<string, unknown> | null | undefined): string | null {
  for (const key of ["url", "auditUrl", "consoleUrl"]) {
    const value = stringValue(record?.[key]);
    if (value && /^https?:\/\/\S+$/i.test(value) && value.length <= 500) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ravi pages outdated

export interface OutdatedVersionPair {
  pinned: unknown;
  current: unknown;
}

export interface OutdatedPageItem {
  siteSlug: string | null;
  hostname: string | null;
  route: string;
  releaseId: string | null;
  publishedAt: string | null;
  theme: OutdatedVersionPair | null;
  widgets: Array<OutdatedVersionPair & { ref: string | null }>;
  runtime: OutdatedVersionPair | null;
}

export interface OutdatedPagesResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  total: number;
  items: OutdatedPageItem[];
}

/** `GET /api/cli/pages/outdated?project=`: active routes shipped with an older theme, widget or runtime. */
export async function listOutdatedPages(
  options: { project: string; console?: string },
  deps: PagesClientDeps = {},
): Promise<OutdatedPagesResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await auth.client.requestJson<unknown>(
    "GET",
    `${PAGES_OUTDATED_PATH}?${new URLSearchParams({ project: options.project }).toString()}`,
    undefined,
    auth.accessToken,
  );
  const items = arrayValue(objectValue(payload)?.items).flatMap((item) => {
    const normalized = normalizeOutdatedItem(item);
    return normalized ? [normalized] : [];
  });
  return { success: true, consoleUrl: auth.consoleUrl, projectRef: options.project, total: items.length, items };
}

/** What is behind on one route: `theme org/acme v2→v3; widget org/card v1→v2; runtime 1.0.0→1.1.0`. */
export function describeOutdatedItem(item: OutdatedPageItem): string {
  const parts: string[] = [];
  if (item.theme) {
    const pinnedRef = refOf(item.theme.pinned);
    const currentRef = refOf(item.theme.current);
    const sameRef = pinnedRef !== null && pinnedRef === currentRef;
    const pinned = versionLabel(item.theme.pinned, !sameRef);
    const current = versionLabel(item.theme.current, !sameRef);
    parts.push(`theme ${sameRef ? `${pinnedRef} ` : ""}${pinned}→${current}`);
  }
  for (const widget of item.widgets) {
    parts.push(
      `widget ${widget.ref ?? "?"} ${versionLabel(widget.pinned, false)}→${versionLabel(widget.current, false)}`,
    );
  }
  if (item.runtime && item.runtime.pinned !== item.runtime.current) {
    parts.push(`runtime ${versionLabel(item.runtime.pinned, false)}→${versionLabel(item.runtime.current, false)}`);
  }
  return parts.join("; ") || "-";
}

/** Plain text table: host, route and what is behind. */
export function renderOutdatedTable(items: readonly OutdatedPageItem[]): string[] {
  const rows = items.map((item) => [item.hostname ?? item.siteSlug ?? "?", item.route, describeOutdatedItem(item)]);
  const header = ["HOST", "ROUTE", "BEHIND"];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)));
  const line = (row: readonly string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function normalizeOutdatedItem(value: unknown): OutdatedPageItem | null {
  const record = objectValue(value);
  const route = stringValue(record?.route);
  if (!record || !route) return null;
  return {
    siteSlug: stringValue(record.siteSlug),
    hostname: stringValue(record.hostname),
    route,
    releaseId: stringValue(record.releaseId),
    publishedAt: stringValue(record.publishedAt),
    theme: versionPair(record.theme),
    widgets: arrayValue(record.widgets).flatMap((item) => {
      const pair = versionPair(item);
      return pair ? [{ ref: stringValue(objectValue(item)?.ref), ...pair }] : [];
    }),
    runtime: versionPair(record.runtime),
  };
}

function versionPair(value: unknown): OutdatedVersionPair | null {
  const record = objectValue(value);
  if (!record) return null;
  return { pinned: jsonOrNull(record.pinned), current: jsonOrNull(record.current) };
}

/** `v3` for a version number, `org/acme v3` with the ref, the text itself for a runtime version. */
function versionLabel(value: unknown, withRef: boolean): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "number") return `v${value}`;
  if (typeof value === "string") return value;
  const record = objectValue(value);
  if (!record) return "?";
  const version =
    typeof record.version === "number"
      ? `v${record.version}`
      : (stringValue(record.version) ?? shortHash(stringValue(record.hash)) ?? "?");
  const ref = withRef ? refOf(record) : null;
  return ref ? `${ref} ${version}` : version;
}

function refOf(value: unknown): string | null {
  return stringValue(objectValue(value)?.ref);
}

function shortHash(value: string | null): string | null {
  return value ? value.slice(0, 8) : null;
}

function jsonOrNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

function mebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

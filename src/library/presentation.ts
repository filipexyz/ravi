/**
 * Library operations of themes and widgets that skills do not have:
 * search and show without local items, the default theme and the widget
 * scaffold for `init`, check and preview, the widget catalog for agents, and
 * the org/project theme pointers. Publish, propose and proposals are the
 * shared ones in service.ts (with `kind`).
 *
 * spec: skills/library
 *
 * Transport only: the Console compiles, checks contrast, renders previews and
 * decides who may set a pointer. This side reads the folder, writes files
 * and keeps an agent inside its own Console project's view.
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  isLibraryNotFoundError,
  libraryLoginRequiredError,
  openLibrarySession,
  type LibrarySession,
  type LibrarySessionOptions,
} from "./client.js";
import {
  hasDiagnosticErrors,
  LibraryDiagnosticsError,
  ThemeCheckFailed,
  type LibraryDiagnostic,
} from "./diagnostics.js";
import { LIBRARY_KIND_PROFILES, PRESENTATION_FILES, type PresentationKind } from "./kinds.js";
import { isSafeLibraryPath, LibraryPackageError, readPresentationFiles, type LibraryPackageFile } from "./package.js";
import { isLibrarySlug, parseLibraryRef, type LibraryRef } from "./refs.js";
import {
  assertLibraryRefInCallerView,
  clampSearchLimit,
  LibraryCommandError,
  notFound,
  openSessionForCaller,
  refForItem,
  usageError,
  type LibraryCaller,
  type LibraryServiceDeps,
} from "./service.js";
import type {
  LibraryContrastReport,
  LibraryFileText,
  LibraryItem,
  LibraryThemeActive,
  LibraryThemeUsePlan,
  LibraryVersion,
  LibraryWidgetCatalog,
  LibraryWidgetSummary,
} from "./types.js";

export const LIBRARY_FILES_EXIST = "LIBRARY_FILES_EXIST";

function openKindSession(
  kind: PresentationKind,
  options: LibrarySessionOptions,
  deps: LibraryServiceDeps,
): Promise<LibrarySession | null> {
  const withKind = { ...options, kind };
  return deps.openSession ? deps.openSession(withKind) : openLibrarySession(withKind, deps.session);
}

async function requireSession(
  kind: PresentationKind,
  project: string | null,
  caller: LibraryCaller | null,
  deps: LibraryServiceDeps,
): Promise<LibrarySession> {
  const session = await openSessionForCaller(project, caller, deps, kind);
  if (!session) throw libraryLoginRequiredError();
  return session;
}

// ---------------------------------------------------------------------------
// Search and show

export interface PresentationSearchResult {
  ref: string;
  scope: "org" | "project";
  project: string | null;
  name: string;
  description: string;
  version: number;
  next: string;
}

export interface PresentationSearchPayload {
  query: string;
  project: string | null;
  total: number;
  items: PresentationSearchResult[];
}

export async function searchPresentationItems(
  input: {
    kind: PresentationKind;
    query: string;
    limit?: number;
    project?: string | null;
    caller?: LibraryCaller | null;
  },
  deps: LibraryServiceDeps = {},
): Promise<PresentationSearchPayload> {
  const profile = LIBRARY_KIND_PROFILES[input.kind];
  const session = await requireSession(input.kind, input.project ?? null, input.caller ?? null, deps);
  const project = session.project?.ref ?? null;
  const response = await session.client.search({ query: input.query, project, limit: clampSearchLimit(input.limit) });
  const items = response.items.map((item) => {
    const ref = refForItem(item).ref;
    return {
      ref,
      scope: item.scope,
      project: item.project?.slug ?? null,
      name: item.name,
      description: item.description,
      version: item.version,
      next: `ravi ${profile.group} show ${ref}`,
    };
  });
  return { query: input.query, project, total: items.length, items };
}

export interface PresentationShowOutcome {
  ref: LibraryRef;
  item: LibraryItem;
  version: LibraryVersion;
  consoleUrl: string;
}

/** A ref (`org/x`, `<project>/x`) or a bare slug resolved in the caller's view (project items, then org items). */
export async function showPresentationItem(
  input: {
    kind: PresentationKind;
    ref?: LibraryRef;
    slug?: string;
    version?: number;
    project?: string | null;
    caller?: LibraryCaller | null;
  },
  deps: LibraryServiceDeps = {},
): Promise<PresentationShowOutcome> {
  const profile = LIBRARY_KIND_PROFILES[input.kind];
  const caller = input.caller ?? null;
  const session = await requireSession(input.kind, input.project ?? null, caller, deps);
  // With a ref the scope is known up front: refuse another project's item before asking.
  if (caller && input.ref) assertLibraryRefInCallerView(caller, input.ref, session, input.ref.project, null, profile);
  const label = input.ref?.ref ?? input.slug ?? "";
  try {
    let shown = input.ref
      ? await session.client.showRef(input.ref, input.version !== undefined ? { version: input.version } : {})
      : await session.client.showSlug(input.slug ?? "", { project: session.project?.ref ?? null });
    const ref = refForItem(shown.item);
    if (caller)
      assertLibraryRefInCallerView(caller, ref, session, shown.item.project?.slug, shown.item.project?.id, profile);
    if (!input.ref && input.version !== undefined && input.version !== shown.version.number) {
      shown = await session.client.showRef(ref, { version: input.version });
    }
    return { ref, item: shown.item, version: shown.version, consoleUrl: session.consoleUrl };
  } catch (error) {
    if (isLibraryNotFoundError(error)) {
      throw notFound(input.version !== undefined ? `${label}@${input.version}` : label, profile);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// init: the default theme and the widget scaffold

export interface WrittenFile {
  file: string;
  bytes: number;
  overwritten: boolean;
}

export interface PresentationInitOutcome {
  kind: PresentationKind;
  dir: string;
  slug: string | null;
  files: WrittenFile[];
  diagnostics: LibraryDiagnostic[];
}

export interface WidgetInitInput {
  dir: string;
  slug: string;
  view?: string;
  project?: string | null;
  force?: boolean;
  caller?: LibraryCaller | null;
}

/** `ravi themes init`: write the Console's default theme files into the folder. */
export async function initTheme(
  input: { dir: string; force?: boolean },
  deps: LibraryServiceDeps = {},
): Promise<PresentationInitOutcome> {
  assertWritableFolder(input.dir);
  const session = await openKindSession("theme", { resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  const generated = await session.client.themeDefault();
  const files = writeGeneratedFiles("theme", input.dir, generated.files, input.force === true);
  return { kind: "theme", dir: input.dir, slug: null, files, diagnostics: generated.diagnostics };
}

/** `ravi widgets init`: write the Console's scaffold (fields from a view's describe with `view`). */
export async function initWidget(
  input: WidgetInitInput,
  deps: LibraryServiceDeps = {},
): Promise<PresentationInitOutcome> {
  if (!isLibrarySlug(input.slug)) {
    throw usageError(
      `"${input.slug.slice(0, 80)}" is not a valid Library slug: 1-64 characters of a-z, 0-9 and -, starting and ending with a letter or digit.`,
      "Pass --slug <slug>",
    );
  }
  assertWritableFolder(input.dir);
  const session = await requireSession("widget", input.project ?? null, input.caller ?? null, deps);
  const project = session.project?.ref ?? null;
  const generated = await session.client.scaffoldWidget({
    slug: input.slug,
    ...(input.view ? { view: input.view } : {}),
    ...(project ? { project } : {}),
  });
  if (hasDiagnosticErrors(generated.diagnostics)) throw new LibraryDiagnosticsError("widget", generated.diagnostics);
  const files = writeGeneratedFiles("widget", input.dir, generated.files, input.force === true);
  return { kind: "widget", dir: input.dir, slug: input.slug, files, diagnostics: generated.diagnostics };
}

function assertWritableFolder(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) {
      throw new LibraryPackageError("LIBRARY_PACKAGE_INVALID", "The path exists and is not a folder.", [
        { path: ["dir"], code: "LIBRARY_PACKAGE_INVALID", message: "Not a folder." },
      ]);
    }
  } catch (error) {
    if (error instanceof LibraryPackageError) throw error;
    // Missing: created on write.
  }
}

/**
 * Write the files the Console generated. Only the kind's own files at the
 * folder root are written; existing files are kept unless `force`.
 */
function writeGeneratedFiles(
  kind: PresentationKind,
  dir: string,
  files: readonly LibraryFileText[],
  force: boolean,
): WrittenFile[] {
  const allowed = new Set(PRESENTATION_FILES[kind].allowed);
  for (const file of files) {
    if (!isSafeLibraryPath(file.path) || !allowed.has(file.path)) {
      throw new LibraryCommandError(
        "SERVER_UNAVAILABLE",
        `The Console returned a file a ${kind} folder does not hold: ${file.path.slice(0, 80)}.`,
        1,
        { suggestedAction: "Update Ravi (ravi update) or try again later" },
      );
    }
  }
  const existing = files.filter((file) => existsSync(join(dir, file.path))).map((file) => file.path);
  if (existing.length > 0 && !force) {
    throw new LibraryCommandError(
      LIBRARY_FILES_EXIST,
      `The folder already has ${existing.join(", ")}; nothing was written.`,
      3,
      {
        existing,
        suggestedAction: "Pass --force to overwrite them, or choose another folder",
      },
    );
  }
  mkdirSync(dir, { recursive: true });
  return files.map((file) => {
    const target = join(dir, file.path);
    const overwritten = existsSync(target);
    if (overwritten && !lstatSync(target).isFile()) {
      throw new LibraryCommandError(LIBRARY_FILES_EXIST, `${file.path} exists and is not a regular file.`, 3, {
        existing: [file.path],
        suggestedAction: "Remove it or choose another folder",
      });
    }
    writeFileSync(target, file.content, "utf8");
    return { file: file.path, bytes: Buffer.byteLength(file.content, "utf8"), overwritten };
  });
}

// ---------------------------------------------------------------------------
// check and preview

export interface ThemeCheckOutcome {
  kind: "theme";
  ok: boolean;
  files: Array<{ file: string; bytes: number }>;
  diagnostics: LibraryDiagnostic[];
  contrast: LibraryContrastReport | null;
  css: string | null;
}

export interface WidgetCheckOutcome {
  kind: "widget";
  ok: boolean;
  files: Array<{ file: string; bytes: number }>;
  diagnostics: LibraryDiagnostic[];
  widget: LibraryWidgetSummary | null;
}

/** Send the folder's files to the Console check; throws {@link LibraryDiagnosticsError} on errors. */
export async function checkPresentationFolder(
  input: { kind: "theme"; dir: string },
  deps?: LibraryServiceDeps,
): Promise<ThemeCheckOutcome>;
export async function checkPresentationFolder(
  input: { kind: "widget"; dir: string },
  deps?: LibraryServiceDeps,
): Promise<WidgetCheckOutcome>;
export async function checkPresentationFolder(
  input: { kind: PresentationKind; dir: string },
  deps: LibraryServiceDeps = {},
): Promise<ThemeCheckOutcome | WidgetCheckOutcome> {
  const files = readPresentationFiles(input.kind, input.dir);
  const session = await openKindSession(input.kind, { resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  const listed = fileList(files);
  if (input.kind === "theme") {
    const checked = await session.client.checkTheme(files);
    if (!checked.ok || hasDiagnosticErrors(checked.diagnostics)) {
      throw new ThemeCheckFailed(checked.diagnostics, checked.contrast);
    }
    return { kind: "theme", files: listed, ...checked };
  }
  const checked = await session.client.checkWidget(files);
  if (!checked.ok || hasDiagnosticErrors(checked.diagnostics)) {
    throw new LibraryDiagnosticsError("widget", checked.diagnostics);
  }
  return { kind: "widget", files: listed, ...checked };
}

export interface WidgetPreviewInput {
  dir: string;
  out: string;
  /** Omitted: the Console picks the effective theme; `none` (or `default`): Ravi's default theme. */
  theme?: string;
  data?: unknown;
  project?: string | null;
  caller?: LibraryCaller | null;
}

export interface WidgetPreviewOutcome {
  out: string;
  bytes: number;
  diagnostics: LibraryDiagnostic[];
}

export async function previewWidget(
  input: WidgetPreviewInput,
  deps: LibraryServiceDeps = {},
): Promise<WidgetPreviewOutcome> {
  const files = readPresentationFiles("widget", input.dir);
  const session = await requireSession("widget", input.project ?? null, input.caller ?? null, deps);
  const project = session.project?.ref ?? null;
  const preview = await session.client.previewWidget({
    files,
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(project ? { project } : {}),
  });
  if (hasDiagnosticErrors(preview.diagnostics)) throw new LibraryDiagnosticsError("widget", preview.diagnostics);
  if (!preview.html) {
    throw new LibraryCommandError("SERVER_UNAVAILABLE", "The Console returned an empty preview.", 1, {
      suggestedAction: "Try again later",
    });
  }
  mkdirSync(dirname(input.out), { recursive: true });
  writeFileSync(input.out, preview.html, "utf8");
  return { out: input.out, bytes: Buffer.byteLength(preview.html, "utf8"), diagnostics: preview.diagnostics };
}

// ---------------------------------------------------------------------------
// The widget catalog

export async function widgetCatalog(
  input: { project?: string | null; caller?: LibraryCaller | null },
  deps: LibraryServiceDeps = {},
): Promise<LibraryWidgetCatalog & { project: string | null }> {
  const session = await requireSession("widget", input.project ?? null, input.caller ?? null, deps);
  const project = session.project?.ref ?? null;
  const catalog = await session.client.widgetCatalog(project);
  return { project, ...catalog };
}

// ---------------------------------------------------------------------------
// Theme pointers

export async function themeActive(
  input: { project?: string | null; caller?: LibraryCaller | null },
  deps: LibraryServiceDeps = {},
): Promise<LibraryThemeActive & { projectRef: string | null }> {
  const session = await requireSession("theme", input.project ?? null, input.caller ?? null, deps);
  const projectRef = session.project?.ref ?? null;
  return { projectRef, ...(await session.client.themeActive(projectRef)) };
}

export interface ThemeUseInput {
  /** A ref (`org/x`, `<project>/x`), a bare slug, or `none` to clear the pointer. */
  ref: string;
  /** Set the project pointer of this project; otherwise the org's (or the ref's own project). */
  project?: string | null;
}

export interface PreparedThemeUse {
  session: LibrarySession;
  body: { scope: "org" | "project"; project?: string; ref: string | null };
  plan: LibraryThemeUsePlan;
}

/** Parse `<ref|none>` and `--project` into a pointer write. Throws LIBRARY_REF_INVALID (exit 2). */
export function themeUseTarget(input: ThemeUseInput): PreparedThemeUse["body"] {
  const raw = input.ref.trim().toLowerCase();
  const project = input.project?.trim().toLowerCase() || null;
  if (project !== null && !isLibrarySlug(project)) {
    throw usageError(
      "--project takes a Console project slug (a-z, 0-9 and -).",
      "List projects with: ravi projects list",
    );
  }
  let ref: string | null;
  let refProject: string | null = null;
  if (raw === "none") {
    ref = null;
  } else if (raw.includes("/")) {
    const parsed = parseLibraryRef(raw);
    if (!parsed) throw invalidThemeRef(input.ref);
    ref = parsed.ref;
    refProject = parsed.scope === "project" ? parsed.project : null;
  } else if (isLibrarySlug(raw)) {
    ref = raw;
  } else {
    throw invalidThemeRef(input.ref);
  }
  // A project theme can only be a project's pointer: its own project's, unless --project says which.
  const pointerProject = project ?? refProject;
  return pointerProject ? { scope: "project", project: pointerProject, ref } : { scope: "org", ref };
}

function invalidThemeRef(value: string): LibraryCommandError {
  return new LibraryCommandError(
    "LIBRARY_REF_INVALID",
    `Not a valid theme ref: ${value.slice(0, 120)}. Use org/<slug>, <project>/<slug>, a slug, or none.`,
    2,
    { suggestedAction: "Copy the ref from: ravi themes search <words> --json" },
  );
}

/** Ask the Console for the plan (`dryRun`): what changes and which Pages hosts it reaches. */
export async function prepareThemeUse(input: ThemeUseInput, deps: LibraryServiceDeps = {}): Promise<PreparedThemeUse> {
  const body = themeUseTarget(input);
  const session = await openKindSession("theme", { resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  try {
    const planned = await session.client.setThemeActive({ ...body, dryRun: true });
    return { session, body, plan: planned.plan };
  } catch (error) {
    if (isLibraryNotFoundError(error) && body.ref) throw notFound(body.ref, LIBRARY_KIND_PROFILES.theme);
    throw error;
  }
}

export async function executeThemeUse(
  prepared: PreparedThemeUse,
): Promise<{ plan: LibraryThemeUsePlan; applied: boolean }> {
  return prepared.session.client.setThemeActive({ ...prepared.body, dryRun: false });
}

// ---------------------------------------------------------------------------

function fileList(files: readonly LibraryPackageFile[]): Array<{ file: string; bytes: number }> {
  return files.map((file) => ({ file: file.path, bytes: file.bytes }));
}

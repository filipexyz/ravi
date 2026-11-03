// Theme and widget tools under the Library router, for `ravi themes|widgets`
// and the Console editors. None of them writes:
//
//   GET  themes/default                 the built-in default theme's files (`ravi themes init`)
//   POST themes/check                   compile + contrast report, also when there are errors
//   GET  widgets/catalog?project=       pieces, filters, types, roles, tokens and the visible widgets
//   POST widgets/check                  compile
//   POST widgets/preview                standalone HTML: every variant, light and dark, no script
//   POST widgets/scaffold               starter files, from a view's schema when `view` is given
//
// Every route needs the Library feature and, with `project`, read access to
// it, like search. Bodies hold files under publish's limits.
// See `.ravi/specs/console/library`.

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { CliApiError, cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { basesCliError, describeViewForCaller, type BasesCaller } from "@/server/console/bases";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import type { LibraryResult, LibraryRouteRequest } from "@/server/console/library/cli";
import { isLibrarySlug, isSafeLibraryPath, LIBRARY_LIMITS, type LibraryFileInput } from "@/server/console/library/files";
import { assertSlugAllowed, KIND_FILE_RULES, kindFromSegment, type CompiledLibraryKind } from "@/server/console/library/kinds";
import { parseBody } from "@/server/console/library/proposals";
import {
  assertLibraryFeature,
  findProject,
  notFound,
  showLibraryItem,
  summarizeProject,
  type LibraryActor,
  type LibraryWorkspace,
  type ProjectSummary,
} from "@/server/console/library/service";
import { db, schema } from "@/server/db";
import type { BaseViewDescribeResponse } from "@/shared/bases/types";
import { BASE_UUID_PATTERN } from "@/shared/bases/values";
import { renderPreviewDocument } from "@/shared/widgets/render/document";
import { exampleFromTypes, normalizeStaticRecords, staticRecordList } from "@/shared/widgets/render/static";
import { compileWidget, WIDGET_EXAMPLE_FILE } from "@/shared/widgets/template/compile";
import { compileTheme } from "@/shared/widgets/theme/compile";
import { DEFAULT_THEME_FILES, defaultCompiledTheme } from "@/shared/widgets/theme/default";
import { hasErrors, type CompiledTheme, type Diagnostic, type LibraryFileText } from "@/shared/widgets/types";

import { effectiveCompiledTheme } from "./live-theme";
import { scaffoldWidgetFiles, type ScaffoldView } from "./scaffold";
import { widgetCatalog } from "./widget-catalog";

/** Theme refs `widgets/preview` reads as the built-in default theme. */
export const PREVIEW_DEFAULT_THEME_REFS: ReadonlySet<string> = new Set(["default", "none"]);

const projectRefSchema = z.string().trim().min(1).max(200);
const fileListSchema = z
  .array(z.object({ path: z.string().max(LIBRARY_LIMITS.maxPathLength), content: z.string() }).strict())
  .max(LIBRARY_LIMITS.maxFiles);

const checkBodySchema = z.object({ files: fileListSchema }).strict();

const previewBodySchema = z
  .object({
    files: fileListSchema,
    theme: z.string().trim().min(1).max(200).nullable().optional(),
    data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
    project: projectRefSchema.optional(),
  })
  .strict();

const scaffoldBodySchema = z
  .object({
    slug: z.string().max(200),
    view: z.string().trim().regex(BASE_UUID_PATTERN).optional(),
    project: projectRefSchema.optional(),
  })
  .strict();

/** The tools for `themes/<tool>` and `widgets/<tool>`; null passes any other request on to the generic routes. */
export async function routeWidgetsToolsRequest(request: LibraryRouteRequest): Promise<LibraryResult | null> {
  const method = request.method.toUpperCase();
  const [kindSegment, tool, ...tail] = request.segments;
  const kind = kindFromSegment(kindSegment);
  if (tail.length > 0 || (kind !== "theme" && kind !== "widget")) return null;
  const handler = (kind === "theme" ? THEME_TOOLS : WIDGET_TOOLS).get(tool ?? "");
  if (!handler) return null;
  if (handler.method !== method) throw cliApiError(404, "NOT_FOUND", "Unknown library route.");
  await assertLibraryFeature(request.workspace);
  return { status: 200, payload: await handler.run(request) };
}

type Tool = { method: "GET" | "POST"; run: (request: LibraryRouteRequest) => Promise<unknown> };

// Keyed by the reserved route words (`RESERVED_KIND_ROUTE_SLUGS`), so no item slug is shadowed.
const THEME_TOOLS: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  ["default", { method: "GET", run: async () => ({ files: DEFAULT_THEME_FILES.map((file) => ({ path: file.path, content: file.content })) }) }],
  ["check", { method: "POST", run: async (request) => checkTheme(request.body) }],
]);

const WIDGET_TOOLS: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  [
    "catalog",
    {
      method: "GET",
      run: async (request) => {
        const project = await readableProject(request.workspace, optionalParam(request.searchParams, "project"));
        return widgetCatalog({ workspace: request.workspace, project });
      },
    },
  ],
  ["check", { method: "POST", run: async (request) => checkWidget(request.body) }],
  ["preview", { method: "POST", run: async (request) => previewWidget(request.workspace, request.body) }],
  ["scaffold", { method: "POST", run: async (request) => scaffoldWidget(request.workspace, request.actor, request.body) }],
]);

// ---------------------------------------------------------------------------
// Themes

/** `POST themes/check`: diagnostics, the contrast report and the CSS (of the draft when there are errors). */
export function checkTheme(body: unknown) {
  const parsed = parseBody(checkBodySchema, body, "theme check");
  const { files, diagnostics: fileDiagnostics } = toolFiles("theme", parsed.files);
  const result = compileTheme(files);
  const diagnostics = [...fileDiagnostics, ...result.diagnostics];
  const shown = result.theme ?? result.draft;
  return { ok: !hasErrors(diagnostics), diagnostics, contrast: shown?.contrast ?? null, css: shown?.css ?? null };
}

// ---------------------------------------------------------------------------
// Widgets

/** `POST widgets/check`: diagnostics and the compiled widget (null when anything is an error). */
export function checkWidget(body: unknown) {
  const parsed = parseBody(checkBodySchema, body, "widget check");
  const { widget, diagnostics } = compileToolWidget(parsed.files);
  const ok = !hasErrors(diagnostics);
  return { ok, diagnostics, compiled: ok ? widget : null };
}

/**
 * `POST widgets/preview`: the widget rendered with `data` (one record or
 * `{ records }`), else `example.json`, else values invented from its types,
 * in `theme` (a ref; `default` or `none` for the built-in theme), else the
 * effective theme of `project` (or the org's), else the built-in theme.
 * `html` is null when the widget does not compile.
 */
export async function previewWidget(workspace: LibraryWorkspace, body: unknown) {
  const parsed = parseBody(previewBodySchema, body, "widget preview");
  const project = await readableProject(workspace, parsed.project ?? null);
  const compiled = compileToolWidget(parsed.files, { validateExample: parsed.data === undefined });
  const diagnostics = [...compiled.diagnostics];
  const { widget } = compiled;
  if (!widget) return { html: null, diagnostics };

  const theme = await previewTheme(workspace, parsed.theme ?? null, project);
  diagnostics.push(...theme.diagnostics);
  let records: unknown[];
  if (parsed.data !== undefined) {
    records = staticRecordList(parsed.data);
  } else if (compiled.example.length > 0) {
    records = compiled.example;
  } else {
    records = [exampleFromTypes(widget.fields, { locale: theme.theme.locale })];
  }
  const normalized = normalizeStaticRecords(widget.fields, records);
  // example.json was checked by compileToolWidget; `data` is checked here.
  if (parsed.data !== undefined) diagnostics.push(...normalized.diagnostics.map((diagnostic) => ({ ...diagnostic, file: "data" })));
  const html = renderPreviewDocument({
    widget,
    theme: theme.theme,
    records: normalized.records,
    columns: normalized.columns,
    users: normalized.users,
    title: widget.name,
    locale: theme.theme.locale,
  });
  return { html, diagnostics };
}

/**
 * `POST widgets/scaffold`: `widget.html`, `widget.json` and `example.json`
 * for `slug`. With `view`, the view is described as the caller through the
 * Bases service (schema only, never rows); the text follows the effective
 * theme's locale.
 */
export async function scaffoldWidget(workspace: LibraryWorkspace, actor: LibraryActor, body: unknown) {
  const parsed = parseBody(scaffoldBodySchema, body, "widget scaffold");
  if (!isLibrarySlug(parsed.slug)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A slug is 1-64 characters of a-z, 0-9 and -, starting and ending with a letter or digit.");
  }
  assertSlugAllowed("widget", parsed.slug);
  const project = await readableProject(workspace, parsed.project ?? null);
  let view: ScaffoldView | null = null;
  let themeProjectId = project?.id ?? null;
  if (parsed.view) {
    const described = await describeViewAsCaller({ workspace, actor, viewId: parsed.view, project });
    view = { name: described.view.name, columns: described.view.columns };
    themeProjectId = described.projectId;
  }
  const theme = await effectiveCompiledTheme({ organizationId: workspace.organization.id, projectId: themeProjectId });
  return scaffoldWidgetFiles({ slug: parsed.slug, view, locale: theme?.theme?.locale ?? null });
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Files of a check or preview body, under publish's path and size limits
 * (a violation is `400 PAYLOAD_INVALID`, as on publish). A file the kind does
 * not hold is an error diagnostic and is not compiled, so `ok` predicts
 * whether publish accepts the files.
 */
export function toolFiles(kind: CompiledLibraryKind, input: readonly LibraryFileInput[]): { files: LibraryFileText[]; diagnostics: Diagnostic[] } {
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of input) {
    if (!isSafeLibraryPath(file.path)) throw invalid(`Invalid file path: ${JSON.stringify(file.path.slice(0, 80))}.`);
    if (seen.has(file.path)) throw invalid(`Duplicate file path: ${file.path}.`);
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > LIBRARY_LIMITS.maxFileBytes) throw invalid(`${file.path} is larger than ${LIBRARY_LIMITS.maxFileBytes / 1024} KiB.`);
    totalBytes += bytes;
  }
  if (totalBytes > LIBRARY_LIMITS.maxVersionBytes) throw invalid(`A version is at most ${LIBRARY_LIMITS.maxVersionBytes / 1024 / 1024} MiB.`);

  const rules = KIND_FILE_RULES[kind];
  const files: LibraryFileText[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const file of input) {
    if (rules.allowed.has(file.path)) {
      files.push({ path: file.path, content: file.content });
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "LIBRARY_FILE_NOT_ALLOWED",
      message: `A ${kind} holds only ${[...rules.allowed].join(", ")}; remove ${file.path}.`,
      file: file.path,
    });
  }
  return { files, diagnostics };
}

/**
 * Compiles a widget for check and preview: file-rule diagnostics, the
 * compiler's, and the example.json values checked against the fields (wrong
 * types are errors here; publish only compiles).
 */
function compileToolWidget(input: readonly LibraryFileInput[], options: { validateExample?: boolean } = {}) {
  const { files, diagnostics: fileDiagnostics } = toolFiles("widget", input);
  const result = compileWidget(files);
  const diagnostics: Diagnostic[] = [...fileDiagnostics, ...result.diagnostics];
  if (result.manifest && result.example.length > 0 && options.validateExample !== false) {
    const example = normalizeStaticRecords(result.manifest.fields, result.example);
    diagnostics.push(...example.diagnostics.map((diagnostic) => ({ ...diagnostic, file: WIDGET_EXAMPLE_FILE })));
  }
  return { widget: result.widget, example: result.example, diagnostics };
}

const THEME_REF_PATTERN = /^(?:([^/]+)\/)?([^/]+)$/;

/** The theme a preview renders with, and warnings when it falls back to the built-in one. */
async function previewTheme(
  workspace: LibraryWorkspace,
  ref: string | null,
  project: ProjectSummary | null,
): Promise<{ theme: CompiledTheme; diagnostics: Diagnostic[] }> {
  const fallback = (code: string, message: string) => ({
    theme: defaultCompiledTheme(),
    diagnostics: [{ severity: "warning" as const, code, message }],
  });
  if (ref !== null && PREVIEW_DEFAULT_THEME_REFS.has(ref)) return { theme: defaultCompiledTheme(), diagnostics: [] };
  if (ref !== null) {
    const match = THEME_REF_PATTERN.exec(ref);
    if (!match) throw notFound("Theme not found.");
    const shown = await showLibraryItem({
      workspace,
      kind: "theme",
      scopeRef: match[1] ?? null,
      slug: match[2] ?? "",
      projectRef: project?.slug ?? null,
    });
    const theme = compileTheme(shown.version.files.map((file) => ({ path: file.path, content: file.content }))).theme;
    if (!theme) return fallback("PREVIEW_THEME_INVALID", `${shown.item.ref} version ${shown.version.number} no longer compiles; the preview uses the default theme.`);
    return { theme, diagnostics: [] };
  }
  const effective = await effectiveCompiledTheme({ organizationId: workspace.organization.id, projectId: project?.id ?? null });
  if (!effective) return { theme: defaultCompiledTheme(), diagnostics: [] };
  if (!effective.theme) {
    return fallback(
      "PREVIEW_THEME_INVALID",
      `${effective.effective.ref} version ${effective.effective.versionNumber} no longer compiles; the preview uses the default theme.`,
    );
  }
  return { theme: effective.theme, diagnostics: [] };
}

/**
 * The view's public shape as the caller sees it (`describe`, schema only): the
 * Bases feature, project read and the view's own admission all apply, and a
 * view the caller may not see is `404 NOT_FOUND`, like a missing one. With
 * `project`, the view is looked for there only, and the 404 names that
 * project and says `--project` picks another; when the caller can describe
 * the view in its own project, it names that one.
 */
async function describeViewAsCaller(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  viewId: string;
  project: ProjectSummary | null;
}): Promise<{ view: BaseViewDescribeResponse; projectId: string }> {
  const { workspace } = input;
  const organizationId = workspace.organization.id;
  const access = await getConsoleFeatureAccessForOrganizationRole({ organizationId, role: workspace.membership.role });
  const feature = access.byKey["console.bases"];
  if (!feature.available) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Bases are not available for this organization.", { error: "feature_unavailable" });
  }
  if (!feature.authorized) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Bases are not enabled for your role.", { error: "feature_forbidden" });
  }
  const viewId = input.viewId.toLowerCase();
  // Only to know where to look; describe checks the caller's access to that project and view.
  const [row] = await db
    .select({ projectId: schema.baseViews.projectId })
    .from(schema.baseViews)
    .where(and(eq(schema.baseViews.id, viewId), eq(schema.baseViews.organizationId, organizationId)))
    .limit(1);
  const caller = await basesCallerForLibrary(workspace, input.actor);
  const describe = async (projectId: string) => {
    try {
      return await describeViewForCaller(caller, { projectId, viewId });
    } catch (error) {
      if (error instanceof ConsoleApiError) throw basesCliError(error);
      throw error;
    }
  };
  const { project } = input;
  if (!project) {
    if (!row) throw notFound(`View ${viewId} was not found, or it does not admit you.`);
    return { view: await describe(row.projectId), projectId: row.projectId };
  }
  try {
    return { view: await describe(project.id), projectId: project.id };
  } catch (error) {
    if (!(error instanceof CliApiError) || error.code !== "NOT_FOUND") throw error;
    // Named only when the caller can describe it there too, so a hidden view still looks missing.
    let home: string | null = null;
    if (row && row.projectId !== project.id) {
      const [other] = await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, row.projectId)).limit(1);
      home = other && (await describe(row.projectId).then(() => true, () => false)) ? other.slug : null;
    }
    throw cliApiError(
      404,
      "NOT_FOUND",
      home
        ? `View ${viewId} is not in project "${project.slug}"; it is in project "${home}". Pass --project ${home}, or leave --project out.`
        : `View ${viewId} was not found in project "${project.slug}", or it does not admit you. --project picks another project; without it the view's own project is used.`,
      { project: project.slug, ...(home ? { viewProject: home } : {}) },
    );
  }
}

/** The Library caller as a Bases caller, with its primary email for view principals. */
async function basesCallerForLibrary(workspace: LibraryWorkspace, actor: LibraryActor): Promise<BasesCaller> {
  const [user] = await db
    .select({ primaryEmail: schema.users.primaryEmail })
    .from(schema.users)
    .where(eq(schema.users.id, workspace.user.id))
    .limit(1);
  const email = user?.primaryEmail?.trim().toLowerCase() || null;
  return {
    organizationId: workspace.organization.id,
    user: { id: workspace.user.id, email },
    orgRole: workspace.membership.role,
    actorType: actor.surface === "cli" ? "cli" : "user",
    actorId: workspace.user.id,
    surface: actor.surface,
    requestId: actor.requestId,
    source: actor.localInstallationId ? { kind: "local_installation", id: actor.localInstallationId } : { kind: "user", id: workspace.user.id },
    pageSiteId: null,
    localInstallationId: actor.localInstallationId,
    clientHint: null,
  };
}

/** `project` resolved with read access, like search (`403 PROJECT_ACCESS_DENIED` otherwise). */
async function readableProject(workspace: LibraryWorkspace, projectRef: string | null): Promise<ProjectSummary | null> {
  if (!projectRef) return null;
  const project = await findProject(workspace, projectRef, "read");
  if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return summarizeProject(project);
}

function optionalParam(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function invalid(message: string) {
  return cliApiError(400, "PAYLOAD_INVALID", message);
}

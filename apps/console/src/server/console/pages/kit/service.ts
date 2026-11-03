// `POST /api/cli/pages/kit`: request checks, the caller's authority (the same
// as publishing to the project), and the database lookups the page kit core
// (`build.ts`) runs on: the Library theme and widgets in the page project's
// view, views described as the CLI user, and the presentation stored on the
// route's active release. Charts are checked by reading their data as the
// CLI user.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { CliApiError, cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { chartDataForCaller, describeViewForCaller, type BasesCaller } from "@/server/console/bases";
import { isLibrarySlug } from "@/server/console/library/files";
import { orgPath, orgSegment } from "@/lib/console-paths";
import { libraryItemPath } from "@/server/console/library/proposals";
import { resolveEffectiveTheme } from "@/server/console/library/themes";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";
import { readScriptAudit } from "@/shared/widgets/script/audit";
import type { LibraryFileText } from "@/shared/widgets/types";

import { validateManifestFilePath, validateRoutePath } from "../policy";
import { buildPageKit, PAGE_KIT_THEME_NONE, type KitLibrarySource, type KitLookup, type PageKitDeps, type PageKitResult } from "./build";
import { storedPagePresentation } from "./presentation";

/** Below the 4.5 MB request body the Console's host accepts; `ravi pages ship` checks the same cap before sending. */
export const PAGE_KIT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const PAGE_KIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PAGE_KIT_MAX_FILES = 1000;
/** Same as `ravi pages ship` publishing: a CLI session that may link projects and publish artifacts. */
export const PAGE_KIT_CLI_SCOPES = ["console.projects.link", "artifacts.publish"] as const;
const HTML_PATH = /\.html?$/i;
const LIBRARY_REF = /^(?:([^/]+)\/)?([^/]+)$/;

export type PageKitCliContext = {
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
  scopes: readonly string[];
  /** Bases caller for the same CLI session (`basesCallerFromCliAuth`). */
  bases: BasesCaller;
};

const requestSchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    site: z.string().trim().min(1).max(200),
    route: z.string().min(1).max(1024),
    visibility: z.enum(["public", "private", "protected_link", "password"]),
    theme: z.string().trim().min(1).max(401).nullable().optional(),
    files: z
      .array(z.object({ path: z.string().min(1).max(512), html: z.string() }).strict())
      .min(1)
      .max(PAGE_KIT_MAX_FILES),
  })
  .strict();

/** Runs the page kit for a CLI session. Errors in the page are diagnostics in the result, not throws. */
export async function runPageKitForCli(input: {
  context: PageKitCliContext;
  body: unknown;
  /** The Console's origin, for the audit links of widgets with code. */
  origin?: string;
}): Promise<PageKitResult> {
  const { context } = input;
  if (!PAGE_KIT_CLI_SCOPES.every((scope) => context.scopes.includes(scope))) {
    throw cliApiError(403, "PUBLISH_NOT_ALLOWED", "This CLI session cannot publish Ravi Pages, so it cannot run the page kit.");
  }
  return runPageKitAs({ context, body: input.body, origin: input.origin });
}

/**
 * The page kit as one person who may publish to the project, without a CLI
 * session: `ravi pages ship` through `runPageKitForCli`, and the MCP
 * `ravi.pages.ship` operation directly.
 */
export async function runPageKitAs(input: {
  context: Omit<PageKitCliContext, "scopes">;
  body: unknown;
  origin?: string;
}): Promise<PageKitResult> {
  const { context } = input;
  const request = parseRequest(input.body);

  const workspace = { authorization: context.bases.authorization, user: context.user, organization: context.organization, membership: context.membership };
  const project = await findAccessibleProjectRecord(workspace, request.project, "write");
  if (!project || project.status === "deleted") {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "This CLI session cannot publish to this project.");
  }
  const site = await findProjectSite(context.organization.id, project.id, request.site);
  if (!site) {
    throw cliApiError(404, "NOT_FOUND", `Project ${project.slug} has no active Pages host ${request.site}.`);
  }

  const scope: KitScope = { organizationId: context.organization.id, org: orgSegment(context.organization), project: { id: project.id, slug: project.slug }, origin: input.origin ?? null };
  const deps: PageKitDeps = {
    resolveTheme: async (ref) => {
      if (ref === null) {
        const effective = await resolveEffectiveTheme({ organizationId: scope.organizationId, projectId: project.id });
        return {
          ok: true,
          source: effective
            ? { itemId: effective.item.id, ref: effective.ref, version: effective.versionNumber, files: effective.files }
            : null,
        };
      }
      return findLibrarySource(scope, "theme", ref);
    },
    resolveWidget: (ref) => findLibrarySource(scope, "widget", ref),
    resolveWidgetItem: (itemId) => findLibrarySourceById(scope, "widget", itemId),
    describeView: async (viewId) => {
      try {
        return { ok: true, view: await describeViewForCaller(context.bases, { projectId: project.id, viewId }) };
      } catch (error) {
        const message = unavailableViewMessage(error);
        if (message === null) throw error;
        return { ok: false, message };
      }
    },
    // Chart data, not a lighter read: it checks the chart, its view and the caller's admission exactly as the page will.
    describeChart: async (chartId) => {
      try {
        const { chart } = await chartDataForCaller(context.bases, { projectId: project.id, chartId });
        return { ok: true, chart: { name: chart.name, viewId: chart.viewId } };
      } catch (error) {
        const message = unavailableViewMessage(error);
        if (message === null) throw error;
        return { ok: false, message };
      }
    },
    previousPresentation: () => loadRoutePresentation(site, request.route),
  };
  return buildPageKit(request, deps);
}

/**
 * A result with error diagnostics as `422 KIT_INVALID`, the diagnostics (with
 * page path, line and column) and warnings in `error.details`; the OSS exits
 * 2 on it. Null when nothing is an error.
 */
export function pageKitInvalidError(result: Pick<PageKitResult, "diagnostics" | "warnings">): CliApiError | null {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  if (errors === 0) return null;
  return cliApiError(422, "KIT_INVALID", `The page kit found ${errors} error${errors === 1 ? "" : "s"}; fix them and ship again.`, {
    diagnostics: result.diagnostics,
    warnings: result.warnings,
  });
}

function parseRequest(body: unknown) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.map(String).join(".") : "body";
    throw cliApiError(400, "PAYLOAD_INVALID", `Page kit request: ${where}: ${issue?.message ?? "invalid"}.`);
  }
  const data = parsed.data;
  const route = validateRoutePath(data.route);
  if (!route.ok) throw cliApiError(400, "PAYLOAD_INVALID", `Page kit request: route "${data.route}" is not a Pages route path.`);

  const seen = new Set<string>();
  const files = data.files.map((file) => {
    const path = validateManifestFilePath(file.path);
    if (!path.ok || !HTML_PATH.test(path.path)) {
      throw cliApiError(400, "PAYLOAD_INVALID", `Page kit request: ${file.path} is not a publishable .html or .htm path.`);
    }
    if (seen.has(path.path)) throw cliApiError(400, "PAYLOAD_INVALID", `Page kit request: ${path.path} is sent twice.`);
    seen.add(path.path);
    if (Buffer.byteLength(file.html, "utf8") > PAGE_KIT_MAX_FILE_BYTES) {
      throw cliApiError(413, "PAYLOAD_INVALID", `Page kit request: ${path.path} is larger than 2 MiB.`);
    }
    return { path: path.path, html: file.html };
  });

  const theme = data.theme ?? null;
  return {
    project: data.project,
    site: data.site,
    route: route.path,
    visibility: data.visibility,
    theme: theme !== null && theme.toLowerCase() === PAGE_KIT_THEME_NONE ? PAGE_KIT_THEME_NONE : theme,
    files,
  };
}

async function findProjectSite(organizationId: string, projectId: string, siteRef: string) {
  const sites = schema.pageSites;
  const ref = isUuidRef(siteRef) ? or(eq(sites.id, siteRef), eq(sites.slug, siteRef)) : eq(sites.slug, siteRef);
  const [site] = await db
    .select({ id: sites.id, activeReleaseId: sites.activeReleaseId })
    .from(sites)
    .where(and(eq(sites.organizationId, organizationId), eq(sites.projectId, projectId), eq(sites.status, "active"), ref))
    .limit(1);
  return site ?? null;
}

/** The presentation on the route's current active release, if it has one. */
async function loadRoutePresentation(site: { id: string; activeReleaseId: string | null }, route: string) {
  if (!site.activeReleaseId) return null;
  const routes = schema.pageReleaseRoutes;
  const [row] = await db
    .select({ metadataJson: schema.artifactVersions.metadataJson })
    .from(routes)
    .innerJoin(schema.artifactVersions, eq(schema.artifactVersions.id, routes.artifactVersionId))
    .where(and(eq(routes.releaseId, site.activeReleaseId), eq(routes.siteId, site.id), eq(routes.path, route)))
    .orderBy(asc(routes.priority))
    .limit(1);
  return row ? storedPagePresentation(row.metadataJson) : null;
}

// ---------------------------------------------------------------------------
// Library lookups (org items and the page project's)

type KitScope = { organizationId: string; org?: string; project: { id: string; slug: string }; origin?: string | null };
type LibraryKitKind = "theme" | "widget";

/**
 * `slug` (the project's item, else the org's), `org/<slug>`, or
 * `<project>/<slug>` for the page's own project, at the item's current
 * published version.
 */
export async function findLibrarySource(scope: KitScope, kind: LibraryKitKind, ref: string): Promise<KitLookup> {
  const code = kind === "theme" ? "KIT_THEME" : "KIT_WIDGET";
  const match = LIBRARY_REF.exec(ref.trim());
  const scopeRef = match?.[1] ?? null;
  const slug = match?.[2] ?? "";
  if (!match || !isLibrarySlug(slug)) {
    return { ok: false, code: `${code}_NOT_FOUND`, message: `${capitalized(kind)} "${ref}" is not a ref; write <slug>, org/<slug> or ${scope.project.slug}/<slug>.` };
  }
  const items = schema.libraryItems;
  let where;
  if (scopeRef === null) where = or(isNull(items.projectId), eq(items.projectId, scope.project.id));
  else if (scopeRef === "org") where = isNull(items.projectId);
  else if (scopeRef === scope.project.slug || scopeRef.toLowerCase() === scope.project.id) where = eq(items.projectId, scope.project.id);
  else {
    return {
      ok: false,
      code: `${code}_OUT_OF_SCOPE`,
      message: `${capitalized(kind)} ${ref} belongs to another project; a page in ${scope.project.slug} uses org ${kind}s or its own project's.`,
    };
  }
  const rows = await selectLibraryItems(and(eq(items.organizationId, scope.organizationId), eq(items.kind, kind), eq(items.slug, slug), where));
  // The project's item first: slugs are unique across both, so this only orders a repaired collision.
  const row = rows.sort((left, right) => Number(left.projectId === null) - Number(right.projectId === null))[0];
  if (!row) {
    return { ok: false, code: `${code}_NOT_FOUND`, message: `${capitalized(kind)} ${ref} does not exist in the Library for project ${scope.project.slug}.` };
  }
  return sourceFor(scope, row, kind, code);
}

/** The item a view's `layout.widget` names, when it is still an org or page-project widget with a published version. */
async function findLibrarySourceById(scope: KitScope, kind: LibraryKitKind, itemId: string): Promise<KitLookup> {
  const code = kind === "theme" ? "KIT_THEME" : "KIT_WIDGET";
  if (!isUuidRef(itemId)) return { ok: false, code: `${code}_NOT_FOUND`, message: "the item no longer exists" };
  const items = schema.libraryItems;
  const [row] = await selectLibraryItems(and(eq(items.organizationId, scope.organizationId), eq(items.id, itemId.toLowerCase())));
  if (!row || row.kind !== kind) return { ok: false, code: `${code}_NOT_FOUND`, message: "the item no longer exists" };
  if (row.projectId !== null && row.projectId !== scope.project.id) {
    return { ok: false, code: `${code}_OUT_OF_SCOPE`, message: "it belongs to another project" };
  }
  return sourceFor(scope, row, kind, code);
}

type LibraryItemRow = Awaited<ReturnType<typeof selectLibraryItems>>[number];

function selectLibraryItems(where: ReturnType<typeof and>) {
  const items = schema.libraryItems;
  return db
    .select({
      id: items.id,
      kind: items.kind,
      slug: items.slug,
      projectId: items.projectId,
      projectSlug: schema.projects.slug,
      archivedAt: items.archivedAt,
      currentVersionId: items.currentVersionId,
      currentVersionNumber: items.currentVersionNumber,
      scriptAudit: schema.libraryVersions.scriptAudit,
    })
    .from(items)
    .leftJoin(schema.projects, eq(schema.projects.id, items.projectId))
    .leftJoin(schema.libraryVersions, eq(schema.libraryVersions.id, items.currentVersionId))
    .where(where)
    .limit(2);
}

async function sourceFor(scope: KitScope, row: LibraryItemRow, kind: LibraryKitKind, code: string): Promise<KitLookup> {
  const ref = `${row.projectId ? (row.projectSlug ?? row.projectId) : "org"}/${row.slug}`;
  if (row.archivedAt || !row.currentVersionId || !row.currentVersionNumber) {
    return { ok: false, code: `${code}_UNPUBLISHED`, message: `${capitalized(kind)} ${ref} is archived or has no published version.` };
  }
  const files: LibraryFileText[] = await db
    .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, row.currentVersionId))
    .orderBy(asc(schema.libraryFiles.path));
  const source: KitLibrarySource = { itemId: row.id, ref, version: row.currentVersionNumber, files };
  if (kind === "widget") {
    source.scriptAudit = readScriptAudit(row.scriptAudit);
    const project = row.projectId ? { id: row.projectId, slug: row.projectSlug ?? row.projectId } : null;
    source.auditUrl = scope.origin && scope.org ? `${scope.origin}${orgPath(scope.org, libraryItemPath(project, row.slug, "widget"))}` : null;
  }
  return { ok: true, source };
}

function capitalized(kind: LibraryKitKind) {
  return kind === "theme" ? "Theme" : "Widget";
}

/** Why the caller cannot describe a view, or null when the error is not about access (it is rethrown). */
function unavailableViewMessage(error: unknown): string | null {
  const status = error instanceof ConsoleApiError || error instanceof CliApiError ? error.status : null;
  if (status === null || status >= 500) return null;
  if (status === 404) return "not found in this project, or the view does not admit you";
  if (status === 403) return "Bases access is denied to you";
  if (status === 409) return "the view or its base is archived or invalid";
  return `Bases answered ${status}`;
}

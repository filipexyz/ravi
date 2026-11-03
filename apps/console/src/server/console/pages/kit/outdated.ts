// `GET /api/cli/pages/outdated?project=`: the project's active routes whose
// shipped presentation is behind: the theme (by how the ship chose it, see
// `outdatedTheme`), a widget with a newer published version, or a runtime
// older than the one ship inlines now. Routes shipped before the page kit
// have no presentation and are not listed.

import { and, asc, eq, inArray } from "drizzle-orm";

import { cliApiError } from "@/server/cli/errors";
import { resolveEffectiveTheme } from "@/server/console/library/themes";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { compileTheme } from "@/shared/widgets/theme/compile";
import type { PagePresentation } from "@/shared/widgets/types";

import { storedPagePresentation } from "./presentation";
import { PAGES_RUNTIME_VERSION } from "./runtime.generated";

export const PAGES_OUTDATED_CLI_SCOPE = "console.projects.read";

export type OutdatedTheme = { itemId: string; ref: string; version: number; hash: string };

export type OutdatedPageRoute = {
  siteSlug: string;
  hostname: string;
  route: string;
  releaseId: string;
  publishedAt: string | null;
  /**
   * Null unless the theme is behind. `pinned` is null when the route shipped
   * no Library theme; `current` is null when no theme applies any more.
   */
  theme: { pinned: OutdatedTheme | null; current: OutdatedTheme | null } | null;
  /** Only the widgets with a newer published version. */
  widgets: Array<{ ref: string; pinned: number; current: number }>;
  /** Null when the route was shipped without the runtime. */
  runtime: { pinned: string; current: string } | null;
};

export async function listOutdatedPages(input: {
  workspace: ProjectAccessWorkspace;
  projectRef: string;
  runtimeVersion?: string;
}): Promise<{ items: OutdatedPageRoute[] }> {
  const project = await findAccessibleProjectRecord(input.workspace, input.projectRef, "read");
  if (!project || project.status === "deleted") {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "This CLI session cannot read this project's Ravi Pages.");
  }
  const runtimeVersion = input.runtimeVersion ?? PAGES_RUNTIME_VERSION;
  const organizationId = input.workspace.organization.id;

  const sites = schema.pageSites;
  const releaseRoutes = schema.pageReleaseRoutes;
  const rows = await db
    .select({
      siteSlug: sites.slug,
      hostname: sites.defaultHostname,
      route: releaseRoutes.path,
      releaseId: schema.pageSiteReleases.id,
      activatedAt: schema.pageSiteReleases.activatedAt,
      metadataJson: schema.artifactVersions.metadataJson,
    })
    .from(sites)
    .innerJoin(schema.pageSiteReleases, eq(schema.pageSiteReleases.id, sites.activeReleaseId))
    .innerJoin(releaseRoutes, eq(releaseRoutes.releaseId, schema.pageSiteReleases.id))
    .innerJoin(schema.pageRoutes, eq(schema.pageRoutes.id, releaseRoutes.routeId))
    .innerJoin(schema.artifactVersions, eq(schema.artifactVersions.id, releaseRoutes.artifactVersionId))
    .where(
      and(
        eq(sites.organizationId, organizationId),
        eq(sites.projectId, project.id),
        eq(sites.status, "active"),
        eq(schema.pageSiteReleases.status, "active"),
        eq(schema.pageRoutes.status, "active"),
      ),
    )
    .orderBy(asc(sites.defaultHostname), asc(releaseRoutes.path));

  const shipped = rows.flatMap((row) => {
    const presentation = storedPagePresentation(row.metadataJson);
    return presentation ? [{ ...row, presentation }] : [];
  });
  if (!shipped.length) return { items: [] };

  const effectiveTheme = await effectiveThemeNow(organizationId, project.id);
  const explicitThemes = await currentThemeVersions(
    organizationId,
    shipped.flatMap(({ presentation }) => (presentation.themeSource === "explicit" && presentation.theme ? [presentation.theme] : [])),
  );
  const widgetVersions = await currentWidgetVersions(
    organizationId,
    shipped.flatMap((row) => row.presentation.widgets.map((widget) => widget.itemId)),
  );

  const items: OutdatedPageRoute[] = [];
  for (const row of shipped) {
    const { presentation } = row;
    const theme = outdatedTheme(presentation, { effective: effectiveTheme, explicit: explicitThemes });
    const widgets = presentation.widgets.flatMap((widget) => {
      const current = widgetVersions.get(widget.itemId);
      return current && current.version > widget.version ? [{ ref: current.ref, pinned: widget.version, current: current.version }] : [];
    });
    const runtime = presentation.runtime ? { pinned: presentation.runtime.version, current: runtimeVersion } : null;
    const runtimeBehind = runtime !== null && compareVersions(runtime.pinned, runtime.current) < 0;
    if (!theme && !widgets.length && !runtimeBehind) continue;
    items.push({
      siteSlug: row.siteSlug,
      hostname: row.hostname,
      route: row.route,
      releaseId: row.releaseId,
      publishedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
      theme,
      widgets,
      runtime,
    });
  }
  return { items };
}

/**
 * The route's theme drift, by how its ship chose the theme:
 * - `effective` (and presentations stored before `themeSource`): behind when
 *   the effective theme's hash differs from the pinned one, including a theme
 *   set after a ship that had none (`pinned: null`) and a pointer cleared
 *   since (`current: null`);
 * - `explicit`: behind when that same item has a newer published version
 *   whose compiled hash differs;
 * - `none`: never.
 */
export function outdatedTheme(
  presentation: Pick<PagePresentation, "theme" | "themeSource">,
  current: { effective: OutdatedTheme | null; explicit: ReadonlyMap<string, OutdatedTheme> },
): OutdatedPageRoute["theme"] {
  const pinned = presentation.theme;
  switch (presentation.themeSource ?? "effective") {
    case "none":
      return null;
    case "explicit": {
      const latest = pinned ? current.explicit.get(pinned.itemId.toLowerCase()) : undefined;
      return pinned && latest && latest.version > pinned.version && latest.hash !== pinned.hash ? { pinned, current: latest } : null;
    }
    case "effective":
      return (pinned?.hash ?? null) !== (current.effective?.hash ?? null) ? { pinned, current: current.effective } : null;
  }
}

async function effectiveThemeNow(organizationId: string, projectId: string): Promise<OutdatedTheme | null> {
  const effective = await resolveEffectiveTheme({ organizationId, projectId });
  if (!effective) return null;
  const compiled = compileTheme(effective.files).theme;
  if (!compiled) return null;
  return { itemId: effective.item.id, ref: effective.ref, version: effective.versionNumber, hash: compiled.hash };
}

/**
 * Current published version of each theme item a route pinned with an
 * explicit ref, compiled for its hash, by lowercased item id. Only items whose
 * current version is newer than one a route pinned are compiled.
 */
async function currentThemeVersions(organizationId: string, pinned: ReadonlyArray<{ itemId: string; version: number }>) {
  const oldest = new Map<string, number>();
  for (const theme of pinned) {
    const id = theme.itemId.toLowerCase();
    oldest.set(id, Math.min(theme.version, oldest.get(id) ?? theme.version));
  }
  const out = new Map<string, OutdatedTheme>();
  if (!oldest.size) return out;
  const items = schema.libraryItems;
  const rows = await db
    .select({
      id: items.id,
      slug: items.slug,
      projectId: items.projectId,
      projectSlug: schema.projects.slug,
      archivedAt: items.archivedAt,
      versionId: items.currentVersionId,
      version: items.currentVersionNumber,
    })
    .from(items)
    .leftJoin(schema.projects, eq(schema.projects.id, items.projectId))
    .where(and(eq(items.organizationId, organizationId), eq(items.kind, "theme"), inArray(items.id, [...oldest.keys()])));
  for (const row of rows) {
    if (row.archivedAt || !row.versionId || !row.version || row.version <= (oldest.get(row.id) ?? row.version)) continue;
    const files = await db
      .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
      .from(schema.libraryFiles)
      .where(eq(schema.libraryFiles.versionId, row.versionId))
      .orderBy(asc(schema.libraryFiles.path));
    const compiled = compileTheme(files).theme;
    if (!compiled) continue;
    out.set(row.id, { itemId: row.id, ref: `${row.projectId ? (row.projectSlug ?? row.projectId) : "org"}/${row.slug}`, version: row.version, hash: compiled.hash });
  }
  return out;
}

/** Current published version and ref of each widget item that is not archived. */
async function currentWidgetVersions(organizationId: string, itemIds: string[]) {
  const ids = [...new Set(itemIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, { ref: string; version: number }>();
  if (!ids.length) return out;
  const items = schema.libraryItems;
  const rows = await db
    .select({
      id: items.id,
      slug: items.slug,
      projectId: items.projectId,
      projectSlug: schema.projects.slug,
      archivedAt: items.archivedAt,
      version: items.currentVersionNumber,
    })
    .from(items)
    .leftJoin(schema.projects, eq(schema.projects.id, items.projectId))
    .where(and(eq(items.organizationId, organizationId), eq(items.kind, "widget"), inArray(items.id, ids)));
  for (const row of rows) {
    if (row.archivedAt || !row.version) continue;
    out.set(row.id, { ref: `${row.projectId ? (row.projectSlug ?? row.projectId) : "org"}/${row.slug}`, version: row.version });
  }
  return out;
}

/** Numeric `major.minor.patch` order; anything else compares as equal unless the strings differ. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left === right ? 0 : left < right ? -1 : 1;
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

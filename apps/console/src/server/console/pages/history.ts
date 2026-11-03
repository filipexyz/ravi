import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { PageVisibility } from "../pages";
import { listActorUsers, releaseAuthor } from "./operator";

/** Releases one history read returns, newest first. The page's top bar lists the same 30. */
const HISTORY_LIMIT = 30;

export type PageHistoryRoute = {
  routeId: string;
  path: string;
  title: string;
  artifactVersionId: string;
  visibility: PageVisibility;
};

export type PageHistoryChange =
  | { kind: "added" | "updated" | "removed"; routeId: string; path: string; title: string }
  | { kind: "visibility"; routeId: string; path: string; title: string; from: PageVisibility; to: PageVisibility };

export type PageHistoryEntry = {
  id: string;
  number: number;
  /** The release visitors get now. A live release older than the newest one was restored. */
  live: boolean;
  createdAt: number;
  activatedAt: number | null;
  by: { name: string | null; via: "cli" | "console" | "system" };
  pageCount: number;
  changes: PageHistoryChange[];
};

export type PageHistory = {
  siteId: string;
  /** The number of the release visitors get now, to tell which entry is live when it isn't the newest. */
  liveReleaseNumber: number | null;
  entries: PageHistoryEntry[];
  /** How many of the host's newest releases were read; with `routeId`, the page's changes are searched there. */
  releasesSearched: number;
  /** The host has older releases than the ones read. */
  truncated: boolean;
};

/**
 * What one release changed against the release that was live when it was made
 * (`previousReleaseId`, the same baseline the top bar's compare uses): pages
 * added, given new content, removed, or set to another visibility. Without a
 * baseline (the host's first release) every page is new.
 */
export function releaseChanges(current: PageHistoryRoute[], previous: PageHistoryRoute[] | null): PageHistoryChange[] {
  const before = new Map((previous ?? []).map((route) => [route.routeId, route]));
  const after = new Map(current.map((route) => [route.routeId, route]));
  const changes: PageHistoryChange[] = [];
  for (const route of current) {
    const old = before.get(route.routeId);
    const page = { path: route.path, routeId: route.routeId, title: route.title };
    if (!old) {
      changes.push({ kind: "added", ...page });
      continue;
    }
    if (old.artifactVersionId !== route.artifactVersionId) changes.push({ kind: "updated", ...page });
    if (old.visibility !== route.visibility) {
      changes.push({ from: old.visibility, kind: "visibility", to: route.visibility, ...page });
    }
  }
  for (const old of previous ?? []) {
    if (!after.has(old.routeId)) changes.push({ kind: "removed", path: old.path, routeId: old.routeId, title: old.title });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

const querySchema = z.object({
  siteId: z.string().uuid(),
  routeId: z.string().uuid().optional(),
});

/**
 * The host's release history for the Console, newest first, each release with
 * what it changed and who published it. With `routeId`, only the releases that
 * changed that page. Read-only; restoring stays in the page's top bar.
 */
export async function listPageHistory({
  projectRef,
  query,
  workspace,
}: {
  projectRef: string;
  query: unknown;
  workspace: ProjectAccessWorkspace;
}): Promise<PageHistory> {
  const parsed = querySchema.safeParse(query ?? {});
  if (!parsed.success) throw new ConsoleApiError(400, { error: "validation_failed" });

  const project = await findAccessibleProjectRecord(workspace, projectRef, "read");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });

  const [site] = await db
    .select({ id: schema.pageSites.id, activeReleaseId: schema.pageSites.activeReleaseId })
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.id, parsed.data.siteId),
        eq(schema.pageSites.organizationId, workspace.organization.id),
        eq(schema.pageSites.projectId, project.id),
      ),
    )
    .limit(1);
  if (!site) throw new ConsoleApiError(404, { error: "site_not_found" });

  const newest = await db
    .select({ release: schema.pageSiteReleases })
    .from(schema.pageSiteReleases)
    .where(and(eq(schema.pageSiteReleases.siteId, site.id), isNotNull(schema.pageSiteReleases.activatedAt)))
    .orderBy(desc(schema.pageSiteReleases.releaseNumber))
    // One more than shown, to tell whether older releases exist.
    .limit(HISTORY_LIMIT + 1);
  const truncated = newest.length > HISTORY_LIMIT;
  const releases = newest.slice(0, HISTORY_LIMIT);
  const authors = await listActorUsers(releases.map((row) => row.release.createdByActorId));

  const releaseIds = releases.map((row) => row.release.id);
  const baselineIds = releases
    .map((row) => row.release.previousReleaseId)
    .filter((id): id is string => Boolean(id) && !releaseIds.includes(id as string));
  const routesByRelease = await listHistoryRoutes([...releaseIds, ...new Set(baselineIds)]);

  const entries = releases.map(({ release }) => {
    const author = release.createdByActorId ? authors.get(release.createdByActorId.toLowerCase()) : undefined;
    const routes = routesByRelease.get(release.id) ?? [];
    const baseline = release.previousReleaseId ? (routesByRelease.get(release.previousReleaseId) ?? []) : null;
    return {
      id: release.id,
      number: release.releaseNumber,
      live: release.id === site.activeReleaseId,
      createdAt: release.createdAt.getTime(),
      activatedAt: release.activatedAt ? release.activatedAt.getTime() : null,
      by: releaseAuthor(release.createdByActorType, author?.displayName, author?.email),
      pageCount: routes.length,
      changes: releaseChanges(routes, baseline),
    } satisfies PageHistoryEntry;
  });

  const routeId = parsed.data.routeId;
  const liveReleaseNumber = site.activeReleaseId
    ? (releases.find((row) => row.release.id === site.activeReleaseId)?.release.releaseNumber ??
      (await liveReleaseNumberFor(site.activeReleaseId)))
    : null;
  return {
    siteId: site.id,
    liveReleaseNumber,
    entries: routeId
      ? entries
          .map((entry) => ({ ...entry, changes: entry.changes.filter((change) => change.routeId === routeId) }))
          .filter((entry) => entry.changes.length > 0)
      : entries,
    releasesSearched: releases.length,
    truncated,
  };
}

async function liveReleaseNumberFor(releaseId: string) {
  const [row] = await db
    .select({ releaseNumber: schema.pageSiteReleases.releaseNumber })
    .from(schema.pageSiteReleases)
    .where(eq(schema.pageSiteReleases.id, releaseId))
    .limit(1);
  return row?.releaseNumber ?? null;
}

async function listHistoryRoutes(releaseIds: string[]) {
  const byRelease = new Map<string, PageHistoryRoute[]>();
  if (releaseIds.length === 0) return byRelease;
  const rows = await db
    .select({
      releaseId: schema.pageReleaseRoutes.releaseId,
      routeId: schema.pageReleaseRoutes.routeId,
      path: schema.pageReleaseRoutes.path,
      artifactVersionId: schema.pageReleaseRoutes.artifactVersionId,
      visibility: schema.pageReleaseRoutes.visibility,
      title: schema.artifacts.name,
    })
    .from(schema.pageReleaseRoutes)
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.pageReleaseRoutes.artifactId))
    .where(inArray(schema.pageReleaseRoutes.releaseId, releaseIds));
  for (const { releaseId, ...route } of rows) {
    const list = byRelease.get(releaseId) ?? [];
    list.push({ ...route, title: route.title?.trim() || route.path });
    byRelease.set(releaseId, list);
  }
  return byRelease;
}

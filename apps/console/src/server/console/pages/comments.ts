import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { matchPageRoute } from "@/server/console/pages/policy";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export type PageRouteCommentItem = {
  id: string;
  body: string;
  path: string;
  target: JsonRecord;
  parentId: string | null;
  createdAt: string;
  unread: boolean;
  author: {
    id: string | null;
    displayName: string | null;
  };
};

export type PageRouteCommentSummary = {
  openCount: number;
  unreadCount: number;
  /** Unread comments left on the route's own path, the only ones the publish gate checks. */
  blockingUnreadCount: number;
  hasUnread: boolean;
  latestAt: number | null;
  latestUnreadAt: number | null;
  lastReadAt: number | null;
  items: PageRouteCommentItem[];
};

type PageRouteRef = {
  siteId: string;
  path: string;
  /** The stable route (page_routes.id) the comments were left on; null finds them by path only. */
  routeId?: string | null;
};

type PageCommentRow = {
  id: string;
  body: string;
  path: string;
  siteId: string;
  routeId: string | null;
  targetJson: JsonRecord;
  metadataJson: JsonRecord;
  createdAt: Date;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
};

type PageCommentReadRow = {
  path: string;
  siteId: string;
  lastReadAt: Date | null;
  lastReadCommentCreatedAt: Date | null;
};

export async function listPageRouteCommentSummaries(input: {
  routes: PageRouteRef[];
  userId: string;
  limitPerRoute?: number;
}): Promise<Map<string, PageRouteCommentSummary>> {
  const uniqueRoutes = uniqueRouteRefs(input.routes);
  const summaries = new Map<string, PageRouteCommentSummary>();
  for (const route of uniqueRoutes) {
    summaries.set(routeCommentKey(route.siteId, route.path), emptyPageRouteCommentSummary());
  }
  if (uniqueRoutes.length === 0) return summaries;

  const siteIds = [...new Set(uniqueRoutes.map((route) => route.siteId))];
  const wantedKeys = new Set(uniqueRoutes.map((route) => routeCommentKey(route.siteId, route.path)));
  const wantedRouteIds = new Set(uniqueRoutes.flatMap((route) => (route.routeId ? [route.routeId] : [])));
  const comments = (
    await db
      .select({
        id: schema.pageComments.id,
        body: schema.pageComments.body,
        path: schema.pageComments.path,
        siteId: schema.pageComments.siteId,
        routeId: schema.pageComments.routeId,
        targetJson: schema.pageComments.targetJson,
        metadataJson: schema.pageComments.metadataJson,
        createdAt: schema.pageComments.createdAt,
        createdByUserId: schema.pageComments.createdByUserId,
        createdByDisplayName: schema.users.displayName,
      })
      .from(schema.pageComments)
      .leftJoin(schema.users, eq(schema.pageComments.createdByUserId, schema.users.id))
      .where(and(inArray(schema.pageComments.siteId, siteIds), eq(schema.pageComments.status, "open")))
      .orderBy(asc(schema.pageComments.createdAt))
  ).filter(
    (comment) =>
      (comment.routeId !== null && wantedRouteIds.has(comment.routeId)) ||
      wantedKeys.has(routeCommentKey(comment.siteId, comment.path)),
  );

  const receipts = (
    await db
      .select({
        path: schema.pageCommentReadReceipts.path,
        siteId: schema.pageCommentReadReceipts.siteId,
        lastReadAt: schema.pageCommentReadReceipts.lastReadAt,
        lastReadCommentCreatedAt: schema.pageCommentReadReceipts.lastReadCommentCreatedAt,
      })
      .from(schema.pageCommentReadReceipts)
      .where(and(inArray(schema.pageCommentReadReceipts.siteId, siteIds), eq(schema.pageCommentReadReceipts.userId, input.userId)))
  ).filter(
    (receipt) =>
      wantedKeys.has(routeCommentKey(receipt.siteId, receipt.path)) ||
      comments.some((comment) => comment.siteId === receipt.siteId && comment.path === receipt.path),
  );

  return summarizeCommentRows({
    comments,
    limitPerRoute: input.limitPerRoute ?? 20,
    receipts,
    routes: uniqueRoutes,
    userId: input.userId,
  });
}

export async function getPageRouteComments(input: {
  markRead?: boolean;
  path: string;
  projectRef: string;
  requestId: string;
  siteRef: string;
  workspace: ProjectAccessWorkspace;
}) {
  const resolved = await resolveCommentPage(input.workspace, input.projectRef, input.siteRef, input.path);
  if (input.markRead) {
    await markPageRouteCommentsRead({
      organizationId: input.workspace.organization.id,
      path: resolved.path,
      projectId: resolved.project.id,
      requestId: input.requestId,
      routeId: resolved.routeId,
      siteId: resolved.site.id,
      userId: input.workspace.user.id,
    });
  }

  const summaries = await listPageRouteCommentSummaries({
    routes: [{ siteId: resolved.site.id, path: resolved.path, routeId: resolved.routeId }],
    userId: input.workspace.user.id,
  });
  const comments = summaries.get(routeCommentKey(resolved.site.id, resolved.path)) ?? emptyPageRouteCommentSummary();

  return {
    comments,
    markedRead: Boolean(input.markRead),
    path: resolved.path,
    project: {
      id: resolved.project.id,
      slug: resolved.project.slug,
    },
    site: {
      id: resolved.site.id,
      slug: resolved.site.slug,
      defaultHostname: resolved.site.defaultHostname,
    },
  };
}

export async function markPageRouteCommentsRead(input: {
  organizationId: string;
  path: string;
  projectId: string;
  requestId: string;
  routeId?: string | null;
  siteId: string;
  userId: string;
}) {
  const path = normalizePageCommentPath(input.path);
  const latest = await latestOpenCommentCreatedAt(input.siteId, path, input.routeId ?? null);
  const now = new Date();
  await db
    .insert(schema.pageCommentReadReceipts)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      siteId: input.siteId,
      path,
      userId: input.userId,
      lastReadCommentCreatedAt: latest,
      lastReadAt: now,
      metadataJson: {
        requestId: input.requestId,
        source: "pages_comments_read",
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.pageCommentReadReceipts.siteId,
        schema.pageCommentReadReceipts.path,
        schema.pageCommentReadReceipts.userId,
      ],
      set: {
        lastReadCommentCreatedAt: latest,
        lastReadAt: now,
        metadataJson: {
          requestId: input.requestId,
          source: "pages_comments_read",
        },
        updatedAt: now,
      },
    });
}

export function normalizePageCommentPath(path: string) {
  const normalized = typeof path === "string" ? path.trim() : "";
  if (!normalized.startsWith("/") || normalized.includes("\0") || normalized.length > 2048) {
    throw new ConsoleApiError(400, { error: "invalid_path" });
  }
  return normalized;
}

export function routeCommentKey(siteId: string, path: string) {
  return `${siteId}\0${path}`;
}

/**
 * Groups open comments under the routes they were left on. The top bar stores a comment
 * under the URL the browser shows, which for a mounted route is `/weekly/` (the Worker
 * redirects `/weekly` there) or any page inside it, so a comment belongs to a route by its
 * stable route id first and by an exact path only when it has none.
 */
export function summarizeCommentRows(input: {
  comments: PageCommentRow[];
  limitPerRoute: number;
  receipts: PageCommentReadRow[];
  routes: PageRouteRef[];
  userId: string;
}): Map<string, PageRouteCommentSummary> {
  const receiptsByKey = new Map(input.receipts.map((receipt) => [routeCommentKey(receipt.siteId, receipt.path), receipt]));
  const routeKeyById = new Map(
    input.routes.flatMap((route) => (route.routeId ? [[route.routeId, routeCommentKey(route.siteId, route.path)] as const] : [])),
  );
  const routeKeys = new Set(input.routes.map((route) => routeCommentKey(route.siteId, route.path)));
  const commentsByKey = new Map<string, PageCommentRow[]>();
  for (const comment of input.comments) {
    const pathKey = routeCommentKey(comment.siteId, comment.path);
    const key = (comment.routeId ? routeKeyById.get(comment.routeId) : undefined) ?? (routeKeys.has(pathKey) ? pathKey : null);
    if (!key) continue;
    commentsByKey.set(key, [...(commentsByKey.get(key) ?? []), comment]);
  }

  const summaries = new Map<string, PageRouteCommentSummary>();
  for (const route of input.routes) {
    const key = routeCommentKey(route.siteId, route.path);
    const receipt = receiptsByKey.get(key);
    const comments = commentsByKey.get(key) ?? [];
    const items = comments.map((comment) =>
      formatCommentItem(comment, input.userId, [receipt, receiptsByKey.get(routeCommentKey(comment.siteId, comment.path))]),
    );
    const unreadItems = items.filter((item) => item.unread);
    const visibleItems = items.slice(Math.max(0, items.length - input.limitPerRoute));
    summaries.set(key, {
      openCount: items.length,
      unreadCount: unreadItems.length,
      blockingUnreadCount: unreadItems.filter((item) => item.path === route.path).length,
      hasUnread: unreadItems.length > 0,
      latestAt: items.at(-1)?.createdAt ? Date.parse(items.at(-1)?.createdAt ?? "") : null,
      latestUnreadAt: unreadItems.at(-1)?.createdAt ? Date.parse(unreadItems.at(-1)?.createdAt ?? "") : null,
      lastReadAt: receipt?.lastReadAt ? receipt.lastReadAt.getTime() : null,
      items: visibleItems,
    });
  }
  return summaries;
}

export function emptyPageRouteCommentSummary(): PageRouteCommentSummary {
  return {
    openCount: 0,
    unreadCount: 0,
    blockingUnreadCount: 0,
    hasUnread: false,
    latestAt: null,
    latestUnreadAt: null,
    lastReadAt: null,
    items: [],
  };
}

function formatCommentItem(
  comment: PageCommentRow,
  userId: string,
  receipts: Array<PageCommentReadRow | undefined>,
): PageRouteCommentItem {
  return {
    id: comment.id,
    body: comment.body,
    path: comment.path,
    target: comment.targetJson,
    parentId: commentParentId(comment.metadataJson),
    createdAt: comment.createdAt.toISOString(),
    unread: isUnreadComment(comment, userId, receipts),
    author: {
      id: comment.createdByUserId,
      displayName: comment.createdByDisplayName,
    },
  };
}

/** Read when a receipt on the route's path or on the comment's own path covers it. */
function isUnreadComment(
  comment: PageCommentRow,
  userId: string,
  receipts: Array<PageCommentReadRow | undefined>,
) {
  if (comment.createdByUserId === userId) return false;
  return !receipts.some((receipt) => receipt?.lastReadCommentCreatedAt && comment.createdAt <= receipt.lastReadCommentCreatedAt);
}

function commentParentId(metadata: JsonRecord): string | null {
  return typeof metadata.parentId === "string" ? metadata.parentId : null;
}

function uniqueRouteRefs(routes: PageRouteRef[]) {
  const seen = new Set<string>();
  const unique: PageRouteRef[] = [];
  for (const route of routes) {
    const path = normalizePageCommentPath(route.path);
    const key = routeCommentKey(route.siteId, path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ siteId: route.siteId, path, routeId: route.routeId ?? null });
  }
  return unique;
}

async function resolveCommentPage(
  workspace: ProjectAccessWorkspace,
  projectRef: string,
  siteRef: string,
  path: string,
) {
  const project = await findAccessibleProjectRecord(workspace, projectRef, "read");
  if (!project) throw new ConsoleApiError(404, { error: "not_found" });
  const normalizedPath = normalizePageCommentPath(path);
  const normalizedSiteRef = siteRef.trim().toLowerCase();
  const siteRefPredicate = isUuidRef(siteRef)
    ? or(eq(schema.pageSites.id, siteRef), eq(schema.pageSites.slug, siteRef))
    : or(eq(schema.pageSites.slug, siteRef), eq(schema.pageSites.defaultHostname, normalizedSiteRef));
  const [site] = await db
    .select()
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.organizationId, workspace.organization.id),
        eq(schema.pageSites.projectId, project.id),
        siteRefPredicate,
      ),
    )
    .limit(1);
  if (!site || site.status !== "active") throw new ConsoleApiError(404, { error: "not_found" });
  const route = await activeRouteForPath(site.activeReleaseId, normalizedPath);
  return {
    path: route?.path ?? normalizedPath,
    project,
    routeId: route?.routeId ?? null,
    site,
  };
}

/** The live route serving `path`, so `/weekly/` and pages inside it read the comments of `/weekly`. */
async function activeRouteForPath(releaseId: string | null, path: string) {
  if (!releaseId) return null;
  const routes = await db
    .select({
      id: schema.pageReleaseRoutes.id,
      matchType: schema.pageReleaseRoutes.matchType,
      path: schema.pageReleaseRoutes.path,
      priority: schema.pageReleaseRoutes.priority,
      routeId: schema.pageReleaseRoutes.routeId,
    })
    .from(schema.pageReleaseRoutes)
    .where(eq(schema.pageReleaseRoutes.releaseId, releaseId));
  const matched = matchPageRoute(routes, path);
  return matched ? (routes.find((route) => route.id === matched.id) ?? null) : null;
}

async function latestOpenCommentCreatedAt(siteId: string, path: string, routeId: string | null) {
  const [comment] = await db
    .select({ createdAt: schema.pageComments.createdAt })
    .from(schema.pageComments)
    .where(
      and(
        eq(schema.pageComments.siteId, siteId),
        routeId ? or(eq(schema.pageComments.routeId, routeId), eq(schema.pageComments.path, path)) : eq(schema.pageComments.path, path),
        eq(schema.pageComments.status, "open"),
      ),
    )
    .orderBy(desc(schema.pageComments.createdAt))
    .limit(1);
  return comment?.createdAt ?? null;
}

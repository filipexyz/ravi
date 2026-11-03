// Database access for Bases. Services pass `db` or a transaction. Row
// reads that filter or sort go through the compiler (`compiler.ts`); this
// module only loads records by id.

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { BaseProjectRole, BaseUserRef } from "@/shared/bases/types";
import { isBaseUuid } from "@/shared/bases/values";

export type BasesDb = typeof db;
export type BasesTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type BasesExecutor = BasesDb | BasesTx;

export type BaseRecord = typeof schema.bases.$inferSelect;
export type BasePropertyRecord = typeof schema.baseProperties.$inferSelect;
export type BaseRowRecord = typeof schema.baseRows.$inferSelect;
export type BaseViewRecord = typeof schema.baseViews.$inferSelect;
export type BaseChartRecord = typeof schema.baseCharts.$inferSelect;
export type BaseLedgerRecord = typeof schema.baseRowLedger.$inferSelect;
export type BaseSubscriptionRecord = typeof schema.baseSubscriptions.$inferSelect;
export type BaseProjectRecord = typeof schema.projects.$inferSelect;

/** Runs raw SQL and returns plain row objects. */
export async function executeRows<T>(executor: BasesExecutor, query: SQL): Promise<T[]> {
  const result = await executor.execute(query);
  return [...(result as unknown as T[])];
}

/** Runs `fn` in a transaction with `SET LOCAL statement_timeout`. */
export async function withStatementTimeout<T>(timeoutMs: number, fn: (tx: BasesTx) => Promise<T>): Promise<T> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
    return fn(tx);
  });
}

export async function findBaseRecord(
  executor: BasesExecutor,
  input: { organizationId: string; projectId: string; ref: string },
): Promise<BaseRecord | null> {
  const ref = input.ref.trim();
  if (!ref) return null;
  const predicate = isBaseUuid(ref) ? eq(schema.bases.id, ref.toLowerCase()) : eq(schema.bases.slug, ref);
  const [base] = await executor
    .select()
    .from(schema.bases)
    .where(and(eq(schema.bases.organizationId, input.organizationId), eq(schema.bases.projectId, input.projectId), predicate))
    .limit(1);
  return base ?? null;
}

export async function listBaseRecords(executor: BasesExecutor, input: { organizationId: string; projectId: string }) {
  return executor
    .select()
    .from(schema.bases)
    .where(and(eq(schema.bases.organizationId, input.organizationId), eq(schema.bases.projectId, input.projectId)))
    .orderBy(asc(schema.bases.name), asc(schema.bases.createdAt));
}

export async function loadPropertyRecords(executor: BasesExecutor, baseId: string) {
  return executor
    .select()
    .from(schema.baseProperties)
    .where(eq(schema.baseProperties.baseId, baseId))
    .orderBy(asc(schema.baseProperties.position), asc(schema.baseProperties.createdAt));
}

export async function loadViewRecords(executor: BasesExecutor, baseIds: string[], options: { includeArchived?: boolean } = {}) {
  if (!baseIds.length) return [];
  const conditions = [inArray(schema.baseViews.baseId, baseIds)];
  if (!options.includeArchived) conditions.push(eq(schema.baseViews.status, "active"));
  return executor
    .select()
    .from(schema.baseViews)
    .where(and(...conditions))
    .orderBy(asc(schema.baseViews.position), asc(schema.baseViews.createdAt));
}

export async function findViewRecord(executor: BasesExecutor, input: { baseId: string; viewId: string }) {
  if (!isBaseUuid(input.viewId)) return null;
  const [view] = await executor
    .select()
    .from(schema.baseViews)
    .where(and(eq(schema.baseViews.baseId, input.baseId), eq(schema.baseViews.id, input.viewId.toLowerCase())))
    .limit(1);
  return view ?? null;
}

export async function loadChartRecords(executor: BasesExecutor, baseId: string, options: { includeArchived?: boolean } = {}) {
  const conditions = [eq(schema.baseCharts.baseId, baseId)];
  if (!options.includeArchived) conditions.push(eq(schema.baseCharts.status, "active"));
  return executor
    .select()
    .from(schema.baseCharts)
    .where(and(...conditions))
    .orderBy(asc(schema.baseCharts.position), asc(schema.baseCharts.createdAt));
}

export async function findChartRecord(executor: BasesExecutor, input: { baseId: string; chartId: string }) {
  if (!isBaseUuid(input.chartId)) return null;
  const [chart] = await executor
    .select()
    .from(schema.baseCharts)
    .where(and(eq(schema.baseCharts.baseId, input.baseId), eq(schema.baseCharts.id, input.chartId.toLowerCase())))
    .limit(1);
  return chart ?? null;
}

export async function findRowRecord(
  executor: BasesExecutor,
  input: { organizationId: string; baseId: string; rowId: string },
  options: { forUpdate?: boolean } = {},
): Promise<BaseRowRecord | null> {
  if (!isBaseUuid(input.rowId)) return null;
  const query = executor
    .select()
    .from(schema.baseRows)
    .where(
      and(
        eq(schema.baseRows.organizationId, input.organizationId),
        eq(schema.baseRows.baseId, input.baseId),
        eq(schema.baseRows.id, input.rowId.toLowerCase()),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export async function findRowRecords(
  executor: BasesExecutor,
  input: { organizationId: string; baseId: string; rowIds: string[] },
): Promise<BaseRowRecord[]> {
  const ids = input.rowIds.filter((id) => isBaseUuid(id)).map((id) => id.toLowerCase());
  if (!ids.length) return [];
  const rows = await executor
    .select()
    .from(schema.baseRows)
    .where(
      and(
        eq(schema.baseRows.organizationId, input.organizationId),
        eq(schema.baseRows.baseId, input.baseId),
        inArray(schema.baseRows.id, ids),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is BaseRowRecord => Boolean(row));
}

export async function countActiveRows(executor: BasesExecutor, baseId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.baseRows)
    .where(and(eq(schema.baseRows.baseId, baseId), isNull(schema.baseRows.archivedAt)));
  return Number(row?.count ?? 0);
}

export async function countActiveRowsByBase(executor: BasesExecutor, baseIds: string[]): Promise<Map<string, number>> {
  if (!baseIds.length) return new Map();
  const rows = await executor
    .select({ baseId: schema.baseRows.baseId, count: sql<number>`count(*)::int` })
    .from(schema.baseRows)
    .where(and(inArray(schema.baseRows.baseId, baseIds), isNull(schema.baseRows.archivedAt)))
    .groupBy(schema.baseRows.baseId);
  return new Map(rows.map((row) => [row.baseId, Number(row.count)]));
}

/** Locks the base row `FOR SHARE` (row writes) or `FOR UPDATE` (schema and metadata changes). */
export async function lockBaseRecord(tx: BasesTx, baseId: string, mode: "share" | "update"): Promise<BaseRecord | null> {
  const query = tx.select().from(schema.bases).where(eq(schema.bases.id, baseId)).limit(1);
  const [base] = mode === "update" ? await query.for("update") : await query.for("share");
  return base ?? null;
}

/** Public user refs (no emails) keyed by id. */
export async function findUserRefs(executor: BasesExecutor, ids: Iterable<string>): Promise<Record<string, BaseUserRef>> {
  const unique = [...new Set([...ids].filter((id) => isBaseUuid(id)).map((id) => id.toLowerCase()))];
  if (!unique.length) return {};
  const rows = await executor
    .select({ id: schema.users.id, displayName: schema.users.displayName, avatarUrl: schema.users.avatarUrl })
    .from(schema.users)
    .where(inArray(schema.users.id, unique));
  const users: Record<string, BaseUserRef> = {};
  for (const row of rows) users[row.id] = { id: row.id, displayName: row.displayName, avatarUrl: row.avatarUrl };
  return users;
}

/** Active members of the organization whose user is active. */
export async function listActiveMemberRefs(executor: BasesExecutor, organizationId: string): Promise<BaseUserRef[]> {
  const rows = await executor
    .select({ id: schema.users.id, displayName: schema.users.displayName, avatarUrl: schema.users.avatarUrl })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
      ),
    )
    .orderBy(asc(schema.users.displayName), asc(schema.users.id));
  return rows.map((row) => ({ id: row.id, displayName: row.displayName, avatarUrl: row.avatarUrl }));
}

/** The subset of `ids` that are active members (and active users) of the organization. */
export async function activeMemberIds(executor: BasesExecutor, organizationId: string, ids: Iterable<string>): Promise<Set<string>> {
  const unique = [...new Set([...ids].filter((id) => isBaseUuid(id)).map((id) => id.toLowerCase()))];
  if (!unique.length) return new Set();
  const rows = await executor
    .select({ userId: schema.organizationMemberships.userId })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
        inArray(schema.organizationMemberships.userId, unique),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}

/** An active member of the organization (active user): role and lowercased primary email; null otherwise. */
export async function findActiveMember(
  executor: BasesExecutor,
  input: { organizationId: string; userId: string },
): Promise<{ userId: string; role: string; email: string | null } | null> {
  if (!isBaseUuid(input.userId)) return null;
  const [row] = await executor
    .select({ userId: schema.organizationMemberships.userId, role: schema.organizationMemberships.role, email: schema.users.primaryEmail })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId.toLowerCase()),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { userId: row.userId, role: row.role, email: row.email ? row.email.trim().toLowerCase() || null : null };
}

export async function findActiveProjectRole(
  executor: BasesExecutor,
  input: { projectId: string; userId: string },
): Promise<BaseProjectRole | null> {
  const [row] = await executor
    .select({ role: schema.projectMemberships.role })
    .from(schema.projectMemberships)
    .where(
      and(
        eq(schema.projectMemberships.projectId, input.projectId),
        eq(schema.projectMemberships.userId, input.userId),
        eq(schema.projectMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

// ---------------------------------------------------------------------------
// Library widgets (`layout.widget`). Read directly, not through the Library
// service: Bases callers (CLI, Console, Pages, system) carry no Library
// workspace, and the binding only needs the item, its scope, and one file.

/** A Library item as `layout.widget` sees it. `projectSlug` is null for org items. */
export type LayoutWidgetItem = {
  id: string;
  kind: string;
  projectId: string | null;
  projectSlug: string | null;
  slug: string;
  archived: boolean;
  currentVersionId: string | null;
};

/** `org/<slug>` or `<project-slug>/<slug>`, as the Library prints refs. */
export function libraryItemRef(item: Pick<LayoutWidgetItem, "projectSlug" | "slug">) {
  return `${item.projectSlug ?? "org"}/${item.slug}`;
}

/**
 * One item of the organization, by id (any kind, any project) or by widget
 * slug: `org` (org items), `project` (items of `projectId`), or `visible`
 * (both, org first). Archived items are returned so callers can say so.
 */
export async function findLayoutWidgetItem(
  executor: BasesExecutor,
  input: { organizationId: string; projectId: string } & ({ itemId: string } | { slug: string; scope: "org" | "project" | "visible" }),
): Promise<LayoutWidgetItem | null> {
  const items = schema.libraryItems;
  let where: SQL | undefined;
  if ("itemId" in input) {
    if (!isBaseUuid(input.itemId)) return null;
    where = and(eq(items.organizationId, input.organizationId), eq(items.id, input.itemId.toLowerCase()));
  } else {
    const scope =
      input.scope === "org"
        ? isNull(items.projectId)
        : input.scope === "project"
          ? eq(items.projectId, input.projectId)
          : or(isNull(items.projectId), eq(items.projectId, input.projectId));
    where = and(eq(items.organizationId, input.organizationId), eq(items.kind, "widget"), eq(items.slug, input.slug), scope);
  }
  const rows = await executor
    .select({
      id: items.id,
      kind: items.kind,
      projectId: items.projectId,
      projectSlug: schema.projects.slug,
      slug: items.slug,
      archivedAt: items.archivedAt,
      currentVersionId: items.currentVersionId,
    })
    .from(items)
    .leftJoin(schema.projects, eq(schema.projects.id, items.projectId))
    .where(where)
    .limit(2);
  // Slugs are unique across org and project items; org first only orders a repaired collision.
  const row = rows.sort((a, b) => Number(a.projectId !== null) - Number(b.projectId !== null))[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    projectSlug: row.projectId ? (row.projectSlug ?? row.projectId) : null,
    slug: row.slug,
    archived: row.archivedAt !== null,
    currentVersionId: row.currentVersionId,
  };
}

/** One file of a Library version, or null. */
export async function findLibraryFileText(executor: BasesExecutor, input: { versionId: string; path: string }): Promise<string | null> {
  const [file] = await executor
    .select({ content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(and(eq(schema.libraryFiles.versionId, input.versionId), eq(schema.libraryFiles.path, input.path)))
    .limit(1);
  return file?.content ?? null;
}

/** Current refs of the organization's Library items among `itemIds`, keyed by item id. */
export async function loadLibraryItemRefs(
  executor: BasesExecutor,
  input: { organizationId: string; itemIds: Iterable<string> },
): Promise<Map<string, string>> {
  const ids = [...new Set([...input.itemIds].filter((id) => isBaseUuid(id)).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map();
  const rows = await executor
    .select({ id: schema.libraryItems.id, projectId: schema.libraryItems.projectId, projectSlug: schema.projects.slug, slug: schema.libraryItems.slug })
    .from(schema.libraryItems)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .where(and(eq(schema.libraryItems.organizationId, input.organizationId), inArray(schema.libraryItems.id, ids)));
  return new Map(
    rows.map((row) => [row.id, libraryItemRef({ projectSlug: row.projectId ? (row.projectSlug ?? row.projectId) : null, slug: row.slug })]),
  );
}

/** Page sites (not deleted) of the project among `siteIds`. */
export async function projectPageSiteIds(executor: BasesExecutor, input: { projectId: string; siteIds: string[] }) {
  const ids = [...new Set(input.siteIds.filter((id) => isBaseUuid(id)).map((id) => id.toLowerCase()))];
  if (!ids.length) return new Set<string>();
  const rows = await executor
    .select({ id: schema.pageSites.id, status: schema.pageSites.status })
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.projectId, input.projectId), inArray(schema.pageSites.id, ids)));
  return new Set(rows.filter((row) => row.status !== "deleted").map((row) => row.id));
}

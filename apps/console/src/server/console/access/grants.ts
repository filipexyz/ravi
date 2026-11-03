import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { validateRoutePath } from "@/server/console/pages/policy";
import { canAccessProject } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import {
  type AccessActor,
  type AccessDb,
  displayNameFor,
  findOrCreateUserByEmail,
  zodFieldErrors,
} from "./common";

type GrantRecord = typeof schema.accessGrants.$inferSelect;
type SiteRecord = typeof schema.pageSites.$inferSelect;
type RouteRecord = typeof schema.pageRoutes.$inferSelect;

/**
 * The access model in OpenFGA's DSL. The tables hold tuples of this model;
 * `canUserViewPagesRoute` and `canUserViewMeeting` are its checks today.
 */
export const ACCESS_MODEL = `model
  schema 1.1
type user
type page_site
  relations
    define viewer: [user]
type page_route
  relations
    define site: [page_site]
    define viewer: [user] or viewer from site
type meeting
  relations
    define viewer: [user]`;

export const ACCESS_GRANT_MAX_DAYS = 365;
const SOURCE = "console.access.grants";

const shareBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    path: z.string().trim().min(1).max(2048).optional().nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
    routeId: z.string().uuid().optional().nullable(),
    siteId: z.string().uuid(),
  })
  .refine((value) => !(value.path && value.routeId), { message: "Pass a route or a path, not both.", path: ["routeId"] });

const unshareBodySchema = z.object({ grantId: z.string().uuid() });

export type AccessGrantSummary = {
  createdAt: string;
  createdBy: string | null;
  email: string;
  expiresAt: string | null;
  id: string;
  name: string | null;
  /** `null` when the grant covers the whole site. */
  routeId: string | null;
  routePath: string | null;
  scope: "route" | "site";
  url: string;
  userId: string;
};

export type SharedPageSummary = {
  expiresAt: string | null;
  grantId: string;
  organizationName: string;
  path: string;
  scope: "route" | "site";
  sharedBy: string | null;
  sharedAt: string;
  siteHostname: string;
  url: string;
};

/**
 * Whether this person was given access to the route, on its own or through
 * its site. Grants never come from org membership; that check is separate.
 */
export async function canUserViewPagesRoute(
  input: { now?: Date; routeId: string | null; siteId: string; userId: string },
  executor: AccessDb = db,
) {
  const now = input.now ?? new Date();
  const objectMatch = input.routeId
    ? or(
        and(eq(schema.accessGrants.objectType, "page_site"), eq(schema.accessGrants.objectId, input.siteId)),
        and(eq(schema.accessGrants.objectType, "page_route"), eq(schema.accessGrants.objectId, input.routeId)),
      )
    : and(eq(schema.accessGrants.objectType, "page_site"), eq(schema.accessGrants.objectId, input.siteId));

  const [row] = await executor
    .select({ id: schema.accessGrants.id })
    .from(schema.accessGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.accessGrants.subjectId))
    .where(
      and(
        eq(schema.accessGrants.pageSiteId, input.siteId),
        eq(schema.accessGrants.relation, "viewer"),
        eq(schema.accessGrants.subjectType, "user"),
        eq(schema.accessGrants.subjectId, input.userId),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
        eq(schema.users.status, "active"),
        objectMatch,
      ),
    )
    .limit(1);
  if (!row) return false;
  // Members (including suspended/removed records) cannot downgrade themselves
  // to the guest path to evade project policy. This leaves explicitly shared
  // outside-org human guests intact; no implicit public access is introduced.
  const [member] = await executor.select({ organizationId: schema.pageSites.organizationId,
    projectId: schema.pageSites.projectId, role: schema.organizationMemberships.role,
    status: schema.organizationMemberships.status }).from(schema.pageSites)
    .innerJoin(schema.organizationMemberships, and(eq(schema.organizationMemberships.organizationId, schema.pageSites.organizationId),
      eq(schema.organizationMemberships.userId, input.userId)))
    .where(eq(schema.pageSites.id, input.siteId)).limit(1);
  if (!member) return true;
  if (member.status !== "active") return false;
  return canAccessProject({ user: { id: input.userId }, organization: { id: member.organizationId }, membership: { role: member.role } }, member.projectId, "read");
}

/** Who can share a site: anyone who can publish to its project (D3). */
export async function assertCanShareSite(actor: AccessActor, site: Pick<SiteRecord, "organizationId" | "projectId">) {
  if (site.organizationId !== actor.organizationId) {
    throw new ConsoleApiError(404, { error: "site_not_found" });
  }
  const allowed = await canAccessProject(
    { membership: { role: actor.role }, organization: { id: actor.organizationId }, user: { id: actor.userId } },
    site.projectId,
    "write",
  );
  if (!allowed) throw new ConsoleApiError(403, { error: "forbidden" });
}

export function parseShareBody(body: unknown, now = new Date()) {
  const result = shareBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: zodFieldErrors(result.error, {
        email: "Enter a valid email.",
        expiresAt: "Pick a valid date.",
        path: "Enter a valid path.",
        reason: "Keep the note under 500 characters.",
        routeId: "Choose a page on this site.",
        siteId: "Choose a site.",
      }),
    });
  }
  const expiresAt = result.data.expiresAt ? new Date(result.data.expiresAt) : null;
  if (expiresAt) {
    const max = now.getTime() + ACCESS_GRANT_MAX_DAYS * 24 * 60 * 60 * 1000;
    if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > max) {
      throw new ConsoleApiError(400, {
        error: "validation_failed",
        fieldErrors: { expiresAt: `Pick a date in the next ${ACCESS_GRANT_MAX_DAYS} days.` },
      });
    }
  }
  return { ...result.data, expiresAt, reason: result.data.reason || null };
}

/** Gives one person access to one site or one page on it. Idempotent. */
export async function sharePagesAccess({
  actor,
  body,
  now = new Date(),
  requestId,
}: {
  actor: AccessActor;
  body: unknown;
  now?: Date;
  requestId: string;
}): Promise<{ created: boolean; grant: AccessGrantSummary; userCreated: boolean }> {
  const input = parseShareBody(body, now);
  const site = await findSite(db, input.siteId);
  if (!site || site.status !== "active") throw new ConsoleApiError(404, { error: "site_not_found" });
  await assertCanShareSite(actor, site);

  const route = input.routeId || input.path ? await findRoute(db, site.id, input) : null;
  if ((input.routeId || input.path) && !route) throw new ConsoleApiError(404, { error: "route_not_found" });

  const objectType = route ? ("page_route" as const) : ("page_site" as const);
  const objectId = route ? route.id : site.id;

  const result = await db.transaction(async (tx) => {
    const { created: userCreated, user } = await findOrCreateUserByEmail(tx, {
      actor,
      createdFrom: "console_pages_share",
      email: input.email,
      requestId,
    });
    if (user.status !== "active") throw new ConsoleApiError(409, { error: "user_inactive" });

    const findActive = async () => {
      const [row] = await tx
        .select()
        .from(schema.accessGrants)
        .where(
          and(
            eq(schema.accessGrants.objectType, objectType),
            eq(schema.accessGrants.objectId, objectId),
            eq(schema.accessGrants.relation, "viewer"),
            eq(schema.accessGrants.subjectType, "user"),
            eq(schema.accessGrants.subjectId, user.id),
            isNull(schema.accessGrants.revokedAt),
          ),
        )
        .limit(1);
      return row;
    };

    const existing = await findActive();

    const via = actor.via ? { via: actor.via } : {};
    const updateExisting = async (existing: GrantRecord) => {
      const [updated] = await tx
        .update(schema.accessGrants)
        .set({ expiresAt: input.expiresAt, reason: input.reason ?? existing.reason, updatedAt: now })
        .where(eq(schema.accessGrants.id, existing.id))
        .returning();
      if (!updated) throw new Error("Failed to update access grant.");
      await tx.insert(schema.auditEvents).values({
        action: "access_grant.updated",
        actorId: actor.userId,
        actorType: actor.actorType,
        afterJson: { grant: sanitizeGrant(updated) },
        beforeJson: { grant: sanitizeGrant(existing) },
        metadataJson: { source: SOURCE, ...via },
        organizationId: site.organizationId,
        projectId: site.projectId,
        requestId,
        targetId: updated.id,
        targetType: "access_grant",
      });
      return { created: false, grant: updated, user, userCreated };
    };
    if (existing) return updateExisting(existing);

    const [grant] = await tx
      .insert(schema.accessGrants)
      .values({
        createdByActorId: actor.userId,
        createdByActorType: actor.actorType,
        expiresAt: input.expiresAt,
        metadataJson: { requestId, source: SOURCE, ...via },
        objectId,
        objectType,
        organizationId: site.organizationId,
        pageSiteId: site.id,
        projectId: site.projectId,
        reason: input.reason,
        relation: "viewer",
        subjectId: user.id,
        subjectType: "user",
      })
      // A concurrent share of the same tuple wins the partial unique index; update theirs instead.
      .onConflictDoNothing()
      .returning();
    if (!grant) {
      const raced = await findActive();
      if (!raced) throw new Error("Failed to create access grant.");
      return updateExisting(raced);
    }

    await tx.insert(schema.auditEvents).values({
      action: "access_grant.created",
      actorId: actor.userId,
      actorType: actor.actorType,
      afterJson: { grant: sanitizeGrant(grant) },
      metadataJson: { source: SOURCE, userCreated, ...via },
      organizationId: site.organizationId,
      projectId: site.projectId,
      requestId,
      targetId: grant.id,
      targetType: "access_grant",
    });
    return { created: true, grant, user, userCreated };
  });

  const creator = await findUser(db, actor.userId);
  return {
    created: result.created,
    grant: toGrantSummary(result.grant, { creator, route, site, user: result.user }),
    userCreated: result.userCreated,
  };
}

export async function unsharePagesAccess({
  actor,
  body,
  now = new Date(),
  requestId,
}: {
  actor: AccessActor;
  body: unknown;
  now?: Date;
  requestId: string;
}): Promise<{ revoked: boolean }> {
  const parsed = unshareBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { grantId: "Choose a valid grant." } });
  }
  const [grant] = await db
    .select()
    .from(schema.accessGrants)
    .where(and(eq(schema.accessGrants.id, parsed.data.grantId), eq(schema.accessGrants.organizationId, actor.organizationId)))
    .limit(1);
  if (!grant?.pageSiteId) throw new ConsoleApiError(404, { error: "grant_not_found" });
  const site = await findSite(db, grant.pageSiteId);
  if (!site) throw new ConsoleApiError(404, { error: "grant_not_found" });
  await assertCanShareSite(actor, site);
  if (grant.revokedAt) return { revoked: false };

  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(schema.accessGrants)
      .set({ revokedAt: now, revokedByActorId: actor.userId, revokedByActorType: actor.actorType, updatedAt: now })
      .where(and(eq(schema.accessGrants.id, grant.id), isNull(schema.accessGrants.revokedAt)))
      .returning();
    if (!revoked) return { revoked: false };
    await tx.insert(schema.auditEvents).values({
      action: "access_grant.revoked",
      actorId: actor.userId,
      actorType: actor.actorType,
      afterJson: { grant: sanitizeGrant(revoked) },
      beforeJson: { grant: sanitizeGrant(grant) },
      metadataJson: { source: SOURCE, ...(actor.via ? { via: actor.via } : {}) },
      organizationId: grant.organizationId,
      projectId: grant.projectId,
      requestId,
      targetId: grant.id,
      targetType: "access_grant",
    });
    return { revoked: true };
  });
}

/** Everyone given access to a site or its pages, still in force. */
export async function listPagesSiteAccess({
  actor,
  now = new Date(),
  siteId,
}: {
  actor: AccessActor;
  now?: Date;
  siteId: string;
}): Promise<{ grants: AccessGrantSummary[]; siteId: string }> {
  const site = await findSite(db, siteId);
  if (!site || site.status === "deleted") throw new ConsoleApiError(404, { error: "site_not_found" });
  await assertCanShareSite(actor, site);

  const rows = await db
    .select()
    .from(schema.accessGrants)
    .where(
      and(
        eq(schema.accessGrants.pageSiteId, site.id),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
      ),
    )
    .orderBy(asc(schema.accessGrants.createdAt));

  const users = await findUsers(db, [
    ...rows.map((row) => row.subjectId),
    ...rows.flatMap((row) => (row.createdByActorId ? [row.createdByActorId] : [])),
  ]);
  const routes = await findRoutes(
    db,
    rows.flatMap((row) => (row.objectType === "page_route" ? [row.objectId] : [])),
  );

  const grants = rows.flatMap((row) => {
    const user = users.get(row.subjectId);
    if (!user) return [];
    const route = row.objectType === "page_route" ? routes.get(row.objectId) ?? null : null;
    if (row.objectType === "page_route" && !route) return [];
    return [
      toGrantSummary(row, {
        creator: row.createdByActorId ? users.get(row.createdByActorId) ?? null : null,
        route,
        site,
        user,
      }),
    ];
  });
  return { grants, siteId: site.id };
}

/** Pages other organizations shared with this person. */
export async function listPagesSharedWithUser({
  now = new Date(),
  userId,
}: {
  now?: Date;
  userId: string;
}): Promise<SharedPageSummary[]> {
  const rows = await db
    .select({ grant: schema.accessGrants, organization: schema.organizations, site: schema.pageSites })
    .from(schema.accessGrants)
    .innerJoin(schema.pageSites, eq(schema.pageSites.id, schema.accessGrants.pageSiteId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accessGrants.organizationId))
    .where(
      and(
        eq(schema.accessGrants.subjectType, "user"),
        eq(schema.accessGrants.subjectId, userId),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
        eq(schema.pageSites.status, "active"),
        eq(schema.organizations.status, "active"),
      ),
    )
    .orderBy(asc(schema.accessGrants.createdAt));

  const routes = await findRoutes(
    db,
    rows.flatMap((row) => (row.grant.objectType === "page_route" ? [row.grant.objectId] : [])),
  );
  const creators = await findUsers(
    db,
    rows.flatMap((row) => (row.grant.createdByActorId ? [row.grant.createdByActorId] : [])),
  );

  return rows.flatMap((row) => {
    const route = row.grant.objectType === "page_route" ? routes.get(row.grant.objectId) ?? null : null;
    if (row.grant.objectType === "page_route" && (!route || route.status !== "active")) return [];
    const path = route ? sharePath(route) : "/";
    return [
      {
        expiresAt: row.grant.expiresAt?.toISOString() ?? null,
        grantId: row.grant.id,
        organizationName: row.organization.name,
        path,
        scope: route ? ("route" as const) : ("site" as const),
        sharedAt: row.grant.createdAt.toISOString(),
        sharedBy: displayNameFor(row.grant.createdByActorId ? creators.get(row.grant.createdByActorId) : null),
        siteHostname: row.site.defaultHostname,
        url: `https://${row.site.defaultHostname}${path}`,
      },
    ];
  });
}

async function findSite(executor: AccessDb, siteId: string): Promise<SiteRecord | null> {
  const [site] = await executor.select().from(schema.pageSites).where(eq(schema.pageSites.id, siteId)).limit(1);
  return site ?? null;
}

async function findRoute(
  executor: AccessDb,
  siteId: string,
  input: { path?: string | null; routeId?: string | null },
): Promise<RouteRecord | null> {
  const rows = await executor
    .select()
    .from(schema.pageRoutes)
    .where(
      and(
        eq(schema.pageRoutes.siteId, siteId),
        eq(schema.pageRoutes.status, "active"),
        input.routeId ? eq(schema.pageRoutes.id, input.routeId) : eq(schema.pageRoutes.path, normalizeSharePath(input.path)),
      ),
    );
  // A path can exist as an exact route and as a prefix route; the exact one is the page.
  return rows.find((row) => row.matchType === "exact") ?? rows[0] ?? null;
}

async function findRoutes(executor: AccessDb, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, RouteRecord>();
  const rows = await executor.select().from(schema.pageRoutes).where(inArray(schema.pageRoutes.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

async function findUser(executor: AccessDb, userId: string) {
  const [user] = await executor.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user ?? null;
}

async function findUsers(executor: AccessDb, ids: string[]) {
  const unique = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!unique.length) return new Map<string, typeof schema.users.$inferSelect>();
  const rows = await executor.select().from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

function normalizeSharePath(path: string | null | undefined) {
  const result = validateRoutePath(path ?? "/");
  if (!result.ok) throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { path: "Enter a valid path." } });
  return result.path;
}

function sharePath(route: Pick<RouteRecord, "path">) {
  return route.path || "/";
}

function toGrantSummary(
  grant: GrantRecord,
  context: {
    creator: typeof schema.users.$inferSelect | null;
    route: RouteRecord | null;
    site: SiteRecord;
    user: typeof schema.users.$inferSelect;
  },
): AccessGrantSummary {
  const path = context.route ? sharePath(context.route) : "/";
  return {
    createdAt: grant.createdAt.toISOString(),
    createdBy: displayNameFor(context.creator),
    email: context.user.primaryEmail,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    id: grant.id,
    name: context.user.displayName,
    routeId: context.route?.id ?? null,
    routePath: context.route ? path : null,
    scope: context.route ? "route" : "site",
    url: `https://${context.site.defaultHostname}${path}`,
    userId: context.user.id,
  };
}

function sanitizeGrant(grant: GrantRecord) {
  return {
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    id: grant.id,
    object: `${grant.objectType}:${grant.objectId}`,
    reason: grant.reason,
    relation: grant.relation,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    subject: `${grant.subjectType}:${grant.subjectId}`,
  };
}

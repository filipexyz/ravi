import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import { AGENT_INBOX_TARGET_LOCAL_INSTALLATION, recordAgentInboxItem } from "@/server/console/agent-inbox";
import { ConsoleApiError } from "@/server/console/api-error";
import { canAccessProject } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { type AccessActor, displayNameFor, memberActorForOrganization } from "./common";
import { assertCanShareSite, canUserViewPagesRoute, sharePagesAccess } from "./grants";
import { isGrantableTarget, type PageTarget, resolvePageTarget } from "./targets";

type RequestRecord = typeof schema.accessRequests.$inferSelect;
type SiteRecord = typeof schema.pageSites.$inferSelect;

export const ACCESS_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCESS_REQUEST_RATE_LIMIT = 20;
const ACCESS_REQUEST_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOURCE = "console.access.requests";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const messageSchema = z.string().trim().max(500).optional().nullable();

/** What the requester and their agent see: never who decided. */
export type AccessRequestSummary = {
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  host: string;
  id: string;
  path: string;
  status: RequestRecord["status"] | "expired";
  /** The forwardable approval link. */
  url: string;
};

/** What someone who can approve sees. */
export type AccessRequestDetail = AccessRequestSummary & {
  agentName: string | null;
  message: string | null;
  organizationName: string;
  pageUrl: string;
  requester: { email: string; name: string | null };
  /** Whether a single page matched; when not, approving gives the whole site. */
  routeMatched: boolean;
  siteId: string;
  via: RequestRecord["via"];
};

export type AccessRequestCaller = {
  /** The CLI installation and agent asking, for `via: "cli"`. */
  cli?: { agentId?: string | null; agentName?: string | null; installationId: string; organizationId: string };
  userId: string;
};

export type CreateAccessRequestResult =
  | { status: "already_allowed"; url: string }
  | { created: boolean; request: AccessRequestSummary; status: "requested" };

/**
 * Asks for access to a private page. Asking again while a request is pending
 * refreshes its message and returns the same request.
 */
export async function createAccessRequest(input: {
  caller: AccessRequestCaller;
  message?: unknown;
  now?: Date;
  origin: string;
  requestId: string;
  target?: PageTarget;
  url?: string;
}): Promise<CreateAccessRequestResult> {
  const now = input.now ?? new Date();
  const parsedMessage = messageSchema.safeParse(input.message ?? null);
  if (!parsedMessage.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { message: "Keep the message under 500 characters." },
    });
  }
  const message = parsedMessage.data || null;
  const target = input.target ?? (await resolvePageTarget(input.url ?? ""));
  const pageUrl = `https://${target.host}${target.path}`;

  if (target.visibility === "public") return { status: "already_allowed", url: pageUrl };
  if (!isGrantableTarget(target)) throw new ConsoleApiError(400, { error: "password_route" });
  if (await userCanViewTarget(input.caller.userId, target, now)) return { status: "already_allowed", url: pageUrl };

  const via = input.caller.cli ? ("cli" as const) : ("page" as const);
  const site = target.site;
  const result = await db.transaction(async (tx) => {
    // Lock the requester so concurrent requests count one after another.
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, input.caller.userId))
      .for("update")
      .limit(1);
    const [recent] = await tx
      .select({ value: count() })
      .from(schema.accessRequests)
      .where(
        and(
          eq(schema.accessRequests.requesterUserId, input.caller.userId),
          gt(schema.accessRequests.createdAt, new Date(now.getTime() - ACCESS_REQUEST_RATE_WINDOW_MS)),
        ),
      );
    if ((recent?.value ?? 0) >= ACCESS_REQUEST_RATE_LIMIT) throw new ConsoleApiError(429, { error: "rate_limited" });

    const [pending] = await tx
      .select()
      .from(schema.accessRequests)
      .where(
        and(
          eq(schema.accessRequests.pageSiteId, site.id),
          eq(schema.accessRequests.path, target.path),
          eq(schema.accessRequests.requesterUserId, input.caller.userId),
          eq(schema.accessRequests.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);

    if (pending && pending.expiresAt > now) {
      const [updated] = await tx
        .update(schema.accessRequests)
        .set({ message: message ?? pending.message, updatedAt: now })
        .where(eq(schema.accessRequests.id, pending.id))
        .returning();
      return { created: false, request: updated ?? pending };
    }
    if (pending) {
      await tx
        .update(schema.accessRequests)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(schema.accessRequests.id, pending.id));
    }

    const [request] = await tx
      .insert(schema.accessRequests)
      .values({
        agentId: input.caller.cli?.agentId ?? null,
        agentName: input.caller.cli?.agentName ?? null,
        expiresAt: new Date(now.getTime() + ACCESS_REQUEST_TTL_MS),
        localInstallationId: input.caller.cli?.installationId ?? null,
        message,
        metadataJson: { requestId: input.requestId, source: SOURCE },
        organizationId: site.organizationId,
        pageSiteId: site.id,
        path: target.path,
        projectId: site.projectId,
        requesterOrganizationId: input.caller.cli?.organizationId ?? null,
        requesterUserId: input.caller.userId,
        routeId: target.route?.routeId ?? null,
        via,
      })
      // Another tab asked at the same moment: answer with its request.
      .onConflictDoNothing()
      .returning();
    if (!request) {
      const [existing] = await tx
        .select()
        .from(schema.accessRequests)
        .where(
          and(
            eq(schema.accessRequests.pageSiteId, site.id),
            eq(schema.accessRequests.path, target.path),
            eq(schema.accessRequests.requesterUserId, input.caller.userId),
            eq(schema.accessRequests.status, "pending"),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Failed to create access request.");
      return { created: false, request: existing };
    }

    const link = accessRequestUrl(input.origin, request.id);
    await tx.insert(schema.auditEvents).values({
      action: "access_request.created",
      actorId: input.caller.userId,
      actorType: via === "cli" ? "cli" : "user",
      afterJson: { request: sanitizeRequest(request) },
      metadataJson: {
        source: SOURCE,
        via,
        ...(input.caller.cli
          ? {
              agentId: input.caller.cli.agentId ?? null,
              installationId: input.caller.cli.installationId,
              requesterOrganizationId: input.caller.cli.organizationId,
            }
          : {}),
      },
      organizationId: site.organizationId,
      projectId: site.projectId,
      requestId: input.requestId,
      targetId: request.id,
      targetType: "access_request",
    });

    const requester = await findUser(tx, input.caller.userId);
    await recordAgentInboxItem(
      {
        actorId: input.caller.userId,
        actorType: "user",
        category: "pages",
        dedupeKey: `pages:access_request:${request.id}:requested`,
        eventType: "pages.access.requested",
        linksJson: { approveUrl: link, pageUrl, requestId: request.id, siteId: site.id },
        occurredAt: now,
        organizationId: site.organizationId,
        payloadJson: {
          host: target.host,
          message,
          path: target.path,
          requestId: request.id,
          requesterEmail: requester?.primaryEmail ?? null,
          requesterName: displayNameFor(requester),
          siteId: site.id,
          via,
        },
        projectId: site.projectId,
        sensitivity: "customer_data",
        severity: "action_required",
        sourceId: request.id,
        sourceType: "access_request",
        summary: `${displayNameFor(requester) ?? "Someone"} asked to see ${target.host}${target.path}. Approve or deny: ${link}`,
        targetId: site.id,
        targetType: "page_site",
        title: "Access requested to a page",
      },
      tx,
    );
    return { created: true, request };
  });

  return {
    created: result.created,
    request: toSummary(result.request, { host: target.host, origin: input.origin }, now),
    status: "requested",
  };
}

export type AccessRequestView =
  | { state: "invalid" }
  | { detail: AccessRequestDetail; state: "approver" }
  | { request: AccessRequestSummary; pageUrl: string; state: "requester" }
  /** Signed in, but neither the requester nor someone who can approve. */
  | { state: "not_allowed" };

/** `GET /access/requests/<id>`: what this viewer may see of the request. Changes nothing. */
export async function getAccessRequestView(input: {
  id: string;
  now?: Date;
  origin: string;
  viewerUserId: string;
}): Promise<AccessRequestView> {
  const now = input.now ?? new Date();
  const loaded = await loadRequest(input.id);
  if (!loaded) return { state: "invalid" };
  const { request, site } = loaded;

  const approver = await approverActor(input.viewerUserId, site);
  if (approver) {
    return { detail: await toDetail(loaded, input.origin, now), state: "approver" };
  }
  if (request.requesterUserId === input.viewerUserId) {
    return {
      pageUrl: `https://${site.defaultHostname}${request.path}`,
      request: toSummary(request, { host: site.defaultHostname, origin: input.origin }, now),
      state: "requester",
    };
  }
  return { state: "not_allowed" };
}

/** Approve (giving the page, or the whole site) or deny. Only people who can share the site decide. */
export async function decideAccessRequest(input: {
  decision: "approve" | "deny";
  id: string;
  now?: Date;
  origin: string;
  requestId: string;
  scope?: "route" | "site";
  viewerUserId: string;
}): Promise<{ request: AccessRequestSummary }> {
  const now = input.now ?? new Date();
  const loaded = await loadRequest(input.id);
  if (!loaded) throw new ConsoleApiError(404, { error: "request_not_found" });
  const { request, site } = loaded;
  const approver = await approverActor(input.viewerUserId, site);
  if (!approver) throw new ConsoleApiError(403, { error: "forbidden" });
  if (request.status !== "pending") throw new ConsoleApiError(409, { error: "request_decided" });
  if (request.expiresAt <= now) throw new ConsoleApiError(409, { error: "request_expired" });

  const requester = input.decision === "approve" ? await findUser(db, request.requesterUserId) : null;
  if (input.decision === "approve" && !requester) throw new ConsoleApiError(404, { error: "request_not_found" });

  // Claim the request first, so a concurrent decision can't leave a grant behind a denied request.
  const status = input.decision === "approve" ? ("approved" as const) : ("denied" as const);
  const [claimed] = await db
    .update(schema.accessRequests)
    .set({ decidedAt: now, decidedByUserId: approver.userId, status, updatedAt: now })
    .where(and(eq(schema.accessRequests.id, request.id), eq(schema.accessRequests.status, "pending")))
    .returning();
  if (!claimed) throw new ConsoleApiError(409, { error: "request_decided" });

  let grantId: string | null = null;
  if (requester) {
    const wholeSite = input.scope === "site" || !request.routeId;
    try {
      const shared = await sharePagesAccess({
        actor: { ...approver, via: { accessRequestId: request.id } },
        body: {
          email: requester.primaryEmail,
          // The share reason is capped at 500 characters, like the request message.
          reason: request.message ? `Asked: ${request.message.slice(0, 493)}` : "Asked for access",
          siteId: site.id,
          ...(wholeSite ? {} : { routeId: request.routeId }),
        },
        now,
        requestId: input.requestId,
      });
      grantId = shared.grant.id;
    } catch (error) {
      await db
        .update(schema.accessRequests)
        .set({ decidedAt: null, decidedByUserId: null, status: "pending", updatedAt: now })
        .where(and(eq(schema.accessRequests.id, request.id), eq(schema.accessRequests.status, status)));
      throw error;
    }
  }

  const decided = await db.transaction(async (tx) => {
    const [updated] = grantId
      ? await tx.update(schema.accessRequests).set({ grantId }).where(eq(schema.accessRequests.id, request.id)).returning()
      : [claimed];
    if (!updated) throw new ConsoleApiError(404, { error: "request_not_found" });

    await tx.insert(schema.auditEvents).values({
      action: status === "approved" ? "access_request.approved" : "access_request.denied",
      actorId: approver.userId,
      actorType: "user",
      afterJson: { request: sanitizeRequest(updated) },
      beforeJson: { request: sanitizeRequest(request) },
      metadataJson: { grantId, scope: grantId ? (input.scope === "site" || !request.routeId ? "site" : "route") : null, source: SOURCE },
      organizationId: site.organizationId,
      projectId: site.projectId,
      requestId: input.requestId,
      targetId: request.id,
      targetType: "access_request",
    });

    // Tell the agent that asked, in its own organization, so it can retry.
    if (status === "approved" && updated.via === "cli" && updated.requesterOrganizationId && updated.localInstallationId) {
      const pageUrl = `https://${site.defaultHostname}${updated.path}`;
      await recordAgentInboxItem(
        {
          actorType: "system",
          category: "pages",
          dedupeKey: `pages:access_request:${updated.id}:approved`,
          eventType: "pages.access.approved",
          linksJson: { pageUrl, requestId: updated.id },
          occurredAt: now,
          organizationId: updated.requesterOrganizationId,
          payloadJson: {
            agentId: updated.agentId,
            host: site.defaultHostname,
            path: updated.path,
            requestId: updated.id,
            requesterUserId: updated.requesterUserId,
          },
          sensitivity: "metadata",
          severity: "success",
          sourceId: updated.id,
          sourceType: "access_request",
          summary: `Access to ${pageUrl} was approved.`,
          targetId: updated.localInstallationId,
          targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
          title: "Access request approved",
        },
        tx,
      );
    }
    return updated;
  });

  return { request: toSummary(decided, { host: site.defaultHostname, origin: input.origin }, now) };
}

/** Pending requests for a site, for its sharing panel. */
export async function listSiteAccessRequests(input: {
  actor: AccessActor;
  now?: Date;
  origin: string;
  siteId: string;
}): Promise<{ requests: AccessRequestDetail[] }> {
  const now = input.now ?? new Date();
  const [site] = await db.select().from(schema.pageSites).where(eq(schema.pageSites.id, input.siteId)).limit(1);
  if (!site || site.status === "deleted") throw new ConsoleApiError(404, { error: "site_not_found" });
  await assertCanShareSite(input.actor, site);

  const rows = await db
    .select()
    .from(schema.accessRequests)
    .where(
      and(
        eq(schema.accessRequests.pageSiteId, site.id),
        eq(schema.accessRequests.status, "pending"),
        gt(schema.accessRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.accessRequests.createdAt))
    .limit(100);
  const [organization] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, site.organizationId))
    .limit(1);
  const users = await findUsers(rows.map((row) => row.requesterUserId));
  const requests = rows.flatMap((request) => {
    const requester = users.get(request.requesterUserId);
    if (!requester || !organization) return [];
    return [detailFrom({ organization, request, site }, requester, input.origin, now)];
  });
  return { requests };
}

/** `GET /api/cli/access/requests/<id>`: only the installation that asked, or its requester. */
export async function getAccessRequestForCli(input: {
  id: string;
  installationId: string;
  now?: Date;
  origin: string;
  userIds: string[];
}): Promise<{ request: AccessRequestSummary }> {
  const loaded = await loadRequest(input.id);
  if (
    !loaded ||
    (loaded.request.localInstallationId !== input.installationId &&
      !input.userIds.includes(loaded.request.requesterUserId))
  ) {
    throw new ConsoleApiError(404, { error: "request_not_found" });
  }
  return {
    request: toSummary(loaded.request, { host: loaded.site.defaultHostname, origin: input.origin }, input.now ?? new Date()),
  };
}

export function accessRequestUrl(origin: string, id: string) {
  return new URL(`/access/requests/${id}`, origin).toString();
}

export function isAccessRequestId(value: string | null | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

/** Members who read the project, and people given the page, already see it. */
async function userCanViewTarget(userId: string, target: PageTarget, now: Date) {
  const member = await memberActorForOrganization({ organizationId: target.site.organizationId, userId });
  if (
    member &&
    (await canAccessProject(
      { membership: { role: member.role }, organization: { id: member.organizationId }, user: { id: userId } },
      target.site.projectId,
      "read",
    ))
  ) {
    return true;
  }
  return canUserViewPagesRoute({ now, routeId: target.route?.routeId ?? null, siteId: target.site.id, userId });
}

async function approverActor(userId: string, site: Pick<SiteRecord, "organizationId" | "projectId">) {
  const actor = await memberActorForOrganization({ organizationId: site.organizationId, userId });
  if (!actor) return null;
  try {
    await assertCanShareSite(actor, site);
    return actor;
  } catch (error) {
    if (error instanceof ConsoleApiError) return null;
    throw error;
  }
}

type LoadedRequest = {
  organization: typeof schema.organizations.$inferSelect;
  request: RequestRecord;
  site: SiteRecord;
};

async function loadRequest(id: string): Promise<LoadedRequest | null> {
  if (!isAccessRequestId(id)) return null;
  const [row] = await db
    .select({ organization: schema.organizations, request: schema.accessRequests, site: schema.pageSites })
    .from(schema.accessRequests)
    .innerJoin(schema.pageSites, eq(schema.pageSites.id, schema.accessRequests.pageSiteId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accessRequests.organizationId))
    .where(eq(schema.accessRequests.id, id))
    .limit(1);
  if (!row || row.site.status === "deleted") return null;
  return row;
}

async function toDetail(loaded: LoadedRequest, origin: string, now: Date): Promise<AccessRequestDetail> {
  const requester = await findUser(db, loaded.request.requesterUserId);
  if (!requester) throw new ConsoleApiError(404, { error: "request_not_found" });
  return detailFrom(loaded, requester, origin, now);
}

function detailFrom(
  loaded: LoadedRequest,
  requester: typeof schema.users.$inferSelect,
  origin: string,
  now: Date,
): AccessRequestDetail {
  const { organization, request, site } = loaded;
  return {
    ...toSummary(request, { host: site.defaultHostname, origin }, now),
    agentName: request.agentName,
    message: request.message,
    organizationName: organization.name,
    pageUrl: `https://${site.defaultHostname}${request.path}`,
    requester: { email: requester.primaryEmail, name: requester.displayName },
    routeMatched: Boolean(request.routeId),
    siteId: site.id,
    via: request.via,
  };
}

function toSummary(request: RequestRecord, context: { host: string; origin: string }, now: Date): AccessRequestSummary {
  return {
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    expiresAt: request.expiresAt.toISOString(),
    host: context.host,
    id: request.id,
    path: request.path,
    status: request.status === "pending" && request.expiresAt <= now ? "expired" : request.status,
    url: accessRequestUrl(context.origin, request.id),
  };
}

async function findUser(executor: Pick<typeof db, "select">, userId: string) {
  const [user] = await executor.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user ?? null;
}

async function findUsers(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

function sanitizeRequest(request: RequestRecord) {
  return {
    decidedAt: request.decidedAt?.toISOString() ?? null,
    grantId: request.grantId,
    id: request.id,
    path: request.path,
    requester: `user:${request.requesterUserId}`,
    routeId: request.routeId,
    siteId: request.pageSiteId,
    status: request.status,
    via: request.via,
  };
}

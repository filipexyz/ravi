// The agent directory and requests between agents (Library phase 5). Each
// linked installation reports its agents through pin sync; the directory lists
// them to the org's members (only the projects they read), and an agent of one
// installation asks an agent of another for help. The Console only stores and
// relays the text: the target installation's Ravi runs the turn, as the
// requesting person, and only for agents its operator opened to requests. See
// `.ravi/specs/console/library`.

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { listAccessibleProjectRecords } from "@/server/console/project-access";
import { db, schema } from "@/server/db";

import { agentSchema, parseBody } from "./proposals";
import {
  assertLibraryFeature,
  conflict,
  findProject,
  iso,
  notFound,
  PROPOSING_ORG_ROLES,
  type LibraryActor,
  type LibraryWorkspace,
} from "./service";

/** An agent counts as online when its installation reported it this recently. */
export const DIRECTORY_ONLINE_MS = 15 * 60 * 1000;
export const AGENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_REQUEST_MESSAGE_MAX = 8_000;
export const AGENT_REQUEST_REPLY_MAX = 16_000;
/** Pending or delivered requests one installation may have out at once. */
export const AGENT_REQUEST_OPEN_MAX = 20;
const PULL_LIMIT = 50;
const LIST_LIMIT = 100;

const OPEN_STATUSES = ["pending", "delivered"] as const;
const CLOSED_STATUSES = ["answered", "failed", "expired", "cancelled"] as const;
type RequestStatus = (typeof OPEN_STATUSES)[number] | (typeof CLOSED_STATUSES)[number];

const sendBodySchema = z
  .object({
    to: z.object({ installationId: z.string().uuid(), agentId: z.string().trim().min(1).max(120) }).strict(),
    message: z.string().trim().min(1).max(AGENT_REQUEST_MESSAGE_MAX),
    agent: agentSchema.optional(),
  })
  .strict();

const replyBodySchema = z
  .object({
    reply: z.string().trim().min(1).max(AGENT_REQUEST_REPLY_MAX).optional(),
    failure: z.string().trim().min(1).max(500).optional(),
    agent: agentSchema.optional(),
  })
  .strict()
  .refine((body) => Boolean(body.reply) !== Boolean(body.failure), { message: "Send either reply or failure." });

const emptyBodySchema = z.object({ agent: agentSchema.optional() }).strict();

type RequestRow = typeof schema.agentRequests.$inferSelect;

// ---------------------------------------------------------------------------
// Directory

/**
 * Agents the caller may see: org-wide agents and those of the projects the
 * caller reads (only org-wide and `project`'s when given), on the org's active
 * installations. Never instructions, paths or credentials.
 */
export async function listAgentDirectory(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  query: string | null;
  projectRef: string | null;
}) {
  await assertLibraryFeature(input.workspace);
  const visible = await visibleProjectIds(input.workspace, input.projectRef);
  const terms = (input.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const match = terms.map((term) => {
    const like = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return or(
      sql`lower(${schema.installationAgents.agentId}) LIKE ${like}`,
      sql`lower(coalesce(${schema.installationAgents.name}, '')) LIKE ${like}`,
      sql`lower(coalesce(${schema.installationAgents.description}, '')) LIKE ${like}`,
      sql`lower(${schema.localInstallations.name}) LIKE ${like}`,
    );
  });
  const rows = await db
    .select({
      agent: schema.installationAgents,
      installationName: schema.localInstallations.name,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
    })
    .from(schema.installationAgents)
    .innerJoin(schema.localInstallations, eq(schema.localInstallations.id, schema.installationAgents.localInstallationId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.installationAgents.projectId))
    .where(
      and(
        eq(schema.installationAgents.organizationId, input.workspace.organization.id),
        eq(schema.localInstallations.organizationId, input.workspace.organization.id),
        isNull(schema.localInstallations.revokedAt),
        eq(schema.localInstallations.status, "active"),
        visible.length
          ? or(isNull(schema.installationAgents.projectId), inArray(schema.installationAgents.projectId, visible))
          : isNull(schema.installationAgents.projectId),
        ...match,
      ),
    )
    .orderBy(desc(schema.installationAgents.acceptsRequests), asc(schema.localInstallations.name), asc(schema.installationAgents.agentId))
    .limit(500);
  const now = Date.now();
  return {
    agents: rows.map((row) => ({
      installation: { id: row.agent.localInstallationId, name: row.installationName },
      agent: {
        id: row.agent.agentId,
        name: row.agent.name ?? row.agent.agentId,
        description: row.agent.description,
        provider: row.agent.provider,
        model: row.agent.model,
        project:
          row.agent.projectId && row.projectSlug
            ? { id: row.agent.projectId, slug: row.projectSlug, name: row.projectName ?? row.projectSlug }
            : null,
      },
      online: now - row.agent.reportedAt.getTime() <= DIRECTORY_ONLINE_MS,
      acceptsRequests: row.agent.acceptsRequests,
      reportedAt: row.agent.reportedAt.toISOString(),
      self: row.agent.localInstallationId === input.actor.localInstallationId,
    })),
    can: { ask: PROPOSING_ORG_ROLES.has(input.workspace.membership.role) },
  };
}

async function visibleProjectIds(workspace: LibraryWorkspace, projectRef: string | null) {
  if (projectRef) {
    const project = await findProject(workspace, projectRef, "read");
    if (!project) throw notFound("Project not found.");
    return [project.id];
  }
  return (await listAccessibleProjectRecords(workspace)).map((project) => project.id);
}

// ---------------------------------------------------------------------------
// Requests

async function callerInstallation(workspace: LibraryWorkspace, actor: LibraryActor) {
  if (!actor.localInstallationId) {
    throw conflict("no_installation", "Requests go between linked Ravi installations. Run `ravi login` on the daemon.");
  }
  const [installation] = await db
    .select({ id: schema.localInstallations.id, name: schema.localInstallations.name })
    .from(schema.localInstallations)
    .where(
      and(
        eq(schema.localInstallations.id, actor.localInstallationId),
        eq(schema.localInstallations.organizationId, workspace.organization.id),
        isNull(schema.localInstallations.revokedAt),
      ),
    )
    .limit(1);
  if (!installation) throw conflict("no_installation", "This login's installation is not active in this organization.");
  return installation;
}

/** Ask an agent on another installation; it answers through its own Ravi. */
export async function sendAgentRequest(input: { workspace: LibraryWorkspace; actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(sendBodySchema, input.body, "request");
  if (!PROPOSING_ORG_ROLES.has(input.workspace.membership.role)) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Owners, admins and developers send requests to agents.");
  }
  const from = await callerInstallation(input.workspace, input.actor);
  const organizationId = input.workspace.organization.id;
  const [target] = await db
    .select({ agent: schema.installationAgents, installationName: schema.localInstallations.name })
    .from(schema.installationAgents)
    .innerJoin(schema.localInstallations, eq(schema.localInstallations.id, schema.installationAgents.localInstallationId))
    .where(
      and(
        eq(schema.installationAgents.organizationId, organizationId),
        eq(schema.installationAgents.localInstallationId, body.to.installationId),
        eq(schema.installationAgents.agentId, body.to.agentId),
        isNull(schema.localInstallations.revokedAt),
        eq(schema.localInstallations.status, "active"),
      ),
    )
    .limit(1);
  // An agent of a project the caller can't read is as missing as one that doesn't exist.
  if (!target) throw notFound("Agent not found in the directory.");
  if (target.agent.projectId) {
    const project = await findProject(input.workspace, target.agent.projectId, "read");
    if (!project) throw notFound("Agent not found in the directory.");
  }
  if (target.agent.localInstallationId === from.id) {
    throw conflict("same_installation", "That agent runs on this same Ravi. Use `ravi sessions send` instead.");
  }
  if (!target.agent.acceptsRequests) {
    throw conflict("not_accepting", `${target.agent.name ?? target.agent.agentId} on ${target.installationName} does not take requests.`);
  }

  const now = new Date();
  const request = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-requests:${from.id}`}))`);
    const [open] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.agentRequests)
      .where(
        and(
          eq(schema.agentRequests.fromInstallationId, from.id),
          inArray(schema.agentRequests.status, [...OPEN_STATUSES]),
          sql`${schema.agentRequests.expiresAt} > now()`,
        ),
      );
    if ((open?.count ?? 0) >= AGENT_REQUEST_OPEN_MAX) {
      throw conflict("too_many_open", `This Ravi already has ${AGENT_REQUEST_OPEN_MAX} requests waiting for an answer.`);
    }
    const [row] = await tx
      .insert(schema.agentRequests)
      .values({
        organizationId,
        projectId: target.agent.projectId,
        fromInstallationId: from.id,
        fromAgentId: body.agent?.id ?? null,
        fromUserId: input.workspace.user.id,
        toInstallationId: target.agent.localInstallationId,
        toAgentId: target.agent.agentId,
        message: body.message,
        expiresAt: new Date(now.getTime() + AGENT_REQUEST_TTL_MS),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("agent request insert returned no row");
    await tx.insert(schema.auditEvents).values(requestAudit(input, row, "agents.request.sent", { toAgentId: row.toAgentId }));
    return row;
  });
  return { status: 201, payload: { request: (await serializeRequests([request], from.id))[0] } };
}

/** The caller installation's requests: `received` (to its agents) or `sent` (default). */
export async function listAgentRequests(input: {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  box: string | null;
  state: string | null;
}) {
  await assertLibraryFeature(input.workspace);
  const installation = await callerInstallation(input.workspace, input.actor);
  await expireRequests(input.workspace.organization.id);
  const received = input.box === "received";
  if (input.box && input.box !== "received" && input.box !== "sent") {
    throw cliApiError(400, "PAYLOAD_INVALID", "box is sent or received.");
  }
  const statuses: readonly RequestStatus[] | null =
    input.state === "all" ? null : input.state === "closed" ? CLOSED_STATUSES : OPEN_STATUSES;
  if (input.state && !["open", "closed", "all"].includes(input.state)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "state is open, closed or all.");
  }
  const rows = await db
    .select()
    .from(schema.agentRequests)
    .where(
      and(
        eq(schema.agentRequests.organizationId, input.workspace.organization.id),
        received
          ? eq(schema.agentRequests.toInstallationId, installation.id)
          : eq(schema.agentRequests.fromInstallationId, installation.id),
        statuses ? inArray(schema.agentRequests.status, [...statuses]) : undefined,
      ),
    )
    .orderBy(desc(schema.agentRequests.createdAt))
    .limit(LIST_LIMIT);
  return { installation, requests: await serializeRequests(rows, installation.id) };
}

export async function showAgentRequest(input: { workspace: LibraryWorkspace; actor: LibraryActor; id: string }) {
  await assertLibraryFeature(input.workspace);
  const installation = await callerInstallation(input.workspace, input.actor);
  await expireRequests(input.workspace.organization.id);
  const row = await findInvolvedRequest(input.workspace, installation.id, input.id);
  return { request: (await serializeRequests([row], installation.id))[0] };
}

/** Target side: take the requests waiting for this installation's agents, marking them delivered. */
export async function pullAgentRequests(input: { workspace: LibraryWorkspace; actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  parseBody(emptyBodySchema, input.body ?? {}, "pull");
  const installation = await callerInstallation(input.workspace, input.actor);
  await expireRequests(input.workspace.organization.id);
  const rows = await db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: schema.agentRequests.id })
      .from(schema.agentRequests)
      .where(
        and(
          eq(schema.agentRequests.toInstallationId, installation.id),
          eq(schema.agentRequests.status, "pending"),
          sql`${schema.agentRequests.expiresAt} > now()`,
        ),
      )
      .orderBy(asc(schema.agentRequests.createdAt))
      .limit(PULL_LIMIT)
      .for("update", { skipLocked: true });
    if (pending.length === 0) return [];
    const now = new Date();
    return tx
      .update(schema.agentRequests)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(inArray(schema.agentRequests.id, pending.map((row) => row.id)))
      .returning();
  });
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { installation, requests: await serializeRequests(rows, installation.id) };
}

/** Target side: answer a delivered request, or say why it couldn't be. */
export async function replyAgentRequest(input: { workspace: LibraryWorkspace; actor: LibraryActor; id: string; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(replyBodySchema, input.body, "reply");
  const installation = await callerInstallation(input.workspace, input.actor);
  await expireRequests(input.workspace.organization.id);
  const row = await findInvolvedRequest(input.workspace, installation.id, input.id);
  if (row.toInstallationId !== installation.id) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the Ravi running the asked agent answers a request.");
  }
  if (row.status !== "delivered" && row.status !== "pending") {
    throw conflict("not_open", `This request is already ${row.status}.`, { status: row.status });
  }
  const now = new Date();
  const [updated] = await db
    .update(schema.agentRequests)
    .set(
      body.reply
        ? { status: "answered", reply: body.reply, answeredAt: now, deliveredAt: row.deliveredAt ?? now, updatedAt: now }
        : { status: "failed", failureReason: body.failure, answeredAt: now, deliveredAt: row.deliveredAt ?? now, updatedAt: now },
    )
    .where(and(eq(schema.agentRequests.id, row.id), inArray(schema.agentRequests.status, [...OPEN_STATUSES])))
    .returning();
  if (!updated) throw conflict("not_open", "This request was closed meanwhile.");
  await db
    .insert(schema.auditEvents)
    .values(requestAudit(input, updated, body.reply ? "agents.request.answered" : "agents.request.failed", {}));
  return { request: (await serializeRequests([updated], installation.id))[0] };
}

/** Sender side: withdraw a request nobody has taken yet. */
export async function cancelAgentRequest(input: { workspace: LibraryWorkspace; actor: LibraryActor; id: string; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  parseBody(emptyBodySchema, input.body ?? {}, "cancel");
  const installation = await callerInstallation(input.workspace, input.actor);
  const row = await findInvolvedRequest(input.workspace, installation.id, input.id);
  if (row.fromInstallationId !== installation.id) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the Ravi that sent a request cancels it.");
  }
  const now = new Date();
  const [updated] = await db
    .update(schema.agentRequests)
    .set({ status: "cancelled", updatedAt: now, replyDeliveredAt: now })
    .where(and(eq(schema.agentRequests.id, row.id), eq(schema.agentRequests.status, "pending")))
    .returning();
  if (!updated) throw conflict("not_pending", "Only a request its agent hasn't taken yet can be cancelled.", { status: row.status });
  await db.insert(schema.auditEvents).values(requestAudit(input, updated, "agents.request.cancelled", {}));
  return { request: (await serializeRequests([updated], installation.id))[0] };
}

/** Sender side: take the answers (and failures, expiries) not yet handed back to the asking agent. */
export async function pullAgentReplies(input: { workspace: LibraryWorkspace; actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  parseBody(emptyBodySchema, input.body ?? {}, "pull");
  const installation = await callerInstallation(input.workspace, input.actor);
  await expireRequests(input.workspace.organization.id);
  const rows = await db.transaction(async (tx) => {
    const ready = await tx
      .select({ id: schema.agentRequests.id })
      .from(schema.agentRequests)
      .where(
        and(
          eq(schema.agentRequests.fromInstallationId, installation.id),
          inArray(schema.agentRequests.status, ["answered", "failed", "expired"]),
          isNull(schema.agentRequests.replyDeliveredAt),
        ),
      )
      .orderBy(asc(schema.agentRequests.updatedAt))
      .limit(PULL_LIMIT)
      .for("update", { skipLocked: true });
    if (ready.length === 0) return [];
    const now = new Date();
    return tx
      .update(schema.agentRequests)
      .set({ replyDeliveredAt: now })
      .where(inArray(schema.agentRequests.id, ready.map((row) => row.id)))
      .returning();
  });
  rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  return { installation, requests: await serializeRequests(rows, installation.id) };
}

async function findInvolvedRequest(workspace: LibraryWorkspace, installationId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Request not found.");
  const [row] = await db
    .select()
    .from(schema.agentRequests)
    .where(
      and(
        eq(schema.agentRequests.id, id),
        eq(schema.agentRequests.organizationId, workspace.organization.id),
        or(eq(schema.agentRequests.fromInstallationId, installationId), eq(schema.agentRequests.toInstallationId, installationId)),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Request not found.");
  return row;
}

/** Requests nobody answered in time become `expired`; the sender still gets told. */
async function expireRequests(organizationId: string) {
  await db
    .update(schema.agentRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentRequests.organizationId, organizationId),
        inArray(schema.agentRequests.status, [...OPEN_STATUSES]),
        lt(schema.agentRequests.expiresAt, new Date()),
      ),
    );
}

async function serializeRequests(rows: RequestRow[], installationId: string) {
  if (rows.length === 0) return [];
  const installationIds = [
    ...new Set(rows.flatMap((row) => [row.fromInstallationId, row.toInstallationId]).filter((id): id is string => Boolean(id))),
  ];
  const userIds = [...new Set(rows.map((row) => row.fromUserId).filter((id): id is string => Boolean(id)))];
  const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))];
  const [installations, users, projects] = await Promise.all([
    db
      .select({ id: schema.localInstallations.id, name: schema.localInstallations.name })
      .from(schema.localInstallations)
      .where(inArray(schema.localInstallations.id, installationIds)),
    userIds.length
      ? db
          .select({ id: schema.users.id, name: schema.users.displayName })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
          .from(schema.projects)
          .where(inArray(schema.projects.id, projectIds))
      : Promise.resolve([]),
  ]);
  const installationName = new Map(installations.map((row) => [row.id, row.name]));
  const userName = new Map(users.map((row) => [row.id, row.name]));
  const projectById = new Map(projects.map((row) => [row.id, row]));
  return rows.map((row) => ({
    id: row.id,
    status: row.status as RequestStatus,
    direction: row.toInstallationId === installationId ? ("received" as const) : ("sent" as const),
    from: {
      installation: row.fromInstallationId
        ? { id: row.fromInstallationId, name: installationName.get(row.fromInstallationId) ?? null }
        : null,
      agentId: row.fromAgentId,
      user: row.fromUserId ? { id: row.fromUserId, name: userName.get(row.fromUserId) ?? null } : null,
    },
    to: {
      installation: { id: row.toInstallationId, name: installationName.get(row.toInstallationId) ?? null },
      agentId: row.toAgentId,
    },
    project: row.projectId ? (projectById.get(row.projectId) ?? null) : null,
    message: row.message,
    reply: row.reply,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: iso(row.deliveredAt),
    answeredAt: iso(row.answeredAt),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

function requestAudit(
  input: { workspace: LibraryWorkspace; actor: LibraryActor },
  row: RequestRow,
  action: string,
  after: Record<string, unknown>,
): typeof schema.auditEvents.$inferInsert {
  // Message and reply text stay out of the audit trail; the request row holds them.
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    actorType: input.actor.surface === "cli" ? "cli" : "user",
    actorId: input.workspace.user.id,
    targetType: "agent_request",
    targetId: row.id,
    action,
    requestId: input.actor.requestId,
    afterJson: { status: row.status, toInstallationId: row.toInstallationId, ...after },
    metadataJson: {
      surface: input.actor.surface,
      ...(input.actor.localInstallationId ? { localInstallationId: input.actor.localInstallationId } : {}),
    },
  };
}


// Library pins (phase 3): a scope admin pins a skill to one agent of one linked
// installation, and that installation's Ravi keeps it loaded for that agent.
// Installations report their agents through pin sync, which also answers the
// pins that apply to them. See `.ravi/specs/console/library`.

import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { agentSchema, assertNotAgent, findItemForProposals, lockKey, parseBody } from "./proposals";
import {
  assertLibraryFeature,
  auditEvent,
  conflict,
  findProject,
  iso,
  notFound,
  scopeRoles,
  selectItems,
  serializeLibraryItem,
  summarizeProject,
  type LibraryActor,
  type LibraryKind,
  type LibraryWorkspace,
} from "./service";

export const INSTALLATION_AGENTS_MAX = 500;

const agentIdSchema = z.string().trim().min(1).max(120);

const pinBodySchema = z
  .object({
    agentId: agentIdSchema,
    installationId: z.string().uuid().optional(),
    agent: agentSchema.optional(),
  })
  .strict();

const syncBodySchema = z
  .object({
    agents: z
      .array(
        z
          .object({
            id: agentIdSchema,
            name: z.string().trim().max(120).nullish(),
            provider: z.string().trim().max(60).nullish(),
            model: z.string().trim().max(120).nullish(),
            project: z.string().trim().max(200).nullish(),
            description: z.string().trim().max(300).nullish(),
            acceptsRequests: z.boolean().optional(),
          })
          .strict(),
      )
      .max(INSTALLATION_AGENTS_MAX),
  })
  .strict();

type ItemInput = { workspace: LibraryWorkspace; kind: LibraryKind; scopeRef: string; slug: string };

// ---------------------------------------------------------------------------
// Installations

async function findOrgInstallation(workspace: LibraryWorkspace, installationId: string) {
  const [installation] = await db
    .select({ id: schema.localInstallations.id, name: schema.localInstallations.name })
    .from(schema.localInstallations)
    .where(
      and(
        eq(schema.localInstallations.id, installationId),
        eq(schema.localInstallations.organizationId, workspace.organization.id),
        isNull(schema.localInstallations.revokedAt),
      ),
    )
    .limit(1);
  return installation ?? null;
}

async function callerInstallation(workspace: LibraryWorkspace, actor: LibraryActor) {
  if (!actor.localInstallationId) {
    throw conflict("no_installation", "This login is not linked to a Ravi installation. Run `ravi login` again on the daemon.");
  }
  const installation = await findOrgInstallation(workspace, actor.localInstallationId);
  if (!installation) throw conflict("no_installation", "This login's installation is not active in this organization.");
  return installation;
}

async function targetInstallation(workspace: LibraryWorkspace, actor: LibraryActor, installationId: string | undefined) {
  if (!installationId) return callerInstallation(workspace, actor);
  const installation = await findOrgInstallation(workspace, installationId);
  if (!installation) throw notFound("Installation not found.");
  return installation;
}

/** The org's active installations and the agents each reported, for the pin picker. */
export async function listLibraryInstallations(input: { workspace: LibraryWorkspace; projectRef: string | null }) {
  await assertLibraryFeature(input.workspace);
  const project = input.projectRef ? await findProject(input.workspace, input.projectRef, "read") : null;
  if (input.projectRef && !project) throw notFound("Project not found.");
  const roles = await scopeRoles(input.workspace, project?.id ?? null);
  if (!roles.canReview) throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the scope's admins pin skills.");
  const installations = await db
    .select({
      id: schema.localInstallations.id,
      name: schema.localInstallations.name,
      lastSeenAt: schema.localInstallations.lastSeenAt,
    })
    .from(schema.localInstallations)
    .where(
      and(
        eq(schema.localInstallations.organizationId, input.workspace.organization.id),
        isNull(schema.localInstallations.revokedAt),
        eq(schema.localInstallations.status, "active"),
      ),
    )
    .orderBy(asc(schema.localInstallations.name));
  const agents = installations.length
    ? await db
        .select({
          agent: schema.installationAgents,
          projectSlug: schema.projects.slug,
          projectName: schema.projects.name,
        })
        .from(schema.installationAgents)
        .leftJoin(schema.projects, eq(schema.projects.id, schema.installationAgents.projectId))
        .where(
          and(
            inArray(
              schema.installationAgents.localInstallationId,
              installations.map((installation) => installation.id),
            ),
            project ? eq(schema.installationAgents.projectId, project.id) : undefined,
          ),
        )
        .orderBy(asc(schema.installationAgents.agentId))
    : [];
  return {
    project: project ? summarizeProject(project) : null,
    installations: installations
      .map((installation) => ({
        id: installation.id,
        name: installation.name,
        lastSeenAt: iso(installation.lastSeenAt),
        agents: agents
          .filter((row) => row.agent.localInstallationId === installation.id)
          .map((row) => serializeInstallationAgent(row.agent, row.projectSlug, row.projectName)),
      }))
      .filter((installation) => installation.agents.length > 0),
  };
}

function serializeInstallationAgent(
  agent: typeof schema.installationAgents.$inferSelect,
  projectSlug: string | null,
  projectName: string | null,
) {
  return {
    id: agent.agentId,
    name: agent.name ?? agent.agentId,
    provider: agent.provider,
    model: agent.model,
    project: agent.projectId && projectSlug ? { id: agent.projectId, slug: projectSlug, name: projectName ?? projectSlug } : null,
    reportedAt: agent.reportedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// An item's pins

export async function listItemPins(input: ItemInput) {
  await assertLibraryFeature(input.workspace);
  const context = await findItemForProposals(input);
  const rows = await db
    .select({
      pin: schema.libraryPins,
      installationName: schema.localInstallations.name,
      agentName: schema.installationAgents.name,
      agentProjectId: schema.installationAgents.projectId,
      agentReported: schema.installationAgents.id,
      projectSlug: schema.projects.slug,
      projectName: schema.projects.name,
      pinnedByName: schema.users.displayName,
    })
    .from(schema.libraryPins)
    .innerJoin(schema.localInstallations, eq(schema.localInstallations.id, schema.libraryPins.localInstallationId))
    .leftJoin(
      schema.installationAgents,
      and(
        eq(schema.installationAgents.localInstallationId, schema.libraryPins.localInstallationId),
        eq(schema.installationAgents.agentId, schema.libraryPins.agentId),
      ),
    )
    .leftJoin(schema.projects, eq(schema.projects.id, schema.installationAgents.projectId))
    .leftJoin(schema.users, eq(schema.users.id, schema.libraryPins.pinnedByUserId))
    .where(and(eq(schema.libraryPins.itemId, context.item.id), isNull(schema.localInstallations.revokedAt)))
    .orderBy(asc(schema.localInstallations.name), asc(schema.libraryPins.agentId));
  return {
    item: { ref: `${context.project ? context.project.slug : "org"}/${context.item.slug}` },
    can: { pin: context.roles.canReview },
    pins: rows.map((row) => ({
      id: row.pin.id,
      installation: { id: row.pin.localInstallationId, name: row.installationName },
      agent: {
        id: row.pin.agentId,
        name: row.agentName ?? row.pin.agentId,
        project: row.agentProjectId && row.projectSlug ? { id: row.agentProjectId, slug: row.projectSlug, name: row.projectName ?? row.projectSlug } : null,
        reported: row.agentReported !== null,
      },
      pinnedBy: row.pinnedByName ? { name: row.pinnedByName } : null,
      createdAt: row.pin.createdAt.toISOString(),
    })),
  };
}

export async function pinLibraryItem(input: ItemInput & { actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(pinBodySchema, input.body, "pin");
  assertNotAgent(body.agent, "pin");
  const context = await findItemForProposals(input);
  if (!context.roles.canReview) throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the scope's admins pin skills.");
  const installation = await targetInstallation(input.workspace, input.actor, body.installationId);
  const organizationId = input.workspace.organization.id;
  return db.transaction(async (tx) => {
    await tx.execute(lockKey(organizationId, input.kind, context.item.slug));
    const [item] = await tx.select().from(schema.libraryItems).where(eq(schema.libraryItems.id, context.item.id)).limit(1);
    if (!item || item.archivedAt || item.currentVersionNumber === null) {
      throw conflict("not_published", "Only a published, non-archived skill can be pinned.");
    }
    const [agent] = await tx
      .select()
      .from(schema.installationAgents)
      .where(
        and(
          eq(schema.installationAgents.localInstallationId, installation.id),
          eq(schema.installationAgents.agentId, body.agentId),
        ),
      )
      .limit(1);
    if (!agent) throw notFound(`Agent ${body.agentId} was not reported by installation ${installation.name}.`);
    if (item.projectId && agent.projectId !== item.projectId) {
      throw conflict("agent_out_of_scope", `Agent ${body.agentId} is not bound to this skill's project.`);
    }
    const [existing] = await tx
      .select()
      .from(schema.libraryPins)
      .where(
        and(
          eq(schema.libraryPins.itemId, item.id),
          eq(schema.libraryPins.localInstallationId, installation.id),
          eq(schema.libraryPins.agentId, body.agentId),
        ),
      )
      .limit(1);
    const view = (pin: typeof schema.libraryPins.$inferSelect) => ({
      id: pin.id,
      installation,
      agent: { id: pin.agentId, name: agent.name ?? pin.agentId },
      createdAt: pin.createdAt.toISOString(),
    });
    if (existing) return { status: 200, payload: { pin: view(existing), created: false } };
    const [pin] = await tx
      .insert(schema.libraryPins)
      .values({
        organizationId,
        itemId: item.id,
        localInstallationId: installation.id,
        agentId: body.agentId,
        pinnedByUserId: input.workspace.user.id,
      })
      .returning();
    await tx.insert(schema.auditEvents).values(
      auditEvent(input, {
        organizationId,
        projectId: item.projectId,
        itemId: item.id,
        action: `library.${input.kind}.pinned`,
        before: null,
        after: { installationId: installation.id, agentId: body.agentId },
      }),
    );
    return { status: 201, payload: { pin: view(pin!), created: true } };
  });
}

export async function unpinLibraryItem(input: ItemInput & { actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(pinBodySchema, input.body, "unpin");
  assertNotAgent(body.agent, "unpin");
  const context = await findItemForProposals(input);
  if (!context.roles.canReview) throw cliApiError(403, "ORG_ACCESS_DENIED", "Only the scope's admins unpin skills.");
  const installation = await targetInstallation(input.workspace, input.actor, body.installationId);
  const organizationId = input.workspace.organization.id;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.libraryPins)
      .where(
        and(
          eq(schema.libraryPins.itemId, context.item.id),
          eq(schema.libraryPins.localInstallationId, installation.id),
          eq(schema.libraryPins.agentId, body.agentId),
        ),
      )
      .returning({ id: schema.libraryPins.id });
    if (removed.length > 0) {
      await tx.insert(schema.auditEvents).values(
        auditEvent(input, {
          organizationId,
          projectId: context.item.projectId,
          itemId: context.item.id,
          action: `library.${input.kind}.unpinned`,
          before: { installationId: installation.id, agentId: body.agentId },
          after: {},
        }),
      );
    }
    return { status: 200, payload: { removed: removed.length > 0 } };
  });
}

// ---------------------------------------------------------------------------
// Installation sync

/** Replace the caller installation's reported agents, then answer its pins. */
export async function syncInstallationPins(input: { workspace: LibraryWorkspace; actor: LibraryActor; body: unknown }) {
  await assertLibraryFeature(input.workspace);
  const body = parseBody(syncBodySchema, input.body, "pin sync");
  const installation = await callerInstallation(input.workspace, input.actor);
  const organizationId = input.workspace.organization.id;

  const projectIds = new Map<string, string | null>();
  for (const agent of body.agents) {
    const ref = agent.project?.trim();
    if (!ref || projectIds.has(ref)) continue;
    const project = await findProject(input.workspace, ref, "read");
    projectIds.set(ref, project?.id ?? null);
  }
  const unique = new Map(body.agents.map((agent) => [agent.id, agent]));
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const agent of unique.values()) {
      const values = {
        name: agent.name ?? null,
        provider: agent.provider ?? null,
        model: agent.model ?? null,
        projectId: agent.project ? (projectIds.get(agent.project.trim()) ?? null) : null,
        description: agent.description || null,
        acceptsRequests: agent.acceptsRequests ?? false,
        reportedAt: now,
        updatedAt: now,
      };
      await tx
        .insert(schema.installationAgents)
        .values({ organizationId, localInstallationId: installation.id, agentId: agent.id, ...values })
        .onConflictDoUpdate({
          target: [schema.installationAgents.localInstallationId, schema.installationAgents.agentId],
          set: values,
        });
    }
    await tx
      .delete(schema.installationAgents)
      .where(
        and(
          eq(schema.installationAgents.localInstallationId, installation.id),
          unique.size > 0 ? notInArray(schema.installationAgents.agentId, [...unique.keys()]) : undefined,
        ),
      );
  });
  return { status: 200, payload: await installationPins(organizationId, installation) };
}

export async function listInstallationPins(input: { workspace: LibraryWorkspace; actor: LibraryActor }) {
  await assertLibraryFeature(input.workspace);
  const installation = await callerInstallation(input.workspace, input.actor);
  return installationPins(input.workspace.organization.id, installation);
}

async function installationPins(organizationId: string, installation: { id: string; name: string }) {
  const pins = await db
    .select({ itemId: schema.libraryPins.itemId, agentId: schema.libraryPins.agentId })
    .from(schema.libraryPins)
    .where(
      and(eq(schema.libraryPins.organizationId, organizationId), eq(schema.libraryPins.localInstallationId, installation.id)),
    );
  const itemIds = [...new Set(pins.map((pin) => pin.itemId))];
  const items = itemIds.length
    ? await selectItems(db, {
        where: and(
          inArray(schema.libraryItems.id, itemIds),
          isNull(schema.libraryItems.archivedAt),
          isNotNull(schema.libraryItems.currentVersionId),
        ),
        limit: itemIds.length,
      })
    : [];
  const viewById = new Map(items.map((row) => [row.item.id, serializeLibraryItem(row)]));
  const applied = pins
    .flatMap((pin) => {
      const item = viewById.get(pin.itemId);
      return item ? [{ agentId: pin.agentId, ref: item.ref, item }] : [];
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.ref.localeCompare(b.ref));
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        applied.map((pin) => [pin.agentId, pin.ref, pin.item.version, pin.item.contentHash, pin.item.externalAllowed]),
      ),
    )
    .digest("hex");
  return { installation: { id: installation.id, name: installation.name }, revision, pins: applied };
}

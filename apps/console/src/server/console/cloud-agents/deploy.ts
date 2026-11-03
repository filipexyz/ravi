// Deploy a Library agent to the cloud provider in one project: resolve the
// Library item and version, compile, upload skills, ensure the project's
// cloud MCP bridge and the agent's environment, then create or update the
// provider agent. A new provider version happens only when what the provider
// sees changes; an unchanged definition is a no-op.

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { listOperationDefinitions } from "@/server/console/operations";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  assertAdminRole,
  assertCloudAgentsEnabled,
  assertCloudProjectAccess,
  CLOUD_ADMIN_ROLES,
  type CloudContext,
  requireCloudProject,
  type ResolvedCloudDeps,
} from "./access";
import {
  canonicalJson,
  type CloudSkillSource,
  cloudSkillRefs,
  type CompiledCloudAgent,
  compileCloudAgent,
  sha256Hex,
} from "./compiler";
import { currentCredential, withOrganizationProvider } from "./credential";
import { cloudError, errorSummary } from "./errors";
import { CLOUD_RAVI_MCP_SERVER, ensureCloudBridge, mcpToolName } from "./mcp";
import type { CloudAgentProvider, ProviderAgentSpec, ProviderEnvironmentSpec } from "./providers/types";
import { recordCloudAudit } from "./records";
import type { CloudAgent } from "./types";

export type CloudAgentRow = typeof schema.cloudAgents.$inferSelect;

/** What `config_json` keeps: the resolved cloud block plus provider-side hashes. */
export type CloudAgentConfig = {
  model: string;
  effort: CompiledCloudAgent["effort"];
  budgetUsd: number;
  networking: "limited" | "unrestricted";
  allowedHosts: string[];
  packages: { apt: string[]; pip: string[]; npm: string[] };
  webSearch: boolean;
  writes: "ask" | "auto";
  raviMcp: boolean;
  mcpServers: { name: string; url: string }[];
  repositories: { repo: string; branch: string | null }[];
  schedule: { cron: string; timezone: string } | null;
  hasHeartbeat: boolean;
  skills: { ref: string; itemId: string; versionId: string; contentHash: string }[];
  warnings: string[];
  bridgeId: string | null;
  /** sha256 of the bridge's Console MCP URL: a new URL redeploys the agent. */
  bridgeUrlHash: string | null;
  /** The organization credential the provider objects were created with; a new key recreates them. */
  credentialId: string | null;
  environmentHash: string;
  agentSpecHash: string;
};

const deployBodySchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    agent: z.string().trim().min(1).max(200),
    version: z.number().int().min(1).optional(),
  })
  .strict();

type LibraryAgent = {
  item: typeof schema.libraryItems.$inferSelect;
  scope: string;
  version: { id: string; versionNumber: number; contentHash: string };
  files: { path: string; content: string }[];
};

export async function deployCloudAgent(ctx: CloudContext, body: unknown): Promise<{ agent: CloudAgent; changed: boolean; warnings: string[] }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const parsed = deployBodySchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send { project, agent: \"<slug>|<itemId>\", version? }.");
  const project = await requireCloudProject(ctx.workspace, parsed.data.project, "write");
  const result = await deployInProject(ctx, deps, {
    project,
    agentRef: parsed.data.agent,
    versionNumber: parsed.data.version ?? null,
  });
  return { agent: await serializeCloudAgentById(result.row.id), changed: result.changed, warnings: result.warnings };
}

/** Deploys (or re-uses) the agent in a project the caller may write; shared by deploy and run start. */
export async function deployInProject(
  ctx: CloudContext,
  deps: ResolvedCloudDeps,
  input: { project: { id: string; slug: string; organizationId: string }; agentRef: string; versionNumber: number | null },
): Promise<{ row: CloudAgentRow; changed: boolean; warnings: string[] }> {
  const organizationId = ctx.workspace.organization.id;
  const library = await resolveLibraryAgent(organizationId, input.project, input.agentRef, input.versionNumber);
  const skills = await resolveLibrarySkills(organizationId, input.project, cloudSkillRefs(library.files));
  const compiled = compileCloudAgent({ files: library.files, skills });
  if (
    (compiled.writes === "auto" || compiled.environment.networking === "unrestricted") &&
    !CLOUD_ADMIN_ROLES.has(ctx.workspace.membership.role)
  ) {
    assertAdminRole(ctx.workspace, "deploy agents with writes: auto or unrestricted networking");
  }

  const [existing] = await db
    .select()
    .from(schema.cloudAgents)
    .where(
      and(
        eq(schema.cloudAgents.projectId, input.project.id),
        eq(schema.cloudAgents.libraryItemId, library.item.id),
        ne(schema.cloudAgents.status, "archived"),
      ),
    )
    .limit(1);
  const previous = (existing?.configJson ?? {}) as Partial<CloudAgentConfig>;
  const credentialId = (await currentCredential(organizationId))?.id ?? null;
  const bridge = compiled.raviMcp
    ? await ensureCloudBridge({
        organizationId,
        projectId: input.project.id,
        userId: ctx.workspace.user.id,
        codec: deps.codec,
        mcpBaseUrl: deps.mcpBaseUrl,
      })
    : null;
  const bridgeUrlHash = bridge ? sha256Hex(bridge.consoleUrl) : null;
  if (
    existing &&
    existing.status === "ready" &&
    existing.compiledHash === compiled.compiledHash &&
    existing.libraryVersionId === library.version.id &&
    existing.providerAgentId &&
    existing.providerEnvironmentId &&
    previous.credentialId === credentialId &&
    (previous.bridgeId ?? null) === (bridge?.id ?? null) &&
    (previous.bridgeUrlHash ?? null) === bridgeUrlHash
  ) {
    return { row: existing, changed: false, warnings: compiled.warnings };
  }
  // Provider objects made with another key belong to another account: start over.
  const reusable = existing && previous.credentialId === credentialId ? existing : null;

  const now = deps.now();
  try {
    const projected = await withOrganizationProvider(organizationId, deps, async (provider) => {
      const skillIds = await ensureProviderSkills(provider, organizationId, credentialId, compiled, skills);

      const environment: ProviderEnvironmentSpec = {
        name: `ravi-${input.project.slug}-${library.item.slug}`.slice(0, 120),
        networking: compiled.environment.networking,
        allowedHosts: compiled.environment.allowedHosts,
        packages: compiled.environment.packages,
        metadata: { ravi_organization: organizationId, ravi_project: input.project.id, ravi_library_item: library.item.id },
      };
      const environmentHash = sha256Hex(canonicalJson(environment));
      const environmentId =
        reusable?.providerEnvironmentId && previous.environmentHash === environmentHash
          ? reusable.providerEnvironmentId
          : (await provider.ensureEnvironment(environment, reusable?.providerEnvironmentId ?? null)).environmentId;

      const spec: ProviderAgentSpec = {
        name: `${library.item.name} (${input.project.slug})`.slice(0, 200),
        description: library.item.description,
        system: compiled.system,
        model: compiled.model,
        effort: compiled.effort,
        webSearch: compiled.webSearch,
        mcpServers: [
          ...(bridge
            ? [
                {
                  name: CLOUD_RAVI_MCP_SERVER,
                  url: bridge.consoleUrl,
                  permission: compiled.writes === "auto" ? ("allow" as const) : ("ask" as const),
                  allowTools: raviReadToolNames(),
                },
              ]
            : []),
          ...compiled.mcpServers.map((server) => ({
            name: server.name,
            url: server.url,
            permission: compiled.writes === "auto" ? ("allow" as const) : ("ask" as const),
            allowTools: [],
          })),
        ],
        skills: compiled.skills.map((skill) => skillIds.get(skill.contentHash)!).filter(Boolean),
        metadata: { ravi_organization: organizationId, ravi_project: input.project.id, ravi_library_item: library.item.id },
      };
      // The bridge token is part of the URL: the hash keeps only the URL's hash.
      const agentSpecHash = sha256Hex(
        canonicalJson({
          ...spec,
          mcpServers: spec.mcpServers.map((server) => ({ ...server, url: server.name === CLOUD_RAVI_MCP_SERVER ? bridgeUrlHash : server.url })),
        }),
      );
      const agent =
        reusable?.providerAgentId && reusable.providerAgentVersion && previous.agentSpecHash === agentSpecHash
          ? { agentId: reusable.providerAgentId, version: reusable.providerAgentVersion }
          : await provider.upsertAgent(
              spec,
              reusable?.providerAgentId && reusable.providerAgentVersion
                ? { agentId: reusable.providerAgentId, version: reusable.providerAgentVersion }
                : null,
            );
      return { skillIds, bridgeId: bridge?.id ?? null, environmentId, environmentHash, agent, agentSpecHash };
    });

    const config: CloudAgentConfig = {
      model: compiled.model,
      effort: compiled.effort,
      budgetUsd: compiled.budgetUsd,
      networking: compiled.environment.networking,
      allowedHosts: compiled.environment.allowedHosts,
      packages: compiled.environment.packages,
      webSearch: compiled.webSearch,
      writes: compiled.writes,
      raviMcp: compiled.raviMcp,
      mcpServers: compiled.mcpServers,
      repositories: compiled.repositories,
      schedule: compiled.schedule,
      hasHeartbeat: compiled.heartbeat !== null,
      skills: compiled.skills.map((skill) => ({ ref: skill.ref, itemId: skill.itemId, versionId: skill.versionId, contentHash: skill.contentHash })),
      warnings: compiled.warnings,
      bridgeId: projected.bridgeId,
      bridgeUrlHash,
      credentialId,
      environmentHash: projected.environmentHash,
      agentSpecHash: projected.agentSpecHash,
    };
    const skillsJson: JsonRecord = {};
    for (const skill of compiled.skills) {
      const provider = projected.skillIds.get(skill.contentHash);
      if (provider) skillsJson[skill.contentHash] = { ...provider, itemId: skill.itemId, ref: skill.ref };
    }
    const values = {
      libraryVersionId: library.version.id,
      libraryVersionNumber: library.version.versionNumber,
      name: library.item.name,
      model: compiled.model,
      providerAgentId: projected.agent.agentId,
      providerAgentVersion: projected.agent.version,
      providerEnvironmentId: projected.environmentId,
      skillsJson,
      compiledHash: compiled.compiledHash,
      configJson: config as unknown as JsonRecord,
      status: "ready",
      lastError: null,
      lastErrorCode: null,
      deployedByUserId: ctx.workspace.user.id,
      deployedAt: now,
      updatedAt: now,
    };
    const row = existing
      ? (await db.update(schema.cloudAgents).set(values).where(eq(schema.cloudAgents.id, existing.id)).returning())[0]!
      : (
          await db
            .insert(schema.cloudAgents)
            .values({ ...values, organizationId, projectId: input.project.id, libraryItemId: library.item.id, provider: "anthropic" })
            .returning()
        )[0]!;
    await recordCloudAudit({
      organizationId,
      projectId: input.project.id,
      actorType: ctx.surface === "cli" ? "cli" : "user",
      actorId: ctx.workspace.user.id,
      action: "cloud_agents.agent.deployed",
      targetType: "cloud_agent",
      targetId: row.id,
      requestId: ctx.requestId,
      before: existing ? { libraryVersionNumber: existing.libraryVersionNumber, compiledHash: existing.compiledHash } : null,
      after: {
        libraryItemId: library.item.id,
        libraryVersionNumber: library.version.versionNumber,
        compiledHash: compiled.compiledHash,
        model: compiled.model,
        writes: compiled.writes,
        networking: compiled.environment.networking,
      },
    });
    return { row, changed: true, warnings: compiled.warnings };
  } catch (error) {
    const summary = errorSummary(error);
    if (existing) {
      await db
        .update(schema.cloudAgents)
        .set({ status: "failed", lastError: summary.message, lastErrorCode: summary.code, updatedAt: now })
        .where(eq(schema.cloudAgents.id, existing.id));
    } else {
      await db
        .insert(schema.cloudAgents)
        .values({
          organizationId,
          projectId: input.project.id,
          libraryItemId: library.item.id,
          libraryVersionId: library.version.id,
          libraryVersionNumber: library.version.versionNumber,
          name: library.item.name,
          model: compiled.model,
          compiledHash: null,
          status: "failed",
          lastError: summary.message,
          lastErrorCode: summary.code,
          deployedByUserId: ctx.workspace.user.id,
        })
        .onConflictDoNothing();
    }
    throw error;
  }
}

/**
 * A ready deployment as a run uses it: redeployed at its own Library version
 * when the organization's key or the project's bridge URL changed since.
 */
export async function freshDeployment(
  ctx: CloudContext,
  deps: ResolvedCloudDeps,
  project: { id: string; slug: string; organizationId: string },
  row: CloudAgentRow,
): Promise<CloudAgentRow> {
  const config = (row.configJson ?? {}) as Partial<CloudAgentConfig>;
  const credentialId = (await currentCredential(row.organizationId))?.id ?? null;
  const bridge =
    config.raviMcp === false
      ? null
      : await ensureCloudBridge({
          organizationId: row.organizationId,
          projectId: row.projectId,
          userId: ctx.workspace.user.id,
          codec: deps.codec,
          mcpBaseUrl: deps.mcpBaseUrl,
        });
  if (
    config.credentialId === credentialId &&
    (config.bridgeId ?? null) === (bridge?.id ?? null) &&
    (config.bridgeUrlHash ?? null) === (bridge ? sha256Hex(bridge.consoleUrl) : null)
  ) {
    return row;
  }
  return (await deployInProject(ctx, deps, { project, agentRef: row.libraryItemId, versionNumber: row.libraryVersionNumber })).row;
}

export async function listCloudAgents(ctx: CloudContext, projectRef: unknown): Promise<{ agents: CloudAgent[] }> {
  await assertCloudAgentsEnabled(ctx);
  const project = await requireCloudProject(ctx.workspace, projectRef, "read");
  const rows = await selectAgents(and(eq(schema.cloudAgents.projectId, project.id), ne(schema.cloudAgents.status, "archived")));
  return { agents: rows.map(serializeAgentRow) };
}

export async function getCloudAgent(ctx: CloudContext, agentId: string): Promise<{ agent: CloudAgent }> {
  await assertCloudAgentsEnabled(ctx);
  const row = await loadAgentForCaller(ctx, agentId, "read");
  return { agent: await serializeCloudAgentById(row.id) };
}

export async function archiveCloudAgent(ctx: CloudContext, agentId: string): Promise<{ agent: CloudAgent }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const row = await loadAgentForCaller(ctx, agentId, "write");
  if (row.status !== "archived") {
    const now = deps.now();
    await db.transaction(async (tx) => {
      await tx.update(schema.cloudAgents).set({ status: "archived", archivedAt: now, updatedAt: now }).where(eq(schema.cloudAgents.id, row.id));
      await tx
        .update(schema.cloudAgentSchedules)
        .set({ enabled: false, nextRunAt: null, updatedAt: now })
        .where(eq(schema.cloudAgentSchedules.agentId, row.id));
      await recordCloudAudit(
        {
          organizationId: row.organizationId,
          projectId: row.projectId,
          actorType: ctx.surface === "cli" ? "cli" : "user",
          actorId: ctx.workspace.user.id,
          action: "cloud_agents.agent.archived",
          targetType: "cloud_agent",
          targetId: row.id,
          requestId: ctx.requestId,
          before: { status: row.status },
        },
        tx,
      );
    });
  }
  return { agent: await serializeCloudAgentById(row.id) };
}

/** A cloud agent of the caller's organization the caller may read or write; not found otherwise. */
export async function loadAgentForCaller(ctx: CloudContext, agentId: string, action: "read" | "write") {
  if (!isUuidRef(agentId)) throw cloudError("not_found", "Cloud agent not found.");
  const [row] = await db
    .select()
    .from(schema.cloudAgents)
    .where(and(eq(schema.cloudAgents.id, agentId), eq(schema.cloudAgents.organizationId, ctx.workspace.organization.id)))
    .limit(1);
  if (!row) throw cloudError("not_found", "Cloud agent not found.");
  await assertCloudProjectAccess(ctx.workspace, row.projectId, action);
  return row;
}

/** The agent's files at its deployed Library version. */
export async function deployedAgentFiles(row: Pick<CloudAgentRow, "libraryVersionId">) {
  if (!row.libraryVersionId) return [];
  return db
    .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, row.libraryVersionId));
}

export async function serializeCloudAgentById(agentId: string): Promise<CloudAgent> {
  const [row] = await selectAgents(eq(schema.cloudAgents.id, agentId));
  if (!row) throw cloudError("not_found", "Cloud agent not found.");
  return serializeAgentRow(row);
}

// ---------------------------------------------------------------------------

async function selectAgents(where: ReturnType<typeof and>) {
  const deployer = alias(schema.users, "cloud_agent_deployer");
  const itemProject = alias(schema.projects, "cloud_agent_item_project");
  return db
    .select({
      agent: schema.cloudAgents,
      itemSlug: schema.libraryItems.slug,
      itemProjectSlug: itemProject.slug,
      deployerId: deployer.id,
      deployerName: deployer.displayName,
      deployerEmail: deployer.primaryEmail,
    })
    .from(schema.cloudAgents)
    .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.cloudAgents.libraryItemId))
    .leftJoin(itemProject, eq(itemProject.id, schema.libraryItems.projectId))
    .leftJoin(deployer, eq(deployer.id, schema.cloudAgents.deployedByUserId))
    .where(where)
    .orderBy(schema.cloudAgents.name);
}

function serializeAgentRow(row: Awaited<ReturnType<typeof selectAgents>>[number]): CloudAgent {
  const agent = row.agent;
  const config = (agent.configJson ?? {}) as Partial<CloudAgentConfig>;
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    library: {
      itemId: agent.libraryItemId,
      slug: row.itemSlug,
      scope: row.itemProjectSlug ?? "org",
      version: agent.libraryVersionNumber,
    },
    provider: "anthropic",
    model: agent.model,
    status: agent.status === "archived" ? "archived" : agent.status === "failed" ? "failed" : "ready",
    deployedAt: agent.deployedAt?.toISOString() ?? null,
    deployedBy: row.deployerId ? { id: row.deployerId, name: personName(row.deployerName, row.deployerEmail) } : null,
    lastError: agent.lastError,
    config: {
      budgetUsd: config.budgetUsd ?? 5,
      networking: config.networking ?? "limited",
      webSearch: config.webSearch ?? false,
      writes: config.writes ?? "ask",
      raviMcp: config.raviMcp ?? true,
      mcpServers: (config.mcpServers ?? []).map((server) => server.name),
      repositories: (config.repositories ?? []).map((repository) => repository.repo),
      schedule: config.schedule ?? null,
    },
  };
}

export function personName(displayName: string | null | undefined, email: string | null | undefined) {
  return displayName?.trim() || email?.split("@")[0] || "Someone";
}

/** The ravi MCP read tools, run without asking even when writes ask (D9). */
function raviReadToolNames() {
  return listOperationDefinitions()
    .filter((definition) => definition.surfaces.includes("mcp") && definition.class === "read")
    .map((definition) => mcpToolName(definition.id));
}

async function resolveLibraryAgent(
  organizationId: string,
  project: { id: string },
  agentRef: string,
  versionNumber: number | null,
): Promise<LibraryAgent> {
  const visible = and(
    eq(schema.libraryItems.organizationId, organizationId),
    eq(schema.libraryItems.kind, "agent"),
    isNull(schema.libraryItems.archivedAt),
    or(isNull(schema.libraryItems.projectId), eq(schema.libraryItems.projectId, project.id)),
  );
  const items = await db
    .select({ item: schema.libraryItems, projectSlug: schema.projects.slug })
    .from(schema.libraryItems)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .where(and(visible, isUuidRef(agentRef) ? eq(schema.libraryItems.id, agentRef) : eq(schema.libraryItems.slug, agentRef)))
    // The project's own agent wins over an org agent of the same slug.
    .orderBy(sql`${schema.libraryItems.projectId} is null`)
    .limit(1);
  const found = items[0];
  if (!found) throw cloudError("not_found", `No Library agent ${agentRef} is visible in this project. Publish it with \`ravi agents publish\`.`);
  const number = versionNumber ?? found.item.currentVersionNumber;
  if (!number) throw cloudError("not_found", `Library agent ${agentRef} has no published version.`);
  const [version] = await db
    .select({ id: schema.libraryVersions.id, versionNumber: schema.libraryVersions.versionNumber, contentHash: schema.libraryVersions.contentHash })
    .from(schema.libraryVersions)
    .where(
      and(
        eq(schema.libraryVersions.itemId, found.item.id),
        eq(schema.libraryVersions.versionNumber, number),
        inArray(schema.libraryVersions.status, ["published", "superseded"]),
      ),
    )
    .limit(1);
  if (!version || version.versionNumber === null) throw cloudError("not_found", `Version ${number} of ${agentRef} is not published.`);
  const files = await db
    .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(eq(schema.libraryFiles.versionId, version.id));
  return {
    item: found.item,
    scope: found.projectSlug ?? "org",
    version: { id: version.id, versionNumber: version.versionNumber, contentHash: version.contentHash },
    files,
  };
}

/** `org/<slug>` is an org skill; `<project>/<slug>` resolves only for the run's own project. */
async function resolveLibrarySkills(organizationId: string, project: { id: string; slug: string }, refs: readonly string[]) {
  const resolved = new Map<string, CloudSkillSource>();
  for (const ref of refs) {
    const [prefix, slug] = ref.split("/") as [string, string];
    if (prefix !== "org" && prefix !== project.slug) continue;
    const [row] = await db
      .select({
        item: schema.libraryItems,
        versionId: schema.libraryVersions.id,
        versionNumber: schema.libraryVersions.versionNumber,
        contentHash: schema.libraryVersions.contentHash,
      })
      .from(schema.libraryItems)
      .innerJoin(schema.libraryVersions, eq(schema.libraryVersions.id, schema.libraryItems.currentVersionId))
      .where(
        and(
          eq(schema.libraryItems.organizationId, organizationId),
          eq(schema.libraryItems.kind, "skill"),
          eq(schema.libraryItems.slug, slug),
          isNull(schema.libraryItems.archivedAt),
          prefix === "org" ? isNull(schema.libraryItems.projectId) : eq(schema.libraryItems.projectId, project.id),
          eq(schema.libraryVersions.status, "published"),
        ),
      )
      .limit(1);
    if (!row) continue;
    const files = await db
      .select({ path: schema.libraryFiles.path, content: schema.libraryFiles.content })
      .from(schema.libraryFiles)
      .where(eq(schema.libraryFiles.versionId, row.versionId));
    resolved.set(ref, {
      ref,
      itemId: row.item.id,
      versionId: row.versionId,
      versionNumber: row.versionNumber,
      slug: row.item.slug,
      name: row.item.name,
      description: row.item.description,
      contentHash: row.contentHash,
      files,
    });
  }
  return resolved;
}

/**
 * Each skill is uploaded once per content hash for the whole organization; a
 * changed skill becomes a new version of the provider skill it had before.
 */
async function ensureProviderSkills(
  provider: CloudAgentProvider,
  organizationId: string,
  credentialId: string | null,
  compiled: CompiledCloudAgent,
  sources: ReadonlyMap<string, CloudSkillSource>,
) {
  const result = new Map<string, { skillId: string; version: string | null }>();
  if (compiled.skills.length === 0) return result;
  const known = await db
    .select({ skills: schema.cloudAgents.skillsJson })
    .from(schema.cloudAgents)
    // Only skills uploaded with the current key exist in its account.
    .where(and(eq(schema.cloudAgents.organizationId, organizationId), sql`${schema.cloudAgents.configJson} ->> 'credentialId' = ${credentialId ?? ""}`))
    .orderBy(desc(schema.cloudAgents.updatedAt));
  const byHash = new Map<string, { skillId: string; version: string | null }>();
  const byItem = new Map<string, string>();
  for (const row of known) {
    for (const [hash, value] of Object.entries(row.skills ?? {})) {
      const entry = value as { skillId?: unknown; version?: unknown; itemId?: unknown };
      if (typeof entry.skillId !== "string") continue;
      if (!byHash.has(hash)) byHash.set(hash, { skillId: entry.skillId, version: typeof entry.version === "string" ? entry.version : null });
      if (typeof entry.itemId === "string" && !byItem.has(entry.itemId)) byItem.set(entry.itemId, entry.skillId);
    }
  }
  for (const skill of compiled.skills) {
    const existing = byHash.get(skill.contentHash);
    if (existing) {
      result.set(skill.contentHash, existing);
      continue;
    }
    const source = sources.get(skill.ref);
    if (!source) continue;
    const uploaded = await provider.ensureSkill({
      displayTitle: source.name,
      directory: source.slug,
      files: source.files,
      existingSkillId: byItem.get(skill.itemId) ?? null,
    });
    byHash.set(skill.contentHash, uploaded);
    byItem.set(skill.itemId, uploaded.skillId);
    result.set(skill.contentHash, uploaded);
  }
  return result;
}

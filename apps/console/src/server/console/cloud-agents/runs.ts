// Cloud runs: start (as the person who pressed run, D6), read, follow up,
// stop, outputs and the task-result handshake with the OSS watcher.

import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { assertCloudAgentsEnabled, CLOUD_ADMIN_ROLES, type CloudContext, requireCloudProject, type ResolvedCloudDeps } from "./access";
import { listRunApprovals } from "./approvals";
import { canonicalJson, sha256Hex } from "./compiler";
import { callProvider, organizationProvider } from "./credential";
import { CLOUD_BUDGET_DEFAULT_USD, parseBudgetUsd, parseRepositories, CloudDefinitionError, type CloudRepository } from "./definition";
import { type CloudAgentConfig, type CloudAgentRow, deployInProject, freshDeployment, personName } from "./deploy";
import { CloudAgentsError, cloudError, errorSummary } from "./errors";
import {
  activeRunWhere,
  CLOUD_RUN_HARD_END_MS,
  type CloudRunRow,
  finishRun,
  isActiveStatus,
  loadRunForCaller,
  readSyncState,
  runUrl,
  writeSyncState,
} from "./lifecycle";
import { ensureCloudBridge, mintCloudRunToken, revokeCloudRunTokenChain } from "./mcp";
import type { CloudAgentProvider, ProviderDownload, ProviderRepositoryResource } from "./providers/types";
import { recordCloudAudit } from "./records";
import { CLOUD_SYNC_STALE_MS, syncCloudRun } from "./sync";
import type { CloudApproval, CloudRun, CloudRunEvent, CloudRunOutput, CloudRunStatus, CloudRunTrigger } from "./types";

const MAX_PROMPT_CHARS = 100_000;
const LIST_LIMIT_DEFAULT = 25;
const LIST_LIMIT_MAX = 100;
const EVENTS_LIMIT = 200;

const originSchema = z
  .object({
    kind: z.enum(["task", "agent", "page", "console", "cli"]),
    installationId: z.string().uuid().optional(),
    sessionName: z.string().trim().min(1).max(200).optional(),
    taskId: z.string().trim().min(1).max(200).optional(),
    agentName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const startBodySchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    agent: z.string().trim().min(1).max(200),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    budgetUsd: z.unknown().optional(),
    repositories: z.unknown().optional(),
    trigger: z.enum(["manual", "task", "agent", "page"]).optional(),
    origin: originSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const messageBodySchema = z.object({ text: z.string().min(1).max(MAX_PROMPT_CHARS) }).strict();

/** Internal starts (schedules) name the actor and trigger themselves. */
export type CloudRunStartOptions = {
  trigger?: "schedule";
  scheduleId?: string;
};

export async function startCloudRun(ctx: CloudContext, body: unknown, options: CloudRunStartOptions = {}): Promise<{ run: CloudRun }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const parsed = startBodySchema.safeParse(body);
  if (!parsed.success) {
    throw cloudError("validation_failed", "Send { project, agent, prompt, budgetUsd?, repositories?, trigger?, origin?, idempotencyKey? }.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const input = parsed.data;
  const trigger: CloudRunTrigger = options.trigger ?? input.trigger ?? "manual";
  let budgetUsd: number | null = null;
  let extraRepositories: CloudRepository[] = [];
  try {
    if (input.budgetUsd !== undefined && input.budgetUsd !== null) budgetUsd = parseBudgetUsd(input.budgetUsd);
    extraRepositories = parseRepositories(input.repositories);
  } catch (error) {
    if (error instanceof CloudDefinitionError) throw cloudError("validation_failed", error.message);
    throw error;
  }
  const origin = runOrigin(ctx, trigger, input.origin ?? null);
  const project = await requireCloudProject(ctx.workspace, input.project, "write");
  const organizationId = ctx.workspace.organization.id;

  // The key first: no rows for an organization that cannot run.
  await organizationProvider(organizationId, deps);
  const agent = await agentForRun(ctx, deps, project, input.agent);
  const config = agent.configJson as unknown as CloudAgentConfig;

  const requestHash = sha256Hex(
    canonicalJson({
      agentId: agent.id,
      prompt: input.prompt,
      budgetUsd,
      trigger,
      repositories: extraRepositories,
      origin,
      actorUserId: ctx.workspace.user.id,
    }),
  );
  if (input.idempotencyKey) {
    const replay = await idempotentRun(organizationId, input.idempotencyKey, requestHash);
    if (replay) return { run: await serializeRunById(deps, replay.id, { outputs: false }) };
  }

  const now = deps.now();
  const runId = randomUUID();
  const budgetCents = Math.round((budgetUsd ?? config.budgetUsd ?? CLOUD_BUDGET_DEFAULT_USD) * 100);
  const hardEndAt = new Date(now.getTime() + CLOUD_RUN_HARD_END_MS);
  const inserted = await db
    .insert(schema.cloudAgentRuns)
    .values({
      id: runId,
      organizationId,
      projectId: project.id,
      agentId: agent.id,
      libraryVersionId: agent.libraryVersionId,
      provider: "anthropic",
      status: "starting",
      trigger,
      actorUserId: ctx.workspace.user.id,
      requestedByUserId: ctx.workspace.user.id,
      scheduleId: options.scheduleId ?? null,
      promptEncrypted: deps.codec.encrypt(input.prompt, { organizationId, purpose: "prompt", recordId: runId }),
      budgetUsdCents: budgetCents,
      originJson: origin,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash,
      startedAt: now,
      hardEndAt,
    })
    .onConflictDoNothing()
    .returning();
  let run = inserted[0];
  if (!run) {
    // Lost a race on the same idempotency key.
    const replay = input.idempotencyKey ? await idempotentRun(organizationId, input.idempotencyKey, requestHash) : null;
    if (replay) return { run: await serializeRunById(deps, replay.id, { outputs: false }) };
    throw cloudError("idempotency_conflict", "The idempotency key was already used for a different request.");
  }
  await recordCloudAudit({
    organizationId,
    projectId: project.id,
    actorType: ctx.surface === "cli" ? "cli" : ctx.surface === "tick" ? "system" : "user",
    actorId: ctx.workspace.user.id,
    action: "cloud_agents.run.started",
    targetType: "cloud_agent_run",
    targetId: run.id,
    requestId: ctx.requestId,
    after: { agentId: agent.id, trigger, budgetUsd: budgetCents / 100, scheduleId: options.scheduleId ?? null },
  });

  const created: { sessionId: string | null; vaultId: string | null; tokenId: string | null } = { sessionId: null, vaultId: null, tokenId: null };
  try {
    run = await launch(ctx, deps, run, agent, config, extraRepositories, input.prompt, created);
  } catch (error) {
    const summary = errorSummary(error);
    await cleanup(deps, organizationId, created);
    const [current] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, run.id)).limit(1);
    await finishRun(current ?? run, deps, { status: "failed", errorCode: summary.code, errorMessage: summary.message }, agent.name);
    if (error instanceof CloudAgentsError) {
      throw new CloudAgentsError(error.code, error.message, { ...(error.details ?? {}), runId: run.id }, error.status);
    }
    throw cloudError("provider_error", summary.message, { runId: run.id });
  }
  return { run: await serializeRunById(deps, run.id, { outputs: false }) };
}

async function launch(
  ctx: CloudContext,
  deps: ResolvedCloudDeps,
  initial: CloudRunRow,
  agent: CloudAgentRow,
  config: CloudAgentConfig,
  extraRepositories: CloudRepository[],
  prompt: string,
  created: { sessionId: string | null; vaultId: string | null; tokenId: string | null },
) {
  let run = initial;
  const organizationId = run.organizationId;
  const { provider } = await organizationProvider(organizationId, deps);
  const call = <T>(fn: () => Promise<T>) => callProvider(organizationId, deps, fn);
  const now = deps.now();

  const repositories = mergeRepositories(config.repositories ?? [], extraRepositories);
  const resources: ProviderRepositoryResource[] = [];
  for (const repository of repositories) {
    const minted = await deps.mintRepositoryToken({ organizationId, repo: repository.repo });
    resources.push({ url: minted.url, authorizationToken: minted.token, branch: repository.branch });
  }

  const vault = await call(() =>
    provider.createVault({ displayName: `Ravi run ${run.id}`, metadata: { ravi_run: run.id, ravi_organization: organizationId } }),
  );
  created.vaultId = vault.vaultId;
  let credentialId: string | null = null;
  if (config.raviMcp) {
    const bridge = await ensureCloudBridge({
      organizationId,
      projectId: run.projectId,
      userId: ctx.workspace.user.id,
      codec: deps.codec,
      mcpBaseUrl: deps.mcpBaseUrl,
    });
    const token = await mintCloudRunToken({
      organizationId,
      projectId: run.projectId,
      bridgeId: bridge.id,
      subjectUserId: run.actorUserId,
      runId: run.id,
      hardEndAt: run.hardEndAt,
      now,
      mcpBaseUrl: deps.mcpBaseUrl,
    });
    created.tokenId = token.tokenId;
    const credential = await call(() =>
      provider.addMcpCredential(vault.vaultId, {
        serverUrl: bridge.consoleUrl,
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
        clientId: token.clientId,
        tokenEndpoint: token.tokenEndpoint,
      }),
    );
    credentialId = credential.credentialId;
  }
  run = stillActive(
    await db
      .update(schema.cloudAgentRuns)
      .set({ providerVaultId: vault.vaultId, providerVaultCredentialId: credentialId, mcpTokenId: created.tokenId, updatedAt: now })
      .where(activeRunWhere(run.id))
      .returning(),
  );

  const session = await call(() =>
    provider.createSession({
      agentId: agent.providerAgentId!,
      agentVersion: agent.providerAgentVersion!,
      environmentId: agent.providerEnvironmentId!,
      vaultIds: [vault.vaultId],
      budgetCents: run.budgetUsdCents,
      resources,
      title: `${agent.name}: ${prompt.slice(0, 120)}`,
      metadata: { ravi_run: run.id, ravi_organization: organizationId, ravi_project: run.projectId, ravi_trigger: run.trigger },
    }),
  );
  created.sessionId = session.sessionId;

  const [trace] = await db
    .insert(schema.runtimeTraceSessions)
    .values({
      organizationId,
      projectId: run.projectId,
      externalTraceId: run.id,
      sessionKey: `cloud:${agent.id}:${run.id}`,
      sessionName: agent.name,
      runId: run.id,
      agentRef: agent.name,
      placement: "cloud",
      runtimeProvider: "anthropic-managed",
      runtimeModel: agent.model,
      status: "active",
      startedAt: run.startedAt,
      safeMetadataJson: { cloudAgentId: agent.id, cloudRunId: run.id, trigger: run.trigger },
    })
    .returning({ id: schema.runtimeTraceSessions.id });
  run = stillActive(
    await db
      .update(schema.cloudAgentRuns)
      .set({ providerSessionId: session.sessionId, runtimeTraceSessionId: trace?.id ?? null, updatedAt: deps.now() })
      .where(activeRunWhere(run.id))
      .returning(),
  );

  await call(() => provider.sendMessage(session.sessionId, prompt));
  const [running] = await db
    .update(schema.cloudAgentRuns)
    .set({ status: "running", updatedAt: deps.now() })
    .where(and(eq(schema.cloudAgentRuns.id, run.id), eq(schema.cloudAgentRuns.status, "starting")))
    .returning();
  // A sync may already have moved it on; only a stopped run is an error.
  return running ?? stillActive(await db.select().from(schema.cloudAgentRuns).where(activeRunWhere(run.id)).limit(1));
}

/** The row of an update guarded by `activeRunWhere`; the run was stopped meanwhile when there is none. */
function stillActive(rows: CloudRunRow[]): CloudRunRow {
  const [row] = rows;
  if (!row) throw cloudError("cloud_run_not_active", "The run was stopped while it started.");
  return row;
}

async function cleanup(deps: ResolvedCloudDeps, organizationId: string, created: { sessionId: string | null; vaultId: string | null; tokenId: string | null }) {
  await revokeCloudRunTokenChain(created.tokenId, deps.now()).catch(() => undefined);
  if (!created.sessionId && !created.vaultId) return;
  try {
    const { provider } = await organizationProvider(organizationId, deps);
    if (created.sessionId) await provider.deleteSession(created.sessionId).catch(() => undefined);
    if (created.vaultId) await provider.deleteVault(created.vaultId).catch(() => undefined);
  } catch {
    // No usable key: the 30-day retention pass cannot reach these either; nothing else to do.
  }
}

/** The ready cloud agent for a run: an existing deployment, else the latest Library version deployed now. */
async function agentForRun(ctx: CloudContext, deps: ResolvedCloudDeps, project: { id: string; slug: string; organizationId: string }, agentRef: string) {
  if (isUuidRef(agentRef)) {
    const [byId] = await db
      .select()
      .from(schema.cloudAgents)
      .where(and(eq(schema.cloudAgents.id, agentRef), eq(schema.cloudAgents.projectId, project.id), sql`${schema.cloudAgents.status} <> 'archived'`))
      .limit(1);
    if (byId) {
      return byId.status === "ready"
        ? freshDeployment(ctx, deps, project, byId)
        : (await deployInProject(ctx, deps, { project, agentRef: byId.libraryItemId, versionNumber: null })).row;
    }
  }
  const existing = await db
    .select({ agent: schema.cloudAgents })
    .from(schema.cloudAgents)
    .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.cloudAgents.libraryItemId))
    .where(
      and(
        eq(schema.cloudAgents.projectId, project.id),
        sql`${schema.cloudAgents.status} = 'ready'`,
        isUuidRef(agentRef) ? eq(schema.libraryItems.id, agentRef) : eq(schema.libraryItems.slug, agentRef),
      ),
    )
    .orderBy(sql`${schema.libraryItems.projectId} is null`)
    .limit(1);
  if (existing[0]) return freshDeployment(ctx, deps, project, existing[0].agent);
  return (await deployInProject(ctx, deps, { project, agentRef, versionNumber: null })).row;
}

async function idempotentRun(organizationId: string, key: string, requestHash: string) {
  const [existing] = await db
    .select({ id: schema.cloudAgentRuns.id, requestHash: schema.cloudAgentRuns.requestHash })
    .from(schema.cloudAgentRuns)
    .where(and(eq(schema.cloudAgentRuns.organizationId, organizationId), eq(schema.cloudAgentRuns.idempotencyKey, key)))
    .limit(1);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw cloudError("idempotency_conflict", "The idempotency key was already used for a different request.");
  return existing;
}

function runOrigin(ctx: CloudContext, trigger: CloudRunTrigger, origin: z.infer<typeof originSchema> | null): JsonRecord | null {
  if (trigger === "task") {
    if (!origin?.sessionName || !origin.taskId) throw cloudError("validation_failed", "A task run needs origin { kind: \"task\", sessionName, taskId }.");
    if (!ctx.localInstallationId) throw cloudError("validation_failed", "A task run starts from a logged-in local installation.");
    // The installation is always the caller's own, whatever the body says.
    return { kind: "task", installationId: ctx.localInstallationId, sessionName: origin.sessionName, taskId: origin.taskId, delivery: "pending" };
  }
  if (!origin) return ctx.localInstallationId ? { kind: trigger, installationId: ctx.localInstallationId } : null;
  return { ...origin, kind: origin.kind, ...(ctx.localInstallationId ? { installationId: ctx.localInstallationId } : {}) };
}

function mergeRepositories(base: readonly CloudRepository[], extra: readonly CloudRepository[]) {
  const byRepo = new Map<string, CloudRepository>();
  for (const repository of [...base, ...extra]) byRepo.set(repository.repo.toLowerCase(), repository);
  return [...byRepo.values()];
}

// ---------------------------------------------------------------------------
// Reads

export async function getCloudRun(ctx: CloudContext, runId: string): Promise<{ run: CloudRun }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const { run } = await loadRunForCaller(ctx, runId, "read");
  if (isActiveStatus(run.status)) await syncCloudRun(run.id, deps, { minAgeMs: CLOUD_SYNC_STALE_MS });
  return { run: await serializeRunById(deps, run.id, { outputs: true }) };
}

export async function listCloudRuns(
  ctx: CloudContext,
  query: { project?: string | null; agent?: string | null; status?: string | null; cursor?: string | null; origin?: string | null; limit?: number | null },
): Promise<{ runs: CloudRun[]; cursor: string | null }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const conditions: (SQL | undefined)[] = [eq(schema.cloudAgentRuns.organizationId, ctx.workspace.organization.id)];
  if (query.origin === "installation") {
    if (!ctx.localInstallationId) throw cloudError("validation_failed", "origin=installation needs a logged-in local installation.");
    conditions.push(
      sql`${schema.cloudAgentRuns.originJson} ->> 'installationId' = ${ctx.localInstallationId}`,
      eq(schema.cloudAgentRuns.actorUserId, ctx.workspace.user.id),
    );
  } else if (query.origin) {
    throw cloudError("validation_failed", "origin is installation or absent.");
  }
  if (query.project) {
    const project = await requireCloudProject(ctx.workspace, query.project, "read");
    conditions.push(eq(schema.cloudAgentRuns.projectId, project.id));
  } else if (query.origin !== "installation") {
    throw cloudError("validation_failed", "Name the project (id or slug).");
  }
  if (query.agent) {
    if (!isUuidRef(query.agent)) throw cloudError("validation_failed", "agent is a cloud agent id.");
    conditions.push(eq(schema.cloudAgentRuns.agentId, query.agent));
  }
  if (query.status) {
    const statuses = query.status.split(",").map((value) => value.trim()).filter(Boolean);
    if (!statuses.every(isRunStatus)) throw cloudError("validation_failed", "Unknown run status.");
    conditions.push(inArray(schema.cloudAgentRuns.status, statuses));
  }
  const cursor = decodeCursor(query.cursor ?? null);
  if (cursor) {
    conditions.push(
      or(
        lt(schema.cloudAgentRuns.startedAt, cursor.startedAt),
        and(eq(schema.cloudAgentRuns.startedAt, cursor.startedAt), lt(schema.cloudAgentRuns.id, cursor.id)),
      ),
    );
  }
  const limit = Math.min(Math.max(query.limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
  const ids = await db
    .select({ id: schema.cloudAgentRuns.id, projectId: schema.cloudAgentRuns.projectId, startedAt: schema.cloudAgentRuns.startedAt })
    .from(schema.cloudAgentRuns)
    .where(and(...conditions))
    .orderBy(desc(schema.cloudAgentRuns.startedAt), desc(schema.cloudAgentRuns.id))
    .limit(limit + 1);
  const page = ids.slice(0, limit);
  const runs = await serializeRuns(deps, page.map((row) => row.id), { outputs: false });
  const last = page.at(-1);
  return { runs, cursor: ids.length > limit && last ? encodeCursor(last.startedAt, last.id) : null };
}

/** The run's events after `after` (a `seq`), oldest first. */
export async function listCloudRunEvents(ctx: CloudContext, runId: string, after: string | null): Promise<{ events: CloudRunEvent[]; cursor: string | null }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const { run } = await loadRunForCaller(ctx, runId, "read");
  if (isActiveStatus(run.status)) await syncCloudRun(run.id, deps, { minAgeMs: CLOUD_SYNC_STALE_MS });
  const afterSeq = after && /^\d+$/.test(after) ? Number(after) : 0;
  if (!run.runtimeTraceSessionId) return { events: [], cursor: after };
  const rows = await db
    .select()
    .from(schema.runtimeTraceEvents)
    .where(and(eq(schema.runtimeTraceEvents.traceSessionId, run.runtimeTraceSessionId), gt(schema.runtimeTraceEvents.sequence, afterSeq)))
    .orderBy(schema.runtimeTraceEvents.sequence)
    .limit(EVENTS_LIMIT);
  const events = rows.map((row): CloudRunEvent => {
    const payload = row.safePayloadJson as { role?: unknown; tool?: unknown };
    return {
      seq: row.sequence,
      at: row.occurredAt.toISOString(),
      type: (["message", "tool_call", "tool_result", "status", "approval", "error"].includes(row.eventType) ? row.eventType : "status") as CloudRunEvent["type"],
      ...(payload.role === "agent" || payload.role === "user" ? { role: payload.role } : {}),
      ...(row.safePreview ? { text: row.safePreview } : {}),
      ...(typeof payload.tool === "string" ? { tool: payload.tool } : {}),
      ...(row.status ? { status: row.status } : {}),
    };
  });
  const last = events.at(-1);
  return { events, cursor: last ? String(last.seq) : (after ?? null) };
}

// ---------------------------------------------------------------------------
// Actions

/**
 * A follow-up message: running or waiting runs queue it; a completed run comes
 * back to life with a new run token. Only the person the run acts for writes to
 * it, or an organization owner or admin, who then becomes that person (D6): a
 * new run token in their name replaces the old one.
 */
export async function sendCloudRunMessage(ctx: CloudContext, runId: string, body: unknown): Promise<{ run: CloudRun }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send { text }.");
  const { run, agentConfig } = await loadRunForCaller(ctx, runId, "write");
  const me = ctx.workspace.user.id;
  const takeover = run.actorUserId !== me;
  if (takeover && !CLOUD_ADMIN_ROLES.has(ctx.workspace.membership.role)) {
    throw cloudError(
      "forbidden",
      "Only the person this run acts for writes to it. An organization owner or admin may too, and the run then acts for them.",
    );
  }
  const now = deps.now();
  const followable = run.status === "running" || run.status === "waiting_approval" || run.status === "completed";
  if (!followable || !run.providerSessionId || run.providerDeletedAt || run.hardEndAt.getTime() <= now.getTime()) {
    throw cloudError("cloud_run_not_active", "This run no longer takes messages. Start a new run.");
  }
  const { provider } = await organizationProvider(run.organizationId, deps);
  const config = agentConfig as unknown as Partial<CloudAgentConfig>;
  const hasToken = config.raviMcp !== false && Boolean(run.providerVaultId && run.providerVaultCredentialId);
  const send = () => callProvider(run.organizationId, deps, () => provider.sendMessage(run.providerSessionId!, parsed.data.text));

  if (run.status === "completed") {
    // Claim the run first, so two follow-ups never both reopen it.
    const [claimed] = await db
      .update(schema.cloudAgentRuns)
      .set({
        status: "running",
        endedAt: null,
        errorCode: null,
        errorMessage: null,
        actorUserId: me,
        eventCursor: writeSyncState({ ...readSyncState(run.eventCursor), last: null }),
        updatedAt: now,
      })
      .where(and(eq(schema.cloudAgentRuns.id, run.id), eq(schema.cloudAgentRuns.status, "completed")))
      .returning();
    if (!claimed) throw cloudError("cloud_run_not_active", "The run changed meanwhile; read it again.");
    let tokenId: string | null = null;
    try {
      if (hasToken) {
        tokenId = await rebindRunToken(claimed, deps, provider, me, now);
        await db.update(schema.cloudAgentRuns).set({ mcpTokenId: tokenId }).where(activeRunWhere(run.id));
      }
      await setTraceStatus(run, "active", null, now);
      await send();
    } catch (error) {
      // Put the run back as it was; the new token is revoked.
      await revokeCloudRunTokenChain(tokenId, deps.now()).catch(() => undefined);
      await db
        .update(schema.cloudAgentRuns)
        .set({
          status: "completed",
          endedAt: run.endedAt,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
          actorUserId: run.actorUserId,
          mcpTokenId: run.mcpTokenId,
          eventCursor: run.eventCursor,
          updatedAt: deps.now(),
        })
        .where(and(eq(schema.cloudAgentRuns.id, run.id), eq(schema.cloudAgentRuns.status, "running")));
      await setTraceStatus(run, "completed", run.endedAt, deps.now());
      throw error;
    }
    if (takeover) await auditActorChange(ctx, run, me);
    return { run: await serializeRunById(deps, run.id, { outputs: false }) };
  }

  if (takeover) {
    const tokenId = hasToken ? await rebindRunToken(run, deps, provider, me, now) : null;
    const [moved] = await db
      .update(schema.cloudAgentRuns)
      .set({ actorUserId: me, ...(tokenId ? { mcpTokenId: tokenId } : {}), updatedAt: now })
      .where(and(activeRunWhere(run.id), eq(schema.cloudAgentRuns.actorUserId, run.actorUserId)))
      .returning();
    if (!moved) {
      await revokeCloudRunTokenChain(tokenId, now);
      throw cloudError("cloud_run_not_active", "The run changed meanwhile; read it again.");
    }
    if (tokenId) await revokeCloudRunTokenChain(run.mcpTokenId, now);
    await auditActorChange(ctx, run, me);
  }
  await send();
  return { run: await serializeRunById(deps, run.id, { outputs: false }) };
}

/** A new run token for `subjectUserId`, put in the run's vault; revoked again when the vault update fails. */
async function rebindRunToken(run: CloudRunRow, deps: ResolvedCloudDeps, provider: CloudAgentProvider, subjectUserId: string, now: Date) {
  const bridge = await ensureCloudBridge({
    organizationId: run.organizationId,
    projectId: run.projectId,
    userId: subjectUserId,
    codec: deps.codec,
    mcpBaseUrl: deps.mcpBaseUrl,
  });
  const token = await mintCloudRunToken({
    organizationId: run.organizationId,
    projectId: run.projectId,
    bridgeId: bridge.id,
    subjectUserId,
    runId: run.id,
    hardEndAt: run.hardEndAt,
    now,
    mcpBaseUrl: deps.mcpBaseUrl,
  });
  try {
    await callProvider(run.organizationId, deps, () =>
      provider.updateMcpCredential(run.providerVaultId!, run.providerVaultCredentialId!, {
        serverUrl: bridge.consoleUrl,
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
        clientId: token.clientId,
        tokenEndpoint: token.tokenEndpoint,
      }),
    );
  } catch (error) {
    await revokeCloudRunTokenChain(token.tokenId, now);
    throw error;
  }
  return token.tokenId;
}

async function setTraceStatus(run: CloudRunRow, status: string, endedAt: Date | null, now: Date) {
  if (!run.runtimeTraceSessionId) return;
  await db
    .update(schema.runtimeTraceSessions)
    .set({ status, endedAt, updatedAt: now })
    .where(eq(schema.runtimeTraceSessions.id, run.runtimeTraceSessionId));
}

async function auditActorChange(ctx: CloudContext, run: CloudRunRow, actorUserId: string) {
  await recordCloudAudit({
    organizationId: run.organizationId,
    projectId: run.projectId,
    actorType: ctx.surface === "cli" ? "cli" : "user",
    actorId: ctx.workspace.user.id,
    action: "cloud_agents.run.actor_changed",
    targetType: "cloud_agent_run",
    targetId: run.id,
    requestId: ctx.requestId,
    before: { actorUserId: run.actorUserId },
    after: { actorUserId },
  });
}

export async function stopCloudRun(ctx: CloudContext, runId: string): Promise<{ run: CloudRun }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const { run, agentName } = await loadRunForCaller(ctx, runId, "write");
  if (!isActiveStatus(run.status)) return { run: await serializeRunById(deps, run.id, { outputs: false }) };
  if (run.providerSessionId) {
    try {
      const { provider } = await organizationProvider(run.organizationId, deps);
      await callProvider(run.organizationId, deps, () => provider.interrupt(run.providerSessionId!));
    } catch (error) {
      // Stopping must work even when the provider does not answer: the token is revoked below.
      await db
        .update(schema.cloudAgentRuns)
        .set({ errorMessage: `Stop: ${errorSummary(error).message}`.slice(0, 500) })
        .where(activeRunWhere(run.id));
    }
  }
  const [current] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, run.id)).limit(1);
  await finishRun(current ?? run, deps, { status: "stopped", errorCode: null, errorMessage: null }, agentName);
  await recordCloudAudit({
    organizationId: run.organizationId,
    projectId: run.projectId,
    actorType: ctx.surface === "cli" ? "cli" : ctx.surface === "tick" ? "system" : "user",
    actorId: ctx.workspace.user.id,
    action: "cloud_agents.run.stopped",
    targetType: "cloud_agent_run",
    targetId: run.id,
    requestId: ctx.requestId,
    before: { status: run.status },
  });
  return { run: await serializeRunById(deps, run.id, { outputs: false }) };
}

/** One output file's bytes, proxied: a provider URL never reaches the client. */
export async function downloadCloudRunOutput(ctx: CloudContext, runId: string, outputId: string): Promise<ProviderDownload> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const { run } = await loadRunForCaller(ctx, runId, "read");
  if (!run.providerSessionId || run.providerDeletedAt) throw cloudError("not_found", "This run's outputs are no longer kept.");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(outputId)) throw cloudError("not_found", "Output not found.");
  const { provider } = await organizationProvider(run.organizationId, deps);
  try {
    return await callProvider(run.organizationId, deps, () => provider.downloadOutput(run.providerSessionId!, outputId));
  } catch (error) {
    if (error instanceof CloudAgentsError && (error.details as { kind?: unknown } | undefined)?.kind === "not_found") {
      throw cloudError("not_found", "Output not found.");
    }
    throw error;
  }
}

/** The OSS watcher acknowledges a task run's result; only the originating installation may. */
export async function markCloudRunDelivered(ctx: CloudContext, runId: string): Promise<{ run: CloudRun }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const { run } = await loadRunForCaller(ctx, runId, "read");
  const origin = (run.originJson ?? {}) as JsonRecord;
  if (!ctx.localInstallationId || origin.installationId !== ctx.localInstallationId) {
    throw cloudError("forbidden", "Only the installation that started this run acknowledges its result.");
  }
  if (origin.delivery !== "delivered") {
    await db
      .update(schema.cloudAgentRuns)
      .set({ originJson: { ...origin, delivery: "delivered", deliveredAt: deps.now().toISOString() }, updatedAt: deps.now() })
      .where(eq(schema.cloudAgentRuns.id, run.id));
  }
  return { run: await serializeRunById(deps, run.id, { outputs: false }) };
}

// ---------------------------------------------------------------------------
// Serialization

export async function serializeRunById(deps: ResolvedCloudDeps, runId: string, options: { outputs: boolean }) {
  const [run] = await serializeRuns(deps, [runId], options);
  if (!run) throw cloudError("not_found", "Cloud run not found.");
  return run;
}

async function serializeRuns(deps: ResolvedCloudDeps, runIds: readonly string[], options: { outputs: boolean }): Promise<CloudRun[]> {
  if (runIds.length === 0) return [];
  const actor = alias(schema.users, "cloud_run_actor");
  const rows = await db
    .select({ run: schema.cloudAgentRuns, agentName: schema.cloudAgents.name, actorName: actor.displayName, actorEmail: actor.primaryEmail })
    .from(schema.cloudAgentRuns)
    .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentRuns.agentId))
    .innerJoin(actor, eq(actor.id, schema.cloudAgentRuns.actorUserId))
    .where(inArray(schema.cloudAgentRuns.id, [...runIds]));
  const approvals = await listRunApprovals(runIds);
  const byId = new Map(rows.map((row) => [row.run.id, row]));
  const result: CloudRun[] = [];
  for (const id of runIds) {
    const row = byId.get(id);
    if (!row) continue;
    const run = row.run;
    const scope = (purpose: "prompt" | "result") => ({ organizationId: run.organizationId, purpose, recordId: run.id });
    result.push({
      id: run.id,
      agentId: run.agentId,
      agentName: row.agentName,
      projectId: run.projectId,
      status: run.status as CloudRunStatus,
      trigger: run.trigger as CloudRunTrigger,
      actor: { id: run.actorUserId, name: personName(row.actorName, row.actorEmail) },
      prompt: decryptOr(deps, run.promptEncrypted, scope("prompt")) ?? "",
      result: run.resultEncrypted ? decryptOr(deps, run.resultEncrypted, scope("result")) : null,
      budgetUsd: run.budgetUsdCents / 100,
      costUsd: Math.round(run.costUsdMicros / 10_000) / 100,
      runningSeconds: run.runningSeconds,
      tokens: { input: run.inputTokens, output: run.outputTokens, cacheRead: run.cacheReadTokens, cacheWrite: run.cacheWriteTokens },
      approvals: approvals.filter((entry) => entry.approval.runId === run.id).map((entry) => serializeApproval(deps, entry)),
      outputs: options.outputs ? await runOutputs(deps, run) : [],
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      error: run.errorCode ? { code: run.errorCode, message: run.errorMessage ?? "" } : null,
      origin: (run.originJson as Record<string, unknown> | null) ?? null,
      url: await runUrl(deps, run),
    });
  }
  return result;
}

function serializeApproval(deps: ResolvedCloudDeps, entry: Awaited<ReturnType<typeof listRunApprovals>>[number]): CloudApproval {
  const approval = entry.approval;
  return {
    id: approval.id,
    tool: approval.toolName,
    server: approval.serverName,
    inputPreview: approval.inputPreviewEncrypted
      ? decryptOr(deps, approval.inputPreviewEncrypted, { organizationId: approval.organizationId, purpose: "approval_input", recordId: approval.id })
      : null,
    status: approval.status as CloudApproval["status"],
    requestedAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decidedBy: approval.decidedByUserId ? { id: approval.decidedByUserId, name: personName(entry.deciderName, entry.deciderEmail) } : null,
  };
}

async function runOutputs(deps: ResolvedCloudDeps, run: CloudRunRow): Promise<CloudRunOutput[]> {
  if (!run.providerSessionId || run.providerDeletedAt) return [];
  try {
    const { provider } = await organizationProvider(run.organizationId, deps);
    const outputs = await callProvider(run.organizationId, deps, () => provider.listOutputs(run.providerSessionId!));
    return outputs.map((output) => ({ id: output.id, name: output.name, size: output.size }));
  } catch {
    return [];
  }
}

function decryptOr(deps: ResolvedCloudDeps, value: string, scope: Parameters<ResolvedCloudDeps["codec"]["decrypt"]>[1]) {
  try {
    return deps.codec.decrypt(value, scope);
  } catch {
    return null;
  }
}

function isRunStatus(value: string): value is CloudRunStatus {
  return ["starting", "running", "waiting_approval", "completed", "failed", "stopped", "budget_exceeded"].includes(value);
}

function encodeCursor(startedAt: Date, id: string) {
  return Buffer.from(`${startedAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(raw: string | null) {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const startedAt = at ? new Date(at) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime()) || !id || !isUuidRef(id)) throw cloudError("validation_failed", "Invalid cursor.");
  return { startedAt, id };
}


// The cloud agents tick (`GET /api/internal/cloud-agents/tick`, every minute):
// stop runs past their hard end, expire approvals, start due schedules, fail
// runs stuck starting, sync active runs, re-revoke the token chains of runs
// that just ended, delete provider sessions 30 days after a run ends (D11) and
// send the monthly spend alert. One overall deadline and short provider calls
// keep it inside the route's 300 s; what is left over waits for the next tick.

import { timingSafeEqual } from "node:crypto";

import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";

import { adminJson, adminRequestId, gateAdminRequest } from "@/server/admin/http";
import { db, schema } from "@/server/db";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

import { CLOUD_ADMIN_ROLES, type CloudDeps, resolveCloudDeps, type ResolvedCloudDeps } from "./access";
import type { CloudProviderLimits } from "./providers/types";
import { expireCloudApprovals } from "./approvals";
import { cloudAgentsConfigured } from "./crypto";
import { callProvider, monthCostUsd, organizationProvider } from "./credential";
import { finishRun } from "./lifecycle";
import { revokeCloudRunTokenChain } from "./mcp";
import { notifyCloudActor } from "./records";
import { runDueCloudSchedules } from "./schedules";
import { syncCloudRun } from "./sync";
import { CLOUD_ACTIVE_RUN_STATUSES } from "./types";

export const CLOUD_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SYNC_BATCH = 25;
const TICK_SYNC_MIN_AGE_MS = 10_000;
const RETENTION_BATCH = 20;
/** The tick's own budget, below the route's maxDuration (300 s). */
export const CLOUD_TICK_BUDGET_MS = 200_000;
/** Provider calls inside the tick: short, no retries (the next tick retries). */
export const CLOUD_TICK_PROVIDER_LIMITS: CloudProviderLimits = { timeoutMs: 10_000, maxRetries: 0 };
/** A run still `starting` after this lost its launch. */
export const CLOUD_STARTING_STALE_MS = 5 * 60_000;
/** Ended runs whose token chain is revoked again, for a rotation that raced the first revoke. */
const RECENTLY_ENDED_MS = 2 * 60 * 60_000;

export type CloudAgentsTickResult =
  | { skipped: "unconfigured" }
  | {
      synced: number;
      hardStopped: number;
      schedules: { due: number; started: number; disabled: number };
      approvalsExpired: number;
      staleStartsFailed: number;
      providerDeleted: number;
      alerts: number;
      errors: number;
      /** The deadline cut the tick short; the rest runs on the next one. */
      deadlineReached: boolean;
    };

export async function runCloudAgentsTick(
  input: CloudDeps = {},
  options: { budgetMs?: number; clock?: () => number } = {},
): Promise<CloudAgentsTickResult> {
  if (!cloudAgentsConfigured(input.env ?? process.env)) return { skipped: "unconfigured" };
  const cloudDeps: CloudDeps = { ...input, providerLimits: input.providerLimits ?? CLOUD_TICK_PROVIDER_LIMITS };
  const deps = resolveCloudDeps(cloudDeps);
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? CLOUD_TICK_BUDGET_MS);
  const late = () => clock() >= deadline;
  let errors = 0;
  const step = async <T>(fallback: T, run: () => Promise<T>) => {
    if (late()) return fallback;
    try {
      return await run();
    } catch (error) {
      errors += 1;
      console.error("cloud agents tick step failed", { message: error instanceof Error ? error.message : "unknown" });
      return fallback;
    }
  };

  // Cheap, time-critical passes first; provider-heavy ones after.
  const hardStopped = await step(0, () => stopRunsPastHardEnd(deps, late));
  const approvalsExpired = await step(0, () => expireCloudApprovals(deps));
  const schedules = await step({ due: 0, started: 0, disabled: 0 }, () => runDueCloudSchedules(cloudDeps, deps, 20, late));
  const staleStartsFailed = await step(0, () => failStaleStarts(deps, late));
  const synced = await step(0, () => syncActiveRuns(deps, late));
  await step(0, () => revokeRecentlyEndedChains(deps));
  const providerDeleted = await step(0, () => deleteExpiredProviderSessions(deps, late));
  const alerts = await step(0, () => sendMonthlyAlerts(deps));
  return { synced, hardStopped, schedules, approvalsExpired, staleStartsFailed, providerDeleted, alerts, errors, deadlineReached: late() };
}

async function syncActiveRuns(deps: ResolvedCloudDeps, late: () => boolean) {
  const runs = await db
    .select({ id: schema.cloudAgentRuns.id })
    .from(schema.cloudAgentRuns)
    .where(and(inArray(schema.cloudAgentRuns.status, [...CLOUD_ACTIVE_RUN_STATUSES]), isNotNull(schema.cloudAgentRuns.providerSessionId)))
    .orderBy(sql`${schema.cloudAgentRuns.lastSyncedAt} asc nulls first`)
    .limit(SYNC_BATCH);
  let synced = 0;
  for (const run of runs) {
    if (late()) break;
    const outcome = await syncCloudRun(run.id, deps, { minAgeMs: TICK_SYNC_MIN_AGE_MS });
    if (outcome.synced) synced += 1;
  }
  return synced;
}

/**
 * A run still `starting` minutes after it began lost its launch (a timeout or
 * a crash between steps): sync it once in case the session did start, else fail
 * it and delete what the launch created at the provider.
 */
async function failStaleStarts(deps: ResolvedCloudDeps, late: () => boolean) {
  const now = deps.now();
  const rows = await db
    .select({ run: schema.cloudAgentRuns, agentName: schema.cloudAgents.name })
    .from(schema.cloudAgentRuns)
    .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentRuns.agentId))
    .where(and(eq(schema.cloudAgentRuns.status, "starting"), lt(schema.cloudAgentRuns.startedAt, new Date(now.getTime() - CLOUD_STARTING_STALE_MS))))
    .limit(SYNC_BATCH);
  let failed = 0;
  for (const { run: stale, agentName } of rows) {
    if (late()) break;
    const run = stale.providerSessionId ? (await syncCloudRun(stale.id, deps, { minAgeMs: 0 })).run : stale;
    if (run.status !== "starting") continue;
    const finished = await finishRun(
      run,
      deps,
      { status: "failed", errorCode: "provider_error", errorMessage: "The run did not finish starting; nothing more will run." },
      agentName,
    );
    if (!finished) continue;
    failed += 1;
    try {
      const { provider } = await organizationProvider(run.organizationId, deps);
      if (run.providerSessionId) await callProvider(run.organizationId, deps, () => provider.deleteSession(run.providerSessionId!));
      if (run.providerVaultId) await callProvider(run.organizationId, deps, () => provider.deleteVault(run.providerVaultId!));
      await db.update(schema.cloudAgentRuns).set({ providerDeletedAt: now }).where(eq(schema.cloudAgentRuns.id, run.id));
    } catch {
      // The 30-day retention pass deletes them later.
    }
  }
  return failed;
}

/**
 * The Worker rotates a refresh token in one statement, but a rotation that
 * committed while the run's chain was being revoked leaves a live child: revoke
 * the chains of recently ended runs again.
 */
async function revokeRecentlyEndedChains(deps: ResolvedCloudDeps) {
  const now = deps.now();
  const rows = await db
    .select({ tokenId: schema.cloudAgentRuns.mcpTokenId })
    .from(schema.cloudAgentRuns)
    .where(
      and(
        isNotNull(schema.cloudAgentRuns.mcpTokenId),
        isNotNull(schema.cloudAgentRuns.endedAt),
        gt(schema.cloudAgentRuns.endedAt, new Date(now.getTime() - RECENTLY_ENDED_MS)),
      ),
    )
    .limit(200);
  for (const row of rows) await revokeCloudRunTokenChain(row.tokenId, now);
  return rows.length;
}

/** A run lives at most 24 hours (the run token's refresh limit). */
async function stopRunsPastHardEnd(deps: ResolvedCloudDeps, late: () => boolean) {
  const now = deps.now();
  const rows = await db
    .select({ run: schema.cloudAgentRuns, agentName: schema.cloudAgents.name })
    .from(schema.cloudAgentRuns)
    .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentRuns.agentId))
    .where(and(inArray(schema.cloudAgentRuns.status, [...CLOUD_ACTIVE_RUN_STATUSES]), lt(schema.cloudAgentRuns.hardEndAt, now)))
    .limit(SYNC_BATCH);
  let stopped = 0;
  for (const { run, agentName } of rows) {
    if (late()) break;
    if (run.providerSessionId) {
      try {
        const { provider } = await organizationProvider(run.organizationId, deps);
        await callProvider(run.organizationId, deps, () => provider.interrupt(run.providerSessionId!));
      } catch {
        // The token is revoked either way.
      }
    }
    const finished = await finishRun(run, deps, { status: "stopped", errorCode: null, errorMessage: "The run reached its 24-hour limit." }, agentName);
    if (finished) stopped += 1;
  }
  return stopped;
}

/** D11: the provider session (and its vault) goes 30 days after the run ends; the Console keeps its summary. */
async function deleteExpiredProviderSessions(deps: ResolvedCloudDeps, late: () => boolean) {
  const now = deps.now();
  const rows = await db
    .select()
    .from(schema.cloudAgentRuns)
    .where(
      and(
        isNull(schema.cloudAgentRuns.providerDeletedAt),
        lt(schema.cloudAgentRuns.endedAt, new Date(now.getTime() - CLOUD_RETENTION_MS)),
        or(isNotNull(schema.cloudAgentRuns.providerSessionId), isNotNull(schema.cloudAgentRuns.providerVaultId)),
      ),
    )
    .orderBy(asc(schema.cloudAgentRuns.updatedAt))
    .limit(RETENTION_BATCH);
  let deleted = 0;
  for (const run of rows) {
    if (late()) break;
    try {
      const { provider } = await organizationProvider(run.organizationId, deps);
      if (run.providerSessionId) await callProvider(run.organizationId, deps, () => provider.deleteSession(run.providerSessionId!));
      if (run.providerVaultId) await callProvider(run.organizationId, deps, () => provider.deleteVault(run.providerVaultId!));
      await db.update(schema.cloudAgentRuns).set({ providerDeletedAt: now, updatedAt: now }).where(eq(schema.cloudAgentRuns.id, run.id));
      deleted += 1;
    } catch {
      // Retried later; `updated_at` moves the run to the back of the queue.
      await db.update(schema.cloudAgentRuns).set({ updatedAt: now }).where(eq(schema.cloudAgentRuns.id, run.id));
    }
  }
  return deleted;
}

/** Once per organization per month, to owners and admins, when this month's list cost passes the alert. */
async function sendMonthlyAlerts(deps: ResolvedCloudDeps) {
  const now = deps.now();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const credentials = await db
    .select()
    .from(schema.cloudAgentCredentials)
    .where(
      and(
        ne(schema.cloudAgentCredentials.status, "revoked"),
        isNotNull(schema.cloudAgentCredentials.monthlyAlertUsd),
        or(isNull(schema.cloudAgentCredentials.alertedMonth), ne(schema.cloudAgentCredentials.alertedMonth, month)),
      ),
    )
    .limit(100);
  let sent = 0;
  for (const credential of credentials) {
    const cost = await monthCostUsd(credential.organizationId, now);
    if (cost < (credential.monthlyAlertUsd ?? Number.POSITIVE_INFINITY)) continue;
    const [claimed] = await db
      .update(schema.cloudAgentCredentials)
      .set({ alertedMonth: month, updatedAt: now })
      .where(
        and(
          eq(schema.cloudAgentCredentials.id, credential.id),
          or(isNull(schema.cloudAgentCredentials.alertedMonth), ne(schema.cloudAgentCredentials.alertedMonth, month)),
        ),
      )
      .returning();
    if (!claimed) continue;
    const admins = await db
      .select({ userId: schema.organizationMemberships.userId, role: schema.organizationMemberships.role })
      .from(schema.organizationMemberships)
      .where(and(eq(schema.organizationMemberships.organizationId, credential.organizationId), eq(schema.organizationMemberships.status, "active")));
    for (const admin of admins.filter((member) => CLOUD_ADMIN_ROLES.has(member.role))) {
      await notifyCloudActor({
        organizationId: credential.organizationId,
        projectId: null,
        userId: admin.userId,
        eventType: "cloud_agents.spend.alert",
        severity: "warning",
        title: `Cloud agents passed US$ ${credential.monthlyAlertUsd} this month`,
        summary: `This month's list cost on the organization's Anthropic key is US$ ${cost.toFixed(2)}. Each run still stops at its own budget.`,
        sourceId: credential.id,
        dedupeKey: `cloud_agents:spend:${credential.organizationId}:${month}:${admin.userId}`,
        url: null,
        payload: { month, costUsd: cost, alertUsd: credential.monthlyAlertUsd },
        occurredAt: now,
      });
    }
    sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// HTTP: Vercel Cron (GET with CRON_SECRET) or an operator (POST with the admin token)

export type CloudAgentsTickHttpDeps = {
  cronSecret?: () => string | undefined;
  runTick?: typeof runCloudAgentsTick;
};

export async function handleCloudAgentsTickHttp(request: Request, deps: CloudAgentsTickHttpDeps = {}): Promise<Response> {
  let requestId: string;
  if (request.method === "GET") {
    requestId = adminRequestId(request);
    const secret = (deps.cronSecret ?? (() => process.env.CRON_SECRET))()?.trim();
    if (!secret) {
      console.error("cloud_agents_tick_cron_secret_missing", { requestId });
      return adminJson({ status: "error", code: "cron_secret_not_configured", requestId }, 503, requestId);
    }
    if (!bearerMatches(request, secret)) {
      if (isRateLimited({ key: rateLimitKey(request, "cloud-agents-tick"), limit: 10, windowMs: 60_000 })) {
        return adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId);
      }
      return adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId);
    }
  } else {
    const gate = gateAdminRequest(request, { rateLimitName: "cloud-agents-tick", missingTokenLog: "cloud_agents_tick_admin_token_missing" });
    if (!gate.ok) return gate.response;
    requestId = gate.requestId;
  }
  try {
    const result = await (deps.runTick ?? runCloudAgentsTick)();
    return adminJson({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    console.error("cloud_agents_tick_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "cloud_agents_tick_failed", requestId }, 500, requestId);
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  const expected = Buffer.from(secret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

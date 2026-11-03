// Sync one run with its provider session: read the events after the cursor,
// mirror them into the runtime trace, create approvals, keep the last agent
// message as the result, update usage and cost, and map the session's state to
// the run's status. A provider failure during sync is recorded on the run and
// never thrown to a reader.

import { eq } from "drizzle-orm";

import { db, schema } from "@/server/db";

import type { ResolvedCloudDeps } from "./access";
import { createApprovals, latestDecisionAt, pendingApprovalCount } from "./approvals";
import { callProvider, organizationProvider } from "./credential";
import { errorSummary } from "./errors";
import {
  activeRunWhere,
  type CloudRunRow,
  claimSync,
  finishRun,
  isActiveStatus,
  mirrorTraceEvents,
  readSyncState,
  recordRunUsage,
  writeSyncState,
} from "./lifecycle";
import type { CloudAgentProvider, ProviderEvent } from "./providers/types";
import type { CloudRunEvent } from "./types";

/** A read syncs a run whose last sync is older than this. */
export const CLOUD_SYNC_STALE_MS = 5_000;
/** A decided approval the idle provider has not picked up after this is asked for again. */
export const CLOUD_CONFIRMATION_GRACE_MS = 2 * 60_000;
const EVENT_PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5;

export type CloudSyncOutcome = { run: CloudRunRow; synced: boolean };

/**
 * Syncs the run unless another pass ran within `minAgeMs`. Only active runs
 * talk to the provider. Never throws for a provider failure.
 */
export async function syncCloudRun(runId: string, deps: ResolvedCloudDeps, options: { minAgeMs?: number } = {}): Promise<CloudSyncOutcome> {
  const [current] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, runId)).limit(1);
  if (!current) throw new Error("cloud run not found");
  if (!isActiveStatus(current.status) || !current.providerSessionId) return { run: current, synced: false };
  const claimed = await claimSync(runId, deps.now(), options.minAgeMs ?? CLOUD_SYNC_STALE_MS);
  if (!claimed || !isActiveStatus(claimed.status) || !claimed.providerSessionId) return { run: claimed ?? current, synced: false };

  const [agent] = await db
    .select({ name: schema.cloudAgents.name })
    .from(schema.cloudAgents)
    .where(eq(schema.cloudAgents.id, claimed.agentId))
    .limit(1);
  const agentName = agent?.name ?? "agent";
  try {
    const { provider } = await organizationProvider(claimed.organizationId, deps);
    const run = await syncWithProvider(claimed, deps, provider, agentName);
    return { run, synced: true };
  } catch (error) {
    const summary = errorSummary(error);
    const [run] = await db
      .update(schema.cloudAgentRuns)
      .set({ errorCode: summary.code, errorMessage: `Sync: ${summary.message}`.slice(0, 500), updatedAt: deps.now() })
      .where(activeRunWhere(claimed.id))
      .returning();
    return { run: run ?? claimed, synced: false };
  }
}

async function syncWithProvider(start: CloudRunRow, deps: ResolvedCloudDeps, provider: CloudAgentProvider, agentName: string) {
  const sessionId = start.providerSessionId!;
  const call = <T>(run: () => Promise<T>) => callProvider(start.organizationId, deps, run);
  let run = start;
  let state = readSyncState(run.eventCursor);
  let resultText: string | null = null;
  let terminalError: { message: string } | null = null;

  for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
    const batch = await call(() => provider.listEvents(sessionId, state.cursor, EVENT_PAGE_SIZE));
    const toolUses: { id: string; tool: string; server: string | null; input: unknown; at: Date }[] = [];
    const mirrored: Parameters<typeof mirrorTraceEvents>[1] = [];
    for (const event of batch.events) {
      const trace = traceOf(event);
      if (trace) mirrored.push(trace);
      if (event.kind === "message" && event.role === "agent" && event.text.trim()) resultText = event.text;
      if (event.kind === "tool_use" && event.permission === "ask") toolUses.push(event);
      if (event.kind === "status") state = { ...state, last: { status: event.status, stopReason: event.stopReason } };
      if (event.kind === "error" && !event.retrying) terminalError = { message: `${event.errorType}: ${event.message}` };
    }
    await mirrorTraceEvents(run, mirrored);
    state = { ...state, cursor: batch.cursor };
    const [saved] = await db
      .update(schema.cloudAgentRuns)
      .set({
        eventCursor: writeSyncState(state),
        ...(resultText !== null
          ? { resultEncrypted: deps.codec.encrypt(resultText, { organizationId: run.organizationId, purpose: "result", recordId: run.id }) }
          : {}),
      })
      .where(eq(schema.cloudAgentRuns.id, run.id))
      .returning();
    run = saved ?? run;
    if (toolUses.length > 0) await createApprovals(run, deps, toolUses, agentName);
    if (!batch.hasMore) break;
  }

  const session = await call(() => provider.getSession(sessionId));
  if (!session) {
    return (await finishRun(run, deps, { status: "failed", errorCode: "provider_error", errorMessage: "The provider session no longer exists." }, agentName)) ?? run;
  }
  const costMicros = session.usage.listCostCents === null ? run.costUsdMicros : Math.round(session.usage.listCostCents * 10_000);
  const [usage] = await db
    .update(schema.cloudAgentRuns)
    .set({
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      cacheReadTokens: session.usage.cacheReadTokens,
      cacheWriteTokens: session.usage.cacheWriteTokens,
      costUsdMicros: Math.max(run.costUsdMicros, costMicros),
      runningSeconds: Math.max(run.runningSeconds, session.usage.activeSeconds),
      errorCode: null,
      errorMessage: null,
      updatedAt: deps.now(),
    })
    .where(activeRunWhere(run.id))
    .returning();
  if (!usage) return (await reload(run.id)) ?? run;
  run = usage;

  // Budget: the provider pauses at its own cap; Ravi also stops at its own.
  if (run.costUsdMicros >= run.budgetUsdCents * 10_000) {
    await call(() => provider.interrupt(sessionId)).catch(() => undefined);
    return (await finishRun(run, deps, { status: "budget_exceeded" }, agentName)) ?? run;
  }

  const last = state.last;
  if (session.status === "terminated" || last?.status === "terminated") {
    return (
      (await finishRun(
        run,
        deps,
        { status: "failed", errorCode: "provider_error", errorMessage: terminalError?.message ?? "The provider ended the session." },
        agentName,
      )) ?? run
    );
  }
  if (last?.status === "idle" && last.stopReason) {
    switch (last.stopReason.type) {
      case "end_turn":
        return (await finishRun(run, deps, { status: "completed" }, agentName)) ?? run;
      case "budget_reached":
        return (await finishRun(run, deps, { status: "budget_exceeded" }, agentName)) ?? run;
      case "requires_action": {
        // Waiting while a person has not decided. With every approval decided and the
        // session still idle past the grace, the provider lost the decision: ask again.
        const pending = await pendingApprovalCount(run.id);
        const decidedAt = pending === 0 ? await latestDecisionAt(run.id) : null;
        const lost =
          pending === 0 &&
          session.status === "idle" &&
          (decidedAt === null || deps.now().getTime() - decidedAt.getTime() > CLOUD_CONFIRMATION_GRACE_MS);
        if (pending > 0 || lost) {
          run = await setStatus(
            run,
            "waiting_approval",
            deps.now(),
            lost ? "The provider is still waiting on a decision: approve or deny the tool call again." : undefined,
          );
        } else if (run.status !== "running") {
          run = await setStatus(run, "running", deps.now());
        }
        await recordRunUsage(run, deps.now());
        return run;
      }
      default:
        return (
          (await finishRun(
            run,
            deps,
            {
              status: "failed",
              errorCode: "provider_error",
              errorMessage: terminalError?.message ?? `The provider stopped the run (${last.stopReason.type === "other" ? last.stopReason.raw : last.stopReason.type}).`,
            },
            agentName,
          )) ?? run
        );
    }
  }
  if ((last?.status === "running" || last?.status === "rescheduling") && run.status !== "running") {
    run = await setStatus(run, "running", deps.now());
  }
  await recordRunUsage(run, deps.now());
  return run;
}

async function setStatus(run: CloudRunRow, status: "running" | "waiting_approval", now: Date, errorMessage?: string) {
  if (run.status === status && errorMessage === undefined) return run;
  const [row] = await db
    .update(schema.cloudAgentRuns)
    .set({ status, updatedAt: now, ...(errorMessage !== undefined ? { errorMessage } : {}) })
    .where(activeRunWhere(run.id))
    .returning();
  return row ?? (await reload(run.id)) ?? run;
}

async function reload(runId: string) {
  const [row] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, runId)).limit(1);
  return row ?? null;
}

function traceOf(event: ProviderEvent): Parameters<typeof mirrorTraceEvents>[1][number] | null {
  const base = { sourceEventId: event.id, at: event.at };
  switch (event.kind) {
    case "message":
      return { ...base, type: "message" satisfies CloudRunEvent["type"], role: event.role, text: event.text };
    case "tool_use":
      return {
        ...base,
        type: "tool_call",
        tool: event.server ? `${event.server}.${event.tool}` : event.tool,
        text: safeJson(event.input),
        status: event.permission === "ask" ? "waiting_approval" : undefined,
      };
    case "tool_result":
      return { ...base, type: "tool_result", text: event.text, status: event.isError ? "error" : "ok", severity: event.isError ? "warning" : "info" };
    case "status":
      return {
        ...base,
        type: "status",
        status: event.stopReason ? `${event.status}:${event.stopReason.type}` : event.status,
      };
    case "error":
      return { ...base, type: "error", text: `${event.errorType}: ${event.message}`, status: event.retrying ? "retrying" : "failed" };
    default:
      return null;
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

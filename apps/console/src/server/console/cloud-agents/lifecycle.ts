// Run state shared by start, sync, approvals and the tick: the sync state kept
// in `event_cursor`, the trace mirror, terminal transitions (revoke the run
// token, record usage, notify the actor) and run links.

import { and, eq, inArray, sql } from "drizzle-orm";

import { orgPath, orgSegment } from "@/lib/console-paths";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { isUuidRef } from "@/server/console/ref";

import { assertCloudProjectAccess, type CloudContext, type ResolvedCloudDeps } from "./access";
import { cloudError } from "./errors";
import { revokeCloudRunTokenChain } from "./mcp";
import type { ProviderStopReason } from "./providers/types";
import { notifyCloudActor, recordCloudRunUsage } from "./records";
import { CLOUD_ACTIVE_RUN_STATUSES, type CloudRunEvent, type CloudRunStatus } from "./types";

export type CloudRunRow = typeof schema.cloudAgentRuns.$inferSelect;

export const CLOUD_RUN_HARD_END_MS = 24 * 60 * 60_000;
export const CLOUD_PREVIEW_MAX = 2000;

/**
 * What sync remembers between passes: the provider's opaque event cursor and
 * the last session status it read from the events. A follow-up message or an
 * approval clears `last`, so an old idle status never ends the new turn.
 */
export type CloudSyncState = {
  cursor: string | null;
  last: { status: string; stopReason: ProviderStopReason | null } | null;
};

export function readSyncState(raw: string | null): CloudSyncState {
  if (!raw) return { cursor: null, last: null };
  try {
    const value = JSON.parse(raw) as Partial<CloudSyncState>;
    return { cursor: typeof value.cursor === "string" ? value.cursor : null, last: value.last ?? null };
  } catch {
    return { cursor: null, last: null };
  }
}

export function writeSyncState(state: CloudSyncState) {
  return JSON.stringify(state);
}

export function isActiveStatus(status: string): status is "starting" | "running" | "waiting_approval" {
  return (CLOUD_ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** The run, only while it is active: every non-terminal update uses it, so an ended run never comes back. */
export function activeRunWhere(runId: string) {
  return and(eq(schema.cloudAgentRuns.id, runId), inArray(schema.cloudAgentRuns.status, [...CLOUD_ACTIVE_RUN_STATUSES]));
}

export async function runUrl(deps: Pick<ResolvedCloudDeps, "consoleOrigin">, run: Pick<CloudRunRow, "id" | "organizationId" | "projectId">) {
  const [organization] = await db
    .select({ id: schema.organizations.id, slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, run.organizationId))
    .limit(1);
  return `${deps.consoleOrigin}${orgPath(orgSegment(organization ?? { id: run.organizationId }), `/p/${run.projectId}/cloud/runs/${run.id}`)}`;
}

/**
 * Mirrors normalized run events into the run's runtime trace (dedupes by event
 * id). Sequences come from an atomic bump of `event_count`, so concurrent
 * mirrors (a sync and an approval) never share one; a duplicate leaves a gap.
 */
export async function mirrorTraceEvents(
  run: Pick<CloudRunRow, "id" | "organizationId" | "runtimeTraceSessionId">,
  input: { sourceEventId: string; at: Date; type: CloudRunEvent["type"]; role?: string; text?: string; tool?: string; status?: string; severity?: string }[],
) {
  if (!run.runtimeTraceSessionId || input.length === 0) return;
  const known = new Set(
    (
      await db
        .select({ sourceEventId: schema.runtimeTraceEvents.sourceEventId })
        .from(schema.runtimeTraceEvents)
        .where(
          and(
            eq(schema.runtimeTraceEvents.traceSessionId, run.runtimeTraceSessionId),
            inArray(
              schema.runtimeTraceEvents.sourceEventId,
              input.map((event) => event.sourceEventId),
            ),
          ),
        )
    ).map((row) => row.sourceEventId),
  );
  const events = input.filter((event, index) => !known.has(event.sourceEventId) && input.findIndex((other) => other.sourceEventId === event.sourceEventId) === index);
  if (events.length === 0) return;
  const [reserved] = await db
    .update(schema.cloudAgentRuns)
    .set({ eventCount: sql`${schema.cloudAgentRuns.eventCount} + ${events.length}` })
    .where(eq(schema.cloudAgentRuns.id, run.id))
    .returning({ eventCount: schema.cloudAgentRuns.eventCount });
  if (!reserved) return;
  let sequence = reserved.eventCount - events.length;
  const rows = events.map((event) => {
    sequence += 1;
    const payload: JsonRecord = {};
    if (event.role) payload.role = event.role;
    if (event.tool) payload.tool = event.tool;
    if (event.status) payload.status = event.status;
    return {
      traceSessionId: run.runtimeTraceSessionId!,
      organizationId: run.organizationId,
      sourceEventId: event.sourceEventId,
      sequence,
      eventType: event.type,
      eventGroup: "cloud_agents",
      severity: event.severity ?? (event.type === "error" ? "error" : "info"),
      status: event.status ?? null,
      safePreview: event.text ? event.text.slice(0, CLOUD_PREVIEW_MAX) : null,
      safePayloadJson: payload,
      occurredAt: event.at,
    };
  });
  await db.insert(schema.runtimeTraceEvents).values(rows).onConflictDoNothing();
}

/**
 * Moves an active run to a terminal status once: revokes the run token chain,
 * closes the trace, records final usage and notifies the actor. Returns false
 * when another pass got there first.
 */
export async function finishRun(
  run: CloudRunRow,
  deps: ResolvedCloudDeps,
  outcome: { status: Exclude<CloudRunStatus, "starting" | "running" | "waiting_approval">; errorCode?: string | null; errorMessage?: string | null },
  agentName: string,
) {
  const now = deps.now();
  const [finished] = await db
    .update(schema.cloudAgentRuns)
    .set({
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      errorMessage: outcome.errorMessage?.slice(0, 500) ?? null,
      endedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.cloudAgentRuns.id, run.id), inArray(schema.cloudAgentRuns.status, [...CLOUD_ACTIVE_RUN_STATUSES])))
    .returning();
  if (!finished) return null;

  await revokeCloudRunTokenChain(finished.mcpTokenId, now);
  // Pending approvals of an ended run can no longer run anything.
  await db
    .update(schema.cloudAgentApprovals)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(schema.cloudAgentApprovals.runId, run.id), eq(schema.cloudAgentApprovals.status, "pending")));
  if (finished.runtimeTraceSessionId) {
    await db
      .update(schema.runtimeTraceSessions)
      .set({ status: outcome.status, endedAt: now, updatedAt: now })
      .where(eq(schema.runtimeTraceSessions.id, finished.runtimeTraceSessionId));
  }
  await recordRunUsage(finished, now);

  const url = await runUrl(deps, finished);
  const severity =
    outcome.status === "completed" ? "success" : outcome.status === "stopped" ? "info" : outcome.status === "budget_exceeded" ? "warning" : "error";
  const what =
    outcome.status === "completed"
      ? "finished"
      : outcome.status === "stopped"
        ? "was stopped"
        : outcome.status === "budget_exceeded"
          ? "reached its budget"
          : "failed";
  await notifyCloudActor({
    organizationId: finished.organizationId,
    projectId: finished.projectId,
    userId: finished.actorUserId,
    eventType: "cloud_agents.run.ended",
    severity,
    title: `Cloud run of ${agentName} ${what}`,
    summary: [
      `US$ ${(finished.costUsdMicros / 1_000_000).toFixed(2)} of US$ ${(finished.budgetUsdCents / 100).toFixed(2)}`,
      outcome.errorMessage ? outcome.errorMessage.slice(0, 300) : null,
    ]
      .filter(Boolean)
      .join(". "),
    sourceId: finished.id,
    dedupeKey: `cloud_agents:run:${finished.id}:ended`,
    url,
    payload: { runId: finished.id, agentId: finished.agentId, status: outcome.status, trigger: finished.trigger },
    occurredAt: now,
  });
  return finished;
}

/** Writes this run's usage deltas and remembers what was recorded. */
export async function recordRunUsage(run: CloudRunRow, now: Date) {
  const recorded = (run.usageRecordedJson ?? {}) as { runs?: number; runningSeconds?: number; costMicros?: number };
  const next = await recordCloudRunUsage({
    organizationId: run.organizationId,
    projectId: run.projectId,
    runId: run.id,
    agentId: run.agentId,
    trigger: run.trigger,
    requestId: null,
    recorded,
    current: { runningSeconds: run.runningSeconds, costMicros: run.costUsdMicros },
    occurredAt: now,
  });
  if (next.runs !== recorded.runs || next.runningSeconds !== recorded.runningSeconds || next.costMicros !== recorded.costMicros) {
    await db
      .update(schema.cloudAgentRuns)
      .set({ usageRecordedJson: next })
      .where(eq(schema.cloudAgentRuns.id, run.id));
  }
}

/** Claims a sync pass: only one pass per run every `minAgeMs`. */
export async function claimSync(runId: string, now: Date, minAgeMs: number) {
  const [row] = await db
    .update(schema.cloudAgentRuns)
    .set({ lastSyncedAt: now })
    .where(
      and(
        eq(schema.cloudAgentRuns.id, runId),
        sql`(${schema.cloudAgentRuns.lastSyncedAt} is null or ${schema.cloudAgentRuns.lastSyncedAt} < ${new Date(now.getTime() - minAgeMs).toISOString()}::timestamptz)`,
      ),
    )
    .returning();
  return row ?? null;
}

/** A run of the caller's organization the caller may read or act on; not found otherwise. */
export async function loadRunForCaller(ctx: CloudContext, runId: string, action: "read" | "write") {
  if (!isUuidRef(runId)) throw cloudError("not_found", "Cloud run not found.");
  const [row] = await db
    .select({ run: schema.cloudAgentRuns, agentName: schema.cloudAgents.name, agentConfig: schema.cloudAgents.configJson })
    .from(schema.cloudAgentRuns)
    .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentRuns.agentId))
    .where(and(eq(schema.cloudAgentRuns.id, runId), eq(schema.cloudAgentRuns.organizationId, ctx.workspace.organization.id)))
    .limit(1);
  if (!row) throw cloudError("not_found", "Cloud run not found.");
  await assertCloudProjectAccess(ctx.workspace, row.run.projectId, action);
  return row;
}

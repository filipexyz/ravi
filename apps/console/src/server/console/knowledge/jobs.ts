import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { KnowledgeDbExecutor } from "./types";

// A small Postgres job queue for capture work, on the agent-inbox outbox
// pattern: claim with a lease, run the handler, record the outcome on the
// claimed row. A `running` job whose lease expired (the function was killed)
// is claimed again; one that already used every attempt is dead-lettered.
// Jobs are claimed one at a time, right before they run, so a lease never
// expires while the job waits behind others in the same drain; the outcome is
// written only while this worker still holds the lease.

const LOCK_MS = 60_000;
const BATCH_SIZE = 25;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_DRAIN_LIMIT = 25;
const DEFAULT_DRAIN_BUDGET_MS = 45_000;
const DEAD_LETTER = "dead_letter";
const HANDLER_FAILED = "handler_failed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KnowledgeTriggerType =
  | "manual"
  | "meeting_ready"
  | "meeting_repair"
  | "meeting_backfill"
  | "page_release"
  | "page_backfill"
  | "proposal_approved"
  | "faq"
  | "vector_backfill";

export type KnowledgeJobRow = typeof schema.knowledgeIngestionJobs.$inferSelect;

export type KnowledgeJobHandler = (
  job: KnowledgeJobRow,
  ctx: { requestId: string; now: Date },
) => Promise<{ resultJson?: JsonRecord }>;

/** Inserts a queued job, or finds the one already holding `(organization, idempotencyKey)`. */
export async function enqueueKnowledgeJob(
  input: {
    organizationId: string;
    projectId: string | null;
    sourceId: string;
    triggerType: KnowledgeTriggerType;
    inputJson: JsonRecord;
    idempotencyKey: string;
    requestId: string;
    actor: { type: "system" | "user" | "cli"; id: string | null };
  },
  executor: KnowledgeDbExecutor = db,
): Promise<{ jobId: string; created: boolean }> {
  const [created] = await executor
    .insert(schema.knowledgeIngestionJobs)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      status: "queued",
      triggerType: input.triggerType,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      inputJson: input.inputJson,
      requestedByActorType: input.actor.type,
      requestedByActorId: input.actor.id,
    })
    .onConflictDoNothing({
      target: [schema.knowledgeIngestionJobs.organizationId, schema.knowledgeIngestionJobs.idempotencyKey],
    })
    .returning({ id: schema.knowledgeIngestionJobs.id });
  if (created) return { jobId: created.id, created: true };

  const [existing] = await executor
    .select({ id: schema.knowledgeIngestionJobs.id })
    .from(schema.knowledgeIngestionJobs)
    .where(
      and(
        eq(schema.knowledgeIngestionJobs.organizationId, input.organizationId),
        eq(schema.knowledgeIngestionJobs.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Failed to enqueue the knowledge job.");
  return { jobId: existing.id, created: false };
}

/** Claims due jobs that have a handler, one at a time right before each runs, until the limit or the budget is reached. */
export async function drainKnowledgeJobs(input: {
  handlers: Partial<Record<KnowledgeTriggerType, KnowledgeJobHandler>>;
  limit?: number;
  budgetMs?: number;
  workerId: string;
  requestId: string;
  now?: () => Date;
}): Promise<{ claimed: number; completed: number; failed: number; deadLettered: number }> {
  const clock = input.now ?? (() => new Date());
  const startedAt = Date.now();
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_DRAIN_LIMIT));
  const budgetMs = Math.max(0, input.budgetMs ?? DEFAULT_DRAIN_BUDGET_MS);
  const triggerTypes = Object.entries(input.handlers)
    .filter(([, handler]) => typeof handler === "function")
    .map(([triggerType]) => triggerType);
  const counts = { claimed: 0, completed: 0, failed: 0, deadLettered: 0 };
  if (triggerTypes.length === 0) return counts;

  counts.deadLettered += await deadLetterExpiredAtCap(triggerTypes, clock());

  let skip: string[] = [];
  while (counts.claimed < limit && Date.now() - startedAt < budgetMs) {
    const candidates = await claimableKnowledgeJobIds({ limit: BATCH_SIZE, now: clock(), triggerTypes, skip });
    if (candidates.length === 0) break;

    let job: KnowledgeJobRow | null = null;
    for (const candidate of candidates) {
      // Another worker may have taken it since the select; try the next one.
      job = await claimKnowledgeJob({ id: candidate, now: clock(), workerId: input.workerId });
      if (job) break;
      skip = [...skip, candidate];
    }
    if (!job) continue;
    counts.claimed += 1;

    const handler = input.handlers[job.triggerType as KnowledgeTriggerType];
    if (!handler) continue;
    try {
      const result = await handler(job, { requestId: input.requestId, now: clock() });
      if (await completeKnowledgeJob(job, result.resultJson ?? {}, clock(), input.workerId)) counts.completed += 1;
    } catch (error) {
      const outcome = await failKnowledgeJob(job, error, clock(), input.workerId);
      if (outcome === "dead_lettered") counts.deadLettered += 1;
      else if (outcome === "failed") counts.failed += 1;
    }
  }
  return counts;
}

export function nextKnowledgeJobAttemptAt(attempt: number, now: Date): Date {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
  return new Date(now.getTime() + delay);
}

/** The error's code (a `ConsoleApiError`'s `error`, or `.code`), else `handler_failed`. Never the message. */
export function knowledgeJobFailureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const payload = (error as { payload?: { error?: unknown } }).payload;
    if (typeof payload?.error === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(payload.error)) return payload.error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
  }
  return HANDLER_FAILED;
}

function knowledgeJobFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || "Error";
  return typeof error;
}

async function deadLetterExpiredAtCap(triggerTypes: string[], now: Date) {
  const rows = await db
    .update(schema.knowledgeIngestionJobs)
    .set({
      status: "canceled",
      failureCode: DEAD_LETTER,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.knowledgeIngestionJobs.status, "running"),
        inArray(schema.knowledgeIngestionJobs.triggerType, triggerTypes),
        sql`${schema.knowledgeIngestionJobs.lockedUntil} < ${now.toISOString()}::timestamptz`,
        sql`${schema.knowledgeIngestionJobs.attempts} >= ${schema.knowledgeIngestionJobs.maxAttempts}`,
      ),
    )
    .returning({ id: schema.knowledgeIngestionJobs.id });
  return rows.length;
}

function claimablePredicate(now: Date) {
  const at = now.toISOString();
  const jobs = schema.knowledgeIngestionJobs;
  return sql`(((${jobs.status} in ('queued', 'failed') and coalesce(${jobs.nextAttemptAt}, ${jobs.createdAt}) <= ${at}::timestamptz and (${jobs.lockedUntil} is null or ${jobs.lockedUntil} < ${at}::timestamptz)) or (${jobs.status} = 'running' and ${jobs.lockedUntil} < ${at}::timestamptz)) and ${jobs.attempts} < ${jobs.maxAttempts})`;
}

async function claimableKnowledgeJobIds(input: { limit: number; now: Date; triggerTypes: string[]; skip: readonly string[] }) {
  const jobs = schema.knowledgeIngestionJobs;
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.triggerType, input.triggerTypes),
        claimablePredicate(input.now),
        input.skip.length > 0 ? notInArray(jobs.id, [...input.skip]) : undefined,
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

/** Leases one job for LOCK_MS from now, re-checking that it is still claimable. */
async function claimKnowledgeJob(input: { id: string; now: Date; workerId: string }): Promise<KnowledgeJobRow | null> {
  const jobs = schema.knowledgeIngestionJobs;
  const [row] = await db
    .update(jobs)
    .set({
      status: "running",
      lockedBy: input.workerId,
      lockedUntil: new Date(input.now.getTime() + LOCK_MS),
      attempts: sql`${jobs.attempts} + 1`,
      startedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(jobs.id, input.id), claimablePredicate(input.now)))
    .returning();
  return row ?? null;
}

/** The outcome counts only while this worker still holds the job; a reclaimed job belongs to its new worker. */
function heldBy(job: KnowledgeJobRow, workerId: string) {
  const jobs = schema.knowledgeIngestionJobs;
  return and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId), eq(jobs.attempts, job.attempts));
}

async function completeKnowledgeJob(job: KnowledgeJobRow, resultJson: JsonRecord, now: Date, workerId: string): Promise<boolean> {
  const documentId = typeof resultJson.documentId === "string" && UUID.test(resultJson.documentId) ? resultJson.documentId : null;
  const rows = await db
    .update(schema.knowledgeIngestionJobs)
    .set({
      status: "completed",
      resultJson,
      // The document the handler wrote, when it still exists (a site move may have deleted it meanwhile).
      ...(documentId
        ? { documentId: sql`(SELECT id FROM ${schema.knowledgeDocuments} WHERE id = ${documentId}::uuid)` }
        : {}),
      failureCode: null,
      failureMessage: null,
      finishedAt: now,
      lockedBy: null,
      lockedUntil: null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(heldBy(job, workerId))
    .returning({ id: schema.knowledgeIngestionJobs.id });
  return rows.length > 0;
}

async function failKnowledgeJob(
  job: KnowledgeJobRow,
  error: unknown,
  now: Date,
  workerId: string,
): Promise<"failed" | "dead_lettered" | "lost"> {
  const deadLettered = job.attempts >= job.maxAttempts;
  const rows = await db
    .update(schema.knowledgeIngestionJobs)
    .set({
      status: deadLettered ? "canceled" : "failed",
      failureCode: deadLettered ? DEAD_LETTER : knowledgeJobFailureCode(error),
      failureMessage: knowledgeJobFailureMessage(error),
      nextAttemptAt: deadLettered ? null : nextKnowledgeJobAttemptAt(job.attempts, now),
      finishedAt: deadLettered ? now : null,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(heldBy(job, workerId))
    .returning({ id: schema.knowledgeIngestionJobs.id });
  if (rows.length === 0) return "lost";
  return deadLettered ? "dead_lettered" : "failed";
}

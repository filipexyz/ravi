import { eq, isNull, sql } from "drizzle-orm";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { adminJson, adminRequestId, gateAdminRequest } from "@/server/admin/http";
import { db, schema } from "@/server/db";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

import { isKnowledgeEnabledForOrganization } from "./enabled";
import { KNOWLEDGE_JOB_HANDLERS, MEETING_TERMINAL_STATUSES } from "./job-handlers";
import { drainKnowledgeJobs } from "./jobs";
import { enqueueMeetingKnowledgeCapture } from "./producers/meeting";
import { runKnowledgeRetention, type KnowledgeRetentionResult } from "./retention";
import { knowledgeSearchVectorSql } from "./search-vector";

// The Knowledge cron (every 10 minutes, `vercel.json`): drain capture jobs,
// repair meetings the webhook missed, fill search vectors a writer left null,
// apply retention, and drain again with what is left of the budget.

const DRAIN_LIMIT = 50;
const MEETING_REPAIR_LIMIT = 25;
const MEETING_REPAIR_SCAN = 200;
const MEETING_REPAIR_WINDOW_DAYS = 7;
const VECTOR_BACKFILL_LIMIT = 500;
/** Each step starts only with at least this much budget left. */
const STEP_RESERVE_MS = 5_000;
/** The route's budget: `maxDuration` is 300 s, so the tick stops early enough to answer. */
export const KNOWLEDGE_TICK_ROUTE_BUDGET_MS = 240_000;

export type KnowledgeTickResult = {
  jobs: { claimed: number; completed: number; failed: number; deadLettered: number };
  meetingRepairs: number;
  vectorBackfill: number;
  purged: KnowledgeRetentionResult;
  budgetExhausted: boolean;
};

export type KnowledgeTickDeps = {
  enabled?: (organizationId: string) => Promise<boolean>;
  drain?: typeof drainKnowledgeJobs;
  retention?: typeof runKnowledgeRetention;
};

export async function runKnowledgeTick(
  input: { requestId: string; budgetMs: number; now?: () => Date },
  deps: KnowledgeTickDeps = {},
): Promise<KnowledgeTickResult> {
  const clock = input.now ?? (() => new Date());
  const startedAt = Date.now();
  const remaining = () => input.budgetMs - (Date.now() - startedAt);
  const result: KnowledgeTickResult = {
    jobs: { claimed: 0, completed: 0, failed: 0, deadLettered: 0 },
    meetingRepairs: 0,
    vectorBackfill: 0,
    purged: { queryTexts: 0, runs: 0, meetingSources: 0, archivedDocuments: 0, proposalsExpired: 0, proposalBodies: 0, jobs: 0 },
    budgetExhausted: false,
  };
  const workerId = `tick:${randomUUID()}`;
  const drain = deps.drain ?? drainKnowledgeJobs;
  const step = async (run: () => Promise<void>) => {
    if (remaining() < STEP_RESERVE_MS) {
      result.budgetExhausted = true;
      return;
    }
    await run();
  };
  const drainOnce = async () => {
    const counts = await drain({
      handlers: KNOWLEDGE_JOB_HANDLERS,
      limit: DRAIN_LIMIT,
      budgetMs: Math.max(0, remaining() - STEP_RESERVE_MS),
      workerId,
      requestId: input.requestId,
      now: clock,
    });
    result.jobs.claimed += counts.claimed;
    result.jobs.completed += counts.completed;
    result.jobs.failed += counts.failed;
    result.jobs.deadLettered += counts.deadLettered;
  };

  await step(drainOnce);
  await step(async () => {
    result.meetingRepairs = await repairMeetings({ requestId: input.requestId, now: clock() }, deps);
  });
  await step(async () => {
    result.vectorBackfill = await backfillSearchVectors();
  });
  await step(async () => {
    result.purged = await (deps.retention ?? runKnowledgeRetention)({
      requestId: input.requestId,
      now: clock,
      outOfBudget: () => remaining() < STEP_RESERVE_MS,
    });
  });
  await step(drainOnce);
  return result;
}

/**
 * Done meetings of the last 7 days, in organizations with Knowledge on, that
 * have no readable transcript yet. Skipped: a source a person deleted, a
 * meeting that already has a repair job (whatever its outcome), and one whose
 * ready job is still pending or ended `gone`/`no_project`/`not_found` or dead.
 */
export async function repairMeetings(input: { requestId: string; now: Date }, deps: Pick<KnowledgeTickDeps, "enabled"> = {}): Promise<number> {
  const since = new Date(input.now.getTime() - MEETING_REPAIR_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const terminal = sql.join(
    MEETING_TERMINAL_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT m.id, m.organization_id, m.project_id, m.title
    FROM ${schema.meetingBots} AS m
    WHERE m.status = 'done'
      AND m.provider_bot_id IS NOT NULL
      AND m.project_id IS NOT NULL
      AND m.created_at > ${since}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM ${schema.knowledgeSources} AS s
        WHERE s.organization_id = m.organization_id AND s.origin_key = 'meeting:' || m.id::text
          AND (s.status = 'deleted' OR EXISTS (
            SELECT 1 FROM ${schema.knowledgeDocuments} AS d WHERE d.source_id = s.id AND d.status IN ('chunked', 'indexed')
          ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${schema.knowledgeIngestionJobs} AS j
        WHERE j.organization_id = m.organization_id
          AND (
            j.idempotency_key = 'meeting_repair:' || m.id::text
            OR (
              j.idempotency_key = 'meeting_ready:' || m.id::text
              AND (j.status IN ('queued', 'running', 'failed', 'canceled')
                OR (j.status = 'completed' AND j.result_json->>'status' IN (${terminal})))
            )
          )
      )
    ORDER BY m.created_at DESC
    LIMIT ${MEETING_REPAIR_SCAN}
  `)) as unknown as Array<{ id: string; organization_id: string; project_id: string; title: string | null }>;

  const enabled = deps.enabled ?? isKnowledgeEnabledForOrganization;
  const enabledByOrg = new Map<string, boolean>();
  let queued = 0;
  for (const row of rows) {
    if (queued >= MEETING_REPAIR_LIMIT) break;
    let on = enabledByOrg.get(row.organization_id);
    if (on === undefined) {
      on = await enabled(row.organization_id);
      enabledByOrg.set(row.organization_id, on);
    }
    if (!on) continue;
    const result = await enqueueMeetingKnowledgeCapture({
      organizationId: row.organization_id,
      projectId: row.project_id,
      meetingId: row.id,
      title: row.title,
      trigger: "meeting_repair",
      requestId: input.requestId,
    });
    if (result.created) queued += 1;
  }
  return queued;
}

/** Chunks a writer left without vectors: both recomputed from the stored text, heading, speakers and source title. */
export async function backfillSearchVectors(limit = VECTOR_BACKFILL_LIMIT): Promise<number> {
  const rows = await db
    .select({
      id: schema.knowledgeChunks.id,
      text: schema.knowledgeChunks.text,
      metadata: schema.knowledgeChunks.safeMetadataJson,
      title: schema.knowledgeSources.title,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeChunks.sourceId, schema.knowledgeSources.id))
    .where(isNull(schema.knowledgeChunks.searchVector))
    .limit(limit);
  for (const row of rows) {
    const heading = typeof row.metadata.heading === "string" ? row.metadata.heading : null;
    const speakers = Array.isArray(row.metadata.speakersFolded)
      ? row.metadata.speakersFolded.filter((item): item is string => typeof item === "string")
      : [];
    const vectors = knowledgeSearchVectorSql({ title: row.title, heading, text: row.text, speakers });
    await db
      .update(schema.knowledgeChunks)
      .set({ searchVector: vectors.searchVector, searchVectorStem: vectors.searchVectorStem })
      .where(eq(schema.knowledgeChunks.id, row.id));
  }
  return rows.length;
}

export type KnowledgeTickHttpDeps = {
  runTick?: (input: { requestId: string; budgetMs: number }) => Promise<KnowledgeTickResult>;
  /** Defaults to `process.env.CRON_SECRET`. */
  cronSecret?: () => string | undefined;
};

/**
 * `GET|POST /api/internal/admin/knowledge/tick`. GET is the Vercel cron and is
 * authorized only by `Bearer <CRON_SECRET>` (503 when the secret is unset, so
 * nothing is compared against an empty value); the admin token is never
 * accepted on GET. POST is the manual run, behind `gateAdminRequest`.
 */
export async function handleKnowledgeTickHttp(request: Request, deps: KnowledgeTickHttpDeps = {}): Promise<Response> {
  let requestId: string;
  if (request.method === "GET") {
    requestId = adminRequestId(request);
    const secret = (deps.cronSecret ?? (() => process.env.CRON_SECRET))()?.trim();
    if (!secret) {
      console.error("knowledge_tick_cron_secret_missing", { requestId });
      return adminJson({ status: "error", code: "cron_secret_not_configured", requestId }, 503, requestId);
    }
    if (!bearerMatches(request, secret)) {
      if (isRateLimited({ key: rateLimitKey(request, "knowledge-tick"), limit: 10, windowMs: 60_000 })) {
        return adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId);
      }
      return adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId);
    }
  } else {
    const gate = gateAdminRequest(request, { rateLimitName: "knowledge-tick", missingTokenLog: "knowledge_tick_admin_token_missing" });
    if (!gate.ok) return gate.response;
    requestId = gate.requestId;
  }

  try {
    const result = await (deps.runTick ?? runKnowledgeTick)({ requestId, budgetMs: KNOWLEDGE_TICK_ROUTE_BUDGET_MS });
    return adminJson({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    console.error("knowledge_tick_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "knowledge_tick_failed", requestId }, 500, requestId);
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

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  TRIAGE_ENGINE_NOT_CONFIGURED,
  isBugTriageEngineConfigured,
} from "@/server/console/bug-triage-config";
import {
  BugTriageEngineError,
  completeBugTriageSuggestion,
} from "@/server/console/bug-triage-engine";
import {
  getAdminBugReport,
  persistStoredBugTriage,
  type AdminBugReportDetail,
  type BugTriageJobSummary,
  type BugTriageJobTrigger,
  type BugTriageV1,
} from "@/server/console/bug-reports";
import { db, schema } from "@/server/db";

export const BUG_TRIAGE_JOB_MAX_ATTEMPTS = 5;
export const BUG_TRIAGE_JOB_LOCK_MS = 60_000;

export type RunBugTriageJobsResult = {
  claimed: number;
  completed: number;
  failed: number;
};

export type BugTriageCompleter = (report: AdminBugReportDetail) => Promise<BugTriageV1>;

export async function runBugTriageJobs(input: {
  limit?: number;
  now?: Date;
  complete?: BugTriageCompleter;
} = {}): Promise<RunBugTriageJobsResult> {
  const limit = boundedLimit(input.limit);
  const now = input.now ?? new Date();
  const claimed = await claimBugTriageJobs({ limit, now });
  let completed = 0;
  let failed = 0;

  for (const job of claimed) {
    const outcome = await processClaimedBugTriageJob(job, { complete: input.complete });
    if (outcome === "completed") completed += 1;
    else failed += 1;
  }

  return { claimed: claimed.length, completed, failed };
}

export async function claimBugTriageJobs(input: { limit: number; now: Date }) {
  const lockUntil = new Date(input.now.getTime() + BUG_TRIAGE_JOB_LOCK_MS);
  const candidates = await db
    .select()
    .from(schema.bugTriageJobs)
    .where(
      and(
        inArray(schema.bugTriageJobs.status, ["queued", "failed"]),
        lte(schema.bugTriageJobs.attempts, BUG_TRIAGE_JOB_MAX_ATTEMPTS - 1),
        or(isNull(schema.bugTriageJobs.lockedUntil), lte(schema.bugTriageJobs.lockedUntil, input.now)),
      ),
    )
    .orderBy(asc(schema.bugTriageJobs.createdAt))
    .limit(input.limit);

  const claimed: Array<typeof schema.bugTriageJobs.$inferSelect> = [];
  for (const candidate of candidates) {
    const [row] = await db
      .update(schema.bugTriageJobs)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        lockedUntil: lockUntil,
        startedAt: candidate.startedAt ?? input.now,
        updatedAt: input.now,
        lastError: null,
      })
      .where(
        and(
          eq(schema.bugTriageJobs.id, candidate.id),
          inArray(schema.bugTriageJobs.status, ["queued", "failed"]),
          or(isNull(schema.bugTriageJobs.lockedUntil), lte(schema.bugTriageJobs.lockedUntil, input.now)),
        ),
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function processClaimedBugTriageJob(
  job: typeof schema.bugTriageJobs.$inferSelect,
  deps: { complete?: BugTriageCompleter } = {},
): Promise<"completed" | "failed"> {
  try {
    const report = await getAdminBugReport(job.bugReportId);
    const complete = deps.complete ?? defaultComplete;
    const triage = await complete(report);
    await persistStoredBugTriage({
      id: report.id,
      triage,
      requestId: job.requestId ?? job.id,
    });
    await markJob(job.id, {
      status: "completed",
      lastError: null,
      finishedAt: new Date(),
    });
    return "completed";
  } catch (error) {
    const code = jobFailureCode(error);
    await markJob(job.id, {
      status: "failed",
      lastError: code,
      finishedAt: new Date(),
    });
    return "failed";
  }
}

async function defaultComplete(report: AdminBugReportDetail): Promise<BugTriageV1> {
  return completeBugTriageSuggestion({
    report: {
      title: report.title,
      summary: report.summary,
      severity: report.severity,
      surface: report.surface,
      payload: report.payload,
    },
  });
}

async function markJob(
  id: string,
  input: {
    status: "completed" | "failed";
    lastError: string | null;
    finishedAt: Date;
  },
) {
  await db
    .update(schema.bugTriageJobs)
    .set({
      status: input.status,
      lastError: input.lastError,
      finishedAt: input.finishedAt,
      lockedUntil: null,
      updatedAt: input.finishedAt,
    })
    .where(eq(schema.bugTriageJobs.id, id));
}

function jobFailureCode(error: unknown) {
  if (error instanceof BugTriageEngineError) return error.code;
  if (error instanceof ConsoleApiError) return error.payload.error;
  if (!isBugTriageEngineConfigured()) return TRIAGE_ENGINE_NOT_CONFIGURED;
  return "triage_job_failed";
}

function boundedLimit(value: number | undefined) {
  if (!Number.isInteger(value) || !value || value < 1) return 5;
  return Math.min(value, 25);
}

export function isActiveTriageJobStatus(status: string) {
  return status === "queued" || status === "running";
}

export type { BugTriageJobSummary, BugTriageJobTrigger };

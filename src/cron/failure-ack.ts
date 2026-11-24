// Settle cron failure reports the owner chose not to receive.
//
// A failed run stays `reported = 0` until its notice reaches the owner, and every
// start retries it. When the owner's direct channel is gone for good, the queue
// only grows and nothing can drain it. Acknowledging marks those runs reported
// without sending anything; the run stays `error` and its diagnostics stay put.

import { pendingCronFailureReports, markCronRunReported, cronRunNotification, type CronRunRow } from "./run-db.js";

export interface CronFailureAckJob {
  jobId: string;
  name: string | null;
  ownerAgentId: string | null;
  runIds: string[];
  oldestAt: number;
  newestAt: number;
}

export interface CronFailureAckPlan {
  pending: number;
  selected: number;
  denied: number;
  jobs: CronFailureAckJob[];
}

export interface CronFailureAckDeps {
  listPending?: () => CronRunRow[];
  markReported?: (runId: string) => void;
}

export interface CronFailureAckFilter {
  jobId?: string;
  /** Whether the caller may settle reports of a job owned by this agent. */
  canAck: (ownerAgentId: string | null) => boolean;
}

function runIdentity(run: CronRunRow): { name: string | null; ownerAgentId: string | null } {
  try {
    const notice = cronRunNotification(run);
    return { name: notice.name ?? null, ownerAgentId: notice.agentId ?? null };
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    // Unreadable notice: the job id is still known; ownership is not.
    return { name: null, ownerAgentId: null };
  }
}

export function planCronFailureAck(filter: CronFailureAckFilter, deps: CronFailureAckDeps = {}): CronFailureAckPlan {
  const all = (deps.listPending ?? pendingCronFailureReports)();
  const pending = filter.jobId ? all.filter((run) => run.job_id === filter.jobId) : all;
  const byJob = new Map<string, CronFailureAckJob>();
  let denied = 0;
  for (const run of pending) {
    const { name, ownerAgentId } = runIdentity(run);
    if (!filter.canAck(ownerAgentId)) {
      denied += 1;
      continue;
    }
    const entry = byJob.get(run.job_id) ?? {
      jobId: run.job_id,
      name,
      ownerAgentId,
      runIds: [],
      oldestAt: run.admitted_at,
      newestAt: run.admitted_at,
    };
    entry.runIds.push(run.id);
    entry.oldestAt = Math.min(entry.oldestAt, run.admitted_at);
    entry.newestAt = Math.max(entry.newestAt, run.admitted_at);
    byJob.set(run.job_id, entry);
  }
  const jobs = [...byJob.values()].sort((a, b) => b.runIds.length - a.runIds.length || a.jobId.localeCompare(b.jobId));
  const selected = jobs.reduce((total, job) => total + job.runIds.length, 0);
  return { pending: pending.length, selected, denied, jobs };
}

/** Marks every selected run reported. Returns how many were settled. */
export function applyCronFailureAck(plan: CronFailureAckPlan, deps: CronFailureAckDeps = {}): number {
  const mark = deps.markReported ?? markCronRunReported;
  let settled = 0;
  for (const job of plan.jobs) {
    for (const runId of job.runIds) {
      mark(runId);
      settled += 1;
    }
  }
  return settled;
}

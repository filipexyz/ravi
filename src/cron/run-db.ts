import { getDb } from "../router/router-db.js";
import { dbGetCronJob, dbMarkJobDispatched, dbRecordJobOutcome, dbDeleteCronJob } from "./cron-db.js";
import type { CronFailureJob } from "./failure-notification.js";
import type { CronJob, JobOutcomeUpdate } from "./types.js";

export interface CronRunRow {
  id: string;
  job_id: string;
  session_name: string;
  admitted_at: number;
  notification_json: string;
  status: "pending" | "ok" | "error";
  error: string | null;
}

export function getCronRun(id: string): CronRunRow | null {
  return getDb().query<CronRunRow, [string]>("SELECT * FROM cron_runs WHERE id = ?").get(id);
}

export function admitCronRun(
  id: string,
  job: CronJob,
  sessionName: string,
  admittedAt: number,
  nextRunAt?: number,
): void {
  const notification: CronFailureJob = {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    ownerPrincipal: job.ownerPrincipal ?? "unknown",
    lastRunAt: admittedAt,
    updatedAt: job.updatedAt,
    runId: id,
  };
  getDb()
    .transaction(() => {
      getDb()
        .query(`INSERT INTO cron_runs (id, job_id, session_name, admitted_at, notification_json, status)
      VALUES (?, ?, ?, ?, ?, 'pending')`)
        .run(id, job.id, sessionName, admittedAt, JSON.stringify(notification));
      dbMarkJobDispatched(job.id, { lastRunAt: admittedAt, nextRunAt });
    })
    .immediate();
}

/**
 * A visible run was admitted under a placeholder session; once its surface binds the real one,
 * the admission follows it, so the turn's outcome settles the run. Only from that placeholder.
 */
export function rebindCronRunSession(id: string, fromSessionName: string, toSessionName: string): boolean {
  return (
    getDb()
      .query("UPDATE cron_runs SET session_name = ? WHERE id = ? AND session_name = ? AND status = 'pending'")
      .run(toSessionName, id, fromSessionName).changes > 0
  );
}

/** Consume a specific run once; old results never overwrite a newer admission. */
export function settleCronRun(id: string, sessionName: string, outcome: JobOutcomeUpdate): CronRunRow | null {
  return getDb()
    .transaction(() => {
      const run = getCronRun(id);
      if (!run || run.status !== "pending" || run.session_name !== sessionName) return null;
      getDb()
        .query("UPDATE cron_runs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'pending'")
        .run(outcome.lastStatus, Date.now(), outcome.lastError ?? null, id);
      const latest = getDb()
        .query<CronRunRow, [string]>("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(run.job_id)!;
      if (latest.id === id) dbRecordJobOutcome(run.job_id, outcome);
      const pending = getDb()
        .query("SELECT 1 FROM cron_runs WHERE job_id = ? AND status = 'pending' LIMIT 1")
        .get(run.job_id);
      const job = dbGetCronJob(run.job_id);
      if (!pending && latest.status === "ok" && job && (job.deleteAfterRun || job.schedule.type === "at"))
        dbDeleteCronJob(job.id);
      return getCronRun(id);
    })
    .immediate();
}

export function pendingCronFailureReports(): CronRunRow[] {
  return getDb()
    .query<CronRunRow, []>("SELECT * FROM cron_runs WHERE status = 'error' AND reported = 0 ORDER BY rowid")
    .all();
}

/** Whether a failed run's report is still unsettled (an acknowledgement may have settled it meanwhile). */
export function isCronFailureReportPending(id: string): boolean {
  return Boolean(
    getDb().query<{ n: number }, [string]>("SELECT 1 AS n FROM cron_runs WHERE id = ? AND reported = 0").get(id),
  );
}

/** Failed runs of one job admitted after a moment (the last notice), settled or not. */
export function countCronFailuresSince(jobId: string, since: number): number {
  const row = getDb()
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM cron_runs WHERE job_id = ? AND status = 'error' AND admitted_at > ?",
    )
    .get(jobId, since);
  return row?.n ?? 0;
}

export function cronRunNotification(run: CronRunRow): CronFailureJob {
  return JSON.parse(run.notification_json) as CronFailureJob;
}

export function markCronRunReported(id: string): void {
  getDb().query("UPDATE cron_runs SET reported = 1 WHERE id = ?").run(id);
}

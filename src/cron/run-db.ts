import { getDb } from "../router/router-db.js";
import { dbGetCronJob, dbMarkJobDispatched, dbRecordJobOutcome, dbDeleteCronJob } from "./cron-db.js";
import type { CronFailureJob } from "./failure-notification.js";
import type { CronJob, JobOutcomeUpdate } from "./types.js";

interface CronRunRow {
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
    ownerPrincipal: job.ownerPrincipal ?? "operator",
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

export function cronRunNotification(run: CronRunRow): CronFailureJob {
  return JSON.parse(run.notification_json) as CronFailureJob;
}

export function markCronRunReported(id: string): void {
  getDb().query("UPDATE cron_runs SET reported = 1 WHERE id = ?").run(id);
}

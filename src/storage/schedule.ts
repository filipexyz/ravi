/**
 * `ravi storage schedule` — idempotent management of the single weekly cron.
 *
 * The command never creates a duplicate: it looks the job up by its fixed name
 * and either creates it, corrects drift (schedule, command, timeout, error
 * notification, enabled state), or reports it unchanged.
 *
 * The store is injected so tests never touch the host cron database.
 */

import {
  STORAGE_SCHEDULE_COMMAND,
  STORAGE_SCHEDULE_CRON,
  STORAGE_SCHEDULE_NAME,
  STORAGE_SCHEDULE_NOTIFY_SESSION,
  STORAGE_SCHEDULE_TIMEOUT_MS,
  STORAGE_SCHEDULE_TIMEZONE,
} from "./policy.js";
import type { CronJob, CronJobInput } from "../cron/types.js";

export const STORAGE_SCHEDULE_DESCRIPTION =
  "Weekly ravi storage cleanup (Sunday 04:00 America/Sao_Paulo; cleanup --tier weekly --execute)";

export interface StorageScheduleStore {
  list(): CronJob[];
  create(input: CronJobInput): CronJob;
  update(id: string, patch: Partial<CronJob>): CronJob;
}

export type StorageScheduleAction = "create" | "update" | "unchanged";

export interface StorageSchedulePlan {
  action: StorageScheduleAction;
  jobId: string | null;
  definition: CronJobInput;
  changes: string[];
  duplicates: string[];
}

export function canonicalScheduleInput(): CronJobInput {
  return {
    name: STORAGE_SCHEDULE_NAME,
    description: STORAGE_SCHEDULE_DESCRIPTION,
    enabled: true,
    deleteAfterRun: false,
    schedule: { type: "cron", cron: STORAGE_SCHEDULE_CRON, timezone: STORAGE_SCHEDULE_TIMEZONE },
    sessionTarget: "main",
    executionType: "shell",
    message: "",
    shellCommand: STORAGE_SCHEDULE_COMMAND,
    shellTimeoutMs: STORAGE_SCHEDULE_TIMEOUT_MS,
    onError: `notify-session:${STORAGE_SCHEDULE_NOTIFY_SESSION}`,
  };
}

function scheduleMatches(job: CronJob, input: CronJobInput): boolean {
  return (
    job.schedule.type === input.schedule.type &&
    job.schedule.cron === input.schedule.cron &&
    (job.schedule.timezone ?? "") === (input.schedule.timezone ?? "")
  );
}

export function diffSchedule(job: CronJob, input: CronJobInput): string[] {
  const changes: string[] = [];
  if (job.executionType !== input.executionType) changes.push("executionType");
  if ((job.shellCommand ?? "") !== (input.shellCommand ?? "")) changes.push("shellCommand");
  if ((job.shellTimeoutMs ?? 0) !== (input.shellTimeoutMs ?? 0)) changes.push("shellTimeoutMs");
  if (!scheduleMatches(job, input)) changes.push("schedule");
  if ((job.onError ?? "") !== (input.onError ?? "")) changes.push("onError");
  if (job.enabled !== (input.enabled !== false)) changes.push("enabled");
  if (Boolean(job.deleteAfterRun) !== Boolean(input.deleteAfterRun)) changes.push("deleteAfterRun");
  if ((job.description ?? "") !== (input.description ?? "")) changes.push("description");
  if ((job.sessionTarget ?? "main") !== (input.sessionTarget ?? "main")) changes.push("sessionTarget");
  if ((job.message ?? "") !== (input.message ?? "")) changes.push("message");
  return changes;
}

export function planStorageSchedule(store: StorageScheduleStore): StorageSchedulePlan {
  const definition = canonicalScheduleInput();
  const matches = store.list().filter((job) => job.name === STORAGE_SCHEDULE_NAME);
  if (matches.length === 0) {
    return { action: "create", jobId: null, definition, changes: [], duplicates: [] };
  }
  const ordered = [...matches].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const primary = ordered[0]!;
  const changes = diffSchedule(primary, definition);
  return {
    action: changes.length === 0 ? "unchanged" : "update",
    jobId: primary.id,
    definition,
    changes,
    duplicates: ordered.slice(1).map((job) => job.id),
  };
}

function updatePatch(definition: CronJobInput): Partial<CronJob> {
  return {
    description: definition.description,
    enabled: definition.enabled !== false,
    deleteAfterRun: definition.deleteAfterRun === true,
    schedule: definition.schedule,
    sessionTarget: definition.sessionTarget ?? "main",
    executionType: definition.executionType ?? "shell",
    message: definition.message,
    shellCommand: definition.shellCommand,
    shellTimeoutMs: definition.shellTimeoutMs,
    onError: definition.onError,
  };
}

export interface StorageScheduleApplyResult {
  action: StorageScheduleAction;
  jobId: string;
  changed: boolean;
}

export function applyStorageSchedule(
  store: StorageScheduleStore,
  plan?: StorageSchedulePlan,
): StorageScheduleApplyResult {
  const resolved = plan ?? planStorageSchedule(store);
  if (resolved.action === "create") {
    const job = store.create(resolved.definition);
    return { action: "create", jobId: job.id, changed: true };
  }
  if (resolved.action === "update" && resolved.jobId) {
    const job = store.update(resolved.jobId, updatePatch(resolved.definition));
    return { action: "update", jobId: job.id, changed: true };
  }
  return { action: "unchanged", jobId: resolved.jobId ?? "", changed: false };
}

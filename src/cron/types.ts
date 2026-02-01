/**
 * Cron System Types
 *
 * Scheduled job execution for agents with support for:
 * - One-shot (at): Run once at a specific time
 * - Interval (every): Run at fixed intervals
 * - Cron expressions (cron): Standard cron syntax
 */

export type ScheduleType = "at" | "every" | "cron";
export type SessionTarget = "main" | "isolated";
export type JobStatus = "ok" | "error";

/**
 * Schedule configuration for a cron job
 */
export interface CronSchedule {
  type: ScheduleType;
  /** Epoch ms for one-shot (at) */
  at?: number;
  /** Interval ms for repeating (every) */
  every?: number;
  /** Cron expression "0 9 * * *" (cron) */
  cron?: string;
  /** Timezone for cron expressions "America/Sao_Paulo" */
  timezone?: string;
}

/**
 * Full cron job record as stored in database
 */
export interface CronJob {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun: boolean;

  schedule: CronSchedule;
  sessionTarget: SessionTarget;
  /** The prompt text to send to the agent */
  message: string;

  // State
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: JobStatus;
  lastError?: string;
  lastDurationMs?: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Input for creating a new cron job
 */
export interface CronJobInput {
  agentId?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget?: SessionTarget;
  /** The prompt text to send to the agent */
  message: string;
}

/**
 * State update for a job after execution
 */
export interface JobStateUpdate {
  lastRunAt: number;
  lastStatus: JobStatus;
  lastError?: string;
  lastDurationMs?: number;
  nextRunAt?: number;
}

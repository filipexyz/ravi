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
export type CronExecutionType = "agent" | "shell";

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
  /** Explicit account ID for outbound routing (overrides session.lastAccountId) */
  accountId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun: boolean;

  schedule: CronSchedule;
  sessionTarget: SessionTarget;
  /** Session key to emit prompt to (e.g., agent:comm:whatsapp:main:group:123) */
  replySession?: string;
  /** Execution mode. Existing rows default to agent. */
  executionType: CronExecutionType;
  /** The prompt text to send to the agent */
  message: string;
  /** Shell command for executionType=shell */
  shellCommand?: string;
  /** Shell command timeout in milliseconds */
  shellTimeoutMs?: number;
  /** Optional env file path to merge into the shell process environment */
  shellEnvFile?: string;
  /** Optional error action, currently notify-session:<session> */
  onError?: string;

  // State
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: JobStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastExitCode?: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Input for creating a new cron job
 */
export interface CronJobInput {
  agentId?: string;
  /** Explicit account ID for outbound routing */
  accountId?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget?: SessionTarget;
  /** Session key to emit prompt to (captured from caller context) */
  replySession?: string;
  /** Execution mode. Defaults to agent. */
  executionType?: CronExecutionType;
  /** The prompt text to send to the agent */
  message: string;
  /** Shell command for executionType=shell */
  shellCommand?: string;
  /** Shell command timeout in milliseconds */
  shellTimeoutMs?: number;
  /** Optional env file path to merge into the shell process environment */
  shellEnvFile?: string;
  /** Optional error action, currently notify-session:<session> */
  onError?: string;
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
  lastExitCode?: number;
}

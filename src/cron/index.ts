/**
 * Cron Module - Public exports
 *
 * Scheduled job execution system for agents.
 */

// Types
export type {
  ScheduleType,
  SessionTarget,
  JobStatus,
  CronExecutionType,
  CronSchedule,
  CronJob,
  CronJobInput,
  JobStateUpdate,
} from "./types.js";

// Database operations
export {
  dbCreateCronJob,
  dbGetCronJob,
  dbListCronJobs,
  dbUpdateCronJob,
  dbDeleteCronJob,
  dbGetDueJobs,
  dbGetNextDueJob,
  dbUpdateJobState,
} from "./cron-db.js";

export { createCronJobIdempotently } from "./idempotency.js";
export type { CronCreationIdempotency, CronCreationResult } from "./idempotency.js";

// Schedule utilities
export {
  calculateNextRun,
  isValidCronExpression,
  parseDurationMs,
  formatDurationMs,
  parseDateTime,
  parseScheduleInput,
  describeSchedule,
} from "./schedule.js";

// Runner
export {
  CronRunner,
  getCronRunner,
  startCronRunner,
  stopCronRunner,
} from "./runner.js";

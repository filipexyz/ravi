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
  JobDispatchUpdate,
  JobOutcomeUpdate,
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
  dbMarkJobDispatched,
  dbRecordJobOutcome,
} from "./cron-db.js";

// Turn outcome tracking
export { parseCronTurnOutcome, buildCronTurnOutcomeState, CRON_RUNTIME_EVENTS_TOPIC } from "./turn-outcome.js";
export type { CronTurnOutcome, CronTurnTerminalKind } from "./turn-outcome.js";

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

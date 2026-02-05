/**
 * Triggers Module - Public exports
 *
 * Event-driven trigger system for agents.
 */

// Types
export type { SessionTarget, Trigger, TriggerInput } from "./types.js";

// Database operations
export {
  dbCreateTrigger,
  dbGetTrigger,
  dbListTriggers,
  dbUpdateTrigger,
  dbDeleteTrigger,
  dbUpdateTriggerState,
} from "./triggers-db.js";

// Runner
export {
  TriggerRunner,
  getTriggerRunner,
  startTriggerRunner,
  stopTriggerRunner,
} from "./runner.js";

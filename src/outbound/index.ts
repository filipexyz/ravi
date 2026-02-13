/**
 * Outbound Module - Public exports
 *
 * Proactive outbound messaging system with round-robin queues.
 */

// Types
export type {
  QueueStatus,
  EntryStatus,
  OutboundQueue,
  OutboundQueueInput,
  OutboundEntry,
  OutboundEntryInput,
  OutboundStage,
  QueueStateUpdate,
  PendingReceipt,
} from "./types.js";

// Database operations
export {
  dbCreateQueue,
  dbGetQueue,
  dbListQueues,
  dbUpdateQueue,
  dbDeleteQueue,
  dbUpdateQueueState,
  dbGetNextDueQueue,
  dbGetDueQueues,
  dbAddEntry,
  dbGetEntry,
  dbListEntries,
  dbGetNextEntry,
  dbGetNextEntryWithResponse,
  dbGetNextFollowUpEntry,
  dbUpdateEntry,
  dbDeleteEntry,
  dbMarkEntryDone,
  dbUpdateEntryContext,
  dbRecordEntryResponse,
  dbAddEntriesFromContacts,
  dbFindActiveEntryByPhone,
  dbFindActiveEntryBySenderId,
  dbFindUnmappedActiveEntry,
  dbFindEntriesWithoutSenderId,
  dbSetPendingReceipt,
  dbClearPendingReceipt,
  dbClearResponseText,
  dbSetEntrySenderId,
  getQueueStageNames,
  getStageDelays,
  getDefaultStageName,
} from "./outbound-db.js";

// Direct send
export {
  directSend,
  type DirectSendInput,
  type DirectSendResult,
} from "./direct-send.js";

// Runner
export {
  OutboundRunner,
  getOutboundRunner,
  startOutboundRunner,
  stopOutboundRunner,
} from "./runner.js";

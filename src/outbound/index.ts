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
  dbUpdateEntry,
  dbDeleteEntry,
  dbMarkEntryDone,
  dbUpdateEntryContext,
  dbRecordEntryResponse,
  dbAddEntriesFromContacts,
  dbFindActiveEntryByPhone,
  dbFindActiveEntryBySenderId,
  dbFindUnmappedActiveEntry,
  dbSetPendingReceipt,
  dbClearPendingReceipt,
  dbClearResponseText,
  dbSetEntrySenderId,
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

/**
 * Outbound Queue System Types
 *
 * Round-robin queue for proactive outbound messaging.
 * Each queue contains entries (contacts) that are processed
 * sequentially with configurable intervals.
 */

export type QueueStatus = "active" | "paused" | "completed";
export type EntryStatus = "pending" | "active" | "done" | "skipped" | "error";
export type QualificationStatus = "cold" | "warm" | "interested" | "qualified" | "rejected";

/**
 * Pending read receipt stored on an outbound entry.
 * When a contact in an active outbound queue sends a message,
 * the read receipt is deferred until the runner processes the entry.
 */
export interface PendingReceipt {
  chatId: string;
  senderId: string;
  messageIds: string[];
  accountId: string;
  channel: string;
}

/**
 * Outbound queue configuration
 */
export interface OutboundQueue {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  instructions: string;
  status: QueueStatus;
  intervalMs: number;
  activeStart?: string;
  activeEnd?: string;
  timezone?: string;
  currentIndex: number;

  // Follow-up config
  followUp?: Record<string, number>; // qualification status → delay in minutes
  maxRounds?: number;

  // State
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;

  // Counters
  totalProcessed: number;
  totalSent: number;
  totalSkipped: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Input for creating a new queue
 */
export interface OutboundQueueInput {
  agentId?: string;
  name: string;
  description?: string;
  instructions: string;
  intervalMs: number;
  activeStart?: string;
  activeEnd?: string;
  timezone?: string;
  followUp?: Record<string, number>;
  maxRounds?: number;
}

/**
 * Entry in an outbound queue (a contact to be processed)
 */
export interface OutboundEntry {
  id: string;
  queueId: string;
  contactPhone: string;
  contactEmail?: string;
  position: number;
  status: EntryStatus;
  context: Record<string, unknown>;
  qualification?: QualificationStatus;
  roundsCompleted: number;
  lastProcessedAt?: number;
  lastSentAt?: number;
  lastResponseAt?: number;
  lastResponseText?: string;
  pendingReceipt?: PendingReceipt;
  senderId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Input for adding an entry to a queue
 */
export interface OutboundEntryInput {
  queueId: string;
  contactPhone: string;
  contactEmail?: string;
  context?: Record<string, unknown>;
}

/**
 * State update after processing a queue
 */
export interface QueueStateUpdate {
  lastRunAt: number;
  lastStatus: string;
  lastError?: string;
  lastDurationMs?: number;
  nextRunAt?: number;
  currentIndex?: number;
  totalProcessed?: number;
  totalSent?: number;
  totalSkipped?: number;
}

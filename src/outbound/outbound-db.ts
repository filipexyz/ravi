/**
 * Outbound Database Operations
 *
 * CRUD operations for outbound queues and entries stored in SQLite.
 * Follows the same pattern as cron-db.ts.
 */

import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type {
  OutboundQueue,
  OutboundQueueInput,
  OutboundEntry,
  OutboundEntryInput,
  QueueStatus,
  EntryStatus,
  QueueStateUpdate,
  PendingReceipt,
} from "./types.js";

const log = logger.child("outbound:db");

// ============================================================================
// Row Types
// ============================================================================

interface QueueRow {
  id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  instructions: string;
  status: string;
  interval_ms: number;
  active_start: string | null;
  active_end: string | null;
  timezone: string | null;
  current_index: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  total_processed: number;
  total_sent: number;
  total_skipped: number;
  created_at: number;
  updated_at: number;
}

interface EntryRow {
  id: string;
  queue_id: string;
  contact_phone: string;
  contact_email: string | null;
  position: number;
  status: string;
  context: string;
  rounds_completed: number;
  last_processed_at: number | null;
  last_sent_at: number | null;
  last_response_at: number | null;
  last_response_text: string | null;
  pending_receipt: string | null;
  sender_id: string | null;
  created_at: number;
  updated_at: number;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToQueue(row: QueueRow): OutboundQueue {
  const queue: OutboundQueue = {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    status: row.status as QueueStatus,
    intervalMs: row.interval_ms,
    currentIndex: row.current_index,
    totalProcessed: row.total_processed,
    totalSent: row.total_sent,
    totalSkipped: row.total_skipped,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.agent_id !== null) queue.agentId = row.agent_id;
  if (row.description !== null) queue.description = row.description;
  if (row.active_start !== null) queue.activeStart = row.active_start;
  if (row.active_end !== null) queue.activeEnd = row.active_end;
  if (row.timezone !== null) queue.timezone = row.timezone;
  if (row.next_run_at !== null) queue.nextRunAt = row.next_run_at;
  if (row.last_run_at !== null) queue.lastRunAt = row.last_run_at;
  if (row.last_status !== null) queue.lastStatus = row.last_status;
  if (row.last_error !== null) queue.lastError = row.last_error;
  if (row.last_duration_ms !== null) queue.lastDurationMs = row.last_duration_ms;

  return queue;
}

function rowToEntry(row: EntryRow): OutboundEntry {
  const entry: OutboundEntry = {
    id: row.id,
    queueId: row.queue_id,
    contactPhone: row.contact_phone,
    position: row.position,
    status: row.status as EntryStatus,
    context: JSON.parse(row.context || "{}"),
    roundsCompleted: row.rounds_completed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.contact_email !== null) entry.contactEmail = row.contact_email;
  if (row.last_processed_at !== null) entry.lastProcessedAt = row.last_processed_at;
  if (row.last_sent_at !== null) entry.lastSentAt = row.last_sent_at;
  if (row.last_response_at !== null) entry.lastResponseAt = row.last_response_at;
  if (row.last_response_text !== null) entry.lastResponseText = row.last_response_text;
  if (row.pending_receipt !== null) {
    try {
      const parsed = JSON.parse(row.pending_receipt);
      // Backward compat: migrate messageId (string) to messageIds (array)
      if (parsed.messageId && !parsed.messageIds) {
        parsed.messageIds = [parsed.messageId];
        delete parsed.messageId;
      }
      entry.pendingReceipt = parsed as PendingReceipt;
    } catch { /* ignore invalid JSON */ }
  }
  if (row.sender_id !== null) entry.senderId = row.sender_id;

  return entry;
}

// ============================================================================
// Queue CRUD
// ============================================================================

/**
 * Create a new outbound queue.
 */
export function dbCreateQueue(input: OutboundQueueInput): OutboundQueue {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  db.prepare(`
    INSERT INTO outbound_queues (
      id, agent_id, name, description, instructions,
      status, interval_ms, active_start, active_end, timezone,
      current_index, next_run_at,
      total_processed, total_sent, total_skipped,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?, ?, 0, NULL, 0, 0, 0, ?, ?)
  `).run(
    id,
    input.agentId ?? null,
    input.name,
    input.description ?? null,
    input.instructions,
    input.intervalMs,
    input.activeStart ?? null,
    input.activeEnd ?? null,
    input.timezone ?? null,
    now,
    now,
  );

  log.info("Created outbound queue", { id, name: input.name });
  return dbGetQueue(id)!;
}

/**
 * Get a queue by ID.
 */
export function dbGetQueue(id: string): OutboundQueue | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM outbound_queues WHERE id = ?").get(id) as QueueRow | undefined;
  return row ? rowToQueue(row) : null;
}

/**
 * List all queues.
 */
export function dbListQueues(): OutboundQueue[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM outbound_queues ORDER BY created_at DESC").all() as QueueRow[];
  return rows.map(rowToQueue);
}

/**
 * Update a queue.
 */
export function dbUpdateQueue(id: string, updates: Partial<OutboundQueue>): OutboundQueue {
  const db = getDb();
  const existing = dbGetQueue(id);
  if (!existing) {
    throw new Error(`Outbound queue not found: ${id}`);
  }

  const now = Date.now();
  type SQLValue = string | number | null;
  const fields: string[] = [];
  const values: SQLValue[] = [];

  if (updates.agentId !== undefined) {
    fields.push("agent_id = ?");
    values.push(updates.agentId ?? null);
  }
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description ?? null);
  }
  if (updates.instructions !== undefined) {
    fields.push("instructions = ?");
    values.push(updates.instructions);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.intervalMs !== undefined) {
    fields.push("interval_ms = ?");
    values.push(updates.intervalMs);
  }
  if (updates.activeStart !== undefined) {
    fields.push("active_start = ?");
    values.push(updates.activeStart ?? null);
  }
  if (updates.activeEnd !== undefined) {
    fields.push("active_end = ?");
    values.push(updates.activeEnd ?? null);
  }
  if (updates.timezone !== undefined) {
    fields.push("timezone = ?");
    values.push(updates.timezone ?? null);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE outbound_queues SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  log.info("Updated outbound queue", { id });
  return dbGetQueue(id)!;
}

/**
 * Delete a queue (cascades to entries).
 */
export function dbDeleteQueue(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM outbound_queues WHERE id = ?").run(id);
  const deleted = getDbChanges() > 0;
  if (deleted) {
    log.info("Deleted outbound queue", { id });
  }
  return deleted;
}

/**
 * Update queue state after processing.
 */
export function dbUpdateQueueState(id: string, state: QueueStateUpdate): void {
  const db = getDb();
  const now = Date.now();

  type SQLValue = string | number | null;
  const fields: string[] = ["last_run_at = ?", "last_status = ?", "updated_at = ?"];
  const values: SQLValue[] = [state.lastRunAt, state.lastStatus, now];

  if (state.lastError !== undefined) {
    fields.push("last_error = ?");
    values.push(state.lastError ?? null);
  }
  if (state.lastDurationMs !== undefined) {
    fields.push("last_duration_ms = ?");
    values.push(state.lastDurationMs ?? null);
  }
  if (state.nextRunAt !== undefined) {
    fields.push("next_run_at = ?");
    values.push(state.nextRunAt ?? null);
  }
  if (state.currentIndex !== undefined) {
    fields.push("current_index = ?");
    values.push(state.currentIndex);
  }
  if (state.totalProcessed !== undefined) {
    fields.push("total_processed = ?");
    values.push(state.totalProcessed);
  }
  if (state.totalSent !== undefined) {
    fields.push("total_sent = ?");
    values.push(state.totalSent);
  }
  if (state.totalSkipped !== undefined) {
    fields.push("total_skipped = ?");
    values.push(state.totalSkipped);
  }

  values.push(id);
  db.prepare(`UPDATE outbound_queues SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  log.debug("Updated queue state", { id, status: state.lastStatus });
}

/**
 * Get the next queue that is due to run.
 */
export function dbGetNextDueQueue(): OutboundQueue | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM outbound_queues
    WHERE status = 'active' AND next_run_at IS NOT NULL
    ORDER BY next_run_at ASC
    LIMIT 1
  `).get() as QueueRow | undefined;
  return row ? rowToQueue(row) : null;
}

/**
 * Get all queues that are due to run now.
 */
export function dbGetDueQueues(): OutboundQueue[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM outbound_queues
    WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `).all(now) as QueueRow[];
  return rows.map(rowToQueue);
}

// ============================================================================
// Entry CRUD
// ============================================================================

/**
 * Add an entry to a queue.
 */
export function dbAddEntry(input: OutboundEntryInput): OutboundEntry {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  // Get max position in queue
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(position), -1) as max_pos FROM outbound_entries WHERE queue_id = ?"
  ).get(input.queueId) as { max_pos: number };
  const position = maxRow.max_pos + 1;

  db.prepare(`
    INSERT INTO outbound_entries (
      id, queue_id, contact_phone, contact_email, position,
      status, context, rounds_completed,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
  `).run(
    id,
    input.queueId,
    input.contactPhone,
    input.contactEmail ?? null,
    position,
    JSON.stringify(input.context ?? {}),
    now,
    now,
  );

  log.info("Added entry to queue", { id, queueId: input.queueId, phone: input.contactPhone });
  return dbGetEntry(id)!;
}

/**
 * Get an entry by ID.
 */
export function dbGetEntry(id: string): OutboundEntry | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM outbound_entries WHERE id = ?").get(id) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * List entries for a queue.
 */
export function dbListEntries(queueId: string): OutboundEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM outbound_entries WHERE queue_id = ? ORDER BY position ASC"
  ).all(queueId) as EntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Get next entry for initial outreach (timer-driven).
 * Only returns pending entries with rounds_completed = 0 (not yet contacted).
 */
export function dbGetNextEntry(queueId: string, afterPosition: number): OutboundEntry | null {
  const db = getDb();

  // First try entries at or after current position
  let row = db.prepare(`
    SELECT * FROM outbound_entries
    WHERE queue_id = ? AND position >= ?
      AND status = 'pending'
      AND rounds_completed = 0
    ORDER BY position ASC
    LIMIT 1
  `).get(queueId, afterPosition) as EntryRow | undefined;

  // If no entries found after position, wrap around to beginning
  if (!row) {
    row = db.prepare(`
      SELECT * FROM outbound_entries
      WHERE queue_id = ?
        AND status = 'pending'
        AND rounds_completed = 0
      ORDER BY position ASC
      LIMIT 1
    `).get(queueId) as EntryRow | undefined;
  }

  return row ? rowToEntry(row) : null;
}

/**
 * Update an entry.
 */
export function dbUpdateEntry(id: string, updates: Partial<OutboundEntry>): OutboundEntry {
  const db = getDb();
  const existing = dbGetEntry(id);
  if (!existing) {
    throw new Error(`Outbound entry not found: ${id}`);
  }

  const now = Date.now();
  type SQLValue = string | number | null;
  const fields: string[] = [];
  const values: SQLValue[] = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.context !== undefined) {
    fields.push("context = ?");
    values.push(JSON.stringify(updates.context));
  }
  if (updates.roundsCompleted !== undefined) {
    fields.push("rounds_completed = ?");
    values.push(updates.roundsCompleted);
  }
  if (updates.lastProcessedAt !== undefined) {
    fields.push("last_processed_at = ?");
    values.push(updates.lastProcessedAt ?? null);
  }
  if (updates.lastSentAt !== undefined) {
    fields.push("last_sent_at = ?");
    values.push(updates.lastSentAt ?? null);
  }
  if (updates.contactEmail !== undefined) {
    fields.push("contact_email = ?");
    values.push(updates.contactEmail ?? null);
  }
  if (updates.lastResponseAt !== undefined) {
    fields.push("last_response_at = ?");
    values.push(updates.lastResponseAt ?? null);
  }
  if (updates.lastResponseText !== undefined) {
    fields.push("last_response_text = ?");
    values.push(updates.lastResponseText ?? null);
  }
  if (updates.senderId !== undefined) {
    fields.push("sender_id = ?");
    values.push(updates.senderId ?? null);
  }
  if (updates.pendingReceipt !== undefined) {
    fields.push("pending_receipt = ?");
    values.push(updates.pendingReceipt ? JSON.stringify(updates.pendingReceipt) : null);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE outbound_entries SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return dbGetEntry(id)!;
}

/**
 * Delete an entry.
 */
export function dbDeleteEntry(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM outbound_entries WHERE id = ?").run(id);
  const deleted = getDbChanges() > 0;
  if (deleted) {
    log.info("Deleted outbound entry", { id });
  }
  return deleted;
}

/**
 * Get the next entry with a pending response (contact replied, waiting for timer).
 * Used by the timer to process responses before doing new outreach.
 */
export function dbGetNextEntryWithResponse(queueId: string): OutboundEntry | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM outbound_entries
    WHERE queue_id = ?
      AND last_response_text IS NOT NULL
      AND status IN ('pending', 'active')
    ORDER BY last_response_at ASC
    LIMIT 1
  `).get(queueId) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Mark an entry as done.
 */
export function dbMarkEntryDone(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE outbound_entries SET status = 'done', last_processed_at = ?, updated_at = ? WHERE id = ?"
  ).run(now, now, id);
  log.info("Marked entry done", { id });
}

/**
 * Update entry context (merge).
 */
export function dbUpdateEntryContext(id: string, ctx: Record<string, unknown>): void {
  const db = getDb();
  const entry = dbGetEntry(id);
  if (!entry) {
    throw new Error(`Outbound entry not found: ${id}`);
  }

  const merged = { ...entry.context, ...ctx };
  // Remove keys set to null
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  const now = Date.now();
  db.prepare(
    "UPDATE outbound_entries SET context = ?, updated_at = ? WHERE id = ?"
  ).run(JSON.stringify(merged), now, id);
}

/**
 * Record a response from a contact for an entry.
 * Appends to existing response text so multiple messages are preserved.
 */
export function dbRecordEntryResponse(id: string, text: string): void {
  const db = getDb();
  const now = Date.now();
  const entry = dbGetEntry(id);
  const combined = entry?.lastResponseText
    ? entry.lastResponseText + "\n\n" + text
    : text;
  db.prepare(`
    UPDATE outbound_entries SET
      status = 'pending',
      last_response_at = ?,
      last_response_text = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, combined, now, id);
  log.debug("Recorded entry response", { id });
}

/**
 * Add entries from a list of contacts.
 * Skips contacts already in the queue or opted out.
 * Returns the number of entries added.
 */
export function dbAddEntriesFromContacts(
  queueId: string,
  contacts: Array<{ phone: string; email?: string | null; opt_out?: boolean }>
): number {
  const db = getDb();

  let added = 0;
  for (const contact of contacts) {
    // Skip opted-out contacts
    if (contact.opt_out) continue;

    // Skip if already in queue
    const existing = db.prepare(
      "SELECT id FROM outbound_entries WHERE queue_id = ? AND contact_phone = ? AND status IN ('pending', 'active')"
    ).get(queueId, contact.phone);

    if (existing) continue;

    dbAddEntry({
      queueId,
      contactPhone: contact.phone,
      contactEmail: contact.email ?? undefined,
    });
    added++;
  }

  log.info("Added entries from contacts", { queueId, count: added });
  return added;
}

/**
 * Set or append a pending read receipt on an outbound entry.
 * Accumulates messageIds so all messages get read receipts when processed.
 */
export function dbSetPendingReceipt(entryId: string, receipt: PendingReceipt): void {
  const db = getDb();
  const now = Date.now();

  // Check existing receipt to accumulate messageIds
  const entry = dbGetEntry(entryId);
  if (entry?.pendingReceipt) {
    const existing = entry.pendingReceipt;
    const merged: PendingReceipt = {
      ...existing,
      messageIds: [...existing.messageIds, ...receipt.messageIds],
    };
    db.prepare(
      "UPDATE outbound_entries SET pending_receipt = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(merged), now, entryId);
  } else {
    db.prepare(
      "UPDATE outbound_entries SET pending_receipt = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(receipt), now, entryId);
  }
  log.debug("Set pending receipt on entry", { entryId, messageIds: receipt.messageIds });
}

/**
 * Clear the last response text from an outbound entry.
 */
export function dbClearResponseText(entryId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE outbound_entries SET last_response_text = NULL, updated_at = ? WHERE id = ?"
  ).run(now, entryId);
  log.debug("Cleared response text from entry", { entryId });
}

/**
 * Clear the pending read receipt from an outbound entry.
 */
export function dbClearPendingReceipt(entryId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE outbound_entries SET pending_receipt = NULL, updated_at = ? WHERE id = ?"
  ).run(now, entryId);
  log.debug("Cleared pending receipt from entry", { entryId });
}

/**
 * Set the sender ID on an outbound entry (maps channel-specific ID to entry).
 */
export function dbSetEntrySenderId(entryId: string, senderId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE outbound_entries SET sender_id = ?, updated_at = ? WHERE id = ?"
  ).run(senderId, now, entryId);
  log.debug("Set sender_id on entry", { entryId, senderId });
}

/**
 * Find outbound entry by sender ID (e.g., LID).
 * Only matches entries in active queues with pending/active status.
 */
export function dbFindActiveEntryBySenderId(senderId: string): OutboundEntry | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.* FROM outbound_entries e
    JOIN outbound_queues q ON q.id = e.queue_id
    WHERE e.sender_id = ?
      AND q.status = 'active'
      AND e.status IN ('pending', 'active')
    ORDER BY e.created_at ASC
    LIMIT 1
  `).get(senderId) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Find outbound entry that has been sent to but has no sender_id yet.
 * Used as a fallback for LID contacts on first interaction.
 * Only matches entries in active queues with pending/active status.
 */
export function dbFindUnmappedActiveEntry(): OutboundEntry | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.* FROM outbound_entries e
    JOIN outbound_queues q ON q.id = e.queue_id
    WHERE e.sender_id IS NULL
      AND e.last_sent_at IS NOT NULL
      AND q.status = 'active'
      AND e.status IN ('pending', 'active')
    ORDER BY e.last_sent_at DESC
    LIMIT 1
  `).get() as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Find outbound entry for a contact phone.
 * Only matches entries in active queues with pending/active status.
 */
export function dbFindActiveEntryByPhone(phone: string): OutboundEntry | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.* FROM outbound_entries e
    JOIN outbound_queues q ON q.id = e.queue_id
    WHERE e.contact_phone = ?
      AND q.status = 'active'
      AND e.status IN ('pending', 'active')
    ORDER BY e.created_at ASC
    LIMIT 1
  `).get(phone) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

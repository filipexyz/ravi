import { randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import type { ChatReadingListRecord, ChatReadingListMemberRecord } from "../router/router-db.js";
import { DynamicListSelectorSchema, type DynamicListSelector } from "./types.js";

interface ChatReadingListRow {
  id: string;
  name: string;
  description: string | null;
  owner_type: string;
  owner_id: string;
  visibility: string;
  mode: string;
  selector_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ChatReadingListMemberRow {
  id: string;
  list_id: string;
  chat_id: string;
  source: string;
  reason: string | null;
  priority: number;
  metadata_json: string | null;
  added_at: number;
  removed_at: number | null;
}

function rowToList(row: ChatReadingListRow): ChatReadingListRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    visibility: row.visibility,
    mode: row.mode,
    selector: row.selector_json ? (JSON.parse(row.selector_json) as Record<string, unknown>) : undefined,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function rowToMember(row: ChatReadingListMemberRow): ChatReadingListMemberRecord {
  return {
    id: row.id,
    listId: row.list_id,
    chatId: row.chat_id,
    source: row.source,
    reason: row.reason ?? undefined,
    priority: row.priority,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
    addedAt: row.added_at,
    removedAt: row.removed_at ?? undefined,
  };
}

/** Return all non-archived lists whose mode is dynamic or hybrid and whose selector_json is set. */
export function dbListDynamicReadingLists(): ChatReadingListRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM chat_reading_lists
      WHERE archived_at IS NULL
        AND mode IN ('dynamic', 'hybrid')
        AND selector_json IS NOT NULL
      ORDER BY updated_at DESC
    `,
    )
    .all() as ChatReadingListRow[];
  return rows.map(rowToList);
}

/** Parse and validate the selector stored in a list record. Returns null if absent or invalid. */
export function dbGetListSelector(list: ChatReadingListRecord): DynamicListSelector | null {
  if (!list.selector) return null;
  const result = DynamicListSelectorSchema.safeParse(list.selector);
  return result.success ? result.data : null;
}

/**
 * Upsert a selector-derived member: insert new row, or clear removed_at (re-entry).
 * Returns the resulting member record and whether a write actually occurred.
 */
export function dbUpsertSelectorMember(input: {
  listId: string;
  chatId: string;
  metadata?: Record<string, unknown> | null;
}): { member: ChatReadingListMemberRecord; written: boolean } {
  const db = getDb();
  const now = Date.now();
  const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

  // Idempotency: already active
  const active = db
    .prepare("SELECT * FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
    .get(input.listId, input.chatId) as ChatReadingListMemberRow | undefined;
  if (active) return { member: rowToMember(active), written: false };

  // Re-entry: reactivate soft-deleted row (preserves member id + audit)
  const softDeleted = db
    .prepare(
      "SELECT * FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NOT NULL ORDER BY added_at DESC LIMIT 1",
    )
    .get(input.listId, input.chatId) as ChatReadingListMemberRow | undefined;

  if (softDeleted) {
    db.prepare(
      "UPDATE chat_reading_list_members SET removed_at = NULL, metadata_json = COALESCE(?, metadata_json), added_at = ? WHERE id = ?",
    ).run(metaJson, now, softDeleted.id);
    const updated = db
      .prepare("SELECT * FROM chat_reading_list_members WHERE id = ?")
      .get(softDeleted.id) as ChatReadingListMemberRow;
    return { member: rowToMember(updated), written: true };
  }

  // New row — ON CONFLICT DO NOTHING guards concurrent inserts
  const id = `crlm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  db.prepare(
    `
    INSERT INTO chat_reading_list_members (id, list_id, chat_id, source, priority, metadata_json, added_at, removed_at)
    VALUES (?, ?, ?, 'selector', 0, ?, ?, NULL)
    ON CONFLICT DO NOTHING
  `,
  ).run(id, input.listId, input.chatId, metaJson, now);

  // Read back (handles both successful insert and concurrent-insert-won case)
  const row = db
    .prepare("SELECT * FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
    .get(input.listId, input.chatId) as ChatReadingListMemberRow | undefined;

  if (!row) throw new Error(`Insert failed and no concurrent row for ${input.listId}/${input.chatId}`);
  return { member: rowToMember(row), written: row.id === id };
}

/**
 * Soft-delete an active selector-derived member.
 * Single UPDATE statement — no read-then-write race.
 * Returns true if a row was actually updated.
 */
export function dbSoftRemoveSelectorMember(input: {
  listId: string;
  chatId: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const result = getDb()
    .prepare(
      `
      UPDATE chat_reading_list_members
      SET removed_at = ?,
          metadata_json = COALESCE(?, metadata_json)
      WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL AND source = 'selector'
    `,
    )
    .run(Date.now(), metaJson, input.listId, input.chatId);
  return result.changes > 0;
}

/** Update selector_json on a reading list and bump updated_at. */
export function dbUpdateReadingListSelector(listId: string, selector: Record<string, unknown> | null): void {
  getDb()
    .prepare("UPDATE chat_reading_lists SET selector_json = ?, updated_at = ? WHERE id = ?")
    .run(selector ? JSON.stringify(selector) : null, Date.now(), listId);
}

/** Update mode on a reading list. */
export function dbUpdateReadingListMode(listId: string, mode: string): void {
  getDb().prepare("UPDATE chat_reading_lists SET mode = ?, updated_at = ? WHERE id = ?").run(mode, Date.now(), listId);
}

/** Update metadata_json on a reading list. */
export function dbUpdateReadingListMetadata(listId: string, metadata: Record<string, unknown> | null): void {
  getDb()
    .prepare("UPDATE chat_reading_lists SET metadata_json = ?, updated_at = ? WHERE id = ?")
    .run(metadata ? JSON.stringify(metadata) : null, Date.now(), listId);
}

/**
 * Check if the list owner has read access to a specific chat.
 * Agent owners must be a participant in the chat.
 * Contact owners must be a participant in the chat.
 * System/instance owners have implicit access.
 */
export function dbCanReadChat(ownerType: string, ownerId: string, chatId: string): boolean {
  const db = getDb();
  if (ownerType === "agent") {
    return (
      db
        .prepare("SELECT 1 AS found FROM chat_participants WHERE chat_id = ? AND agent_id = ? LIMIT 1")
        .get(chatId, ownerId) != null
    );
  }
  if (ownerType === "contact") {
    return (
      db
        .prepare("SELECT 1 AS found FROM chat_participants WHERE chat_id = ? AND contact_id = ? LIMIT 1")
        .get(chatId, ownerId) != null
    );
  }
  return true;
}

/** Return true if the given chat has an active (non-removed) membership in the list. */
export function dbIsActiveMember(listId: string, chatId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS found FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL",
    )
    .get(listId, chatId);
  return row != null;
}

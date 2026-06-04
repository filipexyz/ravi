import { randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import type { MailMessageWithAddresses } from "../mailbox/types.js";
import { emitLocalInboxMailReceived } from "./local-events.js";

export type LocalInboxStatus = "open" | "seen" | "assigned" | "snoozed" | "done" | "archived" | "dismissed";
export type LocalInboxPriority = "low" | "normal" | "high" | "urgent";
export type LocalInboxActorType = "contact" | "agent" | "system" | "unknown";

export interface LocalInboxItem {
  id: string;
  sourceDomain: string;
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  title: string | null;
  summary: string | null;
  status: LocalInboxStatus;
  priority: LocalInboxPriority;
  assignedToAgentId: string | null;
  assignedToContactId: string | null;
  snoozedUntil: number | null;
  occurredAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface LocalInboxEvent {
  id: string;
  itemId: string;
  eventType: string;
  actorType: LocalInboxActorType;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface UpsertLocalInboxItemInput {
  id?: string;
  sourceDomain: string;
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  title?: string | null;
  summary?: string | null;
  status?: LocalInboxStatus;
  priority?: LocalInboxPriority;
  assignedToAgentId?: string | null;
  assignedToContactId?: string | null;
  snoozedUntil?: number | null;
  occurredAt?: number | null;
  metadata?: Record<string, unknown>;
  actorType?: LocalInboxActorType;
  actorId?: string | null;
  now?: number;
}

export interface ListLocalInboxItemsInput {
  status?: LocalInboxStatus;
  sourceDomain?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

interface LocalInboxItemRow {
  id: string;
  source_domain: string;
  source_type: string;
  source_id: string;
  dedupe_key: string;
  title: string | null;
  summary: string | null;
  status: LocalInboxStatus;
  priority: LocalInboxPriority;
  assigned_to_agent_id: string | null;
  assigned_to_contact_id: string | null;
  snoozed_until: number | null;
  occurred_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface LocalInboxEventRow {
  id: string;
  item_id: string;
  event_type: string;
  actor_type: LocalInboxActorType;
  actor_id: string | null;
  payload_json: string | null;
  created_at: number;
}

export function ensureLocalInboxSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      source_domain TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      title TEXT,
      summary TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','seen','assigned','snoozed','done','archived','dismissed')),
      priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
      assigned_to_agent_id TEXT,
      assigned_to_contact_id TEXT,
      snoozed_until INTEGER,
      occurred_at INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_items_status_updated
      ON inbox_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_source
      ON inbox_items(source_domain, source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_snoozed
      ON inbox_items(snoozed_until);

    CREATE TABLE IF NOT EXISTS inbox_item_events (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('contact','agent','system','unknown')),
      actor_id TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_item_events_item
      ON inbox_item_events(item_id, created_at ASC);
  `);
}

export function upsertLocalInboxItem(input: UpsertLocalInboxItemInput): { item: LocalInboxItem; created: boolean } {
  ensureLocalInboxSchema();
  const now = input.now ?? Date.now();
  const id = input.id?.trim() || uniqueId("inbox_item");

  return executeWrite(
    getDb(),
    (db) => {
      const existing = getItemRowByDedupe(input.dedupeKey);
      db.prepare(
        `
        INSERT INTO inbox_items (
          id, source_domain, source_type, source_id, dedupe_key, title, summary,
          status, priority, assigned_to_agent_id, assigned_to_contact_id,
          snoozed_until, occurred_at, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          priority = excluded.priority,
          assigned_to_agent_id = COALESCE(excluded.assigned_to_agent_id, inbox_items.assigned_to_agent_id),
          assigned_to_contact_id = COALESCE(excluded.assigned_to_contact_id, inbox_items.assigned_to_contact_id),
          snoozed_until = COALESCE(excluded.snoozed_until, inbox_items.snoozed_until),
          occurred_at = COALESCE(excluded.occurred_at, inbox_items.occurred_at),
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        requireText(input.sourceDomain, "sourceDomain"),
        requireText(input.sourceType, "sourceType"),
        requireText(input.sourceId, "sourceId"),
        requireText(input.dedupeKey, "dedupeKey"),
        nullableText(input.title),
        nullableText(input.summary),
        input.status ?? "open",
        input.priority ?? "normal",
        nullableText(input.assignedToAgentId),
        nullableText(input.assignedToContactId),
        input.snoozedUntil ?? null,
        input.occurredAt ?? null,
        stableJson(input.metadata ?? {}),
        now,
        now,
      );

      const row = getItemRowByDedupe(input.dedupeKey);
      if (!row) throw new Error("Failed to upsert inbox item.");
      const created = !existing;
      appendInboxEvent(row.id, created ? "created" : "updated", {
        actorType: input.actorType ?? "system",
        actorId: input.actorId ?? null,
        payload: { sourceDomain: input.sourceDomain, sourceType: input.sourceType, sourceId: input.sourceId },
        now,
      });
      return { item: rowToItem(row), created };
    },
    { label: "local_inbox_upsert" },
  );
}

export function projectMailMessageToInbox(
  message: MailMessageWithAddresses,
): { item: LocalInboxItem; created: boolean } | null {
  if (message.direction !== "inbound" || message.status !== "received") return null;
  const projection = upsertLocalInboxItem({
    sourceDomain: "mail",
    sourceType: "mail_message",
    sourceId: message.id,
    dedupeKey: `mail:${message.id}`,
    title: message.subject ?? "(sem assunto)",
    summary: message.snippet,
    status: "open",
    priority: "normal",
    occurredAt: message.receivedAt ?? message.createdAt,
    metadata: {
      mailboxId: message.mailboxId,
      threadId: message.threadId,
      from: message.addresses
        .filter((address) => address.kind === "from")
        .map((address) => ({ address: address.address, name: address.displayName })),
    },
    actorType: "system",
  });
  if (projection.created) {
    emitLocalInboxMailReceived({ item: projection.item, message });
  }
  return projection;
}

export function listLocalInboxItems(input: ListLocalInboxItemsInput = {}): LocalInboxItem[] {
  ensureLocalInboxSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  } else if (!input.includeArchived) {
    where.push("status NOT IN ('done','archived','dismissed')");
  }
  if (input.sourceDomain) {
    where.push("source_domain = ?");
    params.push(input.sourceDomain);
  }
  const limit = clampInt(input.limit, 50, 1, 500);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM inbox_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
        COALESCE(occurred_at, updated_at, created_at) DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as LocalInboxItemRow[];
  return rows.map(rowToItem);
}

export function readLocalInboxItem(id: string): { item: LocalInboxItem; events: LocalInboxEvent[] } {
  ensureLocalInboxSchema();
  const row = getDb().prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id) as LocalInboxItemRow | undefined;
  if (!row) throw new Error(`Inbox item not found: ${id}`);
  markLocalInboxItem(id, "seen", { eventType: "seen" });
  return {
    item: rowToItem((getDb().prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id) as LocalInboxItemRow) ?? row),
    events: listLocalInboxEvents(id),
  };
}

export function markLocalInboxItem(
  id: string,
  status: LocalInboxStatus,
  options: {
    eventType?: string;
    snoozedUntil?: number | null;
    actorType?: LocalInboxActorType;
    actorId?: string | null;
    payload?: Record<string, unknown>;
  } = {},
): LocalInboxItem {
  ensureLocalInboxSchema();
  const now = Date.now();
  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `UPDATE inbox_items
         SET status = ?, snoozed_until = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, options.snoozedUntil ?? null, now, id);
      const row = db.prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id) as LocalInboxItemRow | undefined;
      if (!row) throw new Error(`Inbox item not found: ${id}`);
      appendInboxEvent(id, options.eventType ?? status, {
        actorType: options.actorType ?? "unknown",
        actorId: options.actorId ?? null,
        payload: options.payload ?? { status },
        now,
      });
      return rowToItem(row);
    },
    { label: "local_inbox_mark" },
  );
}

export function listLocalInboxEvents(itemId: string): LocalInboxEvent[] {
  ensureLocalInboxSchema();
  const rows = getDb()
    .prepare(`SELECT * FROM inbox_item_events WHERE item_id = ? ORDER BY created_at ASC`)
    .all(itemId) as LocalInboxEventRow[];
  return rows.map(rowToEvent);
}

export function listLocalInboxSources(): Array<{ sourceDomain: string; count: number; open: number }> {
  ensureLocalInboxSchema();
  const rows = getDb()
    .prepare(
      `
      SELECT source_domain AS sourceDomain,
             COUNT(*) AS count,
             SUM(CASE WHEN status NOT IN ('done','archived','dismissed') THEN 1 ELSE 0 END) AS open
      FROM inbox_items
      GROUP BY source_domain
      ORDER BY source_domain ASC
    `,
    )
    .all() as Array<{ sourceDomain: string; count: number; open: number | null }>;
  return rows.map((row) => ({ sourceDomain: row.sourceDomain, count: row.count, open: row.open ?? 0 }));
}

function appendInboxEvent(
  itemId: string,
  eventType: string,
  input: { actorType: LocalInboxActorType; actorId: string | null; payload: Record<string, unknown>; now: number },
): void {
  getDb()
    .prepare(
      `
      INSERT INTO inbox_item_events (
        id, item_id, event_type, actor_type, actor_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      uniqueId("inbox_evt"),
      itemId,
      eventType,
      input.actorType,
      input.actorId,
      stableJson(input.payload),
      input.now,
    );
}

function getItemRowByDedupe(dedupeKey: string): LocalInboxItemRow | null {
  return (
    (getDb().prepare(`SELECT * FROM inbox_items WHERE dedupe_key = ?`).get(dedupeKey) as
      | LocalInboxItemRow
      | undefined) ?? null
  );
}

function rowToItem(row: LocalInboxItemRow): LocalInboxItem {
  return {
    id: row.id,
    sourceDomain: row.source_domain,
    sourceType: row.source_type,
    sourceId: row.source_id,
    dedupeKey: row.dedupe_key,
    title: row.title,
    summary: row.summary,
    status: row.status,
    priority: row.priority,
    assignedToAgentId: row.assigned_to_agent_id,
    assignedToContactId: row.assigned_to_contact_id,
    snoozedUntil: row.snoozed_until,
    occurredAt: row.occurred_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: LocalInboxEventRow): LocalInboxEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  };
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requireText(value: string | undefined | null, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Missing ${label}.`);
  return text;
}

function nullableText(value: string | undefined | null): string | null {
  const text = value?.trim();
  return text || null;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

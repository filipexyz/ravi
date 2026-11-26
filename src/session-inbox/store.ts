/**
 * Session inbox: durable, deferred notices for one session. Spec: `runtime/session-inbox`.
 *
 * A deferred notice does not wake the session. It waits here until a turn that may drain the
 * inbox (a verified human turn, or an opted-in heartbeat) and then reaches the model inside one
 * grouped block. The ledger follows the Signals piggyback pattern: `pending` items are reserved
 * for a turn before the block is rendered, `delivered` once the prompt reaches the provider, and
 * returned to `pending` when the turn never starts. Nothing is dropped: an item only leaves
 * `pending` by delivery or by an explicit `supersede_key`, and the superseded row is kept.
 */

import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";

export const INBOX_SOURCE_KINDS = ["thread", "child_run", "cron", "observer", "handoff", "system"] as const;
export type InboxSourceKind = (typeof INBOX_SOURCE_KINDS)[number];

export const INBOX_STATES = ["pending", "reserved", "delivered", "superseded"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/** A reservation whose turn never confirmed (a crash between render and send) returns after this. */
export const INBOX_STALE_RESERVATION_MS = 10 * 60_000;

/** Stored body cap. Longer text is cut here with a visible marker, never silently. */
export const INBOX_MAX_BODY_CHARS = 16_000;

export interface InboxItemInput {
  targetSessionName: string;
  sourceKind: InboxSourceKind;
  sourceRef: string;
  title: string;
  body: string;
  /** Only the newest pending item with the same key is delivered; older ones become `superseded`. */
  supersedeKey?: string | null;
  createdAt?: number;
}

export interface InboxItem {
  id: string;
  targetSessionName: string;
  sourceKind: InboxSourceKind;
  sourceRef: string;
  supersedeKey: string | null;
  title: string;
  body: string;
  state: InboxState;
  createdAt: number;
  reservedTurn: string | null;
  reservedAt: number | null;
  deliveredAt: number | null;
  supersededBy: string | null;
  /** When the prompt carrying the item was handed to the provider; null until then. */
  sentAt?: number | null;
}

export class InboxUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxUsageError";
  }
}

let schemaPath: string | null = null;

export function ensureInboxSchema(): void {
  const path = getRaviDbPath();
  if (schemaPath === path) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_inbox (
      id TEXT PRIMARY KEY,
      target_session_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      supersede_key TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'reserved', 'delivered', 'superseded')),
      created_at INTEGER NOT NULL,
      reserved_turn TEXT,
      reserved_at INTEGER,
      delivered_at INTEGER,
      superseded_by TEXT,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_inbox_target_state
      ON session_inbox(target_session_name, state, created_at);
  `);
  try {
    getDb().exec("ALTER TABLE session_inbox ADD COLUMN sent_at INTEGER");
  } catch (error) {
    // The column already exists (a database created after it was added): nothing to do.
    if (!/duplicate column/i.test(String(error))) throw error;
  }
  schemaPath = path;
}

function rowToItem(row: Record<string, unknown>): InboxItem {
  return {
    id: String(row.id),
    targetSessionName: String(row.target_session_name),
    sourceKind: String(row.source_kind) as InboxSourceKind,
    sourceRef: String(row.source_ref),
    supersedeKey: (row.supersede_key as string | null) ?? null,
    title: String(row.title),
    body: String(row.body),
    state: String(row.state) as InboxState,
    createdAt: Number(row.created_at),
    reservedTurn: (row.reserved_turn as string | null) ?? null,
    reservedAt: row.reserved_at == null ? null : Number(row.reserved_at),
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
    supersededBy: (row.superseded_by as string | null) ?? null,
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
  };
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new InboxUsageError(`${label} is required`);
  return text;
}

/** Writes one deferred notice. Returns the stored item. */
export function enqueueInboxItem(input: InboxItemInput): InboxItem {
  ensureInboxSchema();
  const target = requireText(input.targetSessionName, "targetSessionName");
  if (!INBOX_SOURCE_KINDS.includes(input.sourceKind)) {
    throw new InboxUsageError(`Unknown sourceKind: ${String(input.sourceKind)}`);
  }
  // One line, like the title: the source ref is printed inside the block line.
  const sourceRef = requireText(input.sourceRef, "sourceRef").replace(/[\s\u0085]+/g, " ");
  // The title is one line in the rendered block: no line of it may pass for a line of the block.
  const title = requireText(input.title, "title").replace(/[\s\u0085]+/g, " ");
  const rawBody = requireText(input.body, "body");
  const body =
    rawBody.length > INBOX_MAX_BODY_CHARS
      ? `${rawBody.slice(0, INBOX_MAX_BODY_CHARS)}\n[cortado: ${rawBody.length - INBOX_MAX_BODY_CHARS} caracteres]`
      : rawBody;
  const supersedeKey = input.supersedeKey?.trim() || null;
  const createdAt = input.createdAt ?? Date.now();
  const id = `inbox_${randomUUID()}`;
  const db = getDb();
  db.transaction(() => {
    if (supersedeKey) {
      // Only pending rows are superseded: a reserved row is already in a turn's block.
      db.prepare(
        `UPDATE session_inbox SET state = 'superseded', superseded_by = ?
         WHERE target_session_name = ? AND supersede_key = ? AND state = 'pending'`,
      ).run(id, target, supersedeKey);
    }
    db.prepare(
      `INSERT INTO session_inbox
         (id, target_session_name, source_kind, source_ref, supersede_key, title, body, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, target, input.sourceKind, sourceRef, supersedeKey, title, body, createdAt);
  })();
  return getInboxItem(id)!;
}

export function getInboxItem(id: string): InboxItem | null {
  ensureInboxSchema();
  const row = getDb().prepare("SELECT * FROM session_inbox WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToItem(row) : null;
}

export function listInboxItems(input: {
  targetSessionName: string;
  states?: InboxState[];
  limit?: number;
}): InboxItem[] {
  ensureInboxSchema();
  const states = input.states && input.states.length > 0 ? input.states : [...INBOX_STATES];
  const placeholders = states.map(() => "?").join(", ");
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
  const rows = getDb()
    .prepare(
      `SELECT * FROM session_inbox WHERE target_session_name = ? AND state IN (${placeholders})
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(input.targetSessionName, ...states, limit) as Record<string, unknown>[];
  return rows.map(rowToItem);
}

export interface InboxReservation {
  turnKey: string;
  items: InboxItem[];
  /** Pending items left out by the size cap. They stay `pending` for a later turn. */
  overflow: number;
}

export interface ReserveInboxInput {
  targetSessionName: string;
  maxItems: number;
  maxBytes: number;
  now?: number;
}

/**
 * Reserves pending items for one turn, oldest first, within the caps. Stale reservations of the
 * same session are returned to `pending` first, so a crash between render and send loses nothing.
 */
export function reserveInboxItems(input: ReserveInboxInput): InboxReservation {
  ensureInboxSchema();
  const now = input.now ?? Date.now();
  const turnKey = `inbox_turn_${randomUUID()}`;
  const db = getDb();
  let items: InboxItem[] = [];
  let overflow = 0;
  db.transaction(() => {
    db.prepare(
      `UPDATE session_inbox SET state = 'pending', reserved_turn = NULL, reserved_at = NULL, sent_at = NULL
       WHERE target_session_name = ? AND state = 'reserved' AND reserved_at < ?`,
    ).run(input.targetSessionName, now - INBOX_STALE_RESERVATION_MS);
    const pending = (
      db
        .prepare(
          `SELECT * FROM session_inbox WHERE target_session_name = ? AND state = 'pending'
           ORDER BY created_at, id`,
        )
        .all(input.targetSessionName) as Record<string, unknown>[]
    ).map(rowToItem);
    let bytes = 0;
    for (const item of pending) {
      const size = renderedInboxItemBytes(item);
      // Chronological: once one item does not fit, every newer one waits too, so a later turn
      // never sees a newer notice before an older one. The first item always fits; its rendered
      // body is capped (INBOX_MAX_RENDERED_BODY_BYTES), so it cannot block the inbox forever.
      const fits =
        overflow === 0 && items.length < input.maxItems && (items.length === 0 || bytes + size <= input.maxBytes);
      if (!fits) {
        overflow++;
        continue;
      }
      items.push(item);
      bytes += size;
    }
    const reserve = db.prepare(
      `UPDATE session_inbox SET state = 'reserved', reserved_turn = ?, reserved_at = ?
       WHERE id = ? AND state = 'pending'`,
    );
    for (const item of items) reserve.run(turnKey, now, item.id);
  })();
  items = items.map((item) => ({
    ...item,
    state: "reserved",
    reservedTurn: turnKey,
    reservedAt: now,
  }));
  return { turnKey, items, overflow };
}

/**
 * The prompt with the block was handed to the provider. The items stay `reserved`: a turn aborted
 * after this point may never have shown them, so delivery is only confirmed when the turn ends.
 */
export function markInboxReservationSent(turnKey: string, now = Date.now()): number {
  ensureInboxSchema();
  const result = getDb()
    .prepare("UPDATE session_inbox SET sent_at = ? WHERE reserved_turn = ? AND state = 'reserved'")
    .run(now, turnKey);
  return Number(result.changes ?? 0);
}

/** The turn that carried the block completed: the reserved items are delivered. */
export function commitInboxReservation(turnKey: string, now = Date.now()): number {
  ensureInboxSchema();
  const result = getDb()
    .prepare(
      `UPDATE session_inbox SET state = 'delivered', delivered_at = ?
       WHERE reserved_turn = ? AND state = 'reserved'`,
    )
    .run(now, turnKey);
  return Number(result.changes ?? 0);
}

/** The turn never started: the reserved items return to `pending`. */
export function releaseInboxReservation(turnKey: string): number {
  ensureInboxSchema();
  const result = getDb()
    .prepare(
      `UPDATE session_inbox SET state = 'pending', reserved_turn = NULL, reserved_at = NULL, sent_at = NULL
       WHERE reserved_turn = ? AND state = 'reserved'`,
    )
    .run(turnKey);
  return Number(result.changes ?? 0);
}

/** Rendered body cap per item: one notice never takes more than this of a turn's block. */
export const INBOX_MAX_RENDERED_BODY_BYTES = 8 * 1024;

/** Per-item overhead of the rendered line (time, source label, quote marks), counted against the turn cap. */
const INBOX_RENDERED_ITEM_OVERHEAD_BYTES = 64;

export function renderedInboxBody(item: Pick<InboxItem, "id" | "body">): string {
  const bytes = Buffer.byteLength(item.body);
  if (bytes <= INBOX_MAX_RENDERED_BODY_BYTES) return item.body;
  let cut = item.body.slice(0, INBOX_MAX_RENDERED_BODY_BYTES);
  while (Buffer.byteLength(cut) > INBOX_MAX_RENDERED_BODY_BYTES) cut = cut.slice(0, -1);
  return `${cut}\n[cortado no bloco: ${bytes - Buffer.byteLength(cut)} bytes; texto inteiro no item ${item.id}]`;
}

/** What one item adds to the rendered block: title, body as rendered, quote prefixes and labels. */
export function renderedInboxItemBytes(item: Pick<InboxItem, "id" | "title" | "body" | "sourceRef">): number {
  const body = renderedInboxBody(item);
  const lines = body.split(/\r\n|[\n\r\u0085\u2028\u2029]/).length;
  return (
    Buffer.byteLength(item.title) +
    Buffer.byteLength(item.sourceRef) +
    Buffer.byteLength(body) +
    lines * 4 +
    INBOX_RENDERED_ITEM_OVERHEAD_BYTES
  );
}

export function countPendingInboxItems(targetSessionName: string): number {
  ensureInboxSchema();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM session_inbox WHERE target_session_name = ? AND state = 'pending'")
    .get(targetSessionName) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

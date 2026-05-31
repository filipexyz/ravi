import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import { sanitizeSyncError, sanitizeSyncPayload } from "./redaction.js";
import type {
  SyncBatch,
  SyncCursorRecord,
  SyncInboxRecord,
  SyncInboxStatus,
  SyncOutboxRecord,
  SyncOutboxStatus,
  SyncStatusSummary,
} from "./types.js";

const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_BATCH_BYTES = 256 * 1024;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;

interface SyncOutboxRow {
  id: string;
  event_id: string;
  origin_installation_id: string | null;
  domain: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  entity_revision: number | null;
  idempotency_key: string;
  payload_json: string;
  evidence_refs_json: string | null;
  schema_version: number;
  status: SyncOutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  lease_id: string | null;
  leased_until: number | null;
  last_error_code: string | null;
  occurred_at: number;
  sent_at: number | null;
  acked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SyncInboxRow {
  id: string;
  remote_sequence: string | null;
  remote_event_id: string;
  domain: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  status: SyncInboxStatus;
  attempt_count: number;
  last_error_code: string | null;
  received_at: number;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SyncCursorRow {
  domain: string;
  cursor_key: string;
  cursor_value: string | null;
  updated_at: number;
  meta_json: string | null;
}

export interface EnqueueSyncEventInput {
  eventId?: string;
  originInstallationId?: string | null;
  domain: string;
  eventType: string;
  entityType: string;
  entityId: string;
  entityRevision?: number | null;
  idempotencyKey?: string;
  payload: unknown;
  evidenceRefs?: unknown[];
  schemaVersion?: number;
  occurredAt?: number;
  now?: number;
  syncClass?: "syncable" | "local_only" | "remote_owned" | "ephemeral";
}

export interface ListPendingOutboxBatchInput {
  domain?: string | null;
  excludeDomains?: string[];
  limit?: number;
  maxBytes?: number;
  leaseMs?: number;
  now?: number;
}

export interface MarkOutboxFailedInput {
  ids: string[];
  errorCode: string;
  retryable?: boolean;
  now?: number;
  maxAttempts?: number;
}

export interface EnqueueRemoteEventInput {
  id?: string;
  remoteSequence?: string | number | null;
  remoteEventId: string;
  domain: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  receivedAt?: number;
  now?: number;
}

export type SyncInboxApplyHandler = (
  event: SyncInboxRecord,
) => Promise<"applied" | "skipped" | undefined> | "applied" | "skipped" | undefined;

export interface ApplyInboxBatchInput {
  domain?: string | null;
  limit?: number;
  handlers?: Record<string, SyncInboxApplyHandler>;
  now?: number;
}

export interface RetryOutboxInput {
  ids?: string[];
  includeDead?: boolean;
  now?: number;
}

export function enqueueSyncEvent(input: EnqueueSyncEventInput): SyncOutboxRecord | null {
  if (input.syncClass && input.syncClass !== "syncable") return null;

  const now = input.now ?? Date.now();
  const eventId = requireText(input.eventId ?? deterministicEventId(input), "eventId");
  const idempotencyKey = requireText(input.idempotencyKey ?? eventId, "idempotencyKey");
  const payload = stableStringify(sanitizeSyncPayload(input.payload));
  const evidenceRefs = stableStringify(sanitizeSyncPayload(input.evidenceRefs ?? []));
  const occurredAt = input.occurredAt ?? now;
  const id = `sync_out_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT OR IGNORE INTO sync_outbox (
          id, event_id, origin_installation_id, domain, event_type, entity_type, entity_id,
          entity_revision, idempotency_key, payload_json, evidence_refs_json, schema_version,
          status, attempt_count, next_attempt_at, occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)
      `,
      ).run(
        id,
        eventId,
        nullableText(input.originInstallationId),
        requireText(input.domain, "domain"),
        requireText(input.eventType, "eventType"),
        requireText(input.entityType, "entityType"),
        requireText(input.entityId, "entityId"),
        input.entityRevision ?? null,
        idempotencyKey,
        payload,
        evidenceRefs,
        input.schemaVersion ?? 1,
        occurredAt,
        now,
        now,
      );

      return getOutboxByIdempotencyKey(idempotencyKey)!;
    },
    { label: "sync_outbox_enqueue" },
  );
}

export function listPendingOutboxBatch(input: ListPendingOutboxBatchInput = {}): SyncBatch<SyncOutboxRecord> {
  const now = input.now ?? Date.now();
  const limit = clampPositiveInt(input.limit, DEFAULT_BATCH_LIMIT, 500);
  const maxBytes = clampPositiveInt(input.maxBytes, DEFAULT_BATCH_BYTES, 5 * 1024 * 1024);
  const leaseMs = clampPositiveInt(input.leaseMs, DEFAULT_LEASE_MS, 10 * 60_000);
  const leaseId = `lease_${randomUUID().replace(/-/g, "").slice(0, 18)}`;

  return executeWrite(
    getDb(),
    (db) => {
      const domainClause = input.domain ? "AND domain = ?" : "";
      const excludeDomains = input.excludeDomains?.filter(Boolean) ?? [];
      const excludeClause = excludeDomains.length ? `AND domain NOT IN (${placeholders(excludeDomains.length)})` : "";
      const params = input.domain
        ? [now, now, input.domain, ...excludeDomains, limit * 4]
        : [now, now, ...excludeDomains, limit * 4];
      const rows = db
        .prepare(
          `
          SELECT * FROM sync_outbox
          WHERE (
            status IN ('pending','failed')
            OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until <= ?)
          )
          AND next_attempt_at <= ?
          ${domainClause}
          ${excludeClause}
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
        )
        .all(...params) as SyncOutboxRow[];

      const selected: SyncOutboxRow[] = [];
      let bytes = 0;
      for (const row of rows) {
        const rowBytes =
          Buffer.byteLength(row.payload_json, "utf8") + Buffer.byteLength(row.evidence_refs_json ?? "[]", "utf8") + 512;
        if (selected.length > 0 && bytes + rowBytes > maxBytes) break;
        selected.push(row);
        bytes += rowBytes;
        if (selected.length >= limit) break;
      }

      if (selected.length === 0) return { items: [], leaseId, bytes: 0 };

      const update = db.prepare(
        `
        UPDATE sync_outbox
        SET status = 'leased',
            lease_id = ?,
            leased_until = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
      `,
      );
      for (const row of selected) update.run(leaseId, now + leaseMs, now, row.id);

      return {
        items: selected.map((row) =>
          rowToOutbox({
            ...row,
            status: "leased",
            lease_id: leaseId,
            leased_until: now + leaseMs,
            attempt_count: row.attempt_count + 1,
            updated_at: now,
          }),
        ),
        leaseId,
        bytes,
      };
    },
    { label: "sync_outbox_list_pending_batch" },
  );
}

export function markOutboxSent(ids: string[], now = Date.now()): number {
  if (ids.length === 0) return 0;
  return updateOutboxStatus(ids, "sent", now, { sentAt: now });
}

export function markOutboxAcked(ids: string[], now = Date.now()): number {
  if (ids.length === 0) return 0;
  return updateOutboxStatus(ids, "acked", now, { ackedAt: now });
}

export function markOutboxFailed(input: MarkOutboxFailedInput): number {
  if (input.ids.length === 0) return 0;
  const now = input.now ?? Date.now();
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryable = input.retryable !== false;
  const safeCode = sanitizeErrorCode(input.errorCode);
  return executeWrite(
    getDb(),
    (db) => {
      const rows = db
        .prepare(`SELECT id, attempt_count FROM sync_outbox WHERE id IN (${placeholders(input.ids.length)})`)
        .all(...input.ids) as Array<{ id: string; attempt_count: number }>;
      const update = db.prepare(
        `
        UPDATE sync_outbox
        SET status = ?,
            lease_id = NULL,
            leased_until = NULL,
            next_attempt_at = ?,
            last_error_code = ?,
            updated_at = ?
        WHERE id = ?
      `,
      );
      let changed = 0;
      for (const row of rows) {
        const dead = !retryable || row.attempt_count >= maxAttempts;
        const nextAttemptAt = dead ? 0 : now + retryDelayMs(row.attempt_count);
        update.run(dead ? "dead" : "failed", nextAttemptAt, safeCode, now, row.id);
        changed += 1;
        if (dead) {
          insertDeadLetter("outbox", row.id, safeCode, now);
        }
      }
      return changed;
    },
    { label: "sync_outbox_mark_failed" },
  );
}

export function enqueueRemoteEvent(input: EnqueueRemoteEventInput): SyncInboxRecord {
  const now = input.now ?? Date.now();
  const id = input.id ?? `sync_in_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const payload = stableStringify(sanitizeSyncPayload(input.payload));
  const remoteSequence =
    input.remoteSequence === undefined || input.remoteSequence === null ? null : String(input.remoteSequence);
  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT OR IGNORE INTO sync_inbox (
          id, remote_sequence, remote_event_id, domain, event_type, entity_type, entity_id,
          payload_json, status, attempt_count, received_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `,
      ).run(
        id,
        remoteSequence,
        requireText(input.remoteEventId, "remoteEventId"),
        requireText(input.domain, "domain"),
        requireText(input.eventType, "eventType"),
        requireText(input.entityType, "entityType"),
        requireText(input.entityId, "entityId"),
        payload,
        input.receivedAt ?? now,
        now,
        now,
      );
      const existing =
        getInboxByRemoteEventId(input.remoteEventId) ??
        (remoteSequence ? getInboxByDomainSequence(input.domain, remoteSequence) : null);
      if (!existing) throw new Error("sync inbox enqueue failed");
      return existing;
    },
    { label: "sync_inbox_enqueue" },
  );
}

export async function applyInboxBatch(
  input: ApplyInboxBatchInput = {},
): Promise<{ applied: number; skipped: number; failed: number; pending: number }> {
  const now = input.now ?? Date.now();
  const limit = clampPositiveInt(input.limit, DEFAULT_BATCH_LIMIT, 500);
  const domainClause = input.domain ? "AND domain = ?" : "";
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM sync_inbox
      WHERE status = 'pending'
      ${domainClause}
      ORDER BY received_at ASC, id ASC
      LIMIT ?
    `,
    )
    .all(...(input.domain ? [input.domain, limit] : [limit])) as SyncInboxRow[];

  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  for (const row of rows) {
    const record = rowToInbox(row);
    const handler = input.handlers?.[record.domain];
    if (!handler) {
      pending += 1;
      continue;
    }
    try {
      const result = (await handler(record)) ?? "applied";
      const status = result === "skipped" ? "skipped" : "applied";
      getDb()
        .prepare("UPDATE sync_inbox SET status = ?, applied_at = ?, updated_at = ? WHERE id = ?")
        .run(status, now, now, record.id);
      if (status === "skipped") skipped += 1;
      else applied += 1;
    } catch (error) {
      failed += 1;
      const code = sanitizeErrorCode(sanitizeSyncError(error));
      getDb()
        .prepare(
          `
          UPDATE sync_inbox
          SET status = 'failed',
              attempt_count = attempt_count + 1,
              last_error_code = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(code, now, record.id);
    }
  }
  return { applied, skipped, failed, pending };
}

export function getSyncCursor(domain: string, cursorKey: string): SyncCursorRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM sync_cursors WHERE domain = ? AND cursor_key = ?")
    .get(domain, cursorKey) as SyncCursorRow | undefined;
  return row ? rowToCursor(row) : null;
}

export function setSyncCursor(
  domain: string,
  cursorKey: string,
  cursorValue: string | number | null,
  meta?: unknown,
  now = Date.now(),
): SyncCursorRecord {
  const value = cursorValue === null || cursorValue === undefined ? null : String(cursorValue);
  const metaJson = meta === undefined ? null : stableStringify(sanitizeSyncPayload(meta));
  getDb()
    .prepare(
      `
      INSERT INTO sync_cursors (domain, cursor_key, cursor_value, updated_at, meta_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(domain, cursor_key) DO UPDATE SET
        cursor_value = excluded.cursor_value,
        updated_at = excluded.updated_at,
        meta_json = excluded.meta_json
    `,
    )
    .run(requireText(domain, "domain"), requireText(cursorKey, "cursorKey"), value, now, metaJson);
  return getSyncCursor(domain, cursorKey)!;
}

export function getSyncStatusSummary(): SyncStatusSummary {
  const db = getDb();
  const outbox = countStatuses<SyncOutboxStatus>(
    ["pending", "leased", "sent", "acked", "failed", "dead"],
    "sync_outbox",
  );
  const inbox = countStatuses<SyncInboxStatus>(["pending", "applied", "skipped", "failed", "dead"], "sync_inbox");
  const cursors = (db.prepare("SELECT * FROM sync_cursors ORDER BY domain, cursor_key").all() as SyncCursorRow[]).map(
    rowToCursor,
  );
  const lastOutboxError = db
    .prepare(
      "SELECT last_error_code AS code FROM sync_outbox WHERE last_error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as { code: string } | undefined;
  const lastInboxError = db
    .prepare(
      "SELECT last_error_code AS code FROM sync_inbox WHERE last_error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as { code: string } | undefined;
  return {
    outbox,
    inbox,
    cursors,
    lastError: lastOutboxError?.code ?? lastInboxError?.code ?? null,
  };
}

export function retryOutbox(input: RetryOutboxInput = {}): number {
  const now = input.now ?? Date.now();
  const statuses = input.includeDead ? ["failed", "dead"] : ["failed"];
  const ids = input.ids;
  const whereIds = ids?.length ? `AND id IN (${placeholders(ids.length)})` : "";
  const params = [...statuses, ...(ids ?? [])];
  const result = getDb()
    .prepare(
      `
      UPDATE sync_outbox
      SET status = 'pending',
          next_attempt_at = 0,
          lease_id = NULL,
          leased_until = NULL,
          last_error_code = NULL,
          updated_at = ?
      WHERE status IN (${placeholders(statuses.length)})
      ${whereIds}
    `,
    )
    .run(now, ...params);
  return Number(result.changes ?? 0);
}

export function inspectSyncRecord(
  id: string,
): { kind: "outbox"; record: SyncOutboxRecord } | { kind: "inbox"; record: SyncInboxRecord } | null {
  const outbox = getOutboxById(id);
  if (outbox) return { kind: "outbox", record: outbox };
  const inbox = getInboxById(id);
  if (inbox) return { kind: "inbox", record: inbox };
  return null;
}

export function getOutboxById(id: string): SyncOutboxRecord | null {
  const row = getDb().prepare("SELECT * FROM sync_outbox WHERE id = ?").get(id) as SyncOutboxRow | undefined;
  return row ? rowToOutbox(row) : null;
}

export function getInboxById(id: string): SyncInboxRecord | null {
  const row = getDb().prepare("SELECT * FROM sync_inbox WHERE id = ?").get(id) as SyncInboxRow | undefined;
  return row ? rowToInbox(row) : null;
}

function getOutboxByIdempotencyKey(idempotencyKey: string): SyncOutboxRecord | null {
  const row = getDb().prepare("SELECT * FROM sync_outbox WHERE idempotency_key = ?").get(idempotencyKey) as
    | SyncOutboxRow
    | undefined;
  return row ? rowToOutbox(row) : null;
}

function getInboxByRemoteEventId(remoteEventId: string): SyncInboxRecord | null {
  const row = getDb().prepare("SELECT * FROM sync_inbox WHERE remote_event_id = ?").get(remoteEventId) as
    | SyncInboxRow
    | undefined;
  return row ? rowToInbox(row) : null;
}

function getInboxByDomainSequence(domain: string, remoteSequence: string): SyncInboxRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM sync_inbox WHERE domain = ? AND remote_sequence = ?")
    .get(domain, remoteSequence) as SyncInboxRow | undefined;
  return row ? rowToInbox(row) : null;
}

function updateOutboxStatus(
  ids: string[],
  status: SyncOutboxStatus,
  now: number,
  extra: { sentAt?: number; ackedAt?: number } = {},
): number {
  return executeWrite(
    getDb(),
    (db) => {
      const result = db
        .prepare(
          `
          UPDATE sync_outbox
          SET status = ?,
              lease_id = NULL,
              leased_until = NULL,
              sent_at = COALESCE(?, sent_at),
              acked_at = COALESCE(?, acked_at),
              updated_at = ?
          WHERE id IN (${placeholders(ids.length)})
        `,
        )
        .run(status, extra.sentAt ?? null, extra.ackedAt ?? null, now, ...ids);
      return Number(result.changes ?? 0);
    },
    { label: `sync_outbox_mark_${status}` },
  );
}

function insertDeadLetter(source: string, sourceId: string, reasonCode: string, now: number): void {
  getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO sync_dead_letters (id, source, source_id, reason_code, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(`sync_dead_${randomUUID().replace(/-/g, "").slice(0, 20)}`, source, sourceId, reasonCode, now);
}

function rowToOutbox(row: SyncOutboxRow): SyncOutboxRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    originInstallationId: row.origin_installation_id,
    domain: row.domain,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityRevision: row.entity_revision,
    idempotencyKey: row.idempotency_key,
    payload: parseJson(row.payload_json, {}),
    evidenceRefs: parseJson(row.evidence_refs_json ?? "[]", []),
    schemaVersion: row.schema_version,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseId: row.lease_id,
    leasedUntil: row.leased_until,
    lastErrorCode: row.last_error_code,
    occurredAt: row.occurred_at,
    sentAt: row.sent_at,
    ackedAt: row.acked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInbox(row: SyncInboxRow): SyncInboxRecord {
  return {
    id: row.id,
    remoteSequence: row.remote_sequence,
    remoteEventId: row.remote_event_id,
    domain: row.domain,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    receivedAt: row.received_at,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCursor(row: SyncCursorRow): SyncCursorRecord {
  return {
    domain: row.domain,
    cursorKey: row.cursor_key,
    cursorValue: row.cursor_value,
    updatedAt: row.updated_at,
    meta: row.meta_json ? parseJson(row.meta_json, null) : null,
  };
}

function countStatuses<T extends string>(statuses: readonly T[], table: string): Record<T, number> {
  const out = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all() as Array<{
    status: T;
    count: number;
  }>;
  for (const row of rows) {
    if (row.status in out) out[row.status] = Number(row.count ?? 0);
  }
  return out;
}

function deterministicEventId(input: EnqueueSyncEventInput): string {
  return `sync_evt_${createHash("sha256")
    .update([input.domain, input.eventType, input.entityType, input.entityId, input.idempotencyKey ?? ""].join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requireText(value: string | null | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`sync ${field} is required`);
  return text;
}

function nullableText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text || null;
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount, 1), 6);
  return Math.min(60_000 * 2 ** (exponent - 1), 60 * 60_000);
}

function sanitizeErrorCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

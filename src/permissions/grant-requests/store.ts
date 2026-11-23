import { getDb } from "../../router/router-db.js";
import type {
  GrantRequestDelivery,
  GrantRequestOutcome,
  GrantRequestPlan,
  GrantRequestRecord,
  GrantRequestRequester,
  GrantRequestStatus,
} from "./types.js";

interface GrantRequestRow {
  id: string;
  plan_json: string;
  requester_json: string;
  grantors_json: string;
  status: string;
  decided_by_contact_id: string | null;
  decided_via: string | null;
  outcome: string | null;
  reason: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

interface GrantRequestDeliveryRow {
  request_id: string;
  contact_id: string;
  channel: string;
  ref_json: string;
  created_at: number;
}

function ensureTables(): void {
  const db = getDb();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS permission_grant_requests (
      id TEXT PRIMARY KEY,
      plan_json TEXT NOT NULL,
      requester_json TEXT NOT NULL,
      grantors_json TEXT NOT NULL,
      status TEXT NOT NULL,
      decided_by_contact_id TEXT,
      decided_via TEXT,
      outcome TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER
    )`,
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_permission_grant_requests_status_expires
      ON permission_grant_requests(status, expires_at)`,
  ).run();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS permission_grant_request_deliveries (
      request_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      ref_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_permission_grant_request_deliveries_request
      ON permission_grant_request_deliveries(request_id)`,
  ).run();
}

export interface CreateGrantRequestInput {
  readonly id: string;
  readonly plan: GrantRequestPlan;
  readonly requester: GrantRequestRequester;
  readonly grantorContactIds: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function createGrantRequest(input: CreateGrantRequestInput): GrantRequestRecord {
  ensureTables();
  getDb()
    .prepare(
      `INSERT INTO permission_grant_requests
        (id, plan_json, requester_json, grantors_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      input.id,
      JSON.stringify(input.plan),
      JSON.stringify(input.requester),
      JSON.stringify([...input.grantorContactIds]),
      input.createdAt,
      input.expiresAt,
    );
  const record = getGrantRequest(input.id);
  if (!record) throw new Error("Grant request was not stored.");
  return record;
}

export function getGrantRequest(id: string): GrantRequestRecord | null {
  ensureTables();
  const row = getDb().prepare("SELECT * FROM permission_grant_requests WHERE id = ?").get(id) as
    | GrantRequestRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * An identical ask that is still open: same contact, chat and profile. Asking
 * twice must not send the approver two prompts.
 */
export function findOpenGrantRequest(plan: GrantRequestPlan, now: number): GrantRequestRecord | null {
  ensureTables();
  const rows = getDb()
    .prepare("SELECT * FROM permission_grant_requests WHERE status = 'pending' AND expires_at > ? ORDER BY created_at")
    .all(now) as GrantRequestRow[];
  for (const row of rows) {
    const candidate = rowToRecord(row);
    if (
      candidate.plan.profile === plan.profile &&
      candidate.plan.contactId === plan.contactId &&
      candidate.plan.chatId === plan.chatId
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Single-use claim. Exactly one caller can move a request out of `pending`, and
 * only before it expires; an applied, rejected or expired request can never be
 * decided again.
 */
export function claimGrantRequest(input: {
  readonly id: string;
  readonly status: Extract<GrantRequestStatus, "approved" | "rejected">;
  readonly decidedByContactId: string;
  readonly decidedVia: string;
  readonly reason?: string;
  readonly now: number;
}): GrantRequestRecord | null {
  ensureTables();
  const result = getDb()
    .prepare(
      `UPDATE permission_grant_requests
        SET status = ?, decided_by_contact_id = ?, decided_via = ?, reason = ?, decided_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .run(
      input.status,
      input.decidedByContactId,
      input.decidedVia,
      input.reason ?? null,
      input.now,
      input.id,
      input.now,
    );
  return result.changes === 1 ? getGrantRequest(input.id) : null;
}

/** The trusted executor's terminal result. Written once, only for an approved request. */
export function recordGrantRequestOutcome(
  id: string,
  outcome: GrantRequestOutcome,
  status?: Extract<GrantRequestStatus, "failed">,
): GrantRequestRecord | null {
  ensureTables();
  const result = getDb()
    .prepare(
      `UPDATE permission_grant_requests
        SET outcome = ?, status = COALESCE(?, status)
        WHERE id = ? AND status = 'approved' AND outcome IS NULL`,
    )
    .run(outcome, status ?? null, id);
  return result.changes === 1 ? getGrantRequest(id) : null;
}

export function failGrantRequest(id: string, reason: string, now: number): GrantRequestRecord | null {
  ensureTables();
  const result = getDb()
    .prepare(
      `UPDATE permission_grant_requests
        SET status = 'failed', reason = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(reason, now, id);
  return result.changes === 1 ? getGrantRequest(id) : null;
}

/** Flip every pending request that ran out of time. Returns the ones that changed. */
export function expireGrantRequests(now: number): GrantRequestRecord[] {
  ensureTables();
  const due = getDb()
    .prepare("SELECT id FROM permission_grant_requests WHERE status = 'pending' AND expires_at <= ?")
    .all(now) as Array<{ id: string }>;
  const expired: GrantRequestRecord[] = [];
  for (const { id } of due) {
    const result = getDb()
      .prepare(
        `UPDATE permission_grant_requests
          SET status = 'expired', decided_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
      )
      .run(now, id, now);
    if (result.changes !== 1) continue;
    const record = getGrantRequest(id);
    if (record) expired.push(record);
  }
  return expired;
}

export function recordGrantRequestDelivery(
  input: Omit<GrantRequestDelivery, "createdAt"> & { createdAt: number },
): void {
  ensureTables();
  getDb()
    .prepare(
      `INSERT INTO permission_grant_request_deliveries (request_id, contact_id, channel, ref_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.requestId, input.contactId, input.channel, JSON.stringify(input.ref), input.createdAt);
}

export function listGrantRequestDeliveries(requestId: string): GrantRequestDelivery[] {
  ensureTables();
  const rows = getDb()
    .prepare("SELECT * FROM permission_grant_request_deliveries WHERE request_id = ? ORDER BY created_at, rowid")
    .all(requestId) as GrantRequestDeliveryRow[];
  return rows.map((row) => ({
    requestId: row.request_id,
    contactId: row.contact_id,
    channel: row.channel,
    ref: parseObject(row.ref_json),
    createdAt: row.created_at,
  }));
}

/**
 * The delivery whose adapter-private reference holds `value` under `key`. An
 * adapter uses it to find which request an inbound message answers (for example
 * the id of the message it sent); the core never reads the reference itself.
 */
export function findGrantRequestDeliveryByRef(
  channel: string,
  key: string,
  value: string,
): GrantRequestDelivery | null {
  ensureTables();
  const row = getDb()
    .prepare(
      `SELECT * FROM permission_grant_request_deliveries
        WHERE channel = ? AND json_extract(ref_json, '$.' || ?) = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(channel, key, value) as GrantRequestDeliveryRow | undefined;
  return row
    ? {
        requestId: row.request_id,
        contactId: row.contact_id,
        channel: row.channel,
        ref: parseObject(row.ref_json),
        createdAt: row.created_at,
      }
    : null;
}

function rowToRecord(row: GrantRequestRow): GrantRequestRecord {
  return {
    id: row.id,
    plan: parseObject(row.plan_json) as unknown as GrantRequestPlan,
    requester: parseObject(row.requester_json) as GrantRequestRequester,
    grantorContactIds: parseStringArray(row.grantors_json),
    status: row.status as GrantRequestStatus,
    decidedByContactId: row.decided_by_contact_id,
    decidedVia: row.decided_via,
    outcome: row.outcome === "applied" || row.outcome === "failed" ? row.outcome : null,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    // The core wrote this row; an unreadable one is a bug to see, not an empty request.
    throw new Error("Stored grant request JSON is unreadable.", { cause: error });
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseStringArray(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Stored grant request JSON is unreadable.", { cause: error });
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

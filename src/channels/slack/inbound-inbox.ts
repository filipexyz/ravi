import { createHash } from "node:crypto";
import { getDb } from "../../router/router-db.js";
import type { SlackSocketEnvelope } from "./types.js";

export const SLACK_INBOUND_ENVELOPE_CLAIM_LEASE_MS = 5 * 60_000;
export const SLACK_INBOUND_ENVELOPE_RECONCILE_LIMIT = 25;
export const SLACK_INBOUND_ENVELOPE_RETENTION_MS = 14 * 24 * 60 * 60_000;

export type SlackInboundEnvelopeState = "accepted" | "processing" | "processed";

export interface SlackInboundEnvelopeRecord {
  scopeId: string;
  envelopeId: string;
  requestFingerprint: string;
  envelope: SlackSocketEnvelope;
  state: SlackInboundEnvelopeState;
  claimId?: string;
  claimExpiresAt?: number;
  acceptedAt: number;
  processedAt?: number;
  updatedAt: number;
}

interface SlackInboundEnvelopeRow {
  scope_id: string;
  envelope_id: string;
  request_fingerprint: string;
  envelope_json: string;
  state: SlackInboundEnvelopeState;
  claim_id: string | null;
  claim_expires_at: number | null;
  accepted_at: number;
  processed_at: number | null;
  updated_at: number;
}

export type AcceptSlackInboundEnvelopeResult =
  | { status: "accepted" | "duplicate"; record: SlackInboundEnvelopeRecord }
  | { status: "conflict"; record: SlackInboundEnvelopeRecord };

export type ClaimSlackInboundEnvelopeResult =
  | { status: "acquired"; record: SlackInboundEnvelopeRecord }
  | { status: "busy"; record: SlackInboundEnvelopeRecord }
  | { status: "processed"; record: SlackInboundEnvelopeRecord };

export function acceptSlackInboundEnvelope(input: {
  scopeId: string;
  envelopeId: string;
  envelope: SlackSocketEnvelope;
  acceptedAt?: number;
}): AcceptSlackInboundEnvelopeResult {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const envelopeId = requireText(input.envelopeId, "envelopeId");
  const acceptedAt = validTimestamp(input.acceptedAt ?? Date.now(), "acceptedAt");
  const envelopeJson = canonicalJson(input.envelope);
  if (Buffer.byteLength(envelopeJson, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Slack inbound envelope exceeds the durable inbox limit");
  }
  const requestFingerprint = createHash("sha256").update(envelopeJson, "utf8").digest("hex");
  const database = getDb();
  return database.transaction((): AcceptSlackInboundEnvelopeResult => {
    const inserted = database
      .prepare(
        `
        INSERT OR IGNORE INTO slack_inbound_envelopes (
          scope_id, envelope_id, request_fingerprint, envelope_json,
          state, claim_id, claim_expires_at, accepted_at, processed_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'accepted', NULL, NULL, ?, NULL, ?)
      `,
      )
      .run(scopeId, envelopeId, requestFingerprint, envelopeJson, acceptedAt, acceptedAt);
    const record = requireSlackInboundEnvelope(scopeId, envelopeId);
    if (record.requestFingerprint !== requestFingerprint) {
      return { status: "conflict", record };
    }
    return {
      status: inserted.changes > 0 ? "accepted" : "duplicate",
      record,
    };
  })();
}

export function claimSlackInboundEnvelope(input: {
  scopeId: string;
  envelopeId: string;
  claimId: string;
  claimedAt?: number;
  leaseMs?: number;
}): ClaimSlackInboundEnvelopeResult {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const envelopeId = requireText(input.envelopeId, "envelopeId");
  const claimId = requireText(input.claimId, "claimId");
  const claimedAt = validTimestamp(input.claimedAt ?? Date.now(), "claimedAt");
  const leaseMs = input.leaseMs ?? SLACK_INBOUND_ENVELOPE_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 30 * 60_000) {
    throw new Error("leaseMs must be an integer between 1000 and 1800000");
  }
  const database = getDb();
  return database.transaction((): ClaimSlackInboundEnvelopeResult => {
    const current = requireSlackInboundEnvelope(scopeId, envelopeId);
    if (current.state === "processed") return { status: "processed", record: current };
    if (current.state === "processing" && current.claimId !== claimId && (current.claimExpiresAt ?? 0) > claimedAt) {
      return { status: "busy", record: current };
    }
    const claimExpiresAt = claimedAt + leaseMs;
    const result = database
      .prepare(
        `
        UPDATE slack_inbound_envelopes
        SET state = 'processing',
            claim_id = ?,
            claim_expires_at = ?,
            updated_at = ?
        WHERE scope_id = ?
          AND envelope_id = ?
          AND state IN ('accepted', 'processing')
          AND (
            claim_id IS NULL
            OR claim_id = ?
            OR claim_expires_at IS NULL
            OR claim_expires_at <= ?
          )
      `,
      )
      .run(claimId, claimExpiresAt, claimedAt, scopeId, envelopeId, claimId, claimedAt);
    const record = requireSlackInboundEnvelope(scopeId, envelopeId);
    return result.changes > 0 && record.claimId === claimId
      ? { status: "acquired", record }
      : record.state === "processed"
        ? { status: "processed", record }
        : { status: "busy", record };
  })();
}

export function markSlackInboundEnvelopeProcessed(input: {
  scopeId: string;
  envelopeId: string;
  claimId: string;
  processedAt?: number;
}): SlackInboundEnvelopeRecord {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const envelopeId = requireText(input.envelopeId, "envelopeId");
  const claimId = requireText(input.claimId, "claimId");
  const processedAt = validTimestamp(input.processedAt ?? Date.now(), "processedAt");
  const result = getDb()
    .prepare(
      `
      UPDATE slack_inbound_envelopes
      SET state = 'processed',
          claim_id = NULL,
          claim_expires_at = NULL,
          processed_at = COALESCE(processed_at, ?),
          updated_at = ?
      WHERE scope_id = ?
        AND envelope_id = ?
        AND state = 'processing'
        AND claim_id = ?
    `,
    )
    .run(processedAt, processedAt, scopeId, envelopeId, claimId);
  if (result.changes === 0) {
    throw new Error(`Slack inbound envelope claim is no longer owned: ${envelopeId}`);
  }
  return requireSlackInboundEnvelope(scopeId, envelopeId);
}

export function releaseSlackInboundEnvelopeClaim(input: {
  scopeId: string;
  envelopeId: string;
  claimId: string;
  releasedAt?: number;
}): SlackInboundEnvelopeRecord {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const envelopeId = requireText(input.envelopeId, "envelopeId");
  const claimId = requireText(input.claimId, "claimId");
  const releasedAt = validTimestamp(input.releasedAt ?? Date.now(), "releasedAt");
  getDb()
    .prepare(
      `
      UPDATE slack_inbound_envelopes
      SET state = CASE WHEN state = 'processing' THEN 'accepted' ELSE state END,
          claim_id = NULL,
          claim_expires_at = NULL,
          updated_at = ?
      WHERE scope_id = ?
        AND envelope_id = ?
        AND state = 'processing'
        AND claim_id = ?
    `,
    )
    .run(releasedAt, scopeId, envelopeId, claimId);
  return requireSlackInboundEnvelope(scopeId, envelopeId);
}

export function listPendingSlackInboundEnvelopes(input: {
  scopeId: string;
  now?: number;
  limit?: number;
}): SlackInboundEnvelopeRecord[] {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const now = validTimestamp(input.now ?? Date.now(), "now");
  const limit = input.limit ?? SLACK_INBOUND_ENVELOPE_RECONCILE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM slack_inbound_envelopes
      WHERE scope_id = ?
        AND (
          state = 'accepted'
          OR (
            state = 'processing'
            AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
          )
        )
      ORDER BY accepted_at ASC, envelope_id ASC
      LIMIT ?
    `,
    )
    .all(scopeId, now, limit) as SlackInboundEnvelopeRow[];
  return rows.map(rowToSlackInboundEnvelope);
}

export function pruneProcessedSlackInboundEnvelopes(input: { scopeId: string; olderThan: number }): number {
  ensureSlackInboundInboxSchema();
  const scopeId = requireText(input.scopeId, "scopeId");
  const olderThan = validTimestamp(input.olderThan, "olderThan");
  return getDb()
    .prepare(
      `
      DELETE FROM slack_inbound_envelopes
      WHERE scope_id = ?
        AND state = 'processed'
        AND processed_at IS NOT NULL
        AND processed_at < ?
    `,
    )
    .run(scopeId, olderThan).changes;
}

export function getSlackInboundEnvelope(scopeId: string, envelopeId: string): SlackInboundEnvelopeRecord | null {
  ensureSlackInboundInboxSchema();
  const row = selectSlackInboundEnvelope(requireText(scopeId, "scopeId"), requireText(envelopeId, "envelopeId"));
  return row ? rowToSlackInboundEnvelope(row) : null;
}

function ensureSlackInboundInboxSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS slack_inbound_envelopes (
      scope_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'accepted'
        CHECK(state IN ('accepted', 'processing', 'processed')),
      claim_id TEXT,
      claim_expires_at INTEGER,
      accepted_at INTEGER NOT NULL,
      processed_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope_id, envelope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_inbound_envelopes_pending
      ON slack_inbound_envelopes(scope_id, state, claim_expires_at, accepted_at);
  `);
}

function selectSlackInboundEnvelope(scopeId: string, envelopeId: string): SlackInboundEnvelopeRow | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM slack_inbound_envelopes
      WHERE scope_id = ? AND envelope_id = ?
    `,
    )
    .get(scopeId, envelopeId) as SlackInboundEnvelopeRow | undefined;
}

function requireSlackInboundEnvelope(scopeId: string, envelopeId: string): SlackInboundEnvelopeRecord {
  const row = selectSlackInboundEnvelope(scopeId, envelopeId);
  if (!row) throw new Error(`Slack inbound envelope not found: ${envelopeId}`);
  return rowToSlackInboundEnvelope(row);
}

function rowToSlackInboundEnvelope(row: SlackInboundEnvelopeRow): SlackInboundEnvelopeRecord {
  const envelope = JSON.parse(row.envelope_json) as SlackSocketEnvelope;
  return {
    scopeId: row.scope_id,
    envelopeId: row.envelope_id,
    requestFingerprint: row.request_fingerprint,
    envelope,
    state: row.state,
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.claim_expires_at !== null ? { claimExpiresAt: row.claim_expires_at } : {}),
    acceptedAt: row.accepted_at,
    ...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
    updatedAt: row.updated_at,
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty control-free string of 512 characters or fewer`);
  }
  return normalized;
}

function validTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative Unix millisecond timestamp`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

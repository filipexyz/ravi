import { getDb } from "../router/router-db.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const CHANNEL_OUTBOUND_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS = 14 * DAY_MS;

export type ChannelOutboundReceiptState = "claimed" | "sent" | "persisted" | "complete";
export type ChannelOutboundReceiptErrorPhase =
  | "adapter_lookup"
  | "send"
  | "receipt_read"
  | "receipt_claim"
  | "receipt_write"
  | "canonical_persist"
  | "trace_record"
  | "telemetry_emit"
  | "receipt_complete";

export interface ChannelOutboundReceipt {
  idempotencyKey: string;
  requestFingerprint: string;
  jobId: string;
  requestId: string;
  sessionName: string;
  state: ChannelOutboundReceiptState;
  provider: string;
  deliveryMessageId?: string;
  platformMessageId?: string;
  providerTimestamp?: number;
  canonicalMessageId?: string;
  claimOwner?: string;
  claimExpiresAt?: number;
  sentAt?: number;
  persistedAt?: number;
  traceRecordedAt?: number;
  completedAt?: number;
  lastErrorPhase?: ChannelOutboundReceiptErrorPhase;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface ChannelOutboundReceiptRow {
  idempotency_key: string;
  request_fingerprint: string;
  job_id: string;
  request_id: string;
  session_name: string;
  state: ChannelOutboundReceiptState;
  provider: string;
  delivery_message_id: string | null;
  platform_message_id: string | null;
  provider_timestamp: number | null;
  canonical_message_id: string | null;
  claim_owner: string | null;
  claim_expires_at: number | null;
  sent_at: number | null;
  persisted_at: number | null;
  trace_recorded_at: number | null;
  completed_at: number | null;
  last_error_phase: ChannelOutboundReceiptErrorPhase | null;
  last_error_message: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ChannelOutboundClaimResult =
  | { status: "acquired"; receipt: ChannelOutboundReceipt }
  | { status: "busy"; receipt: ChannelOutboundReceipt }
  | { status: "existing"; receipt: ChannelOutboundReceipt }
  | { status: "conflict"; receipt: ChannelOutboundReceipt };

export interface ChannelOutboundReceiptStore {
  get(idempotencyKey: string): ChannelOutboundReceipt | null;
  claim(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    owner: string;
    jobId: string;
    requestId: string;
    sessionName: string;
    provider: string;
    now?: number;
    leaseMs?: number;
  }): ChannelOutboundClaimResult;
  releaseClaim(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    owner: string;
    error: string;
    releasedAt?: number;
  }): ChannelOutboundReceipt;
  recordSent(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    owner: string;
    provider: string;
    deliveryMessageId?: string;
    platformMessageId?: string;
    providerTimestamp?: number;
    sentAt: number;
  }): ChannelOutboundReceipt;
  markPersisted(
    idempotencyKey: string,
    input: { canonicalMessageId?: string; providerTimestamp?: number; persistedAt?: number },
  ): ChannelOutboundReceipt;
  markTraceRecorded(idempotencyKey: string, recordedAt?: number): ChannelOutboundReceipt;
  markComplete(idempotencyKey: string, completedAt?: number): ChannelOutboundReceipt;
  markTerminalError(
    idempotencyKey: string,
    phase: ChannelOutboundReceiptErrorPhase,
    message: string,
    completedAt?: number,
  ): ChannelOutboundReceipt;
  recordError(
    idempotencyKey: string,
    phase: ChannelOutboundReceiptErrorPhase,
    message: string,
    failedAt?: number,
  ): ChannelOutboundReceipt | null;
  pruneExpired(cutoff: number, now?: number): number;
}

export const sqliteChannelOutboundReceiptStore: ChannelOutboundReceiptStore = {
  get: getChannelOutboundReceipt,
  claim: claimChannelOutboundReceipt,
  releaseClaim: releaseChannelOutboundReceiptClaim,
  recordSent: recordChannelOutboundSent,
  markPersisted: markChannelOutboundReceiptPersisted,
  markTraceRecorded: markChannelOutboundReceiptTraceRecorded,
  markComplete: markChannelOutboundReceiptComplete,
  markTerminalError: markChannelOutboundReceiptTerminalError,
  recordError: recordChannelOutboundReceiptError,
  pruneExpired: pruneExpiredChannelOutboundReceipts,
};

export function getChannelOutboundReceipt(idempotencyKey: string): ChannelOutboundReceipt | null {
  const row = selectReceiptRow(requireText(idempotencyKey, "idempotencyKey"));
  return row ? rowToReceipt(row) : null;
}

export function claimChannelOutboundReceipt(input: {
  idempotencyKey: string;
  requestFingerprint: string;
  owner: string;
  jobId: string;
  requestId: string;
  sessionName: string;
  provider: string;
  now?: number;
  leaseMs?: number;
}): ChannelOutboundClaimResult {
  const database = getDb();
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const requestFingerprint = requireText(input.requestFingerprint, "requestFingerprint");
  const owner = requireText(input.owner, "owner");
  const now = finiteNumber(input.now) ?? Date.now();
  const leaseMs = finiteNumber(input.leaseMs) ?? CHANNEL_OUTBOUND_CLAIM_LEASE_MS;
  if (leaseMs <= 0) throw new Error("leaseMs must be greater than zero");
  const claimExpiresAt = now + leaseMs;

  return database.transaction((): ChannelOutboundClaimResult => {
    database
      .prepare(
        `INSERT OR IGNORE INTO channel_outbound_receipts (
           idempotency_key, request_fingerprint, job_id, request_id, session_name,
           state, provider, delivery_message_id, platform_message_id, provider_timestamp,
           canonical_message_id, claim_owner, claim_expires_at, sent_at, persisted_at,
           trace_recorded_at, completed_at, last_error_phase, last_error_message,
           last_error_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        idempotencyKey,
        requestFingerprint,
        requireText(input.jobId, "jobId"),
        requireText(input.requestId, "requestId"),
        requireText(input.sessionName, "sessionName"),
        requireText(input.provider, "provider"),
        owner,
        claimExpiresAt,
        now,
        now,
      );

    let receipt = requireReceipt(idempotencyKey);
    if (receipt.requestFingerprint !== requestFingerprint) {
      return { status: "conflict", receipt };
    }
    if (receipt.state !== "claimed") {
      return { status: "existing", receipt };
    }
    if (receipt.claimOwner === owner) {
      return { status: "acquired", receipt };
    }
    if (receipt.claimExpiresAt !== undefined && receipt.claimExpiresAt > now) {
      return { status: "busy", receipt };
    }

    const result = database
      .prepare(
        `UPDATE channel_outbound_receipts
         SET claim_owner = ?, claim_expires_at = ?, provider = ?,
             last_error_phase = NULL, last_error_message = NULL, last_error_at = NULL,
             updated_at = ?
         WHERE idempotency_key = ?
           AND request_fingerprint = ?
           AND state = 'claimed'
           AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      )
      .run(
        owner,
        claimExpiresAt,
        requireText(input.provider, "provider"),
        now,
        idempotencyKey,
        requestFingerprint,
        now,
      );
    receipt = requireReceipt(idempotencyKey);
    if (result.changes > 0 && receipt.claimOwner === owner) {
      return { status: "acquired", receipt };
    }
    if (receipt.requestFingerprint !== requestFingerprint) {
      return { status: "conflict", receipt };
    }
    return receipt.state === "claimed" ? { status: "busy", receipt } : { status: "existing", receipt };
  })();
}

export function releaseChannelOutboundReceiptClaim(input: {
  idempotencyKey: string;
  requestFingerprint: string;
  owner: string;
  error: string;
  releasedAt?: number;
}): ChannelOutboundReceipt {
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const releasedAt = finiteNumber(input.releasedAt) ?? Date.now();
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET claim_expires_at = ?, last_error_phase = 'send', last_error_message = ?,
           last_error_at = ?, updated_at = ?
       WHERE idempotency_key = ? AND request_fingerprint = ?
         AND state = 'claimed' AND claim_owner = ?`,
    )
    .run(
      releasedAt,
      requireText(input.error, "error"),
      releasedAt,
      releasedAt,
      idempotencyKey,
      requireText(input.requestFingerprint, "requestFingerprint"),
      requireText(input.owner, "owner"),
    );
  if (result.changes === 0) throw new Error(`Outbound receipt claim lost: ${idempotencyKey}`);
  return requireReceipt(idempotencyKey);
}

export function recordChannelOutboundSent(input: {
  idempotencyKey: string;
  requestFingerprint: string;
  owner: string;
  provider: string;
  deliveryMessageId?: string;
  platformMessageId?: string;
  providerTimestamp?: number;
  sentAt: number;
}): ChannelOutboundReceipt {
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const sentAt = finiteNumber(input.sentAt) ?? Date.now();
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET state = 'sent', provider = ?, delivery_message_id = ?, platform_message_id = ?,
           provider_timestamp = ?, sent_at = ?, claim_owner = NULL, claim_expires_at = NULL,
           last_error_phase = NULL, last_error_message = NULL, last_error_at = NULL,
           updated_at = ?
       WHERE idempotency_key = ? AND request_fingerprint = ?
         AND state = 'claimed' AND claim_owner = ?`,
    )
    .run(
      requireText(input.provider, "provider"),
      optionalText(input.deliveryMessageId),
      optionalText(input.platformMessageId),
      finiteNumber(input.providerTimestamp),
      sentAt,
      sentAt,
      idempotencyKey,
      requireText(input.requestFingerprint, "requestFingerprint"),
      requireText(input.owner, "owner"),
    );
  if (result.changes === 0) throw new Error(`Outbound receipt claim lost before sent receipt: ${idempotencyKey}`);
  return requireReceipt(idempotencyKey);
}

export function markChannelOutboundReceiptPersisted(
  idempotencyKey: string,
  input: { canonicalMessageId?: string; providerTimestamp?: number; persistedAt?: number },
): ChannelOutboundReceipt {
  const key = requireText(idempotencyKey, "idempotencyKey");
  const now = finiteNumber(input.persistedAt) ?? Date.now();
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET state = CASE WHEN state = 'complete' THEN state ELSE 'persisted' END,
           canonical_message_id = COALESCE(canonical_message_id, ?),
           provider_timestamp = COALESCE(provider_timestamp, ?),
           persisted_at = COALESCE(persisted_at, ?),
           last_error_phase = NULL,
           last_error_message = NULL,
           last_error_at = NULL,
           updated_at = ?
       WHERE idempotency_key = ? AND state IN ('sent', 'persisted', 'complete')`,
    )
    .run(optionalText(input.canonicalMessageId), finiteNumber(input.providerTimestamp), now, now, key);
  if (result.changes === 0) throw new Error(`Sent outbound receipt not found: ${key}`);
  return requireReceipt(key);
}

export function markChannelOutboundReceiptTraceRecorded(
  idempotencyKey: string,
  recordedAt = Date.now(),
): ChannelOutboundReceipt {
  const key = requireText(idempotencyKey, "idempotencyKey");
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET trace_recorded_at = COALESCE(trace_recorded_at, ?),
           last_error_phase = NULL,
           last_error_message = NULL,
           last_error_at = NULL,
           updated_at = ?
       WHERE idempotency_key = ? AND state IN ('persisted', 'complete')`,
    )
    .run(recordedAt, recordedAt, key);
  if (result.changes === 0) throw new Error(`Persisted outbound receipt not found: ${key}`);
  return requireReceipt(key);
}

export function markChannelOutboundReceiptComplete(
  idempotencyKey: string,
  completedAt = Date.now(),
): ChannelOutboundReceipt {
  const key = requireText(idempotencyKey, "idempotencyKey");
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET state = 'complete',
           completed_at = COALESCE(completed_at, ?),
           last_error_phase = NULL,
           last_error_message = NULL,
           last_error_at = NULL,
           updated_at = ?
       WHERE idempotency_key = ? AND state IN ('persisted', 'complete')`,
    )
    .run(completedAt, completedAt, key);
  if (result.changes === 0) throw new Error(`Persisted outbound receipt not found: ${key}`);
  return requireReceipt(key);
}

export function markChannelOutboundReceiptTerminalError(
  idempotencyKey: string,
  phase: ChannelOutboundReceiptErrorPhase,
  message: string,
  completedAt = Date.now(),
): ChannelOutboundReceipt {
  const key = requireText(idempotencyKey, "idempotencyKey");
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET state = 'complete',
           completed_at = COALESCE(completed_at, ?),
           last_error_phase = ?, last_error_message = ?, last_error_at = ?,
           updated_at = ?
       WHERE idempotency_key = ? AND state IN ('sent', 'complete')`,
    )
    .run(completedAt, phase, requireText(message, "message"), completedAt, completedAt, key);
  if (result.changes === 0) throw new Error(`Sent outbound receipt not found: ${key}`);
  return requireReceipt(key);
}

export function recordChannelOutboundReceiptError(
  idempotencyKey: string,
  phase: ChannelOutboundReceiptErrorPhase,
  message: string,
  failedAt = Date.now(),
): ChannelOutboundReceipt | null {
  const key = requireText(idempotencyKey, "idempotencyKey");
  getDb()
    .prepare(
      `UPDATE channel_outbound_receipts
       SET last_error_phase = ?, last_error_message = ?, last_error_at = ?, updated_at = ?
       WHERE idempotency_key = ?`,
    )
    .run(phase, requireText(message, "message"), failedAt, failedAt, key);
  return getChannelOutboundReceipt(key);
}

export function pruneExpiredChannelOutboundReceipts(cutoff: number, now = Date.now()): number {
  const normalizedCutoff = finiteNumber(cutoff);
  if (normalizedCutoff === null) throw new Error("cutoff must be a finite number");
  const normalizedNow = finiteNumber(now);
  if (normalizedNow === null) throw new Error("now must be a finite number");
  return getDb()
    .prepare(
      `DELETE FROM channel_outbound_receipts
       WHERE updated_at <= ?
         AND NOT (state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at > ?)`,
    )
    .run(normalizedCutoff, normalizedNow).changes;
}

function selectReceiptRow(idempotencyKey: string): ChannelOutboundReceiptRow | null {
  return (
    (getDb().prepare("SELECT * FROM channel_outbound_receipts WHERE idempotency_key = ?").get(idempotencyKey) as
      | ChannelOutboundReceiptRow
      | undefined) ?? null
  );
}

function requireReceipt(idempotencyKey: string): ChannelOutboundReceipt {
  const row = selectReceiptRow(idempotencyKey);
  if (!row) throw new Error(`Outbound receipt not found: ${idempotencyKey}`);
  return rowToReceipt(row);
}

function rowToReceipt(row: ChannelOutboundReceiptRow): ChannelOutboundReceipt {
  return {
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    jobId: row.job_id,
    requestId: row.request_id,
    sessionName: row.session_name,
    state: row.state,
    provider: row.provider,
    ...(row.delivery_message_id ? { deliveryMessageId: row.delivery_message_id } : {}),
    ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
    ...(row.provider_timestamp !== null ? { providerTimestamp: row.provider_timestamp } : {}),
    ...(row.canonical_message_id ? { canonicalMessageId: row.canonical_message_id } : {}),
    ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
    ...(row.claim_expires_at !== null ? { claimExpiresAt: row.claim_expires_at } : {}),
    ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
    ...(row.persisted_at !== null ? { persistedAt: row.persisted_at } : {}),
    ...(row.trace_recorded_at !== null ? { traceRecordedAt: row.trace_recorded_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.last_error_phase ? { lastErrorPhase: row.last_error_phase } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    ...(row.last_error_at !== null ? { lastErrorAt: row.last_error_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function optionalText(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireText(value: string, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function finiteNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { initializeStateSchema } from "../db/schema-owner.js";
import { getDb } from "../router/router-db.js";
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { errorDiagnostic } from "../utils/error-diagnostic.js";
import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import { CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS } from "./outbound-receipts.js";
import { type ChannelOutboundJob, publishChannelOutboundJob } from "./outbound-stream.js";
import { isProviderUnavailableChatText } from "../runtime/public-failure.js";
import { channelOutputHandoffTransientCode, type ChannelOutputHandoffTransientCode } from "./output-handoff.js";

const log = logger.child("channels:outbound-publish-outbox");

export const CHANNEL_OUTBOUND_PUBLISH_RETRY_BASE_MS = 30_000;
export const CHANNEL_OUTBOUND_PUBLISH_RETRY_MAX_MS = 5 * 60_000;
export const CHANNEL_OUTBOUND_PUBLISH_RECONCILE_INTERVAL_MS = 30_000;
export const CHANNEL_OUTBOUND_PUBLISH_RECONCILE_LIMIT = 25;
export const CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS = CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS;

export type ChannelOutboundPublishStatus = "pending" | "published" | "suppressed";

interface ChannelOutboundPublishMetadata {
  idempotencyKey: string;
  requestFingerprint: string;
  jobId: string;
  sessionName: string;
  channelId: string;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  publishedAt?: number;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelOutboundActivePublishRecord extends ChannelOutboundPublishMetadata {
  status: "pending" | "published";
  job: ChannelOutboundJob;
}

/** Permanent compact identity: suppression never requires retaining message content. */
export interface ChannelOutboundSuppressedPublishRecord extends ChannelOutboundPublishMetadata {
  status: "suppressed";
  suppressionReason: string;
}

export type ChannelOutboundPublishRecord = ChannelOutboundActivePublishRecord | ChannelOutboundSuppressedPublishRecord;

export interface ChannelOutboundPublishOutboxSummary {
  pendingCount: number;
  oldestPendingAt?: number;
  nextAttemptAt?: number;
  lastPublishedAt?: number;
  lastError?: {
    message: string;
    at: number;
  };
}

interface ChannelOutboundPublishRow {
  idempotency_key: string;
  request_fingerprint: string;
  job_id: string;
  session_name: string;
  channel_id: string;
  status: ChannelOutboundPublishStatus;
  payload_json: string;
  attempt_count: number;
  next_attempt_at: number;
  last_error_message: string | null;
  last_error_at: number | null;
  published_at: number | null;
  superseded_by: string | null;
  suppression_reason: string | null;
  created_at: number;
  updated_at: number;
}

type ChannelOutboundSuppressionRow = Pick<
  ChannelOutboundPublishRow,
  | "idempotency_key"
  | "request_fingerprint"
  | "job_id"
  | "session_name"
  | "channel_id"
  | "attempt_count"
  | "published_at"
  | "suppression_reason"
  | "created_at"
  | "updated_at"
>;

/**
 * Delivery destination of a provider-unavailable notice. Coalescing must never
 * collapse notices headed to different destinations (different Slack account,
 * instance, chat or thread), so the whole destination is part of the key.
 */
export interface ChannelOutboundNoticeScope {
  channelId: string;
  accountId: string;
  instanceId: string | null;
  targetChatId: string;
  targetThreadId: string | null;
}

export type ChannelOutboundPublisher = (job: ChannelOutboundJob) => Promise<void>;

/**
 * Internal prepared-job evidence. The driver adds its frozen output/binding
 * identity before crossing a process boundary. No disposition grants authority
 * to retry: only finished absence with a closed SQLite code is a candidate.
 */
export type ChannelOutboundPublishHandoffFailure = {
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly operationFinished: true;
} & (
  | { readonly disposition: "finished_pre_save_missing"; readonly code: ChannelOutputHandoffTransientCode }
  | { readonly disposition: "conflict"; readonly code: "REQUEST_FINGERPRINT_CONFLICT" }
  | { readonly disposition: "unknown"; readonly code: "OUTBOX_SAVE_FAILED" | "OUTBOX_READBACK_FAILED" }
);

/** Immutable, sanitized failure of a completed synchronous publication save. */
export class ChannelOutboundPublishHandoffError extends Error {
  readonly evidence: ChannelOutboundPublishHandoffFailure;

  constructor(evidence: ChannelOutboundPublishHandoffFailure, options?: ErrorOptions) {
    super(`Channel outbound publish ${evidence.disposition}: ${evidence.code}`, options);
    this.name = "ChannelOutboundPublishHandoffError";
    this.evidence = Object.freeze({ ...evidence });
  }
}

/**
 * Every returned result already confirms durable ownership, even when queue
 * publication/bookkeeping failed. No result proves platform delivery. A saved
 * record remains positive proof if a later readback is unavailable; that fallback
 * sets bookkeepingUncertain instead of claiming the latest state was observed.
 */
export type ChannelOutboundPublishResult =
  | {
      ok: true;
      disposition: "published";
      record: ChannelOutboundActivePublishRecord;
      publishedNow: boolean;
    }
  | {
      ok: true;
      disposition: "suppressed";
      record: ChannelOutboundSuppressedPublishRecord;
      publishedNow: false;
    }
  | {
      ok: false;
      disposition: "deferred";
      record: ChannelOutboundActivePublishRecord;
      error: unknown;
      nextAttemptAt: number;
      bookkeepingUncertain?: true;
    };

export interface ChannelOutboundPublishOutboxStore {
  /** Synchronous and finished on return/throw; implementations must not schedule a later save. */
  save(job: ChannelOutboundJob, now?: number): ChannelOutboundPublishRecord;
  get(idempotencyKey: string): ChannelOutboundPublishRecord | null;
  listDue(options?: { now?: number; limit?: number }): ChannelOutboundPublishRecord[];
  markPublished(idempotencyKey: string, publishedAt?: number): ChannelOutboundPublishRecord;
  markSuppressed(idempotencyKey: string, reason: string, suppressedAt?: number): ChannelOutboundPublishRecord;
  recordFailure(idempotencyKey: string, error: unknown, failedAt?: number): ChannelOutboundPublishRecord;
  supersede(idempotencyKey: string, supersededBy: string, supersededAt?: number): ChannelOutboundPublishRecord;
  listPendingNoticeCandidates(scope: ChannelOutboundNoticeScope, limit?: number): ChannelOutboundPublishRecord[];
  prunePublished(cutoff: number, now?: number): number;
  summary(now?: number): ChannelOutboundPublishOutboxSummary;
}

export const sqliteChannelOutboundPublishOutboxStore: ChannelOutboundPublishOutboxStore = {
  save: saveChannelOutboundPublishJob,
  get: getChannelOutboundPublishJob,
  listDue: listDueChannelOutboundPublishJobs,
  markPublished: markChannelOutboundPublishJobPublished,
  markSuppressed: markChannelOutboundPublishJobSuppressed,
  recordFailure: recordChannelOutboundPublishJobFailure,
  supersede: markChannelOutboundPublishJobSuperseded,
  listPendingNoticeCandidates: listPendingNoticeCandidates,
  prunePublished: prunePublishedChannelOutboundPublishJobs,
  summary: getChannelOutboundPublishOutboxSummary,
};

/**
 * Saves a pending publication in an IMMEDIATE transaction, checking permanent
 * suppression before inserting payload. Reusing a key with the same request
 * fingerprint preserves its disposition; a different fingerprint throws.
 * A suppressed identity therefore cannot regain content or become pending.
 */
export function saveChannelOutboundPublishJob(job: ChannelOutboundJob, now = Date.now()): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(job.request.idempotencyKey, "idempotencyKey");
  const payloadJson = JSON.stringify(job);
  const requestFingerprint = channelOutboundPublishRequestFingerprint(job);
  const database = getDb();

  return database
    .transaction(() => {
      const suppressed = selectChannelOutboundSuppression(key);
      if (suppressed) {
        if (suppressed.request_fingerprint !== requestFingerprint) {
          throw outboundPublishConflict(key, requestFingerprint);
        }
        return rowToSuppressedPublishRecord(suppressed);
      }
      database
        .prepare(
          `INSERT OR IGNORE INTO channel_outbound_publish_jobs (
           idempotency_key, request_fingerprint, job_id, session_name, channel_id,
           status, payload_json, attempt_count, next_attempt_at, last_error_message,
           last_error_at, published_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          key,
          requestFingerprint,
          requireText(job.jobId, "jobId"),
          requireText(job.request.origin.sessionName, "sessionName"),
          requireText(job.request.channelId, "channelId"),
          payloadJson,
          now,
          now,
        );

      const record = requireChannelOutboundPublishJob(key);
      if (record.requestFingerprint !== requestFingerprint) {
        throw outboundPublishConflict(key, requestFingerprint);
      }
      return record;
    })
    .immediate();
}

/**
 * Looks up publication state, preferring its permanent suppression tombstone.
 * Suppressed results deliberately have no job payload; absence returns null.
 * Neither an active record nor its publication status confirms provider delivery.
 */
export function getChannelOutboundPublishJob(idempotencyKey: string): ChannelOutboundPublishRecord | null {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const suppressed = selectChannelOutboundSuppression(key);
  if (suppressed) return rowToSuppressedPublishRecord(suppressed);
  const row = selectChannelOutboundPublishRow(key);
  return row ? rowToPublishRecord(row) : null;
}

export function listDueChannelOutboundPublishJobs(
  options: { now?: number; limit?: number } = {},
): ChannelOutboundPublishRecord[] {
  ensureChannelOutboundPublishOutboxSchema();
  const now = finiteNumber(options.now) ?? Date.now();
  const limit = Math.max(
    1,
    Math.min(Math.trunc(finiteNumber(options.limit) ?? CHANNEL_OUTBOUND_PUBLISH_RECONCILE_LIMIT), 100),
  );
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM channel_outbound_publish_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ?`,
    )
    .all(now, limit) as ChannelOutboundPublishRow[];
  return rows.map(rowToPublishRecord);
}

/**
 * Records publisher success without reopening a suppressed identity or
 * replacing its first published timestamp. Returns current state, which may
 * already be suppressed by a competing consumer; this is not a send receipt.
 */
export function markChannelOutboundPublishJobPublished(
  idempotencyKey: string,
  publishedAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const now = finiteNumber(publishedAt) ?? Date.now();
  getDb()
    .prepare(
      `UPDATE channel_outbound_publish_jobs
          SET status = 'published',
              published_at = COALESCE(published_at, ?),
              last_error_message = NULL,
              last_error_at = NULL,
              updated_at = ?
        WHERE idempotency_key = ? AND status != 'suppressed'`,
    )
    .run(now, now, key);
  return requireChannelOutboundPublishJob(key);
}

/**
 * Updates the publication and copies its compact suppression tombstone in one
 * IMMEDIATE transaction. Replays preserve the original terminal reason and
 * prior publication timing. Suppression does not prove the absence of an
 * earlier publish, nor cancel a publisher that already holds a pending snapshot.
 */
export function markChannelOutboundPublishJobSuppressed(
  idempotencyKey: string,
  reason: string,
  suppressedAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const normalizedReason = requireText(reason, "reason");
  const at = finiteNumber(suppressedAt) ?? Date.now();
  const database = getDb();
  return database
    .transaction(() => {
      const existing = requireChannelOutboundPublishJob(key);
      if (existing.status === "suppressed") return existing;
      database
        .prepare(
          `UPDATE channel_outbound_publish_jobs
         SET status = 'suppressed', suppression_reason = ?, next_attempt_at = 0, updated_at = ?
         WHERE idempotency_key = ? AND status != 'suppressed'`,
        )
        .run(normalizedReason, at, key);
      database.prepare(`${COPY_SUPPRESSION_TOMBSTONES_SQL} AND idempotency_key = ?`).run(key);
      return requireChannelOutboundPublishJob(key);
    })
    .immediate();
}

/**
 * Records an error and the next backoff only while the publication is pending.
 * Published/suppressed state wins over this update, including races; callers
 * must inspect the returned status before assuming a retry was scheduled.
 */
export function recordChannelOutboundPublishJobFailure(
  idempotencyKey: string,
  error: unknown,
  failedAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const existing = requireChannelOutboundPublishJob(key);
  if (existing.status !== "pending") return existing;
  const now = finiteNumber(failedAt) ?? Date.now();
  const attemptCount = existing.attemptCount + 1;
  const nextAttemptAt = now + channelOutboundPublishRetryDelayMs(attemptCount);
  getDb()
    .prepare(
      `UPDATE channel_outbound_publish_jobs
          SET status = 'pending',
              attempt_count = ?,
              next_attempt_at = ?,
              last_error_message = ?,
              last_error_at = ?,
              updated_at = ?
        WHERE idempotency_key = ?
          AND status = 'pending'`,
    )
    .run(attemptCount, nextAttemptAt, errorMessage(error), now, now, key);
  return requireChannelOutboundPublishJob(key);
}

/**
 * Discards a pending job whose chat text is an exact duplicate of the failure
 * notice already queued for the same (channel, chat, text). The row is closed as
 * `published` so it stops retrying and follows the published-row retention, but
 * it records `supersededBy` so the ledger never pretends it delivered a message.
 */
export function markChannelOutboundPublishJobSuperseded(
  idempotencyKey: string,
  supersededBy: string,
  supersededAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const supersededByKey = requireText(supersededBy, "supersededBy");
  const now = finiteNumber(supersededAt) ?? Date.now();
  getDb()
    .prepare(
      `UPDATE channel_outbound_publish_jobs
          SET status = 'published',
              published_at = COALESCE(published_at, ?),
              superseded_by = ?,
              last_error_message = NULL,
              last_error_at = NULL,
              updated_at = ?
        WHERE idempotency_key = ?
          AND status = 'pending'`,
    )
    .run(now, supersededByKey, now, key);
  return requireChannelOutboundPublishJob(key);
}

/**
 * Every pending job in the same delivery scope, whether or not it is due yet.
 * Callers re-check the notice eligibility themselves (text content) and close
 * the duplicates they find, so a backlog larger than one reconciliation batch
 * cannot keep publishing one extra copy per tick.
 */
export function listPendingNoticeCandidates(
  scope: ChannelOutboundNoticeScope,
  limit = 1000,
): ChannelOutboundPublishRecord[] {
  ensureChannelOutboundPublishOutboxSchema();
  const boundedLimit = Math.max(1, Math.min(Math.trunc(finiteNumber(limit) ?? 1000), 10_000));
  const rows = getDb()
    .prepare(
      `SELECT *
         FROM channel_outbound_publish_jobs
        WHERE status = 'pending'
          AND channel_id = ?
          AND json_extract(payload_json, '$.request.accountId') = ?
          AND json_extract(payload_json, '$.request.instanceId') IS ?
          AND json_extract(payload_json, '$.request.targetChatId') = ?
          AND json_extract(payload_json, '$.request.targetThreadId') IS ?
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ?`,
    )
    .all(
      scope.channelId,
      scope.accountId,
      scope.instanceId,
      scope.targetChatId,
      scope.targetThreadId,
      boundedLimit,
    ) as ChannelOutboundPublishRow[];
  return rows.map(rowToPublishRecord);
}

export function getChannelOutboundPublishOutboxSummary(_now = Date.now()): ChannelOutboundPublishOutboxSummary {
  ensureChannelOutboundPublishOutboxSchema();
  const row = getDb()
    .prepare(
      `SELECT COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
              MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at,
              MIN(CASE WHEN status = 'pending' THEN next_attempt_at END) AS next_attempt_at,
              MAX(published_at) AS last_published_at
         FROM channel_outbound_publish_jobs`,
    )
    .get() as {
    pending_count: number;
    oldest_pending_at: number | null;
    next_attempt_at: number | null;
    last_published_at: number | null;
  };
  const errorRow = getDb()
    .prepare(
      `SELECT last_error_message, last_error_at
         FROM channel_outbound_publish_jobs
        WHERE last_error_at IS NOT NULL
        ORDER BY last_error_at DESC
        LIMIT 1`,
    )
    .get() as { last_error_message: string | null; last_error_at: number | null } | undefined;

  return {
    pendingCount: Number(row?.pending_count ?? 0),
    ...(row?.oldest_pending_at !== null && row?.oldest_pending_at !== undefined
      ? { oldestPendingAt: row.oldest_pending_at }
      : {}),
    ...(row?.next_attempt_at !== null && row?.next_attempt_at !== undefined
      ? { nextAttemptAt: row.next_attempt_at }
      : {}),
    ...(row?.last_published_at !== null && row?.last_published_at !== undefined
      ? { lastPublishedAt: row.last_published_at }
      : {}),
    ...(errorRow?.last_error_at !== null && errorRow?.last_error_at !== undefined
      ? { lastError: { message: errorRow.last_error_message ?? "unknown publish error", at: errorRow.last_error_at } }
      : {}),
  };
}

/**
 * Prunes payload rows by publishedAt for published jobs, or updatedAt for
 * suppressed jobs only when a same-fingerprint compact tombstone exists.
 * Never deletes those terminal tombstones. Rejects nonfinite/future cutoffs
 * and returns the number of payload rows removed.
 */
export function prunePublishedChannelOutboundPublishJobs(cutoff: number, now = Date.now()): number {
  ensureChannelOutboundPublishOutboxSchema();
  const normalizedCutoff = finiteNumber(cutoff);
  if (normalizedCutoff === null) throw new Error("cutoff must be a finite number");
  const normalizedNow = finiteNumber(now);
  if (normalizedNow === null) throw new Error("now must be a finite number");
  if (normalizedCutoff > normalizedNow) throw new Error("cutoff must not be in the future");
  return getDb()
    .prepare(
      `DELETE FROM channel_outbound_publish_jobs
       WHERE (status = 'published' AND published_at IS NOT NULL AND published_at <= ?)
          OR (status = 'suppressed' AND updated_at <= ? AND EXISTS (
            SELECT 1 FROM channel_outbound_publish_suppressions AS suppression
            WHERE suppression.idempotency_key = channel_outbound_publish_jobs.idempotency_key
              AND suppression.request_fingerprint = channel_outbound_publish_jobs.request_fingerprint
          ))`,
    )
    .run(normalizedCutoff, normalizedCutoff).changes;
}

/**
 * Saves before publishing. A throwing synchronous save is read back by immutable
 * key/request fingerprint: a matching row/tombstone confirms handoff WITHOUT
 * another publish, conflict is permanent, and missing permits typed pre-save
 * evidence only for a closed SQLite lock code. Unknown readback never authorizes
 * another save. Request hashes exclude volatile job timestamps.
 *
 * Once save is confirmed, host handoff is irrevocable. Publisher, markPublished,
 * failure-bookkeeping and later readback errors resolve deferred (or a confirmed
 * terminal disposition); the existing reconciler owns all further work. Saved
 * proof survives unavailable bookkeeping, without inventing publication/sent or
 * reopening suppression/coalescing. There is no new retry loop or Slack ACK.
 */
export async function publishChannelOutboundJobDurably(
  job: ChannelOutboundJob,
  options: {
    store?: ChannelOutboundPublishOutboxStore;
    publisher?: ChannelOutboundPublisher;
    now?: () => number;
  } = {},
): Promise<ChannelOutboundPublishResult> {
  const store = options.store ?? sqliteChannelOutboundPublishOutboxStore;
  const now = options.now ?? Date.now;
  const key = requireText(job.request.idempotencyKey, "idempotencyKey");
  const requestFingerprint = channelOutboundPublishRequestFingerprint(job);
  const saveAt = now();
  let saved: ChannelOutboundPublishRecord;
  try {
    saved = store.save(job, saveAt);
  } catch (error) {
    let existing: ChannelOutboundPublishRecord | null;
    try {
      existing = store.get(key);
    } catch (readbackError) {
      const cause = new Error(errorDiagnostic(readbackError, { operation: "outbound_publish_save_readback" }).cause, {
        cause: error,
      });
      // A typed immutable conflict remains permanent even if readback fails.
      if (error instanceof ChannelOutboundPublishHandoffError && error.evidence.disposition === "conflict") {
        throw outboundPublishConflict(key, requestFingerprint, cause);
      }
      throw new ChannelOutboundPublishHandoffError(
        {
          disposition: "unknown",
          code: "OUTBOX_READBACK_FAILED",
          idempotencyKey: key,
          requestFingerprint,
          operationFinished: true,
        },
        { cause },
      );
    }
    if (existing !== null) {
      requireMatchingPublishRecord(existing, job, requestFingerprint);
      return confirmedPublishResult(existing, error);
    }
    if (error instanceof ChannelOutboundPublishHandoffError && error.evidence.disposition === "conflict") {
      throw outboundPublishConflict(key, requestFingerprint, error);
    }
    const code = channelOutputHandoffTransientCode(error);
    throw new ChannelOutboundPublishHandoffError(
      code
        ? {
            disposition: "finished_pre_save_missing",
            code,
            idempotencyKey: key,
            requestFingerprint,
            operationFinished: true,
          }
        : {
            disposition: "unknown",
            code: "OUTBOX_SAVE_FAILED",
            idempotencyKey: key,
            requestFingerprint,
            operationFinished: true,
          },
      { cause: error },
    );
  }
  requireMatchingPublishRecord(saved, job, requestFingerprint);
  if (saved.status === "suppressed") {
    return { ok: true, disposition: "suppressed", record: saved, publishedNow: false };
  }
  if (saved.status === "published") {
    return { ok: true, disposition: "published", record: saved, publishedNow: false };
  }

  try {
    await (options.publisher ?? publishChannelOutboundJob)(saved.job);
    const published = store.markPublished(saved.idempotencyKey, now());
    requireMatchingPublishRecord(published, job, requestFingerprint);
    if (published.status === "suppressed") {
      return { ok: true, disposition: "suppressed", record: published, publishedNow: false };
    }
    if (published.status === "published") {
      return { ok: true, disposition: "published", record: published, publishedNow: !published.supersededBy };
    }
    return confirmedPublishResult(published, new Error("Channel outbound publication bookkeeping is pending"));
  } catch (error) {
    try {
      const failed = store.recordFailure(saved.idempotencyKey, error, now());
      requireMatchingPublishRecord(failed, job, requestFingerprint);
      return confirmedPublishResult(failed, error);
    } catch (bookkeepingError) {
      reportErrorDiagnostic(log, "Channel outbound publication failure bookkeeping failed", bookkeepingError, {
        operation: "outbound_publish_failure_bookkeeping",
      });
      try {
        const current = store.get(saved.idempotencyKey);
        if (current !== null) {
          requireMatchingPublishRecord(current, job, requestFingerprint);
          return confirmedPublishResult(current, error);
        }
      } catch (readbackError) {
        // Retain the original positive save proof, never retry from the host.
        reportErrorDiagnostic(log, "Channel outbound publication readback failed after save", readbackError, {
          operation: "outbound_publish_saved_readback",
        });
      }
      return confirmedPublishResult(saved, error, true);
    }
  }
}

/** Creates permanent conflict evidence without including stored/request content. */
function outboundPublishConflict(
  idempotencyKey: string,
  requestFingerprint: string,
  cause?: unknown,
): ChannelOutboundPublishHandoffError {
  return new ChannelOutboundPublishHandoffError(
    {
      disposition: "conflict",
      code: "REQUEST_FINGERPRINT_CONFLICT",
      idempotencyKey,
      requestFingerprint,
      operationFinished: true,
    },
    { cause },
  );
}

/**
 * Matches compact terminal identity as well as active payload when available.
 * The immutable request includes native destination and canonical provenance;
 * wrapper creation/update timestamps intentionally do not participate.
 */
function requireMatchingPublishRecord(
  record: ChannelOutboundPublishRecord,
  job: ChannelOutboundJob,
  requestFingerprint: string,
): void {
  if (
    record.idempotencyKey !== job.request.idempotencyKey ||
    record.requestFingerprint !== requestFingerprint ||
    record.sessionName !== job.request.origin.sessionName ||
    record.channelId !== job.request.channelId ||
    (record.status !== "suppressed" && channelOutboundPublishRequestFingerprint(record.job) !== requestFingerprint)
  ) {
    throw outboundPublishConflict(job.request.idempotencyKey, requestFingerprint);
  }
}

/** Reports durable ownership while preserving terminal suppression/coalescing. */
function confirmedPublishResult(
  record: ChannelOutboundPublishRecord,
  error: unknown,
  bookkeepingUncertain = false,
): ChannelOutboundPublishResult {
  if (record.status === "suppressed") {
    return { ok: true, disposition: "suppressed", record, publishedNow: false };
  }
  if (record.status === "published") {
    return { ok: true, disposition: "published", record, publishedNow: false };
  }
  return {
    ok: false,
    disposition: "deferred",
    record,
    error,
    nextAttemptAt: record.nextAttemptAt,
    ...(bookkeepingUncertain ? { bookkeepingUncertain: true as const } : {}),
  };
}

/**
 * Publishes a bounded due batch and records retry backoff on failure. Coalesces
 * only recognized provider-unavailable notices sharing the full destination,
 * checking bounded backlog candidates outside the due batch as well.
 * Suppression is rechecked around publishing, but this is not a publisher lock:
 * competing calls can overlap. `attempted` counts selected candidates, including
 * ones later skipped as suppressed, rather than actual publisher invocations.
 */
export async function reconcileDueChannelOutboundPublishes(
  options: {
    store?: ChannelOutboundPublishOutboxStore;
    publisher?: ChannelOutboundPublisher;
    emitEvent?: typeof nats.emit;
    now?: () => number;
    limit?: number;
  } = {},
): Promise<{ attempted: number; published: number; failed: number; coalesced: number }> {
  const store = options.store ?? sqliteChannelOutboundPublishOutboxStore;
  const now = options.now ?? Date.now;
  const due = store.listDue({ now: now(), limit: options.limit });
  let published = 0;
  let failed = 0;
  let coalesced = 0;

  // A provider outage queues the same failure notice over and over. When the
  // link recovers the outbox used to deliver every copy in one burst. Keep the
  // earliest pending copy per delivery destination and discard the rest. This
  // only ever applies to the mapped provider-transport notice text, never to
  // arbitrary chat messages.
  const keepByCoalesceKey = new Map<string, { idempotencyKey: string; scope: ChannelOutboundNoticeScope }>();
  const candidates: ChannelOutboundActivePublishRecord[] = [];
  for (const record of due) {
    if (record.status !== "pending") continue;
    const scope = coalescibleProviderUnavailableScope(record.job);
    if (scope === null) {
      candidates.push(record);
      continue;
    }
    const scopeKey = noticeScopeKey(scope);
    const kept = keepByCoalesceKey.get(scopeKey);
    if (kept === undefined) {
      keepByCoalesceKey.set(scopeKey, { idempotencyKey: record.idempotencyKey, scope });
      candidates.push(record);
      continue;
    }
    store.supersede(record.idempotencyKey, kept.idempotencyKey, now());
    coalesced++;
    log.info("Discarded duplicate provider-unavailable publish from a burst", {
      jobId: record.jobId,
      keptIdempotencyKey: kept.idempotencyKey,
    });
  }

  // The due batch is capped (listDue limit), so a backlog larger than one batch
  // would still publish one extra copy per tick. Close the matching duplicates
  // that sit beyond this batch as well; publishing work stays capped because
  // only the due batch is ever delivered.
  for (const kept of keepByCoalesceKey.values()) {
    for (const backlogRecord of store.listPendingNoticeCandidates(kept.scope)) {
      if (backlogRecord.status !== "pending") continue;
      if (backlogRecord.idempotencyKey === kept.idempotencyKey) continue;
      const backlogScope = coalescibleProviderUnavailableScope(backlogRecord.job);
      if (backlogScope === null || noticeScopeKey(backlogScope) !== noticeScopeKey(kept.scope)) continue;
      store.supersede(backlogRecord.idempotencyKey, kept.idempotencyKey, now());
      coalesced++;
      log.info("Discarded provider-unavailable publish beyond the due batch", {
        jobId: backlogRecord.jobId,
        keptIdempotencyKey: kept.idempotencyKey,
      });
    }
  }

  for (const record of candidates) {
    try {
      // A consumer may have terminally suppressed a previously published copy
      // while this reconciler held an older pending snapshot.
      if (store.get(record.idempotencyKey)?.status === "suppressed") continue;
      await (options.publisher ?? publishChannelOutboundJob)(record.job);
      const updated = store.markPublished(record.idempotencyKey, now());
      if (updated.status === "suppressed") continue;
      published++;
      await emitQueuedDelivery(updated.job, options.emitEvent ?? nats.emit, "native_channel_outbound_reconciled").catch(
        (error) => {
          log.warn("Failed to emit reconciled native outbound queued delivery", {
            jobId: updated.jobId,
            error,
          });
        },
      );
    } catch (error) {
      const updated = store.recordFailure(record.idempotencyKey, error, now());
      if (updated.status === "suppressed") continue;
      failed++;
      log.warn("Deferred channel outbound publish; will retry", {
        jobId: updated.jobId,
        attemptCount: updated.attemptCount,
        nextAttemptAt: updated.nextAttemptAt,
        error,
      });
    }
  }

  return { attempted: candidates.length, published, failed, coalesced };
}

export class ChannelOutboundPublishReconciler {
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      store?: ChannelOutboundPublishOutboxStore;
      publisher?: ChannelOutboundPublisher;
      emitEvent?: typeof nats.emit;
      isRunning?: () => boolean;
      intervalMs?: number;
      limit?: number;
      now?: () => number;
    } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise?.catch((error) => {
      log.debug("Channel outbound publish reconciler stopped after loop error", { error });
    });
    this.loopPromise = null;
  }

  status(): ChannelOutboundPublishOutboxSummary {
    return (this.options.store ?? sqliteChannelOutboundPublishOutboxStore).summary(this.options.now?.() ?? Date.now());
  }

  private shouldContinue(): boolean {
    return this.running && (this.options.isRunning?.() ?? true);
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.options.intervalMs ?? CHANNEL_OUTBOUND_PUBLISH_RECONCILE_INTERVAL_MS;
    while (this.shouldContinue()) {
      try {
        await reconcileDueChannelOutboundPublishes(this.options);
      } catch (error) {
        log.warn("Channel outbound publish reconcile loop failed; retrying", { error });
      }
      await delayWhileRunning(intervalMs, () => this.shouldContinue());
    }
  }
}

export function channelOutboundPublishRetryDelayMs(attemptCount: number): number {
  const attempt =
    typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const exponent = Math.min(attempt - 1, 4);
  return Math.min(CHANNEL_OUTBOUND_PUBLISH_RETRY_BASE_MS * 2 ** exponent, CHANNEL_OUTBOUND_PUBLISH_RETRY_MAX_MS);
}

const COPY_SUPPRESSION_TOMBSTONES_SQL = `
  INSERT OR IGNORE INTO channel_outbound_publish_suppressions
    (idempotency_key, request_fingerprint, job_id, session_name, channel_id,
     attempt_count, published_at, suppression_reason, created_at, updated_at)
  SELECT idempotency_key, request_fingerprint, job_id, session_name, channel_id,
         attempt_count, published_at, COALESCE(suppression_reason, 'outbound_policy'), created_at, updated_at
  FROM channel_outbound_publish_jobs WHERE status = 'suppressed'`;

/**
 * Acquires an IMMEDIATE lock before inspecting/upgrading the schema; the local
 * table-creation helper shares that transaction. Backfills compact tombstones
 * before suppressed payloads become eligible for pruning. Caches initialization
 * per database object only after commit, and rolls back a failed upgrade.
 * Channels only validates the daemon's same-release marker and never upgrades.
 */
export function ensureChannelOutboundPublishOutboxSchema(database: Database = getDb()): void {
  initializeStateSchema(database, "channel-outbound-publish", () => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_outbound_publish_jobs'")
        .get() as { sql: string } | undefined;
      const createTable = (table: "channel_outbound_publish_jobs" | "channel_outbound_publish_jobs_next") => {
        database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        idempotency_key TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        job_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','published','suppressed')),
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error_message TEXT,
        last_error_at INTEGER,
        published_at INTEGER,
        superseded_by TEXT,
        suppression_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      };
      if (!current) {
        createTable("channel_outbound_publish_jobs");
      } else if (!current.sql.includes("'suppressed'")) {
        const columns = new Set(
          (database.prepare("PRAGMA table_info(channel_outbound_publish_jobs)").all() as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        );
        const common =
          "idempotency_key, request_fingerprint, job_id, session_name, channel_id, status, payload_json, attempt_count, next_attempt_at, last_error_message, last_error_at, published_at, created_at, updated_at";
        createTable("channel_outbound_publish_jobs_next");
        database.exec(`INSERT INTO channel_outbound_publish_jobs_next (${common}, superseded_by)
        SELECT ${common}, ${columns.has("superseded_by") ? "superseded_by" : "NULL"} FROM channel_outbound_publish_jobs`);
        database.exec("DROP TABLE channel_outbound_publish_jobs");
        database.exec("ALTER TABLE channel_outbound_publish_jobs_next RENAME TO channel_outbound_publish_jobs");
      }
      database.exec(`
      CREATE TABLE IF NOT EXISTS channel_outbound_publish_suppressions (
        idempotency_key TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        job_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        published_at INTEGER,
        suppression_reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_status_next
        ON channel_outbound_publish_jobs(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_published_retention
        ON channel_outbound_publish_jobs(status, published_at);
      CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_error
        ON channel_outbound_publish_jobs(last_error_at);
    `);
      // Upgrade any already-suppressed rows before their content becomes eligible
      // for retention cleanup. Tombstones intentionally have no age-based prune.
      database.exec(COPY_SUPPRESSION_TOMBSTONES_SQL);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

function selectChannelOutboundPublishRow(idempotencyKey: string): ChannelOutboundPublishRow | null {
  return (
    (getDb().prepare("SELECT * FROM channel_outbound_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as
      | ChannelOutboundPublishRow
      | undefined) ?? null
  );
}

/**
 * Requires a record, giving a permanent tombstone precedence over payload.
 * Throws when neither exists; callers must discriminate status before reading
 * job content because suppressed results intentionally omit it.
 */
function requireChannelOutboundPublishJob(idempotencyKey: string): ChannelOutboundPublishRecord {
  const suppressed = selectChannelOutboundSuppression(idempotencyKey);
  if (suppressed) return rowToSuppressedPublishRecord(suppressed);
  const row = selectChannelOutboundPublishRow(idempotencyKey);
  if (!row) throw new Error(`Channel outbound publish job not found: ${idempotencyKey}`);
  return rowToPublishRecord(row);
}

/**
 * Discriminates suppression before parsing payload JSON, so suppressed records
 * never expose or require job content. Active records parse their stored job
 * and propagate malformed JSON errors to the caller.
 */
function rowToPublishRecord(row: ChannelOutboundPublishRow): ChannelOutboundPublishRecord {
  if (row.status === "suppressed") return rowToSuppressedPublishRecord(row);
  const parsed = JSON.parse(row.payload_json) as ChannelOutboundJob;
  return {
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    jobId: row.job_id,
    sessionName: row.session_name,
    channelId: row.channel_id,
    status: row.status,
    job: parsed,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    ...(row.last_error_at !== null ? { lastErrorAt: row.last_error_at } : {}),
    ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the compact terminal identity for the exact key, or null if absent.
 * Assumes schema initialization; performs no reservation or state transition.
 */
function selectChannelOutboundSuppression(idempotencyKey: string): ChannelOutboundSuppressionRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM channel_outbound_publish_suppressions WHERE idempotency_key = ?")
      .get(idempotencyKey) as ChannelOutboundSuppressionRow | null) ?? null
  );
}

/**
 * Maps a compact tombstone without reading/parsing payload JSON. Keeps any
 * earlier publishedAt value: terminal suppression does not prove the job was
 * never published, and the returned record intentionally carries no content.
 */
function rowToSuppressedPublishRecord(row: ChannelOutboundSuppressionRow): ChannelOutboundSuppressedPublishRecord {
  return {
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    jobId: row.job_id,
    sessionName: row.session_name,
    channelId: row.channel_id,
    status: "suppressed",
    attemptCount: row.attempt_count,
    nextAttemptAt: 0,
    ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
    suppressionReason: row.suppression_reason ?? "outbound_policy",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Existing immutable request fingerprint, including bytes, canonical origin and
 * native destination. Job-level timestamps/retry bookkeeping are excluded.
 */
export function channelOutboundPublishRequestFingerprint(job: ChannelOutboundJob): string {
  return createHash("sha256").update(JSON.stringify(job.request)).digest("hex");
}

/**
 * Coalescing scope for duplicate provider-unavailable notices, or `null` when
 * the job is not eligible. Eligibility is the mapped failure class only: a text
 * job whose content is exactly the provider-unavailable chat line.
 *
 * The scope carries the full delivery destination (channel, account, instance,
 * chat and thread) so two identical notices headed to different Slack accounts
 * or different threads in the same channel are never treated as duplicates.
 */
function coalescibleProviderUnavailableScope(job: ChannelOutboundJob): ChannelOutboundNoticeScope | null {
  const content = job.request.content;
  if (content.type !== "text") return null;
  if (!isProviderUnavailableChatText(content.text)) return null;
  return {
    channelId: job.request.channelId,
    accountId: job.request.accountId ?? "",
    instanceId: job.request.instanceId ?? null,
    targetChatId: job.request.targetChatId,
    targetThreadId: job.request.targetThreadId ?? null,
  };
}

function noticeScopeKey(scope: ChannelOutboundNoticeScope): string {
  return JSON.stringify([scope.channelId, scope.accountId, scope.instanceId, scope.targetChatId, scope.targetThreadId]);
}

async function emitQueuedDelivery(
  job: ChannelOutboundJob,
  emitEvent: typeof nats.emit,
  reason: "native_channel_outbound" | "native_channel_outbound_reconciled",
): Promise<void> {
  await emitEvent(`ravi.session.${job.request.origin.sessionName}.delivery`, {
    traceTurnId: job.request.origin.traceTurnId,
    status: "queued",
    reason,
    jobId: job.jobId,
    target: job.request.target,
    ...(job.request.content.type === "text"
      ? { contentType: "text", textLen: job.request.content.text.length }
      : {
          contentType: "chat_action",
          actionId: job.request.content.actionId,
          ...("providerMessageId" in job.request.content
            ? { providerMessageId: job.request.content.providerMessageId }
            : {}),
        }),
  });
}

function requireText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function finiteNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayWhileRunning(ms: number, shouldContinue: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (shouldContinue()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await delay(Math.min(remaining, 1_000));
  }
}

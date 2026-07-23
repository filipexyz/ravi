import { createHash } from "node:crypto";
import { getDb } from "../router/router-db.js";
import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS } from "./outbound-receipts.js";
import { type ChannelOutboundJob, publishChannelOutboundJob } from "./outbound-stream.js";

const log = logger.child("channels:outbound-publish-outbox");

export const CHANNEL_OUTBOUND_PUBLISH_RETRY_BASE_MS = 30_000;
export const CHANNEL_OUTBOUND_PUBLISH_RETRY_MAX_MS = 5 * 60_000;
export const CHANNEL_OUTBOUND_PUBLISH_RECONCILE_INTERVAL_MS = 30_000;
export const CHANNEL_OUTBOUND_PUBLISH_RECONCILE_LIMIT = 25;
export const CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS = CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS;

export type ChannelOutboundPublishStatus = "pending" | "published";

export interface ChannelOutboundPublishRecord {
  idempotencyKey: string;
  requestFingerprint: string;
  jobId: string;
  sessionName: string;
  channelId: string;
  status: ChannelOutboundPublishStatus;
  job: ChannelOutboundJob;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorMessage?: string;
  lastErrorAt?: number;
  publishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

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
  created_at: number;
  updated_at: number;
}

export type ChannelOutboundPublisher = (job: ChannelOutboundJob) => Promise<void>;

export type ChannelOutboundPublishResult =
  | {
      ok: true;
      record: ChannelOutboundPublishRecord;
      publishedNow: boolean;
    }
  | {
      ok: false;
      record: ChannelOutboundPublishRecord;
      error: unknown;
      nextAttemptAt: number;
    };

export interface ChannelOutboundPublishOutboxStore {
  save(job: ChannelOutboundJob, now?: number): ChannelOutboundPublishRecord;
  get(idempotencyKey: string): ChannelOutboundPublishRecord | null;
  listDue(options?: { now?: number; limit?: number }): ChannelOutboundPublishRecord[];
  markPublished(idempotencyKey: string, publishedAt?: number): ChannelOutboundPublishRecord;
  recordFailure(idempotencyKey: string, error: unknown, failedAt?: number): ChannelOutboundPublishRecord;
  prunePublished(cutoff: number, now?: number): number;
  summary(now?: number): ChannelOutboundPublishOutboxSummary;
}

export const sqliteChannelOutboundPublishOutboxStore: ChannelOutboundPublishOutboxStore = {
  save: saveChannelOutboundPublishJob,
  get: getChannelOutboundPublishJob,
  listDue: listDueChannelOutboundPublishJobs,
  markPublished: markChannelOutboundPublishJobPublished,
  recordFailure: recordChannelOutboundPublishJobFailure,
  prunePublished: prunePublishedChannelOutboundPublishJobs,
  summary: getChannelOutboundPublishOutboxSummary,
};

export function saveChannelOutboundPublishJob(job: ChannelOutboundJob, now = Date.now()): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(job.request.idempotencyKey, "idempotencyKey");
  const payloadJson = JSON.stringify(job);
  const requestFingerprint = channelOutboundPublishRequestFingerprint(job);
  const database = getDb();

  return database.transaction(() => {
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
      throw new Error(`Channel outbound publish job conflict for idempotency key: ${key}`);
    }
    return record;
  })();
}

export function getChannelOutboundPublishJob(idempotencyKey: string): ChannelOutboundPublishRecord | null {
  ensureChannelOutboundPublishOutboxSchema();
  const row = selectChannelOutboundPublishRow(requireText(idempotencyKey, "idempotencyKey"));
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

export function markChannelOutboundPublishJobPublished(
  idempotencyKey: string,
  publishedAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const now = finiteNumber(publishedAt) ?? Date.now();
  const result = getDb()
    .prepare(
      `UPDATE channel_outbound_publish_jobs
          SET status = 'published',
              published_at = COALESCE(published_at, ?),
              last_error_message = NULL,
              last_error_at = NULL,
              updated_at = ?
        WHERE idempotency_key = ?`,
    )
    .run(now, now, key);
  if (result.changes === 0) throw new Error(`Channel outbound publish job not found: ${key}`);
  return requireChannelOutboundPublishJob(key);
}

export function recordChannelOutboundPublishJobFailure(
  idempotencyKey: string,
  error: unknown,
  failedAt = Date.now(),
): ChannelOutboundPublishRecord {
  ensureChannelOutboundPublishOutboxSchema();
  const key = requireText(idempotencyKey, "idempotencyKey");
  const existing = requireChannelOutboundPublishJob(key);
  if (existing.status === "published") return existing;
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
       WHERE status = 'published'
         AND published_at IS NOT NULL
         AND published_at <= ?`,
    )
    .run(normalizedCutoff).changes;
}

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
  const saved = store.save(job, now());
  if (saved.status === "published") {
    return { ok: true, record: saved, publishedNow: false };
  }

  try {
    await (options.publisher ?? publishChannelOutboundJob)(saved.job);
    const published = store.markPublished(saved.idempotencyKey, now());
    return { ok: true, record: published, publishedNow: true };
  } catch (error) {
    const failed = store.recordFailure(saved.idempotencyKey, error, now());
    return {
      ok: false,
      record: failed,
      error,
      nextAttemptAt: failed.nextAttemptAt,
    };
  }
}

export async function reconcileDueChannelOutboundPublishes(
  options: {
    store?: ChannelOutboundPublishOutboxStore;
    publisher?: ChannelOutboundPublisher;
    emitEvent?: typeof nats.emit;
    now?: () => number;
    limit?: number;
  } = {},
): Promise<{ attempted: number; published: number; failed: number }> {
  const store = options.store ?? sqliteChannelOutboundPublishOutboxStore;
  const now = options.now ?? Date.now;
  const due = store.listDue({ now: now(), limit: options.limit });
  let published = 0;
  let failed = 0;

  for (const record of due) {
    try {
      await (options.publisher ?? publishChannelOutboundJob)(record.job);
      const updated = store.markPublished(record.idempotencyKey, now());
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
      failed++;
      const updated = store.recordFailure(record.idempotencyKey, error, now());
      log.warn("Deferred channel outbound publish; will retry", {
        jobId: updated.jobId,
        attemptCount: updated.attemptCount,
        nextAttemptAt: updated.nextAttemptAt,
        error,
      });
    }
  }

  return { attempted: due.length, published, failed };
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

function ensureChannelOutboundPublishOutboxSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS channel_outbound_publish_jobs (
      idempotency_key      TEXT PRIMARY KEY,
      request_fingerprint  TEXT NOT NULL,
      job_id               TEXT NOT NULL,
      session_name         TEXT NOT NULL,
      channel_id           TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN ('pending','published')),
      payload_json         TEXT NOT NULL,
      attempt_count        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at      INTEGER NOT NULL DEFAULT 0,
      last_error_message   TEXT,
      last_error_at        INTEGER,
      published_at         INTEGER,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_status_next
      ON channel_outbound_publish_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_published_retention
      ON channel_outbound_publish_jobs(status, published_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_publish_jobs_error
      ON channel_outbound_publish_jobs(last_error_at);
  `);
}

function selectChannelOutboundPublishRow(idempotencyKey: string): ChannelOutboundPublishRow | null {
  return (
    (getDb().prepare("SELECT * FROM channel_outbound_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as
      | ChannelOutboundPublishRow
      | undefined) ?? null
  );
}

function requireChannelOutboundPublishJob(idempotencyKey: string): ChannelOutboundPublishRecord {
  const row = selectChannelOutboundPublishRow(idempotencyKey);
  if (!row) throw new Error(`Channel outbound publish job not found: ${idempotencyKey}`);
  return rowToPublishRecord(row);
}

function rowToPublishRecord(row: ChannelOutboundPublishRow): ChannelOutboundPublishRecord {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function channelOutboundPublishRequestFingerprint(job: ChannelOutboundJob): string {
  return createHash("sha256").update(JSON.stringify(job.request)).digest("hex");
}

async function emitQueuedDelivery(
  job: ChannelOutboundJob,
  emitEvent: typeof nats.emit,
  reason: "native_channel_outbound" | "native_channel_outbound_reconciled",
): Promise<void> {
  await emitEvent(`ravi.session.${job.request.origin.sessionName}.delivery`, {
    status: "queued",
    reason,
    jobId: job.jobId,
    target: job.request.target,
    textLen: job.request.content.text.length,
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

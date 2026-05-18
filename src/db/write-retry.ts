/**
 * Write-side retry helper for `bun:sqlite`.
 *
 * Wraps a write transaction in `BEGIN IMMEDIATE` so the write lock is acquired
 * up front (vs deferred mode, which acquires it lazily at first write). On
 * `SQLITE_BUSY`/`SQLITE_LOCKED`, sleeps for a random jittered delay and retries.
 *
 * Modeled after Hermes Agent's `_execute_write` (NousResearch/hermes-agent,
 * `hermes_state.py`). The pattern resolves convoy effects under contention:
 * deterministic backoff causes processes to wake at the same time and collide
 * again; jittered sleep desynchronizes them.
 *
 * Sync-only. Do not `await` inside `fn` — SQLite is synchronous and the
 * `BEGIN IMMEDIATE` lock invariant breaks if the event loop yields mid-txn.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

const log = logger.child("db:write-retry");

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MIN_JITTER_MS = 20;
const DEFAULT_MAX_JITTER_MS = 150;
const DEFAULT_CHECKPOINT_EVERY_N_WRITES = 50;

// Per-Database write counter; weakly keyed so the entry vanishes when the
// caller closes/disposes the connection.
const writeCounters = new WeakMap<Database, number>();

/**
 * Best-effort PASSIVE WAL checkpoint. Never throws; never blocks readers or
 * writers (PASSIVE only flushes frames no one is reading). Keeps the WAL from
 * growing unbounded across multi-process daemons + CLIs that share a single
 * SQLite file — large WAL = slower reads = longer-held locks = more contention.
 */
function tryWalCheckpoint(db: Database, label: string | undefined): void {
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    log.debug("WAL checkpoint (PASSIVE) succeeded", { label });
  } catch (err) {
    log.debug("WAL checkpoint (PASSIVE) failed (ignored)", {
      label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function bumpWriteCounter(db: Database, label: string | undefined, threshold: number): void {
  const next = (writeCounters.get(db) ?? 0) + 1;
  writeCounters.set(db, next);
  if (threshold > 0 && next % threshold === 0) {
    tryWalCheckpoint(db, label);
  }
}

/**
 * Reset the per-DB write counter. Call from `closeDb()`/test teardown so the
 * next process pass doesn't inherit a stale tick.
 */
export function resetWriteCounter(db: Database): void {
  writeCounters.delete(db);
}

export interface WriteRetryOptions {
  maxAttempts?: number;
  minJitterMs?: number;
  maxJitterMs?: number;
  label?: string;
  /**
   * Run a PASSIVE WAL checkpoint every N successful writes. Set to 0 to
   * disable. Default 50.
   */
  checkpointEveryNWrites?: number;
}

export interface WriteRetryStats {
  attempts: number;
  retried: boolean;
  totalSleepMs: number;
}

export function isSqliteLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("locked") || msg.includes("busy");
}

function jitterMs(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

export function executeWrite<T>(db: Database, fn: (db: Database) => T, options: WriteRetryOptions = {}): T {
  const result = executeWriteWithStats(db, fn, options);
  return result.value;
}

export function executeWriteWithStats<T>(
  db: Database,
  fn: (db: Database) => T,
  options: WriteRetryOptions = {},
): { value: T; stats: WriteRetryStats } {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const minJitter = Math.max(0, options.minJitterMs ?? DEFAULT_MIN_JITTER_MS);
  const maxJitter = Math.max(minJitter, options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS);
  const label = options.label;
  const checkpointEveryN = Math.max(0, options.checkpointEveryNWrites ?? DEFAULT_CHECKPOINT_EVERY_N_WRITES);

  let lastErr: unknown = null;
  let totalSleepMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn(db);
        db.exec("COMMIT");
        if (attempt > 1) {
          log.info("write succeeded after retry", { attempt, label });
        }
        bumpWriteCounter(db, label, checkpointEveryN);
        return {
          value,
          stats: { attempts: attempt, retried: attempt > 1, totalSleepMs },
        };
      } catch (innerErr) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Rollback can fail if the transaction was already aborted by SQLite
          // (e.g. constraint violation auto-rollback). Swallow to surface the
          // original error.
        }
        throw innerErr;
      }
    } catch (err) {
      lastErr = err;
      if (!isSqliteLockError(err)) {
        throw err;
      }
      if (attempt >= maxAttempts) break;
      const delay = jitterMs(minJitter, maxJitter);
      totalSleepMs += delay;
      log.debug("write blocked, retrying", {
        attempt,
        delayMs: Math.round(delay),
        label,
        error: err instanceof Error ? err.message : String(err),
      });
      // biome-ignore lint/correctness/noUndeclaredVariables: Bun runtime global
      Bun.sleepSync(delay);
    }
  }

  log.error("write failed after retries", {
    attempts: maxAttempts,
    label,
    totalSleepMs: Math.round(totalSleepMs),
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw lastErr;
}

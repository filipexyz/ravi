/**
 * SQLite relay lease for the Pages app gateway runner.
 *
 * Several daemons can share one state directory. Only the lease holder for
 * `(consoleUrl, installationId)` dials the ExecutorRelay, so one installation
 * never holds two sockets from this machine. Same shape and semantics as
 * `console_inbox_poll_locks`.
 */

import { getDb } from "../router/router-db.js";

export function relayLeaseKey(consoleUrl: string, installationId: string): string {
  return `${consoleUrl.replace(/\/+$/, "")}\u0000${installationId}`;
}

export function acquireRelayLease(input: { lockKey: string; ownerId: string; ttlMs: number; now?: number }): boolean {
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(1_000, input.ttlMs);
  const result = getDb()
    .prepare(
      `INSERT INTO console_executor_relay_locks (lock_key, owner_id, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(lock_key) DO UPDATE SET
         owner_id = excluded.owner_id,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE console_executor_relay_locks.expires_at <= ?
          OR console_executor_relay_locks.owner_id = excluded.owner_id`,
    )
    .run(input.lockKey, input.ownerId, now, expiresAt, now);
  return result.changes > 0;
}

export function renewRelayLease(input: { lockKey: string; ownerId: string; ttlMs: number; now?: number }): boolean {
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(1_000, input.ttlMs);
  const result = getDb()
    .prepare(
      `UPDATE console_executor_relay_locks
       SET expires_at = ?
       WHERE lock_key = ? AND owner_id = ? AND expires_at > ?`,
    )
    .run(expiresAt, input.lockKey, input.ownerId, now);
  return result.changes > 0;
}

export function releaseRelayLease(lockKey: string, ownerId: string): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM console_executor_relay_locks WHERE lock_key = ? AND owner_id = ?`)
      .run(lockKey, ownerId).changes > 0
  );
}

import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";

export const RUNTIME_TURN_PROGRESS_INTERVAL_MS = 5_000;

export interface RuntimeTurnProgressOwner {
  attemptId: string;
  turnId: string;
  sessionKey: string;
  bootEpoch: string;
}

class ProgressLeaseExpired extends Error {}

/** Observation only: never renew a lease or authorize a provider side effect. */
export function recordRuntimeTurnProgress(
  owner: RuntimeTurnProgressOwner,
  signalAt: number,
  now: () => number = Date.now,
): boolean {
  if (!Number.isSafeInteger(signalAt) || signalAt < 0) return false;
  try {
    return executeWrite(
      getDb(),
      (db) => {
        const observedAt = now();
        if (!Number.isSafeInteger(observedAt) || signalAt > observedAt) return false;
        const fence = db
          .query(`
            SELECT a.lease_expires_at AS attempt_lease, b.lease_expires_at AS boot_lease
            FROM runtime_turn_attempts a JOIN runtime_boot_epochs b ON b.boot_epoch = a.boot_epoch
            WHERE a.attempt_id = ? AND a.turn_id = ? AND a.session_key = ? AND a.boot_epoch = ?
              AND a.status = 'running' AND a.recovery_claim_id IS NULL
              AND a.started_at <= ? AND a.last_heartbeat_at <= ? AND a.lease_expires_at > ?
              AND b.status = 'active' AND b.last_heartbeat_at <= ? AND b.lease_expires_at > ?
              AND a.turn_id = (SELECT t.turn_id FROM session_turns t WHERE t.session_key = a.session_key
                ORDER BY t.started_at DESC, t.turn_id DESC LIMIT 1)
              AND EXISTS (SELECT 1 FROM session_turns t WHERE t.turn_id = a.turn_id
                AND t.session_key = a.session_key AND t.completed_at IS NULL)
              AND a.attempt_id = (SELECT latest.attempt_id FROM runtime_turn_attempts latest
                WHERE latest.turn_id = a.turn_id AND latest.session_key = a.session_key
                ORDER BY latest.started_at DESC, latest.attempt_id DESC LIMIT 1)
          `)
          .get(
            owner.attemptId,
            owner.turnId,
            owner.sessionKey,
            owner.bootEpoch,
            signalAt,
            observedAt,
            observedAt,
            observedAt,
            observedAt,
          ) as { attempt_lease: number; boot_lease: number } | null;
        if (!fence) return false;
        const changed = db
          .query(`
            INSERT INTO runtime_turn_progress (attempt_id, turn_id, session_key, boot_epoch, last_signal_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(attempt_id) DO UPDATE SET last_signal_at = excluded.last_signal_at
            WHERE runtime_turn_progress.turn_id = excluded.turn_id
              AND runtime_turn_progress.session_key = excluded.session_key
              AND runtime_turn_progress.boot_epoch = excluded.boot_epoch
              AND excluded.last_signal_at >= runtime_turn_progress.last_signal_at + ?
          `)
          .run(
            owner.attemptId,
            owner.turnId,
            owner.sessionKey,
            owner.bootEpoch,
            signalAt,
            RUNTIME_TURN_PROGRESS_INTERVAL_MS,
          ).changes;
        // Re-read after the write, within the transaction, so a blocked write
        // cannot publish a watermark authorized by an already-expired lease.
        const writtenAt = now();
        if (
          !Number.isSafeInteger(writtenAt) ||
          writtenAt < observedAt ||
          writtenAt >= fence.attempt_lease ||
          writtenAt >= fence.boot_lease
        ) {
          throw new ProgressLeaseExpired();
        }
        return changed === 1;
      },
      { label: "runtime-turn-progress" },
    );
  } catch (error) {
    if (error instanceof ProgressLeaseExpired) return false;
    throw error;
  }
}

/** Per event loop, bounded to one binding; avoid one SQLite transaction per token. */
export function createRuntimeTurnProgressRecorder(): (owner: RuntimeTurnProgressOwner, signalAt: number) => boolean {
  let previous: (RuntimeTurnProgressOwner & { signalAt: number }) | undefined;
  return (owner, signalAt) => {
    if (
      previous?.attemptId === owner.attemptId &&
      previous.turnId === owner.turnId &&
      previous.sessionKey === owner.sessionKey &&
      previous.bootEpoch === owner.bootEpoch &&
      signalAt < previous.signalAt + RUNTIME_TURN_PROGRESS_INTERVAL_MS
    ) {
      return false;
    }
    // Throttle failures too: an unavailable database must not be retried on
    // every streamed token. This cache never becomes evidence for observers.
    previous = { ...owner, signalAt };
    return recordRuntimeTurnProgress(owner, signalAt);
  };
}

/** The caller supplies the latest exact attempt, never MAX across former owners. */
export function getRuntimeTurnProgress(owner: RuntimeTurnProgressOwner): number | null {
  const row = getDb()
    .query(`SELECT last_signal_at FROM runtime_turn_progress
      WHERE attempt_id = ? AND turn_id = ? AND session_key = ? AND boot_epoch = ?`)
    .get(owner.attemptId, owner.turnId, owner.sessionKey, owner.bootEpoch) as { last_signal_at: number } | null;
  return row?.last_signal_at ?? null;
}

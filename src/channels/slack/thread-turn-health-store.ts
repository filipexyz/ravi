import { randomUUID } from "node:crypto";
import { executeWrite } from "../../db/write-retry.js";
import { getDb } from "../../router/router-db.js";

export type ThreadTurnState = "idle" | "running" | "interrupted" | "attention" | "closed";
export type ThreadTurnReason = "no_signal" | "no_reply" | "owner_lost" | "failed";

/** A persisted observation, not a second owner of the provider turn. */
export interface ThreadTurnHealth {
  turnId: string | null;
  state: ThreadTurnState;
  reason: ThreadTurnReason | null;
  since: number;
  lastSignalAt: number | null;
  checkedAt: number;
}

interface HealthRow {
  turn_id: string | null;
  state: ThreadTurnState;
  reason: ThreadTurnReason | null;
  since_at: number;
  last_signal_at: number | null;
  checked_at: number;
}

export function getThreadTurnHealth(requestId: string): ThreadTurnHealth | null {
  const row = getDb().prepare("SELECT * FROM slack_thread_turn_health WHERE request_id = ?").get(requestId) as
    | HealthRow
    | undefined;
  return row
    ? {
        turnId: row.turn_id,
        state: row.state,
        reason: row.reason,
        since: row.since_at,
        lastSignalAt: row.last_signal_at,
        checkedAt: row.checked_at,
      }
    : null;
}

export function saveThreadTurnHealth(requestId: string, health: ThreadTurnHealth): void {
  executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    INSERT INTO slack_thread_turn_health
      (request_id, turn_id, state, reason, since_at, last_signal_at, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      since_at = CASE WHEN turn_id IS excluded.turn_id AND state = excluded.state AND reason IS excluded.reason
        THEN since_at ELSE excluded.since_at END,
      claim_id = CASE WHEN turn_id IS excluded.turn_id THEN claim_id ELSE NULL END,
      claim_expires_at = CASE WHEN turn_id IS excluded.turn_id THEN claim_expires_at ELSE NULL END,
      turn_id = excluded.turn_id, state = excluded.state, reason = excluded.reason,
      last_signal_at = excluded.last_signal_at, checked_at = excluded.checked_at
  `)
        .run(
          requestId,
          health.turnId,
          health.state,
          health.reason,
          health.since,
          health.lastSignalAt,
          health.checkedAt,
        ),
    { label: "thread-turn-health-save" },
  );
}

export function claimThreadTurnNotice(requestId: string, turnId: string, now: number): string | null {
  const claimId = randomUUID();
  const claimed = executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    UPDATE slack_thread_turn_health SET claim_id = ?, claim_expires_at = ?
    WHERE request_id = ? AND turn_id = ? AND state = 'attention'
      AND notified_turn_id IS NOT turn_id
      AND (claim_id IS NULL OR claim_expires_at <= ?)
      AND EXISTS (SELECT 1 FROM slack_thread_lifecycle l WHERE l.request_id = ? AND l.status = 'open')
  `)
        .run(claimId, now + 60_000, requestId, turnId, now, requestId).changes > 0,
    { label: "thread-turn-health-claim" },
  );
  return claimed ? claimId : null;
}

export function finishThreadTurnNotice(requestId: string, claimId: string, delivered: boolean, now: number): void {
  executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    UPDATE slack_thread_turn_health
    SET notified_turn_id = CASE WHEN ? THEN turn_id ELSE notified_turn_id END,
        notified_at = CASE WHEN ? THEN ? ELSE notified_at END,
        claim_id = NULL, claim_expires_at = NULL
    WHERE request_id = ? AND claim_id = ?
  `)
        .run(delivered ? 1 : 0, delivered ? 1 : 0, now, requestId, claimId),
    { label: "thread-turn-health-finish" },
  );
}

/** Fair, bounded batches; closed threads leave the batch after one final observation. */
export function listThreadTurnHealthCandidates(): string[] {
  return (
    getDb()
      .prepare(`
    SELECT l.request_id FROM slack_thread_lifecycle l
    LEFT JOIN slack_thread_turn_health h ON h.request_id = l.request_id
    WHERE l.child_session_key IS NOT NULL
      AND (l.status = 'open' OR (l.status = 'closed' AND h.state IS NOT NULL AND h.state != 'closed'))
    ORDER BY COALESCE(h.checked_at, 0), l.request_id LIMIT 100
  `)
      .all() as Array<{ request_id: string }>
  ).map((row) => row.request_id);
}

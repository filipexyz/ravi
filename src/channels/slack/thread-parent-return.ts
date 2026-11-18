import { executeWrite } from "../../db/write-retry.js";
import { listDecisions } from "../../decisions/store.js";
import { getDb } from "../../router/router-db.js";
import type { TurnOrigin } from "../../runtime/turn-provenance.js";
import type { SessionTurnRecord } from "../../session-trace/types.js";

/**
 * Thread → parent return rule.
 *
 * A thread turn that ends with a reply but sends nothing to its parent session
 * (no `sessions report`, no `close-thread --return`, no decision) leaves the
 * parent blind: the reply lives only in the Slack thread. The gateway
 * reconciliation asks the thread once for a short return; if the follow-up turn
 * still sends none, the parent gets an automatic Inform with the thread's last
 * message. At most one follow-up and one Inform per turn, never a follow-up of
 * a follow-up.
 *
 * Every input comes from Ravi's own records: the turn index (`session_turns`),
 * the turn's `adapter.request` provenance and `response.emitted` events, the
 * returns the thread sent (this table) and its decisions. No provider hook,
 * stream format or tool name is read, so the rule is the same for every
 * provider runtime (claude, codex, pi, ...).
 */

/** Turns older than this when first seen are backlog for the parent to triage, not a follow-up. */
export const THREAD_RETURN_WATCH_WINDOW_MS = 2 * 60 * 60_000;
/** The follow-up turn never started: stop waiting and tell the parent. */
export const THREAD_RETURN_NUDGE_TIMEOUT_MS = 15 * 60_000;
/** Follow-ups started per reconciliation tick, so a backlog cannot start every thread at once. */
export const THREAD_RETURN_NUDGES_PER_TICK = 3;

export type ThreadReturnStage = "nudged" | "returned" | "informed" | "skipped";

export interface ThreadReturnWatch {
  requestId: string;
  lastReturnAt: number | null;
  turnId: string | null;
  turnStartedAt: number | null;
  stage: ThreadReturnStage | null;
  nudgeEventId: string | null;
  nudgedAt: number | null;
  followupTurnId: string | null;
  resolvedAt: number | null;
}

interface WatchRow {
  request_id: string;
  last_return_at: number | null;
  turn_id: string | null;
  turn_started_at: number | null;
  stage: ThreadReturnStage | null;
  nudge_event_id: string | null;
  nudged_at: number | null;
  followup_turn_id: string | null;
  resolved_at: number | null;
}

export type ThreadReturnTurn = Pick<
  SessionTurnRecord,
  "turnId" | "status" | "startedAt" | "completedAt" | "outputState"
>;

export interface ThreadReturnInput {
  now: number;
  threadOpen: boolean;
  /** The child session's latest turn. */
  turn: ThreadReturnTurn | null;
  /** `turn_provenance.origin` of that turn's adapter request; null when not recorded. */
  turnOrigin: TurnOrigin | null;
  /** The turn produced a visible reply (final output state or an emitted reply text). */
  turnReplied: boolean;
  watch: ThreadReturnWatch | null;
  /** The thread has an open decision: its parent or owner already has the question. */
  openDecision: boolean;
  /** The thread sent its parent a return (report, close --return or a decision) at or after `since`. */
  returnedSince: (since: number) => boolean;
}

export type ThreadReturnAction =
  | { kind: "none" }
  | { kind: "nudge"; turnId: string; turnStartedAt: number }
  | {
      kind: "inform";
      turnId: string;
      followupTurnId: string | null;
      reason: "followup_without_return" | "followup_failed" | "nudge_unanswered";
    }
  | { kind: "settle"; turnId: string; stage: "returned" | "skipped"; followupTurnId: string | null };

const NONE: ThreadReturnAction = { kind: "none" };

/**
 * Turns started by someone other than a person in the thread. A person who
 * wrote in the thread is there to read the reply; the thread is talking to
 * them, not working for the parent.
 */
function isDelegatedOrigin(origin: TurnOrigin | null): boolean {
  return origin !== null && origin !== "human" && origin !== "unknown";
}

/** Pure decision. The reconciliation applies it with compare-and-set writes. */
export function decideThreadParentReturn(input: ThreadReturnInput): ThreadReturnAction {
  const { watch, turn, now } = input;

  if (watch?.stage === "nudged" && watch.turnId && watch.turnStartedAt !== null && watch.nudgedAt !== null) {
    if (input.returnedSince(watch.turnStartedAt)) {
      const followup = turn && turn.turnId !== watch.turnId ? turn.turnId : null;
      return { kind: "settle", turnId: watch.turnId, stage: "returned", followupTurnId: followup };
    }
    // Closing without a result is an explicit end of the work; nothing more to ask.
    if (!input.threadOpen) return { kind: "settle", turnId: watch.turnId, stage: "skipped", followupTurnId: null };
    const followup = turn && turn.turnId !== watch.turnId && turn.startedAt >= watch.nudgedAt ? turn : null;
    if (followup) {
      if (followup.completedAt === null) return NONE;
      if (followup.status === "complete" && followup.outputState === "silent") {
        // Asked for a return, the thread chose silence: it is waiting on a person in the thread.
        return { kind: "settle", turnId: watch.turnId, stage: "skipped", followupTurnId: followup.turnId };
      }
      return {
        kind: "inform",
        turnId: watch.turnId,
        followupTurnId: followup.turnId,
        reason: followup.status === "complete" ? "followup_without_return" : "followup_failed",
      };
    }
    if (now - watch.nudgedAt >= THREAD_RETURN_NUDGE_TIMEOUT_MS) {
      return { kind: "inform", turnId: watch.turnId, followupTurnId: null, reason: "nudge_unanswered" };
    }
    return NONE;
  }

  if (!input.threadOpen || !turn || turn.completedAt === null || turn.status !== "complete") return NONE;
  // Already handled: the watched turn itself, or the follow-up turn that answered it (no follow-up of a follow-up).
  if (watch && (watch.turnId === turn.turnId || watch.followupTurnId === turn.turnId)) return NONE;
  // No reply means the turn-health observer already raises `no_reply` to the parent.
  if (turn.outputState === "silent" || !input.turnReplied) return NONE;
  if (!isDelegatedOrigin(input.turnOrigin)) return NONE;
  if (now - turn.completedAt > THREAD_RETURN_WATCH_WINDOW_MS) return NONE;
  if (input.openDecision || input.returnedSince(turn.startedAt)) return NONE;
  return { kind: "nudge", turnId: turn.turnId, turnStartedAt: turn.startedAt };
}

function rowToWatch(row: WatchRow): ThreadReturnWatch {
  return {
    requestId: row.request_id,
    lastReturnAt: row.last_return_at,
    turnId: row.turn_id,
    turnStartedAt: row.turn_started_at,
    stage: row.stage,
    nudgeEventId: row.nudge_event_id,
    nudgedAt: row.nudged_at,
    followupTurnId: row.followup_turn_id,
    resolvedAt: row.resolved_at,
  };
}

export function getThreadReturnWatch(requestId: string): ThreadReturnWatch | null {
  const row = getDb().prepare("SELECT * FROM slack_thread_return_watch WHERE request_id = ?").get(requestId) as
    | WatchRow
    | undefined;
  return row ? rowToWatch(row) : null;
}

/** Record that the thread sent its parent a return (report or close --return). */
export function markThreadParentReturn(requestId: string, at: number): void {
  executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    INSERT INTO slack_thread_return_watch (request_id, last_return_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      last_return_at = MAX(COALESCE(last_return_at, 0), excluded.last_return_at),
      updated_at = excluded.updated_at
  `)
        .run(requestId, at, at),
    { label: "thread-return-mark" },
  );
}

/** Claim the single follow-up of a turn. False when another reconciler or an earlier tick already did. */
export function claimThreadReturnNudge(input: {
  requestId: string;
  turnId: string;
  turnStartedAt: number;
  eventId: string;
  now: number;
}): boolean {
  return executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    INSERT INTO slack_thread_return_watch
      (request_id, turn_id, turn_started_at, stage, nudge_event_id, nudged_at, followup_turn_id, resolved_at, updated_at)
    VALUES (?, ?, ?, 'nudged', ?, ?, NULL, NULL, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      turn_id = excluded.turn_id, turn_started_at = excluded.turn_started_at, stage = 'nudged',
      nudge_event_id = excluded.nudge_event_id, nudged_at = excluded.nudged_at,
      followup_turn_id = NULL, resolved_at = NULL, updated_at = excluded.updated_at
    WHERE turn_id IS NOT excluded.turn_id AND followup_turn_id IS NOT excluded.turn_id
      AND (stage IS NULL OR stage <> 'nudged')
  `)
        .run(input.requestId, input.turnId, input.turnStartedAt, input.eventId, input.now, input.now).changes > 0,
    { label: "thread-return-nudge-claim" },
  );
}

/** The follow-up was not published: let the next tick try the same turn again. */
export function releaseThreadReturnNudge(requestId: string, turnId: string, now: number): void {
  executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    UPDATE slack_thread_return_watch
    SET turn_id = NULL, turn_started_at = NULL, stage = NULL, nudge_event_id = NULL, nudged_at = NULL, updated_at = ?
    WHERE request_id = ? AND turn_id = ? AND stage = 'nudged'
  `)
        .run(now, requestId, turnId),
    { label: "thread-return-nudge-release" },
  );
}

/** Move a nudged turn to its final stage. False when someone else already did. */
export function resolveThreadReturnWatch(input: {
  requestId: string;
  turnId: string;
  stage: Exclude<ThreadReturnStage, "nudged">;
  followupTurnId: string | null;
  now: number;
}): boolean {
  return executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    UPDATE slack_thread_return_watch
    SET stage = ?, followup_turn_id = COALESCE(?, followup_turn_id), resolved_at = ?, updated_at = ?
    WHERE request_id = ? AND turn_id = ? AND stage = 'nudged'
  `)
        .run(input.stage, input.followupTurnId, input.now, input.now, input.requestId, input.turnId).changes > 0,
    { label: "thread-return-resolve" },
  );
}

/** Undo an `informed` claim whose Inform was not published, so the next tick retries it. */
export function reopenThreadReturnWatch(requestId: string, turnId: string, now: number): void {
  executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(`
    UPDATE slack_thread_return_watch SET stage = 'nudged', resolved_at = NULL, updated_at = ?
    WHERE request_id = ? AND turn_id = ? AND stage = 'informed'
  `)
        .run(now, requestId, turnId),
    { label: "thread-return-reopen" },
  );
}

/** `turn_provenance.origin` recorded by the runtime for every provider's adapter request. */
export function readThreadTurnOrigin(turnId: string): TurnOrigin | null {
  const row = getDb()
    .prepare(`
    SELECT json_extract(payload_json, '$.turn_provenance.origin') AS origin
    FROM session_events WHERE turn_id = ? AND event_type = 'adapter.request'
    ORDER BY seq ASC, id ASC LIMIT 1
  `)
    .get(turnId) as { origin: unknown } | undefined;
  return typeof row?.origin === "string" ? (row.origin as TurnOrigin) : null;
}

/** Preview of the last reply text the turn emitted, preferring the final answer. */
export function readThreadTurnReplyPreview(turnId: string): string | null {
  const row = getDb()
    .prepare(`
    SELECT preview FROM session_events
    WHERE turn_id = ? AND event_type = 'response.emitted' AND preview IS NOT NULL
      AND COALESCE(json_extract(payload_json, '$.textLen'), 0) > 0
      AND COALESCE(json_extract(payload_json, '$.hasError'), 0) = 0
    ORDER BY (json_extract(payload_json, '$.responsePhase') = 'final_answer') DESC, seq DESC, id DESC
    LIMIT 1
  `)
    .get(turnId) as { preview: string | null } | undefined;
  const text = row?.preview?.trim();
  return text ? text : null;
}

/** Report/close --return recorded here, or a decision the thread opened at or after `since`. */
export function threadReturnedSince(requestId: string, watch: ThreadReturnWatch | null, since: number): boolean {
  if (watch?.lastReturnAt !== null && watch?.lastReturnAt !== undefined && watch.lastReturnAt >= since) return true;
  return listDecisions({ type: "thread", id: requestId }).some((decision) => decision.createdAt >= since);
}

export function threadHasOpenDecision(requestId: string): boolean {
  return listDecisions({ type: "thread", id: requestId }, true).length > 0;
}

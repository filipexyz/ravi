import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { retireDecisionForWait } from "../decisions/store.js";

/**
 * Handoffs: the structured "this child session waits for its parent to act".
 *
 * Before this table the wait lived only in the text of a report, so nothing
 * could tell that the parent (the orchestrating session) had stopped while its
 * threads waited on it: a thread that finished its turn and waits is healthy
 * for every turn-health check. The reconciler (`reconcile.ts`) reads the open
 * rows, reminds the parent once and tells the owner once. Channel-free: rows
 * are keyed by session keys; a channel adapter only delivers the reminder.
 */

export const HANDOFF_KINDS = ["review", "decision", "merge", "dispatch", "instruction"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
export type HandoffStatus = "open" | "acknowledged" | "superseded";

export interface Handoff {
  id: string;
  childSessionKey: string;
  parentSessionKey: string;
  kind: HandoffKind;
  ref: string | null;
  note: string | null;
  callerContextId: string | null;
  status: HandoffStatus;
  createdAt: number;
  parentNudgedAt: number | null;
  ownerEscalatedAt: number | null;
  acknowledgedAt: number | null;
  ackReason: string | null;
  /** A decision wait points at the decision that holds its question and, later, the recorded answer. */
  decisionId: string | null;
}

interface HandoffRow {
  id: string;
  child_session_key: string;
  parent_session_key: string;
  kind: HandoffKind;
  ref: string | null;
  note: string | null;
  caller_context_id: string | null;
  status: HandoffStatus;
  created_at: number;
  parent_nudged_at: number | null;
  owner_escalated_at: number | null;
  acknowledged_at: number | null;
  ack_reason: string | null;
  decision_id?: string | null;
}

function fromRow(row: HandoffRow): Handoff {
  return {
    id: row.id,
    childSessionKey: row.child_session_key,
    parentSessionKey: row.parent_session_key,
    kind: row.kind,
    ref: row.ref,
    note: row.note,
    callerContextId: row.caller_context_id,
    status: row.status,
    createdAt: row.created_at,
    parentNudgedAt: row.parent_nudged_at,
    ownerEscalatedAt: row.owner_escalated_at,
    acknowledgedAt: row.acknowledged_at,
    ackReason: row.ack_reason,
    decisionId: row.decision_id ?? null,
  };
}

export function isHandoffKind(value: string): value is HandoffKind {
  return (HANDOFF_KINDS as readonly string[]).includes(value);
}

const NOTE_MAX = 280;

/**
 * Open a handoff. A child waits on one thing at a time: a new handoff from the
 * same child supersedes the open one (the newer report describes the current wait).
 */
export function newHandoffId(): string {
  return `hof_${randomUUID()}`;
}

export function openHandoff(input: {
  id?: string;
  childSessionKey: string;
  parentSessionKey: string;
  kind: HandoffKind;
  ref?: string | null;
  note?: string | null;
  callerContextId?: string | null;
  decisionId?: string | null;
  /** Record the wait already handled (for example a review the runtime dispatched itself). */
  closedReason?: string | null;
  now: number;
}): { handoff: Handoff; superseded: Handoff[] } {
  const id = input.id ?? newHandoffId();
  const ref = input.ref?.trim() || null;
  const note = input.note?.trim() ? input.note.trim().slice(0, NOTE_MAX) : null;
  return executeWrite(
    getDb(),
    (db) => {
      const previous = (
        db
          .prepare("SELECT * FROM session_handoffs WHERE child_session_key = ? AND status = 'open'")
          .all(input.childSessionKey) as HandoffRow[]
      ).map(fromRow);
      db.prepare(
        `UPDATE session_handoffs SET status = 'superseded', acknowledged_at = ?, ack_reason = 'superseded', updated_at = ?
         WHERE child_session_key = ? AND status = 'open'`,
      ).run(input.now, input.now, input.childSessionKey);
      db.prepare(
        `INSERT INTO session_handoffs
          (id, child_session_key, parent_session_key, kind, ref, note, caller_context_id, status, created_at,
           acknowledged_at, ack_reason, updated_at, decision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.childSessionKey,
        input.parentSessionKey,
        input.kind,
        ref,
        note,
        input.callerContextId ?? null,
        input.closedReason ? "acknowledged" : "open",
        input.now,
        input.closedReason ? input.now : null,
        input.closedReason ?? null,
        input.now,
        input.decisionId ?? null,
      );
      const row = db.prepare("SELECT * FROM session_handoffs WHERE id = ?").get(id) as HandoffRow;
      // A replaced decision wait retires its question, unless the new wait asks the same decision again.
      for (const old of previous)
        if (old.decisionId && old.decisionId !== (input.decisionId ?? null))
          retireDecisionForWait(old.decisionId, `wait superseded by ${id}`, input.now);
      return { handoff: fromRow(row), superseded: previous };
    },
    { label: "handoff-open" },
  );
}

/** Acknowledge every open handoff of a child (the parent acted on that child). */
/**
 * Acknowledge the child's open handoffs. `kinds` limits it to handoffs of those kinds: a message to the
 * thread answers an instruction or a decision, but it does not dispatch a review nor merge.
 */
export function acknowledgeHandoffsForChild(
  childSessionKey: string,
  reason: string,
  now: number,
  kinds?: readonly HandoffKind[],
): Handoff[] {
  return executeWrite(
    getDb(),
    (db) => {
      const open = (
        db
          .prepare("SELECT * FROM session_handoffs WHERE child_session_key = ? AND status = 'open'")
          .all(childSessionKey) as HandoffRow[]
      )
        .map(fromRow)
        .filter((h) => !kinds || kinds.includes(h.kind))
        // A message to the thread does not answer a recorded decision: only `decisions answer` closes that wait.
        .filter((h) => !(kinds && h.kind === "decision" && h.decisionId));
      if (open.length === 0) return [];
      const stmt = db.prepare(
        `UPDATE session_handoffs SET status = 'acknowledged', acknowledged_at = ?, ack_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      );
      for (const h of open) {
        stmt.run(now, reason, now, h.id);
        if (h.decisionId) retireDecisionForWait(h.decisionId, `wait closed: ${reason}`, now);
      }
      return open.map((h) => ({ ...h, status: "acknowledged" as const, acknowledgedAt: now, ackReason: reason }));
    },
    { label: "handoff-ack-child" },
  );
}

/** Acknowledge one open handoff by id. Null when it does not exist or is no longer open. */
export function acknowledgeHandoff(id: string, reason: string, now: number): Handoff | null {
  return executeWrite(
    getDb(),
    (db) => {
      const row = db.prepare("SELECT * FROM session_handoffs WHERE id = ? AND status = 'open'").get(id) as
        | HandoffRow
        | undefined;
      if (!row) return null;
      db.prepare(
        `UPDATE session_handoffs SET status = 'acknowledged', acknowledged_at = ?, ack_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      ).run(now, reason, now, id);
      // An explicit acknowledgement without an answer retires the question so it stops blocking the thread.
      if (row.decision_id) retireDecisionForWait(row.decision_id, `wait acknowledged: ${reason}`, now);
      return { ...fromRow(row), status: "acknowledged" as const, acknowledgedAt: now, ackReason: reason };
    },
    { label: "handoff-ack" },
  );
}

export function getHandoff(id: string): Handoff | null {
  const row = getDb().prepare("SELECT * FROM session_handoffs WHERE id = ?").get(id) as HandoffRow | undefined;
  return row ? fromRow(row) : null;
}

export function listHandoffs(
  filter: { parentSessionKey?: string; includeClosed?: boolean; limit?: number } = {},
): Handoff[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (!filter.includeClosed) clauses.push("status = 'open'");
  if (filter.parentSessionKey) {
    clauses.push("parent_session_key = ?");
    args.push(filter.parentSessionKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // With a limit the newest rows are kept (closed history grows forever), still returned oldest first.
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : null;
  const sql = limit
    ? `SELECT * FROM (SELECT * FROM session_handoffs ${where} ORDER BY created_at DESC LIMIT ${limit}) ORDER BY created_at ASC`
    : `SELECT * FROM session_handoffs ${where} ORDER BY created_at ASC`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as HandoffRow[]
  ).map(fromRow);
}

/** Claim the single parent reminder. False when it was already sent or the handoff closed. */
export function claimParentNudge(id: string, now: number): boolean {
  return executeWrite(
    getDb(),
    (db) =>
      db
        .prepare(
          `UPDATE session_handoffs SET parent_nudged_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open' AND parent_nudged_at IS NULL`,
        )
        .run(now, now, id).changes === 1,
    { label: "handoff-nudge" },
  );
}

/** Claim the owner escalation for the ids still open and not escalated; returns the claimed ids. */
export function claimOwnerEscalation(ids: readonly string[], now: number): string[] {
  if (ids.length === 0) return [];
  return executeWrite(
    getDb(),
    (db) => {
      const claimed: string[] = [];
      const stmt = db.prepare(
        `UPDATE session_handoffs SET owner_escalated_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open' AND owner_escalated_at IS NULL`,
      );
      for (const id of ids) if (stmt.run(now, now, id).changes === 1) claimed.push(id);
      return claimed;
    },
    { label: "handoff-escalate" },
  );
}

/**
 * Undo an owner claim whose delivery did not happen. Only the claim made at `claimedAt` is released, so a
 * later claim (another tick) is never cleared by an older failure.
 */
export function releaseOwnerEscalation(ids: readonly string[], claimedAt: number): void {
  if (ids.length === 0) return;
  executeWrite(
    getDb(),
    (db) => {
      const stmt = db.prepare(
        `UPDATE session_handoffs SET owner_escalated_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'open' AND owner_escalated_at = ?`,
      );
      for (const id of ids) stmt.run(claimedAt, id, claimedAt);
    },
    { label: "handoff-escalate-release" },
  );
}

/** Close the open `review`/`merge` waits whose ref names this PR (`owner/repo#n@<sha>`, any head). */
export function acknowledgeHandoffsForPullRequest(repo: string, pr: number, reason: string, now: number): Handoff[] {
  const prefix = `${repo.toLowerCase()}#${pr}@`;
  return executeWrite(
    getDb(),
    (db) => {
      const open = (
        db
          .prepare(
            "SELECT * FROM session_handoffs WHERE status = 'open' AND kind IN ('review', 'merge') AND substr(lower(ref), 1, ?) = ?",
          )
          .all(prefix.length, prefix) as HandoffRow[]
      ).map(fromRow);
      const stmt = db.prepare(
        `UPDATE session_handoffs SET status = 'acknowledged', acknowledged_at = ?, ack_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      );
      for (const h of open) stmt.run(now, reason, now, h.id);
      return open.map((h) => ({ ...h, status: "acknowledged" as const, acknowledgedAt: now, ackReason: reason }));
    },
    { label: "handoff-ack-pr" },
  );
}

/**
 * Close the open waits that point at this decision. Runs inside the answering transaction (the caller passes
 * its database handle) so the recorded answer and the closed wait commit together.
 */
export function acknowledgeHandoffsForDecision(
  db: ReturnType<typeof getDb>,
  decisionId: string,
  reason: string,
  now: number,
): Handoff[] {
  const open = (
    db
      .prepare("SELECT * FROM session_handoffs WHERE decision_id = ? AND status = 'open'")
      .all(decisionId) as HandoffRow[]
  ).map(fromRow);
  const stmt = db.prepare(
    `UPDATE session_handoffs SET status = 'acknowledged', acknowledged_at = ?, ack_reason = ?, updated_at = ?
     WHERE id = ? AND status = 'open'`,
  );
  for (const h of open) stmt.run(now, reason, now, h.id);
  return open.map((h) => ({ ...h, status: "acknowledged" as const, acknowledgedAt: now, ackReason: reason }));
}

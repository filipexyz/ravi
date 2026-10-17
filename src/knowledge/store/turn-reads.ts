// What a turn read (contract §11.4): the lowest trust tier a turn's Knowledge
// reads returned, and the operator's answers to "this turn read unapproved
// content and now wants to write". Ids, tiers and fingerprints only.

import { executeWrite } from "../../db/write-retry.js";
import { isKnowledgeTrustTier, lowestTier, type KnowledgeTrustTier } from "../types.js";
import { getKnowledgeDb } from "./db.js";

/** A read older than this no longer gates writes (`TURN_READ_TTL` precedent). */
export const TURN_READ_TTL_MS = 6 * 60 * 60_000;

export type WriteApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface WriteApprovalRow {
  id: string;
  turnKey: string;
  fingerprint: string;
  /** Command summary without secrets or bodies, e.g. "pages share <url> --with <email>". */
  summary: string;
  status: WriteApprovalStatus;
  requestedAt: number;
  decidedAt: number | null;
}

interface WriteApprovalDbRow {
  id: string;
  turn_key: string;
  fingerprint: string;
  summary: string;
  status: WriteApprovalStatus;
  requested_at: number;
  decided_at: number | null;
}

/** Records that the turn read content of `tier`; keeps the lowest tier seen. */
export function recordTurnRead(turnKey: string, tier: KnowledgeTrustTier, now: number = Date.now()): void {
  if (!turnKey || !isKnowledgeTrustTier(tier)) return;
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      const existing = db.prepare("SELECT lowest_tier FROM knowledge_turn_reads WHERE turn_key = ?").get(turnKey) as {
        lowest_tier: KnowledgeTrustTier;
      } | null;
      if (!existing) {
        db.prepare(
          "INSERT INTO knowledge_turn_reads (turn_key, lowest_tier, first_read_at, last_read_at) VALUES (?, ?, ?, ?)",
        ).run(turnKey, tier, now, now);
        return;
      }
      const next = lowestTier([existing.lowest_tier, tier]) ?? tier;
      db.prepare("UPDATE knowledge_turn_reads SET lowest_tier = ?, last_read_at = ? WHERE turn_key = ?").run(
        next,
        now,
        turnKey,
      );
    },
    { label: "knowledge_turn_read" },
  );
}

/** The lowest tier this turn read, or null when it read nothing in the last 6 h. */
export function lowestTierReadInTurn(turnKey: string | null, now: number = Date.now()): KnowledgeTrustTier | null {
  if (!turnKey) return null;
  const row = getKnowledgeDb()
    .prepare("SELECT lowest_tier, last_read_at FROM knowledge_turn_reads WHERE turn_key = ?")
    .get(turnKey) as { lowest_tier: KnowledgeTrustTier; last_read_at: number } | null;
  if (!row || row.last_read_at < now - TURN_READ_TTL_MS) return null;
  return isKnowledgeTrustTier(row.lowest_tier) ? row.lowest_tier : null;
}

export function findWriteApproval(turnKey: string, fingerprint: string): WriteApprovalRow | null {
  const row = getKnowledgeDb()
    .prepare("SELECT * FROM knowledge_write_approvals WHERE turn_key = ? AND fingerprint = ?")
    .get(turnKey, fingerprint) as WriteApprovalDbRow | null;
  return row ? toWriteApproval(row) : null;
}

/** Inserts the row, or replaces the one with the same (turnKey, fingerprint). */
export function upsertWriteApproval(row: WriteApprovalRow): WriteApprovalRow {
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_write_approvals (id, turn_key, fingerprint, summary, status, requested_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_key, fingerprint) DO UPDATE SET
           id = excluded.id, summary = excluded.summary, status = excluded.status,
           requested_at = excluded.requested_at, decided_at = excluded.decided_at`,
      ).run(row.id, row.turnKey, row.fingerprint, row.summary, row.status, row.requestedAt, row.decidedAt);
    },
    { label: "knowledge_write_approval_upsert" },
  );
  return row;
}

export function setWriteApprovalStatus(
  id: string,
  status: WriteApprovalStatus,
  decidedAt: number | null = status === "pending" ? null : Date.now(),
): boolean {
  return executeWrite(
    getKnowledgeDb(),
    (db) =>
      db
        .prepare("UPDATE knowledge_write_approvals SET status = ?, decided_at = ? WHERE id = ?")
        .run(status, decidedAt, id).changes > 0,
    { label: "knowledge_write_approval_status" },
  );
}

function toWriteApproval(row: WriteApprovalDbRow): WriteApprovalRow {
  return {
    id: row.id,
    turnKey: row.turn_key,
    fingerprint: row.fingerprint,
    summary: row.summary,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? null,
  };
}

import type { Database } from "bun:sqlite";
import { initializeStateSchema } from "../../db/schema-owner.js";
import { getDb } from "../../router/router-db.js";

export const SLACK_AUTOMATIC_OUTPUT_POLICY = Object.freeze({
  maxOutputs: 4,
  rollingWindowMs: 5 * 60 * 1_000,
  cooldownMs: 5 * 60 * 1_000,
});

export type SlackAutomaticOutputSuppressionReason =
  | "slack_bot_reply_cooldown"
  | "slack_bot_reply_stale_source"
  | "slack_bot_reply_identity_conflict";

export interface SlackAutomaticOutputDecision {
  status: "allowed" | "suppressed";
  reason?: SlackAutomaticOutputSuppressionReason;
  decidedAt: number;
  recoverAt?: number;
}

export interface SlackAutomaticOutputReservation {
  /** Identity of the complete terminal response, shared by all of its parts. */
  idempotencyKey: string;
  /** Immutable terminal manifest: outcome, destination, text and all media. */
  requestFingerprint: string;
  /** Canonical local Slack installation/account and actual destination channel. */
  scope: string;
  /** Trusted triggering input identity, never mutable session latest-source state. */
  sourceId: string;
  /** Local durable ingress acceptance time, not a provider-controlled timestamp. */
  sourceReceivedAt: number;
  now?: number;
}

interface DecisionRow {
  idempotency_key: string;
  request_fingerprint: string;
  scope: string;
  source_id: string;
  source_received_at: number;
  status: "allowed" | "suppressed";
  reason: SlackAutomaticOutputSuppressionReason | null;
  decided_at: number;
  recover_at: number | null;
}

interface ScopeRow {
  cooldown_until: number | null;
  eligibility_after: number | null;
}

/**
 * Reserve quota for one complete terminal response under an IMMEDIATE writer
 * transaction. The caller supplies its fixed manifest identity, excludes
 * commentary, and validates provenance and local acceptance time beforehand.
 * Identifiers remain untrimmed; timestamps must be safe nonnegative integers
 * in local epoch milliseconds.
 *
 * Identical retries return the original decision without another debit, even
 * after cooldown. Conflicting identity returns suppression without overwriting
 * that decision. Suppressed identities remain terminal; after cooldown, new
 * identities require an input accepted strictly after the recovery floor.
 * Quota counts admissions, not delivery, and does not stop every slow bot loop.
 */
export function reserveSlackAutomaticOutput(input: SlackAutomaticOutputReservation): SlackAutomaticOutputDecision {
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const requestFingerprint = requireText(input.requestFingerprint, "requestFingerprint");
  const scope = requireText(input.scope, "scope");
  const sourceId = requireText(input.sourceId, "sourceId");
  const sourceReceivedAt = requireTimestamp(input.sourceReceivedAt, "sourceReceivedAt");
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const database = getDb();
  ensureSlackAutomaticOutputSchema(database);

  // Take the writer lock before reading either the frozen decision or window.
  // Separate processes racing the last allowance cannot both observe a vacancy.
  return database
    .transaction((): SlackAutomaticOutputDecision => {
      const existing = selectDecision(database, idempotencyKey);
      if (existing) {
        if (
          existing.request_fingerprint !== requestFingerprint ||
          existing.scope !== scope ||
          existing.source_id !== sourceId ||
          existing.source_received_at !== sourceReceivedAt
        ) {
          // Do not overwrite the original response or debit its scope again.
          return {
            status: "suppressed",
            reason: "slack_bot_reply_identity_conflict",
            decidedAt: existing.decided_at,
          };
        }
        return rowToDecision(existing);
      }

      database.prepare("INSERT OR IGNORE INTO slack_automatic_output_scopes (scope) VALUES (?)").run(scope);
      const state = database
        .prepare("SELECT cooldown_until, eligibility_after FROM slack_automatic_output_scopes WHERE scope = ?")
        .get(scope) as ScopeRow;
      let decision: SlackAutomaticOutputDecision;
      if (state.cooldown_until !== null && now < state.cooldown_until) {
        decision = {
          status: "suppressed",
          reason: "slack_bot_reply_cooldown",
          decidedAt: now,
          recoverAt: state.cooldown_until,
        };
      } else if (state.eligibility_after !== null && sourceReceivedAt <= state.eligibility_after) {
        // The timer alone cannot revive delayed output from before/during the
        // pause. Only a newly accepted input strictly after recovery can respond.
        decision = {
          status: "suppressed",
          reason: "slack_bot_reply_stale_source",
          decidedAt: now,
          recoverAt: state.eligibility_after,
        };
      } else {
        const { count } = database
          .prepare(
            `SELECT COUNT(*) AS count FROM slack_automatic_output_decisions
           WHERE scope = ? AND status = 'allowed' AND decided_at > ?`,
          )
          .get(scope, now - SLACK_AUTOMATIC_OUTPUT_POLICY.rollingWindowMs) as { count: number };
        if (count < SLACK_AUTOMATIC_OUTPUT_POLICY.maxOutputs) {
          decision = { status: "allowed", decidedAt: now };
        } else {
          const recoverAt = requireTimestamp(now + SLACK_AUTOMATIC_OUTPUT_POLICY.cooldownMs, "recoverAt");
          database
            .prepare(
              `UPDATE slack_automatic_output_scopes
             SET cooldown_until = ?, eligibility_after = ? WHERE scope = ?`,
            )
            .run(recoverAt, recoverAt, scope);
          decision = { status: "suppressed", reason: "slack_bot_reply_cooldown", decidedAt: now, recoverAt };
        }
      }

      database
        .prepare(
          `INSERT INTO slack_automatic_output_decisions
         (idempotency_key, request_fingerprint, scope, source_id, source_received_at,
          status, reason, decided_at, recover_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          idempotencyKey,
          requestFingerprint,
          scope,
          sourceId,
          sourceReceivedAt,
          decision.status,
          decision.reason ?? null,
          decision.decidedAt,
          decision.recoverAt ?? null,
        );
      return decision;
    })
    .immediate();
}

/**
 * Return the original stored decision or null for audit, including after a
 * conflicting reservation attempt. This key-only lookup neither compares the
 * full terminal identity nor authorizes delivery; delivery must reserve it.
 */
export function getSlackAutomaticOutputDecision(idempotencyKey: string): SlackAutomaticOutputDecision | null {
  const key = requireText(idempotencyKey, "idempotencyKey");
  const database = getDb();
  ensureSlackAutomaticOutputSchema(database);
  const row = selectDecision(database, key);
  return row ? rowToDecision(row) : null;
}

/**
 * The daemon initializes quota schema in an IMMEDIATE transaction. Channels
 * only validates the same-release ready marker and never executes the DDL.
 * Decisions, suppression tombstones and recovery floors have no age-based
 * expiry: pruning them could debit a replay again or revive suppressed output.
 * Retained rows contain identities and decisions, never message or media bodies.
 */
export function ensureSlackAutomaticOutputSchema(database: Database = getDb()): void {
  initializeStateSchema(database, "slack-automatic-output", () => {
    database
      .transaction(() => {
        database.exec(`
      CREATE TABLE IF NOT EXISTS slack_automatic_output_scopes (
        scope TEXT PRIMARY KEY,
        cooldown_until INTEGER,
        eligibility_after INTEGER
      );
      CREATE TABLE IF NOT EXISTS slack_automatic_output_decisions (
        idempotency_key TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('allowed', 'suppressed')),
        reason TEXT,
        decided_at INTEGER NOT NULL,
        recover_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_slack_automatic_output_window
        ON slack_automatic_output_decisions (scope, decided_at) WHERE status = 'allowed';
    `);
      })
      .immediate();
  });
  // Keep these compact identity/decision tombstones and the scope floor. Age
  // alone is not proof that an old output cannot return. Deleting either would
  // allow a replay to debit again, revive suppression, or reset the source floor.
  // No message bodies, media or provider payloads are retained here.
}

function selectDecision(database: Database, key: string): DecisionRow | null {
  return (
    (database
      .prepare("SELECT * FROM slack_automatic_output_decisions WHERE idempotency_key = ?")
      .get(key) as DecisionRow | null) ?? null
  );
}

function rowToDecision(row: DecisionRow): SlackAutomaticOutputDecision {
  return {
    status: row.status,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    decidedAt: row.decided_at,
    ...(row.recover_at !== null ? { recoverAt: row.recover_at } : {}),
  };
}

/** Reject blank identifiers while preserving the original string used as identity. */
function requireText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

/**
 * Check only safe integer range and nonnegativity; the caller must supply trusted
 * local epoch milliseconds rather than a provider timestamp or another unit.
 */
function requireTimestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer timestamp`);
  return value;
}

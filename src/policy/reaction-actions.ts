import { createHash } from "node:crypto";
import { getDb } from "../router/router-db.js";

export type ReactionActionKeySource = "explicit" | "observer";

export interface ReactionActionRecord {
  keyHash: string;
  keySource: ReactionActionKeySource;
  actionType: string;
  actionFingerprint: string;
  ruleId?: string;
  sourceTurnIds: string[];
  targetType: string;
  targetId: string;
  createdAt: number;
  completedAt: number;
}

interface ReactionActionRow {
  idempotency_key_hash: string;
  key_source: ReactionActionKeySource;
  action_type: string;
  action_fingerprint: string;
  rule_id: string | null;
  source_turn_ids_json: string;
  target_type: string;
  target_id: string;
  created_at: number;
  completed_at: number;
}

export interface ReactionActionKey {
  keyHash: string;
  keySource: ReactionActionKeySource;
  ruleId?: string;
  sourceTurnIds?: string[];
}

export interface ExecuteIdempotentReactionActionInput extends ReactionActionKey {
  actionType: string;
  actionFingerprint: string;
  execute(): { targetType: string; targetId: string };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function normalizeSourceTurnIds(values: Iterable<string> = []): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

export function fingerprintReactionAction(action: unknown): string {
  const serialized = JSON.stringify(canonicalize(action));
  return sha256(serialized ?? "undefined");
}

export function buildExplicitReactionActionKey(value: string): ReactionActionKey {
  const key = value.trim();
  if (!key) throw new Error("Idempotency key must not be empty.");
  return {
    keyHash: sha256(`explicit\0${key}`),
    keySource: "explicit",
  };
}

export function buildObserverReactionActionKey(input: {
  ruleId: string;
  sourceTurnIds: Iterable<string>;
  actionType: string;
  actionFingerprint: string;
}): ReactionActionKey {
  const ruleId = input.ruleId.trim();
  const sourceTurnIds = normalizeSourceTurnIds(input.sourceTurnIds);
  if (!ruleId) throw new Error("Observer reaction rule id must not be empty.");
  if (sourceTurnIds.length === 0) throw new Error("Observer reaction requires at least one source turn id.");
  return {
    keyHash: sha256(
      ["observer", ruleId, sourceTurnIds.join(","), input.actionType, input.actionFingerprint].join("\0"),
    ),
    keySource: "observer",
    ruleId,
    sourceTurnIds,
  };
}

function rowToReactionAction(row: ReactionActionRow): ReactionActionRecord {
  let sourceTurnIds: string[] = [];
  try {
    const parsed = JSON.parse(row.source_turn_ids_json) as unknown;
    if (Array.isArray(parsed))
      sourceTurnIds = normalizeSourceTurnIds(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    sourceTurnIds = [];
  }
  return {
    keyHash: row.idempotency_key_hash,
    keySource: row.key_source,
    actionType: row.action_type,
    actionFingerprint: row.action_fingerprint,
    ...(row.rule_id ? { ruleId: row.rule_id } : {}),
    sourceTurnIds,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function getReactionAction(keyHash: string): ReactionActionRecord | null {
  const row = getDb().prepare("SELECT * FROM reaction_actions WHERE idempotency_key_hash = ?").get(keyHash) as
    | ReactionActionRow
    | undefined;
  return row ? rowToReactionAction(row) : null;
}

/**
 * Execute a reaction exactly once with the action and ledger write in one
 * SQLite transaction. The durable row intentionally survives target deletion.
 */
export function executeIdempotentReactionAction(input: ExecuteIdempotentReactionActionInput): {
  created: boolean;
  record: ReactionActionRecord;
} {
  const db = getDb();
  let outcome: { created: boolean; record: ReactionActionRecord } | undefined;

  db.transaction(() => {
    const now = Date.now();
    const claim = db
      .prepare(
        `INSERT OR IGNORE INTO reaction_actions (
           idempotency_key_hash, key_source, action_type, action_fingerprint,
           rule_id, source_turn_ids_json, target_type, target_id, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, 0)`,
      )
      .run(
        input.keyHash,
        input.keySource,
        input.actionType,
        input.actionFingerprint,
        input.ruleId ?? null,
        JSON.stringify(normalizeSourceTurnIds(input.sourceTurnIds)),
        now,
      );
    if (claim.changes === 0) {
      const existing = getReactionAction(input.keyHash);
      if (!existing) throw new Error("Idempotent reaction claim disappeared.");
      if (existing.actionType !== input.actionType || existing.actionFingerprint !== input.actionFingerprint) {
        throw new Error("Idempotency key was already used for a different reaction action.");
      }
      outcome = { created: false, record: existing };
      return;
    }

    const target = input.execute();
    db.prepare(
      `UPDATE reaction_actions
       SET target_type = ?, target_id = ?, completed_at = ?
       WHERE idempotency_key_hash = ?`,
    ).run(target.targetType, target.targetId, Date.now(), input.keyHash);
    const completed = getReactionAction(input.keyHash);
    if (!completed) throw new Error("Completed reaction action disappeared.");
    outcome = { created: true, record: completed };
  })();

  if (!outcome) throw new Error("Failed to persist reaction action.");
  return outcome;
}

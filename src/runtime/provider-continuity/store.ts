import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { getDb } from "../../router/router-db.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  providerContinuityBatchSchema,
  providerContinuityEffectSchema,
  providerContinuityEventSchema,
  providerContinuityHealthSchema,
  providerContinuityJournalSchema,
  providerContinuityPolicyConfigSchema,
  providerContinuityPolicySchema,
  type ProviderContinuityBatch,
  type ProviderContinuityEffect,
  type ProviderContinuityEvent,
  type ProviderContinuityHealth,
  type ProviderContinuityJournal,
  type ProviderContinuityPolicy,
  type ProviderContinuityPolicyConfig,
} from "./types.js";

interface PolicyRow {
  agent_id: string;
  policy_json: string;
  version: number;
  created_at: number;
  updated_at: number;
}

interface JournalRow {
  logical_request_id: string;
  agent_id: string;
  session_name: string;
  state: string;
  journal_json: string;
  deadline_at: number;
  wake_at: number | null;
  created_at: number;
  updated_at: number;
}

interface HealthRow {
  agent_id: string;
  provider: string;
  model: string;
  health_json: string;
  updated_at: number;
}

interface EffectRow {
  effect_id: string;
  logical_request_id: string;
  tool_call_id: string;
  operation: string;
  input_fingerprint: string;
  status: string;
  effect_json: string;
  created_at: number;
  updated_at: number;
}

interface BatchRow {
  batch_id: string;
  plan_hash: string;
  batch_json: string;
  status: string;
  expires_at: number;
  approval_ref: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  created_at: number;
  applied_at: number | null;
}

interface EventRow {
  event_id: number;
  logical_request_id: string | null;
  agent_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: number;
  spec_version: string;
  compatibility_snapshot_id: string;
}

export class ProviderContinuityStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "stale"
      | "conflict"
      | "terminal_conflict"
      | "snapshot_conflict"
      | "invalid_persisted_state",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProviderContinuityStoreError";
  }
}

export function ensureProviderContinuityTables(db: Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_policies (
      agent_id TEXT PRIMARY KEY,
      policy_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_journals (
      logical_request_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      state TEXT NOT NULL,
      journal_json TEXT NOT NULL,
      deadline_at INTEGER NOT NULL,
      wake_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_journal_agent
      ON runtime_provider_continuity_journals(agent_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_journal_session
      ON runtime_provider_continuity_journals(session_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_journal_wake
      ON runtime_provider_continuity_journals(state, wake_at);

    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_target_health (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      health_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(agent_id, provider, model)
    );

    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_effects (
      effect_id TEXT PRIMARY KEY,
      logical_request_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_effect_request
      ON runtime_provider_continuity_effects(logical_request_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_batches (
      batch_id TEXT PRIMARY KEY,
      plan_hash TEXT NOT NULL UNIQUE,
      batch_json TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      approval_ref TEXT,
      idempotency_key TEXT UNIQUE,
      request_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_batch_status
      ON runtime_provider_continuity_batches(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS runtime_provider_continuity_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      logical_request_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      spec_version TEXT NOT NULL,
      compatibility_snapshot_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_event_request
      ON runtime_provider_continuity_events(logical_request_id, event_id ASC);
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_continuity_event_agent
      ON runtime_provider_continuity_events(agent_id, event_id ASC);
  `);
}

function parseJson<T>(raw: string, schema: { parse(value: unknown): T }, entity: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ProviderContinuityStoreError(
      "invalid_persisted_state",
      `Invalid persisted provider continuity ${entity}.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function rowToPolicy(row: PolicyRow): ProviderContinuityPolicy {
  const config = parseJson(row.policy_json, providerContinuityPolicyConfigSchema, "policy");
  return providerContinuityPolicySchema.parse({
    ...config,
    agentId: row.agent_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function getProviderContinuityPolicy(agentId: string, db: Database = getDb()): ProviderContinuityPolicy | null {
  ensureProviderContinuityTables(db);
  const row = db.prepare("SELECT * FROM runtime_provider_continuity_policies WHERE agent_id = ?").get(agentId.trim()) as
    | PolicyRow
    | undefined;
  return row ? rowToPolicy(row) : null;
}

export function listProviderContinuityPolicies(db: Database = getDb()): ProviderContinuityPolicy[] {
  ensureProviderContinuityTables(db);
  const rows = db
    .prepare("SELECT * FROM runtime_provider_continuity_policies ORDER BY agent_id ASC")
    .all() as PolicyRow[];
  return rows.map(rowToPolicy);
}

export interface PolicyWriteResult {
  changed: boolean;
  before: ProviderContinuityPolicy | null;
  after: ProviderContinuityPolicy | null;
}

export function writeProviderContinuityPolicy(input: {
  agentId: string;
  expectedVersion: number;
  policy: ProviderContinuityPolicyConfig | null;
  now?: number;
  db?: Database;
}): PolicyWriteResult {
  const db = input.db ?? getDb();
  ensureProviderContinuityTables(db);
  const agentId = input.agentId.trim();
  const now = input.now ?? Date.now();
  const normalizedPolicy = input.policy ? providerContinuityPolicyConfigSchema.parse(input.policy) : null;

  return executeWrite(
    db,
    (tx) => {
      const row = tx.prepare("SELECT * FROM runtime_provider_continuity_policies WHERE agent_id = ?").get(agentId) as
        | PolicyRow
        | undefined;
      const before = row ? rowToPolicy(row) : null;
      const actualVersion = before?.version ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new ProviderContinuityStoreError(
          "stale",
          `Policy version for agent '${agentId}' is ${actualVersion}, expected ${input.expectedVersion}.`,
          { agentId, actualVersion, expectedVersion: input.expectedVersion },
        );
      }

      if (!normalizedPolicy) {
        if (!before) {
          return { changed: false, before: null, after: null };
        }
        tx.prepare("DELETE FROM runtime_provider_continuity_policies WHERE agent_id = ? AND version = ?").run(
          agentId,
          actualVersion,
        );
        return { changed: true, before, after: null };
      }

      if (before && JSON.stringify(policyConfigFromPolicy(before)) === JSON.stringify(normalizedPolicy)) {
        return { changed: false, before, after: before };
      }

      const nextVersion = actualVersion + 1;
      const createdAt = before?.createdAt ?? now;
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_policies
           (agent_id, policy_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           policy_json = excluded.policy_json,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      ).run(agentId, JSON.stringify(normalizedPolicy), nextVersion, createdAt, now);
      const after = providerContinuityPolicySchema.parse({
        ...normalizedPolicy,
        agentId,
        version: nextVersion,
        createdAt,
        updatedAt: now,
      });
      return { changed: true, before, after };
    },
    { label: "provider-continuity-policy-write" },
  );
}

function policyConfigFromPolicy(policy: ProviderContinuityPolicy): ProviderContinuityPolicyConfig {
  return providerContinuityPolicyConfigSchema.parse({
    specVersion: policy.specVersion,
    compatibilitySnapshotId: policy.compatibilitySnapshotId,
    strategy: policy.strategy,
    targets: policy.targets,
    deadlineMs: policy.deadlineMs,
    enabled: policy.enabled,
  });
}

function rowToJournal(row: JournalRow): ProviderContinuityJournal {
  return parseJson(row.journal_json, providerContinuityJournalSchema, "journal");
}

export function getProviderContinuityJournal(
  logicalRequestId: string,
  db: Database = getDb(),
): ProviderContinuityJournal | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare("SELECT * FROM runtime_provider_continuity_journals WHERE logical_request_id = ?")
    .get(logicalRequestId.trim()) as JournalRow | undefined;
  return row ? rowToJournal(row) : null;
}

export function requireProviderContinuityJournal(
  logicalRequestId: string,
  db: Database = getDb(),
): ProviderContinuityJournal {
  const journal = getProviderContinuityJournal(logicalRequestId, db);
  if (!journal) {
    throw new ProviderContinuityStoreError("not_found", `Provider continuity journal not found: ${logicalRequestId}.`, {
      logicalRequestId,
    });
  }
  return journal;
}

export function getActiveProviderContinuityJournalForSession(
  sessionName: string,
  db: Database = getDb(),
): ProviderContinuityJournal | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare(
      `SELECT * FROM runtime_provider_continuity_journals
       WHERE session_name = ?
         AND state IN ('pending','running','waiting','hold','reconciliation_required')
       ORDER BY
         CASE state
           WHEN 'running' THEN 0
           WHEN 'pending' THEN 1
           WHEN 'waiting' THEN 2
           WHEN 'reconciliation_required' THEN 3
           ELSE 4
         END ASC,
         created_at ASC
       LIMIT 1`,
    )
    .get(sessionName.trim()) as JournalRow | undefined;
  return row ? rowToJournal(row) : null;
}

function terminalOutcomeIsSet(journal: ProviderContinuityJournal): boolean {
  return journal.terminalOutcome !== null;
}

export function saveProviderContinuityJournal(
  input: ProviderContinuityJournal,
  db: Database = getDb(),
): ProviderContinuityJournal {
  ensureProviderContinuityTables(db);
  const journal = providerContinuityJournalSchema.parse(input);
  if (journal.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    throw new ProviderContinuityStoreError("snapshot_conflict", "Journal compatibility snapshot mismatch.");
  }

  return executeWrite(
    db,
    (tx) => {
      const existingRow = tx
        .prepare("SELECT * FROM runtime_provider_continuity_journals WHERE logical_request_id = ?")
        .get(journal.logicalRequestId) as JournalRow | undefined;
      const existing = existingRow ? rowToJournal(existingRow) : null;
      if (
        existing &&
        terminalOutcomeIsSet(existing) &&
        (!terminalOutcomeIsSet(journal) || existing.terminalOutcome !== journal.terminalOutcome)
      ) {
        throw new ProviderContinuityStoreError(
          "terminal_conflict",
          `Logical request '${journal.logicalRequestId}' already has terminal outcome '${existing.terminalOutcome}'.`,
          { existing: existing.terminalOutcome, attempted: journal.terminalOutcome },
        );
      }
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_journals
           (logical_request_id, agent_id, session_name, state, journal_json, deadline_at, wake_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(logical_request_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           session_name = excluded.session_name,
           state = excluded.state,
           journal_json = excluded.journal_json,
           deadline_at = excluded.deadline_at,
           wake_at = excluded.wake_at,
           updated_at = excluded.updated_at`,
      ).run(
        journal.logicalRequestId,
        journal.agentId,
        journal.sessionName,
        journal.state,
        JSON.stringify(journal),
        journal.deadlineAt,
        journal.wakeAt,
        journal.createdAt,
        journal.updatedAt,
      );
      return journal;
    },
    { label: "provider-continuity-journal-save" },
  );
}

function rowToHealth(row: HealthRow): ProviderContinuityHealth {
  return parseJson(row.health_json, providerContinuityHealthSchema, "target health");
}

export function getProviderContinuityHealth(
  agentId: string,
  provider: string,
  model: string,
  db: Database = getDb(),
): ProviderContinuityHealth | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare(
      `SELECT * FROM runtime_provider_continuity_target_health
       WHERE agent_id = ? AND provider = ? AND model = ?`,
    )
    .get(agentId.trim(), provider.trim(), model.trim()) as HealthRow | undefined;
  return row ? rowToHealth(row) : null;
}

export function listProviderContinuityHealth(agentId: string, db: Database = getDb()): ProviderContinuityHealth[] {
  ensureProviderContinuityTables(db);
  const rows = db
    .prepare(
      `SELECT * FROM runtime_provider_continuity_target_health
       WHERE agent_id = ?
       ORDER BY provider ASC, model ASC`,
    )
    .all(agentId.trim()) as HealthRow[];
  return rows.map(rowToHealth);
}

export function saveProviderContinuityHealth(
  input: ProviderContinuityHealth,
  db: Database = getDb(),
): ProviderContinuityHealth {
  ensureProviderContinuityTables(db);
  const health = providerContinuityHealthSchema.parse(input);
  executeWrite(
    db,
    (tx) => {
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_target_health
           (agent_id, provider, model, health_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, provider, model) DO UPDATE SET
           health_json = excluded.health_json,
           updated_at = excluded.updated_at`,
      ).run(health.agentId, health.provider, health.model, JSON.stringify(health), health.updatedAt);
    },
    { label: "provider-continuity-health-save" },
  );
  return health;
}

function rowToEffect(row: EffectRow): ProviderContinuityEffect {
  return parseJson(row.effect_json, providerContinuityEffectSchema, "effect");
}

export function getProviderContinuityEffect(effectId: string, db: Database = getDb()): ProviderContinuityEffect | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare("SELECT * FROM runtime_provider_continuity_effects WHERE effect_id = ?")
    .get(effectId.trim()) as EffectRow | undefined;
  return row ? rowToEffect(row) : null;
}

export function listProviderContinuityEffects(
  logicalRequestId: string,
  db: Database = getDb(),
): ProviderContinuityEffect[] {
  ensureProviderContinuityTables(db);
  const rows = db
    .prepare(
      `SELECT * FROM runtime_provider_continuity_effects
       WHERE logical_request_id = ?
       ORDER BY created_at ASC, effect_id ASC`,
    )
    .all(logicalRequestId.trim()) as EffectRow[];
  return rows.map(rowToEffect);
}

export function saveProviderContinuityEffect(
  input: ProviderContinuityEffect,
  db: Database = getDb(),
): ProviderContinuityEffect {
  ensureProviderContinuityTables(db);
  const effect = providerContinuityEffectSchema.parse(input);
  return executeWrite(
    db,
    (tx) => {
      const existingRow = tx
        .prepare("SELECT * FROM runtime_provider_continuity_effects WHERE effect_id = ?")
        .get(effect.effectId) as EffectRow | undefined;
      if (existingRow) {
        const existing = rowToEffect(existingRow);
        if (
          existing.logicalRequestId !== effect.logicalRequestId ||
          existing.toolCallId !== effect.toolCallId ||
          existing.operation !== effect.operation ||
          existing.inputFingerprint !== effect.inputFingerprint
        ) {
          throw new ProviderContinuityStoreError("conflict", `Effect id collision for '${effect.effectId}'.`, {
            effectId: effect.effectId,
          });
        }
      }
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_effects
           (effect_id, logical_request_id, tool_call_id, operation, input_fingerprint, status, effect_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(effect_id) DO UPDATE SET
           status = excluded.status,
           effect_json = excluded.effect_json,
           updated_at = excluded.updated_at`,
      ).run(
        effect.effectId,
        effect.logicalRequestId,
        effect.toolCallId,
        effect.operation,
        effect.inputFingerprint,
        effect.status,
        JSON.stringify(effect),
        effect.createdAt,
        effect.updatedAt,
      );
      return effect;
    },
    { label: "provider-continuity-effect-save" },
  );
}

function rowToBatch(row: BatchRow): ProviderContinuityBatch {
  return parseJson(row.batch_json, providerContinuityBatchSchema, "batch");
}

export function createProviderContinuityBatch(
  input: ProviderContinuityBatch,
  db: Database = getDb(),
): ProviderContinuityBatch {
  ensureProviderContinuityTables(db);
  const batch = providerContinuityBatchSchema.parse(input);
  executeWrite(
    db,
    (tx) => {
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_batches
           (batch_id, plan_hash, batch_json, status, expires_at, approval_ref, idempotency_key,
            request_fingerprint, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        batch.batchId,
        batch.plan.planHash,
        JSON.stringify(batch),
        batch.status,
        batch.plan.expiresAt,
        batch.approvalRef,
        batch.idempotencyKey,
        batch.requestFingerprint,
        batch.createdAt,
        batch.appliedAt,
      );
    },
    { label: "provider-continuity-batch-create" },
  );
  return batch;
}

export function getProviderContinuityBatchById(
  batchId: string,
  db: Database = getDb(),
): ProviderContinuityBatch | null {
  ensureProviderContinuityTables(db);
  const row = db.prepare("SELECT * FROM runtime_provider_continuity_batches WHERE batch_id = ?").get(batchId.trim()) as
    | BatchRow
    | undefined;
  return row ? rowToBatch(row) : null;
}

export function getProviderContinuityBatchByPlanHash(
  planHash: string,
  db: Database = getDb(),
): ProviderContinuityBatch | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare("SELECT * FROM runtime_provider_continuity_batches WHERE plan_hash = ?")
    .get(planHash.trim()) as BatchRow | undefined;
  return row ? rowToBatch(row) : null;
}

export function getProviderContinuityBatchByIdempotencyKey(
  idempotencyKey: string,
  db: Database = getDb(),
): ProviderContinuityBatch | null {
  ensureProviderContinuityTables(db);
  const row = db
    .prepare("SELECT * FROM runtime_provider_continuity_batches WHERE idempotency_key = ?")
    .get(idempotencyKey.trim()) as BatchRow | undefined;
  return row ? rowToBatch(row) : null;
}

export function saveProviderContinuityBatch(
  input: ProviderContinuityBatch,
  db: Database = getDb(),
): ProviderContinuityBatch {
  ensureProviderContinuityTables(db);
  const batch = providerContinuityBatchSchema.parse(input);
  return executeWrite(
    db,
    (tx) => {
      const existing = tx
        .prepare("SELECT * FROM runtime_provider_continuity_batches WHERE batch_id = ?")
        .get(batch.batchId) as BatchRow | undefined;
      if (!existing) {
        throw new ProviderContinuityStoreError("not_found", `Provider continuity batch not found: ${batch.batchId}.`);
      }
      if (existing.plan_hash !== batch.plan.planHash) {
        throw new ProviderContinuityStoreError("conflict", `Batch plan hash cannot change: ${batch.batchId}.`);
      }
      if (batch.idempotencyKey) {
        const keyOwner = tx
          .prepare(
            `SELECT batch_id, request_fingerprint
             FROM runtime_provider_continuity_batches
             WHERE idempotency_key = ? AND batch_id <> ?`,
          )
          .get(batch.idempotencyKey, batch.batchId) as
          | { batch_id: string; request_fingerprint: string | null }
          | undefined;
        if (keyOwner) {
          throw new ProviderContinuityStoreError(
            "conflict",
            `Idempotency key '${batch.idempotencyKey}' is already used by another apply request.`,
            { batchId: keyOwner.batch_id },
          );
        }
      }
      tx.prepare(
        `UPDATE runtime_provider_continuity_batches
         SET batch_json = ?, status = ?, approval_ref = ?, idempotency_key = ?,
             request_fingerprint = ?, applied_at = ?
         WHERE batch_id = ?`,
      ).run(
        JSON.stringify(batch),
        batch.status,
        batch.approvalRef,
        batch.idempotencyKey,
        batch.requestFingerprint,
        batch.appliedAt,
        batch.batchId,
      );
      return batch;
    },
    { label: "provider-continuity-batch-save" },
  );
}

function rowToEvent(row: EventRow): ProviderContinuityEvent {
  return providerContinuityEventSchema.parse({
    eventId: row.event_id,
    logicalRequestId: row.logical_request_id,
    agentId: row.agent_id,
    type: row.event_type,
    payload: parseJson(row.payload_json, { parse: (value) => value as Record<string, unknown> }, "event payload"),
    createdAt: row.created_at,
    specVersion: row.spec_version,
    compatibilitySnapshotId: row.compatibility_snapshot_id,
  });
}

export function appendProviderContinuityEvent(
  input: Omit<ProviderContinuityEvent, "eventId">,
  db: Database = getDb(),
): ProviderContinuityEvent {
  ensureProviderContinuityTables(db);
  if (input.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    throw new ProviderContinuityStoreError("snapshot_conflict", "Event compatibility snapshot mismatch.");
  }
  const eventId = executeWrite(
    db,
    (tx) => {
      const result = tx
        .prepare(
          `INSERT INTO runtime_provider_continuity_events
             (logical_request_id, agent_id, event_type, payload_json, created_at, spec_version, compatibility_snapshot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.logicalRequestId,
          input.agentId,
          input.type,
          JSON.stringify(input.payload),
          input.createdAt,
          input.specVersion,
          input.compatibilitySnapshotId,
        );
      return Number(result.lastInsertRowid);
    },
    { label: "provider-continuity-event-append" },
  );
  return providerContinuityEventSchema.parse({ ...input, eventId });
}

export function listProviderContinuityEvents(input: {
  logicalRequestId: string;
  afterEventId?: number;
  limit?: number;
  db?: Database;
}): { events: ProviderContinuityEvent[]; hasMore: boolean } {
  const db = input.db ?? getDb();
  ensureProviderContinuityTables(db);
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT * FROM runtime_provider_continuity_events
       WHERE logical_request_id = ? AND event_id > ?
       ORDER BY event_id ASC
       LIMIT ?`,
    )
    .all(input.logicalRequestId.trim(), input.afterEventId ?? 0, limit + 1) as EventRow[];
  return {
    events: rows.slice(0, limit).map(rowToEvent),
    hasMore: rows.length > limit,
  };
}

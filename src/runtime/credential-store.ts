import { createHash, randomUUID } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import { normalizeLimitOffsetPage, type ListPage } from "../utils/pagination.js";
import type {
  RuntimeCredentialFailureSignal,
  RuntimeCredentialHealth,
  RuntimeCredentialInput,
  RuntimeCredentialProviderHealth,
  RuntimeCredentialRecord,
  RuntimeCredentialSecretBinding,
  RuntimeCredentialStatus,
} from "./credential-types.js";

interface RuntimeCredentialRow {
  id: string;
  label: string;
  runtime_provider: string;
  upstream_provider: string | null;
  model_allowlist_json: string | null;
  model_denylist_json: string | null;
  agent_allowlist_json: string | null;
  task_profile_allowlist_json: string | null;
  priority: number;
  weight: number | null;
  enabled: number;
  status: RuntimeCredentialStatus;
  auth_method: string | null;
  source_kind: string | null;
  strategy_hint: string | null;
  session_compatibility_key: string | null;
  auth_profile_ref: string | null;
  fingerprint: string;
  sensitive_env_keys_json: string | null;
  remote_forward_env_keys_json: string | null;
  last_error_code: string | null;
  last_error_reason: string | null;
  last_error_message_redacted: string | null;
  reset_at: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeCredentialSecretBindingRow {
  id: string;
  credential_id: string;
  source_kind: RuntimeCredentialSecretBinding["sourceKind"];
  target_kind: RuntimeCredentialSecretBinding["targetKind"];
  target_name: string;
  secret_ref: string;
  source_hint: string | null;
  sensitive: number;
  remote_forward: number;
  created_at: number;
  updated_at: number;
}

interface RuntimeCredentialHealthRow {
  credential_id: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  cooldown_until: number | null;
  reset_at: number | null;
  consecutive_failures: number;
  request_count: number;
  last_failure_kind: RuntimeCredentialHealth["lastFailureKind"] | null;
  last_failure_confidence: RuntimeCredentialHealth["lastFailureConfidence"] | null;
  last_request_id: string | null;
  updated_at: number;
}

interface RuntimeProviderHealthRow {
  id: string;
  runtime_provider: string;
  upstream_provider: string | null;
  model: string | null;
  scope: string | null;
  kind: RuntimeCredentialProviderHealth["kind"];
  cooldown_until: number | null;
  last_request_id: string | null;
  reason: string | null;
  updated_at: number;
}

export interface ListRuntimeCredentialsOptions {
  runtimeProvider?: string;
  upstreamProvider?: string;
  status?: RuntimeCredentialStatus;
  includeDisabled?: boolean;
  limit?: number | string | null;
  offset?: number | string | null;
}

export interface RuntimeCredentialHealthTransition {
  credential: RuntimeCredentialRecord;
  health: RuntimeCredentialHealth;
  providerHealth?: RuntimeCredentialProviderHealth;
}

export type RuntimeCredentialAttemptStatus = "reserved" | "started" | "succeeded" | "failed" | "abandoned";

export interface RuntimeCredentialAttemptReservationInput {
  credentialId: string;
  sessionKey?: string;
  sessionName?: string;
  runId?: string;
  turnId?: string;
  runtimeProvider: string;
  upstreamProvider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface RuntimeCredentialAttemptCompletionInput {
  status: Exclude<RuntimeCredentialAttemptStatus, "reserved" | "started">;
  signal?: RuntimeCredentialFailureSignal;
  metadata?: Record<string, unknown>;
  now?: number;
}

export function ensureRuntimeCredentialTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_credentials (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      runtime_provider TEXT NOT NULL,
      upstream_provider TEXT,
      model_allowlist_json TEXT,
      model_denylist_json TEXT,
      agent_allowlist_json TEXT,
      task_profile_allowlist_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      weight INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      status TEXT NOT NULL DEFAULT 'healthy',
      auth_method TEXT,
      source_kind TEXT,
      strategy_hint TEXT,
      session_compatibility_key TEXT,
      auth_profile_ref TEXT,
      fingerprint TEXT NOT NULL,
      sensitive_env_keys_json TEXT,
      remote_forward_env_keys_json TEXT,
      last_error_code TEXT,
      last_error_reason TEXT,
      last_error_message_redacted TEXT,
      reset_at INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_credentials_provider ON runtime_credentials(runtime_provider, upstream_provider);
    CREATE INDEX IF NOT EXISTS idx_runtime_credentials_status ON runtime_credentials(status, enabled);

    CREATE TABLE IF NOT EXISTS runtime_credential_secret_bindings (
      id TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL REFERENCES runtime_credentials(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_name TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      source_hint TEXT,
      sensitive INTEGER NOT NULL DEFAULT 1 CHECK(sensitive IN (0,1)),
      remote_forward INTEGER NOT NULL DEFAULT 0 CHECK(remote_forward IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_credential_bindings_credential ON runtime_credential_secret_bindings(credential_id);

    CREATE TABLE IF NOT EXISTS runtime_credential_health (
      credential_id TEXT PRIMARY KEY REFERENCES runtime_credentials(id) ON DELETE CASCADE,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      cooldown_until INTEGER,
      reset_at INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_failure_kind TEXT,
      last_failure_confidence TEXT,
      last_request_id TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_credential_attempts (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      session_name TEXT,
      run_id TEXT,
      turn_id TEXT,
      runtime_provider TEXT NOT NULL,
      upstream_provider TEXT,
      model TEXT,
      credential_id TEXT REFERENCES runtime_credentials(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      classifier_kind TEXT,
      classifier_confidence TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_credential_attempts_credential ON runtime_credential_attempts(credential_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS runtime_provider_health (
      id TEXT PRIMARY KEY,
      runtime_provider TEXT NOT NULL,
      upstream_provider TEXT,
      model TEXT,
      scope TEXT,
      kind TEXT NOT NULL,
      cooldown_until INTEGER,
      last_request_id TEXT,
      reason TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_provider_health_provider ON runtime_provider_health(runtime_provider, upstream_provider, cooldown_until);
  `);
}

export function createRuntimeCredential(input: RuntimeCredentialInput): RuntimeCredentialRecord {
  ensureRuntimeCredentialTables();
  validateRuntimeCredentialInput(input);
  const now = Date.now();
  const id = input.id?.trim() || `rcred_${randomUUID()}`;
  const enabled = input.enabled ?? true;
  const status: RuntimeCredentialStatus = enabled ? (input.status ?? "healthy") : "disabled";
  const fingerprint = computeRuntimeCredentialFingerprint({ ...input, id });
  const sensitiveEnvKeys = input.sensitiveEnvKeys ?? inferSensitiveEnvKeys(input);
  const remoteForwardEnvKeys = input.remoteForwardEnvKeys ?? inferRemoteForwardEnvKeys(input);

  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT INTO runtime_credentials (
          id, label, runtime_provider, upstream_provider, model_allowlist_json, model_denylist_json,
          agent_allowlist_json, task_profile_allowlist_json, priority, weight, enabled, status,
          auth_method, source_kind, strategy_hint, session_compatibility_key, auth_profile_ref, fingerprint,
          sensitive_env_keys_json, remote_forward_env_keys_json, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        input.label.trim(),
        input.runtimeProvider.trim(),
        normalizeOptional(input.upstreamProvider),
        stringifyList(input.modelAllowlist),
        stringifyList(input.modelDenylist),
        stringifyList(input.agentAllowlist),
        stringifyList(input.taskProfileAllowlist),
        input.priority ?? 0,
        input.weight ?? null,
        enabled ? 1 : 0,
        status,
        normalizeOptional(input.authMethod),
        normalizeOptional(input.sourceKind),
        normalizeOptional(input.strategyHint),
        normalizeOptional(input.sessionCompatibilityKey) ?? fingerprint,
        normalizeOptional(input.authProfileRef),
        fingerprint,
        JSON.stringify(sensitiveEnvKeys),
        JSON.stringify(remoteForwardEnvKeys),
        normalizeOptional(input.notes),
        now,
        now,
      );

      for (const binding of input.bindings) {
        db.prepare(
          `
          INSERT INTO runtime_credential_secret_bindings (
            id, credential_id, source_kind, target_kind, target_name, secret_ref, source_hint,
            sensitive, remote_forward, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          binding.id?.trim() || `rcbind_${randomUUID()}`,
          id,
          binding.sourceKind,
          binding.targetKind,
          binding.targetName.trim(),
          binding.secretRef.trim(),
          normalizeOptional(binding.sourceHint),
          binding.sensitive ? 1 : 0,
          binding.remoteForward ? 1 : 0,
          now,
          now,
        );
      }

      db.prepare(
        `
        INSERT INTO runtime_credential_health (
          credential_id, consecutive_failures, request_count, updated_at
        ) VALUES (?, 0, 0, ?)
      `,
      ).run(id, now);
    },
    { label: "runtime-credential-create" },
  );

  return getRuntimeCredential(id) ?? failMissingCredential(id);
}

export function getRuntimeCredential(id: string): RuntimeCredentialRecord | null {
  ensureRuntimeCredentialTables();
  const db = getDb();
  const row = db.prepare("SELECT * FROM runtime_credentials WHERE id = ?").get(id) as RuntimeCredentialRow | undefined;
  if (!row) return null;
  const bindings = db
    .prepare("SELECT * FROM runtime_credential_secret_bindings WHERE credential_id = ? ORDER BY created_at ASC, id ASC")
    .all(id) as RuntimeCredentialSecretBindingRow[];
  return rowToCredential(row, bindings);
}

export function listRuntimeCredentials(options: ListRuntimeCredentialsOptions = {}): ListPage<RuntimeCredentialRecord> {
  ensureRuntimeCredentialTables();
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.runtimeProvider) {
    where.push("runtime_provider = ?");
    params.push(options.runtimeProvider);
  }
  if (options.upstreamProvider) {
    where.push("upstream_provider = ?");
    params.push(options.upstreamProvider);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  if (!options.includeDisabled) {
    where.push("enabled = 1");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM runtime_credentials ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  const rows = db
    .prepare(
      `
      SELECT * FROM runtime_credentials
      ${whereSql}
      ORDER BY priority DESC, updated_at DESC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as RuntimeCredentialRow[];
  const ids = rows.map((row) => row.id);
  const bindings = ids.length
    ? (db
        .prepare(
          `
          SELECT * FROM runtime_credential_secret_bindings
          WHERE credential_id IN (${ids.map(() => "?").join(",")})
          ORDER BY created_at ASC, id ASC
        `,
        )
        .all(...ids) as RuntimeCredentialSecretBindingRow[])
    : [];
  const byCredential = new Map<string, RuntimeCredentialSecretBindingRow[]>();
  for (const binding of bindings) {
    const list = byCredential.get(binding.credential_id) ?? [];
    list.push(binding);
    byCredential.set(binding.credential_id, list);
  }
  return {
    items: rows.map((row) => rowToCredential(row, byCredential.get(row.id) ?? [])),
    total: totalRow?.total ?? 0,
    limit,
    offset,
  };
}

export function getRuntimeCredentialHealth(credentialId: string): RuntimeCredentialHealth | null {
  ensureRuntimeCredentialTables();
  const row = getDb().prepare("SELECT * FROM runtime_credential_health WHERE credential_id = ?").get(credentialId) as
    | RuntimeCredentialHealthRow
    | undefined;
  return row ? rowToHealth(row) : null;
}

export function setRuntimeCredentialEnabled(id: string, enabled: boolean): RuntimeCredentialRecord {
  ensureRuntimeCredentialTables();
  const now = Date.now();
  executeWrite(
    getDb(),
    (db) => {
      const existing = db.prepare("SELECT id, status FROM runtime_credentials WHERE id = ?").get(id) as
        | { id: string; status: RuntimeCredentialStatus }
        | undefined;
      if (!existing) throw new Error(`Runtime credential not found: ${id}`);
      const status = enabled && existing.status === "disabled" ? "healthy" : !enabled ? "disabled" : existing.status;
      db.prepare("UPDATE runtime_credentials SET enabled = ?, status = ?, updated_at = ? WHERE id = ?").run(
        enabled ? 1 : 0,
        status,
        now,
        id,
      );
    },
    { label: "runtime-credential-enabled" },
  );
  return getRuntimeCredential(id) ?? failMissingCredential(id);
}

export function resetRuntimeCredentialHealth(id: string): RuntimeCredentialHealthTransition {
  ensureRuntimeCredentialTables();
  const now = Date.now();
  executeWrite(
    getDb(),
    (db) => {
      const existing = db.prepare("SELECT id FROM runtime_credentials WHERE id = ?").get(id);
      if (!existing) throw new Error(`Runtime credential not found: ${id}`);
      db.prepare(
        `
        UPDATE runtime_credentials
        SET status = CASE WHEN enabled = 1 THEN 'healthy' ELSE 'disabled' END,
            last_error_code = NULL,
            last_error_reason = NULL,
            last_error_message_redacted = NULL,
            reset_at = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      ).run(now, id);
      db.prepare(
        `
        UPDATE runtime_credential_health
        SET cooldown_until = NULL,
            reset_at = NULL,
            consecutive_failures = 0,
            last_failure_kind = NULL,
            last_failure_confidence = NULL,
            last_request_id = NULL,
            updated_at = ?
        WHERE credential_id = ?
      `,
      ).run(now, id);
    },
    { label: "runtime-credential-reset-health" },
  );
  return {
    credential: getRuntimeCredential(id) ?? failMissingCredential(id),
    health: getRuntimeCredentialHealth(id) ?? failMissingHealth(id),
  };
}

export function getRuntimeCredentialActiveAttemptCount(credentialId: string): number {
  ensureRuntimeCredentialTables();
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM runtime_credential_attempts
      WHERE credential_id = ?
        AND completed_at IS NULL
        AND status IN ('reserved', 'started')
    `,
    )
    .get(credentialId) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function reserveRuntimeCredentialAttempt(input: RuntimeCredentialAttemptReservationInput): string {
  ensureRuntimeCredentialTables();
  const now = input.now ?? Date.now();
  const id = `rcatt_${randomUUID()}`;
  executeWrite(
    getDb(),
    (db) => {
      const existing = db.prepare("SELECT id FROM runtime_credentials WHERE id = ?").get(input.credentialId);
      if (!existing) throw new Error(`Runtime credential not found: ${input.credentialId}`);
      db.prepare(
        `
        INSERT INTO runtime_credential_attempts (
          id, session_key, session_name, run_id, turn_id, runtime_provider, upstream_provider,
          model, credential_id, status, started_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `,
      ).run(
        id,
        input.sessionKey ?? null,
        input.sessionName ?? null,
        input.runId ?? null,
        input.turnId ?? null,
        input.runtimeProvider,
        input.upstreamProvider ?? null,
        input.model ?? null,
        input.credentialId,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    },
    { label: "runtime-credential-attempt-reserve" },
  );
  return id;
}

export function markRuntimeCredentialAttemptStarted(attemptId: string | undefined, now = Date.now()): void {
  if (!attemptId) return;
  ensureRuntimeCredentialTables();
  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE runtime_credential_attempts
        SET status = 'started'
        WHERE id = ?
          AND completed_at IS NULL
          AND status = 'reserved'
      `,
      ).run(attemptId);
      db.prepare(
        `
        UPDATE runtime_credential_attempts
        SET started_at = COALESCE(started_at, ?)
        WHERE id = ?
      `,
      ).run(now, attemptId);
    },
    { label: "runtime-credential-attempt-start" },
  );
}

export function bindRuntimeCredentialAttemptTurn(attemptId: string | undefined, turnId: string | undefined): void {
  if (!attemptId || !turnId) return;
  ensureRuntimeCredentialTables();
  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE runtime_credential_attempts
        SET turn_id = COALESCE(turn_id, ?)
        WHERE id = ?
      `,
      ).run(turnId, attemptId);
    },
    { label: "runtime-credential-attempt-bind-turn" },
  );
}

export function completeRuntimeCredentialAttempt(
  attemptId: string | undefined,
  input: RuntimeCredentialAttemptCompletionInput,
): void {
  if (!attemptId) return;
  ensureRuntimeCredentialTables();
  const now = input.now ?? Date.now();
  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE runtime_credential_attempts
        SET status = ?,
            classifier_kind = ?,
            classifier_confidence = ?,
            completed_at = ?,
            metadata_json = ?
        WHERE id = ?
          AND completed_at IS NULL
      `,
      ).run(
        input.status,
        input.signal?.kind ?? null,
        input.signal?.confidence ?? null,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        attemptId,
      );
    },
    { label: "runtime-credential-attempt-complete" },
  );
}

export function recordRuntimeCredentialSuccess(
  credentialId: string,
  now = Date.now(),
): RuntimeCredentialHealthTransition {
  ensureRuntimeCredentialTables();
  executeWrite(
    getDb(),
    (db) => {
      const existing = db.prepare("SELECT id FROM runtime_credentials WHERE id = ?").get(credentialId);
      if (!existing) throw new Error(`Runtime credential not found: ${credentialId}`);
      db.prepare(
        `
        UPDATE runtime_credentials
        SET status = CASE WHEN enabled = 1 THEN 'healthy' ELSE 'disabled' END,
            reset_at = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      ).run(now, credentialId);
      db.prepare(
        `
        INSERT INTO runtime_credential_health (
          credential_id, last_success_at, consecutive_failures, request_count, updated_at
        ) VALUES (?, ?, 0, 1, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          last_success_at = excluded.last_success_at,
          cooldown_until = NULL,
          reset_at = NULL,
          consecutive_failures = 0,
          request_count = runtime_credential_health.request_count + 1,
          updated_at = excluded.updated_at
      `,
      ).run(credentialId, now, now);
    },
    { label: "runtime-credential-success" },
  );
  return {
    credential: getRuntimeCredential(credentialId) ?? failMissingCredential(credentialId),
    health: getRuntimeCredentialHealth(credentialId) ?? failMissingHealth(credentialId),
  };
}

export function recordRuntimeCredentialFailure(
  credentialId: string,
  signal: RuntimeCredentialFailureSignal,
  now = Date.now(),
): RuntimeCredentialHealthTransition {
  ensureRuntimeCredentialTables();
  const credential = getRuntimeCredential(credentialId);
  if (!credential) throw new Error(`Runtime credential not found: ${credentialId}`);
  const nextStatus = statusForFailure(credential, signal);
  const cooldownUntil = cooldownUntilForFailure(signal, now);
  const providerHealth = providerHealthForSignal(signal, now);

  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE runtime_credentials
        SET status = ?,
            last_error_code = ?,
            last_error_reason = ?,
            last_error_message_redacted = ?,
            reset_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      ).run(
        nextStatus,
        signal.providerCode ?? null,
        signal.kind,
        signal.message ?? null,
        signal.resetAt ?? cooldownUntil ?? null,
        now,
        credentialId,
      );
      db.prepare(
        `
        INSERT INTO runtime_credential_health (
          credential_id, last_failure_at, cooldown_until, reset_at, consecutive_failures,
          request_count, last_failure_kind, last_failure_confidence, last_request_id, updated_at
        ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          last_failure_at = excluded.last_failure_at,
          cooldown_until = excluded.cooldown_until,
          reset_at = excluded.reset_at,
          consecutive_failures = runtime_credential_health.consecutive_failures + 1,
          request_count = runtime_credential_health.request_count + 1,
          last_failure_kind = excluded.last_failure_kind,
          last_failure_confidence = excluded.last_failure_confidence,
          last_request_id = excluded.last_request_id,
          updated_at = excluded.updated_at
      `,
      ).run(
        credentialId,
        now,
        cooldownUntil ?? null,
        signal.resetAt ?? cooldownUntil ?? null,
        signal.kind,
        signal.confidence,
        signal.requestId ?? null,
        now,
      );

      if (providerHealth) {
        db.prepare(
          `
          INSERT INTO runtime_provider_health (
            id, runtime_provider, upstream_provider, model, scope, kind, cooldown_until, last_request_id, reason, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            cooldown_until = excluded.cooldown_until,
            last_request_id = excluded.last_request_id,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `,
        ).run(
          providerHealth.id,
          providerHealth.runtimeProvider,
          providerHealth.upstreamProvider ?? null,
          providerHealth.model ?? null,
          providerHealth.scope ?? null,
          providerHealth.kind,
          providerHealth.cooldownUntil ?? null,
          providerHealth.lastRequestId ?? null,
          providerHealth.reason ?? null,
          now,
        );
      }
    },
    { label: "runtime-credential-failure" },
  );

  return {
    credential: getRuntimeCredential(credentialId) ?? failMissingCredential(credentialId),
    health: getRuntimeCredentialHealth(credentialId) ?? failMissingHealth(credentialId),
    ...(providerHealth ? { providerHealth } : {}),
  };
}

export function recordRuntimeCredentialLimitPressure(
  credentialId: string,
  signal: RuntimeCredentialFailureSignal,
  now = Date.now(),
): RuntimeCredentialHealthTransition {
  ensureRuntimeCredentialTables();
  const credential = getRuntimeCredential(credentialId);
  if (!credential) throw new Error(`Runtime credential not found: ${credentialId}`);
  const cooldownUntil = limitPressureCooldownUntil(signal, now);

  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE runtime_credentials
        SET status = CASE WHEN enabled = 1 THEN 'cooldown' ELSE 'disabled' END,
            last_error_code = ?,
            last_error_reason = ?,
            last_error_message_redacted = ?,
            reset_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      ).run(
        signal.providerCode ?? null,
        "near_limit",
        signal.message ?? null,
        signal.resetAt ?? cooldownUntil,
        now,
        credentialId,
      );
      db.prepare(
        `
        INSERT INTO runtime_credential_health (
          credential_id, last_failure_at, cooldown_until, reset_at, consecutive_failures,
          request_count, last_failure_kind, last_failure_confidence, last_request_id, updated_at
        ) VALUES (?, NULL, ?, ?, 0, 1, NULL, NULL, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          last_failure_at = NULL,
          cooldown_until = excluded.cooldown_until,
          reset_at = excluded.reset_at,
          consecutive_failures = 0,
          request_count = runtime_credential_health.request_count + 1,
          last_failure_kind = NULL,
          last_failure_confidence = NULL,
          last_request_id = excluded.last_request_id,
          updated_at = excluded.updated_at
      `,
      ).run(credentialId, cooldownUntil, signal.resetAt ?? cooldownUntil, signal.requestId ?? null, now);
    },
    { label: "runtime-credential-limit-pressure" },
  );

  return {
    credential: getRuntimeCredential(credentialId) ?? failMissingCredential(credentialId),
    health: getRuntimeCredentialHealth(credentialId) ?? failMissingHealth(credentialId),
  };
}

export function listRuntimeProviderHealth(): RuntimeCredentialProviderHealth[] {
  ensureRuntimeCredentialTables();
  const rows = getDb()
    .prepare("SELECT * FROM runtime_provider_health ORDER BY updated_at DESC, id ASC")
    .all() as RuntimeProviderHealthRow[];
  return rows.map(rowToProviderHealth);
}

export function serializeRuntimeCredential(
  record: RuntimeCredentialRecord,
  options: { includeBindings?: boolean } = {},
) {
  const base = {
    id: record.id,
    label: record.label,
    runtimeProvider: record.runtimeProvider,
    upstreamProvider: record.upstreamProvider ?? null,
    modelAllowlist: record.modelAllowlist,
    modelDenylist: record.modelDenylist,
    agentAllowlist: record.agentAllowlist,
    taskProfileAllowlist: record.taskProfileAllowlist,
    priority: record.priority,
    weight: record.weight ?? null,
    enabled: record.enabled,
    status: record.status,
    authMethod: record.authMethod ?? null,
    sourceKind: record.sourceKind ?? null,
    strategyHint: record.strategyHint ?? null,
    sessionCompatibilityKey: record.sessionCompatibilityKey ?? null,
    authProfileRef: record.authProfileRef ? redactPath(record.authProfileRef) : null,
    fingerprint: record.fingerprint,
    sensitiveEnvKeys: record.sensitiveEnvKeys.map(redactEnvName),
    remoteForwardEnvKeys: record.remoteForwardEnvKeys.map(redactEnvName),
    lastErrorCode: record.lastErrorCode ?? null,
    lastErrorReason: record.lastErrorReason ?? null,
    lastErrorMessageRedacted: record.lastErrorMessageRedacted ?? null,
    resetAt: record.resetAt ?? null,
    notes: record.notes ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (!options.includeBindings) return base;
  return {
    ...base,
    bindings: record.bindings.map((binding) => ({
      id: binding.id,
      sourceKind: binding.sourceKind,
      targetKind: binding.targetKind,
      targetName: redactEnvName(binding.targetName),
      secretRef: redactSecretRef(binding.secretRef),
      sourceHint: binding.sourceHint ? redactEnvName(binding.sourceHint) : null,
      sensitive: binding.sensitive,
      remoteForward: binding.remoteForward,
    })),
  };
}

function validateRuntimeCredentialInput(input: RuntimeCredentialInput): void {
  if (!input.label.trim()) throw new Error("Credential label is required");
  if (!input.runtimeProvider.trim()) throw new Error("Runtime provider is required");
  if (!input.bindings.length) throw new Error("At least one secret binding is required");
  for (const binding of input.bindings) {
    if (!binding.targetName.trim()) throw new Error("Secret binding targetName is required");
    if (!binding.secretRef.trim()) throw new Error("Secret binding secretRef is required");
    if (binding.secretRef.includes("\n"))
      throw new Error("Secret binding secretRef must be a reference, not a raw multiline value");
  }
}

function rowToCredential(
  row: RuntimeCredentialRow,
  bindingRows: RuntimeCredentialSecretBindingRow[],
): RuntimeCredentialRecord {
  return {
    id: row.id,
    label: row.label,
    runtimeProvider: row.runtime_provider,
    ...(row.upstream_provider ? { upstreamProvider: row.upstream_provider } : {}),
    modelAllowlist: parseList(row.model_allowlist_json),
    modelDenylist: parseList(row.model_denylist_json),
    agentAllowlist: parseList(row.agent_allowlist_json),
    taskProfileAllowlist: parseList(row.task_profile_allowlist_json),
    priority: row.priority,
    ...(row.weight !== null ? { weight: row.weight } : {}),
    enabled: Boolean(row.enabled),
    status: row.status,
    ...(row.auth_method ? { authMethod: row.auth_method } : {}),
    ...(row.source_kind ? { sourceKind: row.source_kind as RuntimeCredentialRecord["sourceKind"] } : {}),
    ...(row.strategy_hint ? { strategyHint: row.strategy_hint as RuntimeCredentialRecord["strategyHint"] } : {}),
    ...(row.session_compatibility_key ? { sessionCompatibilityKey: row.session_compatibility_key } : {}),
    ...(row.auth_profile_ref ? { authProfileRef: row.auth_profile_ref } : {}),
    fingerprint: row.fingerprint,
    sensitiveEnvKeys: parseList(row.sensitive_env_keys_json),
    remoteForwardEnvKeys: parseList(row.remote_forward_env_keys_json),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_reason ? { lastErrorReason: row.last_error_reason } : {}),
    ...(row.last_error_message_redacted ? { lastErrorMessageRedacted: row.last_error_message_redacted } : {}),
    ...(row.reset_at !== null ? { resetAt: row.reset_at } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bindings: bindingRows.map(rowToBinding),
  };
}

function rowToBinding(row: RuntimeCredentialSecretBindingRow): RuntimeCredentialSecretBinding {
  return {
    id: row.id,
    credentialId: row.credential_id,
    sourceKind: row.source_kind,
    targetKind: row.target_kind,
    targetName: row.target_name,
    secretRef: row.secret_ref,
    ...(row.source_hint ? { sourceHint: row.source_hint } : {}),
    sensitive: Boolean(row.sensitive),
    remoteForward: Boolean(row.remote_forward),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHealth(row: RuntimeCredentialHealthRow): RuntimeCredentialHealth {
  return {
    credentialId: row.credential_id,
    ...(row.last_success_at !== null ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_failure_at !== null ? { lastFailureAt: row.last_failure_at } : {}),
    ...(row.cooldown_until !== null ? { cooldownUntil: row.cooldown_until } : {}),
    ...(row.reset_at !== null ? { resetAt: row.reset_at } : {}),
    consecutiveFailures: row.consecutive_failures,
    requestCount: row.request_count,
    ...(row.last_failure_kind ? { lastFailureKind: row.last_failure_kind } : {}),
    ...(row.last_failure_confidence ? { lastFailureConfidence: row.last_failure_confidence } : {}),
    ...(row.last_request_id ? { lastRequestId: row.last_request_id } : {}),
    updatedAt: row.updated_at,
  };
}

function rowToProviderHealth(row: RuntimeProviderHealthRow): RuntimeCredentialProviderHealth {
  return {
    id: row.id,
    runtimeProvider: row.runtime_provider,
    ...(row.upstream_provider ? { upstreamProvider: row.upstream_provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    kind: row.kind,
    ...(row.cooldown_until !== null ? { cooldownUntil: row.cooldown_until } : {}),
    ...(row.last_request_id ? { lastRequestId: row.last_request_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    updatedAt: row.updated_at,
  };
}

function statusForFailure(
  credential: RuntimeCredentialRecord,
  signal: RuntimeCredentialFailureSignal,
): RuntimeCredentialStatus {
  if (!credential.enabled) return "disabled";
  if (signal.kind === "rate_limited") return "cooldown";
  if (signal.kind === "quota_exhausted" || signal.kind === "billing_blocked") return "exhausted";
  if (signal.kind === "auth_invalid") return credential.authMethod?.includes("oauth") ? "needs_reauth" : "invalid";
  if (signal.kind === "permission_denied")
    return signal.scope === "credential" || signal.scope === "account" ? "invalid" : "healthy";
  return credential.status === "disabled" ? "disabled" : credential.status;
}

function cooldownUntilForFailure(signal: RuntimeCredentialFailureSignal, now: number): number | undefined {
  if (signal.resetAt) return signal.resetAt;
  if (signal.retryAfterMs) return now + signal.retryAfterMs;
  if (signal.kind === "rate_limited") return now + 60_000;
  if (signal.kind === "quota_exhausted" || signal.kind === "billing_blocked") return now + 24 * 60 * 60_000;
  return undefined;
}

function limitPressureCooldownUntil(signal: RuntimeCredentialFailureSignal, now: number): number {
  if (signal.resetAt) return signal.resetAt;
  for (const dimension of signal.limitDimensions ?? []) {
    if (dimension.resetAt) return dimension.resetAt;
  }
  return now + 60_000;
}

function providerHealthForSignal(
  signal: RuntimeCredentialFailureSignal,
  now: number,
): RuntimeCredentialProviderHealth | undefined {
  if (signal.scope !== "provider" && signal.kind !== "provider_overloaded" && signal.kind !== "network_transient") {
    return undefined;
  }
  const id = [
    "provider",
    signal.runtimeProvider,
    signal.upstreamProvider ?? "_",
    signal.model ?? "_",
    signal.scope ?? "provider",
  ].join(":");
  return {
    id,
    runtimeProvider: signal.runtimeProvider,
    ...(signal.upstreamProvider ? { upstreamProvider: signal.upstreamProvider } : {}),
    ...(signal.model ? { model: signal.model } : {}),
    scope: signal.scope ?? "provider",
    kind: signal.kind,
    cooldownUntil: cooldownUntilForFailure(signal, now) ?? now + 60_000,
    ...(signal.requestId ? { lastRequestId: signal.requestId } : {}),
    ...(signal.message ? { reason: signal.message } : {}),
    updatedAt: now,
  };
}

function computeRuntimeCredentialFingerprint(input: RuntimeCredentialInput & { id: string }): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      id: input.id,
      label: input.label,
      runtimeProvider: input.runtimeProvider,
      upstreamProvider: input.upstreamProvider ?? null,
      authMethod: input.authMethod ?? null,
      authProfileRef: input.authProfileRef ?? null,
      bindings: input.bindings.map((binding) => ({
        sourceKind: binding.sourceKind,
        targetKind: binding.targetKind,
        targetName: binding.targetName,
        secretRef: binding.secretRef,
      })),
    }),
  );
  return `sha256:${hash.digest("hex").slice(0, 24)}`;
}

function inferSensitiveEnvKeys(input: RuntimeCredentialInput): string[] {
  return uniqueStrings(
    input.bindings.flatMap((binding) => {
      const keys = [];
      if (binding.sourceKind === "env") keys.push(envNameFromSecretRef(binding.secretRef));
      if (binding.targetKind === "env") keys.push(binding.targetName);
      return keys.filter(Boolean) as string[];
    }),
  );
}

function inferRemoteForwardEnvKeys(input: RuntimeCredentialInput): string[] {
  return uniqueStrings(
    input.bindings
      .filter((binding) => binding.remoteForward && binding.targetKind === "env")
      .map((binding) => binding.targetName),
  );
}

function stringifyList(value: string[] | undefined): string | null {
  const normalized = uniqueStrings(value ?? []);
  return normalized.length ? JSON.stringify(normalized) : null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    return [];
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function normalizeOptional(value: string | undefined | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function envNameFromSecretRef(secretRef: string): string | null {
  return secretRef.startsWith("env:") ? secretRef.slice("env:".length) : null;
}

function redactSecretRef(secretRef: string): string {
  if (secretRef.startsWith("env:")) return `env:${redactEnvName(secretRef.slice(4))}`;
  if (secretRef.startsWith("file:")) return `file:${redactPath(secretRef.slice(5))}`;
  const [kind] = secretRef.split(":", 1);
  return kind ? `${kind}:[redacted]` : "[redacted]";
}

function redactEnvName(value: string): string {
  if (!value) return value;
  const parts = value.split("_");
  if (parts.length <= 2) return value;
  return `${parts[0]}_${parts[1]}_[redacted]`;
}

function redactPath(value: string): string {
  return value.replace(/\/Users\/[^/]+/g, "/Users/[redacted]");
}

function failMissingCredential(id: string): never {
  throw new Error(`Runtime credential not found after write: ${id}`);
}

function failMissingHealth(id: string): never {
  throw new Error(`Runtime credential health not found after write: ${id}`);
}

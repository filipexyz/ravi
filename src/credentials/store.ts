import { configureStateJournalMode, initializeStateSchema } from "../db/schema-owner.js";
import { assertDatabaseTargetAllowed, openStateDatabase } from "../db/state-boundary.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Database, type SQLQueryBindings } from "bun:sqlite";
import { executeWrite, resetWriteCounter } from "../db/write-retry.js";
import { buildSqlWhereClause, countRows, normalizeLimitOffsetPage } from "../utils/pagination.js";
import { getCredentialsDbPath } from "../db/state-paths.js";
export { getCredentialsDbPath } from "../db/state-paths.js";
import type {
  CredentialAuditEvent,
  CredentialAuditEventInput,
  CredentialBackend,
  CredentialConnectionPage,
  CredentialConnectionRecord,
  CredentialConnectionStatus,
} from "./types.js";

interface CredentialConnectionRow {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: string;
  secret_ref: string;
  status: string;
  created_at: number;
  updated_at: number;
  owner: string | null;
  purpose: string | null;
  rotated_at: number | null;
  expires_at: number | null;
  disabled_at: number | null;
}

/** Lifecycle columns added after the first schema; nullable, never a secret. */
const LIFECYCLE_COLUMNS = [
  ["owner", "TEXT"],
  ["purpose", "TEXT"],
  ["rotated_at", "INTEGER"],
  ["expires_at", "INTEGER"],
  ["disabled_at", "INTEGER"],
] as const;

interface CredentialDbHandle {
  db: Database;
  path: string;
}

let handle: CredentialDbHandle | null = null;

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
}

export interface UpsertCredentialConnectionInput {
  provider: string;
  connection: string;
  label?: string | null;
  backend: CredentialBackend;
  secretRef: string;
  scopes?: string[];
  status?: CredentialConnectionStatus;
  now?: number;
  /** Lifecycle metadata. `undefined` keeps what is stored; `null` clears it. */
  owner?: string | null;
  purpose?: string | null;
  expiresAt?: number | null;
  /** Set when a new secret value was written for an existing connection. */
  rotatedAt?: number | null;
}

export interface ListCredentialConnectionsInput {
  provider?: string;
  status?: CredentialConnectionStatus;
  includeDisabled?: boolean;
  limit?: number | string | null;
  offset?: number | string | null;
}

export function ensureCredentialTables(options: CredentialStoreOptions = {}): void {
  ensureSchema(getCredentialDb(options));
}

export function getCredentialConnection(
  provider: string,
  connection: string,
  options: CredentialStoreOptions = {},
): CredentialConnectionRecord | null {
  ensureCredentialTables(options);
  const providerId = normalizeCredentialIdentifier(provider, "provider");
  const connectionId = normalizeCredentialIdentifier(connection, "connection");
  const row = getCredentialDb(options)
    .prepare("SELECT * FROM credential_connections WHERE provider = ? AND connection = ?")
    .get(providerId, connectionId) as CredentialConnectionRow | null;
  return row ? hydrateConnection(row, options) : null;
}

export function listCredentialConnections(
  input: ListCredentialConnectionsInput = {},
  options: CredentialStoreOptions = {},
): CredentialConnectionPage {
  ensureCredentialTables(options);
  const page = normalizeLimitOffsetPage(input, { defaultLimit: 50, maxLimit: 500 });
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (input.provider) {
    where.push("provider = ?");
    params.push(normalizeCredentialIdentifier(input.provider, "provider"));
  }
  if (input.status) {
    where.push("status = ?");
    params.push(requireConnectionStatus(input.status));
  } else if (!input.includeDisabled) {
    where.push("status = 'active'");
  }
  const db = getCredentialDb(options);
  const total = countRows({ db, table: "credential_connections", where, params });
  const rows = db
    .prepare(
      `
      SELECT * FROM credential_connections
      ${buildSqlWhereClause(where)}
      ORDER BY provider ASC, connection ASC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, page.limit, page.offset) as CredentialConnectionRow[];
  return {
    total,
    limit: page.limit,
    offset: page.offset,
    items: rows.map((row) => hydrateConnection(row, options)),
  };
}

export function upsertCredentialConnection(
  input: UpsertCredentialConnectionInput,
  options: CredentialStoreOptions = {},
): CredentialConnectionRecord {
  ensureCredentialTables(options);
  const provider = normalizeCredentialIdentifier(input.provider, "provider");
  const connection = normalizeCredentialIdentifier(input.connection, "connection");
  const now = input.now ?? Date.now();
  const id = credentialConnectionId(provider, connection);
  const backend = requireBackend(input.backend);
  const status = requireConnectionStatus(input.status ?? "active");
  const scopes = normalizeScopes(input.scopes ?? []);
  const label = input.label?.trim() || null;
  const secretRef = input.secretRef.trim();
  if (!secretRef) throw new Error("secretRef is required.");

  executeWrite(
    getCredentialDb(options),
    (db) => {
      const existing = db
        .prepare(
          "SELECT created_at, status, owner, purpose, rotated_at, expires_at, disabled_at FROM credential_connections WHERE id = ?",
        )
        .get(id) as
        | Pick<
            CredentialConnectionRow,
            "created_at" | "status" | "owner" | "purpose" | "rotated_at" | "expires_at" | "disabled_at"
          >
        | undefined;
      const lifecycle = mergeLifecycle(existing, input, status, now);
      db.prepare(
        `
        INSERT INTO credential_connections (
          id, provider, connection, label, backend, secret_ref, status, created_at, updated_at,
          owner, purpose, rotated_at, expires_at, disabled_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection) DO UPDATE SET
          label = excluded.label,
          backend = excluded.backend,
          secret_ref = excluded.secret_ref,
          status = excluded.status,
          updated_at = excluded.updated_at,
          owner = excluded.owner,
          purpose = excluded.purpose,
          rotated_at = excluded.rotated_at,
          expires_at = excluded.expires_at,
          disabled_at = excluded.disabled_at
        `,
      ).run(
        id,
        provider,
        connection,
        label,
        backend,
        secretRef,
        status,
        existing?.created_at ?? now,
        now,
        lifecycle.owner,
        lifecycle.purpose,
        lifecycle.rotatedAt,
        lifecycle.expiresAt,
        lifecycle.disabledAt,
      );
      db.prepare("DELETE FROM credential_connection_scopes WHERE connection_id = ?").run(id);
      for (const scope of scopes) {
        db.prepare(
          `
          INSERT OR IGNORE INTO credential_connection_scopes (id, connection_id, scope)
          VALUES (?, ?, ?)
          `,
        ).run(`ccs_${randomUUID()}`, id, scope);
      }
    },
    { label: "credentials.upsert" },
  );

  const saved = getCredentialConnection(provider, connection, options);
  if (!saved) throw new Error(`Failed to save credential connection: ${id}`);
  return saved;
}

/** Add-only counterpart for remote intake: never rotate a connection as a side effect. */
export function createCredentialConnectionIfAbsent(
  input: UpsertCredentialConnectionInput,
  options: CredentialStoreOptions = {},
): CredentialConnectionRecord | null {
  ensureCredentialTables(options);
  const provider = normalizeCredentialIdentifier(input.provider, "provider");
  const connection = normalizeCredentialIdentifier(input.connection, "connection");
  const backend = requireBackend(input.backend);
  const status = requireConnectionStatus(input.status ?? "active");
  const scopes = normalizeScopes(input.scopes ?? []);
  const secretRef = input.secretRef.trim();
  if (!secretRef) throw new Error("secretRef is required.");
  const id = credentialConnectionId(provider, connection);
  const now = input.now ?? Date.now();
  let created = false;
  executeWrite(
    getCredentialDb(options),
    (db) => {
      const result = db
        .prepare(`
        INSERT INTO credential_connections (
          id, provider, connection, label, backend, secret_ref, status, created_at, updated_at,
          owner, purpose, rotated_at, expires_at, disabled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection) DO NOTHING
      `)
        .run(
          id,
          provider,
          connection,
          input.label?.trim() || null,
          backend,
          secretRef,
          status,
          now,
          now,
          normalizeText(input.owner),
          normalizeText(input.purpose),
          null,
          input.expiresAt ?? null,
          status === "disabled" ? now : null,
        );
      created = result.changes === 1;
      if (!created) return;
      for (const scope of scopes) {
        db.prepare("INSERT INTO credential_connection_scopes (id, connection_id, scope) VALUES (?, ?, ?)").run(
          `ccs_${randomUUID()}`,
          id,
          scope,
        );
      }
    },
    { label: "credentials.create-if-absent" },
  );
  return created ? getCredentialConnection(provider, connection, options) : null;
}

export function setCredentialConnectionStatus(
  provider: string,
  connection: string,
  status: CredentialConnectionStatus,
  options: CredentialStoreOptions = {},
): CredentialConnectionRecord | null {
  ensureCredentialTables(options);
  const providerId = normalizeCredentialIdentifier(provider, "provider");
  const connectionId = normalizeCredentialIdentifier(connection, "connection");
  const normalizedStatus = requireConnectionStatus(status);
  executeWrite(
    getCredentialDb(options),
    (db) => {
      const now = Date.now();
      // disabled_at records when the connection went off; re-disabling keeps the first time.
      db.prepare(
        `
        UPDATE credential_connections
        SET status = ?, updated_at = ?,
          disabled_at = CASE WHEN ? = 'disabled' THEN COALESCE(disabled_at, ?) ELSE NULL END
        WHERE provider = ? AND connection = ?
        `,
      ).run(normalizedStatus, now, normalizedStatus, now, providerId, connectionId);
    },
    { label: "credentials.status" },
  );
  return getCredentialConnection(providerId, connectionId, options);
}

export function removeCredentialConnection(
  provider: string,
  connection: string,
  options: CredentialStoreOptions = {},
): CredentialConnectionRecord | null {
  ensureCredentialTables(options);
  const existing = getCredentialConnection(provider, connection, options);
  if (!existing) return null;
  executeWrite(
    getCredentialDb(options),
    (db) => {
      db.prepare("DELETE FROM credential_connections WHERE id = ?").run(existing.id);
    },
    { label: "credentials.remove" },
  );
  return existing;
}

export function recordCredentialAuditEvent(
  input: CredentialAuditEventInput,
  options: CredentialStoreOptions = {},
): CredentialAuditEvent {
  ensureCredentialTables(options);
  const provider = normalizeCredentialIdentifier(input.provider, "provider");
  const connection = normalizeCredentialIdentifier(input.connection, "connection");
  const existing = getCredentialConnection(provider, connection, options);
  const event: CredentialAuditEvent = {
    id: `cae_${randomUUID()}`,
    connectionId: existing?.id ?? null,
    provider,
    connection,
    action: input.action.trim(),
    actorContextId: input.actorContextId ?? null,
    agentId: input.agentId ?? null,
    decision: input.decision,
    approvalRequired: input.approvalRequired ?? false,
    approvalStatus: input.approvalStatus ?? null,
    resultStatus: input.resultStatus ?? null,
    errorCode: input.errorCode ?? null,
    createdAt: input.createdAt ?? Date.now(),
  };
  executeWrite(
    getCredentialDb(options),
    (db) => {
      db.prepare(
        `
        INSERT INTO credential_audit_events (
          id, connection_id, provider, connection, action, actor_context_id, agent_id,
          decision, approval_required, approval_status, result_status, error_code, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        event.id,
        event.connectionId,
        event.provider,
        event.connection,
        event.action,
        event.actorContextId,
        event.agentId,
        event.decision,
        event.approvalRequired ? 1 : 0,
        event.approvalStatus,
        event.resultStatus,
        event.errorCode,
        event.createdAt,
      );
    },
    { label: "credentials.audit" },
  );
  return event;
}

/**
 * Last time the broker resolved each connection's secret, from the audit
 * trail (`result_status = 'secret_resolved'`). Derived, not stored: the broker
 * hot path writes nothing extra and cannot race the connection `updated_at`
 * that its host guard compares.
 */
export function listCredentialLastUsedAt(options: CredentialStoreOptions = {}): Map<string, number> {
  ensureCredentialTables(options);
  const rows = getCredentialDb(options)
    .prepare(
      `
      SELECT provider, connection, MAX(created_at) AS last_used_at
      FROM credential_audit_events
      WHERE result_status = 'secret_resolved'
      GROUP BY provider, connection
      `,
    )
    .all() as Array<{ provider: string; connection: string; last_used_at: number }>;
  return new Map(rows.map((row) => [`${row.provider}:${row.connection}`, row.last_used_at]));
}

export function listRecentCredentialAuditEvents(
  limit: number,
  options: CredentialStoreOptions = {},
): CredentialAuditEvent[] {
  ensureCredentialTables(options);
  const bounded = Math.max(0, Math.min(Math.trunc(limit), 200));
  if (bounded === 0) return [];
  const rows = getCredentialDb(options)
    .prepare("SELECT * FROM credential_audit_events ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(bounded) as Array<{
    id: string;
    connection_id: string | null;
    provider: string;
    connection: string;
    action: string;
    actor_context_id: string | null;
    agent_id: string | null;
    decision: string;
    approval_required: number;
    approval_status: string | null;
    result_status: string | null;
    error_code: string | null;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    connection: row.connection,
    action: row.action,
    actorContextId: row.actor_context_id,
    agentId: row.agent_id,
    decision: row.decision,
    approvalRequired: row.approval_required === 1,
    approvalStatus: row.approval_status,
    resultStatus: row.result_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));
}

export function credentialConnectionId(provider: string, connection: string): string {
  return `${normalizeCredentialIdentifier(provider, "provider")}:${normalizeCredentialIdentifier(connection, "connection")}`;
}

export function normalizeCredentialIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`${label} must use lowercase letters, numbers, dot, underscore or dash.`);
  }
  return normalized;
}

export function closeCredentialsDb(): void {
  if (!handle) return;
  resetWriteCounter(handle.db);
  handle.db.close();
  handle = null;
}

function getCredentialDb(options: CredentialStoreOptions = {}): Database {
  const path = options.dbPath ?? getCredentialsDbPath(options.env);
  assertDatabaseTargetAllowed(path, { env: options.env });
  if (handle?.path === path) return handle.db;
  handle?.db.close();
  mkdirSync(dirname(path), { recursive: true });
  const db = openStateDatabase(path, { create: true }, { env: options.env });
  configureStateJournalMode(db);
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  handle = { db, path };
  return db;
}

function ensureSchema(db: Database): void {
  initializeStateSchema(db, "credentials", () => migrateSchema(db));
}

function migrateSchema(db: Database): void {
  migrateFileBackend(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection TEXT NOT NULL,
      label TEXT,
      backend TEXT NOT NULL CHECK(backend IN ('file', 'keychain', 'vault')),
      secret_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(provider, connection)
    );

    CREATE TABLE IF NOT EXISTS credential_connection_scopes (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES credential_connections(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      UNIQUE(connection_id, scope)
    );

    CREATE TABLE IF NOT EXISTS credential_audit_events (
      id TEXT PRIMARY KEY,
      connection_id TEXT REFERENCES credential_connections(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      connection TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_context_id TEXT,
      agent_id TEXT,
      decision TEXT NOT NULL,
      approval_required INTEGER NOT NULL,
      approval_status TEXT,
      result_status TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_credential_connections_provider
      ON credential_connections(provider, status);
    CREATE INDEX IF NOT EXISTS idx_credential_audit_events_connection
      ON credential_audit_events(provider, connection, created_at);
  `);
  addLifecycleColumns(db);
}

/** Additive, idempotent: old databases gain nullable lifecycle columns; rows keep their data. */
function addLifecycleColumns(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(credential_connections)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of LIFECYCLE_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE credential_connections ADD COLUMN ${name} ${type}`);
  }
}

/** SQLite cannot alter a CHECK constraint; preserve rows and child references. */
function migrateFileBackend(db: Database): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'credential_connections'")
    .get() as { sql: string } | null;
  if (!existing || existing.sql.includes("'file'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE credential_connections_file_backend (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          connection TEXT NOT NULL,
          label TEXT,
          backend TEXT NOT NULL CHECK(backend IN ('file', 'keychain', 'vault')),
          secret_ref TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(provider, connection)
        );
        INSERT INTO credential_connections_file_backend
          (id, provider, connection, label, backend, secret_ref, status, created_at, updated_at)
          SELECT id, provider, connection, label, backend, secret_ref, status, created_at, updated_at
          FROM credential_connections;
        DROP TABLE credential_connections;
        ALTER TABLE credential_connections_file_backend RENAME TO credential_connections;
      `);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Credential schema migration failed");
    }).immediate();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function hydrateConnection(row: CredentialConnectionRow, options: CredentialStoreOptions): CredentialConnectionRecord {
  const scopeRows = getCredentialDb(options)
    .prepare("SELECT scope FROM credential_connection_scopes WHERE connection_id = ? ORDER BY scope ASC")
    .all(row.id) as Array<{ scope: string }>;
  return {
    id: row.id,
    provider: row.provider,
    connection: row.connection,
    label: row.label,
    backend: requireBackend(row.backend),
    secretRef: row.secret_ref,
    scopes: scopeRows.map((scope) => scope.scope),
    status: requireConnectionStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: row.owner ?? null,
    purpose: row.purpose ?? null,
    rotatedAt: row.rotated_at ?? null,
    expiresAt: row.expires_at ?? null,
    disabledAt: row.disabled_at ?? null,
  };
}

function mergeLifecycle(
  existing:
    | Pick<CredentialConnectionRow, "status" | "owner" | "purpose" | "rotated_at" | "expires_at" | "disabled_at">
    | undefined,
  input: UpsertCredentialConnectionInput,
  status: CredentialConnectionStatus,
  now: number,
): {
  owner: string | null;
  purpose: string | null;
  rotatedAt: number | null;
  expiresAt: number | null;
  disabledAt: number | null;
} {
  const keep = <T>(next: T | undefined, current: T | null | undefined): T | null =>
    next === undefined ? (current ?? null) : next;
  return {
    owner: input.owner === undefined ? (existing?.owner ?? null) : normalizeText(input.owner),
    purpose: input.purpose === undefined ? (existing?.purpose ?? null) : normalizeText(input.purpose),
    rotatedAt: keep(input.rotatedAt, existing?.rotated_at),
    expiresAt: keep(input.expiresAt, existing?.expires_at),
    disabledAt: status === "disabled" ? (existing?.status === "disabled" ? (existing.disabled_at ?? now) : now) : null,
  };
}

function normalizeText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).sort();
}

function requireBackend(value: string): CredentialBackend {
  if (value === "file" || value === "keychain" || value === "vault") return value;
  throw new Error(`Unsupported credential backend: ${value}`);
}

function requireConnectionStatus(value: string): CredentialConnectionStatus {
  if (value === "active" || value === "disabled") return value;
  throw new Error(`Unsupported credential connection status: ${value}`);
}

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { executeWrite, resetWriteCounter } from "../db/write-retry.js";
import { buildSqlWhereClause, countRows, normalizeLimitOffsetPage } from "../utils/pagination.js";
import { getRaviStateDir } from "../utils/paths.js";
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
}

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
}

export interface ListCredentialConnectionsInput {
  provider?: string;
  status?: CredentialConnectionStatus;
  includeDisabled?: boolean;
  limit?: number | string | null;
  offset?: number | string | null;
}

export function getCredentialsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAVI_CREDENTIALS_DB_PATH?.trim() || join(getRaviStateDir(env), "credentials.db");
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
      const existing = db.prepare("SELECT created_at FROM credential_connections WHERE id = ?").get(id) as
        | { created_at: number }
        | undefined;
      db.prepare(
        `
        INSERT INTO credential_connections (
          id, provider, connection, label, backend, secret_ref, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection) DO UPDATE SET
          label = excluded.label,
          backend = excluded.backend,
          secret_ref = excluded.secret_ref,
          status = excluded.status,
          updated_at = excluded.updated_at
        `,
      ).run(id, provider, connection, label, backend, secretRef, status, existing?.created_at ?? now, now);
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
      db.prepare(
        `
        UPDATE credential_connections
        SET status = ?, updated_at = ?
        WHERE provider = ? AND connection = ?
        `,
      ).run(normalizedStatus, Date.now(), providerId, connectionId);
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
  if (handle?.path === path) return handle.db;
  handle?.db.close();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  handle = { db, path };
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection TEXT NOT NULL,
      label TEXT,
      backend TEXT NOT NULL CHECK(backend IN ('keychain', 'vault')),
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
  };
}

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).sort();
}

function requireBackend(value: string): CredentialBackend {
  if (value === "keychain" || value === "vault") return value;
  throw new Error(`Unsupported credential backend: ${value}`);
}

function requireConnectionStatus(value: string): CredentialConnectionStatus {
  if (value === "active" || value === "disabled") return value;
  throw new Error(`Unsupported credential connection status: ${value}`);
}

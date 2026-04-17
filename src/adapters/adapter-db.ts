import type { Statement } from "bun:sqlite";
import { z } from "zod";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { StdioSupervisorHealth } from "./stdio-supervisor.js";
import {
  SessionAdapterDefinitionSchema,
  SessionAdapterStatusSchema,
  SessionAdapterSubscriptionSchema,
  type SessionAdapterDefinition,
  type SessionAdapterStatus,
  type SessionAdapterSubscription,
} from "./types.js";

const log = logger.child("adapters:db");

interface SessionAdapterRow {
  adapter_id: string;
  session_key: string;
  session_name: string | null;
  agent_id: string | null;
  adapter_name: string;
  transport: string;
  status: string;
  definition_json: string;
  last_error: string | null;
  last_transition_at: number;
  last_started_at: number | null;
  last_stopped_at: number | null;
  broken_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SessionAdapterSubscriptionRow {
  subscription_id: string;
  adapter_id: string;
  session_key: string;
  direction: string;
  topic: string;
  enabled: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionAdapterDebugRow {
  adapter_id: string;
  snapshot_json: string;
  updated_at: number;
}

export interface SessionAdapterRecord {
  adapterId: string;
  sessionKey: string;
  sessionName?: string;
  agentId?: string;
  name: string;
  transport: "stdio-json";
  status: SessionAdapterStatus;
  definition: SessionAdapterDefinition;
  lastError?: string;
  lastTransitionAt: number;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  brokenAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionAdapterDebugSnapshot {
  adapterId: string;
  adapterName: string;
  transport: "stdio-json";
  sessionKey: string;
  sessionName?: string;
  status: SessionAdapterStatus;
  bind: {
    sessionKey: string;
    sessionName?: string;
    agentId?: string;
    contextId?: string;
    contextKey?: string;
    cliName: string;
  };
  health: StdioSupervisorHealth;
  lastEvent?: {
    topic?: string;
    type: string;
    event?: string;
    payload?: unknown;
    publishedAt: number;
  };
  lastCommand?: {
    topic?: string;
    command: string;
    args?: string[];
    payload?: unknown;
    publishedAt: number;
  };
  lastProtocolError?: {
    message: string;
    kind?: string;
    line?: string;
    reason?: string;
    publishedAt: number;
  };
  updatedAt: number;
}

export interface SessionAdapterSubscriptionRecord extends SessionAdapterSubscription {
  createdAt: number;
  updatedAt: number;
}

export interface SaveSessionAdapterInput {
  adapterId: string;
  definition: SessionAdapterDefinition;
  status?: SessionAdapterStatus;
  lastError?: string;
}

export interface UpdateSessionAdapterStateInput {
  status: SessionAdapterStatus;
  lastError?: string;
}

export interface ListSessionAdaptersOptions {
  sessionKey?: string;
  status?: SessionAdapterStatus;
}

export interface ListSessionAdapterSubscriptionsOptions {
  adapterId?: string;
  sessionKey?: string;
  direction?: SessionAdapterSubscription["direction"];
}

const SaveSessionAdapterInputSchema = z.object({
  adapterId: z.string().min(1),
  definition: SessionAdapterDefinitionSchema,
  status: SessionAdapterStatusSchema.optional(),
  lastError: z.string().min(1).optional(),
});

const UpdateSessionAdapterStateInputSchema = z
  .object({
    status: SessionAdapterStatusSchema,
    lastError: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.status !== "broken") return;
    if (input.lastError) return;
    ctx.addIssue({
      code: "custom",
      message: "lastError is required when an adapter is marked broken",
      path: ["lastError"],
    });
  });

interface AdapterStatements {
  upsertAdapter: Statement;
  getAdapter: Statement;
  deleteAdapter: Statement;
  upsertSubscription: Statement;
  getSubscription: Statement;
  deleteSubscription: Statement;
  upsertDebugSnapshot: Statement;
  getDebugSnapshot: Statement;
}

let ensuredSchema = false;
let stmts: AdapterStatements | null = null;

function ensureAdapterSchema(): void {
  if (ensuredSchema) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_adapters (
      adapter_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      session_name TEXT,
      agent_id TEXT,
      adapter_name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK(transport IN ('stdio-json')),
      status TEXT NOT NULL CHECK(status IN ('configured','running','stopped','broken')),
      definition_json TEXT NOT NULL,
      last_error TEXT,
      last_transition_at INTEGER NOT NULL,
      last_started_at INTEGER,
      last_stopped_at INTEGER,
      broken_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_adapters_name
      ON session_adapters(session_key, adapter_name);
    CREATE INDEX IF NOT EXISTS idx_session_adapters_status
      ON session_adapters(status);
    CREATE INDEX IF NOT EXISTS idx_session_adapters_session
      ON session_adapters(session_key);

    CREATE TABLE IF NOT EXISTS session_adapter_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      adapter_id TEXT NOT NULL REFERENCES session_adapters(adapter_id) ON DELETE CASCADE,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('to-adapter','from-adapter')),
      topic TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(adapter_id, direction, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_session_adapter_subscriptions_adapter
      ON session_adapter_subscriptions(adapter_id);
    CREATE INDEX IF NOT EXISTS idx_session_adapter_subscriptions_session
      ON session_adapter_subscriptions(session_key);

    CREATE TABLE IF NOT EXISTS session_adapter_debug (
      adapter_id TEXT PRIMARY KEY REFERENCES session_adapters(adapter_id) ON DELETE CASCADE,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_adapter_debug_updated
      ON session_adapter_debug(updated_at);
  `);
  ensuredSchema = true;
}

export function ensureSessionAdapterStoreSchema(): void {
  ensureAdapterSchema();
}

function getStatements(): AdapterStatements {
  ensureAdapterSchema();
  if (stmts) return stmts;

  const db = getDb();
  stmts = {
    upsertAdapter: db.prepare(`
      INSERT INTO session_adapters (
        adapter_id, session_key, session_name, agent_id, adapter_name, transport, status,
        definition_json, last_error, last_transition_at, last_started_at, last_stopped_at,
        broken_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET
        session_key = excluded.session_key,
        session_name = excluded.session_name,
        agent_id = excluded.agent_id,
        adapter_name = excluded.adapter_name,
        transport = excluded.transport,
        status = excluded.status,
        definition_json = excluded.definition_json,
        last_error = excluded.last_error,
        last_transition_at = excluded.last_transition_at,
        last_started_at = excluded.last_started_at,
        last_stopped_at = excluded.last_stopped_at,
        broken_at = excluded.broken_at,
        updated_at = excluded.updated_at
    `),
    getAdapter: db.prepare("SELECT * FROM session_adapters WHERE adapter_id = ?"),
    deleteAdapter: db.prepare("DELETE FROM session_adapters WHERE adapter_id = ?"),
    upsertSubscription: db.prepare(`
      INSERT INTO session_adapter_subscriptions (
        subscription_id, adapter_id, session_key, direction, topic, enabled, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        adapter_id = excluded.adapter_id,
        session_key = excluded.session_key,
        direction = excluded.direction,
        topic = excluded.topic,
        enabled = excluded.enabled,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `),
    getSubscription: db.prepare("SELECT * FROM session_adapter_subscriptions WHERE subscription_id = ?"),
    deleteSubscription: db.prepare("DELETE FROM session_adapter_subscriptions WHERE subscription_id = ?"),
    upsertDebugSnapshot: db.prepare(`
      INSERT INTO session_adapter_debug (adapter_id, snapshot_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `),
    getDebugSnapshot: db.prepare("SELECT * FROM session_adapter_debug WHERE adapter_id = ?"),
  };

  return stmts;
}

function rowToAdapter(row: SessionAdapterRow): SessionAdapterRecord {
  const parsedDefinition = SessionAdapterDefinitionSchema.safeParse(JSON.parse(row.definition_json));
  if (!parsedDefinition.success) {
    throw new Error(`Invalid stored adapter definition for ${row.adapter_id}`);
  }

  const parsedStatus = SessionAdapterStatusSchema.parse(row.status);
  const result: SessionAdapterRecord = {
    adapterId: row.adapter_id,
    sessionKey: row.session_key,
    name: row.adapter_name,
    transport: "stdio-json",
    status: parsedStatus,
    definition: parsedDefinition.data,
    lastTransitionAt: row.last_transition_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.session_name) result.sessionName = row.session_name;
  if (row.agent_id) result.agentId = row.agent_id;
  if (row.last_error) result.lastError = row.last_error;
  if (row.last_started_at) result.lastStartedAt = row.last_started_at;
  if (row.last_stopped_at) result.lastStoppedAt = row.last_stopped_at;
  if (row.broken_at) result.brokenAt = row.broken_at;

  return result;
}

function rowToSubscription(row: SessionAdapterSubscriptionRow): SessionAdapterSubscriptionRecord {
  const parsed = SessionAdapterSubscriptionSchema.safeParse({
    subscriptionId: row.subscription_id,
    adapterId: row.adapter_id,
    sessionKey: row.session_key,
    direction: row.direction,
    topic: row.topic,
    enabled: row.enabled === 1,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  });

  if (!parsed.success) {
    throw new Error(`Invalid stored adapter subscription for ${row.subscription_id}`);
  }

  return {
    ...parsed.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDebugSnapshot(row: SessionAdapterDebugRow): SessionAdapterDebugSnapshot {
  const parsed = JSON.parse(row.snapshot_json) as SessionAdapterDebugSnapshot;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid stored adapter debug snapshot for ${row.adapter_id}`);
  }

  return {
    ...parsed,
    adapterId: parsed.adapterId ?? row.adapter_id,
    updatedAt: row.updated_at,
  };
}

function getAdapterRow(adapterId: string): SessionAdapterRow | undefined {
  const s = getStatements();
  return s.getAdapter.get(adapterId) as SessionAdapterRow | undefined;
}

function buildStateSnapshot(
  existing: SessionAdapterRecord | null,
  nextStatus: SessionAdapterStatus,
  now: number,
): Pick<SessionAdapterRecord, "lastTransitionAt" | "lastStartedAt" | "lastStoppedAt" | "brokenAt"> {
  const changed = !existing || existing.status !== nextStatus;

  return {
    lastTransitionAt: changed ? now : existing.lastTransitionAt,
    lastStartedAt:
      nextStatus === "running" ? (changed ? now : (existing.lastStartedAt ?? now)) : existing?.lastStartedAt,
    lastStoppedAt:
      nextStatus === "stopped" ? (changed ? now : (existing.lastStoppedAt ?? now)) : existing?.lastStoppedAt,
    brokenAt: nextStatus === "broken" ? (changed ? now : (existing.brokenAt ?? now)) : existing?.brokenAt,
  };
}

function selectAdapters(options: ListSessionAdaptersOptions = {}): SessionAdapterRecord[] {
  ensureAdapterSchema();
  const db = getDb();
  const clauses: string[] = [];
  const params: string[] = [];

  if (options.sessionKey) {
    clauses.push("session_key = ?");
    params.push(options.sessionKey);
  }
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM session_adapters ${where} ORDER BY created_at DESC, adapter_id ASC`)
    .all(...params) as SessionAdapterRow[];

  return rows.map(rowToAdapter);
}

function selectSubscriptions(options: ListSessionAdapterSubscriptionsOptions = {}): SessionAdapterSubscriptionRecord[] {
  ensureAdapterSchema();
  const db = getDb();
  const clauses: string[] = [];
  const params: string[] = [];

  if (options.adapterId) {
    clauses.push("adapter_id = ?");
    params.push(options.adapterId);
  }
  if (options.sessionKey) {
    clauses.push("session_key = ?");
    params.push(options.sessionKey);
  }
  if (options.direction) {
    clauses.push("direction = ?");
    params.push(options.direction);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM session_adapter_subscriptions ${where} ORDER BY created_at ASC, subscription_id ASC`)
    .all(...params) as SessionAdapterSubscriptionRow[];

  return rows.map(rowToSubscription);
}

export function saveSessionAdapter(input: SaveSessionAdapterInput): SessionAdapterRecord {
  const validated = SaveSessionAdapterInputSchema.parse(input);
  const existing = getSessionAdapter(validated.adapterId);
  const now = Date.now();
  const nextStatus = validated.status ?? existing?.status ?? "configured";

  if (nextStatus === "broken" && !validated.lastError && !existing?.lastError) {
    throw new Error("lastError is required when an adapter is marked broken");
  }

  const state = buildStateSnapshot(existing, nextStatus, now);
  const lastError =
    nextStatus === "broken" ? (validated.lastError ?? existing?.lastError ?? "unknown adapter failure") : undefined;
  const s = getStatements();

  s.upsertAdapter.run(
    validated.adapterId,
    validated.definition.bindings.sessionKey,
    validated.definition.bindings.sessionName ?? null,
    validated.definition.bindings.agentId ?? null,
    validated.definition.name,
    validated.definition.transport,
    nextStatus,
    JSON.stringify(validated.definition),
    lastError ?? null,
    state.lastTransitionAt,
    state.lastStartedAt ?? null,
    state.lastStoppedAt ?? null,
    state.brokenAt ?? null,
    existing?.createdAt ?? now,
    now,
  );

  const saved = getSessionAdapter(validated.adapterId);
  if (!saved) {
    throw new Error(`Failed to persist adapter: ${validated.adapterId}`);
  }

  log.info("Saved session adapter", {
    adapterId: validated.adapterId,
    sessionKey: saved.sessionKey,
    status: saved.status,
  });
  return saved;
}

export function getSessionAdapter(adapterId: string): SessionAdapterRecord | null {
  const row = getAdapterRow(adapterId);
  return row ? rowToAdapter(row) : null;
}

export function listSessionAdapters(options: ListSessionAdaptersOptions = {}): SessionAdapterRecord[] {
  return selectAdapters(options);
}

export function updateSessionAdapterState(
  adapterId: string,
  input: UpdateSessionAdapterStateInput,
): SessionAdapterRecord {
  const existing = getSessionAdapter(adapterId);
  if (!existing) {
    throw new Error(`Adapter not found: ${adapterId}`);
  }

  const validated = UpdateSessionAdapterStateInputSchema.parse(input);
  return saveSessionAdapter({
    adapterId,
    definition: existing.definition,
    status: validated.status,
    lastError: validated.lastError,
  });
}

export function deleteSessionAdapter(adapterId: string): boolean {
  const s = getStatements();
  s.deleteAdapter.run(adapterId);
  return getDbChanges() > 0;
}

export function saveSessionAdapterSubscription(input: SessionAdapterSubscription): SessionAdapterSubscriptionRecord {
  const validated = SessionAdapterSubscriptionSchema.parse(input);
  const adapter = getSessionAdapter(validated.adapterId);
  if (!adapter) {
    throw new Error(`Adapter not found: ${validated.adapterId}`);
  }
  if (adapter.sessionKey !== validated.sessionKey) {
    throw new Error(
      `Subscription session mismatch for ${validated.subscriptionId}: expected ${adapter.sessionKey}, got ${validated.sessionKey}`,
    );
  }

  const existing = getSessionAdapterSubscription(validated.subscriptionId);
  const now = Date.now();
  const s = getStatements();

  s.upsertSubscription.run(
    validated.subscriptionId,
    validated.adapterId,
    validated.sessionKey,
    validated.direction,
    validated.topic,
    validated.enabled ? 1 : 0,
    validated.metadata ? JSON.stringify(validated.metadata) : null,
    existing?.createdAt ?? now,
    now,
  );

  const saved = getSessionAdapterSubscription(validated.subscriptionId);
  if (!saved) {
    throw new Error(`Failed to persist adapter subscription: ${validated.subscriptionId}`);
  }

  return saved;
}

export function getSessionAdapterSubscription(subscriptionId: string): SessionAdapterSubscriptionRecord | null {
  const s = getStatements();
  const row = s.getSubscription.get(subscriptionId) as SessionAdapterSubscriptionRow | undefined;
  return row ? rowToSubscription(row) : null;
}

export function listSessionAdapterSubscriptions(
  options: ListSessionAdapterSubscriptionsOptions = {},
): SessionAdapterSubscriptionRecord[] {
  return selectSubscriptions(options);
}

export function deleteSessionAdapterSubscription(subscriptionId: string): boolean {
  const s = getStatements();
  s.deleteSubscription.run(subscriptionId);
  return getDbChanges() > 0;
}

export interface SaveSessionAdapterDebugSnapshotInput {
  adapterId: string;
  snapshot: SessionAdapterDebugSnapshot;
}

const SaveSessionAdapterDebugSnapshotInputSchema = z.object({
  adapterId: z.string().min(1),
  snapshot: z.record(z.string(), z.unknown()),
});

export function saveSessionAdapterDebugSnapshot(
  input: SaveSessionAdapterDebugSnapshotInput,
): SessionAdapterDebugSnapshot {
  const validated = SaveSessionAdapterDebugSnapshotInputSchema.parse(input);
  const now = Date.now();
  const s = getStatements();

  s.upsertDebugSnapshot.run(validated.adapterId, JSON.stringify(validated.snapshot), now);

  const saved = getSessionAdapterDebugSnapshot(validated.adapterId);
  if (!saved) {
    throw new Error(`Failed to persist adapter debug snapshot: ${validated.adapterId}`);
  }

  return saved;
}

export function getSessionAdapterDebugSnapshot(adapterId: string): SessionAdapterDebugSnapshot | null {
  const s = getStatements();
  const row = s.getDebugSnapshot.get(adapterId) as SessionAdapterDebugRow | undefined;
  return row ? rowToDebugSnapshot(row) : null;
}

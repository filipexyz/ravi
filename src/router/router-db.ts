/**
 * Router Database - SQLite-backed configuration storage
 *
 * Stores agents, routes, and settings in SQLite to prevent
 * direct file editing by bots (which could bypass validation).
 *
 * Uses lazy initialization - database is only created when first accessed.
 */

import { Database, type Statement } from "bun:sqlite";
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";
import type { AgentConfig, RouteConfig, DmScope } from "./types.js";

const log = logger.child("router:db");

// ============================================================================
// Constants
// ============================================================================

const RAVI_DIR = join(homedir(), "ravi");
const DEFAULT_RAVI_STATE_DIR = getRaviStateDir({});
const DEFAULT_DB_PATH = join(DEFAULT_RAVI_STATE_DIR, "ravi.db");
const LEGACY_DB_PATH = join(RAVI_DIR, "ravi.db");

// ============================================================================
// Schemas (safe to access at import time - no I/O)
// ============================================================================

export const DmScopeSchema = z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]);

export const AgentModeSchema = z.enum(["active", "sentinel"]);
export const RuntimeProviderSchema = z.enum(["claude", "codex"]);

export const AgentInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  provider: RuntimeProviderSchema.optional(),
  remote: z.string().optional(),
  remoteUser: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  debounceMs: z.number().int().min(0).optional(),
  groupDebounceMs: z.number().int().min(0).optional(),
  matrixAccount: z.string().optional(),
  settingSources: z.array(z.enum(["user", "project"])).optional(),
  mode: AgentModeSchema.optional(),
});

export const RouteInputSchema = z.object({
  pattern: z.string().min(1),
  accountId: z.string().min(1),
  agent: z.string().min(1),
  dmScope: DmScopeSchema.optional(),
  session: z.string().optional(),
  priority: z.number().int().default(0),
  policy: z.string().optional(),
  channel: z.string().optional(),
});

export const GroupPolicySchema = z.enum(["open", "allowlist", "closed"]);
export const DmPolicySchema = z.enum(["open", "pairing", "closed"]);
export const ContextSourceSchema = z.object({
  channel: z.string().min(1),
  accountId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1).optional(),
});
export const ContextCapabilitySchema = z.object({
  permission: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  source: z.string().optional(),
});
export const ContextInputSchema = z.object({
  contextId: z.string().min(1),
  contextKey: z.string().min(1),
  kind: z.string().min(1).default("runtime"),
  agentId: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
  source: ContextSourceSchema.optional(),
  capabilities: z.array(ContextCapabilitySchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  lastUsedAt: z.number().int().optional(),
  revokedAt: z.number().int().optional(),
});

export const InstanceInputSchema = z.object({
  name: z.string().min(1),
  instanceId: z.string().optional(),
  channel: z.string().default("whatsapp"),
  agent: z.string().optional(),
  dmPolicy: DmPolicySchema.default("open"),
  groupPolicy: GroupPolicySchema.default("open"),
  dmScope: DmScopeSchema.optional(),
  enabled: z.boolean().default(true),
});

// ============================================================================
// Row Types
// ============================================================================

interface AgentRow {
  id: string;
  name: string | null;
  cwd: string;
  model: string | null;
  provider: string | null;
  remote: string | null;
  remote_user: string | null;
  dm_scope: string | null;
  system_prompt_append: string | null;
  debounce_ms: number | null;
  group_debounce_ms: number | null;
  matrix_account: string | null;
  setting_sources: string | null;
  // Heartbeat columns
  heartbeat_enabled: number;
  heartbeat_interval_ms: number;
  heartbeat_model: string | null;
  heartbeat_active_start: string | null;
  heartbeat_active_end: string | null;
  heartbeat_last_run_at: number | null;
  heartbeat_account_id: string | null;
  // Scope isolation columns
  spec_mode: number;
  contact_scope: string | null;
  allowed_sessions: string | null;
  // Agent mode
  agent_mode: string | null;
  // Generic defaults
  defaults: string | null;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: number;
  pattern: string;
  account_id: string;
  agent_id: string;
  dm_scope: string | null;
  session_name: string | null;
  policy: string | null;
  priority: number;
  channel: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface InstanceRow {
  name: string;
  instance_id: string | null;
  channel: string;
  agent: string | null;
  dm_policy: string;
  group_policy: string;
  dm_scope: string | null;
  enabled: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ContextRow {
  context_id: string;
  context_key: string;
  kind: string;
  agent_id: string | null;
  session_key: string | null;
  session_name: string | null;
  source_json: string | null;
  capabilities_json: string;
  metadata_json: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface InstanceConfig {
  name: string;
  instanceId?: string;
  channel: string;
  agent?: string;
  dmPolicy: "open" | "pairing" | "closed";
  groupPolicy: "open" | "allowlist" | "closed";
  dmScope?: DmScope;
  enabled?: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface MatrixAccountRow {
  username: string;
  user_id: string;
  homeserver: string;
  access_token: string;
  device_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface MatrixAccount {
  username: string;
  userId: string;
  homeserver: string;
  accessToken: string;
  deviceId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ContextSource {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface ContextCapability {
  permission: string;
  objectType: string;
  objectId: string;
  source?: string;
}

export interface ContextRecord {
  contextId: string;
  contextKey: string;
  kind: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface ListContextsOptions {
  agentId?: string;
  sessionKey?: string;
  kind?: string;
  includeInactive?: boolean;
}

// ============================================================================
// Lazy Database Initialization
// ============================================================================

type RouterDbState = {
  db: Database | null;
  dbPath: string | null;
  stmts: PreparedStatements | null;
};

type RouterDbGlobal = typeof globalThis & {
  __raviRouterDbState?: RouterDbState;
};

const routerDbGlobal = globalThis as RouterDbGlobal;
const routerDbState =
  routerDbGlobal.__raviRouterDbState ??
  (routerDbGlobal.__raviRouterDbState = {
    db: null,
    dbPath: null,
    stmts: null,
  });

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "ravi.db");
}

/**
 * Get database connection with lazy initialization.
 * Creates database and schema on first access.
 */
function getDb(): Database {
  const nextDbPath = resolveDbPath();
  if (routerDbState.db !== null && routerDbState.dbPath === nextDbPath) {
    return routerDbState.db;
  }
  if (routerDbState.db !== null && routerDbState.dbPath !== nextDbPath) {
    closeRouterDb();
  }

  const stateDir = getRaviStateDir();

  // Create directory on first access
  mkdirSync(stateDir, { recursive: true });

  // Auto-migrate from legacy path (~/ravi/ravi.db → ~/.ravi/ravi.db)
  if (nextDbPath === DEFAULT_DB_PATH && !existsSync(nextDbPath) && existsSync(LEGACY_DB_PATH)) {
    log.info("Migrating database from ~/ravi/ravi.db to ~/.ravi/ravi.db");
    renameSync(LEGACY_DB_PATH, nextDbPath);
    // Also move WAL/SHM files if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const legacy = LEGACY_DB_PATH + suffix;
      if (existsSync(legacy)) renameSync(legacy, nextDbPath + suffix);
    }
  }

  const db = new Database(nextDbPath);
  routerDbState.db = db;
  routerDbState.dbPath = nextDbPath;

  // WAL mode for concurrent read/write access (CLI + daemon)
  db.exec("PRAGMA journal_mode = WAL");
  // Wait up to 5s for locks to clear instead of failing immediately
  db.exec("PRAGMA busy_timeout = 5000");

  // Enable foreign keys before schema creation
  db.exec("PRAGMA foreign_keys = ON");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT NOT NULL,
      model TEXT,
      provider TEXT CHECK(provider IS NULL OR provider IN ('claude','codex')),
      remote TEXT,
      remote_user TEXT,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      system_prompt_append TEXT,
      debounce_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(pattern, account_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      name TEXT,
      sdk_session_id TEXT,
      runtime_provider TEXT CHECK(runtime_provider IS NULL OR runtime_provider IN ('claude','codex')),
      runtime_session_json TEXT,
      runtime_session_display_id TEXT,
      agent_id TEXT NOT NULL,
      agent_cwd TEXT NOT NULL,
      chat_type TEXT,
      channel TEXT,
      account_id TEXT,
      group_id TEXT,
      subject TEXT,
      display_name TEXT,
      last_channel TEXT,
      last_to TEXT,
      last_account_id TEXT,
      last_thread_id TEXT,
      model_override TEXT,
      thinking_level TEXT,
      queue_mode TEXT,
      queue_debounce_ms INTEGER,
      queue_cap INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      context_tokens INTEGER DEFAULT 0,
      system_sent INTEGER DEFAULT 0,
      aborted_last_run INTEGER DEFAULT 0,
      compaction_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_sdk ON sessions(sdk_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL;

    -- REBAC: Relationship-based access control
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
      ON relations(subject_type, subject_id, relation, object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_relations_subject
      ON relations(subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS idx_relations_object
      ON relations(object_type, object_id);

    -- Message metadata (transcriptions, media paths — for reply reinjection)
    CREATE TABLE IF NOT EXISTS message_metadata (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      transcription TEXT,
      media_path TEXT,
      media_type TEXT,
      created_at INTEGER NOT NULL
    );

    -- Cost tracking: granular per-turn cost events
    CREATE TABLE IF NOT EXISTS cost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      input_cost_usd REAL NOT NULL,
      output_cost_usd REAL NOT NULL,
      cache_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_events_session ON cost_events(session_key);
    CREATE INDEX IF NOT EXISTS idx_cost_events_created ON cost_events(created_at);

    -- Instances: central config entity (one per omni connection)
    CREATE TABLE IF NOT EXISTS instances (
      name         TEXT PRIMARY KEY,
      instance_id  TEXT UNIQUE,
      channel      TEXT NOT NULL DEFAULT 'whatsapp',
      agent        TEXT REFERENCES agents(id) ON DELETE SET NULL,
      dm_policy    TEXT NOT NULL DEFAULT 'open' CHECK(dm_policy IN ('open','pairing','closed')),
      group_policy TEXT NOT NULL DEFAULT 'open' CHECK(group_policy IN ('open','allowlist','closed')),
      dm_scope     TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      context_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'runtime',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
      session_name TEXT,
      source_json TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    -- Matrix accounts (all users - both regular users and agents)
    CREATE TABLE IF NOT EXISTS matrix_accounts (
      username TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      homeserver TEXT NOT NULL,
      access_token TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  // Migration: add matrix_account column to agents if not exists
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentColumns.some((c) => c.name === "matrix_account")) {
    db.exec("ALTER TABLE agents ADD COLUMN matrix_account TEXT REFERENCES matrix_accounts(username)");
    log.info("Added matrix_account column to agents table");
  }

  // Migration: add heartbeat columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "heartbeat_enabled")) {
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_interval_ms INTEGER DEFAULT 1800000;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_model TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_start TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_end TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_last_run_at INTEGER;
    `);
    log.info("Added heartbeat columns to agents table");
  }

  // Migration: add setting_sources column to agents if not exists
  if (!agentColumns.some((c) => c.name === "setting_sources")) {
    db.exec("ALTER TABLE agents ADD COLUMN setting_sources TEXT");
    log.info("Added setting_sources column to agents table");
  }

  // Migration: add provider column to agents if not exists
  if (!agentColumns.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT");
    log.info("Added provider column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote TEXT");
    log.info("Added remote column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote_user")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote_user TEXT");
    log.info("Added remote_user column to agents table");
  }

  // Migration: drop legacy permission columns (replaced by REBAC)
  const legacyCols = ["allowed_tools", "bash_mode", "bash_allowlist", "bash_denylist"];
  const toDrop = legacyCols.filter((c) => agentColumns.some((ac) => ac.name === c));
  if (toDrop.length > 0) {
    for (const col of toDrop) {
      db.exec(`ALTER TABLE agents DROP COLUMN ${col}`);
    }
    log.info("Dropped legacy permission columns from agents table", { columns: toDrop });
  }

  // Migration: add spec_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "spec_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN spec_mode INTEGER DEFAULT 0");
    log.info("Added spec_mode column to agents table");
  }

  // Migration: add scope isolation columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "contact_scope")) {
    db.exec("ALTER TABLE agents ADD COLUMN contact_scope TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN allowed_sessions TEXT");
    log.info("Added scope isolation columns to agents table");
  }

  // Migration: add agent_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "agent_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_mode TEXT");
    log.info("Added agent_mode column to agents table");
  }

  // Migration: add group_debounce_ms column to agents if not exists
  if (!agentColumns.some((c) => c.name === "group_debounce_ms")) {
    db.exec("ALTER TABLE agents ADD COLUMN group_debounce_ms INTEGER");
    log.info("Added group_debounce_ms column to agents table");
  }

  // Migration: add defaults column to agents if not exists
  if (!agentColumns.some((c) => c.name === "defaults")) {
    db.exec("ALTER TABLE agents ADD COLUMN defaults TEXT");
    log.info("Added defaults column to agents table");
  }

  // Migration: add heartbeat columns to sessions if not exists
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((c) => c.name === "last_heartbeat_text")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_text TEXT;
    `);
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_sent_at INTEGER;
    `);
    log.info("Added heartbeat columns to sessions table");
  }

  // Migration: add last_context column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "last_context")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_context TEXT");
    log.info("Added last_context column to sessions table");
  }

  // Migration: add runtime_provider column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "runtime_provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_provider TEXT");
    log.info("Added runtime_provider column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_json TEXT");
    log.info("Added runtime_session_json column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_display_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_display_id TEXT");
    log.info("Added runtime_session_display_id column to sessions table");
  }
  db.exec(
    "UPDATE sessions SET runtime_provider = 'claude' WHERE runtime_provider IS NULL AND sdk_session_id IS NOT NULL",
  );
  db.exec(`
    UPDATE sessions
    SET runtime_session_display_id = sdk_session_id
    WHERE runtime_session_display_id IS NULL AND sdk_session_id IS NOT NULL
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_runtime_display ON sessions(runtime_session_display_id)");

  // Migration: add policy column to routes if not exists
  const routeColumns = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumns.some((c) => c.name === "policy")) {
    db.exec("ALTER TABLE routes ADD COLUMN policy TEXT");
    log.info("Added policy column to routes table");
  }

  // Migration: seed instances table from account.* settings (one-time)
  const instanceCount = (db.prepare("SELECT COUNT(*) as n FROM instances").get() as { n: number }).n;
  if (instanceCount === 0) {
    const settingRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'account.%'").all() as Array<{
      key: string;
      value: string;
    }>;
    const instanceData: Record<string, Partial<InstanceConfig>> = {};

    for (const { key, value } of settingRows) {
      const m = key.match(/^account\.([^.]+)\.(.+)$/);
      if (!m) continue;
      const [, name, field] = m;
      if (!instanceData[name]) instanceData[name] = { name };
      if (field === "instanceId") instanceData[name].instanceId = value;
      else if (field === "agent") instanceData[name].agent = value;
      else if (field === "dmPolicy" && (value === "open" || value === "pairing" || value === "closed"))
        instanceData[name].dmPolicy = value;
      else if (field === "groupPolicy" && (value === "open" || value === "allowlist" || value === "closed"))
        instanceData[name].groupPolicy = value;
    }

    const insertInstance = db.prepare(`
      INSERT OR IGNORE INTO instances (name, instance_id, channel, agent, dm_policy, group_policy, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const inst of Object.values(instanceData)) {
      if (!inst.name) continue;
      insertInstance.run(
        inst.name,
        inst.instanceId ?? null,
        "whatsapp",
        inst.agent ?? null,
        inst.dmPolicy ?? "open",
        inst.groupPolicy ?? "open",
        inst.enabled === false ? 0 : 1,
        now,
        now,
      );
      log.info("Migrated instance from settings", { name: inst.name });
    }
  }

  // Migration: add ephemeral session columns
  if (!sessionColumns.some((c) => c.name === "ephemeral")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ephemeral INTEGER DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_ephemeral ON sessions(ephemeral, expires_at) WHERE ephemeral = 1");
    log.info("Added ephemeral session columns to sessions table");
  }

  // Migration: add name column to sessions (human-readable unique identifier)
  if (!sessionColumns.some((c) => c.name === "name")) {
    db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL");
    log.info("Added name column to sessions table");

    // Migrate existing sessions: generate names from session_key
    const rows = db
      .prepare("SELECT session_key, agent_id, display_name, chat_type, group_id FROM sessions")
      .all() as Array<{
      session_key: string;
      agent_id: string;
      display_name: string | null;
      chat_type: string | null;
      group_id: string | null;
    }>;
    const usedNames = new Set<string>();
    const { slugify } = require("./session-name.js") as typeof import("./session-name.js");
    const updateName = db.prepare("UPDATE sessions SET name = ? WHERE session_key = ?");
    for (const row of rows) {
      let name: string;
      const agent = slugify(row.agent_id);
      if (row.session_key.endsWith(":main")) {
        name = agent;
      } else if (row.display_name) {
        name = `${agent}-${slugify(row.display_name)}`;
      } else if (row.group_id) {
        const cleanId = row.group_id.replace(/^group:/, "").slice(-8);
        name = `${agent}-group-${cleanId}`;
      } else {
        // DM or unknown — use last part of session key
        const parts = row.session_key.split(":");
        const lastPart = parts[parts.length - 1];
        const clean = slugify(lastPart).slice(-12);
        name = `${agent}-${clean || "session"}`;
      }
      // Deduplicate
      let finalName = name.slice(0, 64);
      let i = 2;
      while (usedNames.has(finalName)) {
        finalName = `${name.slice(0, 60)}-${i}`;
        i++;
      }
      usedNames.add(finalName);
      updateName.run(finalName, row.session_key);
    }
    if (rows.length > 0) {
      log.info(`Migrated ${rows.length} session names`);
    }
  }

  // Migration: create cron_jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      delete_after_run INTEGER DEFAULT 0,

      -- Schedule (one of these is set based on schedule_type)
      schedule_type TEXT NOT NULL,
      schedule_at INTEGER,
      schedule_every INTEGER,
      schedule_cron TEXT,
      schedule_timezone TEXT,

      -- Execution config
      session_target TEXT DEFAULT 'main',
      reply_session TEXT,
      payload_text TEXT NOT NULL,

      -- State
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);
  `);

  // Migration: add reply_session to cron_jobs
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN reply_session TEXT");
  } catch {
    /* column already exists */
  }

  db.exec(`
    -- Event triggers
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      session TEXT DEFAULT 'isolated' CHECK(session IN ('main','isolated')),
      enabled INTEGER DEFAULT 1,
      cooldown_ms INTEGER DEFAULT 5000,
      last_fired_at INTEGER,
      fire_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);
    CREATE INDEX IF NOT EXISTS idx_triggers_topic ON triggers(topic);
  `);

  // Migrations for triggers
  const triggerColumns = db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>;
  if (!triggerColumns.some((c) => c.name === "reply_session")) {
    db.exec("ALTER TABLE triggers ADD COLUMN reply_session TEXT");
    log.info("Added reply_session column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE triggers ADD COLUMN account_id TEXT");
    log.info("Added account_id column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "filter")) {
    db.exec("ALTER TABLE triggers ADD COLUMN filter TEXT");
    log.info("Added filter column to triggers table");
  }

  // Migration: add account_id column to cron_jobs
  const cronColumns = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  if (!cronColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN account_id TEXT");
    log.info("Added account_id column to cron_jobs table");
  }

  // Migration: add heartbeat_account_id column to agents
  if (!agentColumns.some((c) => c.name === "heartbeat_account_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN heartbeat_account_id TEXT");
    log.info("Added heartbeat_account_id column to agents table");
  }

  // Migration: add account_id column to routes (recreate table for UNIQUE constraint change)
  const routeColumnsV1 = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsV1.some((c) => c.name === "account_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE routes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          account_id TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
          priority INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(pattern, account_id)
        );
        INSERT INTO routes_new (id, pattern, account_id, agent_id, dm_scope, priority, created_at, updated_at)
          SELECT id, pattern, 'unknown', agent_id, dm_scope, priority, created_at, updated_at FROM routes;
        DROP TABLE routes;
        ALTER TABLE routes_new RENAME TO routes;
        CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
        CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
        CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id);
        COMMIT;
      `);
      log.info("Migrated routes table: added account_id column with UNIQUE(pattern, account_id)");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  // Ensure account index exists (for fresh DBs that skip migration)
  db.exec("CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id)");

  // Migration: add session_name column to routes
  const routeColumnsAfter = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsAfter.some((c) => c.name === "session_name")) {
    db.exec("ALTER TABLE routes ADD COLUMN session_name TEXT");
    log.info("Added session_name column to routes table");
  }

  // Migration: add channel column to routes (null = applies to all channels)
  if (!routeColumnsAfter.some((c) => c.name === "channel")) {
    db.exec("ALTER TABLE routes ADD COLUMN channel TEXT");
    // Drop old unique index and recreate including channel
    db.exec("DROP INDEX IF EXISTS idx_routes_unique_pattern");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_unique ON routes(pattern, account_id, COALESCE(channel, ''))",
    );
    log.info("Added channel column to routes table");
  }

  // Migration: soft-delete columns for routes and instances + audit_log table
  if (!routeColumnsAfter.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE routes ADD COLUMN deleted_at INTEGER");
    log.info("Added deleted_at column to routes table");
  }
  const instanceColumnsNow = db.prepare("PRAGMA table_info(instances)").all() as Array<{ name: string }>;
  if (!instanceColumnsNow.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE instances ADD COLUMN deleted_at INTEGER");
    log.info("Added deleted_at column to instances table");
  }
  if (!instanceColumnsNow.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE instances ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    log.info("Added enabled column to instances table");
  }

  const contextColumns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (contextColumns.length > 0 && !contextColumns.some((c) => c.name === "context_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE contexts_new (
          context_id TEXT PRIMARY KEY,
          context_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'runtime',
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
          session_name TEXT,
          source_json TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        INSERT INTO contexts_new (
          context_id, context_key, kind, agent_id, session_key, session_name,
          source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
        )
        SELECT
          'ctx_legacy_' || lower(hex(randomblob(12))),
          context_key,
          'legacy',
          agent_id,
          session_key,
          session_name,
          CASE
            WHEN source_channel IS NOT NULL AND source_account_id IS NOT NULL AND source_chat_id IS NOT NULL
              THEN json_object('channel', source_channel, 'accountId', source_account_id, 'chatId', source_chat_id)
            ELSE NULL
          END,
          '[]',
          NULL,
          created_at,
          NULL,
          updated_at,
          NULL
        FROM contexts;
        DROP TABLE contexts;
        ALTER TABLE contexts_new RENAME TO contexts;
        COMMIT;
      `);
      log.info("Migrated contexts table to central registry schema");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  const contextColumnsNow = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (!contextColumnsNow.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE contexts ADD COLUMN kind TEXT NOT NULL DEFAULT 'runtime'");
  }
  if (!contextColumnsNow.some((c) => c.name === "capabilities_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!contextColumnsNow.some((c) => c.name === "metadata_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN metadata_json TEXT");
  }
  if (!contextColumnsNow.some((c) => c.name === "expires_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN expires_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "last_used_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN last_used_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "revoked_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN revoked_at INTEGER");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_key ON contexts(context_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_agent ON contexts(agent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_session ON contexts(session_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_expires ON contexts(expires_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      old_value  TEXT,
      actor      TEXT NOT NULL DEFAULT 'daemon',
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, ts DESC);
  `);

  // Create default agent if none exist
  const count = db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
  if (count.count === 0) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (id, name, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("main", "Ravi", join(RAVI_DIR, "main"), now, now);
    log.info("Created default agent: main");
  }

  // Startup cleanup: remove any expired ephemeral sessions left over from previous runs
  const expiredCount = (
    db
      .prepare("SELECT COUNT(*) as n FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?")
      .get(Date.now()) as { n: number }
  ).n;
  if (expiredCount > 0) {
    db.prepare("DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(
      Date.now(),
    );
    log.info("Cleaned up expired ephemeral sessions at startup", { count: expiredCount });
  }

  log.debug("Database initialized", { path: nextDbPath });
  return db;
}

/**
 * Get the number of rows changed by the last INSERT/UPDATE/DELETE.
 * Uses SQLite's changes() function since bun:sqlite doesn't expose db.changes.
 */
function getDbChanges(): number {
  const row = getDb().prepare("SELECT changes() AS c").get() as { c: number } | null;
  return row?.c ?? 0;
}

// ============================================================================
// Prepared Statement Cache
// ============================================================================

interface PreparedStatements {
  insertAgent: Statement;
  updateAgent: Statement;
  updateAgentHeartbeatLastRun: Statement;
  deleteAgent: Statement;
  getAgent: Statement;
  listAgents: Statement;
  insertRoute: Statement;
  updateRoute: Statement;
  deleteRoute: Statement;
  getRoute: Statement;
  listRoutes: Statement;
  listRoutesByAccount: Statement;
  upsertSetting: Statement;
  getSetting: Statement;
  deleteSetting: Statement;
  listSettings: Statement;
  // Matrix accounts
  upsertMatrixAccount: Statement;
  getMatrixAccount: Statement;
  deleteMatrixAccount: Statement;
  listMatrixAccounts: Statement;
  touchMatrixAccount: Statement;
  // Message metadata
  upsertMessageMeta: Statement;
  getMessageMeta: Statement;
  cleanupMessageMeta: Statement;
  cleanupExpiredSessions: Statement;
  // Audit log
  insertAuditLog: Statement;
  // Soft-delete
  softDeleteRoute: Statement;
  restoreRoute: Statement;
  listDeletedRoutes: Statement;
  listDeletedRoutesByAccount: Statement;
  softDeleteInstance: Statement;
  restoreInstance: Statement;
  listDeletedInstances: Statement;
  // Cost events
  insertCostEvent: Statement;
  // Instances
  upsertInstance: Statement;
  getInstanceByName: Statement;
  getInstanceByInstanceId: Statement;
  listInstances: Statement;
  deleteInstance: Statement;
  updateInstance: Statement;
  // Contexts
  insertContext: Statement;
  getContextById: Statement;
  getContextByKey: Statement;
  listContexts: Statement;
  touchContext: Statement;
  revokeContext: Statement;
  updateContextCapabilities: Statement;
  deleteContext: Statement;
}

/**
 * Get prepared statements, creating them on first access.
 */
function getStatements(): PreparedStatements {
  if (routerDbState.stmts !== null) {
    return routerDbState.stmts;
  }

  const database = getDb();

  routerDbState.stmts = {
    // Agents
    insertAgent: database.prepare(`
      INSERT INTO agents (id, name, cwd, model, provider, remote, remote_user, dm_scope, system_prompt_append, debounce_ms, group_debounce_ms, matrix_account, setting_sources,
        heartbeat_enabled, heartbeat_interval_ms, heartbeat_model, heartbeat_active_start, heartbeat_active_end, heartbeat_account_id,
        spec_mode,
        contact_scope, allowed_sessions,
        agent_mode,
        defaults,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?,
        cwd = ?,
        model = ?,
        provider = ?,
        remote = ?,
        remote_user = ?,
        dm_scope = ?,
        system_prompt_append = ?,
        debounce_ms = ?,
        group_debounce_ms = ?,
        matrix_account = ?,
        setting_sources = ?,
        heartbeat_enabled = ?,
        heartbeat_interval_ms = ?,
        heartbeat_model = ?,
        heartbeat_active_start = ?,
        heartbeat_active_end = ?,
        heartbeat_account_id = ?,
        spec_mode = ?,
        contact_scope = ?,
        allowed_sessions = ?,
        agent_mode = ?,
        defaults = ?,
        updated_at = ?
      WHERE id = ?
    `),
    updateAgentHeartbeatLastRun: database.prepare(`
      UPDATE agents SET heartbeat_last_run_at = ?, updated_at = ? WHERE id = ?
    `),
    deleteAgent: database.prepare("DELETE FROM agents WHERE id = ?"),
    getAgent: database.prepare("SELECT * FROM agents WHERE id = ?"),
    listAgents: database.prepare("SELECT * FROM agents ORDER BY id"),

    // Routes
    insertRoute: database.prepare(`
      INSERT INTO routes (pattern, account_id, agent_id, dm_scope, session_name, policy, priority, channel, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateRoute: database.prepare(`
      UPDATE routes SET
        agent_id = ?,
        dm_scope = ?,
        session_name = ?,
        policy = ?,
        priority = ?,
        channel = ?,
        updated_at = ?
      WHERE pattern = ? AND account_id = ?
    `),
    deleteRoute: database.prepare("DELETE FROM routes WHERE pattern = ? AND account_id = ?"),
    getRoute: database.prepare("SELECT * FROM routes WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL"),
    listRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NULL ORDER BY priority DESC, id"),
    listRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NULL ORDER BY priority DESC, id",
    ),

    // Settings
    upsertSetting: database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getSetting: database.prepare("SELECT * FROM settings WHERE key = ?"),
    deleteSetting: database.prepare("DELETE FROM settings WHERE key = ?"),
    listSettings: database.prepare("SELECT * FROM settings ORDER BY key"),

    // Matrix accounts
    upsertMatrixAccount: database.prepare(`
      INSERT INTO matrix_accounts (username, user_id, homeserver, access_token, device_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        user_id = excluded.user_id,
        homeserver = excluded.homeserver,
        access_token = excluded.access_token,
        device_id = excluded.device_id,
        last_used_at = excluded.last_used_at
    `),
    getMatrixAccount: database.prepare("SELECT * FROM matrix_accounts WHERE username = ?"),
    deleteMatrixAccount: database.prepare("DELETE FROM matrix_accounts WHERE username = ?"),
    listMatrixAccounts: database.prepare("SELECT * FROM matrix_accounts ORDER BY username"),
    touchMatrixAccount: database.prepare("UPDATE matrix_accounts SET last_used_at = ? WHERE username = ?"),
    // Message metadata
    upsertMessageMeta: database.prepare(`
      INSERT INTO message_metadata (message_id, chat_id, transcription, media_path, media_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        transcription = COALESCE(excluded.transcription, message_metadata.transcription),
        media_path = COALESCE(excluded.media_path, message_metadata.media_path),
        media_type = COALESCE(excluded.media_type, message_metadata.media_type)
    `),
    getMessageMeta: database.prepare("SELECT * FROM message_metadata WHERE message_id = ?"),
    cleanupMessageMeta: database.prepare("DELETE FROM message_metadata WHERE created_at < ?"),
    cleanupExpiredSessions: database.prepare(
      "DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    ),
    // Audit log
    insertAuditLog: database.prepare(
      "INSERT INTO audit_log (action, entity, entity_id, old_value, actor, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    // Soft-delete: routes
    softDeleteRoute: database.prepare(
      "UPDATE routes SET deleted_at = ? WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL",
    ),
    restoreRoute: database.prepare("UPDATE routes SET deleted_at = NULL WHERE pattern = ? AND account_id = ?"),
    listDeletedRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    listDeletedRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Soft-delete: instances
    softDeleteInstance: database.prepare("UPDATE instances SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL"),
    restoreInstance: database.prepare("UPDATE instances SET deleted_at = NULL WHERE name = ?"),
    listDeletedInstances: database.prepare(
      "SELECT * FROM instances WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Cost events
    insertCostEvent: database.prepare(`
      INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd,
        total_cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Instances
    upsertInstance: database.prepare(`
      INSERT INTO instances (name, instance_id, channel, agent, dm_policy, group_policy, dm_scope, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        instance_id  = excluded.instance_id,
        channel      = excluded.channel,
        agent        = excluded.agent,
        dm_policy    = excluded.dm_policy,
        group_policy = excluded.group_policy,
        dm_scope     = excluded.dm_scope,
        enabled      = excluded.enabled,
        updated_at   = excluded.updated_at
    `),
    getInstanceByName: database.prepare("SELECT * FROM instances WHERE name = ? AND deleted_at IS NULL"),
    getInstanceByInstanceId: database.prepare("SELECT * FROM instances WHERE instance_id = ? AND deleted_at IS NULL"),
    listInstances: database.prepare("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY name"),
    deleteInstance: database.prepare("DELETE FROM instances WHERE name = ?"),
    updateInstance: database.prepare(`
      UPDATE instances SET
        instance_id  = ?,
        channel      = ?,
        agent        = ?,
        dm_policy    = ?,
        group_policy = ?,
        dm_scope     = ?,
        enabled      = ?,
        updated_at   = ?
      WHERE name = ?
    `),
    // Contexts
    insertContext: database.prepare(`
      INSERT INTO contexts (
        context_id, context_key, kind, agent_id, session_key, session_name,
        source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getContextById: database.prepare("SELECT * FROM contexts WHERE context_id = ?"),
    getContextByKey: database.prepare("SELECT * FROM contexts WHERE context_key = ?"),
    listContexts: database.prepare("SELECT * FROM contexts ORDER BY created_at DESC"),
    touchContext: database.prepare("UPDATE contexts SET last_used_at = ? WHERE context_id = ?"),
    revokeContext: database.prepare("UPDATE contexts SET revoked_at = ? WHERE context_id = ?"),
    updateContextCapabilities: database.prepare(`
      UPDATE contexts SET
        capabilities_json = ?,
        last_used_at = ?
      WHERE context_id = ?
    `),
    deleteContext: database.prepare("DELETE FROM contexts WHERE context_id = ?"),
  };

  return routerDbState.stmts!;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToAgent(row: AgentRow): AgentConfig {
  const result: AgentConfig = {
    id: row.id,
    cwd: row.cwd,
  };

  if (row.name !== null) result.name = row.name;
  if (row.model !== null) result.model = row.model;
  if (row.provider === "claude" || row.provider === "codex") result.provider = row.provider;
  if (row.remote !== null) result.remote = row.remote;
  if (row.remote_user !== null) result.remoteUser = row.remote_user;
  if (row.dm_scope !== null) {
    // Validate before casting
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }
  if (row.system_prompt_append !== null) result.systemPromptAppend = row.system_prompt_append;
  if (row.debounce_ms !== null) result.debounceMs = row.debounce_ms;
  if (row.group_debounce_ms !== null) result.groupDebounceMs = row.group_debounce_ms;
  if (row.matrix_account !== null) result.matrixAccount = row.matrix_account;
  if (row.setting_sources !== null) {
    try {
      result.settingSources = JSON.parse(row.setting_sources);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Heartbeat fields
  result.heartbeat = {
    enabled: row.heartbeat_enabled === 1,
    intervalMs: row.heartbeat_interval_ms ?? 1800000,
    model: row.heartbeat_model ?? undefined,
    accountId: row.heartbeat_account_id ?? undefined,
    activeStart: row.heartbeat_active_start ?? undefined,
    activeEnd: row.heartbeat_active_end ?? undefined,
    lastRunAt: row.heartbeat_last_run_at ?? undefined,
  };

  // Spec mode
  result.specMode = row.spec_mode === 1;

  // Scope isolation
  if (row.contact_scope !== null) result.contactScope = row.contact_scope;
  if (row.allowed_sessions !== null) {
    try {
      result.allowedSessions = JSON.parse(row.allowed_sessions);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Agent mode
  if (row.agent_mode === "active" || row.agent_mode === "sentinel") {
    result.mode = row.agent_mode;
  }

  // Generic defaults
  if (row.defaults !== null) {
    try {
      result.defaults = JSON.parse(row.defaults);
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

function rowToRoute(row: RouteRow): RouteConfig & { id: number } {
  const result: RouteConfig & { id: number } = {
    id: row.id,
    pattern: row.pattern,
    accountId: row.account_id,
    agent: row.agent_id,
    priority: row.priority,
  };

  if (row.dm_scope !== null) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }

  if (row.session_name !== null) {
    result.session = row.session_name;
  }

  if ((row as RouteRow & { policy?: string | null }).policy != null) {
    result.policy = (row as RouteRow & { policy?: string | null }).policy!;
  }

  if (row.channel !== null) {
    result.channel = row.channel;
  }

  return result;
}

function rowToInstance(row: InstanceRow): InstanceConfig {
  const result: InstanceConfig = {
    name: row.name,
    channel: row.channel,
    dmPolicy: (row.dm_policy ?? "open") as InstanceConfig["dmPolicy"],
    groupPolicy: (row.group_policy ?? "open") as InstanceConfig["groupPolicy"],
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.instance_id) result.instanceId = row.instance_id;
  if (row.agent) result.agent = row.agent;
  if (row.dm_scope) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) result.dmScope = parsed.data;
  }
  if (row.deleted_at) result.deletedAt = row.deleted_at;
  return result;
}

function rowToContext(row: ContextRow): ContextRecord {
  const result: ContextRecord = {
    contextId: row.context_id,
    contextKey: row.context_key,
    kind: row.kind,
    capabilities: [],
    createdAt: row.created_at,
  };

  if (row.agent_id) result.agentId = row.agent_id;
  if (row.session_key) result.sessionKey = row.session_key;
  if (row.session_name) result.sessionName = row.session_name;
  if (row.expires_at) result.expiresAt = row.expires_at;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  if (row.revoked_at) result.revokedAt = row.revoked_at;

  if (row.source_json) {
    try {
      const parsed = ContextSourceSchema.safeParse(JSON.parse(row.source_json));
      if (parsed.success) result.source = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  try {
    const parsed = z.array(ContextCapabilitySchema).safeParse(JSON.parse(row.capabilities_json));
    if (parsed.success) result.capabilities = parsed.data;
  } catch {
    // Ignore invalid JSON
  }

  if (row.metadata_json) {
    try {
      const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(row.metadata_json));
      if (parsed.success) result.metadata = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * Create a new agent
 */
export function dbCreateAgent(input: z.input<typeof AgentInputSchema>): AgentConfig {
  const validated = AgentInputSchema.parse(input);
  const now = Date.now();
  const s = getStatements();

  // Verify matrix account exists if specified
  if (validated.matrixAccount) {
    const account = dbGetMatrixAccount(validated.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${validated.matrixAccount}`);
    }
  }

  try {
    s.insertAgent.run(
      validated.id,
      validated.name ?? null,
      validated.cwd,
      validated.model ?? null,
      validated.provider ?? null,
      validated.remote ?? null,
      validated.remoteUser ?? null,
      validated.dmScope ?? null,
      validated.systemPromptAppend ?? null,
      validated.debounceMs ?? null,
      validated.groupDebounceMs ?? null,
      validated.matrixAccount ?? null,
      validated.settingSources ? JSON.stringify(validated.settingSources) : null,
      // Heartbeat fields (defaults)
      0, // heartbeat_enabled
      1800000, // heartbeat_interval_ms (30 min)
      null, // heartbeat_model
      null, // heartbeat_active_start
      null, // heartbeat_active_end
      null, // heartbeat_account_id
      0, // spec_mode (disabled by default)
      null, // contact_scope (no restriction by default)
      null, // allowed_sessions (no cross-session by default)
      validated.mode ?? null, // agent_mode
      null, // defaults
      now,
      now,
    );

    log.info("Created agent", { id: validated.id });
    return dbGetAgent(validated.id)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Agent already exists: ${validated.id}`);
    }
    throw err;
  }
}

/**
 * Get agent by ID
 */
export function dbGetAgent(id: string): AgentConfig | null {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * List all agents
 */
export function dbListAgents(): AgentConfig[] {
  const s = getStatements();
  const rows = s.listAgents.all() as AgentRow[];
  return rows.map(rowToAgent);
}

/**
 * Update an existing agent
 */
export function dbUpdateAgent(id: string, updates: Partial<AgentConfig>): AgentConfig {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;

  if (!row) {
    throw new Error(`Agent not found: ${id}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  // Verify matrix account exists if specified
  if (updates.matrixAccount !== undefined && updates.matrixAccount !== null) {
    const account = dbGetMatrixAccount(updates.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${updates.matrixAccount}`);
    }
  }

  const now = Date.now();
  const hb = updates.heartbeat;
  s.updateAgent.run(
    updates.name !== undefined ? (updates.name ?? null) : row.name,
    updates.cwd ?? row.cwd,
    updates.model !== undefined ? (updates.model ?? null) : row.model,
    updates.provider !== undefined ? (updates.provider ?? null) : row.provider,
    updates.remote !== undefined ? (updates.remote ?? null) : row.remote,
    updates.remoteUser !== undefined ? (updates.remoteUser ?? null) : row.remote_user,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.systemPromptAppend !== undefined ? (updates.systemPromptAppend ?? null) : row.system_prompt_append,
    updates.debounceMs !== undefined ? (updates.debounceMs ?? null) : row.debounce_ms,
    updates.groupDebounceMs !== undefined ? (updates.groupDebounceMs ?? null) : row.group_debounce_ms,
    updates.matrixAccount !== undefined ? (updates.matrixAccount ?? null) : row.matrix_account,
    updates.settingSources !== undefined
      ? updates.settingSources
        ? JSON.stringify(updates.settingSources)
        : null
      : row.setting_sources,
    // Heartbeat fields
    hb?.enabled !== undefined ? (hb.enabled ? 1 : 0) : row.heartbeat_enabled,
    hb?.intervalMs !== undefined ? hb.intervalMs : row.heartbeat_interval_ms,
    hb?.model !== undefined ? (hb.model ?? null) : row.heartbeat_model,
    hb?.activeStart !== undefined ? (hb.activeStart ?? null) : row.heartbeat_active_start,
    hb?.activeEnd !== undefined ? (hb.activeEnd ?? null) : row.heartbeat_active_end,
    hb?.accountId !== undefined ? (hb.accountId ?? null) : row.heartbeat_account_id,
    // Spec mode
    updates.specMode !== undefined ? (updates.specMode ? 1 : 0) : row.spec_mode,
    // Scope isolation
    updates.contactScope !== undefined ? (updates.contactScope ?? null) : row.contact_scope,
    updates.allowedSessions !== undefined
      ? updates.allowedSessions
        ? JSON.stringify(updates.allowedSessions)
        : null
      : row.allowed_sessions,
    // Agent mode
    updates.mode !== undefined ? (updates.mode ?? null) : row.agent_mode,
    // Generic defaults
    updates.defaults !== undefined ? (updates.defaults ? JSON.stringify(updates.defaults) : null) : row.defaults,
    now,
    id,
  );

  log.info("Updated agent", { id });
  return dbGetAgent(id)!;
}

/**
 * Update agent's heartbeat last run timestamp
 */
export function dbUpdateAgentHeartbeatLastRun(id: string): void {
  const s = getStatements();
  const now = Date.now();
  s.updateAgentHeartbeatLastRun.run(now, now, id);
}

/**
 * Delete an agent
 */
export function dbDeleteAgent(id: string): boolean {
  // Cannot delete the default agent
  const defaultAgentId = getDefaultAgentId();
  if (id === defaultAgentId) {
    throw new Error(`Cannot delete default agent: ${id}`);
  }

  const s = getStatements();
  s.deleteAgent.run(id);
  if (getDbChanges() > 0) {
    log.info("Deleted agent", { id });
    return true;
  }
  return false;
}

/**
 * Set debounce time for an agent (null = disable debounce)
 */
export function dbSetAgentDebounce(id: string, debounceMs: number | null): void {
  dbUpdateAgent(id, { debounceMs: debounceMs as number | undefined });
  log.info("Set agent debounce", { id, debounceMs });
}

// ============================================================================
// Agent Spec Mode
// ============================================================================

/**
 * Enable or disable spec mode for an agent
 */
export function dbSetAgentSpecMode(id: string, enabled: boolean): void {
  dbUpdateAgent(id, { specMode: enabled });
  log.info("Set agent spec mode", { id, enabled });
}

// ============================================================================
// Route CRUD
// ============================================================================

/**
 * Create a new route
 */
export function dbCreateRoute(input: z.input<typeof RouteInputSchema>): RouteConfig {
  const validated = RouteInputSchema.parse(input);
  const s = getStatements();

  // Verify agent exists
  if (!dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }

  const now = Date.now();
  const normalizedPattern = validated.pattern.toLowerCase();

  try {
    s.insertRoute.run(
      normalizedPattern,
      validated.accountId,
      validated.agent,
      validated.dmScope ?? null,
      validated.session ?? null,
      validated.policy ?? null,
      validated.priority,
      validated.channel ?? null,
      now,
      now,
    );

    log.info("Created route", {
      pattern: normalizedPattern,
      account: validated.accountId,
      agent: validated.agent,
      channel: validated.channel ?? "*",
    });
    return dbGetRoute(normalizedPattern, validated.accountId)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      const channelSuffix = validated.channel ? ` [${validated.channel}]` : "";
      throw new Error(`Route already exists: ${validated.pattern} (account: ${validated.accountId}${channelSuffix})`);
    }
    throw err;
  }
}

/**
 * Get route by pattern and account
 */
export function dbGetRoute(pattern: string, accountId: string): (RouteConfig & { id: number }) | null {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;
  return row ? rowToRoute(row) : null;
}

/**
 * List routes, optionally filtered by account
 */
export function dbListRoutes(accountId?: string): (RouteConfig & { id: number })[] {
  const s = getStatements();
  const rows = accountId ? (s.listRoutesByAccount.all(accountId) as RouteRow[]) : (s.listRoutes.all() as RouteRow[]);
  return rows.map(rowToRoute);
}

/**
 * Update an existing route
 */
export function dbUpdateRoute(pattern: string, updates: Partial<RouteConfig>, accountId: string): RouteConfig {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;

  if (!row) {
    throw new Error(`Route not found: ${pattern} (account: ${accountId})`);
  }

  // Verify agent if updating
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  const now = Date.now();
  s.updateRoute.run(
    updates.agent ?? row.agent_id,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.session !== undefined ? (updates.session ?? null) : row.session_name,
    updates.policy !== undefined ? (updates.policy ?? null) : row.policy,
    updates.priority ?? row.priority,
    updates.channel !== undefined ? (updates.channel ?? null) : row.channel,
    now,
    pattern,
    accountId,
  );

  log.info("Updated route", { pattern, accountId });
  return dbGetRoute(pattern, accountId)!;
}

/**
 * Soft-delete a route (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const route = dbGetRoute(pattern, accountId);
  if (!route) return false;
  const now = Date.now();
  s.softDeleteRoute.run(now, pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run(
      "route.deleted",
      "route",
      `${pattern}@${accountId}`,
      JSON.stringify(route),
      process.env.USER ?? "daemon",
      now,
    );
    log.info("Soft-deleted route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted route.
 */
export function dbRestoreRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreRoute.run(pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("route.restored", "route", `${pattern}@${accountId}`, null, process.env.USER ?? "daemon", now);
    log.info("Restored route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * List soft-deleted routes (for recovery/audit).
 */
export function dbListDeletedRoutes(accountId?: string): RouteConfig[] {
  const s = getStatements();
  const rows = (accountId ? s.listDeletedRoutesByAccount.all(accountId) : s.listDeletedRoutes.all()) as RouteRow[];
  return rows.map(rowToRoute);
}

// ============================================================================
// Settings
// ============================================================================

/**
 * Get a setting value
 */
export function dbGetSetting(key: string): string | null {
  const s = getStatements();
  const row = s.getSetting.get(key) as SettingRow | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting value
 */
export function dbSetSetting(key: string, value: string): void {
  // Validate specific settings
  if (key === "defaultDmScope") {
    DmScopeSchema.parse(value);
  }
  if (key === "defaultAgent") {
    if (!dbGetAgent(value)) {
      throw new Error(`Agent not found: ${value}`);
    }
  }

  const s = getStatements();
  const now = Date.now();
  s.upsertSetting.run(key, value, now);
  log.info("Set setting", { key, value });
}

/**
 * Delete a setting
 */
export function dbDeleteSetting(key: string): boolean {
  const s = getStatements();
  s.deleteSetting.run(key);
  return getDbChanges() > 0;
}

/**
 * List all settings
 */
export function dbListSettings(): Record<string, string> {
  const s = getStatements();
  const rows = s.listSettings.all() as SettingRow[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================================
// Instance CRUD
// ============================================================================

export function dbUpsertInstance(input: z.input<typeof InstanceInputSchema>): InstanceConfig {
  const validated = InstanceInputSchema.parse(input);
  if (validated.agent && !dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }
  const s = getStatements();
  const now = Date.now();
  s.upsertInstance.run(
    validated.name,
    validated.instanceId ?? null,
    validated.channel,
    validated.agent ?? null,
    validated.dmPolicy,
    validated.groupPolicy,
    validated.dmScope ?? null,
    validated.enabled ? 1 : 0,
    now,
    now,
  );
  log.info("Upserted instance", { name: validated.name });
  return dbGetInstance(validated.name)!;
}

export function dbGetInstance(name: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbGetInstanceByInstanceId(instanceId: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByInstanceId.get(instanceId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbListInstances(): InstanceConfig[] {
  const s = getStatements();
  const rows = s.listInstances.all() as InstanceRow[];
  return rows.map(rowToInstance);
}

export function dbUpdateInstance(
  name: string,
  updates: Partial<Omit<InstanceConfig, "name" | "createdAt" | "updatedAt">>,
): InstanceConfig {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  if (!row) throw new Error(`Instance not found: ${name}`);
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }
  if (updates.dmScope) DmScopeSchema.parse(updates.dmScope);
  if (updates.dmPolicy) DmPolicySchema.parse(updates.dmPolicy);
  if (updates.groupPolicy) GroupPolicySchema.parse(updates.groupPolicy);
  const now = Date.now();
  s.updateInstance.run(
    updates.instanceId !== undefined ? (updates.instanceId ?? null) : row.instance_id,
    updates.channel ?? row.channel,
    updates.agent !== undefined ? (updates.agent ?? null) : row.agent,
    updates.dmPolicy ?? row.dm_policy,
    updates.groupPolicy ?? row.group_policy,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (row.enabled ?? 1),
    now,
    name,
  );
  log.info("Updated instance", { name, ...updates });
  return dbGetInstance(name)!;
}

/**
 * Soft-delete an instance (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteInstance(name: string): boolean {
  const s = getStatements();
  const inst = dbGetInstance(name);
  if (!inst) return false;
  const now = Date.now();
  s.softDeleteInstance.run(now, name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.deleted", "instance", name, JSON.stringify(inst), process.env.USER ?? "daemon", now);
    log.info("Soft-deleted instance", { name });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted instance.
 */
export function dbRestoreInstance(name: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreInstance.run(name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.restored", "instance", name, null, process.env.USER ?? "daemon", now);
    log.info("Restored instance", { name });
    return true;
  }
  return false;
}

/**
 * List soft-deleted instances (for recovery/audit).
 */
export function dbListDeletedInstances(): InstanceConfig[] {
  const s = getStatements();
  return (s.listDeletedInstances.all() as InstanceRow[]).map(rowToInstance);
}

// ============================================================================
// Context Registry
// ============================================================================

export function dbCreateContext(input: z.input<typeof ContextInputSchema>): ContextRecord {
  const validated = ContextInputSchema.parse(input);
  if (validated.agentId && !dbGetAgent(validated.agentId)) {
    throw new Error(`Agent not found: ${validated.agentId}`);
  }

  const s = getStatements();
  const createdAt = validated.createdAt ?? Date.now();

  try {
    s.insertContext.run(
      validated.contextId,
      validated.contextKey,
      validated.kind,
      validated.agentId ?? null,
      validated.sessionKey ?? null,
      validated.sessionName ?? null,
      validated.source ? JSON.stringify(validated.source) : null,
      JSON.stringify(validated.capabilities),
      validated.metadata ? JSON.stringify(validated.metadata) : null,
      createdAt,
      validated.expiresAt ?? null,
      validated.lastUsedAt ?? null,
      validated.revokedAt ?? null,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Context already exists: ${validated.contextId}`);
    }
    throw err;
  }

  return dbGetContext(validated.contextId)!;
}

export function dbGetContext(contextId: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextById.get(contextId) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbGetContextByKey(contextKey: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextByKey.get(contextKey) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbListContexts(options: ListContextsOptions = {}): ContextRecord[] {
  const s = getStatements();
  const now = Date.now();
  const rows = s.listContexts.all() as ContextRow[];

  return rows
    .map((row) => rowToContext(row))
    .filter((context) => {
      if (options.agentId && context.agentId !== options.agentId) return false;
      if (options.sessionKey && context.sessionKey !== options.sessionKey) return false;
      if (options.kind && context.kind !== options.kind) return false;

      if (!options.includeInactive) {
        if (context.revokedAt && context.revokedAt <= now) return false;
        if (context.expiresAt && context.expiresAt <= now) return false;
      }

      return true;
    });
}

export function dbTouchContext(contextId: string, lastUsedAt = Date.now()): void {
  const s = getStatements();
  s.touchContext.run(lastUsedAt, contextId);
}

export function dbRevokeContext(contextId: string, revokedAt = Date.now()): ContextRecord {
  const s = getStatements();
  const existing = dbGetContext(contextId);
  if (!existing) {
    throw new Error(`Context not found: ${contextId}`);
  }
  s.revokeContext.run(revokedAt, contextId);
  return dbGetContext(contextId)!;
}

export function dbUpdateContextCapabilities(contextId: string, capabilities: ContextCapability[]): ContextRecord {
  const s = getStatements();
  if (!dbGetContext(contextId)) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const validated = z.array(ContextCapabilitySchema).parse(capabilities);
  s.updateContextCapabilities.run(JSON.stringify(validated), Date.now(), contextId);
  return dbGetContext(contextId)!;
}

export function dbDeleteContext(contextId: string): boolean {
  const s = getStatements();
  s.deleteContext.run(contextId);
  return getDbChanges() > 0;
}

// ============================================================================
// Convenience Getters
// ============================================================================

/**
 * Get default agent ID
 */
export function getDefaultAgentId(): string {
  return dbGetSetting("defaultAgent") ?? "main";
}

/**
 * Get default DM scope
 */
export function getDefaultDmScope(): DmScope {
  const value = dbGetSetting("defaultDmScope");
  if (value === null) {
    return "per-peer";
  }
  const parsed = DmScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : "per-peer";
}

/**
 * Get default timezone for cron jobs
 */
export function getDefaultTimezone(): string | undefined {
  return dbGetSetting("defaultTimezone") ?? undefined;
}

/**
 * Get the first registered instance name.
 */
export function getFirstAccountName(): string | undefined {
  const instances = dbListInstances();
  return instances.find((instance) => instance.enabled !== false)?.name;
}

/**
 * Get the instance name mapped to a specific agent.
 * Falls back to first instance name if no mapping found.
 */
export function getAccountForAgent(agentId: string): string | undefined {
  const instances = dbListInstances();
  return (
    instances.find((instance) => instance.enabled !== false && instance.agent === agentId)?.name ??
    instances.find((instance) => instance.enabled !== false)?.name
  );
}

/**
 * Whether to announce compaction start/end to the active session's channel.
 * Setting value: "true" or "false" (default: "true")
 */
export function getAnnounceCompaction(): boolean {
  return dbGetSetting("announceCompaction") !== "false";
}

// ============================================================================
// Database Management
// ============================================================================

/**
 * Close the database connection
 */
export function closeRouterDb(): void {
  if (routerDbState.db !== null) {
    routerDbState.db.close();
    routerDbState.db = null;
    routerDbState.stmts = null;
    routerDbState.dbPath = null;
  }
}

/**
 * Get the shared database connection (for sessions.ts)
 */
export { getDb, getDbChanges };

/**
 * Get the database path
 */
export function getRaviDbPath(): string {
  return resolveDbPath();
}

/**
 * Get the ravi directory
 */
export function getRaviDir(): string {
  return getRaviStateDir();
}

// ============================================================================
// Matrix Accounts (all Matrix users - both regular users and agents)
// ============================================================================

function rowToMatrixAccount(row: MatrixAccountRow): MatrixAccount {
  const result: MatrixAccount = {
    username: row.username,
    userId: row.user_id,
    homeserver: row.homeserver,
    accessToken: row.access_token,
    createdAt: row.created_at,
  };
  if (row.device_id) result.deviceId = row.device_id;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  return result;
}

/**
 * Add or update a Matrix account
 */
export function dbUpsertMatrixAccount(account: Omit<MatrixAccount, "createdAt" | "lastUsedAt">): MatrixAccount {
  const s = getStatements();
  const existing = s.getMatrixAccount.get(account.username) as MatrixAccountRow | undefined;
  const now = Date.now();

  s.upsertMatrixAccount.run(
    account.username,
    account.userId,
    account.homeserver,
    account.accessToken,
    account.deviceId ?? null,
    existing?.created_at ?? now,
    now,
  );

  log.info("Upserted matrix account", { username: account.username, userId: account.userId });
  return dbGetMatrixAccount(account.username)!;
}

/**
 * Get a Matrix account by username
 */
export function dbGetMatrixAccount(username: string): MatrixAccount | null {
  const s = getStatements();
  const row = s.getMatrixAccount.get(username) as MatrixAccountRow | undefined;
  return row ? rowToMatrixAccount(row) : null;
}

/**
 * List all Matrix accounts
 */
export function dbListMatrixAccounts(): MatrixAccount[] {
  const s = getStatements();
  const rows = s.listMatrixAccounts.all() as MatrixAccountRow[];
  return rows.map(rowToMatrixAccount);
}

/**
 * Delete a Matrix account
 */
export function dbDeleteMatrixAccount(username: string): boolean {
  // Check if any agent references this account
  const agents = dbListAgents();
  const referencingAgent = agents.find((a) => a.matrixAccount === username);
  if (referencingAgent) {
    throw new Error(`Cannot delete: account is used by agent "${referencingAgent.id}"`);
  }

  const s = getStatements();
  s.deleteMatrixAccount.run(username);
  if (getDbChanges() > 0) {
    log.info("Deleted matrix account", { username });
    return true;
  }
  return false;
}

/**
 * Touch a Matrix account (update last_used_at)
 */
export function dbTouchMatrixAccount(username: string): void {
  const s = getStatements();
  s.touchMatrixAccount.run(Date.now(), username);
}

/**
 * Get Matrix account for an agent
 */
export function dbGetAgentMatrixAccount(agentId: string): MatrixAccount | null {
  const agent = dbGetAgent(agentId);
  if (!agent?.matrixAccount) return null;
  return dbGetMatrixAccount(agent.matrixAccount);
}

// ============================================================================
// Message Metadata (transcriptions + media paths for reply reinjection)
// ============================================================================

export interface MessageMetadata {
  messageId: string;
  chatId: string;
  transcription?: string;
  mediaPath?: string;
  mediaType?: string;
  createdAt: number;
}

/**
 * Store message metadata (transcription/media path).
 * Upserts — safe to call multiple times for the same message.
 */
export function dbSaveMessageMeta(
  messageId: string,
  chatId: string,
  opts: { transcription?: string; mediaPath?: string; mediaType?: string },
): void {
  const s = getStatements();
  s.upsertMessageMeta.run(
    messageId,
    chatId,
    opts.transcription ?? null,
    opts.mediaPath ?? null,
    opts.mediaType ?? null,
    Date.now(),
  );
}

/**
 * Get message metadata by message ID.
 */
export function dbGetMessageMeta(messageId: string): MessageMetadata | null {
  const s = getStatements();
  const row = s.getMessageMeta.get(messageId) as {
    message_id: string;
    chat_id: string;
    transcription: string | null;
    media_path: string | null;
    media_type: string | null;
    created_at: number;
  } | null;
  if (!row) return null;
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    transcription: row.transcription ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type ?? undefined,
    createdAt: row.created_at,
  };
}

const MESSAGE_META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Delete message metadata older than 7 days.
 * Returns number of rows deleted.
 */
export function dbCleanupMessageMeta(): number {
  const s = getStatements();
  s.cleanupMessageMeta.run(Date.now() - MESSAGE_META_TTL_MS);
  return getDbChanges();
}

/**
 * Hard-delete ephemeral sessions that have already expired.
 * Safe to call at any time — idempotent, only removes rows with expires_at <= now.
 * Returns number of rows deleted.
 */
export function dbCleanupExpiredSessions(): number {
  const s = getStatements();
  s.cleanupExpiredSessions.run(Date.now());
  return getDbChanges();
}

// ============================================================================
// Audit Log
// ============================================================================

export interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  oldValue: unknown | null;
  actor: string;
  ts: number;
}

// ============================================================================
// Cost Events
// ============================================================================

export interface CostEvent {
  id: number;
  sessionKey: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCostUsd: number;
  totalCostUsd: number;
  createdAt: number;
}

/**
 * Insert a cost event for a single turn.
 */
export function dbInsertCostEvent(event: Omit<CostEvent, "id">): void {
  const s = getStatements();
  s.insertCostEvent.run(
    event.sessionKey,
    event.agentId,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheCreationTokens,
    event.inputCostUsd,
    event.outputCostUsd,
    event.cacheCostUsd,
    event.totalCostUsd,
    event.createdAt,
  );
}

interface CostSummaryRow {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  turns: number;
}

interface AgentCostRow extends CostSummaryRow {
  agent_id: string;
  model: string;
}

interface SessionCostRow extends CostSummaryRow {
  session_key: string;
}

/**
 * Get total cost summary for a time range.
 */
export function dbGetCostSummary(sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE created_at >= ?`,
    )
    .get(sinceMs) as CostSummaryRow;
}

/**
 * Get cost breakdown by agent for a time range.
 */
export function dbGetCostByAgent(sinceMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(sinceMs) as AgentCostRow[];
}

/**
 * Get cost for a specific agent in a time range.
 */
export function dbGetCostForAgent(agentId: string, sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE agent_id = ? AND created_at >= ?`,
    )
    .get(agentId, sinceMs) as CostSummaryRow;
}

/**
 * Get cost for a specific session.
 */
export function dbGetCostForSession(sessionKey: string): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE session_key = ?`,
    )
    .get(sessionKey) as CostSummaryRow;
}

/**
 * Get top N most expensive sessions in a time range.
 */
export function dbGetTopSessions(sinceMs: number, limit = 10): SessionCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      session_key,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY session_key
    ORDER BY total_cost DESC
    LIMIT ?`,
    )
    .all(sinceMs, limit) as SessionCostRow[];
}

/**
 * Get cost report for a date range (from, to in ms).
 */
export function dbGetCostReport(fromMs: number, toMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ? AND created_at < ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(fromMs, toMs) as AgentCostRow[];
}

/**
 * Read recent audit log entries.
 * @param entity  Filter by entity type ("route" | "instance"). Omit for all.
 * @param limit   Max rows to return (default 100).
 */
export function dbListAuditLog(entity?: string, limit = 100): AuditEntry[] {
  const db = getDb();
  const rows = entity
    ? (db.prepare("SELECT * FROM audit_log WHERE entity = ? ORDER BY ts DESC LIMIT ?").all(entity, limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>)
    : (db.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    oldValue: r.old_value ? JSON.parse(r.old_value) : null,
    actor: r.actor,
    ts: r.ts,
  }));
}

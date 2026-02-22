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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";
import type { AgentConfig, RouteConfig, DmScope } from "./types.js";

const log = logger.child("router:db");

// ============================================================================
// Constants
// ============================================================================

const RAVI_DIR = join(homedir(), "ravi");
const DB_PATH = join(RAVI_DIR, "ravi.db");

// ============================================================================
// Schemas (safe to access at import time - no I/O)
// ============================================================================

export const DmScopeSchema = z.enum([
  "main",
  "per-peer",
  "per-channel-peer",
  "per-account-channel-peer",
]);

export const AgentModeSchema = z.enum(["active", "sentinel"]);

export const AgentInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  debounceMs: z.number().int().min(0).optional(),
  groupDebounceMs: z.number().int().min(0).optional(),
  matrixAccount: z.string().optional(),
  mode: AgentModeSchema.optional(),
});

export const RouteInputSchema = z.object({
  pattern: z.string().min(1),
  accountId: z.string().min(1),
  agent: z.string().min(1),
  dmScope: DmScopeSchema.optional(),
  priority: z.number().int().default(0),
});

// ============================================================================
// Row Types
// ============================================================================

interface AgentRow {
  id: string;
  name: string | null;
  cwd: string;
  model: string | null;
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
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: number;
  pattern: string;
  account_id: string;
  agent_id: string;
  dm_scope: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
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

// ============================================================================
// Lazy Database Initialization
// ============================================================================

let db: Database | null = null;

/**
 * Get database connection with lazy initialization.
 * Creates database and schema on first access.
 */
function getDb(): Database {
  if (db !== null) {
    return db;
  }

  // Create directory on first access
  mkdirSync(RAVI_DIR, { recursive: true });

  db = new Database(DB_PATH);

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
      sdk_session_id TEXT,
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
  if (!agentColumns.some(c => c.name === "matrix_account")) {
    db.exec("ALTER TABLE agents ADD COLUMN matrix_account TEXT REFERENCES matrix_accounts(username)");
    log.info("Added matrix_account column to agents table");
  }

  // Migration: add heartbeat columns to agents if not exists
  if (!agentColumns.some(c => c.name === "heartbeat_enabled")) {
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
  if (!agentColumns.some(c => c.name === "setting_sources")) {
    db.exec("ALTER TABLE agents ADD COLUMN setting_sources TEXT");
    log.info("Added setting_sources column to agents table");
  }

  // Migration: drop legacy permission columns (replaced by REBAC)
  const legacyCols = ["allowed_tools", "bash_mode", "bash_allowlist", "bash_denylist"];
  const toDrop = legacyCols.filter(c => agentColumns.some(ac => ac.name === c));
  if (toDrop.length > 0) {
    for (const col of toDrop) {
      db.exec(`ALTER TABLE agents DROP COLUMN ${col}`);
    }
    log.info("Dropped legacy permission columns from agents table", { columns: toDrop });
  }

  // Migration: add spec_mode column to agents if not exists
  if (!agentColumns.some(c => c.name === "spec_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN spec_mode INTEGER DEFAULT 0");
    log.info("Added spec_mode column to agents table");
  }

  // Migration: add scope isolation columns to agents if not exists
  if (!agentColumns.some(c => c.name === "contact_scope")) {
    db.exec("ALTER TABLE agents ADD COLUMN contact_scope TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN allowed_sessions TEXT");
    log.info("Added scope isolation columns to agents table");
  }

  // Migration: add agent_mode column to agents if not exists
  if (!agentColumns.some(c => c.name === "agent_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_mode TEXT");
    log.info("Added agent_mode column to agents table");
  }

  // Migration: add group_debounce_ms column to agents if not exists
  if (!agentColumns.some(c => c.name === "group_debounce_ms")) {
    db.exec("ALTER TABLE agents ADD COLUMN group_debounce_ms INTEGER");
    log.info("Added group_debounce_ms column to agents table");
  }

  // Migration: add heartbeat columns to sessions if not exists
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some(c => c.name === "last_heartbeat_text")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_text TEXT;
    `);
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_sent_at INTEGER;
    `);
    log.info("Added heartbeat columns to sessions table");
  }

  // Migration: add last_context column to sessions if not exists
  if (!sessionColumns.some(c => c.name === "last_context")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_context TEXT");
    log.info("Added last_context column to sessions table");
  }

  // Migration: add ephemeral session columns
  if (!sessionColumns.some(c => c.name === "ephemeral")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ephemeral INTEGER DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_ephemeral ON sessions(ephemeral, expires_at) WHERE ephemeral = 1");
    log.info("Added ephemeral session columns to sessions table");
  }

  // Migration: add name column to sessions (human-readable unique identifier)
  if (!sessionColumns.some(c => c.name === "name")) {
    db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL");
    log.info("Added name column to sessions table");

    // Migrate existing sessions: generate names from session_key
    const rows = db.prepare("SELECT session_key, agent_id, display_name, chat_type, group_id FROM sessions").all() as Array<{
      session_key: string; agent_id: string; display_name: string | null; chat_type: string | null; group_id: string | null;
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
  } catch { /* column already exists */ }

  db.exec(`
    -- Outbound queues
    CREATE TABLE IF NOT EXISTS outbound_queues (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT NOT NULL,
      status TEXT DEFAULT 'paused' CHECK(status IN ('active','paused','completed')),
      interval_ms INTEGER NOT NULL,
      active_start TEXT,
      active_end TEXT,
      timezone TEXT,
      current_index INTEGER DEFAULT 0,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,
      total_processed INTEGER DEFAULT 0,
      total_sent INTEGER DEFAULT 0,
      total_skipped INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbound_entries (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL REFERENCES outbound_queues(id) ON DELETE CASCADE,
      contact_phone TEXT NOT NULL,
      contact_email TEXT,
      position INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','done','skipped','error','agent')),
      context TEXT DEFAULT '{}',
      rounds_completed INTEGER DEFAULT 0,
      last_processed_at INTEGER,
      last_sent_at INTEGER,
      last_response_at INTEGER,
      last_response_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_queues_status ON outbound_queues(status);
    CREATE INDEX IF NOT EXISTS idx_outbound_queues_next_run ON outbound_queues(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_entries_queue ON outbound_entries(queue_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_entries_phone ON outbound_entries(contact_phone);

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

  // Migrations for outbound_entries
  const entryColumns = db.prepare("PRAGMA table_info(outbound_entries)").all() as Array<{ name: string }>;
  if (!entryColumns.some(c => c.name === "pending_receipt")) {
    db.exec("ALTER TABLE outbound_entries ADD COLUMN pending_receipt TEXT");
    log.info("Added pending_receipt column to outbound_entries table");
  }
  if (!entryColumns.some(c => c.name === "sender_id")) {
    db.exec("ALTER TABLE outbound_entries ADD COLUMN sender_id TEXT");
    log.info("Added sender_id column to outbound_entries table");
  }
  if (!entryColumns.some(c => c.name === "qualification")) {
    db.exec("ALTER TABLE outbound_entries ADD COLUMN qualification TEXT");
    log.info("Added qualification column to outbound_entries table");
  }

  // Migrations for outbound_queues
  const queueColumns = db.prepare("PRAGMA table_info(outbound_queues)").all() as Array<{ name: string }>;
  if (!queueColumns.some(c => c.name === "follow_up")) {
    db.exec("ALTER TABLE outbound_queues ADD COLUMN follow_up TEXT");
    log.info("Added follow_up column to outbound_queues table");
  }
  if (!queueColumns.some(c => c.name === "max_rounds")) {
    db.exec("ALTER TABLE outbound_queues ADD COLUMN max_rounds INTEGER");
    log.info("Added max_rounds column to outbound_queues table");
  }
  if (!queueColumns.some(c => c.name === "stages")) {
    db.exec("ALTER TABLE outbound_queues ADD COLUMN stages TEXT");
    log.info("Added stages column to outbound_queues table");
  }

  // Migration: add 'agent' to outbound_entries status CHECK constraint
  // SQLite requires table recreation to modify CHECK constraints
  const entrySql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='outbound_entries'"
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (entrySql && !entrySql.includes("'agent'")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE outbound_entries_new (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL REFERENCES outbound_queues(id) ON DELETE CASCADE,
          contact_phone TEXT NOT NULL,
          contact_email TEXT,
          position INTEGER NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','done','skipped','error','agent')),
          context TEXT DEFAULT '{}',
          qualification TEXT,
          rounds_completed INTEGER DEFAULT 0,
          last_processed_at INTEGER,
          last_sent_at INTEGER,
          last_response_at INTEGER,
          last_response_text TEXT,
          pending_receipt TEXT,
          sender_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO outbound_entries_new SELECT
          id, queue_id, contact_phone, contact_email, position, status, context, qualification,
          rounds_completed, last_processed_at, last_sent_at, last_response_at, last_response_text,
          pending_receipt, sender_id, created_at, updated_at
        FROM outbound_entries;
        DROP TABLE outbound_entries;
        ALTER TABLE outbound_entries_new RENAME TO outbound_entries;
        CREATE INDEX IF NOT EXISTS idx_outbound_entries_queue ON outbound_entries(queue_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_entries_phone ON outbound_entries(contact_phone);
        COMMIT;
      `);
      log.info("Migrated outbound_entries CHECK constraint to include 'agent' status");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }

  // Migrations for triggers
  const triggerColumns = db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>;
  if (!triggerColumns.some(c => c.name === "reply_session")) {
    db.exec("ALTER TABLE triggers ADD COLUMN reply_session TEXT");
    log.info("Added reply_session column to triggers table");
  }
  if (!triggerColumns.some(c => c.name === "account_id")) {
    db.exec("ALTER TABLE triggers ADD COLUMN account_id TEXT");
    log.info("Added account_id column to triggers table");
  }

  // Migration: add account_id column to cron_jobs
  const cronColumns = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  if (!cronColumns.some(c => c.name === "account_id")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN account_id TEXT");
    log.info("Added account_id column to cron_jobs table");
  }

  // Migration: add heartbeat_account_id column to agents
  if (!agentColumns.some(c => c.name === "heartbeat_account_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN heartbeat_account_id TEXT");
    log.info("Added heartbeat_account_id column to agents table");
  }

  // Migration: add account_id column to routes (recreate table for UNIQUE constraint change)
  const routeColumns = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumns.some(c => c.name === "account_id")) {
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

  log.debug("Database initialized", { path: DB_PATH });
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
}

let stmts: PreparedStatements | null = null;

/**
 * Get prepared statements, creating them on first access.
 */
function getStatements(): PreparedStatements {
  if (stmts !== null) {
    return stmts;
  }

  const database = getDb();

  stmts = {
    // Agents
    insertAgent: database.prepare(`
      INSERT INTO agents (id, name, cwd, model, dm_scope, system_prompt_append, debounce_ms, group_debounce_ms, matrix_account, setting_sources,
        heartbeat_enabled, heartbeat_interval_ms, heartbeat_model, heartbeat_active_start, heartbeat_active_end, heartbeat_account_id,
        spec_mode,
        contact_scope, allowed_sessions,
        agent_mode,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?,
        cwd = ?,
        model = ?,
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
      INSERT INTO routes (pattern, account_id, agent_id, dm_scope, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateRoute: database.prepare(`
      UPDATE routes SET
        agent_id = ?,
        dm_scope = ?,
        priority = ?,
        updated_at = ?
      WHERE pattern = ? AND account_id = ?
    `),
    deleteRoute: database.prepare("DELETE FROM routes WHERE pattern = ? AND account_id = ?"),
    getRoute: database.prepare("SELECT * FROM routes WHERE pattern = ? AND account_id = ?"),
    listRoutes: database.prepare("SELECT * FROM routes ORDER BY priority DESC, id"),
    listRoutesByAccount: database.prepare("SELECT * FROM routes WHERE account_id = ? ORDER BY priority DESC, id"),

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
  };

  return stmts;
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

  return result;
}

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * Create a new agent
 */
export function dbCreateAgent(input: z.infer<typeof AgentInputSchema>): AgentConfig {
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
      now,
      now
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
    updates.name !== undefined ? updates.name ?? null : row.name,
    updates.cwd ?? row.cwd,
    updates.model !== undefined ? updates.model ?? null : row.model,
    updates.dmScope !== undefined ? updates.dmScope ?? null : row.dm_scope,
    updates.systemPromptAppend !== undefined ? updates.systemPromptAppend ?? null : row.system_prompt_append,
    updates.debounceMs !== undefined ? updates.debounceMs ?? null : row.debounce_ms,
    updates.groupDebounceMs !== undefined ? updates.groupDebounceMs ?? null : row.group_debounce_ms,
    updates.matrixAccount !== undefined ? updates.matrixAccount ?? null : row.matrix_account,
    updates.settingSources !== undefined
      ? updates.settingSources ? JSON.stringify(updates.settingSources) : null
      : row.setting_sources,
    // Heartbeat fields
    hb?.enabled !== undefined ? (hb.enabled ? 1 : 0) : row.heartbeat_enabled,
    hb?.intervalMs !== undefined ? hb.intervalMs : row.heartbeat_interval_ms,
    hb?.model !== undefined ? hb.model ?? null : row.heartbeat_model,
    hb?.activeStart !== undefined ? hb.activeStart ?? null : row.heartbeat_active_start,
    hb?.activeEnd !== undefined ? hb.activeEnd ?? null : row.heartbeat_active_end,
    hb?.accountId !== undefined ? hb.accountId ?? null : row.heartbeat_account_id,
    // Spec mode
    updates.specMode !== undefined ? (updates.specMode ? 1 : 0) : row.spec_mode,
    // Scope isolation
    updates.contactScope !== undefined ? updates.contactScope ?? null : row.contact_scope,
    updates.allowedSessions !== undefined
      ? updates.allowedSessions ? JSON.stringify(updates.allowedSessions) : null
      : row.allowed_sessions,
    // Agent mode
    updates.mode !== undefined ? updates.mode ?? null : row.agent_mode,
    now,
    id
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
export function dbCreateRoute(input: z.infer<typeof RouteInputSchema>): RouteConfig {
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
      validated.priority,
      now,
      now
    );

    log.info("Created route", { pattern: normalizedPattern, account: validated.accountId, agent: validated.agent });
    return dbGetRoute(normalizedPattern, validated.accountId)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Route already exists: ${validated.pattern} (account: ${validated.accountId})`);
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
  const rows = accountId
    ? s.listRoutesByAccount.all(accountId) as RouteRow[]
    : s.listRoutes.all() as RouteRow[];
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
    updates.dmScope !== undefined ? updates.dmScope ?? null : row.dm_scope,
    updates.priority ?? row.priority,
    now,
    pattern,
    accountId
  );

  log.info("Updated route", { pattern, accountId });
  return dbGetRoute(pattern, accountId)!;
}

/**
 * Delete a route
 */
export function dbDeleteRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  s.deleteRoute.run(pattern, accountId);
  if (getDbChanges() > 0) {
    log.info("Deleted route", { pattern, accountId });
    return true;
  }
  return false;
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
 * Get the first registered account name (from account.*.instanceId settings).
 * Used by CLI commands when --account is not specified.
 */
export function getFirstAccountName(): string | undefined {
  const settings = dbListSettings();
  for (const key of Object.keys(settings)) {
    const match = key.match(/^account\.(.+)\.instanceId$/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Get the account name mapped to a specific agent.
 * Looks up settings like account.<name>.agent = <agentId>.
 * Falls back to getFirstAccountName() if no mapping found.
 */
export function getAccountForAgent(agentId: string): string | undefined {
  const settings = dbListSettings();
  for (const [key, value] of Object.entries(settings)) {
    const match = key.match(/^account\.(.+)\.agent$/);
    if (match && value === agentId) return match[1];
  }
  return getFirstAccountName();
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
  if (db !== null) {
    db.close();
    db = null;
    stmts = null;
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
  return DB_PATH;
}

/**
 * Get the ravi directory
 */
export function getRaviDir(): string {
  return RAVI_DIR;
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
    now
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
  const referencingAgent = agents.find(a => a.matrixAccount === username);
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
  opts: { transcription?: string; mediaPath?: string; mediaType?: string }
): void {
  const s = getStatements();
  s.upsertMessageMeta.run(
    messageId,
    chatId,
    opts.transcription ?? null,
    opts.mediaPath ?? null,
    opts.mediaType ?? null,
    Date.now()
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

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

export const AgentInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  debounceMs: z.number().int().min(0).optional(),
  matrixAccount: z.string().optional(),
});

export const RouteInputSchema = z.object({
  pattern: z.string().min(1),
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
  allowed_tools: string | null;
  debounce_ms: number | null;
  matrix_account: string | null;
  // Heartbeat columns
  heartbeat_enabled: number;
  heartbeat_interval_ms: number;
  heartbeat_model: string | null;
  heartbeat_active_start: string | null;
  heartbeat_active_end: string | null;
  heartbeat_last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: number;
  pattern: string;
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
      allowed_tools TEXT,
      debounce_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
 * bun:sqlite tracks this on the database instance.
 */
function getDbChanges(): number {
  return (getDb() as unknown as { changes: number }).changes;
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
      INSERT INTO agents (id, name, cwd, model, dm_scope, system_prompt_append, allowed_tools, debounce_ms, matrix_account,
        heartbeat_enabled, heartbeat_interval_ms, heartbeat_model, heartbeat_active_start, heartbeat_active_end,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?,
        cwd = ?,
        model = ?,
        dm_scope = ?,
        system_prompt_append = ?,
        allowed_tools = ?,
        debounce_ms = ?,
        matrix_account = ?,
        heartbeat_enabled = ?,
        heartbeat_interval_ms = ?,
        heartbeat_model = ?,
        heartbeat_active_start = ?,
        heartbeat_active_end = ?,
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
      INSERT INTO routes (pattern, agent_id, dm_scope, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    updateRoute: database.prepare(`
      UPDATE routes SET
        agent_id = ?,
        dm_scope = ?,
        priority = ?,
        updated_at = ?
      WHERE pattern = ?
    `),
    deleteRoute: database.prepare("DELETE FROM routes WHERE pattern = ?"),
    getRoute: database.prepare("SELECT * FROM routes WHERE pattern = ?"),
    listRoutes: database.prepare("SELECT * FROM routes ORDER BY priority DESC, id"),

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
  if (row.allowed_tools !== null) {
    try {
      result.allowedTools = JSON.parse(row.allowed_tools);
    } catch {
      // Ignore invalid JSON
    }
  }
  if (row.debounce_ms !== null) result.debounceMs = row.debounce_ms;
  if (row.matrix_account !== null) result.matrixAccount = row.matrix_account;

  // Heartbeat fields
  result.heartbeat = {
    enabled: row.heartbeat_enabled === 1,
    intervalMs: row.heartbeat_interval_ms ?? 1800000,
    model: row.heartbeat_model ?? undefined,
    activeStart: row.heartbeat_active_start ?? undefined,
    activeEnd: row.heartbeat_active_end ?? undefined,
    lastRunAt: row.heartbeat_last_run_at ?? undefined,
  };

  return result;
}

function rowToRoute(row: RouteRow): RouteConfig & { id: number } {
  const result: RouteConfig & { id: number } = {
    id: row.id,
    pattern: row.pattern,
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
      validated.allowedTools ? JSON.stringify(validated.allowedTools) : null,
      validated.debounceMs ?? null,
      validated.matrixAccount ?? null,
      // Heartbeat fields (defaults)
      0, // heartbeat_enabled
      1800000, // heartbeat_interval_ms (30 min)
      null, // heartbeat_model
      null, // heartbeat_active_start
      null, // heartbeat_active_end
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
    updates.allowedTools !== undefined
      ? updates.allowedTools ? JSON.stringify(updates.allowedTools) : null
      : row.allowed_tools,
    updates.debounceMs !== undefined ? updates.debounceMs ?? null : row.debounce_ms,
    updates.matrixAccount !== undefined ? updates.matrixAccount ?? null : row.matrix_account,
    // Heartbeat fields
    hb?.enabled !== undefined ? (hb.enabled ? 1 : 0) : row.heartbeat_enabled,
    hb?.intervalMs !== undefined ? hb.intervalMs : row.heartbeat_interval_ms,
    hb?.model !== undefined ? hb.model ?? null : row.heartbeat_model,
    hb?.activeStart !== undefined ? hb.activeStart ?? null : row.heartbeat_active_start,
    hb?.activeEnd !== undefined ? hb.activeEnd ?? null : row.heartbeat_active_end,
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
 * Set allowed tools for an agent (null = bypass mode, clears whitelist)
 */
export function dbSetAgentTools(id: string, tools: string[] | null): void {
  dbUpdateAgent(id, { allowedTools: tools as string[] | undefined });
  log.info("Set agent tools", { id, tools: tools?.length ?? "bypass" });
}

/**
 * Add a tool to the agent's whitelist
 */
export function dbAddAgentTool(id: string, tool: string): void {
  const existing = dbGetAgent(id);
  if (!existing) {
    throw new Error(`Agent not found: ${id}`);
  }

  const tools = existing.allowedTools ?? [];
  if (!tools.includes(tool)) {
    tools.push(tool);
    dbUpdateAgent(id, { allowedTools: tools });
    log.info("Added tool to agent", { id, tool });
  }
}

/**
 * Remove a tool from the agent's whitelist
 */
export function dbRemoveAgentTool(id: string, tool: string): void {
  const existing = dbGetAgent(id);
  if (!existing) {
    throw new Error(`Agent not found: ${id}`);
  }

  if (!existing.allowedTools) return;

  const tools = existing.allowedTools.filter(t => t !== tool);
  dbUpdateAgent(id, { allowedTools: tools });
  log.info("Removed tool from agent", { id, tool });
}

/**
 * Set debounce time for an agent (null = disable debounce)
 */
export function dbSetAgentDebounce(id: string, debounceMs: number | null): void {
  dbUpdateAgent(id, { debounceMs: debounceMs as number | undefined });
  log.info("Set agent debounce", { id, debounceMs });
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

  try {
    s.insertRoute.run(
      validated.pattern,
      validated.agent,
      validated.dmScope ?? null,
      validated.priority,
      now,
      now
    );

    log.info("Created route", { pattern: validated.pattern, agent: validated.agent });
    return dbGetRoute(validated.pattern)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Route already exists: ${validated.pattern}`);
    }
    throw err;
  }
}

/**
 * Get route by pattern
 */
export function dbGetRoute(pattern: string): (RouteConfig & { id: number }) | null {
  const s = getStatements();
  const row = s.getRoute.get(pattern) as RouteRow | undefined;
  return row ? rowToRoute(row) : null;
}

/**
 * List all routes
 */
export function dbListRoutes(): (RouteConfig & { id: number })[] {
  const s = getStatements();
  const rows = s.listRoutes.all() as RouteRow[];
  return rows.map(rowToRoute);
}

/**
 * Update an existing route
 */
export function dbUpdateRoute(pattern: string, updates: Partial<RouteConfig>): RouteConfig {
  const s = getStatements();
  const row = s.getRoute.get(pattern) as RouteRow | undefined;

  if (!row) {
    throw new Error(`Route not found: ${pattern}`);
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
    pattern
  );

  log.info("Updated route", { pattern });
  return dbGetRoute(pattern)!;
}

/**
 * Delete a route
 */
export function dbDeleteRoute(pattern: string): boolean {
  const s = getStatements();
  s.deleteRoute.run(pattern);
  if (getDbChanges() > 0) {
    log.info("Deleted route", { pattern });
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

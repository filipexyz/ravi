/**
 * Router Database - SQLite-backed configuration storage
 *
 * Stores agents, routes, and settings in SQLite to prevent
 * direct file editing by bots (which could bypass validation).
 *
 * Uses lazy initialization - database is only created when first accessed.
 */

import Database from "better-sqlite3";
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
const DB_PATH = join(RAVI_DIR, "router.db");

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

// ============================================================================
// Lazy Database Initialization
// ============================================================================

let db: Database.Database | null = null;

/**
 * Get database connection with lazy initialization.
 * Creates database and schema on first access.
 */
function getDb(): Database.Database {
  if (db !== null) {
    return db;
  }

  // Create directory on first access
  mkdirSync(RAVI_DIR, { recursive: true });

  db = new Database(DB_PATH);

  // Enable foreign keys before schema creation
  db.pragma("foreign_keys = ON");

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

    CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
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

// ============================================================================
// Prepared Statement Cache
// ============================================================================

interface PreparedStatements {
  insertAgent: Database.Statement;
  updateAgent: Database.Statement;
  deleteAgent: Database.Statement;
  getAgent: Database.Statement;
  listAgents: Database.Statement;
  insertRoute: Database.Statement;
  updateRoute: Database.Statement;
  deleteRoute: Database.Statement;
  getRoute: Database.Statement;
  listRoutes: Database.Statement;
  upsertSetting: Database.Statement;
  getSetting: Database.Statement;
  deleteSetting: Database.Statement;
  listSettings: Database.Statement;
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
      INSERT INTO agents (id, name, cwd, model, dm_scope, system_prompt_append, allowed_tools, debounce_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at = ?
      WHERE id = ?
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

  const now = Date.now();
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
    now,
    id
  );

  log.info("Updated agent", { id });
  return dbGetAgent(id)!;
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
  const result = s.deleteAgent.run(id);
  if (result.changes > 0) {
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
  const result = s.deleteRoute.run(pattern);
  if (result.changes > 0) {
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
  const result = s.deleteSetting.run(key);
  return result.changes > 0;
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
 * Get the database path
 */
export function getRouterDbPath(): string {
  return DB_PATH;
}

/**
 * Get the ravi directory
 */
export function getRaviDir(): string {
  return RAVI_DIR;
}

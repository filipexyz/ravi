/**
 * Session Store
 *
 * Manages session entries and SDK session mappings.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionEntry } from "./types.js";
import { getRaviDir } from "./config.js";
import { logger } from "../utils/logger.js";

const log = logger.child("router:sessions");

// ============================================================================
// Database Setup
// ============================================================================

const DB_PATH = join(getRaviDir(), "sessions.db");
mkdirSync(getRaviDir(), { recursive: true });

const db = new Database(DB_PATH);

// Initialize schema
db.exec(`
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
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_sdk ON sessions(sdk_session_id);
`);

// ============================================================================
// Prepared Statements
// ============================================================================

const upsertStmt = db.prepare(`
  INSERT INTO sessions (
    session_key, sdk_session_id, agent_id, agent_cwd,
    chat_type, channel, account_id, group_id, subject, display_name,
    last_channel, last_to, last_account_id, last_thread_id,
    model_override, thinking_level,
    queue_mode, queue_debounce_ms, queue_cap,
    input_tokens, output_tokens, total_tokens, context_tokens,
    system_sent, aborted_last_run, compaction_count,
    created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?
  )
  ON CONFLICT(session_key) DO UPDATE SET
    sdk_session_id = COALESCE(excluded.sdk_session_id, sessions.sdk_session_id),
    chat_type = COALESCE(excluded.chat_type, sessions.chat_type),
    channel = COALESCE(excluded.channel, sessions.channel),
    account_id = COALESCE(excluded.account_id, sessions.account_id),
    subject = COALESCE(excluded.subject, sessions.subject),
    display_name = COALESCE(excluded.display_name, sessions.display_name),
    last_channel = COALESCE(excluded.last_channel, sessions.last_channel),
    last_to = COALESCE(excluded.last_to, sessions.last_to),
    last_account_id = COALESCE(excluded.last_account_id, sessions.last_account_id),
    last_thread_id = COALESCE(excluded.last_thread_id, sessions.last_thread_id),
    model_override = COALESCE(excluded.model_override, sessions.model_override),
    thinking_level = COALESCE(excluded.thinking_level, sessions.thinking_level),
    input_tokens = sessions.input_tokens + excluded.input_tokens,
    output_tokens = sessions.output_tokens + excluded.output_tokens,
    total_tokens = sessions.total_tokens + excluded.total_tokens,
    updated_at = excluded.updated_at
`);

const getByKeyStmt = db.prepare(
  "SELECT * FROM sessions WHERE session_key = ?"
);

const getBySdkIdStmt = db.prepare(
  "SELECT * FROM sessions WHERE sdk_session_id = ?"
);

const getByAgentStmt = db.prepare(
  "SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC"
);

const updateSdkIdStmt = db.prepare(
  "UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE session_key = ?"
);

const updateTokensStmt = db.prepare(`
  UPDATE sessions SET
    input_tokens = input_tokens + ?,
    output_tokens = output_tokens + ?,
    total_tokens = total_tokens + ?,
    context_tokens = ?,
    updated_at = ?
  WHERE session_key = ?
`);

const deleteStmt = db.prepare(
  "DELETE FROM sessions WHERE session_key = ?"
);

const listAllStmt = db.prepare(
  "SELECT * FROM sessions ORDER BY updated_at DESC"
);

// ============================================================================
// Row Mapping
// ============================================================================

interface SessionRow {
  session_key: string;
  sdk_session_id: string | null;
  agent_id: string;
  agent_cwd: string;
  chat_type: string | null;
  channel: string | null;
  account_id: string | null;
  group_id: string | null;
  subject: string | null;
  display_name: string | null;
  last_channel: string | null;
  last_to: string | null;
  last_account_id: string | null;
  last_thread_id: string | null;
  model_override: string | null;
  thinking_level: string | null;
  queue_mode: string | null;
  queue_debounce_ms: number | null;
  queue_cap: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_tokens: number;
  system_sent: number;
  aborted_last_run: number;
  compaction_count: number;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: SessionRow): SessionEntry {
  return {
    sessionKey: row.session_key,
    sdkSessionId: row.sdk_session_id ?? undefined,
    agentId: row.agent_id,
    agentCwd: row.agent_cwd,
    chatType: row.chat_type as SessionEntry["chatType"],
    channel: row.channel ?? undefined,
    accountId: row.account_id ?? undefined,
    groupId: row.group_id ?? undefined,
    subject: row.subject ?? undefined,
    displayName: row.display_name ?? undefined,
    lastChannel: row.last_channel ?? undefined,
    lastTo: row.last_to ?? undefined,
    lastAccountId: row.last_account_id ?? undefined,
    lastThreadId: row.last_thread_id ?? undefined,
    modelOverride: row.model_override ?? undefined,
    thinkingLevel: row.thinking_level as SessionEntry["thinkingLevel"],
    queueMode: row.queue_mode as SessionEntry["queueMode"],
    queueDebounceMs: row.queue_debounce_ms ?? undefined,
    queueCap: row.queue_cap ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    contextTokens: row.context_tokens,
    systemSent: row.system_sent === 1,
    abortedLastRun: row.aborted_last_run === 1,
    compactionCount: row.compaction_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// Session Store API
// ============================================================================

/**
 * Get or create a session entry
 */
export function getOrCreateSession(
  sessionKey: string,
  agentId: string,
  agentCwd: string,
  defaults?: Partial<SessionEntry>
): SessionEntry {
  const existing = getByKeyStmt.get(sessionKey) as SessionRow | undefined;

  if (existing) {
    return rowToEntry(existing);
  }

  const now = Date.now();
  upsertStmt.run(
    sessionKey,
    defaults?.sdkSessionId ?? null,
    agentId,
    agentCwd,
    defaults?.chatType ?? null,
    defaults?.channel ?? null,
    defaults?.accountId ?? null,
    defaults?.groupId ?? null,
    defaults?.subject ?? null,
    defaults?.displayName ?? null,
    defaults?.lastChannel ?? null,
    defaults?.lastTo ?? null,
    defaults?.lastAccountId ?? null,
    defaults?.lastThreadId ?? null,
    defaults?.modelOverride ?? null,
    defaults?.thinkingLevel ?? null,
    defaults?.queueMode ?? null,
    defaults?.queueDebounceMs ?? null,
    defaults?.queueCap ?? null,
    0, 0, 0, 0,
    0, 0, 0,
    now, now
  );

  log.debug("Created session", { sessionKey, agentId });

  return getOrCreateSession(sessionKey, agentId, agentCwd);
}

/**
 * Get session by key
 */
export function getSession(sessionKey: string): SessionEntry | null {
  const row = getByKeyStmt.get(sessionKey) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Get session by SDK session ID
 */
export function getSessionBySdkId(sdkSessionId: string): SessionEntry | null {
  const row = getBySdkIdStmt.get(sdkSessionId) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Get all sessions for an agent
 */
export function getSessionsByAgent(agentId: string): SessionEntry[] {
  const rows = getByAgentStmt.all(agentId) as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Update SDK session ID
 */
export function updateSdkSessionId(
  sessionKey: string,
  sdkSessionId: string
): void {
  updateSdkIdStmt.run(sdkSessionId, Date.now(), sessionKey);
  log.debug("Updated SDK session ID", { sessionKey, sdkSessionId });
}

/**
 * Update token usage
 */
export function updateTokens(
  sessionKey: string,
  input: number,
  output: number,
  context?: number
): void {
  updateTokensStmt.run(
    input,
    output,
    input + output,
    context ?? 0,
    Date.now(),
    sessionKey
  );
}

/**
 * Delete a session
 */
export function deleteSession(sessionKey: string): boolean {
  const result = deleteStmt.run(sessionKey);
  return result.changes > 0;
}

/**
 * List all sessions
 */
export function listSessions(): SessionEntry[] {
  const rows = listAllStmt.all() as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Close the database
 */
export function closeSessions(): void {
  db.close();
}

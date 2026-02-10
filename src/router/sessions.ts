/**
 * Session Store
 *
 * Manages session entries and SDK session mappings.
 * Uses shared database from router-db.ts.
 */

import type { Statement } from "bun:sqlite";
import type { SessionEntry } from "./types.js";
import { getDb, getDbChanges } from "./router-db.js";
import { logger } from "../utils/logger.js";

const log = logger.child("router:sessions");

// ============================================================================
// Row Type
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
  last_context: string | null;
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
  // Heartbeat columns
  last_heartbeat_text: string | null;
  last_heartbeat_sent_at: number | null;
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
    lastContext: row.last_context ?? undefined,
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
    // Heartbeat fields
    lastHeartbeatText: row.last_heartbeat_text ?? undefined,
    lastHeartbeatSentAt: row.last_heartbeat_sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// Prepared Statements (lazy init)
// ============================================================================

interface SessionStatements {
  upsert: Statement;
  getByKey: Statement;
  getBySdkId: Statement;
  getByAgent: Statement;
  updateSdkId: Statement;
  updateTokens: Statement;
  delete: Statement;
  listAll: Statement;
  updateAgent: Statement;
  updateSource: Statement;
  updateDisplayName: Statement;
  updateContext: Statement;
  updateModelOverride: Statement;
  updateThinkingLevel: Statement;
}

let stmts: SessionStatements | null = null;

function getStatements(): SessionStatements {
  if (stmts !== null) return stmts;

  const db = getDb();

  stmts = {
    upsert: db.prepare(`
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
    `),
    getByKey: db.prepare("SELECT * FROM sessions WHERE session_key = ?"),
    getBySdkId: db.prepare("SELECT * FROM sessions WHERE sdk_session_id = ?"),
    getByAgent: db.prepare("SELECT * FROM sessions WHERE agent_id = ? OR session_key LIKE 'agent:' || ? || ':%' ORDER BY updated_at DESC"),
    updateSdkId: db.prepare("UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE session_key = ?"),
    updateTokens: db.prepare(`
      UPDATE sessions SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        total_tokens = total_tokens + ?,
        context_tokens = ?,
        updated_at = ?
      WHERE session_key = ?
    `),
    delete: db.prepare("DELETE FROM sessions WHERE session_key = ?"),
    listAll: db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
    updateAgent: db.prepare(
      "UPDATE sessions SET agent_id = ?, agent_cwd = ?, sdk_session_id = NULL, updated_at = ? WHERE session_key = ?"
    ),
    updateSource: db.prepare(
      "UPDATE sessions SET last_channel = ?, last_account_id = ?, last_to = ?, updated_at = ? WHERE session_key = ?"
    ),
    updateDisplayName: db.prepare(
      "UPDATE sessions SET display_name = ?, updated_at = ? WHERE session_key = ?"
    ),
    updateContext: db.prepare(
      "UPDATE sessions SET last_context = ?, updated_at = ? WHERE session_key = ?"
    ),
    updateModelOverride: db.prepare(
      "UPDATE sessions SET model_override = ?, updated_at = ? WHERE session_key = ?"
    ),
    updateThinkingLevel: db.prepare(
      "UPDATE sessions SET thinking_level = ?, updated_at = ? WHERE session_key = ?"
    ),
  };

  return stmts;
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
  const s = getStatements();
  const existing = s.getByKey.get(sessionKey) as SessionRow | undefined;

  if (existing) {
    // Update agent_id/cwd if changed (e.g., routing config updated)
    if (existing.agent_id !== agentId || existing.agent_cwd !== agentCwd) {
      log.info("Updating session agent", {
        sessionKey,
        oldAgent: existing.agent_id,
        newAgent: agentId,
      });
      s.updateAgent.run(agentId, agentCwd, Date.now(), sessionKey);
      existing.agent_id = agentId;
      existing.agent_cwd = agentCwd;
      existing.sdk_session_id = null;
    }
    return rowToEntry(existing);
  }

  const now = Date.now();
  s.upsert.run(
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
  const s = getStatements();
  const row = s.getByKey.get(sessionKey) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Get session by SDK session ID
 */
export function getSessionBySdkId(sdkSessionId: string): SessionEntry | null {
  const s = getStatements();
  const row = s.getBySdkId.get(sdkSessionId) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Get all sessions for an agent
 */
export function getSessionsByAgent(agentId: string): SessionEntry[] {
  const s = getStatements();
  const rows = s.getByAgent.all(agentId, agentId) as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Update SDK session ID
 */
export function updateSdkSessionId(
  sessionKey: string,
  sdkSessionId: string
): void {
  const s = getStatements();
  s.updateSdkId.run(sdkSessionId, Date.now(), sessionKey);
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
  const s = getStatements();
  s.updateTokens.run(
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
  const s = getStatements();
  s.delete.run(sessionKey);
  return getDbChanges() > 0;
}

/**
 * Find the most recent session that routes to a given chatId (last_to).
 * Useful for resolving a phone/LID to a session key.
 */
export function findSessionByChatId(chatId: string): SessionEntry | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM sessions WHERE last_to = ? COLLATE NOCASE AND last_channel IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
    )
    .get(chatId) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * List all sessions
 */
export function listSessions(): SessionEntry[] {
  const s = getStatements();
  const rows = s.listAll.all() as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Update session source (last channel/account/chat for response routing)
 */
export function updateSessionSource(
  sessionKey: string,
  source: { channel?: string; accountId?: string; chatId?: string }
): void {
  if (!source.channel && !source.accountId && !source.chatId) return;
  const s = getStatements();
  s.updateSource.run(
    source.channel ?? null,
    source.accountId ?? null,
    source.chatId ?? null,
    Date.now(),
    sessionKey
  );
}

export function updateSessionDisplayName(
  sessionKey: string,
  displayName: string
): void {
  const s = getStatements();
  s.updateDisplayName.run(displayName, Date.now(), sessionKey);
}

/**
 * Update session's channel context (stable group/channel metadata as JSON)
 */
export function updateSessionContext(
  sessionKey: string,
  contextJson: string
): void {
  const s = getStatements();
  s.updateContext.run(contextJson, Date.now(), sessionKey);
}

/**
 * Update session heartbeat info
 */
/**
 * Update session model override (null to clear)
 */
export function updateSessionModelOverride(
  sessionKey: string,
  model: string | null
): void {
  const s = getStatements();
  s.updateModelOverride.run(model, Date.now(), sessionKey);
}

/**
 * Update session thinking level (null to clear)
 */
export function updateSessionThinkingLevel(
  sessionKey: string,
  level: string | null
): void {
  const s = getStatements();
  s.updateThinkingLevel.run(level, Date.now(), sessionKey);
}

export function updateSessionHeartbeat(
  sessionKey: string,
  text: string
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE sessions SET
      last_heartbeat_text = ?,
      last_heartbeat_sent_at = ?,
      updated_at = ?
    WHERE session_key = ?
  `);
  const now = Date.now();
  stmt.run(text, now, now, sessionKey);
}

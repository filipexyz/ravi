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
  name: string | null;
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
  // Ephemeral columns
  ephemeral: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: SessionRow): SessionEntry {
  return {
    sessionKey: row.session_key,
    name: row.name ?? undefined,
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
    // Ephemeral fields
    ephemeral: row.ephemeral === 1,
    expiresAt: row.expires_at ?? undefined,
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
  getByName: Statement;
  getBySdkId: Statement;
  getByAgent: Statement;
  findByAttributes: Statement;
  updateSdkId: Statement;
  updateTokens: Statement;
  updateName: Statement;
  nameExists: Statement;
  delete: Statement;
  deleteByName: Statement;
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
        session_key, name, sdk_session_id, agent_id, agent_cwd,
        chat_type, channel, account_id, group_id, subject, display_name,
        last_channel, last_to, last_account_id, last_thread_id,
        model_override, thinking_level,
        queue_mode, queue_debounce_ms, queue_cap,
        input_tokens, output_tokens, total_tokens, context_tokens,
        system_sent, aborted_last_run, compaction_count,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(session_key) DO UPDATE SET
        name = COALESCE(excluded.name, sessions.name),
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
    getByName: db.prepare("SELECT * FROM sessions WHERE name = ?"),
    getBySdkId: db.prepare("SELECT * FROM sessions WHERE sdk_session_id = ?"),
    getByAgent: db.prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC"),
    findByAttributes: db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND channel = ? AND group_id = ? ORDER BY updated_at DESC LIMIT 1"),
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
    updateName: db.prepare("UPDATE sessions SET name = ?, updated_at = ? WHERE session_key = ?"),
    nameExists: db.prepare("SELECT 1 FROM sessions WHERE name = ?"),
    delete: db.prepare("DELETE FROM sessions WHERE session_key = ?"),
    deleteByName: db.prepare("DELETE FROM sessions WHERE name = ?"),
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
    defaults?.name ?? null,
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
  const rows = s.getByAgent.all(agentId) as SessionRow[];
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
 * Reset a session — clears conversation state but keeps the session entry
 * (name, agent, routing, display name, etc. are preserved).
 */
export function resetSession(sessionKey: string): boolean {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET
      sdk_session_id = NULL,
      system_sent = 0,
      aborted_last_run = 0,
      compaction_count = 0,
      input_tokens = 0,
      output_tokens = 0,
      total_tokens = 0,
      context_tokens = 0,
      updated_at = ?
    WHERE session_key = ?
  `).run(Date.now(), sessionKey);
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

// ============================================================================
// Name-based lookups
// ============================================================================

/**
 * Get session by name
 */
export function getSessionByName(name: string): SessionEntry | null {
  const s = getStatements();
  const row = s.getByName.get(name) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Update session name.
 * Names must not contain dots (used as topic separator in notif).
 */
export function updateSessionName(
  sessionKey: string,
  name: string
): void {
  if (name.includes(".")) {
    throw new Error(`Session name must not contain dots: "${name}"`);
  }
  const s = getStatements();
  s.updateName.run(name, Date.now(), sessionKey);
}

/**
 * Check if a session name is already taken (cached prepared statement).
 */
export function isNameTaken(name: string): boolean {
  const s = getStatements();
  return !!s.nameExists.get(name);
}

/**
 * Delete session by name
 */
export function deleteSessionByName(name: string): boolean {
  const s = getStatements();
  s.deleteByName.run(name);
  return getDbChanges() > 0;
}

// ============================================================================
// Ephemeral Sessions
// ============================================================================

/**
 * Make a session ephemeral with a TTL.
 * Sets ephemeral=1 and expires_at = now + ttlMs.
 */
export function setSessionEphemeral(sessionKey: string, ttlMs: number): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE sessions SET ephemeral = 1, expires_at = ?, updated_at = ? WHERE session_key = ?"
  ).run(now + ttlMs, now, sessionKey);
}

/**
 * Extend an ephemeral session's TTL by the given amount.
 */
export function extendSession(nameOrKey: string, ttlMs: number): boolean {
  const session = resolveSession(nameOrKey);
  if (!session) return false;

  const db = getDb();
  const now = Date.now();
  const newExpiry = Math.max(session.expiresAt ?? now, now) + ttlMs;
  db.prepare(
    "UPDATE sessions SET expires_at = ?, updated_at = ? WHERE session_key = ?"
  ).run(newExpiry, now, session.sessionKey);
  return true;
}

/**
 * Make an ephemeral session permanent (removes TTL).
 */
export function makeSessionPermanent(nameOrKey: string): boolean {
  const session = resolveSession(nameOrKey);
  if (!session) return false;

  const db = getDb();
  db.prepare(
    "UPDATE sessions SET ephemeral = 0, expires_at = NULL, updated_at = ? WHERE session_key = ?"
  ).run(Date.now(), session.sessionKey);
  return true;
}

/**
 * Get ephemeral sessions expiring within the next `withinMs` milliseconds.
 */
export function getExpiringSessions(withinMs: number): SessionEntry[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?"
  ).all(now + withinMs, now) as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Get ephemeral sessions that have already expired.
 */
export function getExpiredSessions(): SessionEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?"
  ).all(Date.now()) as SessionRow[];
  return rows.map(rowToEntry);
}

/**
 * Find session by attributes (agent + channel + group/peer).
 * Used by resolveRoute to find existing sessions.
 */
export function findSessionByAttributes(
  agentId: string,
  channel: string,
  groupId: string,
): SessionEntry | null {
  const s = getStatements();
  const row = s.findByAttributes.get(agentId, channel, groupId) as SessionRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Find the main session for an agent.
 * Tries name = slugified agentId first, falls back to chat_type = 'main'.
 */
export function getMainSession(agentId: string): SessionEntry | null {
  const db = getDb();
  // Main session name is the slugified agent ID
  const slug = agentId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const row = db.prepare("SELECT * FROM sessions WHERE name = ? AND agent_id = ?").get(slug, agentId) as SessionRow | undefined;
  if (row) return rowToEntry(row);
  // Fallback: if main session was renamed, find by session_key suffix
  const fallback = db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND session_key LIKE '%:main' ORDER BY updated_at DESC LIMIT 1").get(agentId) as SessionRow | undefined;
  return fallback ? rowToEntry(fallback) : null;
}

/**
 * Resolve a session: try by name first, then by session_key.
 * This allows CLI commands to accept either format.
 */
export function resolveSession(nameOrKey: string): SessionEntry | null {
  // Try name first
  const byName = getSessionByName(nameOrKey);
  if (byName) return byName;
  // Fall back to session_key
  return getSession(nameOrKey);
}

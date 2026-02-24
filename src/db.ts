import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".ravi");
const DB_PATH = join(DATA_DIR, "chat.db");

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for concurrent read/write access (CLI + daemon)
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sdk_session_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
`);

// Migration: add sdk_session_id column if missing (existing DBs)
try {
  db.exec("ALTER TABLE messages ADD COLUMN sdk_session_id TEXT");
} catch {
  // column already exists
}

// Index on sdk_session_id — AFTER migration guarantees column exists
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_sdk_session ON messages(sdk_session_id)");

// Prepared statements — AFTER migrations so column is guaranteed to exist
const insertStmt = db.prepare(
  "INSERT INTO messages (session_id, role, content, sdk_session_id) VALUES (?, ?, ?, ?)"
);

const getHistoryStmt = db.prepare(
  "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC"
);

const getRecentStmt = db.prepare(
  "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
);

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  sdk_session_id: string | null;
  created_at: string;
}

export function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  sdkSessionId?: string | null,
): void {
  insertStmt.run(sessionId, role, content, sdkSessionId ?? null);
}

/**
 * Backfill NULL sdk_session_id on messages after the SDK assigns one.
 */
export function backfillSdkSessionId(sessionId: string, sdkSessionId: string): void {
  db.prepare(
    "UPDATE messages SET sdk_session_id = ? WHERE session_id = ? AND sdk_session_id IS NULL"
  ).run(sdkSessionId, sessionId);
}

export function getHistory(sessionId: string): Message[] {
  return getHistoryStmt.all(sessionId) as Message[];
}

export function getRecentHistory(sessionId: string, limit = 20): Message[] {
  const messages = getRecentStmt.all(sessionId, limit) as Message[];
  return messages.reverse();
}

/**
 * Get recent messages for the current SDK session only.
 * Finds the sdk_session_id of the last message and filters by it.
 */
export function getRecentSessionHistory(sessionId: string, limit = 50): Message[] {
  const last = db.prepare(
    "SELECT sdk_session_id FROM messages WHERE session_id = ? AND sdk_session_id IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get(sessionId) as { sdk_session_id: string } | null;

  if (!last) return [];

  const messages = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND sdk_session_id = ? ORDER BY id DESC LIMIT ?"
  ).all(sessionId, last.sdk_session_id, limit) as Message[];

  return messages.reverse();
}

export function close(): void {
  db.close();
}

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getRaviStateDir } from "./utils/paths.js";

let db: Database | null = null;
let dbPath: string | null = null;

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "chat.db");
}

export function getChatDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDbPath(env);
}

function getDb(): Database {
  const nextDbPath = resolveDbPath();
  if (db !== null && dbPath === nextDbPath) {
    return db;
  }
  if (db !== null && dbPath !== nextDbPath) {
    close();
  }

  mkdirSync(getRaviStateDir(), { recursive: true });

  db = new Database(nextDbPath);
  dbPath = nextDbPath;

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

  return db;
}

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  provider_session_id?: string | null;
  sdk_session_id: string | null;
  created_at: string;
}

export function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  providerSessionId?: string | null,
): void {
  getDb()
    .prepare("INSERT INTO messages (session_id, role, content, sdk_session_id) VALUES (?, ?, ?, ?)")
    .run(sessionId, role, content, providerSessionId ?? null);
}

/**
 * Backfill NULL sdk_session_id on messages after the SDK assigns one.
 */
export function backfillSdkSessionId(sessionId: string, sdkSessionId: string): void {
  getDb()
    .prepare("UPDATE messages SET sdk_session_id = ? WHERE session_id = ? AND sdk_session_id IS NULL")
    .run(sdkSessionId, sessionId);
}

export function backfillProviderSessionId(sessionId: string, providerSessionId: string): void {
  backfillSdkSessionId(sessionId, providerSessionId);
}

export function getHistory(sessionId: string): Message[] {
  return getDb().prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as Message[];
}

export function getRecentHistory(sessionId: string, limit = 20): Message[] {
  const messages = getDb()
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
    .all(sessionId, limit) as Message[];
  return messages.reverse();
}

/**
 * Get recent messages for the current provider session only.
 * Backed by the legacy sdk_session_id column for compatibility.
 */
export function getRecentSessionHistory(sessionId: string, limit = 50): Message[] {
  const last = getDb()
    .prepare(
      "SELECT sdk_session_id FROM messages WHERE session_id = ? AND sdk_session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId) as { sdk_session_id: string } | null;

  if (!last) return [];

  const messages = getDb()
    .prepare("SELECT * FROM messages WHERE session_id = ? AND sdk_session_id = ? ORDER BY id DESC LIMIT ?")
    .all(sessionId, last.sdk_session_id, limit) as Message[];

  return messages.reverse();
}

export function getRecentProviderSessionHistory(sessionId: string, limit = 50): Message[] {
  return getRecentSessionHistory(sessionId, limit);
}

export function close(): void {
  if (db !== null) {
    db.close();
    db = null;
    dbPath = null;
  }
}

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".ravi");
const DB_PATH = join(DATA_DIR, "chat.db");

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
`);

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

const insertStmt = db.prepare(
  "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
);

const getHistoryStmt = db.prepare(
  "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC"
);

const getRecentStmt = db.prepare(
  "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
);

export function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string
): void {
  insertStmt.run(sessionId, role, content);
}

export function getHistory(sessionId: string): Message[] {
  return getHistoryStmt.all(sessionId) as Message[];
}

export function getRecentHistory(sessionId: string, limit = 20): Message[] {
  const messages = getRecentStmt.all(sessionId, limit) as Message[];
  return messages.reverse();
}

export function close(): void {
  db.close();
}

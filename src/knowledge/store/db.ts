// Local Knowledge database `~/.ravi/knowledge.db` (spec knowledge, contract
// §10.1). Its own file, not ravi.db: FTS5 tables cannot go through
// `reconcileColumns`, chat history lives in chat.db, and the file can be
// dropped and rebuilt from chat.db and the meeting folders.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { reconcileColumns } from "../../db/reconcile-columns.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("knowledge:db");

export const KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- F1: local history index
CREATE TABLE IF NOT EXISTS knowledge_local_docs (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('chat','transcript')),
  session_name TEXT, agent_id TEXT, channel TEXT, account_id TEXT, chat_id TEXT, role TEXT,
  speaker TEXT, contact_id TEXT, meeting_key TEXT, start_sec REAL,
  recorded_at INTEGER NOT NULL,
  text_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_local_docs_chat_idx ON knowledge_local_docs(chat_id, recorded_at);
CREATE INDEX IF NOT EXISTS knowledge_local_docs_kind_idx ON knowledge_local_docs(kind, recorded_at);
CREATE INDEX IF NOT EXISTS knowledge_local_docs_contact_idx ON knowledge_local_docs(contact_id);
CREATE INDEX IF NOT EXISTS knowledge_local_docs_session_idx ON knowledge_local_docs(session_name, id);
CREATE TABLE IF NOT EXISTS knowledge_local_text (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL, speaker TEXT);
CREATE TABLE IF NOT EXISTS knowledge_forgotten_subjects (
  subject_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('contact','chat')), forgotten_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_local_runs (
  id TEXT PRIMARY KEY, turn_key TEXT, session_name TEXT, console_run_id TEXT, query_hash TEXT NOT NULL,
  refs_json TEXT NOT NULL, lowest_tier TEXT, issues_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS knowledge_local_runs_turn_idx ON knowledge_local_runs(turn_key, created_at);
CREATE TABLE IF NOT EXISTS knowledge_turn_reads (
  turn_key TEXT PRIMARY KEY, lowest_tier TEXT NOT NULL CHECK (lowest_tier IN ('approved','published','said','inferred')),
  first_read_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_write_approvals (
  id TEXT PRIMARY KEY, turn_key TEXT NOT NULL, fingerprint TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  requested_at INTEGER NOT NULL, decided_at INTEGER, UNIQUE(turn_key, fingerprint));
-- F2
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('contact','chat')),
  subject_id TEXT NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','open_loop','commitment')),
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','archived','redacted')),
  trust TEXT NOT NULL CHECK (trust IN ('approved','published','said','inferred')),
  speaker TEXT CHECK (speaker IN ('operator','contact','agent')),
  recorded_at INTEGER NOT NULL, expires_at INTEGER, superseded_by TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('operator','curator','marker')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_active_key ON knowledge_items(scope, subject_id, ifnull(agent_id,''), kind, key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS knowledge_items_subject_idx ON knowledge_items(scope, subject_id, status);
CREATE TABLE IF NOT EXISTS knowledge_item_sources (
  item_id TEXT NOT NULL, source_kind TEXT NOT NULL CHECK (source_kind IN ('message','operator','meeting')),
  source_ref TEXT NOT NULL, text_hash TEXT NOT NULL, span TEXT, PRIMARY KEY (item_id, source_ref));
CREATE TABLE IF NOT EXISTS knowledge_marked_pages (
  route_id TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, title TEXT,
  document_id TEXT NOT NULL, version INTEGER NOT NULL, approved_at TEXT, instances_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_marked_sections (
  id INTEGER PRIMARY KEY, route_id TEXT NOT NULL, stable_key TEXT NOT NULL, heading TEXT, anchor TEXT, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_briefs (
  id TEXT PRIMARY KEY, session_name TEXT NOT NULL, agent_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL, item_ids_json TEXT NOT NULL, section_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  channel TEXT NOT NULL, account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL, contact_id TEXT NOT NULL, session_name TEXT NOT NULL, question TEXT NOT NULL, question_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','uploaded','answered','notified','dropped')),
  proposal_id TEXT, created_at INTEGER NOT NULL, uploaded_at INTEGER, notified_at INTEGER);
CREATE INDEX IF NOT EXISTS knowledge_gaps_status_idx ON knowledge_gaps(status, created_at);
CREATE INDEX IF NOT EXISTS knowledge_gaps_contact_day_idx ON knowledge_gaps(contact_id, created_at);
CREATE TABLE IF NOT EXISTS knowledge_guarded_sessions (
  session_name TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  normalized_chat_id TEXT NOT NULL,
  contact_id TEXT NOT NULL, guarded_until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS knowledge_guarded_chat_idx ON knowledge_guarded_sessions(channel, chat_id);
CREATE INDEX IF NOT EXISTS knowledge_guarded_instance_chat_idx ON knowledge_guarded_sessions(instance_id, normalized_chat_id);
CREATE TABLE IF NOT EXISTS knowledge_curator_state (
  agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, last_message_id INTEGER NOT NULL, last_run_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, subject_id));
`;

// Created apart from KNOWLEDGE_SCHEMA_SQL (reconcileColumns only reads
// CREATE TABLE), each on its own: a SQLite without FTS5 still opens the file.
// rowid = knowledge_local_docs.id and knowledge_marked_sections.id.
const KNOWLEDGE_FTS_SQL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_local_fts USING fts5(body, speaker, tokenize="unicode61 remove_diacritics 2")`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_marked_fts USING fts5(body, tokenize="unicode61 remove_diacritics 2")`,
];

type KnowledgeDbState = {
  db: Database | null;
  dbPath: string | null;
  fts5: boolean;
  /** Tests force the LIKE fallback with this. */
  forceFts5Off: boolean;
};

type KnowledgeDbGlobal = typeof globalThis & {
  __raviKnowledgeDbState?: KnowledgeDbState;
};

const knowledgeDbGlobal = globalThis as KnowledgeDbGlobal;
const knowledgeDbState =
  knowledgeDbGlobal.__raviKnowledgeDbState ??
  (knowledgeDbGlobal.__raviKnowledgeDbState = {
    db: null,
    dbPath: null,
    fts5: false,
    forceFts5Off: false,
  });

export function getKnowledgeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "knowledge.db");
}

/** The read-write handle, opened (and the schema applied) on first use. */
export function getKnowledgeDb(): Database {
  const nextDbPath = getKnowledgeDbPath();
  if (knowledgeDbState.db !== null && knowledgeDbState.dbPath === nextDbPath) {
    return knowledgeDbState.db;
  }
  if (knowledgeDbState.db !== null) closeKnowledgeDb();

  mkdirSync(getRaviStateDir(), { recursive: true });
  const db = new Database(nextDbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(KNOWLEDGE_SCHEMA_SQL);
  reconcileColumns(db, KNOWLEDGE_SCHEMA_SQL, { label: "knowledge" });
  const fts5 = !knowledgeDbState.forceFts5Off && probeFts5(db);
  if (fts5) {
    for (const statement of KNOWLEDGE_FTS_SQL) db.exec(statement);
    // Rows written while FTS5 was off live only in the plain tables.
    if (readKnowledgeMeta("fts5", db) === "off") rebuildFtsTables(db);
  }
  writeMeta(db, "fts5", fts5 ? "on" : "off");

  knowledgeDbState.db = db;
  knowledgeDbState.dbPath = nextDbPath;
  knowledgeDbState.fts5 = fts5;
  return db;
}

/** Same as `getKnowledgeDb`; the name other modules use for "open it if needed". */
export const ensureKnowledgeDb = getKnowledgeDb;

/** Whether searches use the FTS5 tables (else LIKE over the plain tables). */
export function knowledgeFts5Available(): boolean {
  getKnowledgeDb();
  return knowledgeDbState.fts5;
}

/**
 * A read-only handle for processes that must not write the schema
 * (`ravi-channels`). Null when the file does not exist yet or cannot be
 * opened: callers read that as "no guarded chats". The caller closes it.
 */
export function openKnowledgeDbReadonly(env: NodeJS.ProcessEnv = process.env): Database | null {
  const path = getKnowledgeDbPath(env);
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch (error) {
    log.warn("knowledge.db read-only open failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function closeKnowledgeDb(): void {
  if (knowledgeDbState.db !== null) {
    knowledgeDbState.db.close();
  }
  knowledgeDbState.db = null;
  knowledgeDbState.dbPath = null;
  knowledgeDbState.fts5 = false;
}

/** Test hook: with `true`, the next open behaves as a SQLite without FTS5. */
export function setKnowledgeFts5ForcedOff(off: boolean): void {
  knowledgeDbState.forceFts5Off = off;
  closeKnowledgeDb();
}

export function readKnowledgeMeta(key: string, db: Database = getKnowledgeDb()): string | null {
  const row = db.prepare("SELECT value FROM knowledge_meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function writeKnowledgeMeta(key: string, value: string, db: Database = getKnowledgeDb()): void {
  writeMeta(db, key, value);
}

function writeMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO knowledge_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, Date.now());
}

function rebuildFtsTables(db: Database): void {
  db.exec("DELETE FROM knowledge_local_fts");
  db.exec("INSERT INTO knowledge_local_fts (rowid, body, speaker) SELECT id, body, speaker FROM knowledge_local_text");
  db.exec("DELETE FROM knowledge_marked_fts");
  db.exec("INSERT INTO knowledge_marked_fts (rowid, body) SELECT id, text FROM knowledge_marked_sections");
}

function probeFts5(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.knowledge_fts5_probe USING fts5(x)");
    db.exec("DROP TABLE IF EXISTS temp.knowledge_fts5_probe");
    return true;
  } catch (error) {
    log.warn("SQLite has no FTS5; Knowledge searches use LIKE", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

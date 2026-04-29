import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getRaviStateDir } from "../utils/paths.js";
import { toDevinApiId, type DevinSession, type DevinSessionAttachment, type DevinSessionMessage } from "./client.js";

let db: Database | null = null;

export function getDevinDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "devin.db");
}

function getDevinDb(): Database {
  if (db) return db;
  const path = getDevinDbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function closeDevinDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export interface DevinSessionRecord {
  id: string;
  devinId: string;
  orgId: string;
  url: string;
  status: string;
  statusDetail?: string;
  title?: string;
  tags: string[];
  originType?: string;
  originId?: string;
  originSessionName?: string;
  agentId?: string;
  taskId?: string;
  projectId?: string;
  proxRunId?: string;
  playbookId?: string;
  snapshotId?: string;
  structuredOutput?: Record<string, unknown>;
  pullRequests: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  remoteCreatedAt?: number;
  remoteUpdatedAt?: number;
  lastSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredDevinMessage {
  devinId: string;
  eventId: string;
  createdAt: number;
  source: string;
  message: string;
  syncedAt: number;
}

export interface StoredDevinAttachment {
  devinId: string;
  attachmentId: string;
  name: string;
  source: string;
  url: string;
  contentType?: string;
  syncedAt: number;
}

interface DevinSessionRow {
  id: string;
  devin_id: string;
  org_id: string;
  url: string;
  status: string;
  status_detail: string | null;
  title: string | null;
  tags_json: string;
  origin_type: string | null;
  origin_id: string | null;
  origin_session_name: string | null;
  agent_id: string | null;
  task_id: string | null;
  project_id: string | null;
  prox_run_id: string | null;
  playbook_id: string | null;
  snapshot_id: string | null;
  structured_output_json: string | null;
  pull_requests_json: string | null;
  metadata_json: string | null;
  remote_created_at: number | null;
  remote_updated_at: number | null;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DevinMessageRow {
  devin_id: string;
  event_id: string;
  created_at: number;
  source: string;
  message: string;
  synced_at: number;
}

interface DevinAttachmentRow {
  devin_id: string;
  attachment_id: string;
  name: string;
  source: string;
  url: string;
  content_type: string | null;
  synced_at: number;
}

export interface UpsertDevinSessionOptions {
  originType?: string;
  originId?: string;
  originSessionName?: string;
  agentId?: string;
  taskId?: string;
  projectId?: string;
  proxRunId?: string;
  snapshotId?: string;
  metadata?: Record<string, unknown>;
  lastSyncedAt?: number;
}

export interface ListDevinSessionRecordsOptions {
  status?: string;
  tag?: string;
  limit?: number;
}

function ensureDevinSchema(): void {
  getDevinDb().exec(`
    CREATE TABLE IF NOT EXISTS devin_sessions (
      id TEXT PRIMARY KEY,
      devin_id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      title TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      origin_type TEXT,
      origin_id TEXT,
      origin_session_name TEXT,
      agent_id TEXT,
      task_id TEXT,
      project_id TEXT,
      prox_run_id TEXT,
      playbook_id TEXT,
      snapshot_id TEXT,
      structured_output_json TEXT,
      pull_requests_json TEXT,
      metadata_json TEXT,
      remote_created_at INTEGER,
      remote_updated_at INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devin_sessions_status_time ON devin_sessions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_devin_sessions_origin ON devin_sessions(origin_type, origin_id);
    CREATE INDEX IF NOT EXISTS idx_devin_sessions_task ON devin_sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_devin_sessions_project ON devin_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_devin_sessions_prox_run ON devin_sessions(prox_run_id);

    CREATE TABLE IF NOT EXISTS devin_session_messages (
      devin_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (devin_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_devin_messages_time ON devin_session_messages(devin_id, created_at);

    CREATE TABLE IF NOT EXISTS devin_session_attachments (
      devin_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      content_type TEXT,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (devin_id, attachment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_devin_attachments_session ON devin_session_attachments(devin_id, synced_at);
  `);
  getDevinDb().exec(`
    UPDATE OR IGNORE devin_sessions
      SET devin_id = 'devin-' || devin_id
      WHERE devin_id NOT LIKE 'devin-%';
    UPDATE OR IGNORE devin_session_messages
      SET devin_id = 'devin-' || devin_id
      WHERE devin_id NOT LIKE 'devin-%';
    UPDATE OR IGNORE devin_session_attachments
      SET devin_id = 'devin-' || devin_id
      WHERE devin_id NOT LIKE 'devin-%';
  `);
}

function jsonString(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function localDevinSessionId(): string {
  return `devs_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function rowToSession(row: DevinSessionRow): DevinSessionRecord {
  return {
    id: row.id,
    devinId: row.devin_id,
    orgId: row.org_id,
    url: row.url,
    status: row.status,
    ...(row.status_detail ? { statusDetail: row.status_detail } : {}),
    ...(row.title ? { title: row.title } : {}),
    tags: parseJson<string[]>(row.tags_json, []),
    ...(row.origin_type ? { originType: row.origin_type } : {}),
    ...(row.origin_id ? { originId: row.origin_id } : {}),
    ...(row.origin_session_name ? { originSessionName: row.origin_session_name } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.prox_run_id ? { proxRunId: row.prox_run_id } : {}),
    ...(row.playbook_id ? { playbookId: row.playbook_id } : {}),
    ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
    ...(row.structured_output_json
      ? { structuredOutput: parseJson<Record<string, unknown>>(row.structured_output_json, {}) }
      : {}),
    pullRequests: parseJson<Array<Record<string, unknown>>>(row.pull_requests_json, []),
    ...(row.metadata_json ? { metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}) } : {}),
    ...(row.remote_created_at !== null ? { remoteCreatedAt: row.remote_created_at } : {}),
    ...(row.remote_updated_at !== null ? { remoteUpdatedAt: row.remote_updated_at } : {}),
    ...(row.last_synced_at !== null ? { lastSyncedAt: row.last_synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: DevinMessageRow): StoredDevinMessage {
  return {
    devinId: row.devin_id,
    eventId: row.event_id,
    createdAt: row.created_at,
    source: row.source,
    message: row.message,
    syncedAt: row.synced_at,
  };
}

function rowToAttachment(row: DevinAttachmentRow): StoredDevinAttachment {
  return {
    devinId: row.devin_id,
    attachmentId: row.attachment_id,
    name: row.name,
    source: row.source,
    url: row.url,
    ...(row.content_type ? { contentType: row.content_type } : {}),
    syncedAt: row.synced_at,
  };
}

export function upsertDevinSession(session: DevinSession, options: UpsertDevinSessionOptions = {}): DevinSessionRecord {
  ensureDevinSchema();
  const now = Date.now();
  const devinId = toDevinApiId(session.session_id);
  const existing = getDevinSession(devinId);
  const id = existing?.id ?? localDevinSessionId();
  const originType = options.originType ?? existing?.originType;
  const originId = options.originId ?? existing?.originId;
  const originSessionName = options.originSessionName ?? existing?.originSessionName;
  const agentId = options.agentId ?? existing?.agentId;
  const taskId = options.taskId ?? existing?.taskId;
  const projectId = options.projectId ?? existing?.projectId;
  const proxRunId = options.proxRunId ?? existing?.proxRunId;
  const metadata =
    options.metadata || existing?.metadata
      ? {
          ...(existing?.metadata ?? {}),
          ...(options.metadata ?? {}),
        }
      : undefined;

  getDevinDb()
    .prepare(
      `INSERT INTO devin_sessions (
        id, devin_id, org_id, url, status, status_detail, title, tags_json,
        origin_type, origin_id, origin_session_name, agent_id, task_id, project_id, prox_run_id,
        playbook_id, snapshot_id, structured_output_json, pull_requests_json, metadata_json,
        remote_created_at, remote_updated_at, last_synced_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(devin_id) DO UPDATE SET
        org_id = excluded.org_id,
        url = excluded.url,
        status = excluded.status,
        status_detail = excluded.status_detail,
        title = excluded.title,
        tags_json = excluded.tags_json,
        origin_type = COALESCE(excluded.origin_type, devin_sessions.origin_type),
        origin_id = COALESCE(excluded.origin_id, devin_sessions.origin_id),
        origin_session_name = COALESCE(excluded.origin_session_name, devin_sessions.origin_session_name),
        agent_id = COALESCE(excluded.agent_id, devin_sessions.agent_id),
        task_id = COALESCE(excluded.task_id, devin_sessions.task_id),
        project_id = COALESCE(excluded.project_id, devin_sessions.project_id),
        prox_run_id = COALESCE(excluded.prox_run_id, devin_sessions.prox_run_id),
        playbook_id = excluded.playbook_id,
        snapshot_id = COALESCE(excluded.snapshot_id, devin_sessions.snapshot_id),
        structured_output_json = excluded.structured_output_json,
        pull_requests_json = excluded.pull_requests_json,
        metadata_json = COALESCE(excluded.metadata_json, devin_sessions.metadata_json),
        remote_created_at = excluded.remote_created_at,
        remote_updated_at = excluded.remote_updated_at,
        last_synced_at = COALESCE(excluded.last_synced_at, devin_sessions.last_synced_at),
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      devinId,
      session.org_id,
      session.url,
      session.status,
      session.status_detail ?? null,
      session.title ?? null,
      JSON.stringify(session.tags ?? []),
      originType ?? null,
      originId ?? null,
      originSessionName ?? null,
      agentId ?? null,
      taskId ?? null,
      projectId ?? null,
      proxRunId ?? null,
      session.playbook_id ?? null,
      options.snapshotId ?? existing?.snapshotId ?? null,
      jsonString(session.structured_output ?? undefined),
      jsonString(session.pull_requests ?? []),
      jsonString(metadata),
      session.created_at ?? null,
      session.updated_at ?? null,
      options.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
      existing?.createdAt ?? now,
      now,
    );

  const stored = getDevinSession(devinId);
  if (!stored) throw new Error(`Failed to store Devin session: ${devinId}`);
  return stored;
}

export function getDevinSession(idOrDevinId: string): DevinSessionRecord | null {
  ensureDevinSchema();
  const row = getDevinDb()
    .prepare("SELECT * FROM devin_sessions WHERE id = ? OR devin_id = ?")
    .get(idOrDevinId, idOrDevinId) as DevinSessionRow | null;
  return row ? rowToSession(row) : null;
}

export function listDevinSessions(options: ListDevinSessionRecordsOptions = {}): DevinSessionRecord[] {
  ensureDevinSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.status?.trim()) {
    where.push("status = ?");
    params.push(options.status.trim());
  }
  if (options.tag?.trim()) {
    where.push("tags_json LIKE ?");
    params.push(`%"${options.tag.trim()}"%`);
  }
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const rows = getDevinDb()
    .prepare(
      `SELECT * FROM devin_sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as DevinSessionRow[];
  return rows.map(rowToSession);
}

export function upsertDevinMessages(devinId: string, messages: DevinSessionMessage[]): StoredDevinMessage[] {
  ensureDevinSchema();
  const database = getDevinDb();
  const syncedAt = Date.now();
  const stmt = database.prepare(
    `INSERT INTO devin_session_messages (devin_id, event_id, created_at, source, message, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(devin_id, event_id) DO UPDATE SET
       created_at = excluded.created_at,
       source = excluded.source,
       message = excluded.message,
       synced_at = excluded.synced_at`,
  );
  const insertAll = database.transaction(() => {
    for (const message of messages) {
      stmt.run(devinId, message.event_id, message.created_at, message.source, message.message, syncedAt);
    }
  });
  insertAll();
  return listDevinMessages(devinId);
}

export function listDevinMessages(devinId: string): StoredDevinMessage[] {
  ensureDevinSchema();
  const rows = getDevinDb()
    .prepare("SELECT * FROM devin_session_messages WHERE devin_id = ? ORDER BY created_at ASC")
    .all(devinId) as DevinMessageRow[];
  return rows.map(rowToMessage);
}

export function upsertDevinAttachments(
  devinId: string,
  attachments: DevinSessionAttachment[],
): StoredDevinAttachment[] {
  ensureDevinSchema();
  const database = getDevinDb();
  const syncedAt = Date.now();
  const stmt = database.prepare(
    `INSERT INTO devin_session_attachments (devin_id, attachment_id, name, source, url, content_type, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(devin_id, attachment_id) DO UPDATE SET
       name = excluded.name,
       source = excluded.source,
       url = excluded.url,
       content_type = excluded.content_type,
       synced_at = excluded.synced_at`,
  );
  const insertAll = database.transaction(() => {
    for (const attachment of attachments) {
      stmt.run(
        devinId,
        attachment.attachment_id,
        attachment.name,
        attachment.source,
        attachment.url,
        attachment.content_type ?? null,
        syncedAt,
      );
    }
  });
  insertAll();
  return listDevinAttachments(devinId);
}

export function listDevinAttachments(devinId: string): StoredDevinAttachment[] {
  ensureDevinSchema();
  const rows = getDevinDb()
    .prepare("SELECT * FROM devin_session_attachments WHERE devin_id = ? ORDER BY synced_at DESC, name ASC")
    .all(devinId) as DevinAttachmentRow[];
  return rows.map(rowToAttachment);
}

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { getDb } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";

const ARTIFACT_ID_PATTERN = /^art_[a-z0-9]+_[a-z0-9]+$/;
const KIND_PATTERN = /^[a-z][a-z0-9._:-]{0,79}$/;

export const ArtifactInputSchema = z
  .object({
    id: z.string().regex(ARTIFACT_ID_PATTERN).optional(),
    kind: z.string().regex(KIND_PATTERN, "Artifact kind must start with a letter and use safe identifier chars"),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(2000).optional(),
    status: z.string().trim().min(1).max(80).default("active"),
    uri: z.string().trim().min(1).optional(),
    filePath: z.string().trim().min(1).optional(),
    blobPath: z.string().trim().min(1).optional(),
    mimeType: z.string().trim().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    prompt: z.string().optional(),
    command: z.string().trim().min(1).optional(),
    sessionKey: z.string().trim().min(1).optional(),
    sessionName: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
    messageId: z.string().trim().min(1).optional(),
    channel: z.string().trim().min(1).optional(),
    accountId: z.string().trim().min(1).optional(),
    chatId: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    metrics: z.record(z.string(), z.unknown()).optional(),
    lineage: z.record(z.string(), z.unknown()).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    createdAt: z.number().int().positive().optional(),
    updatedAt: z.number().int().positive().optional(),
  })
  .strict();

export const ArtifactUpdateSchema = ArtifactInputSchema.partial().omit({
  id: true,
  kind: true,
  createdAt: true,
  updatedAt: true,
});

export interface ArtifactRecord extends z.infer<typeof ArtifactInputSchema> {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface ArtifactLink {
  artifactId: string;
  targetType: string;
  targetId: string;
  relation: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ArtifactEvent {
  id: number;
  artifactId: string;
  eventType: string;
  actor?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  status: string;
  uri: string | null;
  file_path: string | null;
  blob_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  command: string | null;
  session_key: string | null;
  session_name: string | null;
  agent_id: string | null;
  task_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  channel: string | null;
  account_id: string | null;
  chat_id: string | null;
  thread_id: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  metadata_json: string | null;
  metrics_json: string | null;
  lineage_json: string | null;
  input_json: string | null;
  output_json: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ArtifactEventRow {
  id: number;
  artifact_id: string;
  event_type: string;
  actor: string | null;
  payload_json: string | null;
  created_at: number;
}

interface ArtifactLinkRow {
  artifact_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  metadata_json: string | null;
  created_at: number;
}

export interface ListArtifactsOptions {
  kind?: string;
  session?: string;
  taskId?: string;
  tag?: string;
  limit?: number;
  includeDeleted?: boolean;
}

function ensureArtifactSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      uri TEXT,
      file_path TEXT,
      blob_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      provider TEXT,
      model TEXT,
      prompt TEXT,
      command TEXT,
      session_key TEXT,
      session_name TEXT,
      agent_id TEXT,
      task_id TEXT,
      run_id TEXT,
      turn_id TEXT,
      message_id TEXT,
      channel TEXT,
      account_id TEXT,
      chat_id TEXT,
      thread_id TEXT,
      duration_ms INTEGER,
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      metadata_json TEXT,
      metrics_json TEXT,
      lineage_json TEXT,
      input_json TEXT,
      output_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_kind_time ON artifacts(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_session_time ON artifacts(session_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_session_name_time ON artifacts(session_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_task_time ON artifacts(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256);
    CREATE INDEX IF NOT EXISTS idx_artifacts_status_time ON artifacts(status, created_at);

    CREATE TABLE IF NOT EXISTS artifact_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_events_artifact ON artifact_events(artifact_id, created_at);

    CREATE TABLE IF NOT EXISTS artifact_links (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'related',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, target_type, target_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_links_target ON artifact_links(target_type, target_id);
  `);
}

function jsonString(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return undefined;
  return JSON.parse(value) as unknown;
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function normalizeTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort();
}

function artifactId(): string {
  return `art_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function inferMimeType(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".txt" || ext === ".md") return "text/plain";
  return undefined;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function blobPathFor(hash: string, sourcePath: string): string {
  const ext = extname(sourcePath);
  return join(getRaviStateDir(), "artifacts", "blobs", hash.slice(0, 2), `${hash}${ext}`);
}

function ingestFile(path: string): {
  filePath: string;
  blobPath: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
} {
  const filePath = resolve(path);
  if (!existsSync(filePath)) {
    throw new Error(`Artifact file not found: ${filePath}`);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Artifact path is not a file: ${filePath}`);
  }

  const sha256 = hashFile(filePath);
  const blobPath = blobPathFor(sha256, filePath);
  mkdirSync(dirname(blobPath), { recursive: true });
  if (!existsSync(blobPath)) {
    copyFileSync(filePath, blobPath);
  }

  return {
    filePath,
    blobPath,
    mimeType: inferMimeType(filePath),
    sizeBytes: stat.size,
    sha256,
  };
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.title ? { title: row.title } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    status: row.status,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.file_path ? { filePath: row.file_path } : {}),
    ...(row.blob_path ? { blobPath: row.blob_path } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes !== null ? { sizeBytes: row.size_bytes } : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.session_name ? { sessionName: row.session_name } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    ...(row.metadata_json ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    ...(row.metrics_json ? { metrics: parseJsonObject(row.metrics_json) } : {}),
    ...(row.lineage_json ? { lineage: parseJsonObject(row.lineage_json) } : {}),
    ...(row.input_json ? { input: parseJsonValue(row.input_json) } : {}),
    ...(row.output_json ? { output: parseJsonValue(row.output_json) } : {}),
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
  };
}

function rowToEvent(row: ArtifactEventRow): ArtifactEvent {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    eventType: row.event_type,
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.payload_json ? { payload: parseJsonObject(row.payload_json) } : {}),
    createdAt: row.created_at,
  };
}

function rowToLink(row: ArtifactLinkRow): ArtifactLink {
  return {
    artifactId: row.artifact_id,
    targetType: row.target_type,
    targetId: row.target_id,
    relation: row.relation,
    ...(row.metadata_json ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    createdAt: row.created_at,
  };
}

function insertArtifactEvent(
  artifactIdValue: string,
  eventType: string,
  payload?: Record<string, unknown>,
  actor?: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO artifact_events (artifact_id, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(artifactIdValue, eventType, actor ?? null, jsonString(payload), now);
}

export function createArtifact(input: z.input<typeof ArtifactInputSchema>): ArtifactRecord {
  ensureArtifactSchema();
  const parsed = ArtifactInputSchema.parse(input);
  const now = parsed.createdAt ?? Date.now();
  const file = parsed.filePath ? ingestFile(parsed.filePath) : null;
  const id = parsed.id ?? artifactId();
  const tags = normalizeTags(parsed.tags);

  getDb()
    .prepare(
      `INSERT INTO artifacts (
        id, kind, title, summary, status, uri, file_path, blob_path, mime_type, size_bytes, sha256,
        provider, model, prompt, command, session_key, session_name, agent_id, task_id, run_id, turn_id,
        message_id, channel, account_id, chat_id, thread_id, duration_ms, cost_usd, input_tokens,
        output_tokens, total_tokens, metadata_json, metrics_json, lineage_json, input_json, output_json,
        tags_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )`,
    )
    .run(
      id,
      parsed.kind,
      parsed.title ?? null,
      parsed.summary ?? null,
      parsed.status,
      parsed.uri ?? null,
      file?.filePath ?? parsed.filePath ?? null,
      file?.blobPath ?? parsed.blobPath ?? null,
      parsed.mimeType ?? file?.mimeType ?? null,
      parsed.sizeBytes ?? file?.sizeBytes ?? null,
      parsed.sha256 ?? file?.sha256 ?? null,
      parsed.provider ?? null,
      parsed.model ?? null,
      parsed.prompt ?? null,
      parsed.command ?? null,
      parsed.sessionKey ?? null,
      parsed.sessionName ?? null,
      parsed.agentId ?? null,
      parsed.taskId ?? null,
      parsed.runId ?? null,
      parsed.turnId ?? null,
      parsed.messageId ?? null,
      parsed.channel ?? null,
      parsed.accountId ?? null,
      parsed.chatId ?? null,
      parsed.threadId ?? null,
      parsed.durationMs ?? null,
      parsed.costUsd ?? null,
      parsed.inputTokens ?? null,
      parsed.outputTokens ?? null,
      parsed.totalTokens ?? null,
      jsonString(parsed.metadata),
      jsonString(parsed.metrics),
      jsonString(parsed.lineage),
      jsonString(parsed.input),
      jsonString(parsed.output),
      JSON.stringify(tags),
      now,
      now,
    );

  insertArtifactEvent(id, "artifact.created", { kind: parsed.kind, file: file ? basename(file.filePath) : null });
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact insert failed: ${id}`);
  return artifact;
}

export function getArtifact(id: string): ArtifactRecord | null {
  ensureArtifactSchema();
  const row = getDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | null;
  return row ? rowToArtifact(row) : null;
}

export function listArtifacts(options: ListArtifactsOptions = {}): ArtifactRecord[] {
  ensureArtifactSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!options.includeDeleted) where.push("deleted_at IS NULL");
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.session) {
    where.push("(session_key = ? OR session_name = ?)");
    params.push(options.session, options.session);
  }
  if (options.taskId) {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.tag) {
    where.push("tags_json LIKE ?");
    params.push(`%"${options.tag}"%`);
  }
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...params, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function updateArtifact(
  id: string,
  updates: z.input<typeof ArtifactUpdateSchema>,
  options: { actor?: string; mergeMetadata?: boolean; mergeMetrics?: boolean; mergeLineage?: boolean } = {},
): ArtifactRecord {
  ensureArtifactSchema();
  const current = getArtifact(id);
  if (!current) throw new Error(`Artifact not found: ${id}`);
  const providedKeys = new Set(Object.keys(updates));
  const parsed = ArtifactUpdateSchema.parse(updates);
  const file = parsed.filePath ? ingestFile(parsed.filePath) : null;
  const now = Date.now();
  const metadata =
    options.mergeMetadata && parsed.metadata ? { ...(current.metadata ?? {}), ...parsed.metadata } : parsed.metadata;
  const metrics =
    options.mergeMetrics && parsed.metrics ? { ...(current.metrics ?? {}), ...parsed.metrics } : parsed.metrics;
  const lineage =
    options.mergeLineage && parsed.lineage ? { ...(current.lineage ?? {}), ...parsed.lineage } : parsed.lineage;

  getDb()
    .prepare(
      `UPDATE artifacts SET
        title = COALESCE(?, title),
        summary = COALESCE(?, summary),
        status = COALESCE(?, status),
        uri = COALESCE(?, uri),
        file_path = COALESCE(?, file_path),
        blob_path = COALESCE(?, blob_path),
        mime_type = COALESCE(?, mime_type),
        size_bytes = COALESCE(?, size_bytes),
        sha256 = COALESCE(?, sha256),
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        prompt = COALESCE(?, prompt),
        command = COALESCE(?, command),
        session_key = COALESCE(?, session_key),
        session_name = COALESCE(?, session_name),
        agent_id = COALESCE(?, agent_id),
        task_id = COALESCE(?, task_id),
        run_id = COALESCE(?, run_id),
        turn_id = COALESCE(?, turn_id),
        message_id = COALESCE(?, message_id),
        channel = COALESCE(?, channel),
        account_id = COALESCE(?, account_id),
        chat_id = COALESCE(?, chat_id),
        thread_id = COALESCE(?, thread_id),
        duration_ms = COALESCE(?, duration_ms),
        cost_usd = COALESCE(?, cost_usd),
        input_tokens = COALESCE(?, input_tokens),
        output_tokens = COALESCE(?, output_tokens),
        total_tokens = COALESCE(?, total_tokens),
        metadata_json = COALESCE(?, metadata_json),
        metrics_json = COALESCE(?, metrics_json),
        lineage_json = COALESCE(?, lineage_json),
        input_json = COALESCE(?, input_json),
        output_json = COALESCE(?, output_json),
        tags_json = COALESCE(?, tags_json),
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      parsed.title ?? null,
      parsed.summary ?? null,
      providedKeys.has("status") ? (parsed.status ?? null) : null,
      parsed.uri ?? null,
      file?.filePath ?? parsed.filePath ?? null,
      file?.blobPath ?? parsed.blobPath ?? null,
      parsed.mimeType ?? file?.mimeType ?? null,
      parsed.sizeBytes ?? file?.sizeBytes ?? null,
      parsed.sha256 ?? file?.sha256 ?? null,
      parsed.provider ?? null,
      parsed.model ?? null,
      parsed.prompt ?? null,
      parsed.command ?? null,
      parsed.sessionKey ?? null,
      parsed.sessionName ?? null,
      parsed.agentId ?? null,
      parsed.taskId ?? null,
      parsed.runId ?? null,
      parsed.turnId ?? null,
      parsed.messageId ?? null,
      parsed.channel ?? null,
      parsed.accountId ?? null,
      parsed.chatId ?? null,
      parsed.threadId ?? null,
      parsed.durationMs ?? null,
      parsed.costUsd ?? null,
      parsed.inputTokens ?? null,
      parsed.outputTokens ?? null,
      parsed.totalTokens ?? null,
      metadata === undefined ? null : jsonString(metadata),
      metrics === undefined ? null : jsonString(metrics),
      lineage === undefined ? null : jsonString(lineage),
      parsed.input === undefined ? null : jsonString(parsed.input),
      parsed.output === undefined ? null : jsonString(parsed.output),
      providedKeys.has("tags") ? JSON.stringify(normalizeTags(parsed.tags)) : null,
      now,
      id,
    );

  insertArtifactEvent(id, "artifact.updated", { updates: [...providedKeys].sort() }, options.actor);
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact update failed: ${id}`);
  return artifact;
}

export function attachArtifact(
  artifactIdValue: string,
  targetType: string,
  targetId: string,
  relation = "related",
  metadata?: Record<string, unknown>,
): ArtifactLink {
  ensureArtifactSchema();
  if (!getArtifact(artifactIdValue)) throw new Error(`Artifact not found: ${artifactIdValue}`);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO artifact_links (artifact_id, target_type, target_id, relation, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id, target_type, target_id, relation)
       DO UPDATE SET metadata_json = excluded.metadata_json`,
    )
    .run(artifactIdValue, targetType, targetId, relation, jsonString(metadata), now);
  insertArtifactEvent(artifactIdValue, "artifact.attached", { targetType, targetId, relation });
  return {
    artifactId: artifactIdValue,
    targetType,
    targetId,
    relation,
    ...(metadata ? { metadata } : {}),
    createdAt: now,
  };
}

export function archiveArtifact(id: string, actor?: string): ArtifactRecord {
  ensureArtifactSchema();
  const now = Date.now();
  const result = getDb()
    .prepare("UPDATE artifacts SET status = 'archived', deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
  if (result.changes === 0) throw new Error(`Artifact not found: ${id}`);
  insertArtifactEvent(id, "artifact.archived", undefined, actor);
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact archive failed: ${id}`);
  return artifact;
}

export function getArtifactDetails(id: string): {
  artifact: ArtifactRecord;
  links: ArtifactLink[];
  events: ArtifactEvent[];
} | null {
  ensureArtifactSchema();
  const artifact = getArtifact(id);
  if (!artifact) return null;
  const links = (
    getDb()
      .prepare("SELECT * FROM artifact_links WHERE artifact_id = ? ORDER BY created_at DESC")
      .all(id) as ArtifactLinkRow[]
  ).map(rowToLink);
  const events = (
    getDb()
      .prepare("SELECT * FROM artifact_events WHERE artifact_id = ? ORDER BY created_at DESC")
      .all(id) as ArtifactEventRow[]
  ).map(rowToEvent);
  return { artifact, links, events };
}

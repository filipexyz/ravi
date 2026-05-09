import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { getDb } from "../router/router-db.js";
import { canonicalAssetIdsForTag, canonicalTagSlugsForAsset, replaceMirroredTagSlugsForAsset } from "../tags/index.js";
import { buildSqlWhereClause, countRows, normalizeLimitOffsetPage, type ListPage } from "../utils/pagination.js";
import { getRaviStateDir } from "../utils/paths.js";

const ARTIFACT_ID_PATTERN = /^art_[a-z0-9]+_[a-z0-9]+$/;
const KIND_PATTERN = /^[a-z][a-z0-9._:-]{0,79}$/;
const ARTIFACT_VERSION_ID_PATTERN = /^artv_[a-z0-9]+_[a-z0-9]+$/;
const ARTIFACT_VERSION_ASSET_ID_PATTERN = /^artva_[a-z0-9]+_[a-z0-9]+$/;
const VERSIONABLE_UPDATE_KEYS = new Set(["blobPath", "filePath", "mimeType", "output", "sha256", "sizeBytes", "uri"]);

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

const ArtifactVersionAssetInputSchema = z
  .object({
    id: z.string().regex(ARTIFACT_VERSION_ASSET_ID_PATTERN).optional(),
    path: z.string().trim().min(1).max(512).optional(),
    role: z.string().trim().min(1).max(80).default("primary"),
    visibility: z.enum(["inherit", "private", "public", "unlisted"]).default("inherit"),
    uri: z.string().trim().min(1).optional(),
    filePath: z.string().trim().min(1).optional(),
    blobPath: z.string().trim().min(1).optional(),
    mimeType: z.string().trim().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ArtifactVersionInputSchema = z
  .object({
    id: z.string().regex(ARTIFACT_VERSION_ID_PATTERN).optional(),
    status: z.string().trim().min(1).max(80).default("active"),
    label: z.string().trim().min(1).max(200).optional(),
    source: z.string().trim().min(1).max(120).default("artifacts.store"),
    message: z.string().trim().min(1).max(500).optional(),
    manifest: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    assets: z.array(ArtifactVersionAssetInputSchema).optional(),
    createdBy: z.string().trim().min(1).optional(),
    createdAt: z.number().int().positive().optional(),
  })
  .strict();

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
  status?: string;
  message?: string;
  source?: string;
  actor?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface AppendArtifactEventInput {
  eventType: string;
  status?: string;
  message?: string;
  payload?: Record<string, unknown>;
  source?: string;
  actor?: string;
}

export interface ArtifactVersionAsset {
  id: string;
  versionId: string;
  artifactId: string;
  path: string;
  role: string;
  visibility: "inherit" | "private" | "public" | "unlisted";
  uri?: string;
  filePath?: string;
  blobPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionNumber: number;
  status: string;
  label?: string;
  source: string;
  manifest: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  createdAt: number;
  assets: ArtifactVersionAsset[];
}

export type CreateArtifactVersionInput = z.input<typeof ArtifactVersionInputSchema>;

export interface RestoreArtifactVersionResult {
  artifact: ArtifactRecord;
  restoredFrom: ArtifactVersion;
  restoreVersion: ArtifactVersion;
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
  status: string | null;
  message: string | null;
  source: string | null;
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

interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version_number: number;
  status: string;
  label: string | null;
  source: string;
  manifest_json: string;
  metadata_json: string | null;
  created_by: string | null;
  created_at: number;
}

interface ArtifactVersionAssetRow {
  id: string;
  version_id: string;
  artifact_id: string;
  path: string;
  role: string;
  visibility: "inherit" | "private" | "public" | "unlisted";
  uri: string | null;
  file_path: string | null;
  blob_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  metadata_json: string | null;
  created_at: number;
}

export interface ListArtifactsOptions {
  kind?: string;
  session?: string;
  taskId?: string;
  agentId?: string;
  lifecycle?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export type ArtifactListPage = ListPage<ArtifactRecord>;

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
      status TEXT,
      message TEXT,
      source TEXT,
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

    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      label TEXT,
      source TEXT NOT NULL DEFAULT 'artifacts.store',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(artifact_id, version_number)
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_created ON artifact_versions(created_at);

    CREATE TABLE IF NOT EXISTS artifact_version_assets (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'primary',
      visibility TEXT NOT NULL DEFAULT 'inherit',
      uri TEXT,
      file_path TEXT,
      blob_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(version_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_version_assets_artifact ON artifact_version_assets(artifact_id, path);
    CREATE INDEX IF NOT EXISTS idx_artifact_version_assets_sha256 ON artifact_version_assets(sha256);
  `);

  ensureColumn("artifact_events", "status", "TEXT");
  ensureColumn("artifact_events", "message", "TEXT");
  ensureColumn("artifact_events", "source", "TEXT");
}

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

function syncArtifactTagsToCanonical(artifactIdValue: string, tags: string[]): void {
  replaceMirroredTagSlugsForAsset({
    assetType: "artifact",
    assetId: artifactIdValue,
    tags,
    source: "artifacts.tags_json",
    createdBy: "artifacts.store",
    metadata: { mirrored: true },
    definitionMetadata: {
      source: "artifacts.tags_json",
      mirrored: true,
    },
  });
}

function artifactId(): string {
  return `art_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function artifactVersionId(): string {
  return `artv_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function artifactVersionAssetId(): string {
  return `artva_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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

function normalizeVersionAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").trim();
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid artifact version asset path: ${path}`);
  }
  return normalized;
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
  const tags = [...new Set([...parseTags(row.tags_json), ...canonicalTagSlugsForAsset("artifact", row.id)])].sort();
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
    tags,
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
    ...(row.status ? { status: row.status } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.source ? { source: row.source } : {}),
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

function rowToVersionAsset(row: ArtifactVersionAssetRow): ArtifactVersionAsset {
  return {
    id: row.id,
    versionId: row.version_id,
    artifactId: row.artifact_id,
    path: row.path,
    role: row.role,
    visibility: row.visibility,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.file_path ? { filePath: row.file_path } : {}),
    ...(row.blob_path ? { blobPath: row.blob_path } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes !== null ? { sizeBytes: row.size_bytes } : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.metadata_json ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    createdAt: row.created_at,
  };
}

function listVersionAssets(versionId: string): ArtifactVersionAsset[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM artifact_version_assets WHERE version_id = ? ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, path ASC",
      )
      .all(versionId) as ArtifactVersionAssetRow[]
  ).map(rowToVersionAsset);
}

function rowToVersion(row: ArtifactVersionRow): ArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    versionNumber: row.version_number,
    status: row.status,
    ...(row.label ? { label: row.label } : {}),
    source: row.source,
    manifest: parseJsonObject(row.manifest_json) ?? {},
    ...(row.metadata_json ? { metadata: parseJsonObject(row.metadata_json) } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: row.created_at,
    assets: listVersionAssets(row.id),
  };
}

function buildDefaultVersionAssets(artifact: ArtifactRecord): Array<z.input<typeof ArtifactVersionAssetInputSchema>> {
  if (!artifact.filePath && !artifact.blobPath && !artifact.uri) return [];
  const sourcePath = artifact.filePath ?? artifact.blobPath;
  return [
    {
      path: sourcePath ? basename(sourcePath) : "remote",
      role: "primary",
      visibility: "inherit",
      ...(artifact.uri ? { uri: artifact.uri } : {}),
      ...(artifact.filePath ? { filePath: artifact.filePath } : {}),
      ...(artifact.blobPath ? { blobPath: artifact.blobPath } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    },
  ];
}

function artifactHasVersionableContent(artifact: ArtifactRecord): boolean {
  return Boolean(artifact.filePath || artifact.blobPath || artifact.uri || artifact.output !== undefined);
}

function updateCreatesVersion(providedKeys: Set<string>): boolean {
  return [...providedKeys].some((key) => VERSIONABLE_UPDATE_KEYS.has(key));
}

function buildVersionManifest(
  artifact: ArtifactRecord,
  versionNumber: number,
  assets: ArtifactVersionAsset[],
  manifest?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(manifest ?? {}),
    artifact: {
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title ?? null,
      status: artifact.status,
      uri: artifact.uri ?? null,
    },
    version: {
      number: versionNumber,
    },
    assets: assets.map((asset) => ({
      path: asset.path,
      role: asset.role,
      visibility: asset.visibility,
      uri: asset.uri ?? null,
      mimeType: asset.mimeType ?? null,
      sizeBytes: asset.sizeBytes ?? null,
      sha256: asset.sha256 ?? null,
    })),
    ...(artifact.output !== undefined ? { output: artifact.output } : {}),
  };
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function manifestArtifactUri(version: ArtifactVersion): string | null {
  const artifact = version.manifest.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
  const uri = (artifact as Record<string, unknown>).uri;
  return typeof uri === "string" && uri.trim() ? uri : null;
}

function insertArtifactEvent(
  artifactIdValue: string,
  eventType: string,
  payload?: Record<string, unknown>,
  actor?: string,
  options: { status?: string; message?: string; source?: string } = {},
): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO artifact_events (artifact_id, event_type, status, message, source, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      artifactIdValue,
      eventType,
      options.status ?? null,
      options.message ?? null,
      options.source ?? null,
      actor ?? null,
      jsonString(payload),
      now,
    );
}

export function createArtifactVersion(
  artifactIdValue: string,
  input: CreateArtifactVersionInput = {},
): ArtifactVersion {
  ensureArtifactSchema();
  const artifact = getArtifact(artifactIdValue);
  if (!artifact) throw new Error(`Artifact not found: ${artifactIdValue}`);

  const parsed = ArtifactVersionInputSchema.parse(input);
  const db = getDb();
  const next = db
    .prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM artifact_versions WHERE artifact_id = ?",
    )
    .get(artifactIdValue) as { version_number: number };
  const versionNumber = next.version_number;
  const now = parsed.createdAt ?? Date.now();
  const versionId = parsed.id ?? artifactVersionId();
  const assetInputs = parsed.assets ?? buildDefaultVersionAssets(artifact);
  const assets = assetInputs.map((asset) => {
    const parsedAsset = ArtifactVersionAssetInputSchema.parse(asset);
    const sourcePath = parsedAsset.filePath ?? parsedAsset.blobPath;
    const fallbackPath = sourcePath ? basename(sourcePath) : parsedAsset.uri ? "remote" : "artifact";
    return {
      id: parsedAsset.id ?? artifactVersionAssetId(),
      versionId,
      artifactId: artifactIdValue,
      path: normalizeVersionAssetPath(parsedAsset.path ?? fallbackPath),
      role: parsedAsset.role,
      visibility: parsedAsset.visibility,
      ...(parsedAsset.uri ? { uri: parsedAsset.uri } : {}),
      ...(parsedAsset.filePath ? { filePath: parsedAsset.filePath } : {}),
      ...(parsedAsset.blobPath ? { blobPath: parsedAsset.blobPath } : {}),
      ...(parsedAsset.mimeType ? { mimeType: parsedAsset.mimeType } : {}),
      ...(parsedAsset.sizeBytes !== undefined ? { sizeBytes: parsedAsset.sizeBytes } : {}),
      ...(parsedAsset.sha256 ? { sha256: parsedAsset.sha256 } : {}),
      ...(parsedAsset.metadata ? { metadata: parsedAsset.metadata } : {}),
      createdAt: now,
    } satisfies ArtifactVersionAsset;
  });
  const assetPaths = new Set<string>();
  for (const asset of assets) {
    if (assetPaths.has(asset.path)) {
      throw new Error(`Duplicate artifact version asset path: ${asset.path}`);
    }
    assetPaths.add(asset.path);
  }
  const manifest = buildVersionManifest(artifact, versionNumber, assets, parsed.manifest);

  db.prepare(
    `INSERT INTO artifact_versions (
      id, artifact_id, version_number, status, label, source, manifest_json, metadata_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    versionId,
    artifactIdValue,
    versionNumber,
    parsed.status,
    parsed.label ?? null,
    parsed.source,
    jsonString(manifest) ?? "{}",
    jsonString(parsed.metadata),
    parsed.createdBy ?? null,
    now,
  );

  const insertAsset = db.prepare(
    `INSERT INTO artifact_version_assets (
      id, version_id, artifact_id, path, role, visibility, uri, file_path, blob_path, mime_type,
      size_bytes, sha256, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const asset of assets) {
    insertAsset.run(
      asset.id,
      asset.versionId,
      asset.artifactId,
      asset.path,
      asset.role,
      asset.visibility,
      asset.uri ?? null,
      asset.filePath ?? null,
      asset.blobPath ?? null,
      asset.mimeType ?? null,
      asset.sizeBytes ?? null,
      asset.sha256 ?? null,
      jsonString(asset.metadata),
      asset.createdAt,
    );
  }

  insertArtifactEvent(
    artifactIdValue,
    "version_created",
    {
      versionId,
      versionNumber,
      assets: assets.map((asset) => ({ path: asset.path, role: asset.role, sha256: asset.sha256 ?? null })),
    },
    parsed.createdBy,
    {
      status: artifact.status,
      message: parsed.message ?? `Artifact version ${versionNumber} created`,
      source: parsed.source,
    },
  );

  const version = getArtifactVersion(artifactIdValue, versionNumber);
  if (!version) throw new Error(`Artifact version insert failed: ${versionId}`);
  return version;
}

export function listArtifactVersions(artifactIdValue: string): ArtifactVersion[] {
  ensureArtifactSchema();
  if (!getArtifact(artifactIdValue)) throw new Error(`Artifact not found: ${artifactIdValue}`);
  return (
    getDb()
      .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_number ASC")
      .all(artifactIdValue) as ArtifactVersionRow[]
  ).map(rowToVersion);
}

export function getArtifactVersion(artifactIdValue: string, versionNumber?: number): ArtifactVersion | null {
  ensureArtifactSchema();
  if (!getArtifact(artifactIdValue)) throw new Error(`Artifact not found: ${artifactIdValue}`);
  const row =
    versionNumber === undefined
      ? (getDb()
          .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_number DESC LIMIT 1")
          .get(artifactIdValue) as ArtifactVersionRow | null)
      : (getDb()
          .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND version_number = ?")
          .get(artifactIdValue, versionNumber) as ArtifactVersionRow | null);
  return row ? rowToVersion(row) : null;
}

export function restoreArtifactVersion(
  artifactIdValue: string,
  versionNumber: number,
  options: { actor?: string; source?: string; message?: string } = {},
): RestoreArtifactVersionResult {
  ensureArtifactSchema();
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new Error("Artifact version number must be a positive integer.");
  }
  const restoredFrom = getArtifactVersion(artifactIdValue, versionNumber);
  if (!restoredFrom) throw new Error(`Artifact version not found: ${artifactIdValue} v${versionNumber}`);

  const primaryAsset = restoredFrom.assets.find((asset) => asset.role === "primary") ?? restoredFrom.assets[0] ?? null;
  const restoredOutput = hasOwnKey(restoredFrom.manifest, "output") ? restoredFrom.manifest.output : undefined;
  const now = Date.now();
  const source = options.source?.trim() || "artifacts.store";
  const message = options.message?.trim() || `Artifact restored from version ${restoredFrom.versionNumber}`;

  getDb()
    .prepare(
      `UPDATE artifacts SET
        uri = ?,
        file_path = ?,
        blob_path = ?,
        mime_type = ?,
        size_bytes = ?,
        sha256 = ?,
        output_json = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      primaryAsset?.uri ?? manifestArtifactUri(restoredFrom),
      primaryAsset?.filePath ?? null,
      primaryAsset?.blobPath ?? null,
      primaryAsset?.mimeType ?? null,
      primaryAsset?.sizeBytes ?? null,
      primaryAsset?.sha256 ?? null,
      restoredOutput === undefined ? null : jsonString(restoredOutput),
      now,
      artifactIdValue,
    );

  const artifact = getArtifact(artifactIdValue);
  if (!artifact) throw new Error(`Artifact restore failed: ${artifactIdValue}`);

  insertArtifactEvent(
    artifactIdValue,
    "version_restored",
    {
      restoredFromVersionId: restoredFrom.id,
      restoredFromVersionNumber: restoredFrom.versionNumber,
      restoredAssetPath: primaryAsset?.path ?? null,
      restoredSha256: primaryAsset?.sha256 ?? null,
    },
    options.actor,
    {
      status: artifact.status,
      message,
      source,
    },
  );

  const restoreVersion = createArtifactVersion(artifactIdValue, {
    source,
    message,
    ...(options.actor ? { createdBy: options.actor } : {}),
    metadata: {
      restoredFromVersionId: restoredFrom.id,
      restoredFromVersionNumber: restoredFrom.versionNumber,
    },
    manifest: {
      restoredFrom: {
        versionId: restoredFrom.id,
        versionNumber: restoredFrom.versionNumber,
      },
    },
  });

  return { artifact, restoredFrom, restoreVersion };
}

export function appendArtifactEvent(artifactIdValue: string, input: AppendArtifactEventInput): ArtifactEvent {
  ensureArtifactSchema();
  if (!getArtifact(artifactIdValue)) throw new Error(`Artifact not found: ${artifactIdValue}`);
  insertArtifactEvent(artifactIdValue, input.eventType, input.payload, input.actor, {
    status: input.status,
    message: input.message,
    source: input.source,
  });
  const events = listArtifactEvents(artifactIdValue);
  const event = events[events.length - 1];
  if (!event) throw new Error(`Artifact event insert failed: ${artifactIdValue}`);
  return event;
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

  insertArtifactEvent(id, "created", { kind: parsed.kind, file: file ? basename(file.filePath) : null }, undefined, {
    status: parsed.status,
    message: "Artifact created",
    source: "artifacts.store",
  });
  syncArtifactTagsToCanonical(id, tags);
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact insert failed: ${id}`);
  if (artifactHasVersionableContent(artifact)) {
    createArtifactVersion(id, {
      source: "artifacts.store",
      message: "Initial artifact version created",
    });
  }
  return artifact;
}

export function getArtifact(id: string): ArtifactRecord | null {
  ensureArtifactSchema();
  const row = getDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | null;
  return row ? rowToArtifact(row) : null;
}

function artifactWhere(options: ListArtifactsOptions): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const lifecycle = options.lifecycle?.trim().toLowerCase();
  if (!options.includeDeleted && lifecycle !== "archived") where.push("deleted_at IS NULL");
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
  if (options.agentId) {
    where.push("agent_id = ?");
    params.push(options.agentId);
  }
  if (options.tag) {
    const canonicalIds = canonicalAssetIdsForTag("artifact", options.tag) ?? [];
    const tagPredicates = ["EXISTS (SELECT 1 FROM json_each(artifacts.tags_json) WHERE value = ?)"];
    params.push(options.tag);
    if (canonicalIds.length > 0) {
      tagPredicates.push(`id IN (${canonicalIds.map(() => "?").join(", ")})`);
      params.push(...canonicalIds);
    }
    where.push(`(${tagPredicates.join(" OR ")})`);
  }
  if (lifecycle) {
    const completedStatuses = "'completed', 'done', 'succeeded', 'success'";
    const failedStatuses = "'failed', 'error', 'errored'";
    const pendingStatuses = "'pending', 'queued', 'waiting'";
    const archivedStatuses = "'archived', 'deleted'";
    const terminalStatuses = `${completedStatuses}, ${failedStatuses}, ${pendingStatuses}, ${archivedStatuses}`;
    if (lifecycle === "archived") {
      where.push(`(deleted_at IS NOT NULL OR lower(status) IN (${archivedStatuses}))`);
    } else if (lifecycle === "completed") {
      where.push(`deleted_at IS NULL AND lower(status) IN (${completedStatuses})`);
    } else if (lifecycle === "failed") {
      where.push(`deleted_at IS NULL AND lower(status) IN (${failedStatuses})`);
    } else if (lifecycle === "pending") {
      where.push(`deleted_at IS NULL AND lower(status) IN (${pendingStatuses})`);
    } else if (lifecycle === "running") {
      where.push(`deleted_at IS NULL AND (trim(status) = '' OR lower(status) NOT IN (${terminalStatuses}))`);
    }
  }
  return { where, params };
}

export function listArtifactsPage(options: ListArtifactsOptions = {}): ArtifactListPage {
  ensureArtifactSchema();
  const db = getDb();
  const { where, params } = artifactWhere(options);
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const total = countRows({ db, table: "artifacts", where, params });
  const sql = `SELECT * FROM artifacts ${buildSqlWhereClause(where)} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset) as ArtifactRow[];
  return {
    items: rows.map(rowToArtifact),
    total,
    limit,
    offset,
  };
}

export function listArtifacts(options: ListArtifactsOptions = {}): ArtifactRecord[] {
  return listArtifactsPage(options).items;
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

  if (providedKeys.has("tags")) {
    syncArtifactTagsToCanonical(id, normalizeTags(parsed.tags));
  }

  insertArtifactEvent(id, "updated", { updates: [...providedKeys].sort() }, options.actor, {
    status: parsed.status,
    message: "Artifact updated",
    source: "artifacts.store",
  });
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact update failed: ${id}`);
  if (updateCreatesVersion(providedKeys) && artifactHasVersionableContent(artifact)) {
    createArtifactVersion(id, {
      source: "artifacts.store",
      message: "Artifact content version created",
      ...(options.actor ? { createdBy: options.actor } : {}),
      metadata: { updates: [...providedKeys].sort() },
    });
  }
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
  insertArtifactEvent(artifactIdValue, "attached", { targetType, targetId, relation }, undefined, {
    message: `Attached to ${targetType}:${targetId}`,
    source: "artifacts.store",
  });
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
  insertArtifactEvent(id, "archived", undefined, actor, {
    status: "archived",
    message: "Artifact archived",
    source: "artifacts.store",
  });
  const artifact = getArtifact(id);
  if (!artifact) throw new Error(`Artifact archive failed: ${id}`);
  return artifact;
}

export function getArtifactDetails(id: string): {
  artifact: ArtifactRecord;
  links: ArtifactLink[];
  events: ArtifactEvent[];
  versions: ArtifactVersion[];
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
  const versions = listArtifactVersions(id);
  return { artifact, links, events, versions };
}

export function listArtifactEvents(id: string): ArtifactEvent[] {
  ensureArtifactSchema();
  if (!getArtifact(id)) throw new Error(`Artifact not found: ${id}`);
  return (
    getDb()
      .prepare("SELECT * FROM artifact_events WHERE artifact_id = ? ORDER BY created_at ASC, id ASC")
      .all(id) as ArtifactEventRow[]
  ).map(rowToEvent);
}

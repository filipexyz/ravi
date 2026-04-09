import { randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import type {
  CreateTagDefinitionInput,
  TagBinding,
  TagBindingQuery,
  TagDefinition,
  TagDefinitionSummary,
  UpsertTagBindingInput,
} from "./types.js";

interface TagDefinitionRow {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  kind: TagDefinition["kind"];
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TagDefinitionSummaryRow extends TagDefinitionRow {
  binding_count: number;
}

interface TagBindingRow {
  id: string;
  tag_id: string;
  tag_slug: string;
  asset_type: TagBinding["assetType"];
  asset_id: string;
  metadata_json: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

let schemaReady = false;

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return undefined;
}

function stringifyMetadata(metadata?: Record<string, unknown>): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  return JSON.stringify(metadata);
}

function rowToTagDefinition(row: TagDefinitionRow): TagDefinition {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    kind: row.kind,
    ...(parseMetadata(row.metadata_json) ? { metadata: parseMetadata(row.metadata_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTagDefinitionSummary(row: TagDefinitionSummaryRow): TagDefinitionSummary {
  return {
    ...rowToTagDefinition(row),
    bindingCount: row.binding_count,
  };
}

function rowToTagBinding(row: TagBindingRow): TagBinding {
  return {
    id: row.id,
    tagId: row.tag_id,
    tagSlug: row.tag_slug,
    assetType: row.asset_type,
    assetId: row.asset_id,
    ...(parseMetadata(row.metadata_json) ? { metadata: parseMetadata(row.metadata_json) } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTagSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_definitions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_bindings (
      id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      metadata_json TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tag_id, asset_type, asset_id),
      FOREIGN KEY (tag_id) REFERENCES tag_definitions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tag_definitions_slug ON tag_definitions(slug);
    CREATE INDEX IF NOT EXISTS idx_tag_bindings_tag ON tag_bindings(tag_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_bindings_asset ON tag_bindings(asset_type, asset_id, updated_at DESC);
  `);
  schemaReady = true;
}

function getTagDefinitionRowBySlug(slug: string): TagDefinitionRow | undefined {
  ensureTagSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM tag_definitions WHERE slug = ?").get(slug) as TagDefinitionRow | undefined;
}

export function dbCreateTagDefinition(input: CreateTagDefinitionInput): TagDefinition {
  ensureTagSchema();
  const db = getDb();
  const existing = getTagDefinitionRowBySlug(input.slug);
  if (existing) {
    throw new Error(`Tag already exists: ${input.slug}`);
  }

  const now = Date.now();
  const id = `tag-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO tag_definitions (
      id, slug, label, description, kind, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.slug,
    input.label,
    input.description ?? null,
    input.kind ?? "user",
    stringifyMetadata(input.metadata),
    now,
    now,
  );

  return dbGetTagDefinition(input.slug)!;
}

export function dbGetTagDefinition(slug: string): TagDefinition | null {
  const row = getTagDefinitionRowBySlug(slug);
  return row ? rowToTagDefinition(row) : null;
}

export function dbListTagDefinitions(): TagDefinitionSummary[] {
  ensureTagSchema();
  const db = getDb();
  const rows = db
    .prepare(`
    SELECT
      t.*,
      COUNT(b.id) AS binding_count
    FROM tag_definitions t
    LEFT JOIN tag_bindings b ON b.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.slug ASC
  `)
    .all() as TagDefinitionSummaryRow[];
  return rows.map(rowToTagDefinitionSummary);
}

export function dbUpsertTagBinding(input: UpsertTagBindingInput): TagBinding {
  ensureTagSchema();
  const db = getDb();
  const tag = getTagDefinitionRowBySlug(input.slug);
  if (!tag) {
    throw new Error(`Tag not found: ${input.slug}`);
  }

  const existing = db
    .prepare(`
    SELECT
      b.id,
      b.tag_id,
      t.slug AS tag_slug,
      b.asset_type,
      b.asset_id,
      b.metadata_json,
      b.created_by,
      b.created_at,
      b.updated_at
    FROM tag_bindings b
    JOIN tag_definitions t ON t.id = b.tag_id
    WHERE b.tag_id = ? AND b.asset_type = ? AND b.asset_id = ?
  `)
    .get(tag.id, input.assetType, input.assetId) as TagBindingRow | undefined;

  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE tag_bindings
      SET metadata_json = ?, created_by = COALESCE(?, created_by), updated_at = ?
      WHERE id = ?
    `).run(stringifyMetadata(input.metadata), input.createdBy ?? null, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO tag_bindings (
        id, tag_id, asset_type, asset_id, metadata_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `tb-${randomUUID().slice(0, 8)}`,
      tag.id,
      input.assetType,
      input.assetId,
      stringifyMetadata(input.metadata),
      input.createdBy ?? null,
      now,
      now,
    );
  }

  return dbFindTagBindings({
    slug: input.slug,
    assetType: input.assetType,
    assetId: input.assetId,
  })[0]!;
}

export function dbDeleteTagBinding(input: {
  slug: string;
  assetType: TagBinding["assetType"];
  assetId: string;
}): boolean {
  ensureTagSchema();
  const db = getDb();
  const tag = getTagDefinitionRowBySlug(input.slug);
  if (!tag) return false;
  const result = db
    .prepare(`
    DELETE FROM tag_bindings
    WHERE tag_id = ? AND asset_type = ? AND asset_id = ?
  `)
    .run(tag.id, input.assetType, input.assetId);
  return result.changes > 0;
}

export function dbFindTagBindings(query: TagBindingQuery = {}): TagBinding[] {
  ensureTagSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string> = [];

  if (query.slug) {
    filters.push("t.slug = ?");
    params.push(query.slug);
  }
  if (query.assetType) {
    filters.push("b.asset_type = ?");
    params.push(query.assetType);
  }
  if (query.assetId) {
    filters.push("b.asset_id = ?");
    params.push(query.assetId);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(`
    SELECT
      b.id,
      b.tag_id,
      t.slug AS tag_slug,
      b.asset_type,
      b.asset_id,
      b.metadata_json,
      b.created_by,
      b.created_at,
      b.updated_at
    FROM tag_bindings b
    JOIN tag_definitions t ON t.id = b.tag_id
    ${where}
    ORDER BY t.slug ASC, b.asset_type ASC, b.asset_id ASC
  `)
    .all(...params) as TagBindingRow[];

  return rows.map(rowToTagBinding);
}

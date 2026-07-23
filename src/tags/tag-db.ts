import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import {
  TAG_ASSET_TYPES,
  TAG_KINDS,
  type CreateTagDefinitionInput,
  type TagAssetType,
  type TagBinding,
  type TagBindingQuery,
  type TagDefinition,
  type TagDefinitionListQuery,
  type TagDefinitionSummary,
  type TagEvent,
  type TagEventQuery,
  type TagEventType,
  type TagKind,
  type TagListCursor,
  type TagListOrder,
  type TagListSort,
  type UpdateTagDefinitionInput,
  type UpsertTagBindingInput,
} from "./types.js";

interface TagDefinitionRow {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  kind: TagKind;
  source: string;
  metadata_json: string | null;
  created_by: string | null;
  updated_by: string | null;
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
  asset_type: TagAssetType;
  asset_id: string;
  metadata_json: string | null;
  source: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

interface TagEventRow {
  id: number;
  event_type: TagEventType;
  tag_id: string | null;
  tag_slug: string;
  asset_type: TagAssetType | null;
  asset_id: string | null;
  actor: string | null;
  source: string;
  previous_json: string | null;
  metadata_json: string | null;
  created_at: number;
}

export interface EnsureTagBindingInput extends UpsertTagBindingInput {
  label?: string;
  description?: string;
  kind?: TagKind;
  definitionSource?: string;
  definitionMetadata?: Record<string, unknown>;
}

let schemaReady = false;
let schemaDbPath: string | null = null;

const TAG_SLUG_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const TAG_SOURCE_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const DEFAULT_TAG_SOURCE = "ravi";

function parseRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return undefined;
}

function assertRecord(
  value: Record<string, unknown> | undefined,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return value;
}

function stringifyRecord(value: Record<string, unknown> | undefined): string | null {
  const record = assertRecord(value, "Tag metadata");
  if (!record || Object.keys(record).length === 0) return null;
  return JSON.stringify(record);
}

function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeTagSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slug) {
    throw new Error("Tag slug is required.");
  }
  if (!TAG_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid tag slug: ${value}. Use lowercase letters, numbers, dots, underscores, colons, or dashes.`,
    );
  }
  return slug;
}

export function tryNormalizeTagSlug(value: string): string | null {
  try {
    return normalizeTagSlug(value);
  } catch {
    return null;
  }
}

export function requireTagKind(value?: string | null): TagKind {
  const normalized = (value?.trim().toLowerCase() || "user") as TagKind;
  if (!(TAG_KINDS as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid tag kind: ${value}. Use ${TAG_KINDS.join("|")}.`);
  }
  return normalized;
}

export function requireTagAssetType(value: string): TagAssetType {
  const normalized = value.trim().toLowerCase() as TagAssetType;
  if (!(TAG_ASSET_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid tag asset type: ${value}. Use ${TAG_ASSET_TYPES.join("|")}.`);
  }
  return normalized;
}

export function normalizeTagSource(value?: string | null): string {
  const normalized = value?.trim().toLowerCase() || DEFAULT_TAG_SOURCE;
  if (!TAG_SOURCE_RE.test(normalized)) {
    throw new Error(`Invalid tag source: ${value}. Use a machine-friendly token.`);
  }
  return normalized;
}

function normalizeTagListLimit(limit?: number): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
}

function getTagSortColumn(sort: TagListSort, tableAlias: string): string {
  return sort === "created" ? `${tableAlias}.created_at` : `${tableAlias}.updated_at`;
}

function validateCursor(
  cursor: TagListCursor | undefined,
  sort: TagListSort,
  order: TagListOrder,
): TagListCursor | undefined {
  if (!cursor) return undefined;
  if (cursor.sort !== sort || cursor.order !== order) {
    throw new Error("Tag list cursor sort/order does not match the requested list order.");
  }
  return cursor;
}

function rowToTagDefinition(row: TagDefinitionRow): TagDefinition {
  const metadata = parseRecord(row.metadata_json);
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    kind: row.kind,
    source: row.source,
    ...(metadata ? { metadata } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
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
  const metadata = parseRecord(row.metadata_json);
  return {
    id: row.id,
    tagId: row.tag_id,
    tagSlug: row.tag_slug,
    assetType: row.asset_type,
    assetId: row.asset_id,
    ...(metadata ? { metadata } : {}),
    source: row.source,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTagEvent(row: TagEventRow): TagEvent {
  const previous = parseRecord(row.previous_json);
  const metadata = parseRecord(row.metadata_json);
  return {
    id: row.id,
    type: row.event_type,
    ...(row.tag_id ? { tagId: row.tag_id } : {}),
    tagSlug: row.tag_slug,
    ...(row.asset_type ? { assetType: row.asset_type } : {}),
    ...(row.asset_id ? { assetId: row.asset_id } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    source: row.source,
    ...(previous ? { previous } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: row.created_at,
  };
}

function applyTagSchemaMigrations(): void {
  const db = getDb();
  const definitionColumns = new Set(
    (db.prepare("PRAGMA table_info(tag_definitions)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!definitionColumns.has("source")) {
    db.exec("ALTER TABLE tag_definitions ADD COLUMN source TEXT NOT NULL DEFAULT 'ravi'");
  }
  if (!definitionColumns.has("created_by")) {
    db.exec("ALTER TABLE tag_definitions ADD COLUMN created_by TEXT");
  }
  if (!definitionColumns.has("updated_by")) {
    db.exec("ALTER TABLE tag_definitions ADD COLUMN updated_by TEXT");
  }

  const bindingColumns = new Set(
    (db.prepare("PRAGMA table_info(tag_bindings)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!bindingColumns.has("source")) {
    db.exec("ALTER TABLE tag_bindings ADD COLUMN source TEXT NOT NULL DEFAULT 'ravi'");
  }
  if (!bindingColumns.has("updated_by")) {
    db.exec("ALTER TABLE tag_bindings ADD COLUMN updated_by TEXT");
  }
}

export function ensureTagSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === dbPath) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_definitions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      source TEXT NOT NULL DEFAULT 'ravi',
      metadata_json TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_bindings (
      id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      metadata_json TEXT,
      source TEXT NOT NULL DEFAULT 'ravi',
      created_by TEXT,
      updated_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tag_id, asset_type, asset_id),
      FOREIGN KEY (tag_id) REFERENCES tag_definitions(id) ON DELETE CASCADE
    );
  `);
  applyTagSchemaMigrations();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      tag_id TEXT,
      tag_slug TEXT NOT NULL,
      asset_type TEXT,
      asset_id TEXT,
      actor TEXT,
      source TEXT NOT NULL DEFAULT 'ravi',
      previous_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tag_definitions_slug ON tag_definitions(slug);
    CREATE INDEX IF NOT EXISTS idx_tag_definitions_source ON tag_definitions(source, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_bindings_tag ON tag_bindings(tag_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_bindings_asset ON tag_bindings(asset_type, asset_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_bindings_source ON tag_bindings(source, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_events_tag ON tag_events(tag_slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_events_asset ON tag_events(asset_type, asset_id, created_at DESC);
  `);
  schemaReady = true;
  schemaDbPath = dbPath;
}

function getTagDefinitionRowBySlug(slug: string): TagDefinitionRow | undefined {
  ensureTagSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM tag_definitions WHERE slug = ?").get(normalizeTagSlug(slug)) as
    | TagDefinitionRow
    | undefined;
}

function insertTagEvent(input: {
  type: TagEventType;
  tagId?: string | null;
  tagSlug: string;
  assetType?: TagAssetType | null;
  assetId?: string | null;
  actor?: string | null;
  source?: string | null;
  previous?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}): void {
  ensureTagSchema();
  getDb()
    .prepare(
      `
      INSERT INTO tag_events (
        event_type, tag_id, tag_slug, asset_type, asset_id, actor, source, previous_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.type,
      input.tagId ?? null,
      normalizeTagSlug(input.tagSlug),
      input.assetType ?? null,
      input.assetId ?? null,
      input.actor ?? null,
      normalizeTagSource(input.source),
      stringifyRecord(input.previous),
      stringifyRecord(input.metadata),
      input.createdAt ?? Date.now(),
    );
}

export function dbCreateTagDefinition(input: CreateTagDefinitionInput): TagDefinition {
  ensureTagSchema();
  const db = getDb();
  const slug = normalizeTagSlug(input.slug);
  const existing = getTagDefinitionRowBySlug(slug);
  if (existing) {
    throw new Error(`Tag already exists: ${slug}`);
  }

  const now = Date.now();
  const id = `tag-${randomUUID().slice(0, 8)}`;
  const kind = requireTagKind(input.kind);
  const source = normalizeTagSource(input.source);
  const createdBy = normalizeOptionalText(input.createdBy);
  const label = input.label.trim() || slug;
  const metadataJson = stringifyRecord(input.metadata);
  db.prepare(
    `
    INSERT INTO tag_definitions (
      id, slug, label, description, kind, source, metadata_json, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, slug, label, input.description?.trim() || null, kind, source, metadataJson, createdBy, createdBy, now, now);

  insertTagEvent({
    type: "tag.definition.created",
    tagId: id,
    tagSlug: slug,
    actor: createdBy,
    source,
    metadata: {
      label,
      kind,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    createdAt: now,
  });

  return dbGetTagDefinition(slug)!;
}

export function dbGetTagDefinition(slug: string): TagDefinition | null {
  const row = getTagDefinitionRowBySlug(slug);
  return row ? rowToTagDefinition(row) : null;
}

export function dbUpdateTagDefinition(input: UpdateTagDefinitionInput): TagDefinition {
  ensureTagSchema();
  const slug = normalizeTagSlug(input.slug);
  const existing = getTagDefinitionRowBySlug(slug);
  if (!existing) {
    throw new Error(`Tag not found: ${slug}`);
  }

  const previous = rowToTagDefinition(existing);
  const label = normalizeOptionalText(input.label) ?? previous.label;
  const description =
    input.description === undefined ? (previous.description ?? null) : normalizeOptionalText(input.description);
  const kind = input.kind ? requireTagKind(input.kind) : previous.kind;
  const source = input.source ? normalizeTagSource(input.source) : previous.source;
  const metadata = input.metadata === undefined ? previous.metadata : assertRecord(input.metadata, "Tag metadata");
  const updatedBy = normalizeOptionalText(input.updatedBy);
  const now = Date.now();

  getDb()
    .prepare(
      `
      UPDATE tag_definitions
      SET label = ?, description = ?, kind = ?, source = ?, metadata_json = ?, updated_by = ?, updated_at = ?
      WHERE slug = ?
    `,
    )
    .run(label, description, kind, source, stringifyRecord(metadata), updatedBy, now, slug);

  insertTagEvent({
    type: "tag.definition.updated",
    tagId: previous.id,
    tagSlug: slug,
    actor: updatedBy,
    source,
    previous: {
      label: previous.label,
      kind: previous.kind,
      source: previous.source,
      ...(previous.description ? { description: previous.description } : {}),
      ...(previous.metadata ? { metadata: previous.metadata } : {}),
    },
    metadata: {
      label,
      kind,
      source,
      ...(description ? { description } : {}),
      ...(metadata ? { metadata } : {}),
    },
    createdAt: now,
  });

  return dbGetTagDefinition(slug)!;
}

export function dbListTagDefinitions(query: TagDefinitionListQuery = {}): TagDefinitionSummary[] {
  ensureTagSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const sort = query.sort ?? query.cursor?.sort ?? "updated";
  const order = query.order ?? query.cursor?.order ?? "desc";
  const cursor = validateCursor(query.cursor, sort, order);
  const sortColumn = getTagSortColumn(sort, "t");
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const cursorComparator = order === "asc" ? ">" : "<";
  const limit = normalizeTagListLimit(query.limit);

  if (query.kind) {
    filters.push("t.kind = ?");
    params.push(requireTagKind(query.kind));
  }
  if (query.source) {
    filters.push("t.source = ?");
    params.push(normalizeTagSource(query.source));
  }
  const textQuery = query.query?.trim().toLowerCase();
  if (textQuery) {
    filters.push("(LOWER(t.slug) LIKE ? OR LOWER(t.label) LIKE ? OR LOWER(COALESCE(t.description, '')) LIKE ?)");
    const like = `%${textQuery}%`;
    params.push(like, like, like);
  }
  if (cursor) {
    filters.push(`(${sortColumn} ${cursorComparator} ? OR (${sortColumn} = ? AND t.id ${cursorComparator} ?))`);
    params.push(Math.floor(cursor.value), Math.floor(cursor.value), cursor.id);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limitClause = limit ? " LIMIT ?" : "";
  if (limit) params.push(limit);
  const rows = db
    .prepare(
      `
    SELECT
      t.*,
      COUNT(b.id) AS binding_count
    FROM tag_definitions t
    LEFT JOIN tag_bindings b ON b.tag_id = t.id
    ${where}
    GROUP BY t.id
    ORDER BY ${sortColumn} ${orderSql}, t.id ${orderSql}
    ${limitClause}
  `,
    )
    .all(...params) as TagDefinitionSummaryRow[];
  return rows.map(rowToTagDefinitionSummary);
}

function getExistingBindingRow(tagId: string, assetType: TagAssetType, assetId: string): TagBindingRow | undefined {
  return getDb()
    .prepare(
      `
    SELECT
      b.id,
      b.tag_id,
      t.slug AS tag_slug,
      b.asset_type,
      b.asset_id,
      b.metadata_json,
      b.source,
      b.created_by,
      b.updated_by,
      b.created_at,
      b.updated_at
    FROM tag_bindings b
    JOIN tag_definitions t ON t.id = b.tag_id
    WHERE b.tag_id = ? AND b.asset_type = ? AND b.asset_id = ?
  `,
    )
    .get(tagId, assetType, assetId) as TagBindingRow | undefined;
}

export function dbUpsertTagBinding(input: UpsertTagBindingInput): TagBinding {
  ensureTagSchema();
  const db = getDb();
  const slug = normalizeTagSlug(input.slug);
  const tag = getTagDefinitionRowBySlug(slug);
  if (!tag) {
    throw new Error(`Tag not found: ${slug}`);
  }

  const assetType = requireTagAssetType(input.assetType);
  const assetId = input.assetId.trim();
  if (!assetId) {
    throw new Error("Tag binding asset id is required.");
  }
  const createdBy = normalizeOptionalText(input.createdBy);
  const updatedBy = normalizeOptionalText(input.updatedBy) ?? createdBy;
  const existing = getExistingBindingRow(tag.id, assetType, assetId);
  const previous = existing ? rowToTagBinding(existing) : null;
  const source = input.source === undefined && previous ? previous.source : normalizeTagSource(input.source);
  if (previous && slug.startsWith("policy.") && source !== previous.source) {
    throw new Error(
      `Cannot change source for policy tag binding ${slug} on ${assetType}:${assetId}; detach and reattach with an explicit audit trail.`,
    );
  }
  const metadata = input.metadata === undefined && previous ? previous.metadata : input.metadata;
  const metadataJson = stringifyRecord(metadata);

  const now = Date.now();
  if (existing) {
    const previousBinding = previous!;
    db.prepare(
      `
      UPDATE tag_bindings
      SET metadata_json = ?, source = ?, created_by = COALESCE(created_by, ?), updated_by = COALESCE(?, updated_by), updated_at = ?
      WHERE id = ?
    `,
    ).run(metadataJson, source, createdBy, updatedBy, now, existing.id);
    insertTagEvent({
      type: "tag.binding.updated",
      tagId: tag.id,
      tagSlug: slug,
      assetType,
      assetId,
      actor: updatedBy,
      source,
      previous: {
        source: previousBinding.source,
        ...(previousBinding.metadata ? { metadata: previousBinding.metadata } : {}),
        ...(previousBinding.createdBy ? { createdBy: previousBinding.createdBy } : {}),
        ...(previousBinding.updatedBy ? { updatedBy: previousBinding.updatedBy } : {}),
      },
      metadata: {
        source,
        ...(metadata ? { metadata } : {}),
      },
      createdAt: now,
    });
  } else {
    const id = `tb-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `
      INSERT INTO tag_bindings (
        id, tag_id, asset_type, asset_id, metadata_json, source, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, tag.id, assetType, assetId, metadataJson, source, createdBy ?? updatedBy, updatedBy, now, now);
    insertTagEvent({
      type: "tag.binding.attached",
      tagId: tag.id,
      tagSlug: slug,
      assetType,
      assetId,
      actor: updatedBy ?? createdBy,
      source,
      metadata: {
        source,
        ...(metadata ? { metadata } : {}),
      },
      createdAt: now,
    });
  }

  return dbFindTagBindings({
    slug,
    assetType,
    assetId,
  })[0]!;
}

export function dbEnsureTagBinding(input: EnsureTagBindingInput): TagBinding {
  const slug = normalizeTagSlug(input.slug);
  if (!dbGetTagDefinition(slug)) {
    dbCreateTagDefinition({
      slug,
      label: input.label?.trim() || slug,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      kind: input.kind,
      source: input.definitionSource ?? input.source,
      metadata: input.definitionMetadata,
      createdBy: input.createdBy ?? input.updatedBy,
    });
  }
  return dbUpsertTagBinding({
    slug,
    assetType: input.assetType,
    assetId: input.assetId,
    metadata: input.metadata,
    source: input.source,
    createdBy: input.createdBy,
    updatedBy: input.updatedBy,
  });
}

export function dbDeleteTagBinding(input: {
  slug: string;
  assetType: TagAssetType;
  assetId: string;
  actor?: string;
  source?: string;
}): boolean {
  ensureTagSchema();
  const db = getDb();
  const slug = normalizeTagSlug(input.slug);
  const tag = getTagDefinitionRowBySlug(slug);
  if (!tag) return false;
  const assetType = requireTagAssetType(input.assetType);
  const assetId = input.assetId.trim();
  const existing = getExistingBindingRow(tag.id, assetType, assetId);
  if (!existing) return false;
  const previous = rowToTagBinding(existing);
  const result = db
    .prepare(
      `
    DELETE FROM tag_bindings
    WHERE tag_id = ? AND asset_type = ? AND asset_id = ?
  `,
    )
    .run(tag.id, assetType, assetId);

  if (result.changes > 0) {
    const source = normalizeTagSource(input.source ?? previous.source);
    insertTagEvent({
      type: "tag.binding.detached",
      tagId: tag.id,
      tagSlug: slug,
      assetType,
      assetId,
      actor: normalizeOptionalText(input.actor) ?? previous.updatedBy ?? previous.createdBy,
      source,
      previous: {
        source: previous.source,
        ...(previous.metadata ? { metadata: previous.metadata } : {}),
        ...(previous.createdBy ? { createdBy: previous.createdBy } : {}),
        ...(previous.updatedBy ? { updatedBy: previous.updatedBy } : {}),
      },
    });
  }

  return result.changes > 0;
}

export function dbFindTagBindings(query: TagBindingQuery = {}): TagBinding[] {
  ensureTagSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const sort = query.sort ?? query.cursor?.sort ?? "updated";
  const order = query.order ?? query.cursor?.order ?? "desc";
  const cursor = validateCursor(query.cursor, sort, order);
  const sortColumn = getTagSortColumn(sort, "b");
  const orderSql = order === "asc" ? "ASC" : "DESC";
  const cursorComparator = order === "asc" ? ">" : "<";
  const limit = normalizeTagListLimit(query.limit);

  if (query.slug) {
    filters.push("t.slug = ?");
    params.push(normalizeTagSlug(query.slug));
  }
  if (query.assetType) {
    filters.push("b.asset_type = ?");
    params.push(requireTagAssetType(query.assetType));
  }
  if (query.assetId) {
    filters.push("b.asset_id = ?");
    params.push(query.assetId.trim());
  }
  if (query.kind) {
    filters.push("t.kind = ?");
    params.push(requireTagKind(query.kind));
  }
  if (query.source) {
    filters.push("b.source = ?");
    params.push(normalizeTagSource(query.source));
  }
  if (cursor) {
    filters.push(`(${sortColumn} ${cursorComparator} ? OR (${sortColumn} = ? AND b.id ${cursorComparator} ?))`);
    params.push(Math.floor(cursor.value), Math.floor(cursor.value), cursor.id);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limitClause = limit ? " LIMIT ?" : "";
  if (limit) params.push(limit);
  const rows = db
    .prepare(
      `
    SELECT
      b.id,
      b.tag_id,
      t.slug AS tag_slug,
      b.asset_type,
      b.asset_id,
      b.metadata_json,
      b.source,
      b.created_by,
      b.updated_by,
      b.created_at,
      b.updated_at
    FROM tag_bindings b
    JOIN tag_definitions t ON t.id = b.tag_id
    ${where}
    ORDER BY ${sortColumn} ${orderSql}, b.id ${orderSql}
    ${limitClause}
  `,
    )
    .all(...params) as TagBindingRow[];

  return rows.map(rowToTagBinding);
}

export function dbListTagBindingsForAsset(assetType: TagAssetType, assetId: string): TagBinding[] {
  return dbFindTagBindings({ assetType, assetId });
}

export function dbListTagEvents(query: TagEventQuery = {}): TagEvent[] {
  ensureTagSchema();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const limit = normalizeTagListLimit(query.limit) ?? 30;

  if (query.slug) {
    filters.push("tag_slug = ?");
    params.push(normalizeTagSlug(query.slug));
  }
  if (query.assetType) {
    filters.push("asset_type = ?");
    params.push(requireTagAssetType(query.assetType));
  }
  if (query.assetId) {
    filters.push("asset_id = ?");
    params.push(query.assetId.trim());
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(limit);
  const rows = getDb()
    .prepare(
      `
    SELECT *
    FROM tag_events
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(...params) as TagEventRow[];
  return rows.map(rowToTagEvent);
}

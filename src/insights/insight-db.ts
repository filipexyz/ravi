import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getRaviStateDir } from "../utils/paths.js";
import { configureSqliteConnection } from "../utils/sqlite.js";
import type {
  AddInsightCommentInput,
  CreateInsightInput,
  InsightActor,
  InsightComment,
  InsightConfidence,
  InsightDetail,
  InsightImportance,
  InsightLink,
  InsightLinkTargetType,
  InsightListQuery,
  InsightOrigin,
  InsightRecord,
  InsightSummary,
  UpsertInsightLinkInput,
} from "./types.js";

interface InsightRow {
  id: string;
  kind: InsightRecord["kind"];
  summary: string;
  detail: string | null;
  confidence: InsightConfidence;
  importance: InsightImportance;
  author_kind: InsightActor["kind"];
  author_name: string;
  author_agent_id: string | null;
  author_session_key: string | null;
  author_session_name: string | null;
  author_context_id: string | null;
  origin_kind: InsightOrigin["kind"];
  origin_context_id: string | null;
  author_json: string;
  origin_json: string;
  created_at: number;
  updated_at: number;
}

interface InsightSummaryRow extends InsightRow {
  link_count: number;
  comment_count: number;
}

interface InsightLinkRow {
  id: string;
  insight_id: string;
  target_type: InsightLinkTargetType;
  target_id: string;
  label: string | null;
  metadata_json: string | null;
  created_by_json: string | null;
  created_at: number;
  updated_at: number;
}

interface InsightCommentRow {
  id: string;
  insight_id: string;
  body: string;
  author_json: string;
  created_at: number;
}

type InsightDbState = {
  db: Database | null;
  dbPath: string | null;
};

type InsightDbGlobal = typeof globalThis & {
  __raviInsightsDbState?: InsightDbState;
};

const insightDbGlobal = globalThis as InsightDbGlobal;
const insightDbState =
  insightDbGlobal.__raviInsightsDbState ??
  (insightDbGlobal.__raviInsightsDbState = {
    db: null,
    dbPath: null,
  });

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "insights.db");
}

function ensureDb(): Database {
  const nextDbPath = resolveDbPath();
  if (insightDbState.db !== null && insightDbState.dbPath === nextDbPath) {
    return insightDbState.db;
  }

  if (insightDbState.db !== null) {
    insightDbState.db.close();
  }

  mkdirSync(getRaviStateDir(), { recursive: true });

  const db = new Database(nextDbPath);
  configureSqliteConnection(db);
  initializeSchema(db);

  insightDbState.db = db;
  insightDbState.dbPath = nextDbPath;
  return db;
}

export function closeInsightsDb(): void {
  if (insightDbState.db !== null) {
    insightDbState.db.close();
  }
  insightDbState.db = null;
  insightDbState.dbPath = null;
}

function initializeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      confidence TEXT NOT NULL,
      importance TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_agent_id TEXT,
      author_session_key TEXT,
      author_session_name TEXT,
      author_context_id TEXT,
      origin_kind TEXT NOT NULL,
      origin_context_id TEXT,
      author_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insight_links (
      id TEXT PRIMARY KEY,
      insight_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      label TEXT,
      metadata_json TEXT,
      created_by_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(insight_id, target_type, target_id),
      FOREIGN KEY (insight_id) REFERENCES insights(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS insight_comments (
      id TEXT PRIMARY KEY,
      insight_id TEXT NOT NULL,
      body TEXT NOT NULL,
      author_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (insight_id) REFERENCES insights(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_insights_updated_at ON insights(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_kind ON insights(kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_author_agent ON insights(author_agent_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_author_session ON insights(author_session_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insights_origin_context ON insights(origin_context_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insight_links_target ON insight_links(target_type, target_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insight_links_insight ON insight_links(insight_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_insight_comments_insight ON insight_comments(insight_id, created_at DESC);
  `);
}

function parseRecord<T extends object>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {}
  return undefined;
}

function stringifyRecord(value?: Record<string, unknown>): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function stringifyActor(actor?: InsightActor): string | null {
  if (!actor) return null;
  return JSON.stringify(actor);
}

function rowToInsightRecord(row: InsightRow): InsightRecord {
  const parsedAuthor = parseRecord<InsightActor>(row.author_json);
  const parsedOrigin = parseRecord<InsightOrigin>(row.origin_json);
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    ...(row.detail ? { detail: row.detail } : {}),
    confidence: row.confidence,
    importance: row.importance,
    author: parsedAuthor ?? {
      kind: row.author_kind,
      name: row.author_name,
      ...(row.author_agent_id ? { agentId: row.author_agent_id } : {}),
      ...(row.author_session_key ? { sessionKey: row.author_session_key } : {}),
      ...(row.author_session_name ? { sessionName: row.author_session_name } : {}),
      ...(row.author_context_id ? { contextId: row.author_context_id } : {}),
    },
    origin: parsedOrigin ?? {
      kind: row.origin_kind,
      ...(row.origin_context_id ? { contextId: row.origin_context_id } : {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInsightSummary(row: InsightSummaryRow): InsightSummary {
  return {
    ...rowToInsightRecord(row),
    linkCount: row.link_count,
    commentCount: row.comment_count,
  };
}

function rowToInsightLink(row: InsightLinkRow): InsightLink {
  return {
    id: row.id,
    insightId: row.insight_id,
    targetType: row.target_type,
    targetId: row.target_id,
    ...(row.label ? { label: row.label } : {}),
    ...(parseRecord<Record<string, unknown>>(row.metadata_json)
      ? { metadata: parseRecord<Record<string, unknown>>(row.metadata_json) }
      : {}),
    ...(parseRecord<InsightActor>(row.created_by_json)
      ? { createdBy: parseRecord<InsightActor>(row.created_by_json) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInsightComment(row: InsightCommentRow): InsightComment {
  return {
    id: row.id,
    insightId: row.insight_id,
    body: row.body,
    author: parseRecord<InsightActor>(row.author_json) ?? { kind: "system", name: "unknown" },
    createdAt: row.created_at,
  };
}

function getInsightRow(insightId: string): InsightRow | undefined {
  const db = ensureDb();
  return db.prepare("SELECT * FROM insights WHERE id = ?").get(insightId) as InsightRow | undefined;
}

function touchInsight(insightId: string, now = Date.now()): void {
  const db = ensureDb();
  db.prepare("UPDATE insights SET updated_at = ? WHERE id = ?").run(now, insightId);
}

function normalizeLimit(limit?: number): number {
  if (!limit) return 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return Math.min(Math.floor(limit), 200);
}

function trimOrNull(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireInsight(insightId: string): InsightRow {
  const row = getInsightRow(insightId);
  if (!row) {
    throw new Error(`Insight not found: ${insightId}`);
  }
  return row;
}

export function dbCreateInsight(input: CreateInsightInput): InsightDetail {
  const db = ensureDb();
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("Insight summary is required.");
  }

  const detail = trimOrNull(input.detail);
  const now = Date.now();
  const id = `ins-${randomUUID().slice(0, 10)}`;
  const kind = input.kind ?? "observation";
  const confidence = input.confidence ?? "medium";
  const importance = input.importance ?? "normal";

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO insights (
        id,
        kind,
        summary,
        detail,
        confidence,
        importance,
        author_kind,
        author_name,
        author_agent_id,
        author_session_key,
        author_session_name,
        author_context_id,
        origin_kind,
        origin_context_id,
        author_json,
        origin_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      kind,
      summary,
      detail,
      confidence,
      importance,
      input.author.kind,
      input.author.name,
      input.author.agentId ?? null,
      input.author.sessionKey ?? null,
      input.author.sessionName ?? null,
      input.author.contextId ?? null,
      input.origin.kind,
      input.origin.contextId ?? null,
      JSON.stringify(input.author),
      JSON.stringify(input.origin),
      now,
      now,
    );

    for (const link of input.links ?? []) {
      db.prepare(`
        INSERT INTO insight_links (
          id,
          insight_id,
          target_type,
          target_id,
          label,
          metadata_json,
          created_by_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `inl-${randomUUID().slice(0, 10)}`,
        id,
        link.targetType,
        link.targetId,
        trimOrNull(link.label),
        stringifyRecord(link.metadata),
        stringifyActor(link.createdBy ?? input.author),
        now,
        now,
      );
    }
  });

  transaction();
  return dbGetInsight(id)!;
}

export function dbListInsights(query: InsightListQuery = {}): InsightSummary[] {
  const db = ensureDb();
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (query.kind) {
    filters.push("i.kind = ?");
    params.push(query.kind);
  }
  if (query.confidence) {
    filters.push("i.confidence = ?");
    params.push(query.confidence);
  }
  if (query.importance) {
    filters.push("i.importance = ?");
    params.push(query.importance);
  }
  if (query.authorKind) {
    filters.push("i.author_kind = ?");
    params.push(query.authorKind);
  }
  if (query.authorAgentId) {
    filters.push("i.author_agent_id = ?");
    params.push(query.authorAgentId);
  }
  if (query.authorSessionName) {
    filters.push("i.author_session_name = ?");
    params.push(query.authorSessionName);
  }
  if (query.linkType && query.linkId) {
    filters.push(`
      EXISTS (
        SELECT 1
        FROM insight_links l
        WHERE l.insight_id = i.id
          AND l.target_type = ?
          AND l.target_id = ?
      )
    `);
    params.push(query.linkType, query.linkId);
  } else if (query.linkType) {
    filters.push(`
      EXISTS (
        SELECT 1
        FROM insight_links l
        WHERE l.insight_id = i.id
          AND l.target_type = ?
      )
    `);
    params.push(query.linkType);
  } else if (query.linkId) {
    filters.push(`
      EXISTS (
        SELECT 1
        FROM insight_links l
        WHERE l.insight_id = i.id
          AND l.target_id = ?
      )
    `);
    params.push(query.linkId);
  }
  if (query.text?.trim()) {
    const needle = `%${query.text.trim().toLowerCase()}%`;
    filters.push(`
      (
        lower(i.summary) LIKE ?
        OR lower(COALESCE(i.detail, '')) LIKE ?
        OR EXISTS (
          SELECT 1
          FROM insight_comments c
          WHERE c.insight_id = i.id
            AND lower(c.body) LIKE ?
        )
      )
    `);
    params.push(needle, needle, needle);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(`
      SELECT
        i.*,
        (
          SELECT COUNT(*)
          FROM insight_links l
          WHERE l.insight_id = i.id
        ) AS link_count,
        (
          SELECT COUNT(*)
          FROM insight_comments c
          WHERE c.insight_id = i.id
        ) AS comment_count
      FROM insights i
      ${where}
      ORDER BY i.updated_at DESC
      LIMIT ?
    `)
    .all(...params, normalizeLimit(query.limit)) as InsightSummaryRow[];

  return rows.map(rowToInsightSummary);
}

export function dbSearchInsights(text: string, query: Omit<InsightListQuery, "text"> = {}): InsightSummary[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("Search text is required.");
  }
  return dbListInsights({
    ...query,
    text: normalizedText,
  });
}

export function dbGetInsight(insightId: string): InsightDetail | null {
  const row = getInsightRow(insightId);
  if (!row) return null;

  const db = ensureDb();
  const links = db
    .prepare(`
      SELECT *
      FROM insight_links
      WHERE insight_id = ?
      ORDER BY target_type ASC, target_id ASC
    `)
    .all(insightId) as InsightLinkRow[];
  const comments = db
    .prepare(`
      SELECT *
      FROM insight_comments
      WHERE insight_id = ?
      ORDER BY created_at ASC
    `)
    .all(insightId) as InsightCommentRow[];

  return {
    ...rowToInsightRecord(row),
    links: links.map(rowToInsightLink),
    comments: comments.map(rowToInsightComment),
  };
}

export function dbUpsertInsightLink(input: UpsertInsightLinkInput): InsightLink {
  const db = ensureDb();
  requireInsight(input.insightId);

  const existing = db
    .prepare(`
      SELECT *
      FROM insight_links
      WHERE insight_id = ? AND target_type = ? AND target_id = ?
    `)
    .get(input.insightId, input.targetType, input.targetId) as InsightLinkRow | undefined;

  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE insight_links
      SET label = ?, metadata_json = ?, created_by_json = COALESCE(?, created_by_json), updated_at = ?
      WHERE id = ?
    `).run(trimOrNull(input.label), stringifyRecord(input.metadata), stringifyActor(input.createdBy), now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO insight_links (
        id,
        insight_id,
        target_type,
        target_id,
        label,
        metadata_json,
        created_by_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `inl-${randomUUID().slice(0, 10)}`,
      input.insightId,
      input.targetType,
      input.targetId,
      trimOrNull(input.label),
      stringifyRecord(input.metadata),
      stringifyActor(input.createdBy),
      now,
      now,
    );
  }

  touchInsight(input.insightId, now);

  const row = db
    .prepare(`
      SELECT *
      FROM insight_links
      WHERE insight_id = ? AND target_type = ? AND target_id = ?
    `)
    .get(input.insightId, input.targetType, input.targetId) as InsightLinkRow;

  return rowToInsightLink(row);
}

export function dbAddInsightComment(input: AddInsightCommentInput): InsightComment {
  const body = input.body.trim();
  if (!body) {
    throw new Error("Comment body is required.");
  }

  const db = ensureDb();
  requireInsight(input.insightId);
  const now = Date.now();
  const id = `inc-${randomUUID().slice(0, 10)}`;

  db.prepare(`
    INSERT INTO insight_comments (
      id,
      insight_id,
      body,
      author_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(id, input.insightId, body, JSON.stringify(input.author), now);

  touchInsight(input.insightId, now);

  const row = db
    .prepare(`
      SELECT *
      FROM insight_comments
      WHERE id = ?
    `)
    .get(id) as InsightCommentRow;

  return rowToInsightComment(row);
}

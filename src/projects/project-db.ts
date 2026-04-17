import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import type {
  CreateProjectInput,
  ProjectDetails,
  ProjectLinkedAssetMatch,
  ProjectLink,
  ProjectListQuery,
  ProjectLinkQuery,
  ProjectRecord,
  ProjectSummary,
  UpdateProjectInput,
  UpsertProjectLinkInput,
} from "./types.js";

interface ProjectRow {
  id: string;
  slug: string;
  title: string;
  status: ProjectRecord["status"];
  summary: string;
  hypothesis: string;
  next_step: string;
  last_signal_at: number;
  owner_agent_id: string | null;
  operator_session_name: string | null;
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ProjectSummaryRow extends ProjectRow {
  link_count: number;
}

interface ProjectLinkRow {
  id: string;
  project_id: string;
  asset_type: ProjectLink["assetType"];
  asset_id: string;
  role: string | null;
  metadata_json: string | null;
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
  created_at: number;
  updated_at: number;
}

let schemaReady = false;
let schemaDbPath: string | null = null;

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

function stringifyMetadata(value?: Record<string, unknown>): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    summary: row.summary,
    hypothesis: row.hypothesis,
    nextStep: row.next_step,
    lastSignalAt: row.last_signal_at,
    ...(row.owner_agent_id ? { ownerAgentId: row.owner_agent_id } : {}),
    ...(row.operator_session_name ? { operatorSessionName: row.operator_session_name } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  return {
    ...rowToProject(row),
    linkCount: row.link_count,
  };
}

function rowToProjectLink(row: ProjectLinkRow): ProjectLink {
  return {
    id: row.id,
    projectId: row.project_id,
    assetType: row.asset_type,
    assetId: row.asset_id,
    ...(row.role ? { role: row.role } : {}),
    ...(parseMetadata(row.metadata_json) ? { metadata: parseMetadata(row.metadata_json) } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureProjectSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) {
    return;
  }

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      next_step TEXT NOT NULL,
      last_signal_at INTEGER NOT NULL,
      owner_agent_id TEXT,
      operator_session_name TEXT,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      role TEXT,
      metadata_json TEXT,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, asset_type, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_projects_status_signal ON projects(status, last_signal_at DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
    CREATE INDEX IF NOT EXISTS idx_project_links_project ON project_links(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_links_asset ON project_links(asset_type, asset_id, updated_at DESC);
  `);

  schemaReady = true;
  schemaDbPath = currentDbPath;
}

function getProjectRow(ref: string): ProjectRow | undefined {
  ensureProjectSchema();
  const normalizedRef = ref.trim();
  const db = getDb();
  return db.prepare("SELECT * FROM projects WHERE id = ? OR slug = ? LIMIT 1").get(normalizedRef, normalizedRef) as
    | ProjectRow
    | undefined;
}

function getProjectLinkRow(
  projectId: string,
  assetType: ProjectLink["assetType"],
  assetId: string,
): ProjectLinkRow | undefined {
  ensureProjectSchema();
  const db = getDb();
  return db
    .prepare(`
      SELECT *
      FROM project_links
      WHERE project_id = ? AND asset_type = ? AND asset_id = ?
      LIMIT 1
    `)
    .get(projectId, assetType, assetId) as ProjectLinkRow | undefined;
}

function listProjectLinkRowsByAsset(assetType: ProjectLink["assetType"], assetId: string): ProjectLinkRow[] {
  ensureProjectSchema();
  const db = getDb();
  return db
    .prepare(
      `
        SELECT *
        FROM project_links
        WHERE asset_type = ? AND asset_id = ?
        ORDER BY
          CASE WHEN role = 'primary' THEN 0 ELSE 1 END,
          updated_at DESC,
          created_at DESC,
          project_id ASC
      `,
    )
    .all(assetType, assetId) as ProjectLinkRow[];
}

function hasOwn<T extends object, K extends keyof T>(value: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function dbCreateProject(input: CreateProjectInput): ProjectRecord {
  ensureProjectSchema();
  const db = getDb();
  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(input.slug) as { id: string } | undefined;
  if (existing) {
    throw new Error(`Project already exists: ${input.slug}`);
  }

  const now = Date.now();
  const id = `proj-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO projects (
      id,
      slug,
      title,
      status,
      summary,
      hypothesis,
      next_step,
      last_signal_at,
      owner_agent_id,
      operator_session_name,
      created_by,
      created_by_agent_id,
      created_by_session_name,
      archived_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.slug,
    input.title,
    input.status ?? "active",
    input.summary,
    input.hypothesis,
    input.nextStep,
    input.lastSignalAt,
    input.ownerAgentId ?? null,
    input.operatorSessionName ?? null,
    input.createdBy ?? null,
    input.createdByAgentId ?? null,
    input.createdBySessionName ?? null,
    input.status === "archived" ? now : null,
    now,
    now,
  );

  return dbGetProject(id)!;
}

export function dbGetProject(ref: string): ProjectRecord | null {
  const row = getProjectRow(ref);
  return row ? rowToProject(row) : null;
}

export function dbListProjects(query: ProjectListQuery = {}): ProjectSummary[] {
  ensureProjectSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string> = [];

  if (query.status) {
    filters.push("p.status = ?");
    params.push(query.status);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(`
      SELECT
        p.*,
        COUNT(l.id) AS link_count
      FROM projects p
      LEFT JOIN project_links l ON l.project_id = p.id
      ${whereClause}
      GROUP BY p.id
      ORDER BY p.last_signal_at DESC, p.updated_at DESC, p.slug ASC
    `)
    .all(...params) as ProjectSummaryRow[];

  return rows.map(rowToProjectSummary);
}

export function dbUpdateProject(ref: string, input: UpdateProjectInput): ProjectRecord {
  ensureProjectSchema();
  const db = getDb();
  const existing = getProjectRow(ref);
  if (!existing) {
    throw new Error(`Project not found: ${ref}`);
  }

  const now = Date.now();
  const nextStatus = input.status ?? existing.status;
  const nextArchivedAt =
    nextStatus === "archived" ? (existing.archived_at ?? now) : input.status ? null : existing.archived_at;
  const nextTitle = input.title ?? existing.title;
  const nextSummary = input.summary ?? existing.summary;
  const nextHypothesis = input.hypothesis ?? existing.hypothesis;
  const nextNextStep = input.nextStep ?? existing.next_step;
  const nextLastSignalAt = input.lastSignalAt ?? existing.last_signal_at;
  const nextOwnerAgentId = hasOwn(input, "ownerAgentId") ? (input.ownerAgentId ?? null) : existing.owner_agent_id;
  const nextOperatorSessionName = hasOwn(input, "operatorSessionName")
    ? (input.operatorSessionName ?? null)
    : existing.operator_session_name;

  db.prepare(`
    UPDATE projects
    SET
      title = ?,
      status = ?,
      summary = ?,
      hypothesis = ?,
      next_step = ?,
      last_signal_at = ?,
      owner_agent_id = ?,
      operator_session_name = ?,
      archived_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    nextTitle,
    nextStatus,
    nextSummary,
    nextHypothesis,
    nextNextStep,
    nextLastSignalAt,
    nextOwnerAgentId,
    nextOperatorSessionName,
    nextArchivedAt,
    now,
    existing.id,
  );

  return dbGetProject(existing.id)!;
}

export function dbListProjectLinks(query: ProjectLinkQuery): ProjectLink[] {
  ensureProjectSchema();
  const project = getProjectRow(query.projectRef);
  if (!project) {
    throw new Error(`Project not found: ${query.projectRef}`);
  }

  const db = getDb();
  const filters = ["project_id = ?"];
  const params: Array<string> = [project.id];
  if (query.assetType) {
    filters.push("asset_type = ?");
    params.push(query.assetType);
  }

  const rows = db
    .prepare(`
      SELECT *
      FROM project_links
      WHERE ${filters.join(" AND ")}
      ORDER BY asset_type ASC, asset_id ASC
    `)
    .all(...params) as ProjectLinkRow[];

  return rows.map(rowToProjectLink);
}

export function dbUpsertProjectLink(input: UpsertProjectLinkInput): ProjectLink {
  ensureProjectSchema();
  const project = getProjectRow(input.projectRef);
  if (!project) {
    throw new Error(`Project not found: ${input.projectRef}`);
  }

  const db = getDb();
  const existing = getProjectLinkRow(project.id, input.assetType, input.assetId);
  if (input.assetType === "workflow") {
    const conflicting = listProjectLinkRowsByAsset(input.assetType, input.assetId).find(
      (row) => row.project_id !== project.id,
    );
    if (conflicting) {
      throw new Error(`Workflow ${input.assetId} already linked to project ${conflicting.project_id}.`);
    }
  }
  const now = Date.now();

  if (input.assetType === "workflow" && input.role === "primary") {
    db.prepare(`
      UPDATE project_links
      SET role = 'support'
      WHERE project_id = ? AND asset_type = 'workflow' AND asset_id <> ? AND role = 'primary'
    `).run(project.id, input.assetId);
  }

  if (existing) {
    db.prepare(`
      UPDATE project_links
      SET
        role = ?,
        metadata_json = ?,
        created_by = COALESCE(?, created_by),
        created_by_agent_id = COALESCE(?, created_by_agent_id),
        created_by_session_name = COALESCE(?, created_by_session_name),
        updated_at = ?
      WHERE id = ?
    `).run(
      input.role ?? null,
      stringifyMetadata(input.metadata),
      input.createdBy ?? null,
      input.createdByAgentId ?? null,
      input.createdBySessionName ?? null,
      now,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO project_links (
        id,
        project_id,
        asset_type,
        asset_id,
        role,
        metadata_json,
        created_by,
        created_by_agent_id,
        created_by_session_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `plink-${randomUUID().slice(0, 8)}`,
      project.id,
      input.assetType,
      input.assetId,
      input.role ?? null,
      stringifyMetadata(input.metadata),
      input.createdBy ?? null,
      input.createdByAgentId ?? null,
      input.createdBySessionName ?? null,
      now,
      now,
    );
  }

  return dbListProjectLinks({
    projectRef: project.id,
    assetType: input.assetType,
  }).find((link) => link.assetId === input.assetId)!;
}

export function dbTouchProjectSignal(ref: string, lastSignalAt: number): ProjectRecord {
  ensureProjectSchema();
  const db = getDb();
  const project = getProjectRow(ref);
  if (!project) {
    throw new Error(`Project not found: ${ref}`);
  }

  const now = Date.now();
  db.prepare(`
    UPDATE projects
    SET last_signal_at = ?, updated_at = ?
    WHERE id = ?
  `).run(lastSignalAt, now, project.id);

  return dbGetProject(project.id)!;
}

export function dbFindProjectByLinkedAsset(
  assetType: ProjectLink["assetType"],
  assetId: string,
): ProjectLinkedAssetMatch | null {
  const row = listProjectLinkRowsByAsset(assetType, assetId)[0];
  if (!row) {
    return null;
  }

  const project = dbGetProject(row.project_id);
  if (!project) {
    return null;
  }

  return {
    project,
    link: rowToProjectLink(row),
  };
}

export function dbGetProjectDetails(ref: string): ProjectDetails | null {
  const project = dbGetProject(ref);
  if (!project) return null;
  return {
    project,
    links: dbListProjectLinks({ projectRef: project.id }),
    linkedWorkflows: [],
    workflowAggregate: null,
    operational: null,
  };
}

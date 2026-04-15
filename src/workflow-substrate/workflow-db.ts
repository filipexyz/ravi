import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import type {
  AddWorkflowTaskInput,
  CreateWorkflowInput,
  RemoveWorkflowTaskInput,
  WorkflowArchiveInput,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowTaskMembership,
} from "./types.js";

interface WorkflowRow {
  id: string;
  title: string;
  summary: string | null;
  status: WorkflowStatus;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
}

interface WorkflowTaskRow {
  workflow_id: string;
  task_id: string;
  node_key: string | null;
  label: string | null;
  created_at: number;
  removed_at: number | null;
  removed_by: string | null;
}

let schemaReady = false;
let schemaDbPath: string | null = null;

function rowToWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
  };
}

function rowToMembership(row: WorkflowTaskRow): WorkflowTaskMembership {
  return {
    workflowId: row.workflow_id,
    taskId: row.task_id,
    ...(row.node_key ? { nodeKey: row.node_key } : {}),
    ...(row.label ? { label: row.label } : {}),
    createdAt: row.created_at,
    ...(typeof row.removed_at === "number" ? { removedAt: row.removed_at } : {}),
    ...(row.removed_by ? { removedBy: row.removed_by } : {}),
  };
}

function normalizeOptionalText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeActor(input?: { actor?: string; sessionName?: string; agentId?: string }): string | null {
  return (
    normalizeOptionalText(input?.actor) ??
    normalizeOptionalText(input?.sessionName) ??
    normalizeOptionalText(input?.agentId)
  );
}

function applyWorkflowSchemaMigrations(): void {
  const db = getDb();
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workflow_tasks)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (columns.size > 0) {
    if (!columns.has("removed_at")) {
      db.exec("ALTER TABLE workflow_tasks ADD COLUMN removed_at INTEGER");
    }
    if (!columns.has("removed_by")) {
      db.exec("ALTER TABLE workflow_tasks ADD COLUMN removed_by TEXT");
    }
  }

  db.exec("DROP INDEX IF EXISTS idx_workflow_tasks_task_unique");
  db.exec("DROP INDEX IF EXISTS idx_workflow_tasks_node_key");
}

function ensureWorkflowSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) {
    return;
  }

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_tasks (
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      node_key TEXT,
      label TEXT,
      created_at INTEGER NOT NULL,
      removed_at INTEGER,
      removed_by TEXT,
      PRIMARY KEY (workflow_id, task_id)
    );
  `);

  applyWorkflowSchemaMigrations();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflows_archived ON workflows(archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_workflow ON workflow_tasks(workflow_id, removed_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_task ON workflow_tasks(task_id, removed_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_tasks_active_task_unique
      ON workflow_tasks(task_id)
      WHERE removed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_tasks_active_node_key
      ON workflow_tasks(workflow_id, node_key)
      WHERE node_key IS NOT NULL AND removed_at IS NULL;
  `);

  schemaReady = true;
  schemaDbPath = currentDbPath;
}

function getWorkflowOrThrow(workflowId: string): WorkflowRecord {
  const workflow = dbGetWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  return workflow;
}

function getMembershipRow(workflowId: string, taskId: string): WorkflowTaskRow | null {
  ensureWorkflowSchema();
  const row = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_tasks
        WHERE workflow_id = ? AND task_id = ?
      `,
    )
    .get(workflowId, taskId) as WorkflowTaskRow | undefined;
  return row ?? null;
}

function getActiveMembershipByTaskId(taskId: string): WorkflowTaskMembership | null {
  ensureWorkflowSchema();
  const row = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_tasks
        WHERE task_id = ?
          AND removed_at IS NULL
      `,
    )
    .get(taskId) as WorkflowTaskRow | undefined;
  return row ? rowToMembership(row) : null;
}

export function dbCreateWorkflow(input: CreateWorkflowInput): WorkflowRecord {
  ensureWorkflowSchema();
  const now = Date.now();
  const id = `wf-${randomUUID()}`;

  getDb()
    .prepare(
      `
        INSERT INTO workflows (
          id, title, summary, status, created_at, updated_at, archived_at, created_by, created_by_agent_id, created_by_session_name
        ) VALUES (?, ?, ?, 'draft', ?, ?, NULL, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.title.trim(),
      normalizeOptionalText(input.summary),
      now,
      now,
      normalizeOptionalText(input.createdBy),
      normalizeOptionalText(input.createdByAgentId),
      normalizeOptionalText(input.createdBySessionName),
    );

  return dbGetWorkflow(id)!;
}

export function dbListWorkflows(options?: { archived?: "exclude" | "include" | "only" }): WorkflowRecord[] {
  ensureWorkflowSchema();
  const archivedMode = options?.archived ?? "exclude";
  const whereClause =
    archivedMode === "only"
      ? "WHERE archived_at IS NOT NULL"
      : archivedMode === "include"
        ? ""
        : "WHERE archived_at IS NULL";
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM workflows
        ${whereClause}
        ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function dbGetWorkflow(workflowId: string): WorkflowRecord | null {
  ensureWorkflowSchema();
  const row = getDb().prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function dbSetWorkflowStatus(workflowId: string, status: WorkflowStatus): WorkflowRecord {
  ensureWorkflowSchema();
  getDb()
    .prepare(
      `
        UPDATE workflows
        SET status = ?,
            updated_at = ?
        WHERE id = ?
      `,
    )
    .run(status, Date.now(), workflowId);
  return getWorkflowOrThrow(workflowId);
}

export function dbArchiveWorkflow(
  workflowId: string,
  _input?: WorkflowArchiveInput,
): { workflow: WorkflowRecord; wasNoop?: boolean } {
  ensureWorkflowSchema();
  const workflow = getWorkflowOrThrow(workflowId);
  if (workflow.archivedAt) {
    return { workflow, wasNoop: true };
  }

  const now = Date.now();
  getDb()
    .prepare(
      `
        UPDATE workflows
        SET status = 'archived',
            archived_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
    )
    .run(now, now, workflowId);
  return { workflow: getWorkflowOrThrow(workflowId) };
}

export function dbUnarchiveWorkflow(
  workflowId: string,
  _input?: WorkflowArchiveInput,
): { workflow: WorkflowRecord; wasNoop?: boolean } {
  ensureWorkflowSchema();
  const workflow = getWorkflowOrThrow(workflowId);
  if (!workflow.archivedAt) {
    return { workflow, wasNoop: true };
  }

  getDb()
    .prepare(
      `
        UPDATE workflows
        SET archived_at = NULL,
            status = 'draft',
            updated_at = ?
        WHERE id = ?
      `,
    )
    .run(Date.now(), workflowId);
  return { workflow: getWorkflowOrThrow(workflowId) };
}

export function dbListWorkflowMemberships(workflowId: string): WorkflowTaskMembership[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_tasks
        WHERE workflow_id = ?
        ORDER BY created_at ASC, task_id ASC
      `,
    )
    .all(workflowId) as WorkflowTaskRow[];
  return rows.map(rowToMembership);
}

export function dbAddTaskToWorkflow(
  workflowId: string,
  taskId: string,
  input: AddWorkflowTaskInput = {},
): { membership: WorkflowTaskMembership; wasNoop?: boolean } {
  ensureWorkflowSchema();
  getWorkflowOrThrow(workflowId);

  const activeMembership = getActiveMembershipByTaskId(taskId);
  if (activeMembership) {
    if (activeMembership.workflowId === workflowId) {
      return {
        membership: activeMembership,
        wasNoop: true,
      };
    }
    throw new Error(`Task ${taskId} already belongs to workflow ${activeMembership.workflowId}.`);
  }

  const nodeKey = normalizeOptionalText(input.nodeKey);
  if (nodeKey) {
    const conflictingNode = getDb()
      .prepare(
        `
          SELECT task_id
          FROM workflow_tasks
          WHERE workflow_id = ?
            AND node_key = ?
            AND removed_at IS NULL
        `,
      )
      .get(workflowId, nodeKey) as { task_id: string } | undefined;
    if (conflictingNode && conflictingNode.task_id !== taskId) {
      throw new Error(`Workflow ${workflowId} already uses node key ${nodeKey}.`);
    }
  }

  const existingPair = getMembershipRow(workflowId, taskId);
  const now = Date.now();
  if (existingPair) {
    getDb()
      .prepare(
        `
          UPDATE workflow_tasks
          SET node_key = ?,
              label = ?,
              removed_at = NULL,
              removed_by = NULL
          WHERE workflow_id = ? AND task_id = ?
        `,
      )
      .run(
        nodeKey ?? existingPair.node_key,
        normalizeOptionalText(input.label) ?? existingPair.label,
        workflowId,
        taskId,
      );
  } else {
    getDb()
      .prepare(
        `
          INSERT INTO workflow_tasks (
            workflow_id, task_id, node_key, label, created_at, removed_at, removed_by
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
        `,
      )
      .run(workflowId, taskId, nodeKey, normalizeOptionalText(input.label), now);
  }

  getDb()
    .prepare(
      `
        UPDATE workflows
        SET updated_at = ?
        WHERE id = ?
      `,
    )
    .run(now, workflowId);

  return {
    membership: rowToMembership(getMembershipRow(workflowId, taskId)!),
  };
}

export function dbRemoveTaskFromWorkflow(
  workflowId: string,
  taskId: string,
  input: RemoveWorkflowTaskInput = {},
): { membership: WorkflowTaskMembership | null; wasNoop?: boolean } {
  ensureWorkflowSchema();
  getWorkflowOrThrow(workflowId);
  const existing = getMembershipRow(workflowId, taskId);
  if (!existing || typeof existing.removed_at === "number") {
    return {
      membership: existing ? rowToMembership(existing) : null,
      wasNoop: true,
    };
  }

  const now = Date.now();
  getDb()
    .prepare(
      `
        UPDATE workflow_tasks
        SET removed_at = ?,
            removed_by = ?
        WHERE workflow_id = ? AND task_id = ?
      `,
    )
    .run(now, normalizeActor(input), workflowId, taskId);
  getDb()
    .prepare(
      `
        UPDATE workflows
        SET updated_at = ?
        WHERE id = ?
      `,
    )
    .run(now, workflowId);

  return {
    membership: rowToMembership(getMembershipRow(workflowId, taskId)!),
  };
}

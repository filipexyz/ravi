import { randomUUID } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import type {
  CreateWorkflowSpecInput,
  TaskWorkflowSurface,
  StartWorkflowRunInput,
  WorkflowNodeRun,
  WorkflowNodeRunTaskAttempt,
  WorkflowRun,
  WorkflowRunEdge,
  WorkflowSpec,
} from "./types.js";

interface WorkflowSpecRow {
  id: string;
  title: string;
  summary: string | null;
  policy_json: string;
  nodes_json: string;
  edges_json: string;
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowRunRow {
  id: string;
  workflow_spec_id: string;
  title: string;
  summary: string | null;
  policy_json: string;
  status: WorkflowRun["status"];
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  started_at: number;
  completed_at: number | null;
}

interface WorkflowNodeRunRow {
  id: string;
  workflow_run_id: string;
  spec_node_key: string;
  label: string;
  node_kind: WorkflowNodeRun["kind"];
  requirement: WorkflowNodeRun["requirement"];
  release_mode: WorkflowNodeRun["releaseMode"];
  status: WorkflowNodeRun["status"];
  waiting_on_node_keys_json: string;
  current_task_id: string | null;
  attempt_count: number;
  released_at: number | null;
  released_by: string | null;
  released_by_agent_id: string | null;
  released_by_session_name: string | null;
  ready_at: number | null;
  blocked_at: number | null;
  completed_at: number | null;
  skipped_at: number | null;
  cancelled_at: number | null;
  archived_at: number | null;
  last_task_transition_at: number | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowRunEdgeRow {
  workflow_run_id: string;
  from_node_run_id: string;
  to_node_run_id: string;
  created_at: number;
}

interface WorkflowNodeRunTaskAttemptRow {
  workflow_node_run_id: string;
  task_id: string;
  attempt: number;
  created_at: number;
}

interface TaskWorkflowSurfaceRow {
  task_id: string;
  workflow_run_id: string;
  workflow_run_title: string;
  workflow_run_status: WorkflowRun["status"];
  workflow_spec_id: string;
  workflow_spec_title: string;
  workflow_node_run_id: string;
  spec_node_key: string;
  label: string;
  node_kind: WorkflowNodeRun["kind"];
  requirement: WorkflowNodeRun["requirement"];
  release_mode: WorkflowNodeRun["releaseMode"];
  node_status: WorkflowNodeRun["status"];
  waiting_on_node_keys_json: string;
  current_task_id: string | null;
  attempt_count: number;
  current_task_attempt: number | null;
}

let schemaReady = false;
let schemaDbPath: string | null = null;

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends object>(raw: string): T {
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

function rowToWorkflowSpec(row: WorkflowSpecRow): WorkflowSpec {
  return {
    id: row.id,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    policy: parseJsonObject(row.policy_json),
    nodes: parseJsonArray(row.nodes_json),
    edges: parseJsonArray(row.edges_json),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowSpecId: row.workflow_spec_id,
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    policy: parseJsonObject(row.policy_json),
    status: row.status,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    ...(typeof row.completed_at === "number" ? { completedAt: row.completed_at } : {}),
  };
}

function rowToWorkflowNodeRun(row: WorkflowNodeRunRow): WorkflowNodeRun {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    specNodeKey: row.spec_node_key,
    label: row.label,
    kind: row.node_kind,
    requirement: row.requirement,
    releaseMode: row.release_mode,
    status: row.status,
    waitingOnNodeKeys: parseJsonArray<string>(row.waiting_on_node_keys_json),
    ...(row.current_task_id ? { currentTaskId: row.current_task_id } : {}),
    attemptCount: row.attempt_count,
    ...(typeof row.released_at === "number" ? { releasedAt: row.released_at } : {}),
    ...(row.released_by ? { releasedBy: row.released_by } : {}),
    ...(row.released_by_agent_id ? { releasedByAgentId: row.released_by_agent_id } : {}),
    ...(row.released_by_session_name ? { releasedBySessionName: row.released_by_session_name } : {}),
    ...(typeof row.ready_at === "number" ? { readyAt: row.ready_at } : {}),
    ...(typeof row.blocked_at === "number" ? { blockedAt: row.blocked_at } : {}),
    ...(typeof row.completed_at === "number" ? { completedAt: row.completed_at } : {}),
    ...(typeof row.skipped_at === "number" ? { skippedAt: row.skipped_at } : {}),
    ...(typeof row.cancelled_at === "number" ? { cancelledAt: row.cancelled_at } : {}),
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    ...(typeof row.last_task_transition_at === "number" ? { lastTaskTransitionAt: row.last_task_transition_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkflowRunEdge(row: WorkflowRunEdgeRow): WorkflowRunEdge {
  return {
    workflowRunId: row.workflow_run_id,
    fromNodeRunId: row.from_node_run_id,
    toNodeRunId: row.to_node_run_id,
    createdAt: row.created_at,
  };
}

function rowToWorkflowNodeRunTaskAttempt(row: WorkflowNodeRunTaskAttemptRow): WorkflowNodeRunTaskAttempt {
  return {
    workflowNodeRunId: row.workflow_node_run_id,
    taskId: row.task_id,
    attempt: row.attempt,
    createdAt: row.created_at,
  };
}

function rowToTaskWorkflowSurface(row: TaskWorkflowSurfaceRow): TaskWorkflowSurface {
  return {
    workflowRunId: row.workflow_run_id,
    workflowRunTitle: row.workflow_run_title,
    workflowRunStatus: row.workflow_run_status,
    workflowSpecId: row.workflow_spec_id,
    workflowSpecTitle: row.workflow_spec_title,
    workflowNodeRunId: row.workflow_node_run_id,
    nodeKey: row.spec_node_key,
    nodeLabel: row.label,
    nodeKind: row.node_kind,
    nodeRequirement: row.requirement,
    nodeReleaseMode: row.release_mode,
    nodeStatus: row.node_status,
    waitingOnNodeKeys: parseJsonArray<string>(row.waiting_on_node_keys_json),
    currentTaskId: row.current_task_id ?? null,
    currentTaskAttempt: typeof row.current_task_attempt === "number" ? row.current_task_attempt : null,
    attemptCount: row.attempt_count,
    isCurrentTask: row.current_task_id === row.task_id,
  };
}

function ensureWorkflowSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) {
    return;
  }

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_specs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      policy_json TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_spec_id TEXT NOT NULL REFERENCES workflow_specs(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      summary TEXT,
      policy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workflow_node_runs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      spec_node_key TEXT NOT NULL,
      label TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      requirement TEXT NOT NULL,
      release_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      waiting_on_node_keys_json TEXT NOT NULL,
      current_task_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      released_at INTEGER,
      released_by TEXT,
      released_by_agent_id TEXT,
      released_by_session_name TEXT,
      ready_at INTEGER,
      blocked_at INTEGER,
      completed_at INTEGER,
      skipped_at INTEGER,
      cancelled_at INTEGER,
      archived_at INTEGER,
      last_task_transition_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workflow_run_id, spec_node_key)
    );

    CREATE TABLE IF NOT EXISTS workflow_run_edges (
      workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      from_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
      to_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workflow_run_id, from_node_run_id, to_node_run_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_node_run_tasks (
      workflow_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workflow_node_run_id, attempt),
      UNIQUE(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated ON workflow_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_run_status ON workflow_node_runs(workflow_run_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_current_task ON workflow_node_runs(current_task_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_run_tasks_task ON workflow_node_run_tasks(task_id);
  `);

  schemaReady = true;
  schemaDbPath = currentDbPath;
}

export function dbCreateWorkflowSpec(input: CreateWorkflowSpecInput): WorkflowSpec {
  ensureWorkflowSchema();
  const db = getDb();
  const now = Date.now();
  const id = input.id?.trim() || `wf-spec-${randomUUID()}`;
  db.prepare(
    `
      INSERT INTO workflow_specs (
        id, title, summary, policy_json, nodes_json, edges_json,
        created_by, created_by_agent_id, created_by_session_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.title,
    input.summary ?? null,
    JSON.stringify(input.policy ?? {}),
    JSON.stringify(input.nodes),
    JSON.stringify(input.edges ?? []),
    input.createdBy ?? null,
    input.createdByAgentId ?? null,
    input.createdBySessionName ?? null,
    now,
    now,
  );

  return dbGetWorkflowSpec(id)!;
}

export function dbGetWorkflowSpec(id: string): WorkflowSpec | null {
  ensureWorkflowSchema();
  const row = getDb().prepare("SELECT * FROM workflow_specs WHERE id = ?").get(id) as WorkflowSpecRow | undefined;
  return row ? rowToWorkflowSpec(row) : null;
}

export function dbListWorkflowSpecs(): WorkflowSpec[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare("SELECT * FROM workflow_specs ORDER BY updated_at DESC, id ASC")
    .all() as WorkflowSpecRow[];
  return rows.map(rowToWorkflowSpec);
}

export function dbCreateWorkflowRun(spec: WorkflowSpec, input: StartWorkflowRunInput = {}): WorkflowRun {
  ensureWorkflowSchema();
  const now = Date.now();
  const runId = input.runId?.trim() || `wf-run-${randomUUID()}`;
  const db = getDb();
  db.prepare(
    `
      INSERT INTO workflow_runs (
        id, workflow_spec_id, title, summary, policy_json, status,
        created_by, created_by_agent_id, created_by_session_name,
        created_at, updated_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    runId,
    spec.id,
    spec.title,
    spec.summary ?? null,
    JSON.stringify(spec.policy ?? {}),
    "draft",
    input.createdBy ?? null,
    input.createdByAgentId ?? null,
    input.createdBySessionName ?? null,
    now,
    now,
    now,
  );

  return dbGetWorkflowRun(runId)!;
}

export function dbGetWorkflowRun(id: string): WorkflowRun | null {
  ensureWorkflowSchema();
  const row = getDb().prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as WorkflowRunRow | undefined;
  return row ? rowToWorkflowRun(row) : null;
}

export function dbListWorkflowRuns(): WorkflowRun[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare("SELECT * FROM workflow_runs ORDER BY updated_at DESC, id ASC")
    .all() as WorkflowRunRow[];
  return rows.map(rowToWorkflowRun);
}

export function dbInsertWorkflowNodeRuns(nodeRuns: Array<Omit<WorkflowNodeRun, "createdAt" | "updatedAt">>): void {
  ensureWorkflowSchema();
  const db = getDb();
  const stmt = db.prepare(
    `
      INSERT INTO workflow_node_runs (
        id, workflow_run_id, spec_node_key, label, node_kind, requirement, release_mode,
        status, waiting_on_node_keys_json, current_task_id, attempt_count, released_at,
        released_by, released_by_agent_id, released_by_session_name, ready_at, blocked_at,
        completed_at, skipped_at, cancelled_at, archived_at, last_task_transition_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const now = Date.now();
  const insertMany = db.transaction(() => {
    for (const nodeRun of nodeRuns) {
      stmt.run(
        nodeRun.id,
        nodeRun.workflowRunId,
        nodeRun.specNodeKey,
        nodeRun.label,
        nodeRun.kind,
        nodeRun.requirement,
        nodeRun.releaseMode,
        nodeRun.status,
        JSON.stringify(nodeRun.waitingOnNodeKeys),
        nodeRun.currentTaskId ?? null,
        nodeRun.attemptCount,
        nodeRun.releasedAt ?? null,
        nodeRun.releasedBy ?? null,
        nodeRun.releasedByAgentId ?? null,
        nodeRun.releasedBySessionName ?? null,
        nodeRun.readyAt ?? null,
        nodeRun.blockedAt ?? null,
        nodeRun.completedAt ?? null,
        nodeRun.skippedAt ?? null,
        nodeRun.cancelledAt ?? null,
        nodeRun.archivedAt ?? null,
        nodeRun.lastTaskTransitionAt ?? null,
        now,
        now,
      );
    }
  });
  insertMany();
}

export function dbInsertWorkflowRunEdges(edges: WorkflowRunEdge[]): void {
  ensureWorkflowSchema();
  const db = getDb();
  const stmt = db.prepare(
    `
      INSERT INTO workflow_run_edges (workflow_run_id, from_node_run_id, to_node_run_id, created_at)
      VALUES (?, ?, ?, ?)
    `,
  );
  const insertMany = db.transaction(() => {
    for (const edge of edges) {
      stmt.run(edge.workflowRunId, edge.fromNodeRunId, edge.toNodeRunId, edge.createdAt);
    }
  });
  insertMany();
}

export function dbListWorkflowNodeRuns(workflowRunId: string): WorkflowNodeRun[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_node_runs
        WHERE workflow_run_id = ?
        ORDER BY created_at ASC, spec_node_key ASC
      `,
    )
    .all(workflowRunId) as WorkflowNodeRunRow[];
  return rows.map(rowToWorkflowNodeRun);
}

export function dbGetWorkflowNodeRun(nodeRunId: string): WorkflowNodeRun | null {
  ensureWorkflowSchema();
  const row = getDb().prepare("SELECT * FROM workflow_node_runs WHERE id = ?").get(nodeRunId) as
    | WorkflowNodeRunRow
    | undefined;
  return row ? rowToWorkflowNodeRun(row) : null;
}

export function dbGetWorkflowNodeRunByKey(workflowRunId: string, nodeKey: string): WorkflowNodeRun | null {
  ensureWorkflowSchema();
  const row = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_node_runs
        WHERE workflow_run_id = ? AND spec_node_key = ?
      `,
    )
    .get(workflowRunId, nodeKey) as WorkflowNodeRunRow | undefined;
  return row ? rowToWorkflowNodeRun(row) : null;
}

export function dbGetWorkflowNodeRunByTaskId(taskId: string): WorkflowNodeRun | null {
  ensureWorkflowSchema();
  const row = getDb()
    .prepare(
      `
        SELECT nr.*
        FROM workflow_node_run_tasks AS att
        JOIN workflow_node_runs AS nr
          ON nr.id = att.workflow_node_run_id
        WHERE att.task_id = ?
      `,
    )
    .get(taskId) as WorkflowNodeRunRow | undefined;
  return row ? rowToWorkflowNodeRun(row) : null;
}

export function dbGetTaskWorkflowSurface(taskId: string): TaskWorkflowSurface | null {
  ensureWorkflowSchema();
  const row = getDb()
    .prepare(
      `
        SELECT
          att.task_id,
          nr.workflow_run_id,
          wr.title AS workflow_run_title,
          wr.status AS workflow_run_status,
          wr.workflow_spec_id,
          ws.title AS workflow_spec_title,
          nr.id AS workflow_node_run_id,
          nr.spec_node_key,
          nr.label,
          nr.node_kind,
          nr.requirement,
          nr.release_mode,
          nr.status AS node_status,
          nr.waiting_on_node_keys_json,
          nr.current_task_id,
          nr.attempt_count,
          att.attempt AS current_task_attempt
        FROM workflow_node_run_tasks AS att
        JOIN workflow_node_runs AS nr
          ON nr.id = att.workflow_node_run_id
        JOIN workflow_runs AS wr
          ON wr.id = nr.workflow_run_id
        JOIN workflow_specs AS ws
          ON ws.id = wr.workflow_spec_id
        WHERE att.task_id = ?
      `,
    )
    .get(taskId) as TaskWorkflowSurfaceRow | undefined;
  return row ? rowToTaskWorkflowSurface(row) : null;
}

export function dbListWorkflowRunEdges(workflowRunId: string): WorkflowRunEdge[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_run_edges
        WHERE workflow_run_id = ?
        ORDER BY created_at ASC, from_node_run_id ASC, to_node_run_id ASC
      `,
    )
    .all(workflowRunId) as WorkflowRunEdgeRow[];
  return rows.map(rowToWorkflowRunEdge);
}

export function dbListWorkflowNodeRunTaskAttempts(nodeRunId: string): WorkflowNodeRunTaskAttempt[] {
  ensureWorkflowSchema();
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM workflow_node_run_tasks
        WHERE workflow_node_run_id = ?
        ORDER BY attempt ASC
      `,
    )
    .all(nodeRunId) as WorkflowNodeRunTaskAttemptRow[];
  return rows.map(rowToWorkflowNodeRunTaskAttempt);
}

export function dbLinkTaskToWorkflowNodeRun(nodeRunId: string, taskId: string): WorkflowNodeRunTaskAttempt {
  ensureWorkflowSchema();
  const db = getDb();
  const nodeRun = dbGetWorkflowNodeRun(nodeRunId);
  if (!nodeRun) {
    throw new Error(`Workflow node run not found: ${nodeRunId}`);
  }

  const existing = getDb().prepare("SELECT * FROM workflow_node_run_tasks WHERE task_id = ?").get(taskId) as
    | WorkflowNodeRunTaskAttemptRow
    | undefined;
  if (existing) {
    throw new Error(`Task ${taskId} already belongs to workflow node run ${existing.workflow_node_run_id}.`);
  }

  const attempt = nodeRun.attemptCount + 1;
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO workflow_node_run_tasks (workflow_node_run_id, task_id, attempt, created_at)
      VALUES (?, ?, ?, ?)
    `,
  ).run(nodeRunId, taskId, attempt, now);
  db.prepare(
    `
      UPDATE workflow_node_runs
      SET current_task_id = ?, attempt_count = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(taskId, attempt, now, nodeRunId);

  return {
    workflowNodeRunId: nodeRunId,
    taskId,
    attempt,
    createdAt: now,
  };
}

type WorkflowRunPatch = Partial<
  Pick<WorkflowRun, "status" | "completedAt" | "archivedAt"> & {
    title: string;
    summary: string | null;
    policyJson: string;
  }
>;

type WorkflowNodeRunPatch = Partial<
  Pick<
    WorkflowNodeRun,
    | "status"
    | "waitingOnNodeKeys"
    | "currentTaskId"
    | "attemptCount"
    | "releasedAt"
    | "releasedBy"
    | "releasedByAgentId"
    | "releasedBySessionName"
    | "readyAt"
    | "blockedAt"
    | "completedAt"
    | "skippedAt"
    | "cancelledAt"
    | "archivedAt"
    | "lastTaskTransitionAt"
  >
>;

function runWorkflowUpdate(
  table: "workflow_runs" | "workflow_node_runs",
  idColumn: string,
  idValue: string,
  fields: Record<string, unknown>,
) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }
  const now = Date.now();
  const assignments = entries.map(([key]) => `${key} = ?`);
  assignments.push("updated_at = ?");
  const values: SQLQueryBindings[] = entries.map(([, value]) => value as SQLQueryBindings);
  values.push(now, idValue);
  getDb()
    .prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${idColumn} = ?`)
    .run(...values);
}

export function dbUpdateWorkflowRun(runId: string, patch: WorkflowRunPatch): WorkflowRun {
  ensureWorkflowSchema();
  runWorkflowUpdate("workflow_runs", "id", runId, {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.completedAt !== undefined ? { completed_at: patch.completedAt ?? null } : {}),
    ...(patch.archivedAt !== undefined ? { archived_at: patch.archivedAt ?? null } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.policyJson !== undefined ? { policy_json: patch.policyJson } : {}),
  });
  return dbGetWorkflowRun(runId)!;
}

export function dbUpdateWorkflowNodeRun(nodeRunId: string, patch: WorkflowNodeRunPatch): WorkflowNodeRun {
  ensureWorkflowSchema();
  runWorkflowUpdate("workflow_node_runs", "id", nodeRunId, {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.waitingOnNodeKeys !== undefined
      ? { waiting_on_node_keys_json: JSON.stringify(patch.waitingOnNodeKeys) }
      : {}),
    ...(patch.currentTaskId !== undefined ? { current_task_id: patch.currentTaskId ?? null } : {}),
    ...(patch.attemptCount !== undefined ? { attempt_count: patch.attemptCount } : {}),
    ...(patch.releasedAt !== undefined ? { released_at: patch.releasedAt ?? null } : {}),
    ...(patch.releasedBy !== undefined ? { released_by: patch.releasedBy ?? null } : {}),
    ...(patch.releasedByAgentId !== undefined ? { released_by_agent_id: patch.releasedByAgentId ?? null } : {}),
    ...(patch.releasedBySessionName !== undefined
      ? { released_by_session_name: patch.releasedBySessionName ?? null }
      : {}),
    ...(patch.readyAt !== undefined ? { ready_at: patch.readyAt ?? null } : {}),
    ...(patch.blockedAt !== undefined ? { blocked_at: patch.blockedAt ?? null } : {}),
    ...(patch.completedAt !== undefined ? { completed_at: patch.completedAt ?? null } : {}),
    ...(patch.skippedAt !== undefined ? { skipped_at: patch.skippedAt ?? null } : {}),
    ...(patch.cancelledAt !== undefined ? { cancelled_at: patch.cancelledAt ?? null } : {}),
    ...(patch.archivedAt !== undefined ? { archived_at: patch.archivedAt ?? null } : {}),
    ...(patch.lastTaskTransitionAt !== undefined
      ? { last_task_transition_at: patch.lastTaskTransitionAt ?? null }
      : {}),
  });
  return dbGetWorkflowNodeRun(nodeRunId)!;
}

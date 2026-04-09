import { randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import type {
  CreateTaskInput,
  DispatchTaskInput,
  ListTasksOptions,
  TaskAssignment,
  TaskEvent,
  TaskProgressInput,
  TaskRecord,
  TaskTerminalInput,
  TaskWorktreeConfig,
} from "./types.js";

interface TaskRow {
  id: string;
  title: string;
  instructions: string;
  status: TaskRecord["status"];
  priority: TaskRecord["priority"];
  progress: number;
  parent_task_id: string | null;
  task_dir: string | null;
  created_by: string | null;
  created_by_agent_id: string | null;
  created_by_session_name: string | null;
  assignee_agent_id: string | null;
  assignee_session_name: string | null;
  worktree_mode: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  summary: string | null;
  blocker_reason: string | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
  started_at: number | null;
  completed_at: number | null;
}

interface TaskAssignmentRow {
  id: string;
  task_id: string;
  agent_id: string;
  session_name: string;
  assigned_by: string | null;
  worktree_mode: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  status: TaskAssignment["status"];
  assigned_at: number;
  accepted_at: number | null;
  completed_at: number | null;
}

interface TaskEventRow {
  id: number;
  task_id: string;
  type: TaskEvent["type"];
  actor: string | null;
  agent_id: string | null;
  session_name: string | null;
  message: string | null;
  progress: number | null;
  related_task_id: string | null;
  created_at: number;
}

let schemaReady = false;

function applyTaskWorktreeSchemaMigrations(): void {
  const db = getDb();
  const taskColumns = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!taskColumns.has("worktree_mode")) {
    db.exec("ALTER TABLE tasks ADD COLUMN worktree_mode TEXT");
  }
  if (!taskColumns.has("worktree_path")) {
    db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
  }
  if (!taskColumns.has("worktree_branch")) {
    db.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
  }
  if (!taskColumns.has("created_by_agent_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN created_by_agent_id TEXT");
  }
  if (!taskColumns.has("created_by_session_name")) {
    db.exec("ALTER TABLE tasks ADD COLUMN created_by_session_name TEXT");
  }
  if (!taskColumns.has("parent_task_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
  }
  if (!taskColumns.has("task_dir")) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_dir TEXT");
  }

  const assignmentColumns = new Set(
    (db.prepare("PRAGMA table_info(task_assignments)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!assignmentColumns.has("worktree_mode")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN worktree_mode TEXT");
  }
  if (!assignmentColumns.has("worktree_path")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN worktree_path TEXT");
  }
  if (!assignmentColumns.has("worktree_branch")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN worktree_branch TEXT");
  }

  const eventColumns = new Set(
    (db.prepare("PRAGMA table_info(task_events)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!eventColumns.has("related_task_id")) {
    db.exec("ALTER TABLE task_events ADD COLUMN related_task_id TEXT");
  }
}

function ensureTaskSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      progress INTEGER NOT NULL DEFAULT 0,
      parent_task_id TEXT,
      task_dir TEXT,
      created_by TEXT,
      created_by_agent_id TEXT,
      created_by_session_name TEXT,
      assignee_agent_id TEXT,
      assignee_session_name TEXT,
      worktree_mode TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      summary TEXT,
      blocker_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      assigned_by TEXT,
      worktree_mode TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      status TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      accepted_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT,
      agent_id TEXT,
      session_name TEXT,
      message TEXT,
      progress INTEGER,
      related_task_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_agent ON tasks(assignee_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_session ON tasks(assignee_session_name);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id, assigned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at ASC);
  `);
  applyTaskWorktreeSchemaMigrations();
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, updated_at DESC)");
  schemaReady = true;
}

function rowToWorktree(
  mode: string | null,
  path: string | null,
  branch: string | null,
): TaskWorktreeConfig | undefined {
  if (mode !== "inherit" && mode !== "path") {
    return undefined;
  }

  return {
    mode,
    ...(path ? { path } : {}),
    ...(branch ? { branch } : {}),
  };
}

function worktreeToColumns(worktree?: TaskWorktreeConfig): [string | null, string | null, string | null] {
  return [worktree?.mode ?? null, worktree?.path ?? null, worktree?.branch ?? null];
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.task_dir ? { taskDir: row.task_dir } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.created_by_agent_id ? { createdByAgentId: row.created_by_agent_id } : {}),
    ...(row.created_by_session_name ? { createdBySessionName: row.created_by_session_name } : {}),
    ...(row.assignee_agent_id ? { assigneeAgentId: row.assignee_agent_id } : {}),
    ...(row.assignee_session_name ? { assigneeSessionName: row.assignee_session_name } : {}),
    ...(rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch)
      ? { worktree: rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch) }
      : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.blocker_reason ? { blockerReason: row.blocker_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function rowToAssignment(row: TaskAssignmentRow): TaskAssignment {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionName: row.session_name,
    ...(row.assigned_by ? { assignedBy: row.assigned_by } : {}),
    ...(rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch)
      ? { worktree: rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch) }
      : {}),
    status: row.status,
    assignedAt: row.assigned_at,
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function rowToEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.session_name ? { sessionName: row.session_name } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(typeof row.progress === "number" ? { progress: row.progress } : {}),
    ...(row.related_task_id ? { relatedTaskId: row.related_task_id } : {}),
    createdAt: row.created_at,
  };
}

function getTaskOrThrow(id: string): TaskRecord {
  const task = dbGetTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  return task;
}

function appendTaskEvent(
  taskId: string,
  type: TaskEvent["type"],
  input: {
    actor?: string;
    agentId?: string;
    sessionName?: string;
    message?: string;
    progress?: number;
    relatedTaskId?: string;
  },
): TaskEvent {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();
  const statement = db.prepare(`
    INSERT INTO task_events (
      task_id, type, actor, agent_id, session_name, message, progress, related_task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  statement.run(
    taskId,
    type,
    input.actor ?? null,
    input.agentId ?? null,
    input.sessionName ?? null,
    input.message ?? null,
    typeof input.progress === "number" ? Math.max(0, Math.min(100, Math.round(input.progress))) : null,
    input.relatedTaskId ?? null,
    now,
  );
  const row = db.prepare("SELECT * FROM task_events WHERE id = last_insert_rowid()").get() as TaskEventRow | undefined;
  if (!row) {
    throw new Error(`Failed to append task event for ${taskId}`);
  }
  return rowToEvent(row);
}

function markActiveAssignmentAccepted(taskId: string, sessionName?: string): void {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();
  if (sessionName) {
    db.prepare(`
      UPDATE task_assignments
      SET status = CASE WHEN status = 'assigned' THEN 'accepted' ELSE status END,
          accepted_at = COALESCE(accepted_at, ?)
      WHERE task_id = ? AND session_name = ? AND status IN ('assigned', 'accepted')
    `).run(now, taskId, sessionName);
    return;
  }

  db.prepare(`
    UPDATE task_assignments
    SET status = CASE WHEN status = 'assigned' THEN 'accepted' ELSE status END,
        accepted_at = COALESCE(accepted_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted')
  `).run(now, taskId);
}

export function dbCreateTask(input: CreateTaskInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const id = `task-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const [worktreeMode, worktreePath, worktreeBranch] = worktreeToColumns(input.worktree);

  db.prepare(`
    INSERT INTO tasks (
      id, title, instructions, status, priority, progress, parent_task_id, task_dir, created_by, created_by_agent_id,
      created_by_session_name, worktree_mode, worktree_path, worktree_branch, created_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title,
    input.instructions,
    input.priority ?? "normal",
    input.parentTaskId ?? null,
    input.createdBy ?? null,
    input.createdByAgentId ?? null,
    input.createdBySessionName ?? null,
    worktreeMode,
    worktreePath,
    worktreeBranch,
    now,
    now,
  );

  const event = appendTaskEvent(id, "task.created", {
    actor: input.createdBy,
    message: input.title,
    progress: 0,
  });
  return { task: getTaskOrThrow(id), event };
}

export function dbSetTaskDir(taskId: string, taskDir: string): TaskRecord {
  ensureTaskSchema();
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET task_dir = ?
    WHERE id = ?
  `).run(taskDir, taskId);
  return getTaskOrThrow(taskId);
}

export function dbGetTask(id: string): TaskRecord | null {
  ensureTaskSchema();
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function dbListTasks(options: ListTasksOptions = {}): TaskRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string> = [];

  if (options.status) {
    filters.push("status = ?");
    params.push(options.status);
  }
  if (options.agentId) {
    filters.push("assignee_agent_id = ?");
    params.push(options.agentId);
  }
  if (options.sessionName) {
    filters.push("assignee_session_name = ?");
    params.push(options.sessionName);
  }
  if (options.parentTaskId) {
    filters.push("parent_task_id = ?");
    params.push(options.parentTaskId);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`).all(...params) as TaskRow[];
  return rows.map(rowToTask);
}

export function dbListChildTasks(parentTaskId: string): TaskRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC")
    .all(parentTaskId) as TaskRow[];
  return rows.map(rowToTask);
}

export function dbHasActiveTaskForSession(sessionName: string, excludeTaskId?: string): boolean {
  ensureTaskSchema();
  const db = getDb();
  const row = excludeTaskId
    ? (db
        .prepare(`
          SELECT 1
          FROM tasks
          WHERE assignee_session_name = ?
            AND status IN ('dispatched', 'in_progress', 'blocked')
            AND id != ?
          LIMIT 1
        `)
        .get(sessionName, excludeTaskId) as { 1: number } | undefined)
    : (db
        .prepare(`
          SELECT 1
          FROM tasks
          WHERE assignee_session_name = ?
            AND status IN ('dispatched', 'in_progress', 'blocked')
          LIMIT 1
        `)
        .get(sessionName) as { 1: number } | undefined);
  return Boolean(row);
}

export function dbListTaskEvents(taskId: string, limit = 100): TaskEvent[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(taskId, limit) as TaskEventRow[];
  return rows.map(rowToEvent);
}

export function dbGetActiveAssignment(taskId: string): TaskAssignment | null {
  ensureTaskSchema();
  const db = getDb();
  const row = db
    .prepare(`
      SELECT * FROM task_assignments
      WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
      ORDER BY assigned_at DESC
      LIMIT 1
    `)
    .get(taskId) as TaskAssignmentRow | undefined;
  return row ? rowToAssignment(row) : null;
}

export function dbListAssignments(taskId: string): TaskAssignment[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM task_assignments WHERE task_id = ? ORDER BY assigned_at DESC")
    .all(taskId) as TaskAssignmentRow[];
  return rows.map(rowToAssignment);
}

export function dbDispatchTask(
  taskId: string,
  input: DispatchTaskInput,
): { task: TaskRecord; assignment: TaskAssignment; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();
  const [worktreeMode, worktreePath, worktreeBranch] = worktreeToColumns(input.worktree);
  getTaskOrThrow(taskId);

  db.prepare(`
    UPDATE task_assignments
    SET status = 'superseded', completed_at = COALESCE(completed_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, taskId);

  const assignmentId = `asg-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO task_assignments (
      id, task_id, agent_id, session_name, assigned_by, worktree_mode, worktree_path, worktree_branch, status, assigned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?)
  `).run(
    assignmentId,
    taskId,
    input.agentId,
    input.sessionName,
    input.assignedBy ?? null,
    worktreeMode,
    worktreePath,
    worktreeBranch,
    now,
  );

  db.prepare(`
    UPDATE tasks
    SET status = 'dispatched',
        assignee_agent_id = ?,
        assignee_session_name = ?,
        dispatched_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(input.agentId, input.sessionName, now, now, taskId);

  const event = appendTaskEvent(taskId, "task.dispatched", {
    actor: input.assignedBy,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: `Dispatched to ${input.agentId}/${input.sessionName}`,
    progress: 0,
  });

  return {
    task: getTaskOrThrow(taskId),
    assignment: dbGetActiveAssignment(taskId)!,
    event,
  };
}

export function dbReportTaskProgress(taskId: string, input: TaskProgressInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const task = getTaskOrThrow(taskId);
  if (task.status === "done" || task.status === "failed") {
    const event = appendTaskEvent(taskId, "task.progress", {
      actor: input.actor,
      agentId: input.agentId,
      sessionName: input.sessionName,
      message: input.message
        ? `Ignored late progress after ${task.status}: ${input.message}`
        : `Ignored late progress after ${task.status}.`,
      progress: task.progress,
    });
    return { task, event };
  }

  const now = Date.now();
  const progress =
    typeof input.progress === "number" ? Math.max(0, Math.min(100, Math.round(input.progress))) : task.progress;
  const nextStatus: TaskRecord["status"] = "in_progress";
  const startedAt = task.startedAt ?? now;

  db.prepare(`
    UPDATE tasks
    SET status = ?,
        progress = ?,
        blocker_reason = NULL,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = ?
  `).run(nextStatus, progress, startedAt, now, taskId);

  markActiveAssignmentAccepted(taskId, input.sessionName);
  const event = appendTaskEvent(taskId, "task.progress", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: input.message,
    progress,
  });
  return { task: getTaskOrThrow(taskId), event };
}

export function dbBlockTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const task = getTaskOrThrow(taskId);
  const now = Date.now();
  const progress = Math.max(task.progress, 1);

  db.prepare(`
    UPDATE tasks
    SET status = 'blocked',
        blocker_reason = ?,
        progress = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = ?
  `).run(input.message, progress, now, now, taskId);

  db.prepare(`
    UPDATE task_assignments
    SET status = 'blocked',
        accepted_at = COALESCE(accepted_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, taskId);

  const event = appendTaskEvent(taskId, "task.blocked", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: input.message,
    progress,
  });
  return { task: getTaskOrThrow(taskId), event };
}

export function dbFailTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        summary = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(input.message, now, now, taskId);

  db.prepare(`
    UPDATE task_assignments
    SET status = 'failed',
        accepted_at = COALESCE(accepted_at, ?),
        completed_at = COALESCE(completed_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, now, taskId);

  const event = appendTaskEvent(taskId, "task.failed", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: input.message,
    progress: 100,
  });
  return { task: getTaskOrThrow(taskId), event };
}

export function dbCompleteTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    UPDATE tasks
    SET status = 'done',
        progress = 100,
        summary = ?,
        blocker_reason = NULL,
        completed_at = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = ?
  `).run(input.message, now, now, now, taskId);

  db.prepare(`
    UPDATE task_assignments
    SET status = 'done',
        accepted_at = COALESCE(accepted_at, ?),
        completed_at = COALESCE(completed_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, now, taskId);

  const event = appendTaskEvent(taskId, "task.done", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: input.message,
    progress: 100,
  });
  return { task: getTaskOrThrow(taskId), event };
}

export function dbDeleteTask(taskId: string): boolean {
  ensureTaskSchema();
  const db = getDb();
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  return result.changes > 0;
}

export function dbAppendTaskEvent(
  taskId: string,
  type: TaskEvent["type"],
  input: {
    actor?: string;
    agentId?: string;
    sessionName?: string;
    message?: string;
    progress?: number;
    relatedTaskId?: string;
  },
  options: {
    touchTask?: boolean;
  } = {},
): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  getTaskOrThrow(taskId);

  if (options.touchTask) {
    db.prepare(`
      UPDATE tasks
      SET updated_at = ?
      WHERE id = ?
    `).run(Date.now(), taskId);
  }

  const event = appendTaskEvent(taskId, type, input);
  return { task: getTaskOrThrow(taskId), event };
}

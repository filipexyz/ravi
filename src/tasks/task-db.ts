import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import {
  DEFAULT_TASK_CHECKPOINT_INTERVAL_MS,
  computeTaskCheckpointDueAt,
  calculateTaskCheckpointMiss,
  resolveTaskCheckpointIntervalMs,
} from "./checkpoint.js";
import { DEFAULT_TASK_PROFILE_ID, resolveTaskProfileForTask } from "./profiles.js";
import {
  type TaskArchiveInput,
  TASK_REPORT_EVENTS,
  type TaskProfileSnapshot,
  type TaskProfileState,
  type CreateTaskInput,
  type DispatchTaskInput,
  type ListTasksOptions,
  type TaskArchiveMode,
  type TaskAssignment,
  type TaskComment,
  type TaskCommentInput,
  type TaskDependencyRecord,
  type TaskEvent,
  type TaskLaunchPlan,
  type TaskProfileInputValues,
  type TaskProgressInput,
  type TaskRecord,
  type TaskReportEvent,
  type TaskTerminalInput,
  type TaskUnarchiveInput,
  type TaskWorktreeConfig,
} from "./types.js";
import { requireTaskProgressMessage } from "./progress-contract.js";

interface TaskRow {
  id: string;
  title: string;
  instructions: string;
  status: TaskRecord["status"];
  priority: TaskRecord["priority"];
  progress: number;
  profile_id: string | null;
  profile_version: string | null;
  profile_source: string | null;
  profile_snapshot_json: string | null;
  profile_state_json: string | null;
  profile_input_json: string | null;
  checkpoint_interval_ms: number | null;
  report_to_session_name: string | null;
  report_events: string | null;
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
  archived_at: number | null;
  archived_by: string | null;
  archive_reason: string | null;
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
  assigned_by_agent_id: string | null;
  assigned_by_session_name: string | null;
  worktree_mode: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  checkpoint_interval_ms: number | null;
  report_to_session_name: string | null;
  report_events: string | null;
  checkpoint_last_report_at: number | null;
  checkpoint_due_at: number | null;
  checkpoint_overdue_count: number | null;
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

interface TaskCommentRow {
  id: string;
  task_id: string;
  author: string | null;
  author_agent_id: string | null;
  author_session_name: string | null;
  body: string;
  created_at: number;
}

interface TaskDependencyRow {
  task_id: string;
  depends_on_task_id: string;
  created_at: number;
  satisfied_at: number | null;
  satisfied_by_event_id: number | null;
}

interface TaskLaunchPlanRow {
  task_id: string;
  agent_id: string;
  session_name: string;
  assigned_by: string | null;
  assigned_by_agent_id: string | null;
  assigned_by_session_name: string | null;
  worktree_mode: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  checkpoint_interval_ms: number | null;
  report_to_session_name: string | null;
  report_events: string | null;
  created_at: number;
  updated_at: number;
}

let schemaReady = false;
let schemaDbPath: string | null = null;
const DEFAULT_TASK_REPORT_EVENTS_JSON = JSON.stringify(["done"] satisfies TaskReportEvent[]);

function normalizeTaskReportToSessionName(sessionName?: string | null): string | null {
  const trimmed = sessionName?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTaskReportEvents(events?: readonly TaskReportEvent[] | null): TaskReportEvent[] {
  const allowed = new Set<string>(TASK_REPORT_EVENTS);
  const normalized = [...new Set((events ?? []).filter((event): event is TaskReportEvent => allowed.has(event)))];
  return normalized.length > 0 ? normalized : ["done"];
}

function serializeTaskReportEvents(events?: readonly TaskReportEvent[] | null): string {
  return JSON.stringify(normalizeTaskReportEvents(events));
}

function deserializeTaskReportEvents(raw: string | null | undefined): TaskReportEvent[] {
  if (!raw?.trim()) {
    return normalizeTaskReportEvents();
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeTaskReportEvents(parsed as TaskReportEvent[]);
    }
  } catch {
    // Fall back to a simple CSV parser for older rows or hand-edited values.
  }

  return normalizeTaskReportEvents(raw.split(",").map((value) => value.trim()) as TaskReportEvent[]);
}

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
  if (!taskColumns.has("checkpoint_interval_ms")) {
    db.exec("ALTER TABLE tasks ADD COLUMN checkpoint_interval_ms INTEGER");
  }
  if (!taskColumns.has("report_to_session_name")) {
    db.exec("ALTER TABLE tasks ADD COLUMN report_to_session_name TEXT");
  }
  if (!taskColumns.has("report_events")) {
    db.exec("ALTER TABLE tasks ADD COLUMN report_events TEXT");
  }
  if (!taskColumns.has("archived_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER");
  }
  if (!taskColumns.has("archived_by")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_by TEXT");
  }
  if (!taskColumns.has("archive_reason")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archive_reason TEXT");
  }
  if (!taskColumns.has("profile_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_id TEXT");
  }
  if (!taskColumns.has("profile_version")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_version TEXT");
  }
  if (!taskColumns.has("profile_source")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_source TEXT");
  }
  if (!taskColumns.has("profile_snapshot_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_snapshot_json TEXT");
  }
  if (!taskColumns.has("profile_state_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_state_json TEXT");
  }
  if (!taskColumns.has("profile_input_json")) {
    db.exec("ALTER TABLE tasks ADD COLUMN profile_input_json TEXT");
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
  if (!assignmentColumns.has("checkpoint_interval_ms")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN checkpoint_interval_ms INTEGER");
  }
  if (!assignmentColumns.has("report_to_session_name")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN report_to_session_name TEXT");
  }
  if (!assignmentColumns.has("report_events")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN report_events TEXT");
  }
  if (!assignmentColumns.has("checkpoint_last_report_at")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN checkpoint_last_report_at INTEGER");
  }
  if (!assignmentColumns.has("checkpoint_due_at")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN checkpoint_due_at INTEGER");
  }
  if (!assignmentColumns.has("checkpoint_overdue_count")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN checkpoint_overdue_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!assignmentColumns.has("assigned_by_agent_id")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN assigned_by_agent_id TEXT");
  }
  if (!assignmentColumns.has("assigned_by_session_name")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN assigned_by_session_name TEXT");
  }

  const eventColumns = new Set(
    (db.prepare("PRAGMA table_info(task_events)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!eventColumns.has("related_task_id")) {
    db.exec("ALTER TABLE task_events ADD COLUMN related_task_id TEXT");
  }

  const launchPlanColumns = new Set(
    (db.prepare("PRAGMA table_info(task_launch_plans)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!launchPlanColumns.has("assigned_by")) {
    db.exec("ALTER TABLE task_launch_plans ADD COLUMN assigned_by TEXT");
  }
  if (!launchPlanColumns.has("assigned_by_agent_id")) {
    db.exec("ALTER TABLE task_launch_plans ADD COLUMN assigned_by_agent_id TEXT");
  }
  if (!launchPlanColumns.has("assigned_by_session_name")) {
    db.exec("ALTER TABLE task_launch_plans ADD COLUMN assigned_by_session_name TEXT");
  }

  db.prepare(`
    UPDATE tasks
    SET checkpoint_interval_ms = COALESCE(checkpoint_interval_ms, ?),
        report_to_session_name = COALESCE(report_to_session_name, created_by_session_name),
        report_events = COALESCE(report_events, ?),
        profile_id = COALESCE(profile_id, ?)
  `).run(DEFAULT_TASK_CHECKPOINT_INTERVAL_MS, DEFAULT_TASK_REPORT_EVENTS_JSON, DEFAULT_TASK_PROFILE_ID);

  db.prepare(`
    UPDATE task_assignments
    SET checkpoint_interval_ms = COALESCE(checkpoint_interval_ms, ?),
        report_to_session_name = COALESCE(
          report_to_session_name,
          (SELECT tasks.report_to_session_name FROM tasks WHERE tasks.id = task_assignments.task_id)
        ),
        report_events = COALESCE(
          report_events,
          (SELECT tasks.report_events FROM tasks WHERE tasks.id = task_assignments.task_id),
          ?
        ),
        checkpoint_due_at = CASE
          WHEN status = 'accepted' AND checkpoint_due_at IS NULL
            THEN COALESCE(checkpoint_last_report_at, accepted_at) + COALESCE(checkpoint_interval_ms, ?)
          ELSE checkpoint_due_at
        END,
        checkpoint_overdue_count = COALESCE(checkpoint_overdue_count, 0)
  `).run(DEFAULT_TASK_CHECKPOINT_INTERVAL_MS, DEFAULT_TASK_REPORT_EVENTS_JSON, DEFAULT_TASK_CHECKPOINT_INTERVAL_MS);
}

function ensureTaskSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      progress INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT,
      profile_version TEXT,
      profile_source TEXT,
      profile_snapshot_json TEXT,
      profile_state_json TEXT,
      profile_input_json TEXT,
      checkpoint_interval_ms INTEGER,
      report_to_session_name TEXT,
      report_events TEXT,
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
      archived_at INTEGER,
      archived_by TEXT,
      archive_reason TEXT,
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
      assigned_by_agent_id TEXT,
      assigned_by_session_name TEXT,
      worktree_mode TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      checkpoint_interval_ms INTEGER,
      report_to_session_name TEXT,
      report_events TEXT,
      checkpoint_last_report_at INTEGER,
      checkpoint_due_at INTEGER,
      checkpoint_overdue_count INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author TEXT,
      author_agent_id TEXT,
      author_session_name TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      satisfied_at INTEGER,
      satisfied_by_event_id INTEGER,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (satisfied_by_event_id) REFERENCES task_events(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_launch_plans (
      task_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      assigned_by TEXT,
      assigned_by_agent_id TEXT,
      assigned_by_session_name TEXT,
      worktree_mode TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      checkpoint_interval_ms INTEGER,
      report_to_session_name TEXT,
      report_events TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_agent ON tasks(assignee_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_session ON tasks(assignee_session_name);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id, assigned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream ON task_dependencies(depends_on_task_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id, satisfied_at, created_at);
  `);
  applyTaskWorktreeSchemaMigrations();
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_archived_updated ON tasks(archived_at, updated_at DESC)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_assignments_checkpoint_due ON task_assignments(status, checkpoint_due_at)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_launch_plans_session ON task_launch_plans(session_name)");
  schemaReady = true;
  schemaDbPath = currentDbPath;
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

function resolveTaskArchiveMode(mode?: TaskArchiveMode): TaskArchiveMode {
  return mode ?? "include";
}

function parseTaskProfileState(raw: string | null): TaskProfileState | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as TaskProfileState;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeTaskProfileState(state?: TaskProfileState | null): string | null {
  if (!state) return null;
  return JSON.stringify(state);
}

function parseTaskProfileInput(raw: string | null): TaskProfileInputValues | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as TaskProfileInputValues;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeTaskProfileInput(input?: TaskProfileInputValues | null): string | null {
  if (!input) return null;
  return JSON.stringify(input);
}

function parseTaskProfileSnapshot(raw: string | null): TaskProfileSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as TaskProfileSnapshot;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeTaskProfileSnapshot(snapshot?: TaskProfileSnapshot | null): string | null {
  if (!snapshot) return null;
  return JSON.stringify(snapshot);
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.profile_version ? { profileVersion: row.profile_version } : {}),
    ...(row.profile_source ? { profileSource: row.profile_source } : {}),
    ...(row.profile_snapshot_json ? { profileSnapshot: parseTaskProfileSnapshot(row.profile_snapshot_json) } : {}),
    ...(row.profile_state_json ? { profileState: parseTaskProfileState(row.profile_state_json) } : {}),
    ...(row.profile_input_json ? { profileInput: parseTaskProfileInput(row.profile_input_json) } : {}),
    ...(typeof row.checkpoint_interval_ms === "number" ? { checkpointIntervalMs: row.checkpoint_interval_ms } : {}),
    ...(row.report_to_session_name ? { reportToSessionName: row.report_to_session_name } : {}),
    reportEvents: deserializeTaskReportEvents(row.report_events),
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
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.archived_by ? { archivedBy: row.archived_by } : {}),
    ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
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
    ...(row.assigned_by_agent_id ? { assignedByAgentId: row.assigned_by_agent_id } : {}),
    ...(row.assigned_by_session_name ? { assignedBySessionName: row.assigned_by_session_name } : {}),
    ...(rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch)
      ? { worktree: rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch) }
      : {}),
    ...(typeof row.checkpoint_interval_ms === "number" ? { checkpointIntervalMs: row.checkpoint_interval_ms } : {}),
    ...(row.report_to_session_name ? { reportToSessionName: row.report_to_session_name } : {}),
    reportEvents: deserializeTaskReportEvents(row.report_events),
    ...(row.checkpoint_last_report_at ? { checkpointLastReportAt: row.checkpoint_last_report_at } : {}),
    ...(row.checkpoint_due_at ? { checkpointDueAt: row.checkpoint_due_at } : {}),
    checkpointOverdueCount: row.checkpoint_overdue_count ?? 0,
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

function rowToComment(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.author ? { author: row.author } : {}),
    ...(row.author_agent_id ? { authorAgentId: row.author_agent_id } : {}),
    ...(row.author_session_name ? { authorSessionName: row.author_session_name } : {}),
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToTaskDependency(row: TaskDependencyRow): TaskDependencyRecord {
  return {
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at,
    ...(typeof row.satisfied_at === "number" ? { satisfiedAt: row.satisfied_at } : {}),
    ...(typeof row.satisfied_by_event_id === "number" ? { satisfiedByEventId: row.satisfied_by_event_id } : {}),
  };
}

function rowToTaskLaunchPlan(row: TaskLaunchPlanRow): TaskLaunchPlan {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionName: row.session_name,
    ...(row.assigned_by ? { assignedBy: row.assigned_by } : {}),
    ...(row.assigned_by_agent_id ? { assignedByAgentId: row.assigned_by_agent_id } : {}),
    ...(row.assigned_by_session_name ? { assignedBySessionName: row.assigned_by_session_name } : {}),
    ...(rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch)
      ? { worktree: rowToWorktree(row.worktree_mode, row.worktree_path, row.worktree_branch) }
      : {}),
    ...(typeof row.checkpoint_interval_ms === "number" ? { checkpointIntervalMs: row.checkpoint_interval_ms } : {}),
    ...(row.report_to_session_name ? { reportToSessionName: row.report_to_session_name } : {}),
    reportEvents: deserializeTaskReportEvents(row.report_events),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getAssignmentRowById(assignmentId: string): TaskAssignmentRow | undefined {
  ensureTaskSchema();
  const db = getDb();
  return db.prepare("SELECT * FROM task_assignments WHERE id = ?").get(assignmentId) as TaskAssignmentRow | undefined;
}

function getTaskOrThrow(id: string): TaskRecord {
  const task = dbGetTask(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  return task;
}

function getLatestTaskEvent(taskId: string, type?: TaskEvent["type"]): TaskEvent | undefined {
  ensureTaskSchema();
  const db = getDb();
  const row = type
    ? (db
        .prepare(`
          SELECT * FROM task_events
          WHERE task_id = ? AND type = ?
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(taskId, type) as TaskEventRow | undefined)
    : (db
        .prepare(`
          SELECT * FROM task_events
          WHERE task_id = ?
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(taskId) as TaskEventRow | undefined);
  return row ? rowToEvent(row) : undefined;
}

function getTerminalTaskNoopResult(
  task: TaskRecord,
  preferredType?: TaskEvent["type"],
): { task: TaskRecord; event: TaskEvent; wasNoop: true } {
  const fallbackType = task.status === "failed" ? "task.failed" : task.status === "done" ? "task.done" : undefined;
  const event =
    (preferredType ? getLatestTaskEvent(task.id, preferredType) : undefined) ??
    (fallbackType ? getLatestTaskEvent(task.id, fallbackType) : undefined) ??
    getLatestTaskEvent(task.id)!;
  return {
    task,
    event,
    wasNoop: true,
  };
}

function resolveSatisfiedDependencySource(dependsOnTaskId: string): {
  satisfiedAt?: number;
  satisfiedByEventId?: number;
} {
  const upstreamTask = dbGetTask(dependsOnTaskId);
  if (upstreamTask?.status !== "done") {
    return {};
  }

  const doneEvent = getLatestTaskEvent(dependsOnTaskId, "task.done");
  if (!doneEvent) {
    return {};
  }

  return {
    satisfiedAt: doneEvent.createdAt,
    ...(typeof doneEvent.id === "number" ? { satisfiedByEventId: doneEvent.id } : {}),
  };
}

function buildDispatchEventMessage(input: DispatchTaskInput): string {
  return [
    `Dispatched to ${input.agentId}/${input.sessionName}.`,
    "Dispatch summary surfaced here:",
    "the runtime caller did not provide a profile-specific summary,",
    "so treat this as a generic dispatch and sync via ravi tasks report|done|block|fail.",
  ].join(" ");
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
      SET status = CASE WHEN status IN ('assigned', 'blocked') THEN 'accepted' ELSE status END,
          accepted_at = COALESCE(accepted_at, ?)
      WHERE task_id = ? AND session_name = ? AND status IN ('assigned', 'accepted', 'blocked')
    `).run(now, taskId, sessionName);
    return;
  }

  db.prepare(`
    UPDATE task_assignments
    SET status = CASE WHEN status IN ('assigned', 'blocked') THEN 'accepted' ELSE status END,
        accepted_at = COALESCE(accepted_at, ?)
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, taskId);
}

export function dbCreateTask(input: CreateTaskInput): { task: TaskRecord; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const id = `task-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const [worktreeMode, worktreePath, worktreeBranch] = worktreeToColumns(input.worktree);
  const checkpointIntervalMs = resolveTaskCheckpointIntervalMs(input.checkpointIntervalMs);
  const reportToSessionName = normalizeTaskReportToSessionName(input.reportToSessionName ?? input.createdBySessionName);
  const reportEvents = serializeTaskReportEvents(input.reportEvents);

  db.prepare(`
    INSERT INTO tasks (
      id, title, instructions, status, priority, progress, checkpoint_interval_ms, report_to_session_name, report_events,
      profile_id, profile_version, profile_source, profile_snapshot_json, profile_state_json, profile_input_json, parent_task_id, task_dir, created_by, created_by_agent_id, created_by_session_name, worktree_mode, worktree_path,
      worktree_branch, created_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title,
    input.instructions,
    input.priority ?? "normal",
    checkpointIntervalMs,
    reportToSessionName,
    reportEvents,
    input.profileId ?? DEFAULT_TASK_PROFILE_ID,
    input.profileVersion ?? null,
    input.profileSource ?? null,
    serializeTaskProfileSnapshot(input.profileSnapshot),
    serializeTaskProfileState(input.profileState),
    serializeTaskProfileInput(input.profileInput),
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
  const task = getTaskOrThrow(taskId);
  const profile = resolveTaskProfileForTask(task);
  if (!profile.workspaceBootstrap.ensureTaskDir) {
    throw new Error(`Task ${taskId} profile ${profile.id} forbids task_dir persistence.`);
  }
  db.prepare(`
    UPDATE tasks
    SET task_dir = ?
    WHERE id = ?
  `).run(taskDir, taskId);
  return getTaskOrThrow(taskId);
}

export function dbSetTaskProfileId(taskId: string, profileId: string): TaskRecord {
  ensureTaskSchema();
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET profile_id = ?
    WHERE id = ?
  `).run(profileId, taskId);
  return getTaskOrThrow(taskId);
}

export function dbSetTaskProfileResolution(
  taskId: string,
  input: {
    profileId: string;
    profileVersion: string;
    profileSource: string;
    profileSnapshot: TaskProfileSnapshot;
  },
): TaskRecord {
  ensureTaskSchema();
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET profile_id = ?,
        profile_version = ?,
        profile_source = ?,
        profile_snapshot_json = ?
    WHERE id = ?
  `).run(
    input.profileId,
    input.profileVersion,
    input.profileSource,
    serializeTaskProfileSnapshot(input.profileSnapshot),
    taskId,
  );
  return getTaskOrThrow(taskId);
}

export function dbSetTaskProfileState(taskId: string, profileState: TaskProfileState): TaskRecord {
  ensureTaskSchema();
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET profile_state_json = ?
    WHERE id = ?
  `).run(serializeTaskProfileState(profileState), taskId);
  return getTaskOrThrow(taskId);
}

export function dbGetTask(id: string): TaskRecord | null {
  ensureTaskSchema();
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function dbListTaskDependencies(taskId: string): TaskDependencyRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE task_id = ?
        ORDER BY created_at ASC, depends_on_task_id ASC
      `,
    )
    .all(taskId) as TaskDependencyRow[];
  return rows.map(rowToTaskDependency);
}

export function dbListTaskDependents(dependsOnTaskId: string): TaskDependencyRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE depends_on_task_id = ?
        ORDER BY created_at ASC, task_id ASC
      `,
    )
    .all(dependsOnTaskId) as TaskDependencyRow[];
  return rows.map(rowToTaskDependency);
}

export function dbGetTaskLaunchPlan(taskId: string): TaskLaunchPlan | null {
  ensureTaskSchema();
  const db = getDb();
  const row = db.prepare("SELECT * FROM task_launch_plans WHERE task_id = ?").get(taskId) as
    | TaskLaunchPlanRow
    | undefined;
  return row ? rowToTaskLaunchPlan(row) : null;
}

export function dbSetTaskLaunchPlan(taskId: string, input: DispatchTaskInput): TaskLaunchPlan {
  ensureTaskSchema();
  const db = getDb();
  getTaskOrThrow(taskId);
  const now = Date.now();
  const [worktreeMode, worktreePath, worktreeBranch] = worktreeToColumns(input.worktree);
  db.prepare(
    `
      INSERT INTO task_launch_plans (
        task_id, agent_id, session_name, assigned_by, assigned_by_agent_id, assigned_by_session_name,
        worktree_mode, worktree_path, worktree_branch, checkpoint_interval_ms, report_to_session_name,
        report_events, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        session_name = excluded.session_name,
        assigned_by = excluded.assigned_by,
        assigned_by_agent_id = excluded.assigned_by_agent_id,
        assigned_by_session_name = excluded.assigned_by_session_name,
        worktree_mode = excluded.worktree_mode,
        worktree_path = excluded.worktree_path,
        worktree_branch = excluded.worktree_branch,
        checkpoint_interval_ms = excluded.checkpoint_interval_ms,
        report_to_session_name = excluded.report_to_session_name,
        report_events = excluded.report_events,
        updated_at = excluded.updated_at
    `,
  ).run(
    taskId,
    input.agentId,
    input.sessionName,
    input.assignedBy ?? null,
    input.assignedByAgentId ?? null,
    input.assignedBySessionName ?? null,
    worktreeMode,
    worktreePath,
    worktreeBranch,
    input.checkpointIntervalMs ?? null,
    normalizeTaskReportToSessionName(input.reportToSessionName),
    serializeTaskReportEvents(input.reportEvents),
    now,
    now,
  );

  return dbGetTaskLaunchPlan(taskId)!;
}

export function dbClearTaskLaunchPlan(taskId: string): boolean {
  ensureTaskSchema();
  const db = getDb();
  return db.prepare("DELETE FROM task_launch_plans WHERE task_id = ?").run(taskId).changes > 0;
}

export function dbAddTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
): { dependency: TaskDependencyRecord; wasNoop?: boolean } {
  ensureTaskSchema();
  const db = getDb();
  getTaskOrThrow(taskId);
  getTaskOrThrow(dependsOnTaskId);

  const existing = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE task_id = ? AND depends_on_task_id = ?
      `,
    )
    .get(taskId, dependsOnTaskId) as TaskDependencyRow | undefined;
  if (existing) {
    return {
      dependency: rowToTaskDependency(existing),
      wasNoop: true,
    };
  }

  const now = Date.now();
  const satisfied = resolveSatisfiedDependencySource(dependsOnTaskId);
  db.prepare(
    `
      INSERT INTO task_dependencies (
        task_id, depends_on_task_id, created_at, satisfied_at, satisfied_by_event_id
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(taskId, dependsOnTaskId, now, satisfied.satisfiedAt ?? null, satisfied.satisfiedByEventId ?? null);

  db.prepare(
    `
      UPDATE tasks
      SET updated_at = ?
      WHERE id = ?
    `,
  ).run(now, taskId);

  const row = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE task_id = ? AND depends_on_task_id = ?
      `,
    )
    .get(taskId, dependsOnTaskId) as TaskDependencyRow | undefined;
  if (!row) {
    throw new Error(`Failed to persist dependency ${taskId} -> ${dependsOnTaskId}`);
  }
  return { dependency: rowToTaskDependency(row) };
}

export function dbRemoveTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
): { dependency: TaskDependencyRecord | null; wasNoop?: boolean } {
  ensureTaskSchema();
  const db = getDb();
  const existing = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE task_id = ? AND depends_on_task_id = ?
      `,
    )
    .get(taskId, dependsOnTaskId) as TaskDependencyRow | undefined;
  if (!existing) {
    return { dependency: null, wasNoop: true };
  }

  db.prepare(
    `
      DELETE FROM task_dependencies
      WHERE task_id = ? AND depends_on_task_id = ?
    `,
  ).run(taskId, dependsOnTaskId);

  db.prepare(
    `
      UPDATE tasks
      SET updated_at = ?
      WHERE id = ?
    `,
  ).run(Date.now(), taskId);

  return { dependency: rowToTaskDependency(existing) };
}

export function dbMarkTaskDependenciesSatisfiedByUpstream(
  dependsOnTaskId: string,
  event: Pick<TaskEvent, "id" | "createdAt">,
): TaskDependencyRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const pendingRows = db
    .prepare(
      `
        SELECT *
        FROM task_dependencies
        WHERE depends_on_task_id = ?
          AND satisfied_at IS NULL
      `,
    )
    .all(dependsOnTaskId) as TaskDependencyRow[];
  if (pendingRows.length === 0) {
    return [];
  }

  db.prepare(
    `
      UPDATE task_dependencies
      SET satisfied_at = ?,
          satisfied_by_event_id = ?
      WHERE depends_on_task_id = ?
        AND satisfied_at IS NULL
    `,
  ).run(event.createdAt, typeof event.id === "number" ? event.id : null, dependsOnTaskId);
  return pendingRows.map((row) =>
    rowToTaskDependency({
      ...row,
      satisfied_at: event.createdAt,
      satisfied_by_event_id: typeof event.id === "number" ? event.id : null,
    }),
  );
}

export function dbListTasks(options: ListTasksOptions = {}): TaskRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const archiveMode = resolveTaskArchiveMode(options.archiveMode);
  const normalizedQuery = options.query?.trim().toLowerCase() ?? "";
  const normalizedLimit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;

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
  if (options.onlyRootTasks) {
    filters.push("parent_task_id IS NULL");
  }
  if (options.profileId) {
    filters.push("profile_id = ?");
    params.push(options.profileId);
  }
  if (normalizedQuery) {
    filters.push("(LOWER(title) LIKE ? OR LOWER(instructions) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ?)");
    const like = `%${normalizedQuery}%`;
    params.push(like, like, like);
  }
  if (archiveMode === "exclude") {
    filters.push("archived_at IS NULL");
  } else if (archiveMode === "only") {
    filters.push("archived_at IS NOT NULL");
  }

  const lineageCte = options.rootTaskId
    ? `
      WITH RECURSIVE task_lineage(id) AS (
        SELECT id FROM tasks WHERE id = ?
        UNION ALL
        SELECT tasks.id
        FROM tasks
        JOIN task_lineage ON tasks.parent_task_id = task_lineage.id
      )
    `
    : "";
  if (options.rootTaskId) {
    filters.push("id IN (SELECT id FROM task_lineage)");
    params.unshift(options.rootTaskId);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limitClause = normalizedLimit ? " LIMIT ?" : "";
  if (normalizedLimit) {
    params.push(normalizedLimit);
  }
  const rows = db
    .prepare(`${lineageCte} SELECT * FROM tasks ${where} ORDER BY updated_at DESC${limitClause}`)
    .all(...params) as TaskRow[];
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

export function dbResolveActiveTaskBindingForSession(
  sessionName: string,
  taskId?: string,
): { task: TaskRecord; assignment: TaskAssignment } | null {
  ensureTaskSchema();
  const db = getDb();
  const rows = (
    taskId
      ? db
          .prepare(`
            SELECT *
            FROM task_assignments
            WHERE session_name = ?
              AND task_id = ?
              AND status IN ('assigned', 'accepted', 'blocked')
            ORDER BY assigned_at DESC
          `)
          .all(sessionName, taskId)
      : db
          .prepare(`
            SELECT *
            FROM task_assignments
            WHERE session_name = ?
              AND status IN ('assigned', 'accepted', 'blocked')
            ORDER BY assigned_at DESC
          `)
          .all(sessionName)
  ) as TaskAssignmentRow[];

  const bindings = rows
    .map((row) => {
      const task = dbGetTask(row.task_id);
      if (!task || !["dispatched", "in_progress", "blocked"].includes(task.status)) {
        return null;
      }
      return {
        task,
        assignment: rowToAssignment(row),
      };
    })
    .filter((binding): binding is { task: TaskRecord; assignment: TaskAssignment } => binding !== null);

  if (typeof taskId === "string" && taskId.trim()) {
    return bindings[0] ?? null;
  }

  const activeTaskIds = [...new Set(bindings.map((binding) => binding.task.id))];
  if (activeTaskIds.length !== 1) {
    return null;
  }

  return bindings[0] ?? null;
}

export function dbMarkTaskAcceptedForSession(
  sessionName: string,
  taskId?: string,
): { task: TaskRecord; assignment: TaskAssignment; event: TaskEvent | null; transitioned: boolean } | null {
  ensureTaskSchema();
  const binding = dbResolveActiveTaskBindingForSession(sessionName, taskId);
  if (!binding) {
    return null;
  }

  const db = getDb();
  const now = Date.now();
  const transitionedAssignment = ["assigned", "blocked"].includes(binding.assignment.status);
  const checkpointDueAt = transitionedAssignment
    ? computeTaskCheckpointDueAt(now, binding.assignment.checkpointIntervalMs ?? binding.task.checkpointIntervalMs)
    : (binding.assignment.checkpointDueAt ?? null);

  db.prepare(`
    UPDATE task_assignments
    SET status = CASE WHEN status IN ('assigned', 'blocked') THEN 'accepted' ELSE status END,
        accepted_at = COALESCE(accepted_at, ?),
        checkpoint_due_at = CASE
          WHEN status IN ('assigned', 'blocked') THEN ?
          ELSE checkpoint_due_at
        END,
        checkpoint_overdue_count = CASE
          WHEN status IN ('assigned', 'blocked') THEN 0
          ELSE checkpoint_overdue_count
        END
    WHERE id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, checkpointDueAt, binding.assignment.id);

  const transitionedTask =
    db
      .prepare(`
    UPDATE tasks
    SET status = CASE
          WHEN status = 'dispatched' THEN 'in_progress'
          ELSE status
        END,
        started_at = CASE
          WHEN status = 'dispatched' THEN COALESCE(started_at, ?)
          ELSE started_at
        END,
        updated_at = ?
    WHERE id = ? AND status IN ('dispatched', 'in_progress', 'blocked')
  `)
      .run(now, now, binding.task.id).changes > 0 && binding.task.status === "dispatched";

  const nextTask = getTaskOrThrow(binding.task.id);
  const nextAssignment = dbGetActiveAssignment(binding.task.id)!;
  const event = transitionedTask
    ? appendTaskEvent(binding.task.id, "task.progress", {
        actor: sessionName,
        sessionName,
        message: "Worker bootstrap started; awaiting the first progress sync.",
        progress: nextTask.progress,
      })
    : null;

  return {
    task: nextTask,
    assignment: nextAssignment,
    event,
    transitioned: transitionedTask,
  };
}

export function dbListTaskEvents(taskId: string, limit = 100): TaskEvent[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(taskId, limit) as TaskEventRow[];
  return rows.map(rowToEvent);
}

export function dbAddTaskComment(taskId: string, input: TaskCommentInput): TaskComment {
  ensureTaskSchema();
  const db = getDb();
  getTaskOrThrow(taskId);

  const now = Date.now();
  const id = `cmt-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO task_comments (
      id, task_id, author, author_agent_id, author_session_name, body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    input.author ?? null,
    input.authorAgentId ?? null,
    input.authorSessionName ?? null,
    input.body,
    now,
  );

  db.prepare(`
    UPDATE tasks
    SET updated_at = ?
    WHERE id = ?
  `).run(now, taskId);

  const row = db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id) as TaskCommentRow | undefined;
  if (!row) {
    throw new Error(`Failed to fetch newly created task comment: ${id}`);
  }
  return rowToComment(row);
}

export function dbListTaskComments(taskId: string, limit = 100): TaskComment[] {
  ensureTaskSchema();
  getTaskOrThrow(taskId);
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(taskId, limit) as TaskCommentRow[];
  return rows.map(rowToComment);
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

export function dbRegisterTaskCheckpointMiss(
  taskId: string,
  assignmentId: string,
  now = Date.now(),
): { task: TaskRecord; assignment: TaskAssignment; event: TaskEvent; missedCount: number } | null {
  ensureTaskSchema();
  const db = getDb();
  getTaskOrThrow(taskId);

  const row = getAssignmentRowById(assignmentId);
  if (!row || row.task_id !== taskId) {
    return null;
  }
  if (!["assigned", "accepted"].includes(row.status)) {
    return null;
  }
  if (!row.checkpoint_due_at) {
    return null;
  }

  const checkpointIntervalMs = resolveTaskCheckpointIntervalMs(row.checkpoint_interval_ms);
  const { missedCount, nextDueAt } = calculateTaskCheckpointMiss(row.checkpoint_due_at, checkpointIntervalMs, now);
  if (missedCount <= 0) {
    return null;
  }

  const nextOverdueCount = (row.checkpoint_overdue_count ?? 0) + missedCount;
  const result = db
    .prepare(`
      UPDATE task_assignments
      SET checkpoint_due_at = ?,
          checkpoint_overdue_count = ?
      WHERE id = ?
        AND task_id = ?
        AND status IN ('assigned', 'accepted')
        AND checkpoint_due_at = ?
    `)
    .run(nextDueAt, nextOverdueCount, assignmentId, taskId, row.checkpoint_due_at);
  if (result.changes === 0) {
    return null;
  }

  const assignmentRow = getAssignmentRowById(assignmentId);
  if (!assignmentRow) {
    return null;
  }
  const assignment = rowToAssignment(assignmentRow);
  const event = appendTaskEvent(taskId, "task.checkpoint.missed", {
    actor: "task-checkpoint-runner",
    agentId: assignment.agentId,
    sessionName: assignment.sessionName,
    message: `Checkpoint overdue ${assignment.checkpointOverdueCount ?? nextOverdueCount}x; real report still pending.`,
    progress: getTaskOrThrow(taskId).progress,
  });

  return {
    task: getTaskOrThrow(taskId),
    assignment,
    event,
    missedCount,
  };
}

export function dbDispatchTask(
  taskId: string,
  input: DispatchTaskInput,
  options: {
    eventMessage?: string;
  } = {},
): { task: TaskRecord; assignment: TaskAssignment; event: TaskEvent } {
  ensureTaskSchema();
  const db = getDb();
  const now = Date.now();
  const [worktreeMode, worktreePath, worktreeBranch] = worktreeToColumns(input.worktree);
  const task = getTaskOrThrow(taskId);
  const checkpointIntervalMs = resolveTaskCheckpointIntervalMs(input.checkpointIntervalMs ?? task.checkpointIntervalMs);
  const reportToSessionName = normalizeTaskReportToSessionName(input.reportToSessionName ?? task.reportToSessionName);
  const reportEvents = serializeTaskReportEvents(input.reportEvents ?? task.reportEvents);

  db.prepare("DELETE FROM task_launch_plans WHERE task_id = ?").run(taskId);

  db.prepare(`
    UPDATE task_assignments
    SET status = 'superseded',
        completed_at = COALESCE(completed_at, ?),
        checkpoint_due_at = NULL
    WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
  `).run(now, taskId);

  const assignmentId = `asg-${randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO task_assignments (
      id, task_id, agent_id, session_name, assigned_by, assigned_by_agent_id, assigned_by_session_name,
      worktree_mode, worktree_path, worktree_branch, checkpoint_interval_ms, report_to_session_name, report_events,
      checkpoint_last_report_at, checkpoint_due_at, checkpoint_overdue_count, status, assigned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'assigned', ?)
  `).run(
    assignmentId,
    taskId,
    input.agentId,
    input.sessionName,
    input.assignedBy ?? null,
    input.assignedByAgentId ?? null,
    input.assignedBySessionName ?? null,
    worktreeMode,
    worktreePath,
    worktreeBranch,
    checkpointIntervalMs,
    reportToSessionName,
    reportEvents,
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
    message: options.eventMessage ?? buildDispatchEventMessage(input),
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
  const message = requireTaskProgressMessage(input.message, "Task progress requires a descriptive message.");
  if (task.status === "done" || task.status === "failed") {
    const event = appendTaskEvent(taskId, "task.progress", {
      actor: input.actor,
      agentId: input.agentId,
      sessionName: input.sessionName,
      message: `Ignored late progress after ${task.status}: ${message}`,
      progress: task.progress,
    });
    return { task, event };
  }

  const now = Date.now();
  const resetCheckpoint = input.resetCheckpoint ?? true;
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

  if (resetCheckpoint) {
    const activeAssignment = dbGetActiveAssignment(taskId);
    const checkpointIntervalMs = resolveTaskCheckpointIntervalMs(
      activeAssignment?.checkpointIntervalMs ?? task.checkpointIntervalMs,
    );
    const checkpointDueAt = computeTaskCheckpointDueAt(now, checkpointIntervalMs);

    if (input.sessionName) {
      db.prepare(`
        UPDATE task_assignments
        SET status = CASE WHEN status IN ('assigned', 'blocked') THEN 'accepted' ELSE status END,
            accepted_at = COALESCE(accepted_at, ?),
            checkpoint_last_report_at = ?,
            checkpoint_due_at = ?,
            checkpoint_overdue_count = 0
        WHERE task_id = ? AND session_name = ? AND status IN ('assigned', 'accepted', 'blocked')
      `).run(now, now, checkpointDueAt, taskId, input.sessionName);
    } else {
      db.prepare(`
        UPDATE task_assignments
        SET status = CASE WHEN status IN ('assigned', 'blocked') THEN 'accepted' ELSE status END,
            accepted_at = COALESCE(accepted_at, ?),
            checkpoint_last_report_at = ?,
            checkpoint_due_at = ?,
            checkpoint_overdue_count = 0
        WHERE task_id = ? AND status IN ('assigned', 'accepted', 'blocked')
      `).run(now, now, checkpointDueAt, taskId);
    }
  } else {
    markActiveAssignmentAccepted(taskId, input.sessionName);
  }

  const event = appendTaskEvent(taskId, "task.progress", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message,
    progress,
  });
  return { task: getTaskOrThrow(taskId), event };
}

export function dbArchiveTask(
  taskId: string,
  input: TaskArchiveInput,
): { task: TaskRecord; event: TaskEvent; wasNoop?: boolean } {
  ensureTaskSchema();
  const db = getDb();
  const task = getTaskOrThrow(taskId);
  if (task.archivedAt) {
    return {
      task,
      event: getLatestTaskEvent(taskId, "task.archived") ?? getLatestTaskEvent(taskId)!,
      wasNoop: true,
    };
  }

  const now = Date.now();
  const archivedBy = input.actor ?? input.sessionName ?? input.agentId ?? null;
  db.prepare(`
    UPDATE tasks
    SET archived_at = ?,
        archived_by = ?,
        archive_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(now, archivedBy, input.reason, now, taskId);

  const archivedTask = getTaskOrThrow(taskId);
  const event = appendTaskEvent(taskId, "task.archived", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: input.reason,
    progress: archivedTask.progress,
  });
  return { task: archivedTask, event };
}

export function dbUnarchiveTask(
  taskId: string,
  input: TaskUnarchiveInput,
): { task: TaskRecord; event: TaskEvent; wasNoop?: boolean } {
  ensureTaskSchema();
  const db = getDb();
  const task = getTaskOrThrow(taskId);
  if (!task.archivedAt) {
    return {
      task,
      event: getLatestTaskEvent(taskId, "task.unarchived") ?? getLatestTaskEvent(taskId)!,
      wasNoop: true,
    };
  }

  const now = Date.now();
  const previousReason = task.archiveReason;
  db.prepare(`
    UPDATE tasks
    SET archived_at = NULL,
        archived_by = NULL,
        archive_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, taskId);

  const unarchivedTask = getTaskOrThrow(taskId);
  const event = appendTaskEvent(taskId, "task.unarchived", {
    actor: input.actor,
    agentId: input.agentId,
    sessionName: input.sessionName,
    message: previousReason ? `restored visibility (${previousReason})` : "restored visibility",
    progress: unarchivedTask.progress,
  });
  return { task: unarchivedTask, event };
}

export function dbBlockTask(
  taskId: string,
  input: TaskTerminalInput,
): { task: TaskRecord; event: TaskEvent; wasNoop?: boolean } {
  ensureTaskSchema();
  const db = getDb();
  const task = getTaskOrThrow(taskId);
  if (task.status === "done" || task.status === "failed") {
    return getTerminalTaskNoopResult(task);
  }
  const now = Date.now();
  const progress =
    typeof input.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(input.progress)))
      : Math.max(task.progress, 1);

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
        accepted_at = COALESCE(accepted_at, ?),
        checkpoint_due_at = NULL
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

export function dbFailTask(
  taskId: string,
  input: TaskTerminalInput,
): { task: TaskRecord; event: TaskEvent; wasNoop?: boolean } {
  ensureTaskSchema();
  const task = getTaskOrThrow(taskId);
  if (task.status === "done" || task.status === "failed") {
    return getTerminalTaskNoopResult(task);
  }

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
        completed_at = COALESCE(completed_at, ?),
        checkpoint_due_at = NULL
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

export function dbCompleteTask(
  taskId: string,
  input: TaskTerminalInput,
): { task: TaskRecord; event: TaskEvent; wasNoop?: boolean } {
  ensureTaskSchema();
  const task = getTaskOrThrow(taskId);
  if (task.status === "done" || task.status === "failed") {
    return getTerminalTaskNoopResult(task, "task.done");
  }

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
        completed_at = COALESCE(completed_at, ?),
        checkpoint_due_at = NULL
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

export function dbGetActiveTasksBlocking(): TaskRecord[] {
  ensureTaskSchema();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM tasks WHERE status IN ('dispatched', 'in_progress') ORDER BY updated_at DESC")
    .all() as TaskRow[];
  return rows.map(rowToTask);
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

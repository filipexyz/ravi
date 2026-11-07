import type { Database } from "bun:sqlite";
import { getDb } from "../router/router-db.js";
import { addThreadEntry, createThread, upsertThreadLink } from "../threads/service.js";
import type { TaskEvent, TaskRecord } from "./types.js";

/** Additive, transactional import. No session, channel or queued payload is rewritten. */
export function migrateTaskThreads(db: Database): void {
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("thread_id")) db.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT REFERENCES threads(id)");
    if (!columns.has("creation_key")) db.exec("ALTER TABLE tasks ADD COLUMN creation_key TEXT");
    if (!columns.has("creation_hash")) db.exec("ALTER TABLE tasks ADD COLUMN creation_hash TEXT");
    const legacy = db.query("SELECT * FROM tasks WHERE thread_id IS NULL").all() as Array<{
      id: string;
      title: string;
      instructions: string;
      status: string;
      summary: string | null;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
    }>;
    for (const row of legacy) {
      const threadId = createTaskThread(
        { id: row.id, title: row.title, instructions: row.instructions, createdAt: row.created_at },
        true,
      );
      db.query("UPDATE tasks SET thread_id=? WHERE id=?").run(threadId, row.id);
      db.query("UPDATE threads SET status=?,summary=?,closed_at=?,closed_reason=?,updated_at=? WHERE id=?").run(
        threadStatus(row.status),
        row.summary,
        row.completed_at,
        row.status === "done" ? "task.done" : row.status === "failed" ? "task.failed" : null,
        row.updated_at,
        threadId,
      );
      if (row.summary)
        addThreadEntry({
          threadId,
          kind: "summary",
          body: row.summary,
          sourceType: "task.import",
          sourceId: row.id,
          now: row.completed_at ?? row.updated_at,
        });
    }
    db.exec(`
      INSERT OR IGNORE INTO thread_links(id,thread_id,target_type,target_id,role,created_at,updated_at)
      SELECT 'trl_task_parent_' || child.id,child.thread_id,'thread',parent.thread_id,'parent',child.created_at,child.created_at
      FROM tasks child JOIN tasks parent ON parent.id=child.parent_task_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_key ON tasks(creation_key) WHERE creation_key IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS tasks_require_thread_insert BEFORE INSERT ON tasks
      WHEN NEW.thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM threads WHERE id=NEW.thread_id)
      BEGIN SELECT RAISE(ABORT, 'Task requires a canonical thread'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_require_thread_update BEFORE UPDATE OF thread_id ON tasks
      WHEN NEW.thread_id IS NOT OLD.thread_id
      BEGIN SELECT RAISE(ABORT, 'Task thread is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_retain_thread BEFORE DELETE ON threads
      WHEN EXISTS (SELECT 1 FROM tasks WHERE thread_id=OLD.id)
      BEGIN SELECT RAISE(ABORT, 'Task thread is still referenced'); END;
    `);
    const assignments = new Set(
      (db.query("PRAGMA table_info(task_assignments)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, definition] of Object.entries({
      dispatch_payload_json: "TEXT",
      dispatch_published_at: "INTEGER",
      handoff_id: "TEXT REFERENCES thread_handoffs(id)",
      execution_status: "TEXT NOT NULL DEFAULT 'legacy'",
      execution_admitted_at: "INTEGER",
    })) {
      if (!assignments.has(name)) db.exec(`ALTER TABLE task_assignments ADD COLUMN ${name} ${definition}`);
    }
  }).immediate();
}

export function createTaskThread(
  task: Pick<TaskRecord, "id" | "title" | "instructions" | "createdAt" | "parentTaskId">,
  imported = false,
): string {
  const thread = createThread({
    title: task.title,
    scope: { type: "task", id: task.id },
    owner: { type: "system" },
    now: task.createdAt,
    metadata: { createdVia: imported ? "task.import" : "task.create" },
  });
  upsertThreadLink({ threadId: thread.id, target: { type: "task", id: task.id }, role: "work", now: task.createdAt });
  addThreadEntry({
    threadId: thread.id,
    kind: "prompt",
    body: task.instructions || task.title,
    sourceType: imported ? "task.import" : "task",
    sourceId: task.id,
    now: task.createdAt,
  });
  if (task.parentTaskId) {
    const parent = getDb().query("SELECT thread_id FROM tasks WHERE id=?").get(task.parentTaskId) as {
      thread_id: string;
    } | null;
    if (parent?.thread_id)
      upsertThreadLink({
        threadId: thread.id,
        target: { type: "thread", id: parent.thread_id },
        role: "parent",
        now: task.createdAt,
      });
  }
  return thread.id;
}

function threadStatus(status: string): string {
  return (
    (
      {
        open: "open",
        dispatched: "active",
        in_progress: "active",
        blocked: "blocked",
        done: "resolved",
        failed: "closed",
      } as Record<string, string>
    )[status] ?? "open"
  );
}

/** Called inside the task write: the task runtime is the sole lifecycle writer. */
export function syncTaskThreadEvent(task: TaskRecord, event: TaskEvent): void {
  const terminal = task.status === "done" || task.status === "failed";
  getDb()
    .query(`UPDATE threads SET title=?,status=?,summary=?,current_assignee_type=?,current_assignee_id=?,
    closed_at=?,closed_reason=?,updated_at=? WHERE id=?`)
    .run(
      task.title,
      threadStatus(task.status),
      task.summary ?? null,
      task.assigneeAgentId ? "agent" : null,
      task.assigneeAgentId ?? null,
      task.completedAt ?? null,
      terminal ? `task.${task.status}` : null,
      event.createdAt,
      task.threadId,
    );
  addThreadEntry({
    threadId: task.threadId,
    kind: event.type === "task.done" || event.type === "task.failed" ? "summary" : "status_change",
    body: event.message || event.type,
    sourceType: "task.event",
    sourceId: String(event.id),
    actor: { type: event.agentId ? "agent" : "system", agentId: event.agentId, sessionName: event.sessionName },
    metadata: { taskId: task.id, eventType: event.type },
    now: event.createdAt,
  });
}

export function assertTaskDecisionsSettled(task: TaskRecord): void {
  const db = getDb();
  const pending = db
    .query(`SELECT d.id FROM decisions d WHERE
    ((d.origin_type='task' AND d.origin_id=?) OR (d.origin_type='thread' AND d.origin_id=?))
    AND (d.status='open' OR EXISTS (SELECT 1 FROM decision_deliveries x WHERE x.decision_id=d.id
      AND x.kind='answer' AND x.status NOT IN ('delivered','superseded'))) LIMIT 1`)
    .get(task.id, task.threadId);
  if (pending) throw new Error("Task has an open decision or an undelivered answer");
}

import { getDb } from "../router/router-db.js";
import { resolveSession } from "../router/sessions.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { prepareThreadHandoff, markThreadHandoffDelivered } from "../threads/service.js";
import { dbGetTask } from "./task-db.js";
import { publishTaskSessionPrompt } from "./session-publisher.js";
import type { TaskAssignment, TaskRecord } from "./types.js";

interface DispatchReceipt {
  id: string;
  task_id: string;
  session_name: string;
  agent_id: string;
  status: string;
  execution_status: string;
  dispatch_payload_json: string | null;
  handoff_id: string | null;
}

function receipt(assignmentId: string): DispatchReceipt {
  const row = getDb().query("SELECT * FROM task_assignments WHERE id=?").get(assignmentId) as DispatchReceipt | null;
  if (!row) throw new Error("Task assignment not found");
  return row;
}

/** Expiring the session row must not change an already frozen executor identity. */
export function taskDispatchSessionKey(
  task: TaskRecord,
  agentId: string,
  sessionName: string,
  existingKey?: string,
): string {
  const frozen = getDb()
    .query(`SELECT h.target_session_key FROM task_assignments a
    JOIN thread_handoffs h ON h.id=a.handoff_id
    WHERE a.task_id=? AND a.agent_id=? AND a.session_name=? AND a.status IN ('assigned','accepted','blocked')`)
    .get(task.id, agentId, sessionName) as { target_session_key: string } | null;
  if (frozen && existingKey && frozen.target_session_key !== existingKey)
    throw new Error("Task assignment session identity changed");
  return frozen?.target_session_key ?? existingKey ?? `agent:${agentId}:thread:${task.threadId}`;
}

/** Freeze the exact channel-free envelope once; retries replay the stored bytes. */
export function prepareTaskDispatch(task: TaskRecord, assignment: TaskAssignment, prompt: string): RuntimeLaunchPrompt {
  return getDb()
    .transaction(() => {
      const row = receipt(assignment.id);
      if (row.dispatch_payload_json) return JSON.parse(row.dispatch_payload_json) as RuntimeLaunchPrompt;
      if (row.task_id !== task.id || !["assigned", "accepted", "blocked"].includes(row.status))
        throw new Error("Task assignment is not active");
      const target = resolveSession(assignment.sessionName);
      if (!target || target.agentId !== assignment.agentId) throw new Error("Task assignment session differs");
      const prepared = prepareThreadHandoff({
        threadRef: task.threadId,
        prompt,
        targetSession: target,
        actor: { type: "system" },
        metadata: { assignmentId: assignment.id, taskId: task.id },
      });
      const payload: RuntimeLaunchPrompt = {
        prompt: `${prepared.brief.text}\n\n${prompt}`,
        deliveryBarrier: "after_task",
        _agentId: assignment.agentId,
        taskBarrierTaskId: task.id,
        _thread: prepared.promptMetadata,
        _taskAssignmentId: assignment.id,
        _taskSessionKey: target.sessionKey,
      };
      getDb()
        .query("UPDATE task_assignments SET dispatch_payload_json=?,handoff_id=? WHERE id=?")
        .run(JSON.stringify(payload), prepared.handoff.id, assignment.id);
      return payload;
    })
    .immediate();
}

/** Publication and runtime admission are independent receipts. */
export async function publishTaskDispatch(
  task: TaskRecord,
  assignment: TaskAssignment,
  prompt: string,
): Promise<boolean> {
  const row = receipt(assignment.id);
  if (row.execution_status !== "pending") return false;
  const payload = prepareTaskDispatch(task, assignment, prompt);
  await publishTaskSessionPrompt(assignment.sessionName, payload as unknown as Record<string, unknown>);
  getDb()
    .transaction(() => {
      getDb()
        .query("UPDATE task_assignments SET dispatch_published_at=COALESCE(dispatch_published_at,?) WHERE id=?")
        .run(Date.now(), assignment.id);
      const handoffId = receipt(assignment.id).handoff_id;
      if (handoffId) markThreadHandoffDelivered(handoffId);
    })
    .immediate();
  return true;
}

/** No lease expiry replays work: a crash after claim requires reconciliation. */
export async function admitTaskDispatch(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
  handle: (prompt: RuntimeLaunchPrompt) => Promise<void>,
): Promise<boolean> {
  if (!prompt._taskAssignmentId) return false;
  // Initialize/migrate task storage before entering the claim transaction.
  if (!prompt.taskBarrierTaskId || !dbGetTask(prompt.taskBarrierTaskId)) throw new Error("Task dispatch has no task");
  const id = prompt._taskAssignmentId;
  const expected = getDb()
    .transaction(() => {
      const row = receipt(id);
      const task = dbGetTask(row.task_id)!;
      if (row.session_name !== sessionName || !row.dispatch_payload_json)
        throw new Error("Task dispatch target differs");
      const frozen = JSON.parse(row.dispatch_payload_json) as RuntimeLaunchPrompt;
      if (
        prompt.prompt !== frozen.prompt ||
        prompt.taskBarrierTaskId !== task.id ||
        prompt._agentId !== row.agent_id ||
        prompt._taskSessionKey !== frozen._taskSessionKey ||
        JSON.stringify(prompt._thread) !== JSON.stringify(frozen._thread) ||
        prompt.source ||
        prompt._decisionDeliveryId
      )
        throw new Error("Task dispatch envelope differs");
      if (task.status === "done" || task.status === "failed" || row.status === "superseded") return null;
      if (row.execution_status !== "pending") return null;
      const session = resolveSession(sessionName);
      if (session?.agentId !== row.agent_id) throw new Error("Task dispatch target differs");
      const handoff = getDb()
        .query("SELECT target_session_key,thread_id FROM thread_handoffs WHERE id=?")
        .get(row.handoff_id) as { target_session_key: string; thread_id: string } | null;
      if (handoff?.target_session_key !== session.sessionKey || handoff.thread_id !== task.threadId)
        throw new Error("Task dispatch identity differs");
      getDb().query("UPDATE task_assignments SET execution_status='accepting' WHERE id=?").run(id);
      return frozen;
    })
    .immediate();
  if (!expected) return true;
  try {
    await handle(expected);
    getDb()
      .query(
        "UPDATE task_assignments SET execution_status='admitted',execution_admitted_at=? WHERE id=? AND execution_status='accepting'",
      )
      .run(Date.now(), id);
  } catch (error) {
    getDb()
      .query("UPDATE task_assignments SET execution_status='uncertain' WHERE id=? AND execution_status='accepting'")
      .run(id);
    throw error;
  }
  return true;
}

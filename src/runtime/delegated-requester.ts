import { dbGetContext, type ContextRecord } from "../router/router-db.js";
import { dbGetTaskDispatchRequester, type TaskDispatchRequesterRow } from "../tasks/task-db.js";
import { resolveHumanRequestCaller, type HumanRequestCaller } from "./human-request.js";
import { isDelegatedRequesterFresh, resolveThreadInheritedRequester } from "./thread-requester.js";
import { RUNTIME_TURN_ORIGIN_PROTOCOL, RUNTIME_TURN_ORIGIN_SCHEMA_VERSION } from "./turn-origin.js";

/**
 * Work the operator (or a contact) asked for keeps its requester when an agent
 * does it in another session: a Slack thread the parent session runs, or a task
 * the task runtime dispatches. Bases and the Console access calls then act for
 * that person, never for "an agent's relay". The person is proven by a stored
 * pointer to the turn their own verified message started (a turn-runtime
 * context), which `resolveHumanRequestCaller` re-checks every time it is used:
 * the context must still be a resolved human turn, the person must not be
 * blocked or opted out, and the turn must not have been withdrawn.
 *
 * Nothing here trusts text: not the prompt, not a contact named in it. A turn
 * no human asked into (an external message relayed by an agent, a cron, a
 * trigger) inherits nobody and stays refused.
 */

export interface TaskTurnRequester extends HumanRequestCaller {
  taskId: string;
  /** The stored context that proved the requester. */
  requesterContextId: string;
}

export interface DelegatedRequesterDeps {
  getContextById?: (contextId: string) => ContextRecord | null;
  resolveRequester?: typeof resolveHumanRequestCaller;
  getTaskDispatch?: (handoffId: string) => TaskDispatchRequesterRow | null;
  getThreadRequester?: typeof resolveThreadInheritedRequester;
  now?: number;
}

const ACTIVE_ASSIGNMENT = new Set(["assigned", "accepted", "blocked"]);
const TERMINAL_TASK = new Set(["done", "failed"]);
const MAX_LINEAGE_DEPTH = 32;

/**
 * The person behind a stored verified-request turn, resolved now. The turn is
 * replayed as the work handoff of its own agent from its own session, so the
 * same chain rules apply as to a live `sessions send|execute`.
 */
export function resolveRequesterContext(
  contextId: string,
  deps: DelegatedRequesterDeps = {},
): HumanRequestCaller | null {
  const context = (deps.getContextById ?? dbGetContext)(contextId);
  if (!context?.agentId) return null;
  return (deps.resolveRequester ?? resolveHumanRequestCaller)({
    _turnOrigin: {
      protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
      schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
      producer: "session-relay",
      action: "execute",
      principal: { type: "agent", id: context.agentId },
      ...(context.sessionKey ? { session: { key: context.sessionKey } } : {}),
      callerContextId: context.contextId,
    },
  });
}

/**
 * A task dispatch turn's requester: the turn must carry the host-issued
 * `raviThread` of a task scope (only a turn-runtime context does), its handoff
 * must be the one the task runtime froze for this task's active assignment to
 * this same agent, the task must not be finished or archived, and the task's
 * recorded requester must still resolve and be at most 72 hours old.
 */
export function resolveTaskTurnRequester(
  input: { raviThread: unknown; agentId: string | null | undefined },
  deps: DelegatedRequesterDeps = {},
): TaskTurnRequester | null {
  const thread = input.raviThread as { handoffId?: unknown; scope?: { type?: unknown; id?: unknown } } | undefined;
  if (!thread || typeof thread !== "object") return null;
  if (thread.scope?.type !== "task" || typeof thread.scope.id !== "string") return null;
  if (typeof thread.handoffId !== "string" || !thread.handoffId || !input.agentId) return null;
  const row = (deps.getTaskDispatch ?? dbGetTaskDispatchRequester)(thread.handoffId);
  if (!row || row.taskId !== thread.scope.id || row.assignmentAgentId !== input.agentId) return null;
  if (!ACTIVE_ASSIGNMENT.has(row.assignmentStatus) || TERMINAL_TASK.has(row.taskStatus) || row.taskArchived) {
    return null;
  }
  if (!row.requesterContextId) return null;
  const requester = resolveRequesterContext(row.requesterContextId, deps);
  if (!requester || !isDelegatedRequesterFresh(requester, deps)) return null;
  return { ...requester, taskId: row.taskId, requesterContextId: row.requesterContextId };
}

/**
 * Which verified-request turn to record for work the given context starts
 * (a task it creates): the CLI's context is walked up to the turn that runs
 * it, and that turn qualifies when it is itself a verified human request (a
 * person's message, or one an agent handed over with `humanRequest`), when it
 * is a thread turn that inherits the thread's requester, or when it is a task
 * turn with a requester (a subtask). Null otherwise: the task then has no
 * requester and its turns are refused in Bases, as before.
 */
export function resolveRequesterContextIdFor(
  start: ContextRecord | null | undefined,
  deps: DelegatedRequesterDeps = {},
): string | null {
  const turn = findTurnRuntimeContext(start, deps.getContextById ?? dbGetContext);
  if (!turn) return null;
  const meta = turn.metadata ?? {};
  const principal = typeof meta.actorPrincipal === "string" ? meta.actorPrincipal : "";

  if (principal.startsWith("contact:")) {
    return resolveRequesterContext(turn.contextId, deps) ? turn.contextId : null;
  }
  const task = resolveTaskTurnRequester({ raviThread: meta.raviThread, agentId: turn.agentId }, deps);
  if (task) return task.requesterContextId;
  if (principal.startsWith("agent:")) {
    const inherited = (deps.getThreadRequester ?? resolveThreadInheritedRequester)({
      sessionKey: turn.sessionKey ?? null,
      turnOrigin: meta.turnOrigin,
      relayAgentId: principal.slice("agent:".length),
    });
    if (inherited) return inherited.threadTurn.contextId;
  }
  return null;
}

function findTurnRuntimeContext(
  start: ContextRecord | null | undefined,
  getById: (contextId: string) => ContextRecord | null,
): ContextRecord | null {
  const seen = new Set<string>();
  let cursor: ContextRecord | null | undefined = start;
  while (cursor && !seen.has(cursor.contextId) && seen.size < MAX_LINEAGE_DEPTH) {
    seen.add(cursor.contextId);
    if (cursor.kind === "turn-runtime") return cursor;
    const parentId = cursor.metadata?.parentContextId;
    if (typeof parentId !== "string" || !parentId) return null;
    cursor = getById(parentId);
  }
  return null;
}

import type { ObservationPromptMetadata } from "../runtime/message-types.js";
import { logger } from "../utils/logger.js";
import {
  dbClaimTaskObserverDelivery,
  dbGetTaskObserverState,
  dbSaveTaskObserverState,
  emptyTaskObserverState,
  isTaskObserverRuleId,
  parseTaskObserverVerdict,
  TASK_OBSERVER_ACTOR,
  TASK_OBSERVER_MAX_NUDGES,
  TASK_OBSERVER_ROLE,
  type TaskObserverChecklistItem,
  type TaskObserverState,
  type TaskObserverVerdict,
} from "./observer-contract.js";
import { neutralizeSystemMarkers, normalizeTaskProgressMessage } from "./progress-contract.js";
import { blockTask, completeTask, emitTaskEvent, failTask, reportTaskProgress, reportTaskStall } from "./service.js";
import { publishTaskSessionPrompt } from "./session-publisher.js";
import { dbAppendTaskEvent, dbGetActiveAssignment, dbGetTask, dbTouchTaskCheckpoint } from "./task-db.js";
import type { TaskEvent, TaskRecord } from "./types.js";

const log = logger.child("tasks:observer");

export type TaskObserverAction = "unchanged" | "progress" | "blocked" | "done" | "failed" | "nudged" | "stalled";

export interface TaskObserverApplyResult {
  applied: boolean;
  reason: string;
  taskId?: string;
  action?: TaskObserverAction;
}

const ACTIVE_TASK_STATUSES = new Set<TaskRecord["status"]>(["dispatched", "in_progress", "blocked"]);

function countDone(checklist: TaskObserverChecklistItem[]): number {
  return checklist.filter((entry) => entry.done).length;
}

function resolveObservedProgress(
  task: TaskRecord,
  verdict: TaskObserverVerdict,
  checklist: TaskObserverChecklistItem[],
): number {
  const derived = checklist.length > 0 ? (countDone(checklist) / checklist.length) * 100 : undefined;
  const value = verdict.progress ?? derived ?? task.progress;
  // Only a done verdict closes the task, so an observed progress never reads 100%.
  return Math.max(0, Math.min(99, Math.round(value)));
}

function cleanMessage(value: string | undefined): string | undefined {
  const normalized = normalizeTaskProgressMessage(value);
  return normalized ? neutralizeSystemMarkers(normalized) : undefined;
}

async function emitMutation(result: {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents?: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
}): Promise<void> {
  if (result.wasNoop) return;
  await emitTaskEvent(result.task, result.event);
  for (const related of result.relatedEvents ?? []) {
    await emitTaskEvent(related.task, related.event);
  }
}

export function buildTaskObserverNudgePrompt(task: TaskRecord, missing: string): string {
  return `[System] Execute: Continue task ${task.id} (${neutralizeSystemMarkers(task.title)}).

The task observer read your last turn and the task is not done yet.
Missing: ${neutralizeSystemMarkers(missing)}

Keep working until it is done, or say plainly what blocks you.`;
}

async function nudgeWorker(input: {
  task: TaskRecord;
  workerSessionName: string;
  missing: string;
  actor: { actor: string; agentId?: string; sessionName: string };
}): Promise<void> {
  const { event } = dbAppendTaskEvent(input.task.id, "task.nudged", {
    ...input.actor,
    message: neutralizeSystemMarkers(input.missing),
    progress: input.task.progress,
  });
  await emitTaskEvent(input.task, event);
  await publishTaskSessionPrompt(input.workerSessionName, {
    prompt: buildTaskObserverNudgePrompt(input.task, input.missing),
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _taskRuntime: { taskId: input.task.id, kind: "nudge", event: "task.nudged" },
  });
}

/** Record a stall and tell the requester. Shared with the checkpoint runner's silence detector. */
export async function recordTaskStall(
  task: TaskRecord,
  message: string,
  actor: { actor: string; agentId?: string; sessionName?: string },
): Promise<TaskEvent> {
  const { task: current, event } = dbAppendTaskEvent(task.id, "task.stalled", {
    ...actor,
    message: neutralizeSystemMarkers(message),
    progress: task.progress,
  });
  await emitTaskEvent(current, event);
  try {
    await reportTaskStall(current, event);
  } catch (error) {
    log.warn("Failed to report task stall", { taskId: task.id, error });
  }
  return event;
}

/**
 * Apply the verdict of one built-in task-observer turn.
 *
 * The observer only writes text; this function is the only path from its
 * verdict to the task. It is scoped to the task the delivery was composed for
 * and to that task's current assignee, and it applies each delivery once.
 */
export async function applyTaskObserverTurn(input: {
  observation: ObservationPromptMetadata;
  text: string;
  observerSessionName: string;
  observerAgentId?: string;
  now?: number;
}): Promise<TaskObserverApplyResult> {
  const { observation } = input;
  if (observation.role !== TASK_OBSERVER_ROLE || !isTaskObserverRuleId(observation.ruleId)) {
    return { applied: false, reason: "not_task_observer" };
  }
  const taskId = observation.taskId;
  if (!taskId) return { applied: false, reason: "no_task" };
  const task = dbGetTask(taskId);
  if (!task) return { applied: false, reason: "task_not_found", taskId };
  if (!ACTIVE_TASK_STATUSES.has(task.status) || task.archivedAt) {
    return { applied: false, reason: "task_inactive", taskId };
  }
  const assignment = dbGetActiveAssignment(taskId);
  if (!assignment || assignment.sessionName !== observation.sourceSessionName) {
    return { applied: false, reason: "not_assignee", taskId };
  }
  const now = input.now ?? Date.now();
  const deliveryId = observation.deliveryId ?? `${observation.bindingId}:${observation.eventIds.join(",")}`;
  if (!dbClaimTaskObserverDelivery(deliveryId, taskId, now)) {
    return { applied: false, reason: "duplicate_delivery", taskId };
  }

  // Reading the worker at all proves it is alive: the silence detector restarts.
  if (task.status !== "blocked") dbTouchTaskCheckpoint(taskId, now);

  const parsed = parseTaskObserverVerdict(input.text);
  if (!parsed.ok) {
    log.warn("Task observer reply has no valid verdict", {
      taskId,
      observerSessionName: input.observerSessionName,
      reason: parsed.reason,
      error: parsed.ok ? undefined : parsed.error,
    });
    return { applied: false, reason: `verdict_${parsed.reason}`, taskId };
  }

  const verdict = parsed.verdict;
  const previous = dbGetTaskObserverState(taskId) ?? emptyTaskObserverState(taskId, now);
  const checklist = verdict.checklist ?? previous.checklist;
  const progress = resolveObservedProgress(task, verdict, checklist);
  const moved = progress > task.progress || countDone(checklist) > countDone(previous.checklist);
  const message = cleanMessage(verdict.message) ?? cleanMessage(verdict.evidence);
  const actor = {
    actor: TASK_OBSERVER_ACTOR,
    ...(input.observerAgentId ? { agentId: input.observerAgentId } : {}),
    sessionName: input.observerSessionName,
  };
  const next: TaskObserverState = {
    ...previous,
    checklist,
    lastStatus: verdict.status,
    ...(message ? { lastMessage: message } : {}),
    lastVerdictAt: now,
    lastDeliveryId: deliveryId,
    verdictCount: previous.verdictCount + 1,
    ...(moved ? { nudgesSinceProgress: 0, stalledAt: undefined } : {}),
    updatedAt: now,
  };

  let action: TaskObserverAction = "unchanged";
  switch (verdict.status) {
    case "progress": {
      if (!moved && (!message || message === previous.lastMessage)) break;
      await emitMutation(
        reportTaskProgress(taskId, {
          ...actor,
          message: message ?? "Work advanced, per the task observer.",
          progress,
        }),
      );
      next.nudgesSinceProgress = 0;
      next.stalledAt = undefined;
      action = "progress";
      break;
    }
    case "blocked": {
      const reason = message ?? cleanMessage(verdict.missing) ?? "Blocked, per the task observer.";
      if (task.status === "blocked" && task.blockerReason === reason) break;
      await emitMutation(blockTask(taskId, { ...actor, message: reason, progress }));
      action = "blocked";
      break;
    }
    case "done": {
      await emitMutation(await completeTask(taskId, { ...actor, message: message ?? "Done, per the task observer." }));
      action = "done";
      break;
    }
    case "failed": {
      await emitMutation(failTask(taskId, { ...actor, message: message ?? "Failed, per the task observer." }));
      action = "failed";
      break;
    }
    case "stopped": {
      // A pulse reads a turn that is still running; only its end can show a stop.
      if (observation.trigger === "pulse" || task.status === "blocked") break;
      const missing =
        cleanMessage(verdict.missing) ?? message ?? "The task is not done and the last turn ended without a result.";
      if (next.nudgesSinceProgress < TASK_OBSERVER_MAX_NUDGES) {
        await nudgeWorker({ task, workerSessionName: assignment.sessionName, missing, actor });
        next.nudgesSinceProgress += 1;
        action = "nudged";
      } else if (next.stalledAt === undefined) {
        await recordTaskStall(task, `Stopped after a nudge. Missing: ${missing}`, actor);
        next.stalledAt = now;
        action = "stalled";
      }
      break;
    }
    case "unchanged":
      break;
  }

  dbSaveTaskObserverState(next);
  return { applied: true, reason: "applied", taskId, action };
}

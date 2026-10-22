import type { TaskRecord } from "../../tasks/types.js";
import type { RaiseSignalResult } from "../types.js";
import { raiseSignal } from "../service.js";
import { readTaskRuntimeSubject, taskSubjectIsTerminal } from "../subjects.js";

export interface TaskRuntimeObservation {
  turnActive: boolean;
  pendingCount: number;
}

export type TaskSignalClassification =
  | { action: "none"; reason: "archived" | "ephemeral_ended" | "terminal" | "missing" | "unknown" }
  | { action: "orphan"; key: string }
  | { action: "stall"; key: string };

export function classifyTaskSignal(
  task: Pick<TaskRecord, "id" | "status">,
  observation: TaskRuntimeObservation | null,
  now = Date.now(),
): TaskSignalClassification {
  const runtime = readTaskRuntimeSubject(task.id, now);
  if (!runtime) return { action: "none", reason: "missing" };
  if (taskSubjectIsTerminal(runtime)) {
    return {
      action: "none",
      reason: runtime.archivedAt !== null ? "archived" : runtime.sessionEnded ? "ephemeral_ended" : "terminal",
    };
  }
  if (!observation) return { action: "none", reason: "unknown" };
  if (observation.turnActive) {
    return { action: "stall", key: `task.stalled.${task.id}` };
  }
  if (observation.pendingCount > 0) {
    return { action: "none", reason: "unknown" };
  }
  return { action: "orphan", key: `task.orphaned.${task.id}` };
}

export function raiseTaskStallSignal(input: {
  task: TaskRecord;
  observation: TaskRuntimeObservation | null;
  sourceSession: string;
  detail?: string;
  now?: number;
}): { classification: TaskSignalClassification; raised?: RaiseSignalResult } {
  const now = input.now ?? Date.now();
  const classification = classifyTaskSignal(input.task, input.observation, now);
  if (classification.action === "none") {
    return { classification };
  }
  const scopeAgentId = input.task.assigneeAgentId;
  const scopeType = scopeAgentId ? "agent" : "fleet";
  const scopeId = scopeAgentId ?? "fleet";
  const producerId = `task-observer:${input.sourceSession}`;
  if (classification.action === "stall") {
    const raised = raiseSignal({
      key: classification.key,
      kind: "judgment",
      producerId,
      producerClass: "task-observer",
      producerType: "agent",
      scopeType,
      scopeId,
      subjectType: "task",
      subjectId: input.task.id,
      severity: "piggyback",
      title: `Task ${input.task.id} has an active turn without progress`,
      detail: input.detail ?? "The session turn is active but no progress was reported.",
      evidence: {
        task: input.task.id,
        turn_active: input.observation?.turnActive ?? null,
        pending_count: input.observation?.pendingCount ?? null,
        progress: input.task.progress,
        last_updated_at: input.task.updatedAt,
        source_session: input.sourceSession,
      },
      clearWhen: { type: "decay", after_ms: 6 * 3_600_000 },
      cooldownMs: 12 * 3_600_000,
      renotifyAfterMs: 24 * 3_600_000,
      maxSurfaces: 3,
      ttlMs: 24 * 3_600_000,
      reopenAfterMs: 6 * 3_600_000,
      now,
    });
    return { classification, raised };
  }
  const raised = raiseSignal({
    key: classification.key,
    kind: "fact",
    producerId: `task-runtime:${input.sourceSession}`,
    producerClass: "code",
    producerType: "code",
    scopeType,
    scopeId,
    subjectType: "task",
    subjectId: input.task.id,
    severity: "piggyback",
    title: `Task ${input.task.id} is open without an active turn`,
    detail: "The task is in progress but its session has no active turn or queued prompt.",
    evidence: {
      task: input.task.id,
      turn_active: false,
      pending_count: 0,
      progress: input.task.progress,
      last_updated_at: input.task.updatedAt,
      source_session: input.sourceSession,
    },
    clearWhen: { type: "probe", probe: "task.state", expr: "terminal == 1", recheck_ms: 15 * 60_000, grace_ms: 0 },
    cooldownMs: 24 * 3_600_000,
    renotifyAfterMs: 24 * 3_600_000,
    escalateAfterMs: null,
    maxSurfaces: 1,
    ttlMs: 7 * 86_400_000,
    reopenAfterMs: 3_600_000,
    now,
  });
  return { classification, raised };
}

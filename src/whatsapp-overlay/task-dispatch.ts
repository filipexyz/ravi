import {
  getDefaultTaskSessionName,
  renderTaskSessionTemplate,
  type TaskStreamSelection,
  type TaskStreamTaskEntity,
} from "../tasks/index.js";

export type OverlayTaskDispatchSessionCandidate = {
  sessionName: string;
  agentId: string;
};

export type OverlayTaskDispatchState = {
  allowed: boolean;
  reason: "archived" | "not_open" | "assigned" | null;
  defaultSessionName: string;
  defaultAgentId: string | null;
  defaultReportToSessionName: string | null;
};

export function resolveOverlayTaskDefaultSessionName(
  task: Pick<TaskStreamTaskEntity, "id" | "profileId" | "taskProfile">,
) {
  const template = task.taskProfile?.sessionNameTemplate;
  if (typeof template === "string" && template.trim()) {
    return renderTaskSessionTemplate(template, task.id);
  }
  return getDefaultTaskSessionName(task.id, task.profileId);
}

function cleanDispatchValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildOverlayTaskDispatchState(
  selection: Pick<TaskStreamSelection, "task" | "activeAssignment"> | null | undefined,
  options: {
    actorSessionName?: string | null;
    actorAgentId?: string | null;
    availableSessions?: OverlayTaskDispatchSessionCandidate[] | null;
  } = {},
): OverlayTaskDispatchState | null {
  const task = selection?.task;
  if (!task) {
    return null;
  }

  const defaultSessionName = resolveOverlayTaskDefaultSessionName(task);
  const availableSessions = Array.isArray(options.availableSessions)
    ? options.availableSessions.filter(
        (session) => cleanDispatchValue(session?.sessionName) && cleanDispatchValue(session?.agentId),
      )
    : [];
  const matchingSession =
    availableSessions.find((session) => cleanDispatchValue(session.sessionName) === defaultSessionName) ?? null;
  const defaultAgentId =
    cleanDispatchValue(task.assigneeAgentId) ??
    cleanDispatchValue(selection?.activeAssignment?.agentId) ??
    cleanDispatchValue(matchingSession?.agentId) ??
    cleanDispatchValue(options.actorAgentId) ??
    cleanDispatchValue(task.createdByAgentId) ??
    cleanDispatchValue(availableSessions[0]?.agentId) ??
    null;
  const defaultReportToSessionName =
    cleanDispatchValue(selection?.activeAssignment?.reportToSessionName) ??
    cleanDispatchValue(task.reportToSessionName) ??
    cleanDispatchValue(options.actorSessionName) ??
    cleanDispatchValue(task.createdBySessionName) ??
    cleanDispatchValue(availableSessions[0]?.sessionName) ??
    null;

  if (task.archivedAt) {
    return {
      allowed: false,
      reason: "archived",
      defaultSessionName,
      defaultAgentId,
      defaultReportToSessionName,
    };
  }
  if (task.status !== "open") {
    return {
      allowed: false,
      reason: "not_open",
      defaultSessionName,
      defaultAgentId,
      defaultReportToSessionName,
    };
  }
  if (selection?.activeAssignment || task.assigneeAgentId || task.assigneeSessionName) {
    return {
      allowed: false,
      reason: "assigned",
      defaultSessionName,
      defaultAgentId,
      defaultReportToSessionName,
    };
  }

  return {
    allowed: true,
    reason: null,
    defaultSessionName,
    defaultAgentId,
    defaultReportToSessionName,
  };
}

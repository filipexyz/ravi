import { getAgent } from "../router/config.js";
import { expandHome } from "../router/resolver.js";
import { logger } from "../utils/logger.js";
import { evaluateFilter } from "../triggers/filter.js";
import { resolveTemplate } from "../triggers/template.js";
import {
  requireTaskProfileDefinition,
  resolveTaskProfileArtifacts,
  resolveTaskProfileForTask,
  resolveTaskProfileInputValues,
  resolveTaskProfilePrimaryArtifact,
  taskProfileUsesTaskDocument,
} from "./profiles.js";
import { getTaskDocPath } from "./task-doc.js";
import { dbGetActiveAssignment, dbGetTask, dbListAssignments } from "./task-db.js";
import {
  dbClaimTaskAutomationRun,
  dbCreateTaskAutomation,
  dbDeleteTaskAutomation,
  dbFinalizeTaskAutomationRun,
  dbGetTaskAutomation,
  dbListTaskAutomationRuns,
  dbListTaskAutomations,
  dbRecordTaskAutomationFire,
  dbUpdateTaskAutomation,
} from "./automations-db.js";
import type {
  CreateTaskInput,
  DispatchTaskInput,
  TaskAssignment,
  TaskAutomation,
  TaskAutomationEventType,
  TaskAutomationInput,
  TaskAutomationRun,
  TaskEvent,
  TaskPriority,
  TaskRecord,
  TaskReportEvent,
  TaskWorktreeConfig,
} from "./types.js";
import { buildTaskSessionLink, formatTaskWorktree, resolveTaskWorktreeContext } from "./service.js";

const log = logger.child("tasks:automations");

export interface TaskAutomationExecutionResult {
  automation: TaskAutomation;
  run: TaskAutomationRun;
  spawnedTask?: TaskRecord;
  dispatchSessionName?: string;
}

function trimOrUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAutomationInput(input: TaskAutomationInput): TaskAutomationInput {
  const normalizedName = input.name.trim();
  if (!normalizedName) {
    throw new Error("Task automation name is required.");
  }

  const titleTemplate = input.titleTemplate.trim();
  if (!titleTemplate) {
    throw new Error("Task automation title template is required.");
  }

  const instructionsTemplate = input.instructionsTemplate.trim();
  if (!instructionsTemplate) {
    throw new Error("Task automation instructions template is required.");
  }

  if (input.agentId) {
    const agent = getAgent(input.agentId.trim());
    if (!agent) {
      throw new Error(`Agent not found in runtime config: ${input.agentId}`);
    }
  }

  if (input.profileId) {
    requireTaskProfileDefinition(input.profileId.trim());
  }

  const profileInput =
    input.profileInput && Object.keys(input.profileInput).length > 0
      ? Object.fromEntries(
          Object.entries(input.profileInput).map(([key, value]) => {
            const normalizedKey = key.trim();
            if (!normalizedKey) {
              throw new Error("Task automation input keys cannot be empty.");
            }
            return [normalizedKey, String(value)];
          }),
        )
      : undefined;

  return {
    ...input,
    name: normalizedName,
    titleTemplate,
    instructionsTemplate,
    ...(input.agentId ? { agentId: input.agentId.trim() } : {}),
    ...(input.profileId ? { profileId: input.profileId.trim() } : {}),
    ...(trimOrUndefined(input.sessionNameTemplate)
      ? { sessionNameTemplate: trimOrUndefined(input.sessionNameTemplate) }
      : {}),
    ...(trimOrUndefined(input.reportToSessionNameTemplate)
      ? { reportToSessionNameTemplate: trimOrUndefined(input.reportToSessionNameTemplate) }
      : {}),
    ...(trimOrUndefined(input.filter)
      ? { filter: trimOrUndefined(input.filter) }
      : input.filter !== undefined
        ? { filter: undefined }
        : {}),
    ...(profileInput ? { profileInput } : {}),
  };
}

function normalizeAutomationUpdate(
  updates: Partial<TaskAutomationInput> & { enabled?: boolean },
): Partial<TaskAutomationInput> & { enabled?: boolean } {
  if (updates.name !== undefined && !updates.name.trim()) {
    throw new Error("Task automation name cannot be empty.");
  }
  if (updates.titleTemplate !== undefined && !updates.titleTemplate.trim()) {
    throw new Error("Task automation title template cannot be empty.");
  }
  if (updates.instructionsTemplate !== undefined && !updates.instructionsTemplate.trim()) {
    throw new Error("Task automation instructions template cannot be empty.");
  }
  if (updates.agentId !== undefined) {
    const normalizedAgentId = trimOrUndefined(updates.agentId);
    if (normalizedAgentId) {
      const agent = getAgent(normalizedAgentId);
      if (!agent) {
        throw new Error(`Agent not found in runtime config: ${normalizedAgentId}`);
      }
    }
  }
  if (updates.profileId !== undefined) {
    const normalizedProfileId = trimOrUndefined(updates.profileId);
    if (normalizedProfileId) {
      requireTaskProfileDefinition(normalizedProfileId);
    }
  }

  return {
    ...updates,
    ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
    ...(updates.titleTemplate !== undefined ? { titleTemplate: updates.titleTemplate.trim() } : {}),
    ...(updates.instructionsTemplate !== undefined
      ? { instructionsTemplate: updates.instructionsTemplate.trim() }
      : {}),
    ...(updates.agentId !== undefined ? { agentId: trimOrUndefined(updates.agentId) } : {}),
    ...(updates.profileId !== undefined ? { profileId: trimOrUndefined(updates.profileId) } : {}),
    ...(updates.sessionNameTemplate !== undefined
      ? { sessionNameTemplate: trimOrUndefined(updates.sessionNameTemplate) }
      : {}),
    ...(updates.reportToSessionNameTemplate !== undefined
      ? { reportToSessionNameTemplate: trimOrUndefined(updates.reportToSessionNameTemplate) }
      : {}),
    ...(updates.filter !== undefined ? { filter: trimOrUndefined(updates.filter) } : {}),
    ...(updates.profileInput !== undefined
      ? {
          profileInput:
            updates.profileInput && Object.keys(updates.profileInput).length > 0
              ? Object.fromEntries(
                  Object.entries(updates.profileInput).map(([key, value]) => {
                    const normalizedKey = key.trim();
                    if (!normalizedKey) {
                      throw new Error("Task automation input keys cannot be empty.");
                    }
                    return [normalizedKey, String(value)];
                  }),
                )
              : undefined,
        }
      : {}),
  };
}

function toAutomationEventType(type: TaskEvent["type"]): TaskAutomationEventType | null {
  switch (type) {
    case "task.blocked":
    case "task.done":
    case "task.failed":
    case "task.child.blocked":
    case "task.child.done":
    case "task.child.failed":
      return type;
    default:
      return null;
  }
}

interface AutomationArtifactModel {
  primary: { kind: string; label: string; path: string } | null;
  items: Array<{ kind: string; label: string; path: string }>;
  byKind: Record<string, { kind: string; label: string; path: string }>;
  taskDocPath: string;
}

function resolveAutomationEffectiveCwd(task: TaskRecord): string {
  const agentId = trimOrUndefined(task.assigneeAgentId) ?? trimOrUndefined(task.createdByAgentId);
  if (!agentId) {
    return process.cwd();
  }

  const agent = getAgent(agentId);
  return agent?.cwd ? expandHome(agent.cwd) : process.cwd();
}

function resolveAutomationWorktree(
  task: TaskRecord,
  assignment?: TaskAssignment | null,
): TaskWorktreeConfig | undefined {
  const taskProfile = resolveTaskProfileForTask(task);
  return resolveTaskWorktreeContext(
    resolveAutomationEffectiveCwd(task),
    task,
    taskProfile,
    assignment?.worktree ?? task.worktree,
  );
}

function buildAutomationArtifactModel(task: TaskRecord, assignment?: TaskAssignment | null): AutomationArtifactModel {
  const taskProfile = resolveTaskProfileForTask(task);
  const effectiveCwd = resolveAutomationEffectiveCwd(task);
  const worktree = resolveAutomationWorktree(task, assignment);
  const taskDocPath = taskProfileUsesTaskDocument(taskProfile) && task.taskDir ? getTaskDocPath(task) : "";
  const artifactOptions = {
    effectiveCwd,
    taskProfile,
    ...(worktree ? { worktree } : {}),
    ...(taskDocPath ? { taskDocPath } : {}),
    ...(trimOrUndefined(task.assigneeAgentId) ? { agentId: trimOrUndefined(task.assigneeAgentId) } : {}),
    ...(trimOrUndefined(task.assigneeSessionName) ? { sessionName: trimOrUndefined(task.assigneeSessionName) } : {}),
  };
  const items = resolveTaskProfileArtifacts(task, artifactOptions).map((artifact) => ({
    kind: artifact.kind,
    label: artifact.label,
    path: artifact.path,
  }));
  const primaryArtifact = resolveTaskProfilePrimaryArtifact(task, artifactOptions);

  return {
    primary: primaryArtifact
      ? {
          kind: primaryArtifact.kind,
          label: primaryArtifact.label,
          path: primaryArtifact.path,
        }
      : null,
    items,
    byKind: Object.fromEntries(items.map((artifact) => [artifact.kind, artifact])),
    taskDocPath,
  };
}

function buildAutomationTemplateContext(task: TaskRecord, event: TaskEvent, assignment?: TaskAssignment | null) {
  const taskProfile = resolveTaskProfileForTask(task);
  const sourceInput = resolveTaskProfileInputValues(taskProfile, task.profileInput);
  const sourceWorktree = resolveAutomationWorktree(task, assignment);
  const sourceArtifacts = buildAutomationArtifactModel(task, assignment);
  const sourceTaskSession = buildTaskSessionLink(task);
  const sourceProjectDir =
    sourceInput.video_id && sourceWorktree?.path
      ? `${sourceWorktree.path}/out/${sourceInput.video_id}`
      : (task.taskDir ?? "");
  const parentTask = task.parentTaskId ? dbGetTask(task.parentTaskId) : null;
  const relatedTask = event.relatedTaskId ? dbGetTask(event.relatedTaskId) : null;
  return {
    topic: `ravi.task.${task.id}.event`,
    data: {
      task: {
        ...task,
        profileId: task.profileId ?? taskProfile.id,
        profileVersion: task.profileVersion ?? taskProfile.version,
        profileSource: task.profileSource ?? taskProfile.source,
      },
      taskProfile,
      event,
      activeAssignment: assignment ?? null,
      assignments: dbListAssignments(task.id),
      parentTask,
      parentTaskProfile: parentTask ? resolveTaskProfileForTask(parentTask) : null,
      relatedTask,
      relatedTaskProfile: relatedTask ? resolveTaskProfileForTask(relatedTask) : null,
      source: {
        task: {
          id: task.id,
          title: task.title,
          instructions: task.instructions,
          status: task.status,
          priority: task.priority,
          progress: task.progress,
          summary: task.summary ?? "",
          blockerReason: task.blockerReason ?? "",
          parentTaskId: task.parentTaskId ?? "",
          reportToSessionName: task.reportToSessionName ?? "",
          createdBySessionName: task.createdBySessionName ?? "",
          assigneeAgentId: task.assigneeAgentId ?? "",
          assigneeSessionName: task.assigneeSessionName ?? "",
        },
        profile: {
          id: taskProfile.id,
          version: taskProfile.version,
          source: taskProfile.source,
          sourceKind: taskProfile.sourceKind,
          label: taskProfile.label,
        },
        input: sourceInput,
        event: {
          id: event.id,
          type: event.type,
          message: event.message ?? "",
          progress: typeof event.progress === "number" ? event.progress : "",
          createdAt: event.createdAt,
        },
        worktree: {
          mode: sourceWorktree?.mode ?? "inherit",
          path: sourceWorktree?.path ?? "",
          branch: sourceWorktree?.branch ?? "",
          label: formatTaskWorktree(sourceWorktree),
        },
        projectDir: sourceProjectDir,
        artifacts: sourceArtifacts,
        taskDocPath: sourceArtifacts.taskDocPath,
        taskSession: sourceTaskSession
          ? {
              alias: sourceTaskSession.alias,
              sessionName: sourceTaskSession.sessionName,
              readCommand: sourceTaskSession.readCommand,
              debugCommand: sourceTaskSession.debugCommand,
              toolTopic: sourceTaskSession.toolTopic,
            }
          : null,
      },
    },
  };
}

function renderTemplateValue(template: string, context: { topic: string; data: unknown }): string {
  return resolveTemplate(template, context).trim();
}

function renderProfileInput(
  profileInput: Record<string, string> | undefined,
  context: { topic: string; data: unknown },
): Record<string, string> | undefined {
  if (!profileInput || Object.keys(profileInput).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(profileInput).map(([key, value]) => [key, resolveTemplate(value, context).trim()]),
  );
}

function resolveAutomationPriority(automation: TaskAutomation, task: TaskRecord): TaskPriority {
  return automation.priority ?? task.priority;
}

function resolveAutomationProfileId(automation: TaskAutomation, task: TaskRecord): string {
  return automation.profileId ?? task.profileId ?? resolveTaskProfileForTask(task).id;
}

function resolveInheritedCheckpoint(
  automation: TaskAutomation,
  task: TaskRecord,
  assignment?: TaskAssignment | null,
): number | undefined {
  if (typeof automation.checkpointIntervalMs === "number") {
    return automation.checkpointIntervalMs;
  }
  if (!automation.inheritCheckpoint) {
    return undefined;
  }
  return assignment?.checkpointIntervalMs ?? task.checkpointIntervalMs;
}

function resolveInheritedReportTo(
  automation: TaskAutomation,
  task: TaskRecord,
  assignment: TaskAssignment | null | undefined,
  context: { topic: string; data: unknown },
): string | undefined {
  const explicit = trimOrUndefined(
    automation.reportToSessionNameTemplate
      ? renderTemplateValue(automation.reportToSessionNameTemplate, context)
      : undefined,
  );
  if (explicit) {
    return explicit;
  }
  if (!automation.inheritReportTo) {
    return undefined;
  }
  return trimOrUndefined(assignment?.reportToSessionName) ?? trimOrUndefined(task.reportToSessionName);
}

function resolveInheritedReportEvents(
  automation: TaskAutomation,
  task: TaskRecord,
  assignment?: TaskAssignment | null,
): TaskReportEvent[] | undefined {
  if (automation.reportEvents && automation.reportEvents.length > 0) {
    return automation.reportEvents;
  }
  if (!automation.inheritReportEvents) {
    return undefined;
  }
  return assignment?.reportEvents ?? task.reportEvents;
}

function resolveInheritedWorktree(
  automation: TaskAutomation,
  task: TaskRecord,
  assignment?: TaskAssignment | null,
): TaskWorktreeConfig | undefined {
  if (!automation.inheritWorktree) {
    return undefined;
  }
  return assignment?.worktree ?? task.worktree;
}

export function createTaskAutomation(input: TaskAutomationInput): TaskAutomation {
  return dbCreateTaskAutomation(normalizeAutomationInput(input));
}

export function getTaskAutomation(id: string): TaskAutomation | null {
  return dbGetTaskAutomation(id);
}

export function listTaskAutomations(opts?: { enabledOnly?: boolean }): TaskAutomation[] {
  return dbListTaskAutomations(opts);
}

export function updateTaskAutomation(
  id: string,
  updates: Partial<TaskAutomationInput> & { enabled?: boolean },
): TaskAutomation {
  return dbUpdateTaskAutomation(id, normalizeAutomationUpdate(updates));
}

export function deleteTaskAutomation(id: string): boolean {
  return dbDeleteTaskAutomation(id);
}

export function listTaskAutomationRuns(automationId: string, limit = 20): TaskAutomationRun[] {
  return dbListTaskAutomationRuns(automationId, limit);
}

export async function executeTaskAutomation(
  automation: TaskAutomation,
  task: TaskRecord,
  event: TaskEvent,
): Promise<TaskAutomationExecutionResult | null> {
  const eventType = toAutomationEventType(event.type);
  if (!eventType) {
    return null;
  }
  if (!automation.enabled || !automation.eventTypes.includes(eventType)) {
    return null;
  }
  if (typeof event.id !== "number") {
    throw new Error(`Task automation execution requires a persisted event id for ${task.id}/${event.type}.`);
  }

  const assignment = dbGetActiveAssignment(task.id);
  const context = buildAutomationTemplateContext(task, event, assignment);
  const claimedRun = dbClaimTaskAutomationRun({
    automationId: automation.id,
    triggerTaskId: task.id,
    triggerEventId: event.id,
    triggerEventType: eventType,
    message: `Claimed for ${task.id}/${event.type}`,
  });
  if (!claimedRun) {
    return null;
  }
  try {
    if (!evaluateFilter(automation.filter, context.data)) {
      const run = dbFinalizeTaskAutomationRun(claimedRun.id, {
        status: "skipped",
        message: "Filter did not match.",
      });
      return { automation, run };
    }

    const title = renderTemplateValue(automation.titleTemplate, context);
    if (!title) {
      throw new Error(`Task automation ${automation.id} rendered an empty follow-up title.`);
    }

    const instructions = renderTemplateValue(automation.instructionsTemplate, context);
    if (!instructions) {
      throw new Error(`Task automation ${automation.id} rendered empty follow-up instructions.`);
    }

    const profileInput = renderProfileInput(automation.profileInput, context);
    const checkpointIntervalMs = resolveInheritedCheckpoint(automation, task, assignment);
    const reportToSessionName = resolveInheritedReportTo(automation, task, assignment, context);
    const reportEvents = resolveInheritedReportEvents(automation, task, assignment);
    const worktree = resolveInheritedWorktree(automation, task, assignment);
    const taskInput: CreateTaskInput = {
      title,
      instructions,
      priority: resolveAutomationPriority(automation, task),
      profileId: resolveAutomationProfileId(automation, task),
      ...(profileInput ? { profileInput } : {}),
      ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
      ...(reportToSessionName ? { reportToSessionName } : {}),
      ...(reportEvents ? { reportEvents } : {}),
      ...(automation.inheritParentTask ? { parentTaskId: task.id } : {}),
      ...(worktree ? { worktree } : {}),
      createdBy: `task automation:${automation.id}`,
    };

    const taskService = await import("./service.js");
    const created = taskService.createTask(taskInput);
    await taskService.emitTaskEvent(created.task, created.event);

    let spawnedTask = created.task;
    let dispatchSessionName: string | undefined;

    const normalizedAgentId = trimOrUndefined(automation.agentId);
    if (normalizedAgentId) {
      if (!getAgent(normalizedAgentId)) {
        throw new Error(`Agent not found in runtime config: ${normalizedAgentId}`);
      }

      const renderedSessionName = trimOrUndefined(
        automation.sessionNameTemplate ? renderTemplateValue(automation.sessionNameTemplate, context) : undefined,
      );
      const dispatchInput: DispatchTaskInput = {
        agentId: normalizedAgentId,
        sessionName:
          renderedSessionName ?? taskService.getDefaultTaskSessionName(created.task.id, created.task.profileId ?? null),
        assignedBy: `task automation:${automation.id}`,
        ...(typeof taskInput.checkpointIntervalMs === "number"
          ? { checkpointIntervalMs: taskInput.checkpointIntervalMs }
          : {}),
        ...(taskInput.reportToSessionName ? { reportToSessionName: taskInput.reportToSessionName } : {}),
        ...(taskInput.reportEvents ? { reportEvents: taskInput.reportEvents } : {}),
        ...(taskInput.worktree ? { worktree: taskInput.worktree } : {}),
      };
      const dispatched = await taskService.dispatchTask(created.task.id, dispatchInput);
      await taskService.emitTaskEvent(dispatched.task, dispatched.event);
      spawnedTask = dispatched.task;
      dispatchSessionName = dispatched.sessionName;
    }

    dbRecordTaskAutomationFire(automation.id);
    const run = dbFinalizeTaskAutomationRun(claimedRun.id, {
      status: "spawned",
      spawnedTaskId: spawnedTask.id,
      message: normalizedAgentId
        ? `Spawned ${spawnedTask.id} and dispatched to ${normalizedAgentId}/${dispatchSessionName ?? "-"}`
        : `Spawned ${spawnedTask.id}`,
    });

    return {
      automation,
      run,
      spawnedTask,
      ...(dispatchSessionName ? { dispatchSessionName } : {}),
    };
  } catch (error) {
    const run = dbFinalizeTaskAutomationRun(claimedRun.id, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return { automation, run };
  }
}

export async function executeTaskAutomationsForEvent(
  task: TaskRecord,
  event: TaskEvent,
): Promise<TaskAutomationExecutionResult[]> {
  const eventType = toAutomationEventType(event.type);
  if (!eventType) {
    return [];
  }

  const automations = dbListTaskAutomations({ enabledOnly: true }).filter((automation) =>
    automation.eventTypes.includes(eventType),
  );
  const results: TaskAutomationExecutionResult[] = [];

  for (const automation of automations) {
    try {
      const result = await executeTaskAutomation(automation, task, event);
      if (result) {
        results.push(result);
      }
    } catch (error) {
      log.error("Task automation execution failed", {
        automationId: automation.id,
        taskId: task.id,
        eventType,
        error,
      });
    }
  }

  return results;
}

import {
  archiveTask,
  blockTask,
  commentTask,
  completeTask,
  failTask,
  getTaskDependencySurface,
  getTaskDetails,
  reportTaskProgress,
  unarchiveTask,
  updateTask,
} from "../../tasks/index.js";
import type { TaskPriority, TaskRecord, TaskStatus } from "../../tasks/index.js";
import type {
  WorkObject,
  WorkObjectActionInput,
  WorkObjectActionResult,
  WorkObjectAdapter,
  WorkObjectCustomField,
  WorkObjectExternalRef,
  WorkObjectField,
  WorkObjectRequestContext,
  WorkObjectResolveInput,
  WorkObjectSuggestionInput,
  WorkObjectSuggestionOption,
  WorkObjectUpdatePatch,
  WorkObjectUpdateResult,
} from "../types.js";

const TASK_REF_TYPE = "task";
const TASK_ENTITY_TYPE = "task";

const TASK_STATUSES: TaskStatus[] = ["open", "dispatched", "in_progress", "blocked", "done", "failed"];
const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

export function createTaskWorkObjectAdapter(): WorkObjectAdapter {
  return {
    id: TASK_REF_TYPE,
    canResolve: (input) => Boolean(resolveTaskId(input)),
    async resolveWorkObject(input) {
      const taskId = resolveTaskId(input);
      if (!taskId) return null;
      const details = getTaskDetails(taskId);
      if (!details.task) return null;
      return buildTaskWorkObject(details.task, { sourceUrl: input.url ?? input.appUnfurlUrl });
    },
    async updateWorkObject(ref, patch, context) {
      if (!isTaskRef(ref)) return null;
      return updateTaskWorkObject(ref.id, patch, context);
    },
    async executeWorkObjectAction(ref, action, context) {
      if (!isTaskRef(ref)) return null;
      return executeTaskWorkObjectAction(ref.id, action, context);
    },
    async suggestWorkObjectOptions(ref, suggestion) {
      if (!isTaskRef(ref)) return null;
      return suggestTaskWorkObjectOptions(suggestion);
    },
  };
}

export function resolveTaskId(input: WorkObjectResolveInput): string | null {
  const ref = input.externalRef;
  if (ref?.id && (!ref.type || ref.type === TASK_REF_TYPE)) {
    return ref.id;
  }

  const metadataTaskId = readString(input.metadata?.taskId) ?? readString(input.metadata?.id);
  if (metadataTaskId) return metadataTaskId;

  const candidateUrl = input.url ?? input.appUnfurlUrl;
  if (!candidateUrl) return null;
  return parseTaskIdFromUrl(candidateUrl);
}

export function buildTaskWorkObject(task: TaskRecord, options: { sourceUrl?: string } = {}): WorkObject {
  const dependencySurface = getTaskDependencySurface(task);
  const url = buildTaskUrl(task.id, options.sourceUrl);
  const fields: Record<string, WorkObjectField> = {
    status: {
      value: task.status,
      label: "Status",
      type: "string",
      tag_color: colorForTaskStatus(task.status),
      link: `${url}?status=${encodeURIComponent(task.status)}`,
      edit: {
        type: "select",
        optionSource: "work-object",
        staticOptions: TASK_STATUSES.map((status) => ({ text: formatTaskStatus(status), value: status })),
      },
    },
    priority: {
      value: task.priority,
      label: "Priority",
      type: "string",
      tag_color: colorForTaskPriority(task.priority),
      link: `${url}?priority=${encodeURIComponent(task.priority)}`,
      edit: {
        type: "select",
        optionSource: "work-object",
        staticOptions: TASK_PRIORITIES.map((priority) => ({ text: formatTaskPriority(priority), value: priority })),
      },
    },
    progress: {
      value: task.progress,
      label: "Progress",
      type: "number",
      edit: { type: "number", min: 0, max: 100 },
    },
    description: {
      value: task.instructions,
      label: "Instructions",
      type: "string",
      long: true,
      format: "markdown",
      edit: { type: "text", maxLength: 4000 },
    },
    date_created: {
      value: task.createdAt,
      label: "Created",
      type: "timestamp",
    },
    date_updated: {
      value: task.updatedAt,
      label: "Updated",
      type: "timestamp",
    },
  };

  if (task.assigneeSessionName) {
    fields.assignee = {
      label: "Assignee",
      type: "user",
      user: { text: task.assigneeSessionName },
    };
  }

  if (task.createdBy) {
    fields.created_by = {
      label: "Created by",
      type: "user",
      user: { text: task.createdBy },
    };
  }

  if (task.blockerReason) {
    fields.blocker = {
      value: task.blockerReason,
      label: "Blocker",
      type: "string",
      long: true,
    };
  }

  const customFields = [
    customField("progress", "Progress", task.progress, { type: "integer" }),
    customField("readiness", "Readiness", dependencySurface.readiness.state),
    customField("archived", "Archived", Boolean(task.archivedAt), { type: "boolean" }),
    customField("profile", "Profile", task.profileId),
    customField("assignee_agent", "Assignee agent", task.assigneeAgentId),
    customField("assignee_session", "Assignee session", task.assigneeSessionName),
    customField("parent_task", "Parent task", task.parentTaskId),
    task.blockerReason ? customField("blocker", "Blocker", task.blockerReason, { long: true }) : undefined,
  ].filter((field): field is WorkObjectCustomField => Boolean(field));

  return {
    url,
    externalRef: { type: TASK_REF_TYPE, id: task.id },
    title: task.title,
    kind: TASK_REF_TYPE,
    entityType: TASK_ENTITY_TYPE,
    displayId: task.id,
    displayType: "Task",
    productName: "Ravi",
    status: task.status,
    description: task.summary ?? task.blockerReason ?? task.instructions,
    metadataLastModified: Math.floor(task.updatedAt / 1000),
    revision: String(task.updatedAt),
    attributes: {
      priority: task.priority,
      progress: task.progress,
      archived: Boolean(task.archivedAt),
      readiness: dependencySurface.readiness.state,
      assigneeAgentId: task.assigneeAgentId ?? null,
      assigneeSessionName: task.assigneeSessionName ?? null,
    },
    fields,
    displayOrder: ["status", "priority", "assignee", "progress", "readiness", "date_updated", "description", "blocker"],
    customFields,
    actions: {
      primaryActions: [
        {
          text: "Mark done",
          actionId: "task.done",
          style: "primary",
          processingState: { enabled: true, interstitialText: "Marking task done..." },
        },
        { text: "Open task", actionId: "task.open", url },
      ],
      overflowActions: [
        ...(task.archivedAt
          ? [{ text: "Unarchive", actionId: "task.unarchive" }]
          : [{ text: "Archive", actionId: "task.archive" }]),
      ],
    },
  };
}

async function updateTaskWorkObject(
  taskId: string,
  patch: WorkObjectUpdatePatch,
  context: WorkObjectRequestContext,
): Promise<WorkObjectUpdateResult> {
  const existingTask = getTaskDetails(taskId).task;
  if (!existingTask) return { formError: `Task not found: ${taskId}` };
  if (patch.revision && patch.revision !== String(existingTask.updatedAt)) {
    return { formError: "Task changed since this Work Object was rendered. Refresh and try again." };
  }

  const fieldErrors: Record<string, string> = {};
  const values = patch.values;
  const mutations: Array<() => Promise<unknown> | unknown> = [];
  const taskUpdates: {
    title?: string;
    instructions?: string;
    priority?: TaskPriority;
  } = {};

  if (values.title !== undefined) {
    const title = readString(values.title);
    if (!title) {
      fieldErrors.title = "Title cannot be empty.";
    } else {
      taskUpdates.title = title;
    }
  }

  if (values.description !== undefined || values.instructions !== undefined) {
    const description = readString(values.description) ?? readString(values.instructions);
    if (!description) {
      fieldErrors.description = "Description cannot be empty.";
    } else {
      taskUpdates.instructions = description;
    }
  }

  if (values.comment !== undefined) {
    const body = readString(values.comment);
    if (!body) {
      fieldErrors.comment = "Comment cannot be empty.";
    } else {
      mutations.push(() => commentTask(taskId, { ...actorInput(context), body }));
    }
  }

  if (values.progress !== undefined || values.progressMessage !== undefined) {
    const progress = readNumber(values.progress);
    const message = readString(values.progressMessage) ?? "Progress updated from Work Object.";
    if (values.progress !== undefined && progress === null) {
      fieldErrors.progress = "Progress must be a number between 0 and 100.";
    } else {
      mutations.push(() =>
        reportTaskProgress(taskId, { ...actorInput(context), message, ...(progress !== null ? { progress } : {}) }),
      );
    }
  }

  if (values.status !== undefined) {
    const status = readString(values.status);
    if (!status || !isTaskStatus(status)) {
      fieldErrors.status = `Status must be one of: ${TASK_STATUSES.join(", ")}.`;
    } else {
      const mutation = buildTaskStatusMutation(taskId, status, values, context, fieldErrors);
      if (mutation) mutations.push(mutation);
    }
  }

  if (values.priority !== undefined) {
    const priority = readString(values.priority);
    if (!priority || !isTaskPriority(priority)) {
      fieldErrors.priority = `Priority must be one of: ${TASK_PRIORITIES.join(", ")}.`;
    } else {
      taskUpdates.priority = priority;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  if (Object.keys(taskUpdates).length > 0) {
    mutations.push(() =>
      updateTask(taskId, {
        ...actorInput(context),
        ...taskUpdates,
        message: `Updated from Work Object: ${Object.keys(taskUpdates).join(", ")}.`,
      }),
    );
  }

  for (const mutation of mutations) await mutation();

  const task = getTaskDetails(taskId).task;
  if (!task) return { formError: `Task not found: ${taskId}` };
  return { object: buildTaskWorkObject(task), revision: String(task.updatedAt) };
}

async function executeTaskWorkObjectAction(
  taskId: string,
  action: WorkObjectActionInput,
  context: WorkObjectRequestContext,
): Promise<WorkObjectActionResult> {
  const value = action.value?.trim();

  switch (normalizeActionId(action.actionId)) {
    case "task.comment": {
      if (!value) return { error: "Comment action requires a value." };
      await commentTask(taskId, { ...actorInput(context), body: value });
      return actionResult(taskId, "Comment added.");
    }
    case "task.report": {
      if (!value) return { error: "Report action requires a value." };
      reportTaskProgress(taskId, { ...actorInput(context), message: value });
      return actionResult(taskId, "Progress reported.");
    }
    case "task.done": {
      await completeTask(taskId, { ...actorInput(context), message: value || "Completed from Work Object." });
      return actionResult(taskId, "Task marked done.");
    }
    case "task.block": {
      if (!value) return { error: "Block action requires a reason." };
      blockTask(taskId, { ...actorInput(context), message: value });
      return actionResult(taskId, "Task blocked.");
    }
    case "task.fail": {
      if (!value) return { error: "Fail action requires a reason." };
      failTask(taskId, { ...actorInput(context), message: value });
      return actionResult(taskId, "Task failed.");
    }
    case "task.archive": {
      archiveTask(taskId, { ...actorInput(context), reason: value || "Archived from Work Object." });
      return actionResult(taskId, "Task archived.");
    }
    case "task.unarchive": {
      unarchiveTask(taskId, actorInput(context));
      return actionResult(taskId, "Task unarchived.");
    }
    case "task.open":
      return actionResult(taskId, "Task link opened.");
    default:
      return { error: `Unsupported task action: ${action.actionId}` };
  }
}

function suggestTaskWorkObjectOptions(suggestion: WorkObjectSuggestionInput): WorkObjectSuggestionOption[] {
  const fieldId = normalizeFieldId(suggestion.fieldId);
  const query = suggestion.query?.trim().toLowerCase() ?? "";
  const source =
    fieldId === "status"
      ? TASK_STATUSES.map((status) => ({ text: formatTaskStatus(status), value: status }))
      : fieldId === "priority"
        ? TASK_PRIORITIES.map((priority) => ({ text: formatTaskPriority(priority), value: priority }))
        : [];

  if (!query) return source;
  return source.filter(
    (option) => option.text.toLowerCase().includes(query) || option.value.toLowerCase().includes(query),
  );
}

function buildTaskStatusMutation(
  taskId: string,
  status: TaskStatus,
  values: Record<string, unknown>,
  context: WorkObjectRequestContext,
  fieldErrors: Record<string, string>,
): (() => Promise<unknown> | unknown) | null {
  switch (status) {
    case "done": {
      const message = readString(values.summary) ?? readString(values.message) ?? "Completed from Work Object.";
      return () => completeTask(taskId, { ...actorInput(context), message });
    }
    case "blocked": {
      const message = readString(values.blockerReason) ?? readString(values.reason) ?? readString(values.message);
      if (!message) {
        fieldErrors.status = "Blocked status requires blockerReason or message.";
        return null;
      }
      return () => blockTask(taskId, { ...actorInput(context), message });
    }
    case "failed": {
      const message = readString(values.reason) ?? readString(values.summary) ?? readString(values.message);
      if (!message) {
        fieldErrors.status = "Failed status requires reason, summary, or message.";
        return null;
      }
      return () => failTask(taskId, { ...actorInput(context), message });
    }
    default:
      fieldErrors.status = `Status ${status} is read-only from Work Objects in this MVP.`;
      return null;
  }
}

async function actionResult(taskId: string, message: string): Promise<WorkObjectActionResult> {
  const task = getTaskDetails(taskId).task;
  return {
    message,
    ...(task ? { object: buildTaskWorkObject(task) } : {}),
  };
}

function actorInput(context: WorkObjectRequestContext): {
  actor?: string;
  author?: string;
  agentId?: string;
  sessionName?: string;
  authorAgentId?: string;
  authorSessionName?: string;
} {
  const actor =
    context.actor?.displayName?.trim() || context.actor?.username?.trim() || context.actor?.id?.trim() || "work-object";
  const agentId = readString(context.metadata?.agentId);
  const sessionName = readString(context.metadata?.sessionName);
  return {
    actor,
    author: actor,
    ...(agentId ? { agentId, authorAgentId: agentId } : {}),
    ...(sessionName ? { sessionName, authorSessionName: sessionName } : {}),
  };
}

function isTaskRef(ref: WorkObjectExternalRef): boolean {
  return Boolean(ref.id && (!ref.type || ref.type === TASK_REF_TYPE));
}

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

function isTaskPriority(value: string): value is TaskPriority {
  return TASK_PRIORITIES.includes(value as TaskPriority);
}

function normalizeActionId(actionId: string): string {
  return actionId.replace(/^work_object:/, "");
}

function normalizeFieldId(fieldId: string): string {
  return fieldId
    .replace(/^work_object:/, "")
    .replace(/^task\./, "")
    .replace(/\.input$/, "");
}

function formatTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "dispatched":
      return "Dispatched";
    case "in_progress":
      return "In progress";
    case "blocked":
      return "Blocked";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

function formatTaskPriority(priority: TaskPriority): string {
  switch (priority) {
    case "low":
      return "Low";
    case "normal":
      return "Normal";
    case "high":
      return "High";
    case "urgent":
      return "Urgent";
  }
}

function colorForTaskStatus(status: TaskStatus): "red" | "yellow" | "green" | "gray" | "blue" {
  switch (status) {
    case "done":
      return "green";
    case "failed":
      return "red";
    case "blocked":
      return "yellow";
    case "in_progress":
    case "dispatched":
      return "blue";
    case "open":
      return "gray";
  }
}

function colorForTaskPriority(priority: TaskPriority): "red" | "yellow" | "green" | "gray" | "blue" {
  switch (priority) {
    case "urgent":
      return "red";
    case "high":
      return "yellow";
    case "normal":
      return "blue";
    case "low":
      return "gray";
  }
}

function customField(
  key: string,
  label: string,
  value: string | number | boolean | null | undefined,
  options: Omit<WorkObjectCustomField, "key" | "label" | "value"> = {},
): WorkObjectCustomField | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return {
    key,
    label,
    value,
    ...options,
  };
}

function parseTaskIdFromUrl(rawUrl: string): string | null {
  if (rawUrl.startsWith("ravi://")) {
    const match = rawUrl.match(/^ravi:\/\/(?:work-objects\/)?task\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  try {
    const url = new URL(rawUrl);
    const taskFromQuery = url.searchParams.get("taskId") ?? url.searchParams.get("task");
    if (taskFromQuery) return taskFromQuery;

    const match = url.pathname.match(/\/(?:work-objects\/task|tasks?|task)\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    const match = rawUrl.match(/(?:^|\/)(?:work-objects\/task|tasks?|task)\/([^/?#\s]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

function buildTaskUrl(taskId: string, sourceUrl?: string): string {
  const base = process.env.RAVI_WORK_OBJECT_BASE_URL?.trim();
  if (base) {
    return `${base.replace(/\/+$/, "")}/work-objects/task/${encodeURIComponent(taskId)}`;
  }
  const publicSourceUrl = sourceUrl?.trim();
  if (publicSourceUrl && /^https?:\/\//i.test(publicSourceUrl)) {
    return publicSourceUrl;
  }
  return `ravi://task/${encodeURIComponent(taskId)}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed);
}

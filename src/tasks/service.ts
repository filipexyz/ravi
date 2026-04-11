import { getContext } from "../cli/context.js";
import { nats } from "../nats.js";
import { expandHome, loadRouterConfig } from "../router/index.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { rmSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import {
  dbAddTaskComment,
  dbAppendTaskEvent,
  dbCompleteTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbFailTask,
  dbBlockTask,
  dbGetTask,
  dbGetActiveAssignment,
  dbListAssignments,
  dbListTaskComments,
  dbListChildTasks,
  dbListTaskEvents,
  dbListTasks,
  dbReportTaskProgress,
  dbSetTaskDir,
} from "./task-db.js";
import {
  getCanonicalTaskDir,
  getTaskDocPath,
  readTaskDocFrontmatter,
  taskDocExists,
  writeTaskDoc,
  type TaskDocSection,
} from "./task-doc.js";
import type {
  CreateTaskInput,
  DispatchTaskInput,
  TaskAssignment,
  TaskPriority,
  ListTasksOptions,
  TaskEvent,
  TaskComment,
  TaskCommentInput,
  TaskProgressInput,
  TaskRecord,
  TaskReportEvent,
  TaskStatus,
  TaskTerminalInput,
  TaskWorktreeConfig,
  TaskWorktreeMode,
} from "./types.js";
import { TASK_REPORT_EVENTS } from "./types.js";

const TASK_EVENT_PREFIX = "ravi.task";
const TASK_STATUSES = ["open", "dispatched", "in_progress", "blocked", "done", "failed"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TASK_ARTIFACT_KINDS = ["file", "url", "text"] as const;
const TASK_WORKTREE_MODES = ["inherit", "path"] as const;
const TASK_RECOVERY_STATUSES: TaskStatus[] = ["dispatched", "in_progress"];
const TASK_RECOVERY_MAX_STALE_MS = 20 * 60 * 1000;
const TASK_REPORT_EVENT_SET = new Set<string>(TASK_REPORT_EVENTS);
const log = logger.child("tasks:service");

export const TASK_STREAM_SCOPE = "tasks";
export const TASK_STREAM_TOPIC_PATTERNS = ["ravi.task.>"] as const;
export const TASK_STREAM_COMMAND_NAMES = [
  "task.create",
  "task.dispatch",
  "task.report",
  "task.comment",
  "task.done",
  "task.block",
  "task.fail",
] as const;
export const TASK_STREAM_CAPABILITIES = ["snapshot.open", "ping", ...TASK_STREAM_COMMAND_NAMES] as const;

export interface TaskArtifactPlaceholder {
  status: "planned";
  supportedKinds: Array<(typeof TASK_ARTIFACT_KINDS)[number]>;
  items: [];
}

export interface TaskStreamTaskEntity {
  id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  checkpointIntervalMs: number | null;
  reportToSessionName: string | null;
  reportEvents: TaskReportEvent[];
  parentTaskId: string | null;
  taskDir: string | null;
  createdBy: string | null;
  createdByAgentId: string | null;
  createdBySessionName: string | null;
  assigneeAgentId: string | null;
  assigneeSessionName: string | null;
  workSessionName: string | null;
  worktree: TaskWorktreeConfig | null;
  summary: string | null;
  blockerReason: string | null;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  artifacts: TaskArtifactPlaceholder;
}

export interface TaskStreamStats {
  total: number;
  open: number;
  dispatched: number;
  inProgress: number;
  blocked: number;
  done: number;
  failed: number;
}

export interface TaskStreamSelection {
  task: TaskStreamTaskEntity;
  parentTask: TaskStreamTaskEntity | null;
  childTasks: TaskStreamTaskEntity[];
  activeAssignment: TaskAssignment | null;
  assignments: TaskAssignment[];
  events: TaskEvent[];
  comments: TaskComment[];
}

export interface TaskStreamSnapshotEntity {
  query: {
    taskId: string | null;
    status: TaskStatus | null;
    agentId: string | null;
    sessionName: string | null;
    eventsLimit: number;
  };
  items: TaskStreamTaskEntity[];
  stats: TaskStreamStats;
  artifacts: TaskArtifactPlaceholder;
  selectedTask: TaskStreamSelection | null;
}

export interface TaskStreamEventPayload {
  kind: "task.event";
  taskId: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  parentTaskId: string | null;
  createdByAgentId: string | null;
  createdBySessionName: string | null;
  dispatcherSessionName: string | null;
  reportToSessionName: string | null;
  reportEvents: TaskReportEvent[];
  assigneeAgentId: string | null;
  assigneeSessionName: string | null;
  activeAssignment: TaskAssignment | null;
  task: TaskStreamTaskEntity;
  event: TaskEvent;
  artifacts: TaskArtifactPlaceholder;
}

export interface TaskRecoveryResult {
  recoveredTaskIds: string[];
  skipped: Array<{ taskId: string; reason: string }>;
}

export function isTaskRecoveryFresh(task: TaskRecord, assignment: TaskAssignment, now = Date.now()): boolean {
  const freshestActivity = Math.max(task.updatedAt ?? 0, assignment.acceptedAt ?? 0, assignment.assignedAt ?? 0);
  return now - freshestActivity <= TASK_RECOVERY_MAX_STALE_MS;
}

export type TaskStreamCommandName = (typeof TASK_STREAM_COMMAND_NAMES)[number];

const TaskSnapshotArgsSchema = z
  .object({
    taskId: z.string().trim().min(1).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    agentId: z.string().trim().min(1).optional(),
    sessionName: z.string().trim().min(1).optional(),
    eventsLimit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const TaskStreamActorSchema = z.object({
  actor: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  sessionName: z.string().trim().min(1).optional(),
});

const TaskWorktreeInputSchema = z
  .object({
    mode: z.enum(TASK_WORKTREE_MODES).optional(),
    path: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
  })
  .strict()
  .transform((value) => createTaskWorktreeConfig(value));

const TaskCreateCommandArgsSchema = TaskStreamActorSchema.extend({
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  checkpointIntervalMs: z.coerce.number().int().positive().optional(),
  reportToSessionName: z.string().trim().min(1).optional(),
  reportEvents: z.array(z.enum(TASK_REPORT_EVENTS)).min(1).optional(),
  parentTaskId: z.string().trim().min(1).optional(),
  createdByAgentId: z.string().trim().min(1).optional(),
  createdBySessionName: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  createdBy: z.string().trim().min(1).optional(),
  assigneeAgentId: z.string().trim().min(1).optional(),
  sessionName: z.string().trim().min(1).optional(),
  worktree: TaskWorktreeInputSchema.optional(),
}).strict();

const TaskDispatchCommandArgsSchema = z
  .object({
    taskId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    sessionName: z.string().trim().min(1).optional(),
    checkpointIntervalMs: z.coerce.number().int().positive().optional(),
    reportToSessionName: z.string().trim().min(1).optional(),
    reportEvents: z.array(z.enum(TASK_REPORT_EVENTS)).min(1).optional(),
    assignedBy: z.string().trim().min(1).optional(),
    actor: z.string().trim().min(1).optional(),
    worktree: TaskWorktreeInputSchema.optional(),
  })
  .strict();

const TaskReportCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  message: z.string().trim().min(1).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
}).strict();

const TaskCommentCommandArgsSchema = z
  .object({
    taskId: z.string().trim().min(1),
    body: z.string().trim().min(1),
    author: z.string().trim().min(1).optional(),
    authorAgentId: z.string().trim().min(1).optional(),
    authorSessionName: z.string().trim().min(1).optional(),
  })
  .strict();

const TaskDoneCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  summary: z.string().trim().min(1),
}).strict();

const TaskBlockCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  progress: z.coerce.number().int().min(0).max(100).optional(),
}).strict();

const TaskFailCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
}).strict();

function createTaskArtifactPlaceholder(): TaskArtifactPlaceholder {
  return {
    status: "planned",
    supportedKinds: [...TASK_ARTIFACT_KINDS],
    items: [],
  };
}

function normalizeTaskString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function createTaskWorktreeConfig(input?: {
  mode?: string | null;
  path?: string | null;
  branch?: string | null;
}): TaskWorktreeConfig | undefined {
  const modeInput = normalizeTaskString(input?.mode);
  const path = normalizeTaskString(input?.path);
  const branch = normalizeTaskString(input?.branch);

  if (!modeInput && !path && !branch) {
    return undefined;
  }

  const mode = (modeInput ?? (path || branch ? "path" : "inherit")) as TaskWorktreeMode;
  if (mode !== "inherit" && mode !== "path") {
    throw new Error(`Invalid worktree mode: ${modeInput}. Use inherit|path.`);
  }

  if (mode === "inherit") {
    if (path || branch) {
      throw new Error("worktree mode 'inherit' cannot be combined with path or branch.");
    }
    return { mode };
  }

  if (!path) {
    throw new Error("worktree path is required when worktree mode is 'path'.");
  }

  return {
    mode,
    path,
    ...(branch ? { branch } : {}),
  };
}

export function formatTaskWorktree(worktree?: TaskWorktreeConfig | null): string {
  if (!worktree) {
    return "agent default cwd";
  }

  if (worktree.mode === "inherit") {
    return "inherit agent cwd";
  }

  return `${worktree.path}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`;
}

function buildTaskDocSection(title: string, timestamp: number | undefined, lines: string[]): TaskDocSection {
  return {
    title,
    timestamp,
    lines,
  };
}

function buildTaskCreatedDocSection(task: TaskRecord, event: TaskEvent): TaskDocSection {
  return buildTaskDocSection("Task Created", event.createdAt, [
    `Status inicial: \`${task.status}\``,
    `Prioridade: \`${task.priority}\``,
    ...(task.parentTaskId ? [`Task pai: \`${task.parentTaskId}\``] : []),
    "TASK.md inicializado pelo task runtime.",
  ]);
}

function buildTaskMaterializedDocSection(task: TaskRecord): TaskDocSection {
  return buildTaskDocSection("Task Document Materialized", task.updatedAt, [
    "TASK.md materializado a partir do estado atual do runtime.",
    `Status atual: \`${task.status}\``,
    `Progresso atual: \`${task.progress}%\``,
    ...(task.parentTaskId ? [`Task pai: \`${task.parentTaskId}\``] : []),
  ]);
}

function buildTaskCommentDocSection(comment: TaskComment): TaskDocSection {
  const author = comment.authorSessionName ?? comment.authorAgentId ?? comment.author ?? "unknown";
  const commentLines = comment.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return buildTaskDocSection("Comment", comment.createdAt, [
    `Autor: \`${author}\``,
    "Comentário:",
    ...(commentLines.length > 0 ? commentLines : [comment.body]),
  ]);
}

function buildTaskCommentEventMessage(comment: TaskComment): string {
  const author = comment.authorSessionName ?? comment.authorAgentId ?? comment.author ?? "unknown";
  return `${author}: ${comment.body.replace(/\s+/g, " ").trim()}`;
}

function buildTaskCommentSteerPrompt(task: TaskRecord, comment: TaskComment): string {
  const author = comment.authorSessionName ?? comment.authorAgentId ?? comment.author ?? "unknown";
  return `[System] Inform: Novo comentário na task ${task.id} (${task.title}).

Autor: ${author}
Status atual: ${task.status}
Progresso atual: ${task.progress}%
TASK.md: ${getTaskDocPath(task)}

Comentário:
${comment.body}

Se isso mudar teu plano, atualize primeiro o TASK.md e depois sincronize o runtime com ravi tasks report|block|done|fail.`;
}

function shouldSteerTaskComment(task: TaskRecord): boolean {
  return (
    (task.status === "dispatched" || task.status === "in_progress" || task.status === "blocked") &&
    Boolean(task.assigneeSessionName)
  );
}

function buildChildStateEventType(
  task: TaskRecord,
): Extract<TaskEvent["type"], "task.child.blocked" | "task.child.done" | "task.child.failed"> {
  switch (task.status) {
    case "blocked":
      return "task.child.blocked";
    case "done":
      return "task.child.done";
    default:
      return "task.child.failed";
  }
}

function buildChildStateCallbackMessage(task: TaskRecord, event: TaskEvent): string {
  const summary = event.message ?? task.summary ?? task.blockerReason ?? task.status;
  if (task.status === "blocked") {
    return [
      `Task filha ${task.id} (${task.title}) entrou em blocked.`,
      `Assignee: ${task.assigneeAgentId ?? "-"}.`,
      `Session: ${task.assigneeSessionName ?? "-"}.`,
      `TASK.md: ${getTaskDocPath(task)}.`,
      `Blocker: ${summary}.`,
    ].join(" ");
  }

  return [
    `Task filha ${task.id} (${task.title}) terminalizou com status ${task.status}.`,
    `Assignee: ${task.assigneeAgentId ?? "-"}.`,
    `Session: ${task.assigneeSessionName ?? "-"}.`,
    `TASK.md: ${getTaskDocPath(task)}.`,
    `Resumo: ${summary}.`,
  ].join(" ");
}

function buildChildStateDocSection(task: TaskRecord, callbackEvent: TaskEvent): TaskDocSection {
  const summary = task.summary ?? task.blockerReason ?? task.status;
  const title =
    task.status === "blocked" ? "Child Task Blocked" : task.status === "done" ? "Child Task Done" : "Child Task Failed";
  const statusLabel = task.status === "blocked" ? "Status atual" : "Status final";
  const summaryLabel = task.status === "blocked" ? "Blocker" : "Resumo";
  return buildTaskDocSection(title, callbackEvent.createdAt, [
    `Filha: \`${task.id}\` - ${task.title}`,
    `${statusLabel}: \`${task.status}\``,
    `Progresso: \`${task.progress}%\``,
    `Assignee: \`${task.assigneeAgentId ?? "-"}\``,
    `Session: \`${task.assigneeSessionName ?? "-"}\``,
    `TASK.md: \`${getTaskDocPath(task)}\``,
    `${summaryLabel}: ${summary}`,
  ]);
}

function ensureTaskDocument(
  task: TaskRecord,
  options: {
    initializeSection?: TaskDocSection;
  } = {},
): TaskRecord {
  let ensuredTask = task;
  let initializeSection = options.initializeSection;

  if (!ensuredTask.taskDir) {
    ensuredTask = dbSetTaskDir(ensuredTask.id, getCanonicalTaskDir(ensuredTask.id));
  }

  if (!taskDocExists(ensuredTask) && !initializeSection) {
    initializeSection = buildTaskMaterializedDocSection(ensuredTask);
  }

  if (!taskDocExists(ensuredTask)) {
    writeTaskDoc(ensuredTask, {
      ...(initializeSection ? { initializeSection } : {}),
    });
  }

  return ensuredTask;
}

function getTaskDocSyncActor(task: TaskRecord): { actor: string; agentId?: string; sessionName?: string } {
  return {
    actor: task.assigneeSessionName ?? task.assigneeAgentId ?? task.createdBySessionName ?? "task-doc-sync",
    ...(task.assigneeAgentId ? { agentId: task.assigneeAgentId } : {}),
    ...(task.assigneeSessionName ? { sessionName: task.assigneeSessionName } : {}),
  };
}

function reconcileTaskRuntimeFromDocument(task: TaskRecord): TaskRecord {
  const documentedTask = ensureTaskDocument(task);
  const frontmatter = readTaskDocFrontmatter(documentedTask);

  if (documentedTask.status === "done" || documentedTask.status === "failed") {
    return documentedTask;
  }

  const frontmatterProgress =
    typeof frontmatter.progress === "number"
      ? Math.max(documentedTask.progress, frontmatter.progress)
      : documentedTask.progress;

  if (
    frontmatter.status === "in_progress" ||
    (documentedTask.status === "in_progress" && frontmatterProgress !== documentedTask.progress)
  ) {
    if (documentedTask.status !== "in_progress" || frontmatterProgress !== documentedTask.progress) {
      return reportTaskProgress(documentedTask.id, {
        ...getTaskDocSyncActor(documentedTask),
        progress: frontmatterProgress,
        resetCheckpoint: false,
      }).task;
    }
  }

  return documentedTask;
}

function resolveTaskSessionWorkspace(
  agentCwd: string,
  worktree?: TaskWorktreeConfig,
): { effectiveCwd: string; worktree?: TaskWorktreeConfig } {
  if (!worktree || worktree.mode === "inherit") {
    return {
      effectiveCwd: agentCwd,
      ...(worktree ? { worktree } : {}),
    };
  }

  const expandedPath = expandHome(worktree.path ?? "");
  const effectiveCwd = isAbsolute(expandedPath) ? expandedPath : resolvePath(agentCwd, expandedPath);
  return {
    effectiveCwd,
    worktree: {
      ...worktree,
      path: effectiveCwd,
    },
  };
}

function resolveTaskSessionContext(
  task: TaskRecord,
  agentId: string,
  sessionName: string,
  worktreeInput?: TaskWorktreeConfig,
): { sessionName: string; effectiveCwd: string; worktree?: TaskWorktreeConfig } {
  const config = loadRouterConfig();
  const agent = config.agents[agentId];
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const configuredAgentCwd = expandHome(agent.cwd);
  const { effectiveCwd, worktree } = resolveTaskSessionWorkspace(configuredAgentCwd, worktreeInput ?? task.worktree);
  const existingSession = resolveSession(sessionName);
  if (existingSession && existingSession.agentId !== agentId) {
    throw new Error(`Session ${sessionName} already belongs to agent ${existingSession.agentId}, not ${agentId}.`);
  }

  const sessionKey = existingSession?.sessionKey ?? sessionName;
  const session = getOrCreateSession(sessionKey, agentId, effectiveCwd, {
    name: existingSession?.name ?? sessionName,
  });

  return {
    sessionName: session.name ?? sessionName,
    effectiveCwd,
    ...(worktree ? { worktree } : {}),
  };
}

function toTaskStreamEntity(task: TaskRecord): TaskStreamTaskEntity {
  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    checkpointIntervalMs: task.checkpointIntervalMs ?? null,
    reportToSessionName: task.reportToSessionName ?? null,
    reportEvents: resolveTaskReportEvents(task.reportEvents),
    parentTaskId: task.parentTaskId ?? null,
    taskDir: task.taskDir ?? null,
    createdBy: task.createdBy ?? null,
    createdByAgentId: task.createdByAgentId ?? null,
    createdBySessionName: task.createdBySessionName ?? null,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
    workSessionName: task.assigneeSessionName ?? null,
    worktree: task.worktree ?? null,
    summary: task.summary ?? null,
    blockerReason: task.blockerReason ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    dispatchedAt: task.dispatchedAt ?? null,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    artifacts: createTaskArtifactPlaceholder(),
  };
}

function resolveTaskReportEvents(events?: readonly TaskReportEvent[] | null): TaskReportEvent[] {
  const normalized = [
    ...new Set((events ?? []).filter((event): event is TaskReportEvent => TASK_REPORT_EVENT_SET.has(event))),
  ];
  return normalized.length > 0 ? normalized : ["done"];
}

function toTaskReportEvent(type: TaskEvent["type"]): TaskReportEvent | null {
  switch (type) {
    case "task.blocked":
      return "blocked";
    case "task.done":
      return "done";
    case "task.failed":
      return "failed";
    default:
      return null;
  }
}

function buildTaskReportAnswerMessage(
  reportEvent: TaskReportEvent,
  input: {
    taskId: string;
    title?: string | null;
    message?: string | null;
    assigneeAgentId?: string | null;
    assigneeSessionName?: string | null;
  },
): string {
  const headline =
    reportEvent === "done" ? "Task concluída" : reportEvent === "blocked" ? "Task bloqueada" : "Task falhou";
  const detailLabel = reportEvent === "done" ? "Resumo" : reportEvent === "blocked" ? "Blocker" : "Erro";
  const parts = [`${headline}: ${input.taskId}`];
  if (input.title?.trim()) {
    parts.push(input.title.trim());
  }

  let message = parts.join(" · ");
  if (input.message?.trim()) {
    message += `\n${detailLabel}: ${input.message.trim()}`;
  }
  if (input.assigneeAgentId || input.assigneeSessionName) {
    message += `\nResponsável: ${input.assigneeAgentId ?? "-"}${input.assigneeSessionName ? `/${input.assigneeSessionName}` : ""}`;
  }
  return message;
}

export function buildTaskSessionLink(task: TaskRecord): {
  alias: string;
  sessionName: string;
  readCommand: string;
  debugCommand: string;
  toolTopic: string;
} | null {
  const sessionName = task.assigneeSessionName?.trim();
  if (!sessionName) {
    return null;
  }

  return {
    alias: task.id,
    sessionName,
    readCommand: `ravi sessions read ${sessionName}`,
    debugCommand: `ravi sessions debug ${sessionName}`,
    toolTopic: `ravi.session.${sessionName}.tool`,
  };
}

export async function reportTaskEvent(task: TaskRecord, event: TaskEvent): Promise<string | null> {
  const reportEvent = toTaskReportEvent(event.type);
  if (!reportEvent) {
    return null;
  }

  const latestAssignment = dbListAssignments(task.id)[0] ?? null;
  const reportToSessionName = latestAssignment?.reportToSessionName?.trim() || task.reportToSessionName?.trim() || null;
  const reportEvents = resolveTaskReportEvents(latestAssignment?.reportEvents ?? task.reportEvents);

  if (!reportToSessionName || !reportEvents.includes(reportEvent)) {
    return null;
  }

  const sourceSessionName = task.assigneeSessionName?.trim() || event.sessionName?.trim() || task.id;
  await publishSessionPrompt(reportToSessionName, {
    prompt: `[System] Answer: [from: ${sourceSessionName}] ${buildTaskReportAnswerMessage(reportEvent, {
      taskId: task.id,
      title: task.title,
      message: task.summary ?? task.blockerReason ?? event.message ?? null,
      assigneeAgentId: task.assigneeAgentId ?? null,
      assigneeSessionName: task.assigneeSessionName ?? null,
    })}`,
    deliveryBarrier: "after_response",
  });

  return reportToSessionName;
}

function summarizeTasks(tasks: TaskRecord[]): TaskStreamStats {
  const stats: TaskStreamStats = {
    total: tasks.length,
    open: 0,
    dispatched: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
  };

  for (const task of tasks) {
    switch (task.status) {
      case "open":
        stats.open += 1;
        break;
      case "dispatched":
        stats.dispatched += 1;
        break;
      case "in_progress":
        stats.inProgress += 1;
        break;
      case "blocked":
        stats.blocked += 1;
        break;
      case "done":
        stats.done += 1;
        break;
      case "failed":
        stats.failed += 1;
        break;
    }
  }

  return stats;
}

function resolveTaskCommandActor(actor?: string, fallback = "ravi.stream"): string {
  return actor?.trim() || fallback;
}

function resolveTaskCreateAssignee(agentId?: string, assigneeAgentId?: string): string | undefined {
  if (agentId && assigneeAgentId && agentId !== assigneeAgentId) {
    throw new Error(`Conflicting task.create assignee values: agentId=${agentId}, assigneeAgentId=${assigneeAgentId}`);
  }
  return agentId ?? assigneeAgentId;
}

export function isTaskStreamCommand(name: string): name is TaskStreamCommandName {
  return (TASK_STREAM_COMMAND_NAMES as readonly string[]).includes(name);
}

export function buildTaskEventPayload(task: TaskRecord, event: TaskEvent): TaskStreamEventPayload {
  const latestAssignment = dbListAssignments(task.id)[0] ?? null;
  const reportToSessionName = latestAssignment?.reportToSessionName ?? task.reportToSessionName ?? null;
  const reportEvents = resolveTaskReportEvents(latestAssignment?.reportEvents ?? task.reportEvents);
  return {
    kind: "task.event",
    taskId: task.id,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    parentTaskId: task.parentTaskId ?? null,
    createdByAgentId: task.createdByAgentId ?? null,
    createdBySessionName: task.createdBySessionName ?? null,
    dispatcherSessionName: latestAssignment?.assignedBySessionName ?? latestAssignment?.assignedBy ?? null,
    reportToSessionName,
    reportEvents,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
    activeAssignment: dbGetActiveAssignment(task.id),
    task: toTaskStreamEntity(task),
    event,
    artifacts: createTaskArtifactPlaceholder(),
  };
}

export function buildTaskStreamSnapshot(args: Record<string, unknown> = {}): TaskStreamSnapshotEntity {
  const parsed = TaskSnapshotArgsSchema.parse(args);
  if (parsed.taskId) {
    const details = getTaskDetails(parsed.taskId);
    if (!details.task) {
      throw new Error(`Task not found: ${parsed.taskId}`);
    }

    return {
      query: {
        taskId: parsed.taskId,
        status: null,
        agentId: null,
        sessionName: null,
        eventsLimit: parsed.eventsLimit,
      },
      items: [toTaskStreamEntity(details.task)],
      stats: summarizeTasks([details.task]),
      artifacts: createTaskArtifactPlaceholder(),
      selectedTask: {
        task: toTaskStreamEntity(details.task),
        parentTask: details.parentTask ? toTaskStreamEntity(details.parentTask) : null,
        childTasks: details.childTasks.map(toTaskStreamEntity),
        activeAssignment: details.activeAssignment,
        assignments: details.assignments,
        events: details.events.slice(-parsed.eventsLimit),
        comments: details.comments.slice(-parsed.eventsLimit),
      },
    };
  }

  const tasks = listTasks({
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    ...(parsed.sessionName ? { sessionName: parsed.sessionName } : {}),
  });

  return {
    query: {
      taskId: null,
      status: parsed.status ?? null,
      agentId: parsed.agentId ?? null,
      sessionName: parsed.sessionName ?? null,
      eventsLimit: parsed.eventsLimit,
    },
    items: tasks.map(toTaskStreamEntity),
    stats: summarizeTasks(tasks),
    artifacts: createTaskArtifactPlaceholder(),
    selectedTask: null,
  };
}

export async function executeTaskStreamCommand(
  name: TaskStreamCommandName,
  rawArgs: Record<string, unknown> = {},
  options: { actor?: string } = {},
): Promise<Record<string, unknown>> {
  switch (name) {
    case "task.create": {
      const args = TaskCreateCommandArgsSchema.parse(rawArgs);
      const created = createTask({
        title: args.title,
        instructions: args.instructions,
        priority: args.priority,
        ...(typeof args.checkpointIntervalMs === "number" ? { checkpointIntervalMs: args.checkpointIntervalMs } : {}),
        ...(args.reportToSessionName ? { reportToSessionName: args.reportToSessionName } : {}),
        ...(args.reportEvents ? { reportEvents: args.reportEvents } : {}),
        ...(args.parentTaskId ? { parentTaskId: args.parentTaskId } : {}),
        createdBy: args.createdBy ?? resolveTaskCommandActor(args.actor, options.actor),
        createdByAgentId: args.createdByAgentId,
        createdBySessionName: args.createdBySessionName,
        ...(args.worktree ? { worktree: args.worktree } : {}),
      });
      await emitTaskEvent(created.task, created.event);

      const assigneeAgentId = resolveTaskCreateAssignee(args.agentId, args.assigneeAgentId);
      if (assigneeAgentId) {
        const dispatch = await dispatchTask(created.task.id, {
          agentId: assigneeAgentId,
          sessionName: args.sessionName ?? getDefaultTaskSessionName(created.task.id),
          assignedBy: args.createdBy ?? resolveTaskCommandActor(args.actor, options.actor),
          ...(args.createdByAgentId ? { assignedByAgentId: args.createdByAgentId } : {}),
          ...(args.createdBySessionName ? { assignedBySessionName: args.createdBySessionName } : {}),
          ...(typeof args.checkpointIntervalMs === "number" ? { checkpointIntervalMs: args.checkpointIntervalMs } : {}),
          ...(args.reportToSessionName ? { reportToSessionName: args.reportToSessionName } : {}),
          ...(args.reportEvents ? { reportEvents: args.reportEvents } : {}),
          ...(args.worktree ? { worktree: args.worktree } : {}),
        });
        await emitTaskEvent(dispatch.task, dispatch.event);
        return {
          action: name,
          task: toTaskStreamEntity(dispatch.task),
          event: created.event,
          dispatch: {
            assignment: dispatch.assignment,
            event: dispatch.event,
            sessionName: dispatch.sessionName,
          },
        };
      }

      return {
        action: name,
        task: toTaskStreamEntity(created.task),
        event: created.event,
      };
    }

    case "task.dispatch": {
      const args = TaskDispatchCommandArgsSchema.parse(rawArgs);
      const result = await dispatchTask(args.taskId, {
        agentId: args.agentId,
        sessionName: args.sessionName ?? getDefaultTaskSessionName(args.taskId),
        assignedBy: args.assignedBy ?? resolveTaskCommandActor(args.actor, options.actor),
        ...(typeof args.checkpointIntervalMs === "number" ? { checkpointIntervalMs: args.checkpointIntervalMs } : {}),
        ...(args.reportToSessionName ? { reportToSessionName: args.reportToSessionName } : {}),
        ...(args.reportEvents ? { reportEvents: args.reportEvents } : {}),
        ...(args.worktree ? { worktree: args.worktree } : {}),
      });
      await emitTaskEvent(result.task, result.event);
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
        assignment: result.assignment,
        event: result.event,
        sessionName: result.sessionName,
      };
    }

    case "task.report": {
      const args = TaskReportCommandArgsSchema.parse(rawArgs);
      const { task, event } = reportTaskProgress(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        ...(args.message ? { message: args.message } : {}),
        ...(typeof args.progress === "number" ? { progress: args.progress } : {}),
      });
      await emitTaskEvent(task, event);
      return {
        action: name,
        task: toTaskStreamEntity(task),
        event,
      };
    }

    case "task.comment": {
      const args = TaskCommentCommandArgsSchema.parse(rawArgs);
      const result = await commentTask(args.taskId, {
        author: args.author ?? resolveTaskCommandActor(options.actor),
        authorAgentId: args.authorAgentId,
        authorSessionName: args.authorSessionName,
        body: args.body,
      });
      await emitTaskEvent(result.task, result.event);
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
        event: result.event,
        comment: result.comment,
        steeredSessionName: result.steeredSessionName ?? null,
      };
    }

    case "task.done": {
      const args = TaskDoneCommandArgsSchema.parse(rawArgs);
      const completion = completeTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.summary,
      });
      if (!completion.wasNoop) {
        await emitTaskEvent(completion.task, completion.event);
        for (const relatedEvent of completion.relatedEvents) {
          await emitTaskEvent(relatedEvent.task, relatedEvent.event);
        }
      }
      return {
        action: name,
        task: toTaskStreamEntity(completion.task),
        event: completion.event,
      };
    }

    case "task.block": {
      const args = TaskBlockCommandArgsSchema.parse(rawArgs);
      const result = blockTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.reason,
        ...(typeof args.progress === "number" ? { progress: args.progress } : {}),
      });
      await emitTaskEvent(result.task, result.event);
      for (const relatedEvent of result.relatedEvents) {
        await emitTaskEvent(relatedEvent.task, relatedEvent.event);
      }
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
        event: result.event,
      };
    }

    case "task.fail": {
      const args = TaskFailCommandArgsSchema.parse(rawArgs);
      const failure = failTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.reason,
      });
      await emitTaskEvent(failure.task, failure.event);
      for (const relatedEvent of failure.relatedEvents) {
        await emitTaskEvent(relatedEvent.task, relatedEvent.event);
      }
      return {
        action: name,
        task: toTaskStreamEntity(failure.task),
        event: failure.event,
      };
    }
  }

  const exhaustive: never = name;
  throw new Error(`Unsupported task command: ${exhaustive}`);
}

export function getDefaultTaskSessionName(taskId: string): string {
  return `${taskId}-work`;
}

export function getTaskActor(): { actor?: string; agentId?: string; sessionName?: string } {
  const ctx = getContext();
  return {
    actor: ctx?.sessionName ?? ctx?.agentId ?? process.env.USER ?? "cli",
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
  };
}

export async function emitTaskEvent(task: TaskRecord, event: TaskEvent): Promise<void> {
  const payload = buildTaskEventPayload(task, event);
  await nats.emit(`${TASK_EVENT_PREFIX}.${task.id}.event`, payload as unknown as Record<string, unknown>);

  if (toTaskReportEvent(event.type)) {
    try {
      await reportTaskEvent(task, event);
    } catch (error) {
      log.warn("Failed to publish task report", {
        taskId: task.id,
        reportToSessionName: payload.reportToSessionName,
        reportEvents: payload.reportEvents,
        error,
      });
    }
  }
}

export function buildTaskDispatchPrompt(
  task: TaskRecord,
  agentId: string,
  sessionName: string,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath: string;
  },
): string {
  return `[System] Execute: Você assumiu a task ${task.id} no Ravi.

Título: ${task.title}
Prioridade: ${task.priority}
Sessão de trabalho: ${sessionName}
Agent responsável: ${agentId}

Contexto operacional:
- diretório efetivo: ${options.effectiveCwd}
- worktree: ${formatTaskWorktree(options.worktree)}
- task pai: ${task.parentTaskId ?? "-"}
- TASK.md: ${options.taskDocPath}

Objetivo:
${task.instructions}

Instruções de execução:
- carregue a skill \`ravi-system-tasks-manager\` antes de editar a task
- trabalhe a partir de ${options.taskDocPath}
- faça toda escrita primeiro no TASK.md
- depois de editar o frontmatter/corpo, use \`ravi tasks ...\` para o runtime reconhecer as mudanças

Flow obrigatório:
1. Abra o TASK.md e atualize o frontmatter/corpo seguindo a skill.
2. Ao iniciar ou avançar de verdade, sincronize:
   ravi tasks report ${task.id}
3. Se travar, registre no TASK.md e sincronize:
   ravi tasks block ${task.id}
4. Se der erro terminal, registre no TASK.md e sincronize:
   ravi tasks fail ${task.id}
5. Quando concluir, registre no TASK.md e sincronize:
   ravi tasks done ${task.id}

Regras:
- trabalhe nesta sessão até concluir ou bloquear
- não responda descrevendo o protocolo
- use o CLI de tasks para atualizar o estado real da task
- o corpo rico da task vive no TASK.md; DB/NATS continuam sendo a fonte autoritativa do estado`;
}

export function buildTaskResumePrompt(
  task: TaskRecord,
  _agentId: string,
  _sessionName: string,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath: string;
  },
): string {
  return `[System] Daemon reiniciou. Continue a task ${task.id} ("${task.title}") de onde parou.
Progresso: ${task.progress}% | TASK.md: ${options.taskDocPath}`;
}

export function createTask(input: CreateTaskInput): { task: TaskRecord; event: TaskEvent } {
  if (input.parentTaskId) {
    const parentTask = dbGetTask(input.parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task not found: ${input.parentTaskId}`);
    }
  }

  const created = dbCreateTask(input);

  try {
    const task = ensureTaskDocument(created.task, {
      initializeSection: buildTaskCreatedDocSection(created.task, created.event),
    });
    return { task, event: created.event };
  } catch (error) {
    dbDeleteTask(created.task.id);
    rmSync(getCanonicalTaskDir(created.task.id), { recursive: true, force: true });
    throw error;
  }
}

export function listTasks(options: ListTasksOptions = {}): TaskRecord[] {
  return dbListTasks(options);
}

export function getTaskDetails(taskId: string): {
  task: TaskRecord | null;
  parentTask: TaskRecord | null;
  childTasks: TaskRecord[];
  activeAssignment: ReturnType<typeof dbGetActiveAssignment>;
  assignments: ReturnType<typeof dbListAssignments>;
  events: ReturnType<typeof dbListTaskEvents>;
  comments: ReturnType<typeof dbListTaskComments>;
} {
  const task = dbGetTask(taskId);
  const documentedTask = task ? reconcileTaskRuntimeFromDocument(task) : null;
  const parentTask =
    documentedTask?.parentTaskId && dbGetTask(documentedTask.parentTaskId)
      ? reconcileTaskRuntimeFromDocument(dbGetTask(documentedTask.parentTaskId)!)
      : null;
  return {
    task: documentedTask,
    parentTask,
    childTasks: documentedTask
      ? dbListChildTasks(documentedTask.id).map((childTask) => reconcileTaskRuntimeFromDocument(childTask))
      : [],
    activeAssignment: dbGetActiveAssignment(taskId),
    assignments: dbListAssignments(taskId),
    events: dbListTaskEvents(taskId, 200),
    comments: dbListTaskComments(taskId, 200),
  };
}

function buildChildStateRelatedEvents(
  task: TaskRecord,
  event: TaskEvent,
): Array<{ task: TaskRecord; event: TaskEvent }> {
  if (!task.parentTaskId || (task.status !== "blocked" && task.status !== "done" && task.status !== "failed")) {
    return [];
  }

  const parentTask = dbGetTask(task.parentTaskId);
  if (!parentTask) {
    return [];
  }

  const callback = dbAppendTaskEvent(
    parentTask.id,
    buildChildStateEventType(task),
    {
      actor: event.actor,
      agentId: task.assigneeAgentId ?? event.agentId,
      sessionName: task.assigneeSessionName ?? event.sessionName,
      message: buildChildStateCallbackMessage(task, event),
      progress: task.progress,
      relatedTaskId: task.id,
    },
    { touchTask: true },
  );
  const documentedParent = ensureTaskDocument(callback.task);
  writeTaskDoc(documentedParent, {
    appendSection: buildChildStateDocSection(task, callback.event),
  });
  return [{ task: documentedParent, event: callback.event }];
}

export async function dispatchTask(
  taskId: string,
  input: DispatchTaskInput,
): Promise<{
  task: TaskRecord;
  assignment: TaskAssignment;
  event: TaskEvent;
  sessionName: string;
}> {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { sessionName, effectiveCwd, worktree } = resolveTaskSessionContext(
    existingTask,
    input.agentId,
    input.sessionName,
    input.worktree ?? existingTask.worktree,
  );

  const { task, assignment, event } = dbDispatchTask(taskId, {
    ...input,
    sessionName,
    ...(worktree ? { worktree } : {}),
  });
  const documentedTask = ensureTaskDocument(task);
  const taskDocPath = getTaskDocPath(documentedTask);

  const prompt = buildTaskDispatchPrompt(documentedTask, input.agentId, sessionName, {
    effectiveCwd,
    worktree,
    taskDocPath,
  });
  await publishSessionPrompt(sessionName, {
    prompt,
    deliveryBarrier: "after_task",
    taskBarrierTaskId: documentedTask.id,
  });

  return { task: documentedTask, assignment, event, sessionName };
}

export async function recoverActiveTasksAfterRestart(): Promise<TaskRecoveryResult> {
  const recoveredTaskIds: string[] = [];
  const skipped: Array<{ taskId: string; reason: string }> = [];
  const seen = new Set<string>();
  const now = Date.now();

  for (const status of TASK_RECOVERY_STATUSES) {
    const tasks = listTasks({ status });
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);

      const assignment = dbGetActiveAssignment(task.id);
      if (!assignment) {
        skipped.push({ taskId: task.id, reason: "no_active_assignment" });
        continue;
      }
      if (!isTaskRecoveryFresh(task, assignment, now)) {
        skipped.push({ taskId: task.id, reason: "stale_active_task" });
        continue;
      }

      try {
        const documentedTask = ensureTaskDocument(task);
        const { sessionName, effectiveCwd, worktree } = resolveTaskSessionContext(
          documentedTask,
          assignment.agentId,
          assignment.sessionName,
          assignment.worktree ?? documentedTask.worktree,
        );
        const prompt = buildTaskResumePrompt(documentedTask, assignment.agentId, sessionName, {
          effectiveCwd,
          worktree,
          taskDocPath: getTaskDocPath(documentedTask),
        });
        await publishSessionPrompt(sessionName, {
          prompt,
          deliveryBarrier: "after_task",
          taskBarrierTaskId: documentedTask.id,
        });
        recoveredTaskIds.push(documentedTask.id);
      } catch (error) {
        skipped.push({
          taskId: task.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { recoveredTaskIds, skipped };
}

export function reportTaskProgress(taskId: string, input: TaskProgressInput): { task: TaskRecord; event: TaskEvent } {
  return dbReportTaskProgress(taskId, input);
}

export async function commentTask(
  taskId: string,
  input: TaskCommentInput,
): Promise<{
  task: TaskRecord;
  comment: TaskComment;
  event: TaskEvent;
  steeredSessionName?: string;
}> {
  const task = dbGetTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const documentedTask = reconcileTaskRuntimeFromDocument(task);
  const comment = dbAddTaskComment(taskId, input);
  const eventResult = dbAppendTaskEvent(
    taskId,
    "task.comment",
    {
      actor: input.author,
      agentId: input.authorAgentId,
      sessionName: input.authorSessionName,
      message: buildTaskCommentEventMessage(comment),
      progress: documentedTask.progress,
    },
    { touchTask: true },
  );
  const updatedTask = ensureTaskDocument(eventResult.task);
  writeTaskDoc(updatedTask, {
    appendSection: buildTaskCommentDocSection(comment),
  });

  let steeredSessionName: string | undefined;
  if (shouldSteerTaskComment(updatedTask) && updatedTask.assigneeSessionName) {
    await publishSessionPrompt(updatedTask.assigneeSessionName, {
      prompt: buildTaskCommentSteerPrompt(updatedTask, comment),
      deliveryBarrier: "after_response",
    });
    steeredSessionName = updatedTask.assigneeSessionName;
  }

  return {
    task: updatedTask,
    comment,
    event: eventResult.event,
    ...(steeredSessionName ? { steeredSessionName } : {}),
  };
}

export function blockTask(
  taskId: string,
  input: TaskTerminalInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
} {
  const result = dbBlockTask(taskId, input);
  return {
    ...result,
    relatedEvents: buildChildStateRelatedEvents(result.task, result.event),
  };
}

export function failTask(
  taskId: string,
  input: TaskTerminalInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
} {
  const result = dbFailTask(taskId, input);
  return {
    ...result,
    relatedEvents: buildChildStateRelatedEvents(result.task, result.event),
  };
}

export function completeTask(
  taskId: string,
  input: TaskTerminalInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
} {
  const result = dbCompleteTask(taskId, input);
  return {
    ...result,
    relatedEvents: result.wasNoop ? [] : buildChildStateRelatedEvents(result.task, result.event),
  };
}

import { getContext } from "../cli/context.js";
import { nats } from "../nats.js";
import { expandHome, getAgent } from "../router/index.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { getProjectSurfaceByWorkflowRunId, type ProjectTaskSurface } from "../projects/index.js";
import { logger } from "../utils/logger.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import {
  buildTaskProfileSnapshot,
  buildTaskDispatchEventMessageForProfile,
  buildTaskDispatchPromptForProfile,
  buildTaskDispatchSummaryForProfile,
  buildTaskReportMessageForProfile,
  buildTaskResumePromptForProfile,
  getDefaultTaskSessionNameForProfile,
  getDefaultTaskSessionNameForTask,
  previewTaskProfile,
  requireTaskProfileDefinition,
  resolveTaskProfile,
  resolveTaskProfileArtifacts,
  resolveTaskProfileForTask,
  resolveTaskProfileInputValues,
  resolveTaskProfilePrimaryArtifact,
  resolveTaskProfileState,
  taskProfileRequiresTaskDocument,
  taskProfileUsesTaskDocument,
  shouldPersistTaskProfileState,
} from "./profiles.js";
import {
  dbArchiveTask,
  dbAddTaskComment,
  dbAddTaskDependency,
  dbAppendTaskEvent,
  dbUnarchiveTask,
  dbCompleteTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbFailTask,
  dbBlockTask,
  dbGetTask,
  dbGetActiveAssignment,
  dbGetTaskLaunchPlan,
  dbListAssignments,
  dbListTaskComments,
  dbListChildTasks,
  dbListTaskDependencies,
  dbListTaskDependents,
  dbListTaskEvents,
  dbListTasks,
  dbMarkTaskDependenciesSatisfiedByUpstream,
  dbRemoveTaskDependency,
  dbReportTaskProgress,
  dbSetTaskDir,
  dbSetTaskLaunchPlan,
  dbSetTaskProfileResolution,
  dbSetTaskProfileState,
} from "./task-db.js";
import {
  appendTaskDocumentSection,
  ensureRequiredTaskDocument,
  getCanonicalTaskDir,
  getTaskDocPath,
  taskDocExists,
  type TaskDocSection,
} from "./task-doc.js";
import { requireTaskProgressMessage } from "./progress-contract.js";
import { dbGetTaskWorkflowSurface, syncWorkflowNodeRunForTask, type TaskWorkflowSurface } from "../workflows/index.js";
import type {
  ResolvedTaskProfile,
  TaskArchiveInput,
  TaskArchiveMode,
  CreateTaskInput,
  DispatchTaskInput,
  TaskAssignment,
  TaskPriority,
  ListTasksOptions,
  TaskEvent,
  TaskComment,
  TaskCommentInput,
  TaskDependencyEdge,
  TaskDependencyRecord,
  TaskProfileArtifactKind,
  TaskProfileArtifactRef,
  TaskProgressInput,
  TaskLaunchPlan,
  TaskReadiness,
  TaskRecord,
  TaskReportEvent,
  TaskStatus,
  TaskTerminalInput,
  TaskUnarchiveInput,
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
  "task.archive",
  "task.unarchive",
  "task.done",
  "task.block",
  "task.fail",
] as const;
export const TASK_STREAM_CAPABILITIES = ["snapshot.open", "ping", ...TASK_STREAM_COMMAND_NAMES] as const;

export interface TaskSurfaceArtifactPath {
  absolutePath: string | null;
  workspaceRelativePath: string | null;
  displayPath: string | null;
}

export interface TaskSurfaceArtifact {
  kind: TaskProfileArtifactKind;
  role: "primary" | "supporting";
  label: string;
  exists: boolean | null;
  path: TaskSurfaceArtifactPath;
}

export interface TaskArtifactSummary {
  status: "planned";
  supportedKinds: Array<(typeof TASK_ARTIFACT_KINDS)[number]>;
  workspaceRoot: string | null;
  items: TaskSurfaceArtifact[];
  primary: TaskSurfaceArtifact | null;
}

export interface TaskDependencySurface {
  dependencies: TaskDependencyEdge[];
  dependents: TaskDependencyEdge[];
  readiness: TaskReadiness;
  launchPlan: TaskLaunchPlan | null;
}

export interface TaskStreamTaskEntity {
  id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  visualStatus: TaskStatus | "waiting";
  priority: TaskPriority;
  progress: number;
  profileId: string;
  taskProfile: ResolvedTaskProfile;
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
  archivedAt: number | null;
  archivedBy: string | null;
  archiveReason: string | null;
  createdAt: number;
  updatedAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  readiness: TaskReadiness;
  launchPlan: TaskLaunchPlan | null;
  dependencyCount: number;
  satisfiedDependencyCount: number;
  unsatisfiedDependencyCount: number;
  workflow: TaskWorkflowSurface | null;
  project: ProjectTaskSurface | null;
  artifacts: TaskArtifactSummary;
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
  dependencies: TaskDependencyEdge[];
  dependents: TaskDependencyEdge[];
  launchPlan: TaskLaunchPlan | null;
  readiness: TaskReadiness;
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
    archiveMode: TaskArchiveMode;
    eventsLimit: number;
  };
  items: TaskStreamTaskEntity[];
  stats: TaskStreamStats;
  artifacts: TaskArtifactSummary;
  selectedTask: TaskStreamSelection | null;
}

export interface TaskStreamEventPayload {
  kind: "task.event";
  taskId: string;
  status: TaskStatus;
  visualStatus: TaskStatus | "waiting";
  priority: TaskPriority;
  progress: number;
  profileId: string;
  taskProfile: ResolvedTaskProfile;
  archivedAt: number | null;
  archivedBy: string | null;
  archiveReason: string | null;
  parentTaskId: string | null;
  createdByAgentId: string | null;
  createdBySessionName: string | null;
  dispatcherSessionName: string | null;
  reportToSessionName: string | null;
  reportEvents: TaskReportEvent[];
  assigneeAgentId: string | null;
  assigneeSessionName: string | null;
  readiness: TaskReadiness;
  launchPlan: TaskLaunchPlan | null;
  activeAssignment: TaskAssignment | null;
  project: ProjectTaskSurface | null;
  task: TaskStreamTaskEntity;
  event: TaskEvent;
  artifacts: TaskArtifactSummary;
}

export interface TaskRecoveryResult {
  recoveredTaskIds: string[];
  skipped: Array<{ taskId: string; reason: string }>;
}

export function deriveTaskReadStatus(
  task: Pick<TaskRecord, "status">,
  activeAssignment?: Pick<TaskAssignment, "status" | "acceptedAt"> | null,
): TaskStatus {
  if (
    task.status === "dispatched" &&
    activeAssignment &&
    (activeAssignment.status === "accepted" || typeof activeAssignment.acceptedAt === "number")
  ) {
    return "in_progress";
  }

  return task.status;
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
    archived: z.boolean().optional(),
    all: z.boolean().optional(),
    eventsLimit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.archived && value.all) {
      ctx.addIssue({
        code: "custom",
        message: "snapshot.open cannot combine archived=true with all=true.",
        path: ["archived"],
      });
    }
  });

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
  profileId: z.string().trim().min(1).optional(),
  dependsOnTaskIds: z.array(z.string().trim().min(1)).optional(),
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

const TaskArchiveCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
}).strict();

const TaskUnarchiveCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
}).strict();

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

function createEmptyTaskArtifactSummary(workspaceRoot: string | null = null): TaskArtifactSummary {
  return {
    status: "planned",
    supportedKinds: [...TASK_ARTIFACT_KINDS],
    workspaceRoot,
    items: [],
    primary: null,
  };
}

function resolveTaskArtifactWorkspaceRoot(task: TaskRecord, activeAssignment?: TaskAssignment | null): string | null {
  const agentId =
    normalizeTaskString(activeAssignment?.agentId) ??
    normalizeTaskString(task.assigneeAgentId) ??
    normalizeTaskString(task.createdByAgentId);
  if (!agentId) {
    return null;
  }

  try {
    return requireTaskRuntimeAgent(agentId).cwd;
  } catch {
    return null;
  }
}

function resolveWorkspaceRelativePath(targetPath: string | null, workspaceRoot: string | null): string | null {
  if (!targetPath || !workspaceRoot) {
    return null;
  }

  const relativeTargetPath = relativePath(workspaceRoot, targetPath);
  if (!relativeTargetPath) {
    return null;
  }
  if (
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith("../") ||
    relativeTargetPath.startsWith("..\\") ||
    isAbsolute(relativeTargetPath)
  ) {
    return null;
  }
  return relativeTargetPath;
}

function createTaskSurfaceArtifact(input: {
  kind: TaskProfileArtifactKind;
  role: "primary" | "supporting";
  label: string;
  absolutePath: string | null;
  workspaceRelativePath: string | null;
  exists: boolean | null;
}): TaskSurfaceArtifact {
  return {
    kind: input.kind,
    role: input.role,
    label: input.label,
    exists: input.exists,
    path: {
      absolutePath: input.absolutePath,
      workspaceRelativePath: input.workspaceRelativePath,
      displayPath: input.workspaceRelativePath ?? input.absolutePath,
    },
  };
}

export function buildTaskArtifactSummary(
  task: TaskRecord,
  activeAssignment?: TaskAssignment | null,
): TaskArtifactSummary {
  const profile = resolveTaskProfileForTask(task);
  const workspaceRoot = resolveTaskArtifactWorkspaceRoot(task, activeAssignment);
  const effectiveCwd = workspaceRoot ?? "/tmp";
  const artifactWorkspaceRoot = workspaceRoot ?? effectiveCwd;
  const taskDocPath = taskProfileUsesTaskDocument(profile) ? getTaskDocPath(task) : null;
  const primaryArtifact = resolveTaskProfilePrimaryArtifact(task, {
    effectiveCwd,
    taskProfile: profile,
    ...(taskDocPath !== null ? { taskDocPath } : {}),
    ...((activeAssignment?.agentId ?? task.assigneeAgentId ?? task.createdByAgentId)
      ? { agentId: activeAssignment?.agentId ?? task.assigneeAgentId ?? task.createdByAgentId }
      : {}),
    ...((activeAssignment?.sessionName ?? task.assigneeSessionName)
      ? { sessionName: activeAssignment?.sessionName ?? task.assigneeSessionName }
      : {}),
  });
  const items = resolveTaskProfileArtifacts(task, {
    effectiveCwd,
    taskProfile: profile,
    ...(taskDocPath !== null ? { taskDocPath } : {}),
    ...((activeAssignment?.agentId ?? task.assigneeAgentId ?? task.createdByAgentId)
      ? { agentId: activeAssignment?.agentId ?? task.assigneeAgentId ?? task.createdByAgentId }
      : {}),
    ...((activeAssignment?.sessionName ?? task.assigneeSessionName)
      ? { sessionName: activeAssignment?.sessionName ?? task.assigneeSessionName }
      : {}),
  }).map((artifact) => {
    const absolutePath = workspaceRoot || !artifact.path.startsWith("/tmp/") ? artifact.path : null;
    return createTaskSurfaceArtifact({
      kind: artifact.kind,
      role:
        primaryArtifact && primaryArtifact.kind === artifact.kind && primaryArtifact.path === artifact.path
          ? "primary"
          : "supporting",
      label: artifact.label,
      absolutePath,
      workspaceRelativePath: resolveWorkspaceRelativePath(artifact.path, artifactWorkspaceRoot),
      exists: absolutePath ? existsSync(absolutePath) : null,
    });
  });

  return {
    ...createEmptyTaskArtifactSummary(workspaceRoot),
    items,
    primary: items.find((item) => item.role === "primary") ?? null,
  };
}

function resolveTaskDocumentPathForProfile(
  task: Pick<TaskRecord, "id" | "taskDir">,
  profile: ResolvedTaskProfile,
): string | null {
  return taskProfileUsesTaskDocument(profile) ? getTaskDocPath(task) : null;
}

function formatTaskSurfaceArtifactPath(artifact: TaskSurfaceArtifact | null | undefined): string | null {
  return artifact?.path.displayPath ?? artifact?.path.absolutePath ?? null;
}

function resolvePrimaryArtifactLine(task: TaskRecord): string | null {
  const primaryArtifact = buildTaskArtifactSummary(task).primary;
  const primaryArtifactPath = formatTaskSurfaceArtifactPath(primaryArtifact);
  if (!primaryArtifact || !primaryArtifactPath) {
    return null;
  }
  return `${primaryArtifact.label}: ${primaryArtifactPath}`;
}

function normalizeTaskString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveTaskArchiveMode(input?: {
  archived?: boolean;
  all?: boolean;
  archiveMode?: TaskArchiveMode;
}): TaskArchiveMode {
  if (input?.archiveMode) {
    return input.archiveMode;
  }
  if (input?.archived) {
    return "only";
  }
  if (input?.all) {
    return "include";
  }
  return "exclude";
}

function buildTaskDependencyEdge(
  dependency: TaskDependencyRecord,
  direction: "dependency" | "dependent",
): TaskDependencyEdge {
  const relatedTaskId = direction === "dependency" ? dependency.dependsOnTaskId : dependency.taskId;
  const relatedTask = dbGetTask(relatedTaskId);
  const relatedActiveAssignment = relatedTask ? dbGetActiveAssignment(relatedTaskId) : null;
  return {
    direction,
    taskId: dependency.taskId,
    relatedTaskId,
    relatedTaskTitle: relatedTask?.title ?? relatedTaskId,
    relatedTaskStatus: relatedTask ? deriveTaskReadStatus(relatedTask, relatedActiveAssignment) : "open",
    relatedTaskProgress: relatedTask?.progress ?? 0,
    ...(relatedTask?.assigneeAgentId ? { relatedTaskAssigneeAgentId: relatedTask.assigneeAgentId } : {}),
    ...(relatedTask?.assigneeSessionName ? { relatedTaskAssigneeSessionName: relatedTask.assigneeSessionName } : {}),
    satisfied: typeof dependency.satisfiedAt === "number",
    createdAt: dependency.createdAt,
    ...(typeof dependency.satisfiedAt === "number" ? { satisfiedAt: dependency.satisfiedAt } : {}),
    ...(typeof dependency.satisfiedByEventId === "number" ? { satisfiedByEventId: dependency.satisfiedByEventId } : {}),
  };
}

export function getTaskDependencySurface(
  task: Pick<TaskRecord, "id" | "status"> & Partial<TaskRecord>,
  activeAssignment?: TaskAssignment | null,
): TaskDependencySurface {
  const dependencies = dbListTaskDependencies(task.id).map((dependency) =>
    buildTaskDependencyEdge(dependency, "dependency"),
  );
  const dependents = dbListTaskDependents(task.id).map((dependency) =>
    buildTaskDependencyEdge(dependency, "dependent"),
  );
  const launchPlan = dbGetTaskLaunchPlan(task.id);
  const satisfiedDependencyCount = dependencies.filter((dependency) => dependency.satisfied).length;
  const unsatisfiedDependencies = dependencies.filter((dependency) => !dependency.satisfied);
  const activeStatus = deriveTaskReadStatus(task as Pick<TaskRecord, "status">, activeAssignment);

  let state: TaskReadiness["state"];
  let label: string;
  let canStart = false;
  if (activeStatus === "done" || activeStatus === "failed") {
    state = "terminal";
    label = `terminal (${activeStatus})`;
  } else if (activeStatus === "dispatched" || activeStatus === "in_progress" || activeStatus === "blocked") {
    state = "active";
    label = activeStatus === "blocked" ? "already started; currently blocked" : "already started";
  } else if (unsatisfiedDependencies.length > 0) {
    state = "waiting";
    label = `waiting on ${unsatisfiedDependencies.length}/${dependencies.length} dependencies`;
  } else {
    state = "ready";
    label = launchPlan ? "ready; launch plan armed" : "ready to start";
    canStart = true;
  }

  return {
    dependencies,
    dependents,
    launchPlan,
    readiness: {
      state,
      label,
      canStart,
      dependencyCount: dependencies.length,
      satisfiedDependencyCount,
      unsatisfiedDependencyCount: unsatisfiedDependencies.length,
      unsatisfiedDependencyIds: unsatisfiedDependencies.map((dependency) => dependency.relatedTaskId),
      hasLaunchPlan: Boolean(launchPlan),
    },
  };
}

export function deriveTaskVisualStatus(
  task: Pick<TaskRecord, "id" | "status"> & Partial<TaskRecord>,
  readiness?: TaskReadiness,
  activeAssignment?: Pick<TaskAssignment, "status" | "acceptedAt"> | null,
): TaskStatus | "waiting" {
  const activeStatus = deriveTaskReadStatus(task as Pick<TaskRecord, "status">, activeAssignment);
  const effectiveReadiness =
    readiness ?? getTaskDependencySurface(task, activeAssignment as TaskAssignment | null).readiness;
  if (activeStatus === "open" && effectiveReadiness.state === "waiting") {
    return "waiting";
  }
  return activeStatus;
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
  const profile = resolveTaskProfileForTask(task);
  const primaryArtifactLine = resolvePrimaryArtifactLine(task);
  const syncInstruction = taskProfileRequiresTaskDocument(profile)
    ? "Se isso mudar teu plano, atualize primeiro o TASK.md e depois sincronize o runtime com ravi tasks report|block|done|fail."
    : "Se isso mudar teu plano, atualize o artifact/contexto do profile e sincronize o runtime com ravi tasks report|block|done|fail.";
  return `[System] Inform: Novo comentário na task ${task.id} (${task.title}).

Autor: ${author}
Status atual: ${task.status}
Progresso atual: ${task.progress}%
Profile: ${profile.id}
${primaryArtifactLine ? `${primaryArtifactLine}\n` : ""}

Comentário:
${comment.body}

${syncInstruction}`;
}

export function buildTaskCheckpointReminderPrompt(
  task: TaskRecord,
  assignment: Pick<TaskAssignment, "checkpointDueAt" | "checkpointIntervalMs" | "checkpointOverdueCount">,
): string {
  const profile = resolveTaskProfileForTask(task);
  const primaryArtifactLine = resolvePrimaryArtifactLine(task);
  const syncInstruction = taskProfileRequiresTaskDocument(profile)
    ? "Atualize primeiro o TASK.md e depois sincronize via ravi tasks report|block|done|fail."
    : "Atualize o artifact/contexto do profile e depois sincronize via ravi tasks report|block|done|fail.";

  return `[System] Inform: Checkpoint vencido na task ${task.id} (${task.title}).

Status atual: ${task.status}
Progresso atual: ${task.progress}%
Profile: ${profile.id}
${primaryArtifactLine ? `Artifact primário: ${primaryArtifactLine}\n` : ""}Overdues: ${assignment.checkpointOverdueCount ?? 1}
Próximo checkpoint: ${assignment.checkpointDueAt ? new Date(assignment.checkpointDueAt).toISOString() : "-"}

${syncInstruction}`;
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
  const profile = resolveTaskProfileForTask(task);
  const primaryArtifactLine = resolvePrimaryArtifactLine(task);
  if (task.status === "blocked") {
    return [
      `Task filha ${task.id} (${task.title}) entrou em blocked.`,
      `Profile: ${profile.id}.`,
      `Assignee: ${task.assigneeAgentId ?? "-"}.`,
      `Session: ${task.assigneeSessionName ?? "-"}.`,
      ...(primaryArtifactLine ? [`Artifact: ${primaryArtifactLine}.`] : []),
      `Blocker: ${summary}.`,
    ].join(" ");
  }

  return [
    `Task filha ${task.id} (${task.title}) terminalizou com status ${task.status}.`,
    `Profile: ${profile.id}.`,
    `Assignee: ${task.assigneeAgentId ?? "-"}.`,
    `Session: ${task.assigneeSessionName ?? "-"}.`,
    ...(primaryArtifactLine ? [`Artifact: ${primaryArtifactLine}.`] : []),
    `Resumo: ${summary}.`,
  ].join(" ");
}

function buildChildStateDocSection(task: TaskRecord, callbackEvent: TaskEvent): TaskDocSection {
  const summary = task.summary ?? task.blockerReason ?? task.status;
  const profile = resolveTaskProfileForTask(task);
  const primaryArtifactLine = resolvePrimaryArtifactLine(task);
  const title =
    task.status === "blocked" ? "Child Task Blocked" : task.status === "done" ? "Child Task Done" : "Child Task Failed";
  const statusLabel = task.status === "blocked" ? "Status atual" : "Status final";
  const summaryLabel = task.status === "blocked" ? "Blocker" : "Resumo";
  return buildTaskDocSection(title, callbackEvent.createdAt, [
    `Filha: \`${task.id}\` - ${task.title}`,
    `Profile: \`${profile.id}\``,
    `${statusLabel}: \`${task.status}\``,
    `Progresso: \`${task.progress}%\``,
    `Assignee: \`${task.assigneeAgentId ?? "-"}\``,
    `Session: \`${task.assigneeSessionName ?? "-"}\``,
    ...(primaryArtifactLine ? [`Artifact: \`${primaryArtifactLine}\``] : []),
    `${summaryLabel}: ${summary}`,
  ]);
}

function buildTaskRuntimeStateDocSection(task: TaskRecord, event: TaskEvent): TaskDocSection {
  const title =
    event.type === "task.done"
      ? "Task Done"
      : event.type === "task.failed"
        ? "Task Failed"
        : event.type === "task.blocked"
          ? "Task Blocked"
          : event.type === "task.archived"
            ? "Task Archived"
            : event.type === "task.unarchived"
              ? "Task Restored"
              : "Task Runtime Update";

  const lines = [
    `Evento: \`${event.type}\``,
    `Status atual: \`${task.status}\``,
    `Progresso atual: \`${task.progress}%\``,
  ];

  if (task.summary) {
    lines.push(`Resumo: ${task.summary}`);
  } else if (event.type === "task.failed" && event.message) {
    lines.push(`Falha: ${event.message}`);
  }

  if (task.blockerReason) {
    lines.push(`Blocker: ${task.blockerReason}`);
  } else if (event.type === "task.blocked" && event.message) {
    lines.push(`Blocker: ${event.message}`);
  }

  if (typeof task.archivedAt === "number") {
    lines.push(`Arquivada em: \`${new Date(task.archivedAt).toISOString()}\``);
  }
  if (task.archiveReason) {
    lines.push(`Motivo do archive: ${task.archiveReason}`);
  } else if ((event.type === "task.archived" || event.type === "task.unarchived") && event.message) {
    lines.push(`Mensagem: ${event.message}`);
  }

  if (
    !task.summary &&
    !task.blockerReason &&
    !task.archiveReason &&
    event.message &&
    event.type !== "task.archived" &&
    event.type !== "task.unarchived"
  ) {
    lines.push(`Mensagem: ${event.message}`);
  }

  return buildTaskDocSection(title, event.createdAt, lines);
}

function syncRequiredTaskDocumentAfterRuntimeEvent(
  task: TaskRecord,
  profile: ResolvedTaskProfile,
  event: TaskEvent,
): TaskRecord {
  if (!taskProfileRequiresTaskDocument(profile)) {
    return task;
  }

  return appendTaskDocumentSection(task, buildTaskRuntimeStateDocSection(task, event), {
    profile,
    initializeSection: buildTaskMaterializedDocSection(task),
  });
}

function ensureResolvedTaskProfile(
  task: TaskRecord,
  options: {
    persistMissingProfileId?: boolean;
    persistMissingProfileState?: boolean;
  } = {},
): { task: TaskRecord; profile: ResolvedTaskProfile } {
  let resolvedTask = task;
  let profile = resolveTaskProfileForTask(resolvedTask);

  if (
    !resolvedTask.profileSnapshot ||
    !resolvedTask.profileVersion ||
    !resolvedTask.profileSource ||
    (options.persistMissingProfileId && !resolvedTask.profileId)
  ) {
    resolvedTask = dbSetTaskProfileResolution(resolvedTask.id, {
      profileId: profile.id,
      profileVersion: profile.version,
      profileSource: profile.source,
      profileSnapshot: buildTaskProfileSnapshot(profile),
    });
    profile = resolveTaskProfileForTask(resolvedTask);
  }

  if ((options.persistMissingProfileState ?? true) && shouldPersistTaskProfileState(resolvedTask, profile)) {
    const profileState = resolveTaskProfileState(resolvedTask, profile);
    if (profileState) {
      resolvedTask = dbSetTaskProfileState(resolvedTask.id, profileState);
    }
  }

  return { task: resolvedTask, profile };
}

function ensureTaskWorkspaceBootstrap(task: TaskRecord, profile: ResolvedTaskProfile): TaskRecord {
  let ensuredTask = task;
  if (profile.workspaceBootstrap.ensureTaskDir && !ensuredTask.taskDir) {
    ensuredTask = dbSetTaskDir(ensuredTask.id, getCanonicalTaskDir(ensuredTask.id));
  }

  if (profile.workspaceBootstrap.ensureTaskDir && ensuredTask.taskDir) {
    mkdirSync(ensuredTask.taskDir, { recursive: true });
  }

  return ensuredTask;
}

function assertTaskDocumentInvariant(
  task: Pick<TaskRecord, "id" | "taskDir">,
  profile: ResolvedTaskProfile,
  stage: string,
): void {
  if (!taskProfileUsesTaskDocument(profile) && taskDocExists(task)) {
    throw new Error(
      `Task ${task.id} profile ${profile.id} forbids TASK.md, but found unexpected ${getTaskDocPath(task)} during ${stage}. Remove the legacy TASK.md before continuing.`,
    );
  }
}

function validateTaskCreateProfileOrThrow(
  input: Pick<CreateTaskInput, "title" | "instructions" | "priority">,
  profile: ResolvedTaskProfile,
  profileInput: Record<string, string>,
): void {
  previewTaskProfile(profile.id, {
    title: input.title,
    instructions: input.instructions,
    priority: input.priority,
    input: profileInput,
  });
}

function validateTaskProfileRuntimeOrThrow(
  task: TaskRecord,
  profile: ResolvedTaskProfile,
  options: {
    stage: string;
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    agentId?: string;
    sessionName?: string;
    validateDispatch?: boolean;
    validateResume?: boolean;
  },
): { taskDocPath: string | null; primaryArtifact: TaskProfileArtifactRef | null } {
  assertTaskDocumentInvariant(task, profile, options.stage);

  const taskDocPath = resolveTaskDocumentPathForProfile(task, profile);
  const primaryArtifact = resolveTaskProfilePrimaryArtifact(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(taskDocPath !== null ? { taskDocPath } : {}),
    taskProfile: profile,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
  });

  resolveTaskProfileArtifacts(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(taskDocPath !== null ? { taskDocPath } : {}),
    taskProfile: profile,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
  });

  if (options.validateDispatch) {
    if (!options.agentId || !options.sessionName) {
      throw new Error(`Task ${task.id} dispatch validation requires agentId and sessionName.`);
    }
    buildTaskDispatchPromptForProfile(task, options.agentId, options.sessionName, {
      effectiveCwd: options.effectiveCwd,
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(taskDocPath !== null ? { taskDocPath } : {}),
      taskProfile: profile,
      primaryArtifact,
    });
    buildTaskDispatchSummaryForProfile(task, {
      effectiveCwd: options.effectiveCwd,
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(taskDocPath !== null ? { taskDocPath } : {}),
      taskProfile: profile,
      primaryArtifact,
      agentId: options.agentId,
      sessionName: options.sessionName,
    });
    buildTaskDispatchEventMessageForProfile(
      task,
      {
        agentId: options.agentId,
        sessionName: options.sessionName,
      },
      {
        effectiveCwd: options.effectiveCwd,
        ...(options.worktree ? { worktree: options.worktree } : {}),
        ...(taskDocPath !== null ? { taskDocPath } : {}),
        taskProfile: profile,
        primaryArtifact,
      },
    );
  }

  if (options.validateResume) {
    buildTaskResumePromptForProfile(task, {
      effectiveCwd: options.effectiveCwd,
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(taskDocPath !== null ? { taskDocPath } : {}),
      taskProfile: profile,
      primaryArtifact,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    });
  }

  return { taskDocPath, primaryArtifact };
}

function surfaceTaskRecordForRead(task: TaskRecord): { task: TaskRecord; profile: ResolvedTaskProfile } {
  const profile = resolveTaskProfileForTask(task);
  assertTaskDocumentInvariant(task, profile, "task.read");
  return {
    task: {
      ...task,
      profileId: task.profileId ?? profile.id,
      profileVersion: task.profileVersion ?? profile.version,
      profileSource: task.profileSource ?? profile.source,
      profileSnapshot: task.profileSnapshot ?? buildTaskProfileSnapshot(profile),
    },
    profile,
  };
}

export function resolveTaskWorktreeContext(
  agentCwd: string,
  task: TaskRecord,
  profile: ResolvedTaskProfile,
  worktree?: TaskWorktreeConfig,
): TaskWorktreeConfig | undefined {
  if (worktree) {
    if (worktree.mode === "inherit") {
      return worktree;
    }

    const expandedPath = expandHome(worktree.path ?? "");
    const resolvedPath = isAbsolute(expandedPath) ? expandedPath : resolvePath(agentCwd, expandedPath);
    return {
      ...worktree,
      path: resolvedPath,
    };
  }

  if (profile.workspaceBootstrap.mode === "task_dir" && task.taskDir) {
    return {
      mode: "path",
      path: task.taskDir,
      ...(profile.workspaceBootstrap.branch ? { branch: profile.workspaceBootstrap.branch } : {}),
    };
  }

  if (profile.workspaceBootstrap.mode === "path" && profile.workspaceBootstrap.path) {
    const expandedPath = expandHome(profile.workspaceBootstrap.path);
    const resolvedPath = isAbsolute(expandedPath) ? expandedPath : resolvePath(agentCwd, expandedPath);
    return {
      mode: "path",
      path: resolvedPath,
      ...(profile.workspaceBootstrap.branch ? { branch: profile.workspaceBootstrap.branch } : {}),
    };
  }

  return undefined;
}

export function resolveTaskSessionContext(
  task: TaskRecord,
  profile: ResolvedTaskProfile,
  agentId: string,
  sessionName: string,
  worktreeInput?: TaskWorktreeConfig,
): { agentId: string; sessionName: string; sessionCwd: string; worktree?: TaskWorktreeConfig } {
  const resolvedAgent = requireTaskRuntimeAgent(agentId);
  const sessionCwd = resolvedAgent.cwd;
  const worktree = resolveTaskWorktreeContext(sessionCwd, task, profile, worktreeInput ?? task.worktree);
  const existingSession = resolveSession(sessionName);
  if (existingSession && existingSession.agentId !== resolvedAgent.id) {
    throw new Error(
      `Session ${sessionName} already belongs to agent ${existingSession.agentId}, not ${resolvedAgent.id}.`,
    );
  }

  const sessionKey = existingSession?.sessionKey ?? sessionName;
  const session = getOrCreateSession(sessionKey, resolvedAgent.id, sessionCwd, {
    name: existingSession?.name ?? sessionName,
  });

  return {
    agentId: resolvedAgent.id,
    sessionName: session.name ?? sessionName,
    sessionCwd,
    ...(worktree ? { worktree } : {}),
  };
}

function assertTaskStartAllowed(task: TaskRecord, action: "dispatch" | "arm a launch plan"): void {
  if (task.archivedAt) {
    throw new Error(`Task ${task.id} is archived. Unarchive it before you ${action}.`);
  }
}

function prepareTaskDispatchContext(
  task: TaskRecord,
  input: DispatchTaskInput,
  options: {
    materializeSession: boolean;
  },
): {
  task: TaskRecord;
  profile: ResolvedTaskProfile;
  agentId: string;
  sessionName: string;
  sessionCwd: string;
  worktree?: TaskWorktreeConfig;
  taskDocPath: string | null;
  primaryArtifact: TaskProfileArtifactRef | null;
} {
  assertTaskStartAllowed(task, options.materializeSession ? "dispatch" : "arm a launch plan");

  const { task: profiledTask, profile } = ensureResolvedTaskProfile(task, { persistMissingProfileId: true });
  const bootstrappedTask = ensureTaskWorkspaceBootstrap(profiledTask, profile);
  const resolvedAgent = requireTaskRuntimeAgent(input.agentId);
  const sessionCwd = resolvedAgent.cwd;
  const worktree = resolveTaskWorktreeContext(
    sessionCwd,
    bootstrappedTask,
    profile,
    input.worktree ?? bootstrappedTask.worktree,
  );
  const existingSession = resolveSession(input.sessionName);
  if (existingSession && existingSession.agentId !== resolvedAgent.id) {
    throw new Error(
      `Session ${input.sessionName} already belongs to agent ${existingSession.agentId}, not ${resolvedAgent.id}.`,
    );
  }

  const sessionName = options.materializeSession
    ? (getOrCreateSession(existingSession?.sessionKey ?? input.sessionName, resolvedAgent.id, sessionCwd, {
        name: existingSession?.name ?? input.sessionName,
      }).name ??
      existingSession?.name ??
      input.sessionName)
    : (existingSession?.name ?? input.sessionName);

  const { taskDocPath, primaryArtifact } = validateTaskProfileRuntimeOrThrow(bootstrappedTask, profile, {
    stage: "task.dispatch",
    effectiveCwd: sessionCwd,
    ...(worktree ? { worktree } : {}),
    agentId: resolvedAgent.id,
    sessionName,
    validateDispatch: true,
    validateResume: true,
  });

  return {
    task: bootstrappedTask,
    profile,
    agentId: resolvedAgent.id,
    sessionName,
    sessionCwd,
    ...(worktree ? { worktree } : {}),
    taskDocPath,
    primaryArtifact,
  };
}

function toTaskStreamEntity(task: TaskRecord, activeAssignment?: TaskAssignment | null): TaskStreamTaskEntity {
  const profile = resolveTaskProfileForTask(task);
  const status = deriveTaskReadStatus(task, activeAssignment);
  const dependencySurface = getTaskDependencySurface(task, activeAssignment);
  const workflow = dbGetTaskWorkflowSurface(task.id);
  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    status,
    visualStatus: deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment),
    priority: task.priority,
    progress: task.progress,
    profileId: profile.id,
    taskProfile: profile,
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
    archivedAt: task.archivedAt ?? null,
    archivedBy: task.archivedBy ?? null,
    archiveReason: task.archiveReason ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    dispatchedAt: task.dispatchedAt ?? null,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    readiness: dependencySurface.readiness,
    launchPlan: dependencySurface.launchPlan,
    dependencyCount: dependencySurface.readiness.dependencyCount,
    satisfiedDependencyCount: dependencySurface.readiness.satisfiedDependencyCount,
    unsatisfiedDependencyCount: dependencySurface.readiness.unsatisfiedDependencyCount,
    workflow,
    project: workflow ? getProjectSurfaceByWorkflowRunId(workflow.workflowRunId) : null,
    artifacts: buildTaskArtifactSummary(task, activeAssignment),
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

function resolveTaskReportEffectiveCwd(task: TaskRecord): string {
  const agentId = task.assigneeAgentId?.trim();
  if (!agentId) {
    return task.taskDir?.trim() || process.cwd();
  }

  const agent = getAgent(agentId);
  return agent?.cwd ? expandHome(agent.cwd) : task.taskDir?.trim() || process.cwd();
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

  const profile = resolveTaskProfileForTask(task);
  const sourceSessionName = task.assigneeSessionName?.trim() || event.sessionName?.trim() || task.id;
  const effectiveCwd = resolveTaskReportEffectiveCwd(task);
  const worktree = latestAssignment?.worktree ?? task.worktree;
  const taskDocPath = resolveTaskDocumentPathForProfile(task, profile);
  const primaryArtifact = resolveTaskProfilePrimaryArtifact(task, {
    effectiveCwd,
    ...(worktree ? { worktree } : {}),
    ...(taskDocPath !== undefined ? { taskDocPath } : {}),
    taskProfile: profile,
    ...(task.assigneeAgentId ? { agentId: task.assigneeAgentId } : {}),
    sessionName: sourceSessionName,
  });
  await publishSessionPrompt(reportToSessionName, {
    prompt: `[System] Answer: [from: ${sourceSessionName}] ${buildTaskReportMessageForProfile(task, reportEvent, {
      effectiveCwd,
      sourceSessionName,
      ...(worktree ? { worktree } : {}),
      ...(taskDocPath !== undefined ? { taskDocPath } : {}),
      taskProfile: profile,
      ...(primaryArtifact !== undefined ? { primaryArtifact } : {}),
      ...(task.assigneeAgentId ? { agentId: task.assigneeAgentId } : {}),
      sessionName: sourceSessionName,
      message: task.summary ?? task.blockerReason ?? event.message ?? null,
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

function summarizeTaskEntities(tasks: TaskStreamTaskEntity[]): TaskStreamStats {
  return summarizeTasks(tasks.map((task) => ({ status: task.status }) as TaskRecord));
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

export function requireTaskRuntimeAgent(agentId: string): { id: string; cwd: string } {
  const normalizedAgentId = agentId.trim();
  const agent = getAgent(normalizedAgentId);
  if (!agent) {
    throw new Error(`Agent not found in runtime config: ${normalizedAgentId}`);
  }

  return {
    id: normalizedAgentId,
    cwd: expandHome(agent.cwd),
  };
}

export function resolveTaskCreateAssigneeAgent(agentId?: string, assigneeAgentId?: string): string | undefined {
  const resolvedAgentId = resolveTaskCreateAssignee(agentId, assigneeAgentId);
  if (!resolvedAgentId) {
    return undefined;
  }

  return requireTaskRuntimeAgent(resolvedAgentId).id;
}

export function isTaskStreamCommand(name: string): name is TaskStreamCommandName {
  return (TASK_STREAM_COMMAND_NAMES as readonly string[]).includes(name);
}

export function buildTaskEventPayload(task: TaskRecord, event: TaskEvent): TaskStreamEventPayload {
  const latestAssignment = dbListAssignments(task.id)[0] ?? null;
  const reportToSessionName = latestAssignment?.reportToSessionName ?? task.reportToSessionName ?? null;
  const reportEvents = resolveTaskReportEvents(latestAssignment?.reportEvents ?? task.reportEvents);
  const profile = resolveTaskProfileForTask(task);
  const artifacts = buildTaskArtifactSummary(task, latestAssignment);
  const dependencySurface = getTaskDependencySurface(task, latestAssignment);
  const taskEntity = toTaskStreamEntity(task, latestAssignment);
  return {
    kind: "task.event",
    taskId: task.id,
    status: task.status,
    visualStatus: deriveTaskVisualStatus(task, dependencySurface.readiness, latestAssignment),
    priority: task.priority,
    progress: task.progress,
    profileId: profile.id,
    taskProfile: profile,
    archivedAt: task.archivedAt ?? null,
    archivedBy: task.archivedBy ?? null,
    archiveReason: task.archiveReason ?? null,
    parentTaskId: task.parentTaskId ?? null,
    createdByAgentId: task.createdByAgentId ?? null,
    createdBySessionName: task.createdBySessionName ?? null,
    dispatcherSessionName: latestAssignment?.assignedBySessionName ?? latestAssignment?.assignedBy ?? null,
    reportToSessionName,
    reportEvents,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
    readiness: dependencySurface.readiness,
    launchPlan: dependencySurface.launchPlan,
    activeAssignment: dbGetActiveAssignment(task.id),
    project: taskEntity.project,
    task: taskEntity,
    event,
    artifacts,
  };
}

export function buildTaskStreamSnapshot(args: Record<string, unknown> = {}): TaskStreamSnapshotEntity {
  const parsed = TaskSnapshotArgsSchema.parse(args);
  const archiveMode = resolveTaskArchiveMode(parsed);
  if (parsed.taskId) {
    const details = getTaskDetails(parsed.taskId);
    if (!details.task) {
      throw new Error(`Task not found: ${parsed.taskId}`);
    }
    const selectedTask = toTaskStreamEntity(details.task, details.activeAssignment);
    const dependencySurface = getTaskDependencySurface(details.task, details.activeAssignment);

    return {
      query: {
        taskId: parsed.taskId,
        status: null,
        agentId: null,
        sessionName: null,
        archiveMode,
        eventsLimit: parsed.eventsLimit,
      },
      items: [selectedTask],
      stats: summarizeTaskEntities([selectedTask]),
      artifacts: selectedTask.artifacts,
      selectedTask: {
        task: selectedTask,
        parentTask: details.parentTask ? toTaskStreamEntity(details.parentTask) : null,
        childTasks: details.childTasks.map((childTask) => toTaskStreamEntity(childTask)),
        dependencies: dependencySurface.dependencies,
        dependents: dependencySurface.dependents,
        launchPlan: dependencySurface.launchPlan,
        readiness: dependencySurface.readiness,
        activeAssignment: details.activeAssignment,
        assignments: details.assignments,
        events: details.events.slice(-parsed.eventsLimit),
        comments: details.comments.slice(-parsed.eventsLimit),
      },
    };
  }

  const rawStatusFilter = parsed.status === "dispatched" || parsed.status === "in_progress" ? undefined : parsed.status;
  const tasks = listTasks({
    ...(rawStatusFilter ? { status: rawStatusFilter } : {}),
    ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    ...(parsed.sessionName ? { sessionName: parsed.sessionName } : {}),
    archiveMode,
  });
  const items = tasks
    .map((task) => {
      const activeAssignment = dbGetActiveAssignment(task.id);
      return toTaskStreamEntity(task, activeAssignment);
    })
    .filter((task) => (parsed.status ? task.status === parsed.status : true));

  return {
    query: {
      taskId: null,
      status: parsed.status ?? null,
      agentId: parsed.agentId ?? null,
      sessionName: parsed.sessionName ?? null,
      archiveMode,
      eventsLimit: parsed.eventsLimit,
    },
    items,
    stats: summarizeTaskEntities(items),
    artifacts: createEmptyTaskArtifactSummary(),
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
      const assigneeAgentId = resolveTaskCreateAssigneeAgent(args.agentId, args.assigneeAgentId);
      const created = await createTask({
        title: args.title,
        instructions: args.instructions,
        priority: args.priority,
        ...(args.profileId ? { profileId: args.profileId } : {}),
        ...(args.dependsOnTaskIds ? { dependsOnTaskIds: args.dependsOnTaskIds } : {}),
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
      for (const relatedEvent of created.relatedEvents) {
        await emitTaskEvent(relatedEvent.task, relatedEvent.event);
      }

      if (assigneeAgentId) {
        const dispatch = await queueOrDispatchTask(created.task.id, {
          agentId: assigneeAgentId,
          sessionName: args.sessionName ?? getDefaultTaskSessionNameForTask(created.task),
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
          ...(dispatch.mode === "dispatched"
            ? {
                dispatch: {
                  assignment: dispatch.assignment,
                  event: dispatch.event,
                  sessionName: dispatch.sessionName,
                },
              }
            : {
                launchPlan: dispatch.launchPlan,
                readiness: dispatch.readiness,
              }),
        };
      }

      return {
        action: name,
        task: toTaskStreamEntity(created.task),
        event: created.event,
        relatedEvents: created.relatedEvents,
      };
    }

    case "task.dispatch": {
      const args = TaskDispatchCommandArgsSchema.parse(rawArgs);
      const task = dbGetTask(args.taskId);
      const result = await queueOrDispatchTask(args.taskId, {
        agentId: args.agentId,
        sessionName:
          args.sessionName ?? (task ? getDefaultTaskSessionNameForTask(task) : getDefaultTaskSessionName(args.taskId)),
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
        event: result.event,
        ...(result.mode === "dispatched"
          ? {
              assignment: result.assignment,
              sessionName: result.sessionName,
            }
          : {
              launchPlan: result.launchPlan,
              readiness: result.readiness,
            }),
      };
    }

    case "task.report": {
      const args = TaskReportCommandArgsSchema.parse(rawArgs);
      const { task, event } = reportTaskProgress(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.message ?? "",
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

    case "task.archive": {
      const args = TaskArchiveCommandArgsSchema.parse(rawArgs);
      const result = archiveTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        reason: args.reason,
      });
      if (!result.wasNoop) {
        await emitTaskEvent(result.task, result.event);
      }
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
        event: result.event,
      };
    }

    case "task.unarchive": {
      const args = TaskUnarchiveCommandArgsSchema.parse(rawArgs);
      const result = unarchiveTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
      });
      if (!result.wasNoop) {
        await emitTaskEvent(result.task, result.event);
      }
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
        event: result.event,
      };
    }

    case "task.done": {
      const args = TaskDoneCommandArgsSchema.parse(rawArgs);
      const completion = await completeTask(args.taskId, {
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

export function getDefaultTaskSessionName(taskId: string, profileId?: string | null): string {
  return getDefaultTaskSessionNameForProfile(taskId, profileId);
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

  try {
    const { executeTaskAutomationsForEvent } = await import("./automations.js");
    await executeTaskAutomationsForEvent(task, event);
  } catch (error) {
    log.warn("Failed to execute task automations", {
      taskId: task.id,
      eventType: event.type,
      error,
    });
  }
}

export function buildTaskDispatchPrompt(
  task: TaskRecord,
  agentId: string,
  sessionName: string,
  options: {
    sessionCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
  },
): string {
  const taskProfile = options.taskProfile ?? resolveTaskProfileForTask(task);
  return buildTaskDispatchPromptForProfile(task, agentId, sessionName, {
    effectiveCwd: options.sessionCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
  });
}

export function buildTaskResumePrompt(
  task: TaskRecord,
  _agentId: string,
  _sessionName: string,
  options: {
    sessionCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
  },
): string {
  const taskProfile = options.taskProfile ?? resolveTaskProfileForTask(task);
  return buildTaskResumePromptForProfile(task, {
    effectiveCwd: options.sessionCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
  });
}

export function createTask(input: CreateTaskInput): {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
} {
  if (input.parentTaskId) {
    const parentTask = dbGetTask(input.parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task not found: ${input.parentTaskId}`);
    }
  }

  const dependencyIds = [...new Set((input.dependsOnTaskIds ?? []).map((taskId) => taskId.trim()).filter(Boolean))];
  for (const dependencyId of dependencyIds) {
    if (!dbGetTask(dependencyId)) {
      throw new Error(`Dependency task not found: ${dependencyId}`);
    }
  }

  const profile = resolveTaskProfile(requireTaskProfileDefinition(input.profileId).id);
  const profileInput = resolveTaskProfileInputValues(profile, input.profileInput);
  validateTaskCreateProfileOrThrow(input, profile, profileInput);
  const initialProfileState = resolveTaskProfileState(
    {
      title: input.title,
      profileId: profile.id,
      profileSnapshot: buildTaskProfileSnapshot(profile),
      profileInput,
    },
    profile,
  );
  const created = dbCreateTask({
    ...input,
    profileId: profile.id,
    profileVersion: profile.version,
    profileSource: profile.source,
    profileSnapshot: buildTaskProfileSnapshot(profile),
    ...(Object.keys(profileInput).length > 0 ? { profileInput } : {}),
    ...(initialProfileState ? { profileState: initialProfileState } : {}),
  });

  try {
    const { task: profiledTask, profile: resolvedProfile } = ensureResolvedTaskProfile(created.task, {
      persistMissingProfileState: true,
    });
    const bootstrappedTask = ensureTaskWorkspaceBootstrap(profiledTask, resolvedProfile);
    let task = taskProfileRequiresTaskDocument(resolvedProfile)
      ? ensureRequiredTaskDocument(bootstrappedTask, {
          profile: resolvedProfile,
          initializeSection: buildTaskCreatedDocSection(bootstrappedTask, created.event),
        })
      : bootstrappedTask;
    assertTaskDocumentInvariant(task, resolvedProfile, "task.create");
    const relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }> = [];
    for (const dependencyId of dependencyIds) {
      dbAddTaskDependency(task.id, dependencyId);
      const eventResult = dbAppendTaskEvent(
        task.id,
        "task.dependency.added",
        {
          actor: input.createdBy,
          agentId: input.createdByAgentId,
          sessionName: input.createdBySessionName,
          message: formatDependencyMutationMessage(task.id, dependencyId, "added"),
          relatedTaskId: dependencyId,
          progress: task.progress,
        },
        { touchTask: true },
      );
      task = eventResult.task;
      relatedEvents.push({ task: eventResult.task, event: eventResult.event });
    }
    return { task, event: created.event, relatedEvents };
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
  taskProfile: ResolvedTaskProfile | null;
  project: ProjectTaskSurface | null;
  parentTask: TaskRecord | null;
  childTasks: TaskRecord[];
  activeAssignment: ReturnType<typeof dbGetActiveAssignment>;
  assignments: ReturnType<typeof dbListAssignments>;
  events: ReturnType<typeof dbListTaskEvents>;
  comments: ReturnType<typeof dbListTaskComments>;
} {
  const task = dbGetTask(taskId);
  const surfacedTask = task ? surfaceTaskRecordForRead(task) : null;
  const parentTask =
    surfacedTask?.task.parentTaskId && dbGetTask(surfacedTask.task.parentTaskId)
      ? surfaceTaskRecordForRead(dbGetTask(surfacedTask.task.parentTaskId)!).task
      : null;
  return {
    task: surfacedTask?.task ?? null,
    taskProfile: surfacedTask?.profile ?? null,
    project: surfacedTask ? getTaskProjectSurface(surfacedTask.task.id) : null,
    parentTask,
    childTasks: surfacedTask
      ? dbListChildTasks(surfacedTask.task.id).map((childTask) => surfaceTaskRecordForRead(childTask).task)
      : [],
    activeAssignment: dbGetActiveAssignment(taskId),
    assignments: dbListAssignments(taskId),
    events: dbListTaskEvents(taskId, 200),
    comments: dbListTaskComments(taskId, 200),
  };
}

export function getTaskProjectSurface(taskId: string): ProjectTaskSurface | null {
  const workflow = dbGetTaskWorkflowSurface(taskId);
  return workflow ? getProjectSurfaceByWorkflowRunId(workflow.workflowRunId) : null;
}

function isTaskDependencyEditable(task: TaskRecord): boolean {
  return task.status === "open";
}

function assertTaskDependencyEditable(task: TaskRecord, action: "add" | "remove"): void {
  if (!isTaskDependencyEditable(task)) {
    throw new Error(
      `Cannot ${action} dependencies for task ${task.id} while status is ${task.status}. Dependencies gate start; edit them before dispatching work.`,
    );
  }
}

function taskDependsOn(taskId: string, targetTaskId: string, visited = new Set<string>()): boolean {
  if (taskId === targetTaskId) {
    return true;
  }
  if (visited.has(taskId)) {
    return false;
  }
  visited.add(taskId);
  return dbListTaskDependencies(taskId).some((dependency) =>
    taskDependsOn(dependency.dependsOnTaskId, targetTaskId, visited),
  );
}

function assertTaskDependencyEdge(taskId: string, dependsOnTaskId: string): void {
  if (taskId === dependsOnTaskId) {
    throw new Error("A task cannot depend on itself.");
  }
  if (taskDependsOn(dependsOnTaskId, taskId)) {
    throw new Error(`Dependency cycle detected: ${taskId} cannot depend on ${dependsOnTaskId}.`);
  }
}

function formatDependencyMutationMessage(taskId: string, dependsOnTaskId: string, verb: "added" | "removed"): string {
  return verb === "added"
    ? `Dependency added: ${taskId} now waits for ${dependsOnTaskId}.`
    : `Dependency removed: ${taskId} no longer waits for ${dependsOnTaskId}.`;
}

function buildDependencySatisfiedMessage(taskId: string, dependsOnTaskId: string): string {
  return `Dependency satisfied: ${taskId} no longer waits for ${dependsOnTaskId}.`;
}

function buildReadyMessage(_task: TaskRecord, launchPlan?: TaskLaunchPlan | null): string {
  return launchPlan
    ? `All dependencies satisfied; auto-dispatching via launch plan to ${launchPlan.agentId}/${launchPlan.sessionName}.`
    : "All dependencies satisfied; task is ready to start.";
}

export function getTaskLaunchPlan(taskId: string): TaskLaunchPlan | null {
  return dbGetTaskLaunchPlan(taskId);
}

async function reconcileTaskReadinessTransition(
  taskId: string,
  beforeUnsatisfiedCount: number,
): Promise<Array<{ task: TaskRecord; event: TaskEvent }>> {
  const task = dbGetTask(taskId);
  if (!task) {
    return [];
  }

  const dependencySurface = getTaskDependencySurface(task);
  if (
    task.archivedAt ||
    task.status !== "open" ||
    beforeUnsatisfiedCount <= 0 ||
    dependencySurface.readiness.unsatisfiedDependencyCount > 0
  ) {
    return [];
  }

  const readyEvent = dbAppendTaskEvent(
    taskId,
    "task.ready",
    {
      actor: "task.dependencies",
      message: buildReadyMessage(task, dependencySurface.launchPlan),
      progress: task.progress,
    },
    { touchTask: true },
  );
  const relatedEvents = [readyEvent];
  if (!dependencySurface.launchPlan) {
    return relatedEvents;
  }

  const dispatched = await dispatchTask(taskId, {
    agentId: dependencySurface.launchPlan.agentId,
    sessionName: dependencySurface.launchPlan.sessionName,
    assignedBy: dependencySurface.launchPlan.assignedBy ?? "task.launch-plan",
    ...(dependencySurface.launchPlan.assignedByAgentId
      ? { assignedByAgentId: dependencySurface.launchPlan.assignedByAgentId }
      : {}),
    ...(dependencySurface.launchPlan.assignedBySessionName
      ? { assignedBySessionName: dependencySurface.launchPlan.assignedBySessionName }
      : {}),
    ...(dependencySurface.launchPlan.worktree ? { worktree: dependencySurface.launchPlan.worktree } : {}),
    ...(typeof dependencySurface.launchPlan.checkpointIntervalMs === "number"
      ? { checkpointIntervalMs: dependencySurface.launchPlan.checkpointIntervalMs }
      : {}),
    ...(dependencySurface.launchPlan.reportToSessionName
      ? { reportToSessionName: dependencySurface.launchPlan.reportToSessionName }
      : {}),
    ...(dependencySurface.launchPlan.reportEvents ? { reportEvents: dependencySurface.launchPlan.reportEvents } : {}),
  });
  relatedEvents.push({ task: dispatched.task, event: dispatched.event });
  return relatedEvents;
}

export async function queueTaskLaunch(
  taskId: string,
  input: DispatchTaskInput,
): Promise<{
  mode: "launch_planned";
  task: TaskRecord;
  launchPlan: TaskLaunchPlan;
  readiness: TaskReadiness;
  event: TaskEvent;
}> {
  const task = dbGetTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const dependencySurface = getTaskDependencySurface(task);
  if (dependencySurface.readiness.unsatisfiedDependencyCount === 0) {
    throw new Error(`Task ${taskId} is already ready; dispatch it instead of arming a launch plan.`);
  }
  const prepared = prepareTaskDispatchContext(task, input, { materializeSession: false });
  const launchPlan = dbSetTaskLaunchPlan(taskId, {
    ...input,
    agentId: prepared.agentId,
    sessionName: prepared.sessionName,
    ...(prepared.worktree ? { worktree: prepared.worktree } : {}),
  });
  const eventResult = dbAppendTaskEvent(
    taskId,
    "task.launch-planned",
    {
      actor: input.assignedBy,
      agentId: launchPlan.agentId,
      sessionName: launchPlan.sessionName,
      message: `Launch plan armed for ${launchPlan.agentId}/${launchPlan.sessionName}.`,
      progress: task.progress,
    },
    { touchTask: true },
  );

  return {
    mode: "launch_planned",
    task: eventResult.task,
    launchPlan,
    readiness: getTaskDependencySurface(eventResult.task).readiness,
    event: eventResult.event,
  };
}

export async function queueOrDispatchTask(
  taskId: string,
  input: DispatchTaskInput,
): Promise<
  | ({
      mode: "launch_planned";
      launchPlan: TaskLaunchPlan;
      readiness: TaskReadiness;
    } & Awaited<ReturnType<typeof queueTaskLaunch>>)
  | ({
      mode: "dispatched";
      readiness: TaskReadiness;
    } & Awaited<ReturnType<typeof dispatchTask>>)
> {
  const task = dbGetTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const dependencySurface = getTaskDependencySurface(task);
  if (task.status === "open" && dependencySurface.readiness.unsatisfiedDependencyCount > 0) {
    const planned = await queueTaskLaunch(taskId, input);
    return {
      ...planned,
      mode: "launch_planned",
      readiness: planned.readiness,
    };
  }

  const dispatched = await dispatchTask(taskId, input);
  return {
    ...dispatched,
    mode: "dispatched",
    readiness: getTaskDependencySurface(dispatched.task, dispatched.assignment).readiness,
  };
}

export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
): Promise<{
  task: TaskRecord;
  dependency: TaskDependencyRecord;
  event: TaskEvent;
  readiness: TaskReadiness;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
}> {
  const task = dbGetTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  assertTaskDependencyEditable(task, "add");
  if (!dbGetTask(dependsOnTaskId)) {
    throw new Error(`Dependency task not found: ${dependsOnTaskId}`);
  }
  assertTaskDependencyEdge(taskId, dependsOnTaskId);
  const beforeUnsatisfiedCount = getTaskDependencySurface(task).readiness.unsatisfiedDependencyCount;
  const added = dbAddTaskDependency(taskId, dependsOnTaskId);
  if (added.wasNoop) {
    return {
      task,
      dependency: added.dependency,
      event: dbListTaskEvents(taskId, 1)[0] ?? {
        id: 0,
        taskId,
        type: "task.created",
        createdAt: task.createdAt,
      },
      readiness: getTaskDependencySurface(task).readiness,
      relatedEvents: [],
      wasNoop: true,
    };
  }
  const eventResult = dbAppendTaskEvent(
    taskId,
    "task.dependency.added",
    {
      actor: "task.dependencies",
      message: formatDependencyMutationMessage(taskId, dependsOnTaskId, "added"),
      relatedTaskId: dependsOnTaskId,
      progress: task.progress,
    },
    { touchTask: true },
  );
  const relatedEvents = await reconcileTaskReadinessTransition(taskId, beforeUnsatisfiedCount);
  return {
    task: eventResult.task,
    dependency: added.dependency,
    event: eventResult.event,
    readiness: getTaskDependencySurface(eventResult.task).readiness,
    relatedEvents,
    ...(added.wasNoop ? { wasNoop: true } : {}),
  };
}

export async function removeTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
): Promise<{
  task: TaskRecord;
  dependency: TaskDependencyRecord | null;
  event: TaskEvent;
  readiness: TaskReadiness;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
}> {
  const task = dbGetTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  assertTaskDependencyEditable(task, "remove");
  const beforeUnsatisfiedCount = getTaskDependencySurface(task).readiness.unsatisfiedDependencyCount;
  const removed = dbRemoveTaskDependency(taskId, dependsOnTaskId);
  if (removed.wasNoop) {
    return {
      task,
      dependency: removed.dependency,
      event: dbListTaskEvents(taskId, 1)[0] ?? {
        id: 0,
        taskId,
        type: "task.created",
        createdAt: task.createdAt,
      },
      readiness: getTaskDependencySurface(task).readiness,
      relatedEvents: [],
      wasNoop: true,
    };
  }
  const eventResult = dbAppendTaskEvent(
    taskId,
    "task.dependency.removed",
    {
      actor: "task.dependencies",
      message: formatDependencyMutationMessage(taskId, dependsOnTaskId, "removed"),
      relatedTaskId: dependsOnTaskId,
      progress: task.progress,
    },
    { touchTask: true },
  );
  const relatedEvents = await reconcileTaskReadinessTransition(taskId, beforeUnsatisfiedCount);
  return {
    task: eventResult.task,
    dependency: removed.dependency,
    event: eventResult.event,
    readiness: getTaskDependencySurface(eventResult.task).readiness,
    relatedEvents,
    ...(removed.wasNoop ? { wasNoop: true } : {}),
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
  const { task: callbackTask, profile } = ensureResolvedTaskProfile(callback.task, { persistMissingProfileId: true });
  const documentedParent = appendTaskDocumentSection(callbackTask, buildChildStateDocSection(task, callback.event), {
    profile,
    initializeSection: buildTaskMaterializedDocSection(callbackTask),
  });
  return [{ task: documentedParent, event: callback.event }];
}

async function buildDependencySatisfiedRelatedEvents(
  task: TaskRecord,
  event: TaskEvent,
): Promise<Array<{ task: TaskRecord; event: TaskEvent }>> {
  if (task.status !== "done" || typeof event.id !== "number") {
    return [];
  }

  const satisfiedDependencies = dbMarkTaskDependenciesSatisfiedByUpstream(task.id, event);
  const relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }> = [];
  const seen = new Set<string>();

  for (const dependency of satisfiedDependencies) {
    const dependentTask = dbGetTask(dependency.taskId);
    if (!dependentTask) {
      continue;
    }
    const beforeUnsatisfiedCount = getTaskDependencySurface(dependentTask).readiness.unsatisfiedDependencyCount + 1;
    const satisfiedEvent = dbAppendTaskEvent(
      dependentTask.id,
      "task.dependency.satisfied",
      {
        actor: event.actor ?? "task.dependencies",
        agentId: event.agentId,
        sessionName: event.sessionName,
        message: buildDependencySatisfiedMessage(dependentTask.id, task.id),
        relatedTaskId: task.id,
        progress: dependentTask.progress,
      },
      { touchTask: true },
    );
    relatedEvents.push(satisfiedEvent);

    if (seen.has(dependentTask.id)) {
      continue;
    }
    seen.add(dependentTask.id);
    const readinessEvents = await reconcileTaskReadinessTransition(dependentTask.id, beforeUnsatisfiedCount);
    relatedEvents.push(...readinessEvents);
  }

  return relatedEvents;
}

export async function dispatchTask(
  taskId: string,
  input: DispatchTaskInput,
): Promise<{
  task: TaskRecord;
  assignment: TaskAssignment;
  event: TaskEvent;
  sessionName: string;
  primaryArtifact: TaskProfileArtifactRef | null;
  dispatchSummary: string;
}> {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const dependencySurface = getTaskDependencySurface(existingTask);
  if (existingTask.status === "open" && dependencySurface.readiness.unsatisfiedDependencyCount > 0) {
    throw new Error(
      `Task ${taskId} is waiting on ${dependencySurface.readiness.unsatisfiedDependencyCount} dependencies. Arm a launch plan instead of dispatching it early.`,
    );
  }
  const {
    task: bootstrappedTask,
    profile,
    agentId,
    sessionName,
    sessionCwd,
    worktree,
    taskDocPath,
    primaryArtifact,
  } = prepareTaskDispatchContext(existingTask, input, { materializeSession: true });

  const { task, assignment, event } = dbDispatchTask(
    taskId,
    {
      ...input,
      agentId,
      sessionName,
      ...(worktree ? { worktree } : {}),
    },
    {
      eventMessage: buildTaskDispatchEventMessageForProfile(
        bootstrappedTask,
        {
          ...input,
          agentId,
          sessionName,
          ...(worktree ? { worktree } : {}),
        },
        {
          effectiveCwd: sessionCwd,
          ...(worktree ? { worktree } : {}),
          taskDocPath,
          taskProfile: profile,
          primaryArtifact,
        },
      ),
    },
  );
  const taskProfile = resolveTaskProfileForTask(task);
  const documentedTask = taskProfileRequiresTaskDocument(taskProfile)
    ? ensureRequiredTaskDocument(task, {
        profile: taskProfile,
        initializeSection: buildTaskMaterializedDocSection(task),
      })
    : ensureTaskWorkspaceBootstrap(task, taskProfile);
  const documentedTaskDocPath = resolveTaskDocumentPathForProfile(documentedTask, taskProfile);

  const prompt = buildTaskDispatchPrompt(documentedTask, agentId, sessionName, {
    sessionCwd,
    worktree,
    taskDocPath: documentedTaskDocPath,
    taskProfile,
    primaryArtifact,
  });
  syncWorkflowNodeRunForTask(documentedTask.id);
  await publishSessionPrompt(sessionName, {
    prompt,
    deliveryBarrier: "after_task",
    taskBarrierTaskId: documentedTask.id,
  });

  return {
    task: documentedTask,
    assignment,
    event,
    sessionName,
    primaryArtifact,
    dispatchSummary: buildTaskDispatchSummaryForProfile(documentedTask, {
      effectiveCwd: sessionCwd,
      ...(worktree ? { worktree } : {}),
      taskDocPath: documentedTaskDocPath,
      taskProfile,
      primaryArtifact,
      agentId,
      sessionName,
    }),
  };
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
        const { task: profiledTask, profile } = ensureResolvedTaskProfile(task, { persistMissingProfileId: true });
        const documentedTask = taskProfileRequiresTaskDocument(profile)
          ? ensureRequiredTaskDocument(profiledTask, {
              profile,
              initializeSection: buildTaskMaterializedDocSection(profiledTask),
            })
          : ensureTaskWorkspaceBootstrap(profiledTask, profile);
        const { sessionName, sessionCwd, worktree } = resolveTaskSessionContext(
          documentedTask,
          profile,
          assignment.agentId,
          assignment.sessionName,
          assignment.worktree ?? documentedTask.worktree,
        );
        const { taskDocPath, primaryArtifact } = validateTaskProfileRuntimeOrThrow(documentedTask, profile, {
          stage: "task.resume",
          effectiveCwd: sessionCwd,
          ...(worktree ? { worktree } : {}),
          agentId: assignment.agentId,
          sessionName,
          validateResume: true,
        });
        const prompt = buildTaskResumePrompt(documentedTask, assignment.agentId, sessionName, {
          sessionCwd,
          ...(worktree ? { worktree } : {}),
          ...(taskDocPath !== null ? { taskDocPath } : {}),
          taskProfile: profile,
          primaryArtifact,
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

  const openTasks = listTasks({ status: "open", archiveMode: "exclude" });
  for (const task of openTasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);

    const dependencySurface = getTaskDependencySurface(task);
    if (dependencySurface.readiness.state !== "ready" || !dependencySurface.launchPlan) {
      continue;
    }

    try {
      const dispatched = await dispatchTask(task.id, {
        agentId: dependencySurface.launchPlan.agentId,
        sessionName: dependencySurface.launchPlan.sessionName,
        assignedBy: dependencySurface.launchPlan.assignedBy ?? "task.launch-plan",
        ...(dependencySurface.launchPlan.assignedByAgentId
          ? { assignedByAgentId: dependencySurface.launchPlan.assignedByAgentId }
          : {}),
        ...(dependencySurface.launchPlan.assignedBySessionName
          ? { assignedBySessionName: dependencySurface.launchPlan.assignedBySessionName }
          : {}),
        ...(dependencySurface.launchPlan.worktree ? { worktree: dependencySurface.launchPlan.worktree } : {}),
        ...(typeof dependencySurface.launchPlan.checkpointIntervalMs === "number"
          ? { checkpointIntervalMs: dependencySurface.launchPlan.checkpointIntervalMs }
          : {}),
        ...(dependencySurface.launchPlan.reportToSessionName
          ? { reportToSessionName: dependencySurface.launchPlan.reportToSessionName }
          : {}),
        ...(dependencySurface.launchPlan.reportEvents
          ? { reportEvents: dependencySurface.launchPlan.reportEvents }
          : {}),
      });
      await emitTaskEvent(dispatched.task, dispatched.event);
      recoveredTaskIds.push(dispatched.task.id);
    } catch (error) {
      skipped.push({
        taskId: task.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { recoveredTaskIds, skipped };
}

export function reportTaskProgress(taskId: string, input: TaskProgressInput): { task: TaskRecord; event: TaskEvent } {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  return dbReportTaskProgress(taskId, {
    ...input,
    message: requireTaskProgressMessage(
      input.message,
      "Task progress requires a descriptive message. Update TASK.md frontmatter.progress_note or provide --message.",
    ),
  });
}

export function archiveTask(
  taskId: string,
  input: TaskArchiveInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  wasNoop?: boolean;
} {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { profile } = ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  const result = dbArchiveTask(taskId, input);
  const documentedTask = result.wasNoop
    ? result.task
    : syncRequiredTaskDocumentAfterRuntimeEvent(result.task, profile, result.event);
  return { ...result, task: documentedTask };
}

export function unarchiveTask(
  taskId: string,
  input: TaskUnarchiveInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  wasNoop?: boolean;
} {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { profile } = ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  const result = dbUnarchiveTask(taskId, input);
  const documentedTask = result.wasNoop
    ? result.task
    : syncRequiredTaskDocumentAfterRuntimeEvent(result.task, profile, result.event);
  return { ...result, task: documentedTask };
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

  const { task: profiledTask, profile: taskProfile } = ensureResolvedTaskProfile(task, {
    persistMissingProfileId: true,
  });
  const documentedTask = ensureTaskWorkspaceBootstrap(profiledTask, taskProfile);
  assertTaskDocumentInvariant(documentedTask, taskProfile, "task.comment");
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
  const updatedTask = appendTaskDocumentSection(eventResult.task, buildTaskCommentDocSection(comment), {
    profile: taskProfile,
    initializeSection: buildTaskMaterializedDocSection(eventResult.task),
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
  wasNoop?: boolean;
} {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { profile } = ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  const result = dbBlockTask(taskId, input);
  const documentedTask = result.wasNoop
    ? result.task
    : syncRequiredTaskDocumentAfterRuntimeEvent(result.task, profile, result.event);
  syncWorkflowNodeRunForTask(taskId);
  return {
    ...result,
    task: documentedTask,
    relatedEvents: result.wasNoop ? [] : buildChildStateRelatedEvents(result.task, result.event),
  };
}

export function failTask(
  taskId: string,
  input: TaskTerminalInput,
): {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
} {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { profile } = ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  const result = dbFailTask(taskId, input);
  const documentedTask = result.wasNoop
    ? result.task
    : syncRequiredTaskDocumentAfterRuntimeEvent(result.task, profile, result.event);
  syncWorkflowNodeRunForTask(taskId);
  return {
    ...result,
    task: documentedTask,
    relatedEvents: result.wasNoop ? [] : buildChildStateRelatedEvents(result.task, result.event),
  };
}

export async function completeTask(
  taskId: string,
  input: TaskTerminalInput,
): Promise<{
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
}> {
  const existingTask = dbGetTask(taskId);
  if (!existingTask) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const { profile } = ensureResolvedTaskProfile(existingTask, { persistMissingProfileId: true });
  const result = dbCompleteTask(taskId, input);
  const documentedTask = result.wasNoop
    ? result.task
    : syncRequiredTaskDocumentAfterRuntimeEvent(result.task, profile, result.event);
  syncWorkflowNodeRunForTask(taskId);
  const dependencyRelatedEvents = result.wasNoop
    ? []
    : await buildDependencySatisfiedRelatedEvents(result.task, result.event);
  return {
    ...result,
    task: documentedTask,
    relatedEvents: result.wasNoop
      ? []
      : [...buildChildStateRelatedEvents(result.task, result.event), ...dependencyRelatedEvents],
  };
}

import "reflect-metadata";
import { Arg, CliOnly, Command, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  decodeListCursor,
  encodeListCursor,
  parseListLimit,
  parseListOrder,
  parseListSort,
  parseListTimeBound,
  type ListOrder,
} from "../listing.js";
import { resolveSession } from "../../router/sessions.js";
import { nats } from "../../nats.js";
import { formatDurationMs, parseDurationMs } from "../../cron/schedule.js";
import { resolveTaskCheckpointIntervalMs } from "../../tasks/checkpoint.js";
import {
  TASK_REPORT_EVENTS,
  archiveTask,
  buildTaskArtifactSummary,
  buildTaskCreateOutputForProfile,
  buildTaskSessionLink,
  completeTask,
  commentTask,
  createTask,
  createTaskWorktreeConfig,
  deriveTaskVisualStatus,
  emitTaskEvent,
  deriveTaskReadStatus,
  formatTaskWorktree,
  formatTaskRuntimeOptions,
  getTaskDependencySurface,
  getTaskDocPath,
  getTaskActor,
  getTaskDetails,
  listTasks,
  getTaskProjectSurface,
  normalizeTaskProgressMessage,
  normalizeTaskRuntimeOptions,
  getDefaultTaskSessionNameForTask,
  queueOrDispatchTask,
  requireTaskRuntimeAgent,
  readTaskDocFrontmatter,
  resolveTaskProfile,
  resolveTaskProfileForTask,
  resolveTaskRuntimeForRead,
  reportTaskProgress,
  blockTask,
  failTask,
  taskProfileUsesArtifactFirstSync,
  taskProfileUsesTaskDocument,
  taskDocExists,
  unarchiveTask,
} from "../../tasks/index.js";
import { searchTagBindingsForSelector } from "../../tags/service.js";
import type {
  TaskAssignment,
  TaskArchiveMode,
  TaskComment,
  TaskDependencyEdge,
  TaskEvent,
  TaskPriority,
  TaskReadiness,
  TaskRecord,
  TaskReportEvent,
  TaskRuntimeOptions,
  TaskRuntimeResolution,
  TaskListCursor,
  TaskListOrder,
  TaskListSort,
  TaskStatus,
} from "../../tasks/types.js";
import {
  taskCommentReturnSchema,
  taskCreateReturnSchema,
  taskDispatchReturnSchema,
  taskListReturnSchema,
  taskMutationReturnSchema,
  taskShowReturnSchema,
} from "./operational-return-schemas.js";

const VALID_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const VALID_STATUSES = new Set<TaskStatus>(["open", "dispatched", "in_progress", "blocked", "done", "failed"]);
const TASK_WATCH_RECONNECT_DELAY_MS = 1000;
const DEFAULT_TASK_LIST_LAST = 30;
const MAX_TASK_LIST_LIMIT = 500;
const DEFAULT_TASK_LIST_WINDOW = "1d";
const DEFAULT_TASK_SHOW_LAST = 12;
const TASK_LIST_SORT_FIELDS = ["updated", "created"] as const satisfies readonly TaskListSort[];

function formatTaskStatus(status: TaskStatus | "waiting"): string {
  switch (status) {
    case "waiting":
      return "waiting";
    case "open":
      return "open";
    case "dispatched":
      return "queued";
    case "in_progress":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

function formatTime(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(ts?: number): string {
  if (!ts) return "-";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(ts?: number): string {
  if (!ts) return "-";
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  if (abs < 60000) {
    return diff >= 0 ? "due now" : "just overdue";
  }
  if (mins < 60) {
    return diff >= 0 ? `in ${mins}m` : `${mins}m overdue`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return diff >= 0 ? `in ${hours}h` : `${hours}h overdue`;
  }
  const days = Math.floor(hours / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d overdue`;
}

function requirePriority(value?: string): TaskPriority {
  const normalized = (value ?? "normal").trim().toLowerCase() as TaskPriority;
  if (!VALID_PRIORITIES.has(normalized)) {
    fail(`Invalid priority: ${value}. Use low|normal|high|urgent.`);
  }
  return normalized;
}

function requireStatus(value?: string): TaskStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as TaskStatus;
  if (!VALID_STATUSES.has(normalized)) {
    fail(`Invalid status: ${value}. Use open|dispatched|in_progress|blocked|done|failed.`);
  }
  return normalized;
}

function resolveCreateAssignee(agentId?: string, assigneeId?: string): string | undefined {
  const normalizedAgent = agentId?.trim();
  const normalizedAssignee = assigneeId?.trim();
  if (normalizedAgent && normalizedAssignee && normalizedAgent !== normalizedAssignee) {
    fail(`Conflicting assignee values: --agent=${normalizedAgent} and --assignee=${normalizedAssignee}.`);
  }
  return normalizedAgent || normalizedAssignee;
}

function requireTaskWorktree(mode?: string, path?: string, branch?: string) {
  try {
    return createTaskWorktreeConfig({ mode, path, branch });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseCheckpointInterval(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  try {
    return parseDurationMs(value.trim());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseReportEvents(value?: string): TaskReportEvent[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed = value
    .split(",")
    .map((event) => event.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    fail("Report events cannot be empty. Use blocked,done,failed.");
  }

  const invalid = parsed.filter((event) => !TASK_REPORT_EVENTS.includes(event as TaskReportEvent));
  if (invalid.length > 0) {
    fail(`Invalid report event(s): ${invalid.join(", ")}. Use ${TASK_REPORT_EVENTS.join(",")}.`);
  }

  return [...new Set(parsed as TaskReportEvent[])];
}

function resolveDispatchActor(actorSessionName: string | undefined): {
  actor: string;
  agentId?: string;
  sessionName?: string;
} {
  const trimmed = actorSessionName?.trim();
  if (!trimmed) {
    const ctx = getTaskActor();
    return {
      actor: ctx.actor ?? "cli",
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
    };
  }

  const session = resolveSession(trimmed);
  if (!session) {
    fail(`Actor session not found: ${trimmed}`);
  }

  const label = session.name ?? session.sessionKey;
  return {
    actor: label,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    sessionName: label,
  };
}

function parseRuntimeOverride(model?: string, effort?: string, thinking?: string): TaskRuntimeOptions | undefined {
  try {
    return normalizeTaskRuntimeOptions({
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(effort?.trim() ? { effort: effort.trim() as TaskRuntimeOptions["effort"] } : {}),
      ...(thinking?.trim() ? { thinking: thinking.trim() as TaskRuntimeOptions["thinking"] } : {}),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function formatRuntimeResolution(resolution: TaskRuntimeResolution): string {
  const options = formatTaskRuntimeOptions(resolution.options);
  if (options === "-") {
    return "-";
  }
  return [
    resolution.options.model ? `model=${resolution.options.model}(${resolution.sources.model})` : null,
    resolution.options.effort ? `effort=${resolution.options.effort}(${resolution.sources.effort})` : null,
    resolution.options.thinking ? `thinking=${resolution.options.thinking}(${resolution.sources.thinking})` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

function formatRuntimeListLabel(resolution: TaskRuntimeResolution): string {
  if (!resolution.hasTaskRuntimeContext) {
    return "-";
  }
  const model = resolution.options.model ?? "-";
  const effort = resolution.options.effort ? `/${resolution.options.effort}` : "";
  const thinking = resolution.options.thinking ? `/${resolution.options.thinking}` : "";
  return `${model}${effort}${thinking}`.slice(0, 18);
}

function parseProfileInputs(raw?: string[] | string): Record<string, string> | undefined {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (values.length === 0) {
    return undefined;
  }

  const resolved: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    const key = value.slice(0, index).trim();
    const entryValue = value.slice(index + 1).trim();
    if (!key) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    resolved[key] = entryValue;
  }

  return resolved;
}

function parseTaskIds(raw?: string[] | string): string[] | undefined {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (values.length === 0) {
    return undefined;
  }

  const resolved = [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return resolved.length > 0 ? resolved : undefined;
}

function parseDependsOn(raw?: string[] | string): string[] | undefined {
  return parseTaskIds(raw);
}

function normalizeLegacyCreateTail(
  profileInputRaw?: string[] | string | boolean,
  asJson?: boolean,
): { profileInputRaw?: string[] | string; asJson?: boolean } {
  if (typeof profileInputRaw === "boolean" && asJson === undefined) {
    return {
      asJson: profileInputRaw,
    };
  }

  return {
    profileInputRaw: profileInputRaw as string[] | string | undefined,
    asJson,
  };
}

function formatTaskReportEvents(events?: readonly TaskReportEvent[] | null): string {
  const normalized = Array.isArray(events) && events.length > 0 ? events : ["done"];
  return normalized.join(",");
}

function formatCheckpointSummary(
  assignment?: {
    checkpointIntervalMs?: number;
    checkpointLastReportAt?: number;
    checkpointDueAt?: number;
    checkpointOverdueCount?: number;
  } | null,
): string {
  if (!assignment) return "-";
  const interval = formatDurationMs(resolveTaskCheckpointIntervalMs(assignment.checkpointIntervalMs));
  const lastReport = formatTime(assignment.checkpointLastReportAt);
  const dueAt = assignment.checkpointDueAt
    ? `${formatTime(assignment.checkpointDueAt)} (${timeUntil(assignment.checkpointDueAt)})`
    : "paused";
  const overdueCount = assignment.checkpointOverdueCount ?? 0;
  return `checkpoint ${interval} | last ${lastReport} | next ${dueAt} | overdue ${overdueCount}`;
}

function resolveArchiveListMode(archived?: boolean, all?: boolean): TaskArchiveMode {
  if (archived && all) {
    fail("Use either --archived or --all, not both.");
  }
  if (archived) {
    return "only";
  }
  if (all) {
    return "include";
  }
  return "exclude";
}

function parseLastLimit(value: string | undefined, defaultValue: number): number | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === "all" || normalized === "0") {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    fail(`Invalid --last value: ${value}. Use a positive integer, 0, or "all".`);
  }
  const parsed = Number.parseInt(normalized, 10);
  return parsed === 0 ? undefined : parsed;
}

function parseTaskListLimit(limit: string | undefined, last: string | undefined): number | undefined {
  if (limit?.trim()) {
    return parseListLimit(limit, {
      defaultValue: DEFAULT_TASK_LIST_LAST,
      maxValue: MAX_TASK_LIST_LIMIT,
      flag: "--limit",
    });
  }

  const parsed = parseLastLimit(last, DEFAULT_TASK_LIST_LAST);
  if (typeof parsed === "number" && parsed > MAX_TASK_LIST_LIMIT) {
    fail(`Invalid --last value: ${last}. Maximum page size is ${MAX_TASK_LIST_LIMIT}; use --last all explicitly.`);
  }
  return parsed;
}

function parseTagSlug(value: string | undefined): string | undefined {
  const slug = value?.trim().toLowerCase();
  if (!slug) return undefined;
  if (!/^[a-z0-9._:-]+$/.test(slug)) {
    fail(`Invalid tag slug: ${value}. Use [a-z0-9._:-].`);
  }
  return slug;
}

function parseTagSlugs(value: string[] | string | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      values
        .flatMap((item) => item.split(","))
        .map((item) => parseTagSlug(item))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}

function resolveTaskListCursor(
  value: string | undefined,
  sort: TaskListSort,
  order: TaskListOrder,
): TaskListCursor | undefined {
  const parsed = decodeListCursor(value);
  if (!parsed) return undefined;
  if (parsed.sort !== sort || parsed.order !== order) {
    fail(`Cursor was created for sort ${parsed.sort} ${parsed.order}. Re-run with matching --sort/--order.`);
  }
  if (parsed.sort !== "updated" && parsed.sort !== "created") {
    fail("Cursor was created for an unsupported task sort field.");
  }
  return {
    sort: parsed.sort,
    order: parsed.order,
    value: parsed.value,
    id: parsed.id,
  };
}

function getTaskListSortValue(task: TaskRecord, sort: TaskListSort): number {
  return sort === "created" ? task.createdAt : task.updatedAt;
}

function quoteCliArg(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9._:/@=-]+$/.test(text) ? text : JSON.stringify(text);
}

interface TaskListNextCommandInput {
  cursor: string;
  limit: number | undefined;
  sort: TaskListSort;
  order: ListOrder;
  status?: string;
  agentId?: string;
  sessionName?: string;
  profileId?: string;
  tagSlug?: string;
  parentTaskId?: string;
  rootTaskId?: string;
  onlyRootTasks?: boolean;
  textQuery?: string;
  mine?: boolean;
  archiveMode: TaskArchiveMode;
  updatedSince?: number;
  updatedUntil?: number;
}

function buildTaskListNextCommand(input: TaskListNextCommandInput): string {
  const args = [
    "ravi",
    "tasks",
    "list",
    "--cursor",
    quoteCliArg(input.cursor),
    "--sort",
    input.sort,
    "--order",
    input.order,
  ];
  if (typeof input.limit === "number") {
    args.push("--limit", String(input.limit));
  } else {
    args.push("--last", "all");
  }
  if (input.status) args.push("--status", quoteCliArg(input.status));
  if (input.mine) {
    args.push("--mine");
  } else {
    if (input.agentId) args.push("--agent", quoteCliArg(input.agentId));
    if (input.sessionName) args.push("--session", quoteCliArg(input.sessionName));
  }
  if (input.profileId) args.push("--profile", quoteCliArg(input.profileId));
  if (input.tagSlug) args.push("--tag", quoteCliArg(input.tagSlug));
  if (input.parentTaskId) args.push("--parent", quoteCliArg(input.parentTaskId));
  if (input.rootTaskId) args.push("--root", quoteCliArg(input.rootTaskId));
  if (input.onlyRootTasks) args.push("--roots");
  if (input.textQuery) args.push("--text", quoteCliArg(input.textQuery));
  if (input.archiveMode === "only") args.push("--archived");
  if (input.archiveMode === "include") args.push("--all");
  if (typeof input.updatedSince === "number") args.push("--since", String(input.updatedSince));
  if (typeof input.updatedUntil === "number") args.push("--until", String(input.updatedUntil));
  if (typeof input.updatedSince !== "number" && typeof input.updatedUntil !== "number") args.push("--all-time");
  return args.join(" ");
}

function formatTaskListWindow(defaultWindow: string | null, since?: number, until?: number): string {
  const parts: string[] = [];
  if (defaultWindow) {
    parts.push(`updated last ${defaultWindow}`);
  } else if (typeof since === "number") {
    parts.push(`updated since ${new Date(since).toISOString()}`);
  } else {
    parts.push("all time");
  }
  if (typeof until === "number") {
    parts.push(`until ${new Date(until).toISOString()}`);
  }
  return parts.join(", ");
}

function sliceLastEntries<T>(items: T[], limit: number | undefined): T[] {
  return typeof limit === "number" ? items.slice(-limit) : items;
}

function resolveListLineageFilters(parentTaskId?: string, rootTaskId?: string, onlyRootTasks?: boolean) {
  const normalizedParentTaskId = parentTaskId?.trim();
  const normalizedRootTaskId = rootTaskId?.trim();

  if (normalizedParentTaskId && normalizedRootTaskId) {
    fail("Use either --parent or --root, not both.");
  }
  if (onlyRootTasks && (normalizedParentTaskId || normalizedRootTaskId)) {
    fail("Use --roots by itself, without --parent or --root.");
  }

  return {
    parentTaskId: normalizedParentTaskId,
    rootTaskId: normalizedRootTaskId,
    onlyRootTasks: onlyRootTasks === true,
  };
}

function describeTaskWorkspace(profile: ReturnType<typeof resolveTaskProfile>): string {
  switch (profile.workspaceBootstrap.mode) {
    case "task_dir":
      return "task workspace";
    case "path":
      return profile.workspaceBootstrap.path?.trim()
        ? `shared path :: ${profile.workspaceBootstrap.path}`
        : "shared path";
    case "inherit":
    default:
      return profile.workspaceBootstrap.ensureTaskDir ? "agent cwd + task workspace" : "agent cwd";
  }
}

function formatReadiness(readiness: TaskReadiness): string {
  if (readiness.state === "waiting") {
    return `${readiness.label}${readiness.hasLaunchPlan ? " :: launch plan armed" : ""}`;
  }
  return readiness.label;
}

function formatLaunchPlanSummary(
  launchPlan:
    | {
        agentId: string;
        sessionName: string;
      }
    | null
    | undefined,
): string {
  if (!launchPlan) {
    return "-";
  }
  return `${launchPlan.agentId}/${launchPlan.sessionName}`;
}

function formatDependencyEdge(edge: TaskDependencyEdge): string {
  const status = formatTaskStatus(edge.relatedTaskStatus);
  const satisfaction = edge.satisfied ? `done @ ${formatTime(edge.satisfiedAt)}` : "pending";
  return `${edge.relatedTaskId} :: ${status} :: ${edge.relatedTaskProgress}% :: ${satisfaction} :: ${edge.relatedTaskTitle}`;
}

function printTaskSummary(task: TaskRecord, activeAssignment?: TaskAssignment | null): void {
  const taskProfile = resolveTaskProfileForTask(task);
  const artifacts = buildTaskArtifactSummary(task, activeAssignment);
  const dependencySurface = getTaskDependencySurface(task, activeAssignment);
  const runtime = resolveTaskRuntimeForRead(task, {
    assignment: activeAssignment,
    launchPlan: dependencySurface.launchPlan,
  });
  const projectSurface = getTaskProjectSurface(task.id);
  const visualStatus = deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment);
  console.log(`\nTask:        ${task.id}`);
  console.log(`Title:       ${task.title}`);
  console.log(`Status:      ${formatTaskStatus(visualStatus)}`);
  console.log(`Lifecycle:   ${formatTaskStatus(deriveTaskReadStatus(task, activeAssignment))}`);
  console.log(`Readiness:   ${formatReadiness(dependencySurface.readiness)}`);
  console.log(`Priority:    ${task.priority}`);
  console.log(`Progress:    ${task.progress}%`);
  console.log(`Profile:     ${taskProfile.id}@${taskProfile.version}`);
  console.log(`Profile src: ${taskProfile.sourceKind} :: ${taskProfile.source}`);
  console.log(`Runtime:     ${formatRuntimeResolution(runtime)}`);
  if (task.runtimeOverride) console.log(`Task RT ov.: ${formatTaskRuntimeOptions(task.runtimeOverride)}`);
  console.log(`Surface:     ${taskProfile.rendererHints.label}`);
  console.log(`Workspace:   ${describeTaskWorkspace(taskProfile)}`);
  if (projectSurface) {
    console.log(`Project:     ${projectSurface.projectSlug} :: ${projectSurface.projectStatus}`);
    console.log(`Proj next:   ${projectSurface.projectNextStep}`);
  }
  if (task.profileInput && Object.keys(task.profileInput).length > 0) {
    console.log(
      `Profile in: ${Object.entries(task.profileInput)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
  }
  console.log(`Checkpoint:  ${formatDurationMs(resolveTaskCheckpointIntervalMs(task.checkpointIntervalMs))}`);
  console.log(`Report to:   ${task.reportToSessionName ?? "-"}`);
  console.log(`Report on:   ${formatTaskReportEvents(task.reportEvents)}`);
  console.log(`Launch plan: ${formatLaunchPlanSummary(dependencySurface.launchPlan)}`);
  if (task.parentTaskId) console.log(`Parent:      ${task.parentTaskId}`);
  console.log(`Agent:       ${task.assigneeAgentId ?? "-"}`);
  console.log(`Session:     ${task.assigneeSessionName ?? "-"}`);
  if (task.worktree) console.log(`Worktree:    ${formatTaskWorktree(task.worktree)}`);
  if (task.taskDir) console.log(`Task dir:    ${task.taskDir}`);
  if (artifacts.primary)
    console.log(`Primary:     ${artifacts.primary.label} :: ${formatArtifactDisplayPath(artifacts.primary)}`);
  console.log(`Created:     ${formatTime(task.createdAt)}`);
  console.log(`Updated:     ${formatTime(task.updatedAt)} (${timeAgo(task.updatedAt)})`);
  if (task.archivedAt) {
    console.log(`Archived:    ${formatTime(task.archivedAt)} by ${task.archivedBy ?? "unknown"}`);
  }
  if (task.archiveReason) {
    console.log(`Archive why: ${task.archiveReason}`);
  }
  if (task.summary) console.log(`Summary:     ${task.summary}`);
  if (task.blockerReason) console.log(`Blocked by:  ${task.blockerReason}`);
  console.log("\nInstructions:");
  console.log(`  ${task.instructions.split("\n").join("\n  ")}`);
}

function buildTaskDocumentSummary(task: TaskRecord) {
  const taskProfile = resolveTaskProfileForTask(task);
  if (!taskProfileUsesTaskDocument(taskProfile)) {
    return null;
  }

  return {
    exists: taskDocExists(task),
    taskDir: task.taskDir ?? null,
    path: getTaskDocPath(task),
    frontmatter: readTaskDocFrontmatter(task),
  };
}

function readTaskDocFrontmatterForProfile(task: TaskRecord, taskProfile: ReturnType<typeof resolveTaskProfileForTask>) {
  return taskProfileUsesTaskDocument(taskProfile) ? readTaskDocFrontmatter(task) : {};
}

function formatArtifactDisplayPath(
  artifact:
    | {
        path?: {
          displayPath?: string | null;
          absolutePath?: string | null;
        } | null;
      }
    | null
    | undefined,
): string {
  return artifact?.path?.displayPath ?? artifact?.path?.absolutePath ?? "-";
}

function shouldPrintArtifactSection(
  artifacts:
    | {
        items?: Array<{
          kind?: string | null;
        }>;
        primary?: {
          kind?: string | null;
        } | null;
      }
    | null
    | undefined,
): boolean {
  if (!artifacts) {
    return false;
  }
  if ((artifacts.items?.length ?? 0) > 1) {
    return true;
  }
  return artifacts.primary?.kind !== "task-doc";
}

function buildTaskLineageNode(task: TaskRecord) {
  const taskProfile = resolveTaskProfileForTask(task);
  const taskArtifacts = buildTaskArtifactSummary(task);
  const dependencySurface = getTaskDependencySurface(task);
  return {
    id: task.id,
    title: task.title,
    status: deriveTaskVisualStatus(task, dependencySurface.readiness),
    progress: task.progress,
    profileId: taskProfile.id,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
    workSessionName: task.assigneeSessionName ?? null,
    taskDir: task.taskDir ?? null,
    primaryArtifact: taskArtifacts.primary,
  };
}

function formatTaskComment(comment: TaskComment): string {
  const author = comment.authorSessionName ?? comment.authorAgentId ?? comment.author ?? "unknown";
  return `  - ${formatTime(comment.createdAt)} ${author} :: ${comment.body}`;
}

async function emitMutationEvents(result: {
  task: TaskRecord;
  event: TaskEvent;
  relatedEvents?: Array<{ task: TaskRecord; event: TaskEvent }>;
  wasNoop?: boolean;
}) {
  if (result.wasNoop) {
    return;
  }
  await emitTaskEvent(result.task, result.event);
  for (const relatedEvent of result.relatedEvents ?? []) {
    await emitTaskEvent(relatedEvent.task, relatedEvent.event);
  }
}

function printNextSteps(task: TaskRecord): void {
  const taskProfile = resolveTaskProfileForTask(task);
  const artifacts = buildTaskArtifactSummary(task);
  const dependencySurface = getTaskDependencySurface(task);
  console.log("\nNext:");
  if (task.archivedAt) {
    console.log(`  ravi tasks unarchive ${task.id}`);
    if (task.status === "done" || task.status === "failed") {
      console.log("  task archived; use show for history.");
      return;
    }
  }

  if (task.status === "open") {
    if (dependencySurface.readiness.state === "waiting") {
      console.log(`  ravi tasks show ${task.id}`);
      if (dependencySurface.dependencies.length > 0) {
        console.log(
          `  pending upstreams: ${dependencySurface.dependencies
            .filter((edge) => !edge.satisfied)
            .map((edge) => edge.relatedTaskId)
            .join(", ")}`,
        );
      }
      if (dependencySurface.launchPlan) {
        console.log(
          `  waiting for upstreams; auto-dispatch armed to ${formatLaunchPlanSummary(dependencySurface.launchPlan)}.`,
        );
      } else {
        console.log("  waiting for upstreams; remove deps or finish the upstream tasks before dispatching.");
      }
      return;
    }
    const primaryArtifactPath = artifacts.primary ? formatArtifactDisplayPath(artifacts.primary) : null;
    if (primaryArtifactPath) {
      console.log(`  1. open ${primaryArtifactPath}`);
    } else {
      console.log(`  1. review profile ${taskProfile.id} and the task workspace`);
    }
    if (taskProfileUsesArtifactFirstSync(taskProfile) && artifacts.primary) {
      console.log(`  2. work in the profile primary artifact first (${artifacts.primary.label})`);
    } else if (artifacts.primary) {
      console.log(`  2. work in the profile primary artifact (${artifacts.primary.label})`);
    } else {
      console.log("  2. refine the profile process/artifacts before dispatch");
    }
    console.log("  3. review with the task owner");
    console.log(`  4. dispatch only after that: ravi tasks dispatch ${task.id} --agent <agent>`);
    return;
  }

  if (task.status === "dispatched" || task.status === "in_progress" || task.status === "blocked") {
    console.log(`  ravi tasks watch ${task.id}`);
    console.log(`  ravi tasks report ${task.id}`);
    console.log(`  ravi tasks done ${task.id}`);
    console.log(`  ravi tasks block ${task.id}`);
    console.log(`  ravi tasks fail ${task.id}`);
    return;
  }

  console.log("  task terminal; use list/show for history.");
}

function printTaskCreateOutput(task: TaskRecord): void {
  const taskProfile = resolveTaskProfileForTask(task);
  const dependencySurface = getTaskDependencySurface(task);
  const taskDocPath = taskProfileUsesTaskDocument(taskProfile) ? getTaskDocPath(task) : null;
  const output = buildTaskCreateOutputForProfile(task, {
    effectiveCwd: process.cwd(),
    ...(taskDocPath !== null ? { taskDocPath } : {}),
    taskProfile,
    readiness: dependencySurface.readiness,
    dependencies: dependencySurface.dependencies,
    dependents: dependencySurface.dependents,
    launchPlan: dependencySurface.launchPlan,
    ...(task.assigneeAgentId ? { agentId: task.assigneeAgentId } : {}),
    ...(task.assigneeSessionName ? { sessionName: task.assigneeSessionName } : {}),
  });
  console.log(`\n${output}`);
}

function formatWatchLine(payload: Record<string, unknown>, asJson?: boolean): string {
  if (asJson) {
    return JSON.stringify(payload);
  }

  const event = payload.event as Record<string, unknown>;
  const time = formatTime(typeof event.createdAt === "number" ? event.createdAt : Date.now());
  const type = typeof event.type === "string" ? event.type.replace("task.", "") : "event";
  const progress = typeof payload.progress === "number" ? `${payload.progress}%` : "-";
  const actor =
    typeof event.actor === "string" ? event.actor : typeof event.agentId === "string" ? event.agentId : "cli";
  const message = typeof event.message === "string" ? event.message : "";
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "task";
  const status =
    typeof payload.visualStatus === "string"
      ? payload.visualStatus
      : typeof payload.status === "string"
        ? payload.status
        : "unknown";
  const profileId = typeof payload.profileId === "string" ? payload.profileId : null;
  const primaryArtifact = (
    (payload.artifacts as
      | {
          primary?: {
            label?: string | null;
            kind?: string | null;
            path?: {
              displayPath?: string | null;
              absolutePath?: string | null;
            } | null;
          } | null;
        }
      | null
      | undefined) ?? null
  )?.primary;
  const checkpoint = formatCheckpointSummary(
    (payload.activeAssignment as
      | {
          checkpointIntervalMs?: number;
          checkpointLastReportAt?: number;
          checkpointDueAt?: number;
          checkpointOverdueCount?: number;
        }
      | null
      | undefined) ?? null,
  );
  const readiness = (payload.readiness as { label?: string | null } | null | undefined) ?? null;
  const project =
    (payload.project as { projectSlug?: string | null } | null | undefined) ??
    (payload.task as { project?: { projectSlug?: string | null } | null } | null | undefined)?.project ??
    null;
  const profileSuffix = profileId && profileId !== "default" ? ` :: profile ${profileId}` : "";
  const artifactSuffix =
    primaryArtifact && primaryArtifact.kind && primaryArtifact.kind !== "task-doc"
      ? ` :: ${primaryArtifact.label ?? primaryArtifact.kind} ${formatArtifactDisplayPath(primaryArtifact)}`
      : "";
  const readinessSuffix = readiness?.label ? ` :: readiness ${readiness.label}` : "";
  const projectSuffix = project?.projectSlug ? ` :: project ${project.projectSlug}` : "";
  return `[${time}] ${taskId} :: ${type} :: ${status} :: ${progress} :: ${actor}${message ? ` :: ${message}` : ""}${profileSuffix}${projectSuffix}${artifactSuffix}${readinessSuffix}${checkpoint !== "-" ? ` :: ${checkpoint}` : ""}`;
}

function deriveWatchStatus(event: TaskEvent, fallback?: TaskStatus): TaskStatus {
  switch (event.type) {
    case "task.created":
      return "open";
    case "task.dispatched":
      return "dispatched";
    case "task.progress":
      return "in_progress";
    case "task.blocked":
      return "blocked";
    case "task.done":
      return "done";
    case "task.failed":
      return "failed";
    default:
      return fallback ?? "open";
  }
}

function buildWatchPayload(
  taskId: string,
  task: TaskRecord | null,
  event: TaskEvent,
  activeAssignment?: TaskAssignment | null,
): Record<string, unknown> {
  const taskProfile = task ? resolveTaskProfileForTask(task) : null;
  const artifacts = task ? buildTaskArtifactSummary(task, activeAssignment) : null;
  const dependencySurface = task ? getTaskDependencySurface(task, activeAssignment) : null;
  const project = task ? getTaskProjectSurface(task.id) : null;
  return {
    taskId,
    status: deriveWatchStatus(event, task?.status),
    visualStatus:
      task && dependencySurface ? deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment) : null,
    progress: typeof event.progress === "number" ? event.progress : (task?.progress ?? 0),
    profileId: taskProfile?.id ?? resolveTaskProfile(undefined).id,
    taskProfile,
    artifacts,
    project,
    readiness: dependencySurface?.readiness ?? null,
    launchPlan: dependencySurface?.launchPlan ?? null,
    activeAssignment: activeAssignment ?? null,
    event,
  };
}

function printTaskEventsSince(
  taskId: string,
  sinceEventId: number,
  asJson?: boolean,
): { lastSeenEventId: number; taskStatus?: TaskStatus } {
  const details = getTaskDetails(taskId);
  const unseenEvents = details.events.filter((event) => (event.id ?? 0) > sinceEventId);
  let lastSeenEventId = sinceEventId;

  for (const event of unseenEvents) {
    console.log(formatWatchLine(buildWatchPayload(taskId, details.task, event, details.activeAssignment), asJson));
    lastSeenEventId = Math.max(lastSeenEventId, event.id ?? lastSeenEventId);
  }

  return { lastSeenEventId, taskStatus: details.task?.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Group({
  name: "tasks",
  description: "Task runtime for dispatching work to Ravi agents",
  scope: "open",
})
export class TaskCommands {
  @Command({
    name: "create",
    description: "Create a tracked task; unresolved dependencies arm launch plans instead of dispatching early",
  })
  @Returns(taskCreateReturnSchema)
  async create(
    @Arg("title", { description: "Short task title" }) title: string,
    @Option({ flags: "--instructions <text>", description: "Detailed instructions for the task" })
    instructions?: string,
    @Option({ flags: "--priority <level>", description: "low|normal|high|urgent", defaultValue: "normal" })
    priority?: string,
    @Option({ flags: "--profile <id>", description: "Task profile id (defaults to default)" }) profileId?: string,
    @Option({ flags: "--agent <id>", description: "Auto-dispatch to this agent immediately" }) agentId?: string,
    @Option({ flags: "--assignee <id>", description: "Alias for --agent" }) assigneeId?: string,
    @Option({ flags: "--session <name>", description: "Working session name to use when auto-dispatching" })
    sessionName?: string,
    @Option({ flags: "--worktree-mode <mode>", description: "Worktree metadata mode: inherit|path" })
    worktreeMode?: string,
    @Option({
      flags: "--worktree-path <path>",
      description: "Worktree metadata path (resolved relative to agent cwd if needed; does not override session cwd)",
    })
    worktreePath?: string,
    @Option({ flags: "--worktree-branch <name>", description: "Optional branch label for the contextual worktree" })
    worktreeBranch?: string,
    @Option({ flags: "--parent <task-id>", description: "Create this task as a child of another task" })
    parentTaskId?: string,
    @Option({
      flags: "--depends-on <task-id...>",
      description: "Gate this task on upstream tasks; repeat or pass multiple ids",
    })
    dependsOnRaw?: string[] | string,
    @Option({ flags: "--checkpoint <duration>", description: "Assignment checkpoint interval (e.g. 5m, 30s, 1h)" })
    checkpoint?: string,
    @Option({ flags: "--report-to <session>", description: "Session to receive explicit task reports" })
    reportToSessionName?: string,
    @Option({ flags: "--report-events <events>", description: "Comma-separated report events: blocked,done,failed" })
    reportEvents?: string,
    @Option({ flags: "--input <key=value...>", description: "Profile input values pinned to the task" })
    profileInputRaw?: string[] | string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--tag <slug...>",
      description: "Attach canonical task tags; repeat or pass comma-separated slugs",
    })
    tagSlugsRaw?: string[] | string,
    @Option({ flags: "--model <model>", description: "Task runtime model override" })
    model?: string,
    @Option({ flags: "--effort <level>", description: "Runtime effort: low|medium|high|xhigh" })
    effort?: string,
    @Option({ flags: "--thinking <level>", description: "Runtime thinking: off|normal|verbose" })
    thinking?: string,
  ) {
    if (!instructions?.trim()) {
      fail("--instructions is required");
    }

    const assigneeAgentId = resolveCreateAssignee(agentId, assigneeId);
    if (sessionName?.trim() && !assigneeAgentId) {
      fail("--session requires --agent or --assignee.");
    }
    if (assigneeAgentId) {
      try {
        requireTaskRuntimeAgent(assigneeAgentId);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }

    const worktree = requireTaskWorktree(worktreeMode, worktreePath, worktreeBranch);
    const normalizedTail = normalizeLegacyCreateTail(
      profileInputRaw as string[] | string | boolean | undefined,
      asJson,
    );
    const dependsOnTaskIds = parseDependsOn(dependsOnRaw);
    const checkpointIntervalMs = parseCheckpointInterval(checkpoint);
    const parsedReportEvents = parseReportEvents(reportEvents);
    const profileInput = parseProfileInputs(normalizedTail.profileInputRaw);
    const tagSlugs = parseTagSlugs(tagSlugsRaw);
    const runtimeOverride = parseRuntimeOverride(model, effort, thinking);
    const actor = getTaskActor();
    if (!actor.sessionName && !reportToSessionName?.trim()) {
      fail(
        "Cannot infer task report target outside a Ravi session. Run with RAVI_CONTEXT_KEY or pass --report-to <session>.",
      );
    }
    const created = await createTask({
      title: title.trim(),
      instructions: instructions.trim(),
      priority: requirePriority(priority),
      ...(profileId?.trim() ? { profileId: profileId.trim() } : {}),
      ...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
      ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
      ...(reportToSessionName?.trim() ? { reportToSessionName: reportToSessionName.trim() } : {}),
      ...(parsedReportEvents ? { reportEvents: parsedReportEvents } : {}),
      ...(profileInput ? { profileInput } : {}),
      ...(tagSlugs.length > 0 ? { tagSlugs } : {}),
      ...(runtimeOverride ? { runtimeOverride } : {}),
      createdBy: actor.actor,
      createdByAgentId: actor.agentId,
      createdBySessionName: actor.sessionName,
      ...(parentTaskId?.trim() ? { parentTaskId: parentTaskId.trim() } : {}),
      ...(worktree ? { worktree } : {}),
    });
    await emitMutationEvents(created);

    let task = created.task;
    let launchResult: Awaited<ReturnType<typeof queueOrDispatchTask>> | null = null;
    if (assigneeAgentId) {
      launchResult = await queueOrDispatchTask(created.task.id, {
        agentId: assigneeAgentId,
        sessionName: sessionName?.trim() || getDefaultTaskSessionNameForTask(created.task),
        assignedBy: actor.actor,
        ...(actor.agentId ? { assignedByAgentId: actor.agentId } : {}),
        ...(actor.sessionName ? { assignedBySessionName: actor.sessionName } : {}),
        ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
        ...(runtimeOverride ? { runtimeOverride } : {}),
        ...(worktree ? { worktree } : {}),
      });
      await emitMutationEvents(launchResult);
      task = launchResult.task;
    }

    const dependencySurface = getTaskDependencySurface(task);
    const payload = {
      task,
      taskProfile: resolveTaskProfileForTask(task),
      event: created.event,
      relatedEvents: created.relatedEvents,
      parentTaskId: task.parentTaskId ?? null,
      readiness: dependencySurface.readiness,
      dependencies: dependencySurface.dependencies,
      dependents: dependencySurface.dependents,
      launchPlan: dependencySurface.launchPlan,
      ...(launchResult
        ? {
            action:
              launchResult.mode === "dispatched"
                ? {
                    type: "dispatch" as const,
                    assignment: launchResult.assignment,
                    event: launchResult.event,
                    sessionName: launchResult.sessionName,
                  }
                : {
                    type: "launch_plan" as const,
                    launchPlan: launchResult.launchPlan,
                    event: launchResult.event,
                  },
          }
        : {}),
    };

    if (normalizedTail.asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const headline = !launchResult
        ? "Created"
        : launchResult.mode === "dispatched"
          ? "Created and dispatched"
          : "Created with launch plan";
      console.log(`\n✓ ${headline} task ${task.id}`);
      printTaskCreateOutput(task);
    }
    return payload;
  }

  @Command({ name: "list", description: "List tasks" })
  @Returns(taskListReturnSchema)
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) status?: string,
    @Option({ flags: "--agent <id>", description: "Filter by assigned agent" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Filter by assigned session" }) sessionName?: string,
    @Option({ flags: "--profile <id>", description: "Filter by task profile" }) profileId?: string,
    @Option({ flags: "--parent <task-id>", description: "Filter direct children of one parent task" })
    parentTaskId?: string,
    @Option({ flags: "--root <task-id>", description: "Filter one task tree (root task plus descendants)" })
    rootTaskId?: string,
    @Option({ flags: "--roots", description: "Show only root tasks (no parent)" }) onlyRootTasks?: boolean,
    @Option({
      flags: "--text <query>",
      description: "Free-text match across id, title, instructions, summary, blocker, profile, agent and session",
    })
    textQuery?: string,
    @Option({ flags: "--mine", description: "Filter by current agent/session context" }) mine?: boolean,
    @Option({ flags: "--archived", description: "List only archived tasks" }) archived?: boolean,
    @Option({ flags: "--all", description: "Include archived and visible tasks" }) all?: boolean,
    @Option({
      flags: "--last <n>",
      description: `Number of newest tasks to show by default (default: ${DEFAULT_TASK_LIST_LAST}; use 0 or "all" to disable)`,
    })
    last?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--limit <n>",
      description: `Page size (default: ${DEFAULT_TASK_LIST_LAST}, max: ${MAX_TASK_LIST_LIMIT})`,
    })
    limit?: string,
    @Option({ flags: "--cursor <token>", description: "Opaque cursor returned by the previous page" }) cursor?: string,
    @Option({ flags: "--sort <field>", description: "Sort field: updated|created" }) sort?: string,
    @Option({ flags: "--order <dir>", description: "Sort direction: asc|desc" }) order?: string,
    @Option({ flags: "--since <time>", description: "Lower updated_at bound: 1d, epoch ms, or ISO datetime" })
    since?: string,
    @Option({ flags: "--until <time>", description: "Upper updated_at bound: 1d, epoch ms, or ISO datetime" })
    until?: string,
    @Option({ flags: "--all-time", description: "Disable the default 1d updated_at window" }) allTime?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical task tag" }) tagSlug?: string,
  ) {
    const ctx = getContext();
    const archiveMode = resolveArchiveListMode(archived, all);
    const lineageFilters = resolveListLineageFilters(parentTaskId, rootTaskId, onlyRootTasks);
    const pageLimit = parseTaskListLimit(limit, last);
    const sortField = parseListSort(sort, TASK_LIST_SORT_FIELDS, "updated");
    const orderDirection = parseListOrder(order) as TaskListOrder;
    const taskCursor = resolveTaskListCursor(cursor, sortField, orderDirection);
    const now = Date.now();
    const explicitSince = parseListTimeBound(since, "--since", now);
    const updatedUntil = parseListTimeBound(until, "--until", now);
    const defaultWindow = !allTime && typeof explicitSince !== "number" ? DEFAULT_TASK_LIST_WINDOW : null;
    const updatedSince =
      typeof explicitSince === "number"
        ? explicitSince
        : defaultWindow
          ? now - parseDurationMs(DEFAULT_TASK_LIST_WINDOW)
          : undefined;
    if (typeof updatedSince === "number" && typeof updatedUntil === "number" && updatedSince > updatedUntil) {
      fail("--since must be earlier than or equal to --until.");
    }
    const queryLimit = typeof pageLimit === "number" ? pageLimit + 1 : undefined;
    const resolvedStatus = requireStatus(status);
    const resolvedAgentId = mine ? (ctx?.agentId ?? undefined) : agentId?.trim() || undefined;
    const resolvedSessionName = mine ? (ctx?.sessionName ?? undefined) : sessionName?.trim() || undefined;
    const normalizedProfileId = profileId?.trim() || undefined;
    const normalizedTagSlug = parseTagSlug(tagSlug);
    const normalizedTextQuery = textQuery?.trim() || undefined;
    const fetchedTasks = listTasks({
      status: resolvedStatus,
      agentId: resolvedAgentId,
      sessionName: resolvedSessionName,
      ...(normalizedProfileId ? { profileId: normalizedProfileId } : {}),
      ...(normalizedTagSlug ? { tagSlug: normalizedTagSlug } : {}),
      ...(lineageFilters.parentTaskId ? { parentTaskId: lineageFilters.parentTaskId } : {}),
      ...(lineageFilters.rootTaskId ? { rootTaskId: lineageFilters.rootTaskId } : {}),
      ...(lineageFilters.onlyRootTasks ? { onlyRootTasks: true } : {}),
      ...(normalizedTextQuery ? { query: normalizedTextQuery } : {}),
      ...(typeof queryLimit === "number" ? { limit: queryLimit } : {}),
      ...(typeof updatedSince === "number" ? { updatedSince } : {}),
      ...(typeof updatedUntil === "number" ? { updatedUntil } : {}),
      sort: sortField,
      order: orderDirection,
      ...(taskCursor ? { cursor: taskCursor } : {}),
      archiveMode,
    });
    const hasMore = typeof pageLimit === "number" && fetchedTasks.length > pageLimit;
    const tasks = hasMore && typeof pageLimit === "number" ? fetchedTasks.slice(0, pageLimit) : fetchedTasks;
    const lastTask = tasks[tasks.length - 1];
    const nextCursor =
      hasMore && lastTask
        ? encodeListCursor({
            sort: sortField,
            order: orderDirection,
            value: getTaskListSortValue(lastTask, sortField),
            id: lastTask.id,
          })
        : null;
    const nextCommand = nextCursor
      ? buildTaskListNextCommand({
          cursor: nextCursor,
          limit: pageLimit,
          sort: sortField,
          order: orderDirection,
          status: resolvedStatus,
          agentId: resolvedAgentId,
          sessionName: resolvedSessionName,
          profileId: normalizedProfileId,
          tagSlug: normalizedTagSlug,
          parentTaskId: lineageFilters.parentTaskId,
          rootTaskId: lineageFilters.rootTaskId,
          onlyRootTasks: lineageFilters.onlyRootTasks,
          textQuery: normalizedTextQuery,
          mine,
          archiveMode,
          updatedSince,
          updatedUntil,
        })
      : null;
    const surfacedTasks = tasks.map((task) => {
      const activeAssignment = task.status === "dispatched" ? getTaskDetails(task.id).activeAssignment : null;
      const dependencySurface = getTaskDependencySurface(task, activeAssignment);
      return {
        task,
        activeAssignment,
        project: getTaskProjectSurface(task.id),
        dependencySurface,
        visualStatus: deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment),
      };
    });

    const payloadTasks = surfacedTasks.map((item) => ({
      ...item.task,
      tags: searchTagBindingsForSelector({ selector: { task: item.task.id } }).bindings,
      project: item.project,
      visualStatus: item.visualStatus,
      runtime: resolveTaskRuntimeForRead(item.task, {
        assignment: item.activeAssignment,
        launchPlan: item.dependencySurface.launchPlan,
      }),
      readiness: item.dependencySurface.readiness,
      dependencyCount: item.dependencySurface.readiness.dependencyCount,
      unsatisfiedDependencyCount: item.dependencySurface.readiness.unsatisfiedDependencyCount,
      launchPlan: item.dependencySurface.launchPlan,
    }));
    const payload = {
      total: tasks.length,
      archiveMode,
      limit: pageLimit ?? null,
      page: {
        limit: pageLimit ?? null,
        count: tasks.length,
        hasMore,
        nextCursor,
        nextCommand,
        sort: sortField,
        order: orderDirection,
        since: updatedSince ?? null,
        until: updatedUntil ?? null,
        defaultWindow,
      },
      filters: {
        status: resolvedStatus ?? null,
        agentId: resolvedAgentId ?? null,
        sessionName: resolvedSessionName ?? null,
        profileId: normalizedProfileId ?? null,
        tagSlug: normalizedTagSlug ?? null,
        parentTaskId: lineageFilters.parentTaskId ?? null,
        rootTaskId: lineageFilters.rootTaskId ?? null,
        onlyRootTasks: Boolean(lineageFilters.onlyRootTasks),
        query: normalizedTextQuery ?? null,
        archiveMode,
        mine: Boolean(mine),
      },
      items: payloadTasks,
      tasks: payloadTasks,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    if (tasks.length === 0) {
      console.log("\nNo tasks found for the current filters.\n");
      console.log("Usage:");
      console.log('  ravi tasks create "Fix routing" --instructions "..."');
      console.log("  ravi tasks list --limit 30 --cursor <nextCursor>");
      console.log("  ravi tasks list --all-time --all");
      return payload;
    }

    const limitSummary = typeof pageLimit === "number" ? `limit ${pageLimit}` : "unlimited";
    const windowSummary = formatTaskListWindow(defaultWindow, updatedSince, updatedUntil);
    console.log(
      `\nTasks (${tasks.length} returned, ${limitSummary}, ${windowSummary}, sort ${sortField} ${orderDirection})\n`,
    );
    const showArchiveColumn = archiveMode !== "exclude";
    if (showArchiveColumn) {
      console.log(
        "  ID              STATUS      READY        DEPS   PRIORITY  ARCHIVE   AGENT        RUNTIME             PROJECT          UPDATED      TITLE",
      );
      console.log(
        "  --------------  ----------  -----------  -----  --------  --------  -----------  ------------------  ---------------  ----------  ------------------------------",
      );
    } else {
      console.log(
        "  ID              STATUS      READY        DEPS   PRIORITY  AGENT        RUNTIME             PROJECT          UPDATED      TITLE",
      );
      console.log(
        "  --------------  ----------  -----------  -----  --------  -----------  ------------------  ---------------  ----------  ------------------------------",
      );
    }
    for (const item of surfacedTasks) {
      const { task, project, dependencySurface, visualStatus } = item;
      const archiveLabel = task.archivedAt ? "yes" : "-";
      const projectLabel = (project?.projectSlug ?? "-").slice(0, 15);
      const runtimeLabel = formatRuntimeListLabel(
        resolveTaskRuntimeForRead(task, {
          assignment: item.activeAssignment,
          launchPlan: dependencySurface.launchPlan,
        }),
      );
      const readinessLabel =
        dependencySurface.readiness.state === "waiting"
          ? `${dependencySurface.readiness.unsatisfiedDependencyCount} pending`
          : dependencySurface.readiness.state === "ready"
            ? dependencySurface.launchPlan
              ? "auto-dispatch"
              : "ready"
            : dependencySurface.readiness.state;
      const row = `  ${task.id.padEnd(14)}  ${formatTaskStatus(visualStatus).padEnd(10)}  ${readinessLabel.padEnd(11)}  ${`${dependencySurface.readiness.satisfiedDependencyCount}/${dependencySurface.readiness.dependencyCount}`.padEnd(5)}  ${task.priority.padEnd(8)}`;
      if (showArchiveColumn) {
        console.log(
          `${row}  ${archiveLabel.padEnd(8)}  ${(task.assigneeAgentId ?? "-").padEnd(11)}  ${runtimeLabel.padEnd(18)}  ${projectLabel.padEnd(15)}  ${timeAgo(task.updatedAt).padEnd(10)}  ${task.title.slice(0, 30)}`,
        );
      } else {
        console.log(
          `${row}  ${(task.assigneeAgentId ?? "-").padEnd(11)}  ${runtimeLabel.padEnd(18)}  ${projectLabel.padEnd(15)}  ${timeAgo(task.updatedAt).padEnd(10)}  ${task.title.slice(0, 30)}`,
        );
      }
    }
    console.log("");
    if (nextCommand) {
      console.log("Next page:");
      console.log(`  ${nextCommand}\n`);
    } else if (defaultWindow) {
      console.log("Showing tasks updated in the last 1d. Use --all-time to include older tasks.\n");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show task details and history" })
  @Returns(taskShowReturnSchema)
  show(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--last <n>",
      description: `Number of recent history items to show (default: ${DEFAULT_TASK_SHOW_LAST}; use 0 or "all" to disable)`,
    })
    last?: string,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }
    const taskArtifacts = buildTaskArtifactSummary(details.task, details.activeAssignment);
    const dependencySurface = getTaskDependencySurface(details.task, details.activeAssignment);
    const historyLimit = parseLastLimit(last, DEFAULT_TASK_SHOW_LAST);
    const recentEvents = sliceLastEntries(details.events, historyLimit);
    const recentComments = sliceLastEntries(details.comments, historyLimit);

    const payload = {
      ...details,
      project: details.project,
      events: recentEvents,
      comments: recentComments,
      historyLimit: historyLimit ?? null,
      taskSession: details.task ? buildTaskSessionLink(details.task) : null,
      parentTask: details.parentTask ? buildTaskLineageNode(details.parentTask) : null,
      childTasks: details.childTasks.map(buildTaskLineageNode),
      taskDocument: details.task ? buildTaskDocumentSummary(details.task) : null,
      taskArtifacts,
      primaryArtifact: taskArtifacts.primary,
      runtime: resolveTaskRuntimeForRead(details.task, {
        assignment: details.activeAssignment,
        launchPlan: dependencySurface.launchPlan,
      }),
      readiness: dependencySurface.readiness,
      dependencies: dependencySurface.dependencies,
      dependents: dependencySurface.dependents,
      launchPlan: dependencySurface.launchPlan,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    printTaskSummary(details.task, details.activeAssignment);

    const taskSession = buildTaskSessionLink(details.task);
    if (taskSession) {
      console.log("\nTask session:");
      console.log(`  Alias:      ${taskSession.alias}`);
      console.log(`  Session:    ${taskSession.sessionName}`);
      console.log(`  Tool topic: ${taskSession.toolTopic}`);
      console.log(`  Read:       ${taskSession.readCommand}`);
      console.log(`  Debug:      ${taskSession.debugCommand}`);
    }

    const taskTags = details.tags ?? [];
    console.log("\nTags:");
    if (taskTags.length === 0) {
      console.log("  - none");
    } else {
      for (const tag of taskTags) {
        console.log(`  - ${tag.tagSlug}${tag.metadata ? ` :: ${JSON.stringify(tag.metadata)}` : ""}`);
      }
    }

    const taskDocument = buildTaskDocumentSummary(details.task);
    console.log("\nTask profile:");
    console.log(`  ID:         ${details.taskProfile?.id ?? resolveTaskProfile(undefined).id}`);
    console.log(`  Version:    ${details.taskProfile?.version ?? resolveTaskProfile(undefined).version}`);
    console.log(
      `  Source:     ${details.taskProfile?.sourceKind ?? resolveTaskProfile(undefined).sourceKind} :: ${details.taskProfile?.source ?? resolveTaskProfile(undefined).source}`,
    );
    console.log(
      `  Surface:    ${details.taskProfile?.rendererHints.label ?? resolveTaskProfile(undefined).rendererHints.label}`,
    );
    console.log(`  Workspace:  ${describeTaskWorkspace(details.taskProfile ?? resolveTaskProfile(undefined))}`);
    console.log(`  RT default: ${formatTaskRuntimeOptions(details.taskProfile?.runtimeDefaults)}`);
    if (details.task.profileInput && Object.keys(details.task.profileInput).length > 0) {
      console.log(
        `  Inputs:     ${Object.entries(details.task.profileInput)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
      );
    }

    if (taskDocument) {
      console.log("\nTASK.md:");
      console.log(`  Exists:     ${taskDocument.exists ? "yes" : "no"}`);
      console.log(`  Dir:        ${taskDocument.taskDir ?? "-"}`);
      console.log(`  Path:       ${taskDocument.path}`);
      if (taskDocument.frontmatter.status) {
        console.log(`  FM status:  ${taskDocument.frontmatter.status}`);
      }
      if (typeof taskDocument.frontmatter.progress === "number") {
        console.log(`  FM prog.:   ${taskDocument.frontmatter.progress}%`);
      }
      if (taskDocument.frontmatter.progressNote) {
        console.log(`  FM note:   ${taskDocument.frontmatter.progressNote}`);
      }
      if (taskDocument.frontmatter.summary) {
        console.log(`  FM summary: ${taskDocument.frontmatter.summary}`);
      }
      if (taskDocument.frontmatter.blockerReason) {
        console.log(`  FM block:   ${taskDocument.frontmatter.blockerReason}`);
      }
    }

    if (shouldPrintArtifactSection(taskArtifacts)) {
      console.log("\nArtifacts:");
      if (taskArtifacts.workspaceRoot) {
        console.log(`  Workspace:  ${taskArtifacts.workspaceRoot}`);
      }
      if (taskArtifacts.primary) {
        console.log(`  Primary:    ${taskArtifacts.primary.label}`);
        console.log(`  Path:       ${formatArtifactDisplayPath(taskArtifacts.primary)}`);
        if (taskArtifacts.primary.path.workspaceRelativePath) {
          console.log(`  Relative:   ${taskArtifacts.primary.path.workspaceRelativePath}`);
        }
        if (taskArtifacts.primary.path.absolutePath) {
          console.log(`  Absolute:   ${taskArtifacts.primary.path.absolutePath}`);
        }
        if (typeof taskArtifacts.primary.exists === "boolean") {
          console.log(`  Exists:     ${taskArtifacts.primary.exists ? "yes" : "no"}`);
        }
      }
      for (const artifact of taskArtifacts.items.filter((item) => item.role !== "primary")) {
        console.log(`  Extra:      ${artifact.label} -> ${formatArtifactDisplayPath(artifact)}`);
      }
    }

    if (details.activeAssignment) {
      console.log("\nActive assignment:");
      console.log(`  Agent:       ${details.activeAssignment.agentId}`);
      console.log(`  Session:     ${details.activeAssignment.sessionName}`);
      if (details.activeAssignment.worktree) {
        console.log(`  Worktree:    ${formatTaskWorktree(details.activeAssignment.worktree)}`);
      }
      console.log(`  Status:      ${details.activeAssignment.status}`);
      console.log(`  Assigned at: ${formatTime(details.activeAssignment.assignedAt)}`);
      console.log(`  RT override: ${formatTaskRuntimeOptions(details.activeAssignment.runtimeOverride)}`);
      console.log(
        `  Checkpoint:  ${formatDurationMs(resolveTaskCheckpointIntervalMs(details.activeAssignment.checkpointIntervalMs))}`,
      );
      console.log(`  Report to:   ${details.activeAssignment.reportToSessionName ?? "-"}`);
      console.log(`  Report on:   ${formatTaskReportEvents(details.activeAssignment.reportEvents)}`);
      console.log(`  Last report: ${formatTime(details.activeAssignment.checkpointLastReportAt)}`);
      if (details.activeAssignment.checkpointDueAt) {
        console.log(
          `  Next due:    ${formatTime(details.activeAssignment.checkpointDueAt)} (${timeUntil(details.activeAssignment.checkpointDueAt)})`,
        );
      } else {
        console.log("  Next due:    paused");
      }
      console.log(`  Overdue:     ${details.activeAssignment.checkpointOverdueCount ?? 0}`);
    }

    if (details.project) {
      console.log("\nProject:");
      console.log(`  Slug:       ${details.project.projectSlug}`);
      console.log(`  Title:      ${details.project.projectTitle}`);
      console.log(`  Status:     ${details.project.projectStatus}`);
      console.log(`  Summary:    ${details.project.projectSummary}`);
      console.log(`  Next step:  ${details.project.projectNextStep}`);
      console.log(`  Workflow:   ${details.project.workflowRunId}`);
      if (details.project.workflowRunTitle) {
        console.log(`  WF title:   ${details.project.workflowRunTitle}`);
      }
      if (details.project.workflowRunStatus) {
        console.log(`  WF status:  ${details.project.workflowRunStatus}`);
      }
      if (details.project.workflowLinkRole) {
        console.log(`  WF role:    ${details.project.workflowLinkRole}`);
      }
      console.log(
        `  Rollup:     ${details.project.workflowAggregateStatus ?? "-"} (${details.project.workflowCount} workflow${details.project.workflowCount === 1 ? "" : "s"})`,
      );
    }

    console.log("\nScheduling:");
    console.log(`  Readiness:   ${formatReadiness(dependencySurface.readiness)}`);
    console.log(`  Launch plan: ${formatLaunchPlanSummary(dependencySurface.launchPlan)}`);
    if (dependencySurface.launchPlan?.runtimeOverride) {
      console.log(`  Launch RT:   ${formatTaskRuntimeOptions(dependencySurface.launchPlan.runtimeOverride)}`);
    }

    if (dependencySurface.dependencies.length > 0) {
      console.log("\nDependencies (gating):");
      for (const dependency of dependencySurface.dependencies) {
        console.log(`  - ${formatDependencyEdge(dependency)}`);
      }
    } else {
      console.log("\nDependencies (gating):");
      console.log("  - none");
    }

    if (dependencySurface.dependents.length > 0) {
      console.log("\nDependents:");
      for (const dependent of dependencySurface.dependents) {
        console.log(`  - ${formatDependencyEdge(dependent)}`);
      }
    }

    if (details.parentTask) {
      const parentTask = buildTaskLineageNode(details.parentTask);
      console.log("\nLineage:");
      console.log("  Parent:");
      console.log(
        `  ${parentTask.id} :: ${formatTaskStatus(parentTask.status)} :: ${parentTask.assigneeAgentId ?? "-"} :: ${parentTask.assigneeSessionName ?? "-"} :: ${formatArtifactDisplayPath(parentTask.primaryArtifact)}`,
      );
    }

    if (details.childTasks.length > 0) {
      console.log(details.parentTask ? "  Children:" : "\nLineage:");
      for (const childTask of details.childTasks.map(buildTaskLineageNode)) {
        console.log(
          `  - ${childTask.id} :: ${formatTaskStatus(childTask.status)} :: ${childTask.assigneeAgentId ?? "-"} :: ${childTask.assigneeSessionName ?? "-"} :: ${formatArtifactDisplayPath(childTask.primaryArtifact)}`,
        );
      }
    }

    if (details.events.length > 0) {
      console.log("\nEvents:");
      for (const event of recentEvents) {
        const progress = typeof event.progress === "number" ? ` [${event.progress}%]` : "";
        const actor = event.actor ?? event.agentId ?? "cli";
        console.log(
          `  - ${formatTime(event.createdAt)} ${event.type}${progress} ${actor}${event.message ? ` :: ${event.message}` : ""}`,
        );
      }
    }

    if (details.comments.length > 0) {
      console.log("\nComments:");
      for (const comment of recentComments) {
        console.log(formatTaskComment(comment));
      }
    }

    if (
      typeof historyLimit === "number" &&
      (details.events.length > recentEvents.length || details.comments.length > recentComments.length)
    ) {
      console.log(
        `\nHistory limited to the last ${historyLimit} events/comments. Use --last all to show everything captured.`,
      );
    }

    printNextSteps(details.task);
    return payload;
  }

  @Command({ name: "comment", description: "Add a comment to a task and steer the assignee if it is active" })
  @Returns(taskCommentReturnSchema)
  async comment(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Arg("body", { description: "Comment body" }) body: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      fail("Comment body cannot be empty.");
    }

    const actor = getTaskActor();
    const result = await commentTask(taskId, {
      author: actor.actor,
      authorAgentId: actor.agentId,
      authorSessionName: actor.sessionName,
      body: trimmedBody,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ Comment added to ${taskId}`);
      console.log(`  ${result.comment.body}`);
      if (result.steeredSessionName) {
        console.log(`  Steer: ${result.steeredSessionName}`);
      }
    }
    return result;
  }

  @Command({ name: "archive", description: "Archive a task without changing its execution status" })
  @Returns(taskMutationReturnSchema)
  async archive(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Why this task should leave the default list" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const finalReason = reason?.trim();
    if (!finalReason) {
      fail("--reason is required");
    }

    const actor = getTaskActor();
    const result = archiveTask(taskId, {
      ...actor,
      reason: finalReason,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ Task ${taskId} ${result.wasNoop ? "already archived" : "archived"}`);
      console.log(`  ${result.task.archiveReason ?? finalReason}`);
    }
    return result;
  }

  @Command({ name: "unarchive", description: "Restore an archived task to the default list" })
  @Returns(taskMutationReturnSchema)
  async unarchive(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const actor = getTaskActor();
    const result = unarchiveTask(taskId, actor);
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ Task ${taskId} ${result.wasNoop ? "already visible" : "unarchived"}`);
    }
    return result;
  }

  @Command({
    name: "dispatch",
    description: "Dispatch a task now, or arm a launch plan if dependencies still gate start",
  })
  @Returns(taskDispatchReturnSchema)
  async dispatch(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--agent <id>", description: "Agent ID to receive the task" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name (defaults to task-specific session)" })
    sessionName?: string,
    @Option({ flags: "--checkpoint <duration>", description: "Override the assignment checkpoint interval" })
    checkpoint?: string,
    @Option({ flags: "--report-to <session>", description: "Override the report target for this assignment" })
    reportToSessionName?: string,
    @Option({ flags: "--report-events <events>", description: "Override report events for this assignment" })
    reportEvents?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--model <model>", description: "Dispatch runtime model override" })
    model?: string,
    @Option({ flags: "--effort <level>", description: "Runtime effort: low|medium|high|xhigh" })
    effort?: string,
    @Option({ flags: "--thinking <level>", description: "Runtime thinking: off|normal|verbose" })
    thinking?: string,
    @Option({
      flags: "--actor-session <name>",
      description:
        "Attribute the dispatch to a specific session (overrides RAVI_TASK_ACTOR; useful when a UI dispatches on behalf of a session)",
    })
    actorSessionName?: string,
  ) {
    if (!agentId?.trim()) {
      fail("--agent is required");
    }
    const normalizedAgentId = agentId.trim();
    try {
      requireTaskRuntimeAgent(normalizedAgentId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }

    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const actor = resolveDispatchActor(actorSessionName);
    const checkpointIntervalMs = parseCheckpointInterval(checkpoint);
    const parsedReportEvents = parseReportEvents(reportEvents);
    const runtimeOverride = parseRuntimeOverride(model, effort, thinking);
    const result = await queueOrDispatchTask(taskId, {
      agentId: normalizedAgentId,
      sessionName: sessionName?.trim() || getDefaultTaskSessionNameForTask(details.task),
      assignedBy: actor.actor,
      ...(actor.agentId ? { assignedByAgentId: actor.agentId } : {}),
      ...(actor.sessionName ? { assignedBySessionName: actor.sessionName } : {}),
      ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
      ...(reportToSessionName?.trim() ? { reportToSessionName: reportToSessionName.trim() } : {}),
      ...(parsedReportEvents ? { reportEvents: parsedReportEvents } : {}),
      ...(runtimeOverride ? { runtimeOverride } : {}),
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.mode === "launch_planned") {
      console.log(`\n✓ Launch plan armed for ${taskId}`);
      console.log(`  Agent:      ${result.launchPlan.agentId}`);
      console.log(`  Session:    ${result.launchPlan.sessionName}`);
      if (result.launchPlan.runtimeOverride) {
        console.log(`  Runtime:    ${formatTaskRuntimeOptions(result.launchPlan.runtimeOverride)}`);
      }
      console.log(`  Readiness:  ${formatReadiness(result.readiness)}`);
      console.log(`  Missing:    ${result.readiness.unsatisfiedDependencyIds.join(", ")}`);
      console.log(`  Inspect:    ravi tasks show ${taskId}`);
    } else {
      console.log(`\n✓ Dispatched ${taskId}`);
      console.log(`  Agent:    ${result.task.assigneeAgentId}`);
      console.log(`  Session:  ${result.sessionName}`);
      console.log(`  Status:   ${formatTaskStatus(result.task.status)}`);
      console.log(`  Checkpoint: ${formatCheckpointSummary(result.assignment)}`);
      console.log(`  Report to: ${result.assignment.reportToSessionName ?? "-"}`);
      console.log(`  Report on: ${formatTaskReportEvents(result.assignment.reportEvents)}`);
      console.log(
        `  Runtime:   ${formatRuntimeResolution(resolveTaskRuntimeForRead(result.task, { assignment: result.assignment }))}`,
      );
      console.log(`  Profile:  ${resolveTaskProfileForTask(result.task).id}`);
      if (result.primaryArtifact) {
        console.log(`  ${result.primaryArtifact.label}:  ${result.primaryArtifact.path}`);
      }
      console.log(`\n${result.dispatchSummary}`);
      console.log(`  ravi tasks report ${taskId}`);
      console.log(`  ravi tasks done ${taskId}`);
      console.log(`  ravi tasks block ${taskId}`);
      console.log(`  ravi tasks fail ${taskId}`);
    }
    return result;
  }

  @Command({ name: "report", description: "Report task progress from a CLI or agent session" })
  @Returns(taskMutationReturnSchema)
  async report(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--message <text>", description: "Progress update message" }) message?: string,
    @Option({ flags: "--progress <n>", description: "Progress percentage 0-100" }) progress?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const actor = getTaskActor();
    const taskProfile = details.taskProfile ?? resolveTaskProfileForTask(details.task);
    const docState = readTaskDocFrontmatterForProfile(details.task, taskProfile);
    const usesTaskDocument = taskProfileUsesTaskDocument(taskProfile);
    const explicitMessage = message === undefined ? undefined : normalizeTaskProgressMessage(message);
    if (message !== undefined && !explicitMessage) {
      fail(
        !usesTaskDocument
          ? "Task progress requires a descriptive message. Provide --message with useful text."
          : "Task progress requires a descriptive message. Update TASK.md frontmatter.progress_note or provide --message with useful text.",
      );
    }
    const finalMessage = explicitMessage ?? normalizeTaskProgressMessage(docState.progressNote);
    if (!finalMessage) {
      fail(
        !usesTaskDocument
          ? "Provide --message with a descriptive progress update."
          : "Update TASK.md frontmatter.progress_note or provide --message with a descriptive progress update.",
      );
    }
    const cliProgressValue = progress !== undefined ? Number.parseInt(progress, 10) : undefined;
    const progressValue = Number.isFinite(cliProgressValue) ? cliProgressValue : docState.progress;

    const result = reportTaskProgress(taskId, {
      ...actor,
      message: finalMessage,
      ...(Number.isFinite(progressValue) ? { progress: progressValue } : {}),
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✓ ${taskId} -> ${result.task.progress}% (${formatTaskStatus(result.task.status)})`);
      console.log(`  ${result.event.message ?? finalMessage}`);
    }
    return result;
  }

  @Command({ name: "done", description: "Mark a task as done" })
  @Returns(taskMutationReturnSchema)
  async done(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--summary <text>", description: "Completion summary" }) summary?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const taskProfile = details.taskProfile ?? resolveTaskProfileForTask(details.task);
    const docState = readTaskDocFrontmatterForProfile(details.task, taskProfile);
    const usesTaskDocument = taskProfileUsesTaskDocument(taskProfile);
    const finalSummary = summary?.trim() || docState.summary;
    if (!finalSummary) {
      fail(
        !usesTaskDocument
          ? `Provide --summary${taskProfile.completion.summaryLabel ? ` (${taskProfile.completion.summaryLabel})` : ""}.`
          : "Update TASK.md frontmatter.summary or provide --summary.",
      );
    }

    const actor = getTaskActor();
    const result = await completeTask(taskId, {
      ...actor,
      message: finalSummary,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const effectiveSummary = result.task.summary ?? finalSummary;
      console.log(`✓ Task ${taskId} ${result.wasNoop ? "already done" : "done"}`);
      console.log(`  ${effectiveSummary}`);
    }
    return result;
  }

  @Command({ name: "block", description: "Mark a task as blocked" })
  @Returns(taskMutationReturnSchema)
  async block(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Concrete blocker reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const taskProfile = details.taskProfile ?? resolveTaskProfileForTask(details.task);
    const docState = readTaskDocFrontmatterForProfile(details.task, taskProfile);
    const usesTaskDocument = taskProfileUsesTaskDocument(taskProfile);
    const finalReason = reason?.trim() || docState.blockerReason;
    if (!finalReason) {
      fail(!usesTaskDocument ? "Provide --reason." : "Update TASK.md frontmatter.blocker_reason or provide --reason.");
    }
    const progressValue = typeof docState.progress === "number" ? docState.progress : undefined;

    const actor = getTaskActor();
    const result = blockTask(taskId, {
      ...actor,
      message: finalReason,
      ...(typeof progressValue === "number" ? { progress: progressValue } : {}),
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.wasNoop) {
      console.log(`✓ Task ${taskId} already done`);
      console.log(`  ${result.task.summary ?? "Block ignored because the task is already terminal."}`);
    } else {
      console.log(`⚠️  Task ${taskId} blocked`);
      console.log(`  ${finalReason}`);
    }
    return result;
  }

  @Command({ name: "fail", description: "Mark a task as failed" })
  @Returns(taskMutationReturnSchema)
  async failTaskCommand(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Failure reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const taskProfile = details.taskProfile ?? resolveTaskProfileForTask(details.task);
    const docState = readTaskDocFrontmatterForProfile(details.task, taskProfile);
    const usesTaskDocument = taskProfileUsesTaskDocument(taskProfile);
    const finalReason = reason?.trim() || docState.summary || docState.blockerReason;
    if (!finalReason) {
      fail(
        !usesTaskDocument
          ? "Provide --reason."
          : "Update TASK.md frontmatter.summary/blocker_reason or provide --reason.",
      );
    }

    const actor = getTaskActor();
    const result = failTask(taskId, {
      ...actor,
      message: finalReason,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✗ Task ${taskId} failed`);
      console.log(`  ${finalReason}`);
    }
    return result;
  }

  @Command({ name: "watch", description: "Watch task events live" })
  @CliOnly()
  async watch(
    @Arg("taskId", { description: "Task ID (optional)", required: false }) taskId?: string,
    @Option({ flags: "--json", description: "Print raw JSONL events" }) asJson?: boolean,
  ) {
    let lastSeenEventId = 0;
    if (taskId) {
      const details = getTaskDetails(taskId);
      if (!details.task) {
        fail(`Task not found: ${taskId}`);
      }
      console.log(`\nWatching ${taskId}\n`);
      if (details.activeAssignment) {
        console.log(`Checkpoint: ${formatCheckpointSummary(details.activeAssignment)}`);
        console.log("");
      }
      for (const event of details.events.slice(-20)) {
        console.log(formatWatchLine(buildWatchPayload(taskId, details.task, event, details.activeAssignment), asJson));
        lastSeenEventId = Math.max(lastSeenEventId, event.id ?? lastSeenEventId);
      }
    } else {
      console.log("\nWatching all task events\n");
    }

    const pattern = taskId ? `ravi.task.${taskId}.event` : "ravi.task.*.event";
    let closed = false;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      await nats.close().catch(() => {});
    };

    const sigintHandler = async () => {
      console.log("\n🛑 task watch interrupted");
      await cleanup();
    };
    process.once("SIGINT", sigintHandler);

    try {
      while (!closed) {
        if (taskId) {
          const replay = printTaskEventsSince(taskId, lastSeenEventId, asJson);
          lastSeenEventId = replay.lastSeenEventId;
        }

        try {
          const stream = nats.subscribe(pattern);
          for await (const event of stream) {
            if (closed) break;
            console.log(formatWatchLine(event.data, asJson));
            if (taskId) {
              const eventId =
                typeof (event.data.event as Record<string, unknown> | undefined)?.id === "number"
                  ? ((event.data.event as Record<string, unknown>).id as number)
                  : 0;
              lastSeenEventId = Math.max(lastSeenEventId, eventId);
            }
          }
        } catch (err) {
          if (closed) break;
          console.log(`\n↻ task watch reconnecting (${err instanceof Error ? err.message : "subscription ended"})\n`);
        }

        if (closed) break;
        await sleep(TASK_WATCH_RECONNECT_DELAY_MS);
      }
    } finally {
      process.removeListener("SIGINT", sigintHandler);
      await cleanup();
    }
  }
}

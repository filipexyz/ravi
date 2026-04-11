import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { formatDurationMs, parseDurationMs } from "../../cron/schedule.js";
import { resolveTaskCheckpointIntervalMs } from "../../tasks/checkpoint.js";
import {
  TASK_REPORT_EVENTS,
  buildTaskSessionLink,
  completeTask,
  commentTask,
  createTask,
  createTaskWorktreeConfig,
  dispatchTask,
  emitTaskEvent,
  formatTaskWorktree,
  getDefaultTaskSessionName,
  getTaskDocPath,
  getTaskActor,
  getTaskDetails,
  listTasks,
  readTaskDocFrontmatter,
  reportTaskProgress,
  blockTask,
  failTask,
} from "../../tasks/index.js";
import type {
  TaskComment,
  TaskEvent,
  TaskPriority,
  TaskRecord,
  TaskReportEvent,
  TaskStatus,
} from "../../tasks/types.js";

const VALID_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const VALID_STATUSES = new Set<TaskStatus>(["open", "dispatched", "in_progress", "blocked", "done", "failed"]);
const TASK_WATCH_RECONNECT_DELAY_MS = 1000;

function formatTaskStatus(status: TaskStatus): string {
  switch (status) {
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

function printTaskSummary(task: TaskRecord): void {
  console.log(`\nTask:        ${task.id}`);
  console.log(`Title:       ${task.title}`);
  console.log(`Status:      ${formatTaskStatus(task.status)}`);
  console.log(`Priority:    ${task.priority}`);
  console.log(`Progress:    ${task.progress}%`);
  console.log(`Checkpoint:  ${formatDurationMs(resolveTaskCheckpointIntervalMs(task.checkpointIntervalMs))}`);
  console.log(`Report to:   ${task.reportToSessionName ?? "-"}`);
  console.log(`Report on:   ${formatTaskReportEvents(task.reportEvents)}`);
  if (task.parentTaskId) console.log(`Parent:      ${task.parentTaskId}`);
  console.log(`Agent:       ${task.assigneeAgentId ?? "-"}`);
  console.log(`Session:     ${task.assigneeSessionName ?? "-"}`);
  if (task.worktree) console.log(`Worktree:    ${formatTaskWorktree(task.worktree)}`);
  if (task.taskDir) console.log(`Task dir:    ${task.taskDir}`);
  if (task.taskDir) console.log(`TASK.md:     ${getTaskDocPath(task)}`);
  console.log(`Created:     ${formatTime(task.createdAt)}`);
  console.log(`Updated:     ${formatTime(task.updatedAt)} (${timeAgo(task.updatedAt)})`);
  if (task.summary) console.log(`Summary:     ${task.summary}`);
  if (task.blockerReason) console.log(`Blocked by:  ${task.blockerReason}`);
  console.log("\nInstructions:");
  console.log(`  ${task.instructions.split("\n").join("\n  ")}`);
}

function buildTaskDocumentSummary(task: TaskRecord) {
  return {
    taskDir: task.taskDir ?? null,
    path: getTaskDocPath(task),
    frontmatter: readTaskDocFrontmatter(task),
  };
}

function buildTaskLineageNode(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
    workSessionName: task.assigneeSessionName ?? null,
    taskDir: task.taskDir ?? null,
    path: getTaskDocPath(task),
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
  console.log("\nNext:");
  if (task.status === "open") {
    console.log(`  1. abrir ${getTaskDocPath(task)}`);
    console.log("  2. refinar o TASK.md via brainstorm/edicao antes de subir");
    console.log(`  3. revisar com o dono da task`);
    console.log(`  4. so depois despachar: ravi tasks dispatch ${task.id} --agent <agent>`);
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

  console.log("  task concluída; use list/show para histórico.");
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
  const status = typeof payload.status === "string" ? payload.status : "unknown";
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
  return `[${time}] ${taskId} :: ${type} :: ${status} :: ${progress} :: ${actor}${message ? ` :: ${message}` : ""}${checkpoint !== "-" ? ` :: ${checkpoint}` : ""}`;
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
  activeAssignment?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    taskId,
    status: deriveWatchStatus(event, task?.status),
    progress: typeof event.progress === "number" ? event.progress : (task?.progress ?? 0),
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
  @Command({ name: "create", description: "Create a tracked task; --agent/--assignee auto-dispatches immediately" })
  async create(
    @Arg("title", { description: "Short task title" }) title: string,
    @Option({ flags: "--instructions <text>", description: "Detailed instructions for the task" })
    instructions?: string,
    @Option({ flags: "--priority <level>", description: "low|normal|high|urgent", defaultValue: "normal" })
    priority?: string,
    @Option({ flags: "--agent <id>", description: "Auto-dispatch to this agent immediately" }) agentId?: string,
    @Option({ flags: "--assignee <id>", description: "Alias for --agent" }) assigneeId?: string,
    @Option({ flags: "--session <name>", description: "Working session name to use when auto-dispatching" })
    sessionName?: string,
    @Option({ flags: "--worktree-mode <mode>", description: "inherit|path (path is implied by --worktree-path)" })
    worktreeMode?: string,
    @Option({ flags: "--worktree-path <path>", description: "Task worktree path (relative to agent cwd if needed)" })
    worktreePath?: string,
    @Option({ flags: "--worktree-branch <name>", description: "Optional branch label for the task worktree" })
    worktreeBranch?: string,
    @Option({ flags: "--parent <task-id>", description: "Create this task as a child of another task" })
    parentTaskId?: string,
    @Option({ flags: "--checkpoint <duration>", description: "Assignment checkpoint interval (e.g. 5m, 30s, 1h)" })
    checkpoint?: string,
    @Option({ flags: "--report-to <session>", description: "Session to receive explicit task reports" })
    reportToSessionName?: string,
    @Option({ flags: "--report-events <events>", description: "Comma-separated report events: blocked,done,failed" })
    reportEvents?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!instructions?.trim()) {
      fail("--instructions is required");
    }

    const assigneeAgentId = resolveCreateAssignee(agentId, assigneeId);
    if (sessionName?.trim() && !assigneeAgentId) {
      fail("--session requires --agent or --assignee.");
    }

    const worktree = requireTaskWorktree(worktreeMode, worktreePath, worktreeBranch);
    const checkpointIntervalMs = parseCheckpointInterval(checkpoint);
    const parsedReportEvents = parseReportEvents(reportEvents);
    const actor = getTaskActor();
    const created = createTask({
      title: title.trim(),
      instructions: instructions.trim(),
      priority: requirePriority(priority),
      ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
      ...(reportToSessionName?.trim() ? { reportToSessionName: reportToSessionName.trim() } : {}),
      ...(parsedReportEvents ? { reportEvents: parsedReportEvents } : {}),
      createdBy: actor.actor,
      createdByAgentId: actor.agentId,
      createdBySessionName: actor.sessionName,
      ...(parentTaskId?.trim() ? { parentTaskId: parentTaskId.trim() } : {}),
      ...(worktree ? { worktree } : {}),
    });
    await emitMutationEvents(created);

    let task = created.task;
    let dispatched: Awaited<ReturnType<typeof dispatchTask>> | null = null;
    if (assigneeAgentId) {
      dispatched = await dispatchTask(created.task.id, {
        agentId: assigneeAgentId,
        sessionName: sessionName?.trim() || getDefaultTaskSessionName(created.task.id),
        assignedBy: actor.actor,
        ...(actor.agentId ? { assignedByAgentId: actor.agentId } : {}),
        ...(actor.sessionName ? { assignedBySessionName: actor.sessionName } : {}),
        ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
        ...(worktree ? { worktree } : {}),
      });
      await emitMutationEvents(dispatched);
      task = dispatched.task;
    }

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            task,
            event: created.event,
            parentTaskId: task.parentTaskId ?? null,
            ...(dispatched
              ? {
                  dispatch: {
                    assignment: dispatched.assignment,
                    event: dispatched.event,
                    sessionName: dispatched.sessionName,
                  },
                }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`\n✓ ${dispatched ? "Created and dispatched" : "Created"} task ${task.id}`);
    printTaskSummary(task);
    printNextSteps(task);
  }

  @Command({ name: "list", description: "List tasks" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) status?: string,
    @Option({ flags: "--agent <id>", description: "Filter by assigned agent" }) agentId?: string,
    @Option({ flags: "--mine", description: "Filter by current agent/session context" }) mine?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = getContext();
    const tasks = listTasks({
      status: requireStatus(status),
      agentId: mine ? (ctx?.agentId ?? undefined) : agentId,
      sessionName: mine ? (ctx?.sessionName ?? undefined) : undefined,
    });

    if (asJson) {
      console.log(JSON.stringify({ total: tasks.length, tasks }, null, 2));
      return;
    }

    if (tasks.length === 0) {
      console.log("\nNo tasks found.\n");
      console.log("Usage:");
      console.log('  ravi tasks create "Fix routing" --instructions "..."');
      console.log("  ravi tasks dispatch <task-id> --agent dev");
      return;
    }

    console.log(`\nTasks (${tasks.length})\n`);
    console.log("  ID              STATUS      PROGRESS  PRIORITY  AGENT        UPDATED      TITLE");
    console.log(
      "  --------------  ----------  --------  --------  -----------  ----------  ------------------------------",
    );
    for (const task of tasks) {
      console.log(
        `  ${task.id.padEnd(14)}  ${formatTaskStatus(task.status).padEnd(10)}  ${`${task.progress}%`.padEnd(8)}  ${task.priority.padEnd(8)}  ${(task.assigneeAgentId ?? "-").padEnd(11)}  ${timeAgo(task.updatedAt).padEnd(10)}  ${task.title.slice(0, 30)}`,
      );
    }
    console.log("");
  }

  @Command({ name: "show", description: "Show task details and history" })
  show(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ...details,
            taskSession: details.task ? buildTaskSessionLink(details.task) : null,
            parentTask: details.parentTask ? buildTaskLineageNode(details.parentTask) : null,
            childTasks: details.childTasks.map(buildTaskLineageNode),
            taskDocument: details.task ? buildTaskDocumentSummary(details.task) : null,
          },
          null,
          2,
        ),
      );
      return;
    }

    printTaskSummary(details.task);

    const taskSession = buildTaskSessionLink(details.task);
    if (taskSession) {
      console.log("\nTask session:");
      console.log(`  Alias:      ${taskSession.alias}`);
      console.log(`  Session:    ${taskSession.sessionName}`);
      console.log(`  Tool topic: ${taskSession.toolTopic}`);
      console.log(`  Read:       ${taskSession.readCommand}`);
      console.log(`  Debug:      ${taskSession.debugCommand}`);
    }

    const taskDocument = buildTaskDocumentSummary(details.task);
    console.log("\nTASK.md:");
    console.log(`  Dir:        ${taskDocument.taskDir ?? "-"}`);
    console.log(`  Path:       ${taskDocument.path}`);
    if (taskDocument.frontmatter.status) {
      console.log(`  FM status:  ${taskDocument.frontmatter.status}`);
    }
    if (typeof taskDocument.frontmatter.progress === "number") {
      console.log(`  FM prog.:   ${taskDocument.frontmatter.progress}%`);
    }
    if (taskDocument.frontmatter.summary) {
      console.log(`  FM summary: ${taskDocument.frontmatter.summary}`);
    }
    if (taskDocument.frontmatter.blockerReason) {
      console.log(`  FM block:   ${taskDocument.frontmatter.blockerReason}`);
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

    if (details.parentTask) {
      const parentTask = buildTaskLineageNode(details.parentTask);
      console.log("\nParent task:");
      console.log(
        `  ${parentTask.id} :: ${formatTaskStatus(parentTask.status)} :: ${parentTask.assigneeAgentId ?? "-"} :: ${parentTask.assigneeSessionName ?? "-"} :: ${parentTask.path}`,
      );
    }

    if (details.childTasks.length > 0) {
      console.log("\nChild tasks:");
      for (const childTask of details.childTasks.map(buildTaskLineageNode)) {
        console.log(
          `  - ${childTask.id} :: ${formatTaskStatus(childTask.status)} :: ${childTask.assigneeAgentId ?? "-"} :: ${childTask.assigneeSessionName ?? "-"} :: ${childTask.path}`,
        );
      }
    }

    if (details.events.length > 0) {
      console.log("\nEvents:");
      for (const event of details.events.slice(-12)) {
        const progress = typeof event.progress === "number" ? ` [${event.progress}%]` : "";
        const actor = event.actor ?? event.agentId ?? "cli";
        console.log(
          `  - ${formatTime(event.createdAt)} ${event.type}${progress} ${actor}${event.message ? ` :: ${event.message}` : ""}`,
        );
      }
    }

    if (details.comments.length > 0) {
      console.log("\nComments:");
      for (const comment of details.comments.slice(-12)) {
        console.log(formatTaskComment(comment));
      }
    }

    printNextSteps(details.task);
  }

  @Command({ name: "comment", description: "Add a comment to a task and steer the assignee if it is active" })
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
      return;
    }

    console.log(`✓ Comment added to ${taskId}`);
    console.log(`  ${result.comment.body}`);
    if (result.steeredSessionName) {
      console.log(`  Steer: ${result.steeredSessionName}`);
    }
  }

  @Command({ name: "dispatch", description: "Dispatch a task to an agent session" })
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
  ) {
    if (!agentId?.trim()) {
      fail("--agent is required");
    }

    const actor = getTaskActor();
    const checkpointIntervalMs = parseCheckpointInterval(checkpoint);
    const parsedReportEvents = parseReportEvents(reportEvents);
    const result = await dispatchTask(taskId, {
      agentId: agentId.trim(),
      sessionName: sessionName?.trim() || getDefaultTaskSessionName(taskId),
      assignedBy: actor.actor,
      ...(actor.agentId ? { assignedByAgentId: actor.agentId } : {}),
      ...(actor.sessionName ? { assignedBySessionName: actor.sessionName } : {}),
      ...(typeof checkpointIntervalMs === "number" ? { checkpointIntervalMs } : {}),
      ...(reportToSessionName?.trim() ? { reportToSessionName: reportToSessionName.trim() } : {}),
      ...(parsedReportEvents ? { reportEvents: parsedReportEvents } : {}),
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\n✓ Dispatched ${taskId}`);
    console.log(`  Agent:    ${result.task.assigneeAgentId}`);
    console.log(`  Session:  ${result.sessionName}`);
    console.log(`  Status:   ${formatTaskStatus(result.task.status)}`);
    console.log(`  Checkpoint: ${formatCheckpointSummary(result.assignment)}`);
    console.log(`  Report to: ${result.assignment.reportToSessionName ?? "-"}`);
    console.log(`  Report on: ${formatTaskReportEvents(result.assignment.reportEvents)}`);
    console.log(`  TASK.md:  ${getTaskDocPath(result.task)}`);
    console.log("\nThe target session was instructed to edit TASK.md first, then sync through:");
    console.log(`  ravi tasks report ${taskId}`);
    console.log(`  ravi tasks done ${taskId}`);
    console.log(`  ravi tasks block ${taskId}`);
    console.log(`  ravi tasks fail ${taskId}`);
  }

  @Command({ name: "report", description: "Report task progress from a CLI or agent session" })
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
    const docState = readTaskDocFrontmatter(details.task);
    const cliProgressValue = progress !== undefined ? Number.parseInt(progress, 10) : undefined;
    const progressValue = Number.isFinite(cliProgressValue) ? cliProgressValue : docState.progress;
    if (!message?.trim() && !Number.isFinite(progressValue)) {
      fail("Update TASK.md frontmatter.progress or provide --message/--progress.");
    }

    const result = reportTaskProgress(taskId, {
      ...actor,
      ...(message?.trim() ? { message: message.trim() } : {}),
      ...(Number.isFinite(progressValue) ? { progress: progressValue } : {}),
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✓ ${taskId} -> ${result.task.progress}% (${formatTaskStatus(result.task.status)})`);
    if (message?.trim()) console.log(`  ${message.trim()}`);
  }

  @Command({ name: "done", description: "Mark a task as done" })
  async done(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--summary <text>", description: "Completion summary" }) summary?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const docState = readTaskDocFrontmatter(details.task);
    const finalSummary = summary?.trim() || docState.summary;
    if (!finalSummary) {
      fail("Update TASK.md frontmatter.summary or provide --summary.");
    }

    const actor = getTaskActor();
    const result = completeTask(taskId, {
      ...actor,
      message: finalSummary,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const effectiveSummary = result.task.summary ?? finalSummary;
    console.log(`✓ Task ${taskId} ${result.wasNoop ? "already done" : "done"}`);
    console.log(`  ${effectiveSummary}`);
  }

  @Command({ name: "block", description: "Mark a task as blocked" })
  async block(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Concrete blocker reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const docState = readTaskDocFrontmatter(details.task);
    const finalReason = reason?.trim() || docState.blockerReason;
    if (!finalReason) {
      fail("Update TASK.md frontmatter.blocker_reason or provide --reason.");
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
      return;
    }

    console.log(`⚠️  Task ${taskId} blocked`);
    console.log(`  ${finalReason}`);
  }

  @Command({ name: "fail", description: "Mark a task as failed" })
  async failTaskCommand(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Failure reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const docState = readTaskDocFrontmatter(details.task);
    const finalReason = reason?.trim() || docState.summary || docState.blockerReason;
    if (!finalReason) {
      fail("Update TASK.md frontmatter.summary/blocker_reason or provide --reason.");
    }

    const actor = getTaskActor();
    const result = failTask(taskId, {
      ...actor,
      message: finalReason,
    });
    await emitMutationEvents(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✗ Task ${taskId} failed`);
    console.log(`  ${finalReason}`);
  }

  @Command({ name: "watch", description: "Watch task events live" })
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

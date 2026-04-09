import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import {
  completeTask,
  createTask,
  createTaskWorktreeConfig,
  dispatchTask,
  emitTaskEvent,
  formatTaskWorktree,
  getDefaultTaskSessionName,
  getTaskActor,
  getTaskDetails,
  listTasks,
  reportTaskProgress,
  blockTask,
  failTask,
} from "../../tasks/index.js";
import type { TaskEvent, TaskPriority, TaskRecord, TaskStatus } from "../../tasks/types.js";

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

function printTaskSummary(task: TaskRecord): void {
  console.log(`\nTask:        ${task.id}`);
  console.log(`Title:       ${task.title}`);
  console.log(`Status:      ${formatTaskStatus(task.status)}`);
  console.log(`Priority:    ${task.priority}`);
  console.log(`Progress:    ${task.progress}%`);
  console.log(`Agent:       ${task.assigneeAgentId ?? "-"}`);
  console.log(`Session:     ${task.assigneeSessionName ?? "-"}`);
  if (task.worktree) console.log(`Worktree:    ${formatTaskWorktree(task.worktree)}`);
  console.log(`Created:     ${formatTime(task.createdAt)}`);
  console.log(`Updated:     ${formatTime(task.updatedAt)} (${timeAgo(task.updatedAt)})`);
  if (task.summary) console.log(`Summary:     ${task.summary}`);
  if (task.blockerReason) console.log(`Blocked by:  ${task.blockerReason}`);
  console.log("\nInstructions:");
  console.log(`  ${task.instructions.split("\n").join("\n  ")}`);
}

function printNextSteps(task: TaskRecord): void {
  console.log("\nNext:");
  if (task.status === "open") {
    console.log(`  ravi tasks dispatch ${task.id} --agent <agent>`);
    return;
  }

  if (task.status === "dispatched" || task.status === "in_progress" || task.status === "blocked") {
    console.log(`  ravi tasks watch ${task.id}`);
    console.log(`  ravi tasks report ${task.id} --progress <0-100> --message "..."`);
    console.log(`  ravi tasks done ${task.id} --summary "..."`);
    console.log(`  ravi tasks block ${task.id} --reason "..."`);
    console.log(`  ravi tasks fail ${task.id} --reason "..."`);
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
  return `[${time}] ${taskId} :: ${type} :: ${status} :: ${progress} :: ${actor}${message ? ` :: ${message}` : ""}`;
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

function buildWatchPayload(taskId: string, task: TaskRecord | null, event: TaskEvent): Record<string, unknown> {
  return {
    taskId,
    status: deriveWatchStatus(event, task?.status),
    progress: typeof event.progress === "number" ? event.progress : (task?.progress ?? 0),
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
    console.log(formatWatchLine(buildWatchPayload(taskId, details.task, event), asJson));
    lastSeenEventId = Math.max(lastSeenEventId, event.id ?? lastSeenEventId);
  }

  return { lastSeenEventId, taskStatus: details.task?.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silenceCliInfraLogs(): void {
  logger.setLevel("error");
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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    if (!instructions?.trim()) {
      fail("--instructions is required");
    }

    const assigneeAgentId = resolveCreateAssignee(agentId, assigneeId);
    if (sessionName?.trim() && !assigneeAgentId) {
      fail("--session requires --agent or --assignee.");
    }

    const worktree = requireTaskWorktree(worktreeMode, worktreePath, worktreeBranch);
    const actor = getTaskActor();
    const created = createTask({
      title: title.trim(),
      instructions: instructions.trim(),
      priority: requirePriority(priority),
      createdBy: actor.actor,
      createdByAgentId: actor.agentId,
      createdBySessionName: actor.sessionName,
      ...(worktree ? { worktree } : {}),
    });
    await emitTaskEvent(created.task, created.event);

    let task = created.task;
    let dispatched: Awaited<ReturnType<typeof dispatchTask>> | null = null;
    if (assigneeAgentId) {
      dispatched = await dispatchTask(created.task.id, {
        agentId: assigneeAgentId,
        sessionName: sessionName?.trim() || getDefaultTaskSessionName(created.task.id),
        assignedBy: actor.actor,
        ...(worktree ? { worktree } : {}),
      });
      await emitTaskEvent(dispatched.task, dispatched.event);
      task = dispatched.task;
    }

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            task,
            event: created.event,
            ...(dispatched
              ? {
                  dispatch: {
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
    silenceCliInfraLogs();
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
    silenceCliInfraLogs();
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    if (asJson) {
      console.log(JSON.stringify(details, null, 2));
      return;
    }

    printTaskSummary(details.task);

    if (details.activeAssignment) {
      console.log("\nActive assignment:");
      console.log(`  Agent:       ${details.activeAssignment.agentId}`);
      console.log(`  Session:     ${details.activeAssignment.sessionName}`);
      if (details.activeAssignment.worktree) {
        console.log(`  Worktree:    ${formatTaskWorktree(details.activeAssignment.worktree)}`);
      }
      console.log(`  Status:      ${details.activeAssignment.status}`);
      console.log(`  Assigned at: ${formatTime(details.activeAssignment.assignedAt)}`);
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

    printNextSteps(details.task);
  }

  @Command({ name: "dispatch", description: "Dispatch a task to an agent session" })
  async dispatch(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--agent <id>", description: "Agent ID to receive the task" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name (defaults to task-specific session)" })
    sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    if (!agentId?.trim()) {
      fail("--agent is required");
    }

    const actor = getTaskActor().actor;
    const result = await dispatchTask(taskId, {
      agentId: agentId.trim(),
      sessionName: sessionName?.trim() || getDefaultTaskSessionName(taskId),
      assignedBy: actor,
    });
    await emitTaskEvent(result.task, result.event);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\n✓ Dispatched ${taskId}`);
    console.log(`  Agent:    ${result.task.assigneeAgentId}`);
    console.log(`  Session:  ${result.sessionName}`);
    console.log(`  Status:   ${formatTaskStatus(result.task.status)}`);
    console.log("\nThe target session was instructed to report progress through:");
    console.log(`  ravi tasks report ${taskId} --progress <0-100> --message "..."`);
    console.log(`  ravi tasks done ${taskId} --summary "..."`);
    console.log(`  ravi tasks block ${taskId} --reason "..."`);
    console.log(`  ravi tasks fail ${taskId} --reason "..."`);
  }

  @Command({ name: "report", description: "Report task progress from a CLI or agent session" })
  async report(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--message <text>", description: "Progress update message" }) message?: string,
    @Option({ flags: "--progress <n>", description: "Progress percentage 0-100" }) progress?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    const actor = getTaskActor();
    const progressValue = progress !== undefined ? Number.parseInt(progress, 10) : undefined;
    if (!message?.trim() && !Number.isFinite(progressValue)) {
      fail("Provide --message, --progress, or both.");
    }

    const result = reportTaskProgress(taskId, {
      ...actor,
      ...(message?.trim() ? { message: message.trim() } : {}),
      ...(Number.isFinite(progressValue) ? { progress: progressValue } : {}),
    });
    await emitTaskEvent(result.task, result.event);

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
    silenceCliInfraLogs();
    if (!summary?.trim()) {
      fail("--summary is required");
    }

    const actor = getTaskActor();
    const result = completeTask(taskId, {
      ...actor,
      message: summary.trim(),
    });
    await emitTaskEvent(result.task, result.event);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✓ Task ${taskId} done`);
    console.log(`  ${summary.trim()}`);
  }

  @Command({ name: "block", description: "Mark a task as blocked" })
  async block(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Concrete blocker reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    if (!reason?.trim()) {
      fail("--reason is required");
    }

    const actor = getTaskActor();
    const result = blockTask(taskId, {
      ...actor,
      message: reason.trim(),
    });
    await emitTaskEvent(result.task, result.event);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`⚠️  Task ${taskId} blocked`);
    console.log(`  ${reason.trim()}`);
  }

  @Command({ name: "fail", description: "Mark a task as failed" })
  async failTaskCommand(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Failure reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    if (!reason?.trim()) {
      fail("--reason is required");
    }

    const actor = getTaskActor();
    const result = failTask(taskId, {
      ...actor,
      message: reason.trim(),
    });
    await emitTaskEvent(result.task, result.event);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✗ Task ${taskId} failed`);
    console.log(`  ${reason.trim()}`);
  }

  @Command({ name: "watch", description: "Watch task events live" })
  async watch(
    @Arg("taskId", { description: "Task ID (optional)", required: false }) taskId?: string,
    @Option({ flags: "--json", description: "Print raw JSONL events" }) asJson?: boolean,
  ) {
    silenceCliInfraLogs();
    let lastSeenEventId = 0;
    if (taskId) {
      const details = getTaskDetails(taskId);
      if (!details.task) {
        fail(`Task not found: ${taskId}`);
      }
      console.log(`\nWatching ${taskId}\n`);
      for (const event of details.events.slice(-20)) {
        console.log(formatWatchLine(buildWatchPayload(taskId, details.task, event), asJson));
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

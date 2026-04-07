import { getContext } from "../cli/context.js";
import { nats } from "../nats.js";
import { expandHome, loadRouterConfig } from "../router/index.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { z } from "zod";
import {
  dbCompleteTask,
  dbCreateTask,
  dbDispatchTask,
  dbFailTask,
  dbBlockTask,
  dbGetTask,
  dbGetActiveAssignment,
  dbListAssignments,
  dbListTaskEvents,
  dbListTasks,
  dbReportTaskProgress,
} from "./task-db.js";
import type {
  CreateTaskInput,
  DispatchTaskInput,
  TaskAssignment,
  TaskPriority,
  ListTasksOptions,
  TaskEvent,
  TaskProgressInput,
  TaskRecord,
  TaskStatus,
  TaskTerminalInput,
} from "./types.js";

const TASK_EVENT_PREFIX = "ravi.task";
const TASK_STATUSES = ["open", "dispatched", "in_progress", "blocked", "done", "failed"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TASK_ARTIFACT_KINDS = ["file", "url", "text"] as const;

export const TASK_STREAM_SCOPE = "tasks";
export const TASK_STREAM_TOPIC_PATTERNS = ["ravi.task.>"] as const;
export const TASK_STREAM_COMMAND_NAMES = [
  "task.create",
  "task.dispatch",
  "task.report",
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
  createdBy: string | null;
  assigneeAgentId: string | null;
  assigneeSessionName: string | null;
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
  activeAssignment: TaskAssignment | null;
  assignments: TaskAssignment[];
  events: TaskEvent[];
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
  assigneeAgentId: string | null;
  assigneeSessionName: string | null;
  task: TaskStreamTaskEntity;
  event: TaskEvent;
  artifacts: TaskArtifactPlaceholder;
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

const TaskCreateCommandArgsSchema = TaskStreamActorSchema.extend({
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  createdBy: z.string().trim().min(1).optional(),
}).strict();

const TaskDispatchCommandArgsSchema = z
  .object({
    taskId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    sessionName: z.string().trim().min(1).optional(),
    assignedBy: z.string().trim().min(1).optional(),
    actor: z.string().trim().min(1).optional(),
  })
  .strict();

const TaskReportCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  message: z.string().trim().min(1).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
}).strict();

const TaskDoneCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  summary: z.string().trim().min(1),
}).strict();

const TaskBlockCommandArgsSchema = TaskStreamActorSchema.extend({
  taskId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
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

function toTaskStreamEntity(task: TaskRecord): TaskStreamTaskEntity {
  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    createdBy: task.createdBy ?? null,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
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

export function isTaskStreamCommand(name: string): name is TaskStreamCommandName {
  return (TASK_STREAM_COMMAND_NAMES as readonly string[]).includes(name);
}

export function buildTaskEventPayload(task: TaskRecord, event: TaskEvent): TaskStreamEventPayload {
  return {
    kind: "task.event",
    taskId: task.id,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    assigneeAgentId: task.assigneeAgentId ?? null,
    assigneeSessionName: task.assigneeSessionName ?? null,
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
        activeAssignment: details.activeAssignment,
        assignments: details.assignments,
        events: details.events.slice(-parsed.eventsLimit),
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
      const { task, event } = createTask({
        title: args.title,
        instructions: args.instructions,
        priority: args.priority,
        createdBy: args.createdBy ?? resolveTaskCommandActor(args.actor, options.actor),
      });
      await emitTaskEvent(task, event);
      return {
        action: name,
        task: toTaskStreamEntity(task),
        event,
      };
    }

    case "task.dispatch": {
      const args = TaskDispatchCommandArgsSchema.parse(rawArgs);
      const result = await dispatchTask(args.taskId, {
        agentId: args.agentId,
        sessionName: args.sessionName ?? getDefaultTaskSessionName(args.taskId),
        assignedBy: args.assignedBy ?? resolveTaskCommandActor(args.actor, options.actor),
      });
      await emitTaskEvent(result.task, result.event);
      return {
        action: name,
        task: toTaskStreamEntity(result.task),
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

    case "task.done": {
      const args = TaskDoneCommandArgsSchema.parse(rawArgs);
      const { task, event } = completeTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.summary,
      });
      await emitTaskEvent(task, event);
      return {
        action: name,
        task: toTaskStreamEntity(task),
        event,
      };
    }

    case "task.block": {
      const args = TaskBlockCommandArgsSchema.parse(rawArgs);
      const { task, event } = blockTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.reason,
      });
      await emitTaskEvent(task, event);
      return {
        action: name,
        task: toTaskStreamEntity(task),
        event,
      };
    }

    case "task.fail": {
      const args = TaskFailCommandArgsSchema.parse(rawArgs);
      const { task, event } = failTask(args.taskId, {
        ...(args.actor ? { actor: args.actor } : options.actor ? { actor: options.actor } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.sessionName ? { sessionName: args.sessionName } : {}),
        message: args.reason,
      });
      await emitTaskEvent(task, event);
      return {
        action: name,
        task: toTaskStreamEntity(task),
        event,
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
  await nats.emit(`${TASK_EVENT_PREFIX}.${task.id}.event`, buildTaskEventPayload(task, event));
}

export function buildTaskDispatchPrompt(task: TaskRecord, agentId: string, sessionName: string): string {
  return `[System] Execute: Você assumiu a task ${task.id} no Ravi.

Título: ${task.title}
Prioridade: ${task.priority}
Sessão de trabalho: ${sessionName}
Agent responsável: ${agentId}

Objetivo:
${task.instructions}

Flow obrigatório:
1. Comece reportando progresso:
   ravi tasks report ${task.id} --progress 5 --message "assumi a task e comecei a investigar"
2. Sempre que avançar de verdade:
   ravi tasks report ${task.id} --progress <0-100> --message "<o que mudou>"
3. Se travar:
   ravi tasks block ${task.id} --reason "<bloqueio concreto>"
4. Se der erro terminal:
   ravi tasks fail ${task.id} --reason "<falha concreta>"
5. Quando concluir:
   ravi tasks done ${task.id} --summary "<o que foi entregue>"

Regras:
- trabalhe nesta sessão até concluir ou bloquear
- não responda descrevendo o protocolo
- use o CLI de tasks para atualizar o estado real da task
- progresso é binário e operacional, não narrativo`;
}

export function createTask(input: CreateTaskInput): { task: TaskRecord; event: TaskEvent } {
  return dbCreateTask(input);
}

export function listTasks(options: ListTasksOptions = {}): TaskRecord[] {
  return dbListTasks(options);
}

export function getTaskDetails(taskId: string): {
  task: TaskRecord | null;
  activeAssignment: ReturnType<typeof dbGetActiveAssignment>;
  assignments: ReturnType<typeof dbListAssignments>;
  events: ReturnType<typeof dbListTaskEvents>;
} {
  return {
    task: dbGetTask(taskId),
    activeAssignment: dbGetActiveAssignment(taskId),
    assignments: dbListAssignments(taskId),
    events: dbListTaskEvents(taskId, 200),
  };
}

export async function dispatchTask(
  taskId: string,
  input: DispatchTaskInput,
): Promise<{
  task: TaskRecord;
  event: TaskEvent;
  sessionName: string;
}> {
  const config = loadRouterConfig();
  const agent = config.agents[input.agentId];
  if (!agent) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }

  const agentCwd = expandHome(agent.cwd);
  const existingSession = resolveSession(input.sessionName);
  if (existingSession && existingSession.agentId !== input.agentId) {
    throw new Error(
      `Session ${input.sessionName} already belongs to agent ${existingSession.agentId}, not ${input.agentId}.`,
    );
  }

  const session =
    existingSession ?? getOrCreateSession(input.sessionName, input.agentId, agentCwd, { name: input.sessionName });
  const sessionName = session.name ?? input.sessionName;

  const { task, event } = dbDispatchTask(taskId, {
    ...input,
    sessionName,
  });

  const prompt = buildTaskDispatchPrompt(task, input.agentId, sessionName);
  await publishSessionPrompt(sessionName, {
    prompt,
    deliveryBarrier: "after_task",
    taskBarrierTaskId: task.id,
  });

  return { task, event, sessionName };
}

export function reportTaskProgress(taskId: string, input: TaskProgressInput): { task: TaskRecord; event: TaskEvent } {
  return dbReportTaskProgress(taskId, input);
}

export function blockTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  return dbBlockTask(taskId, input);
}

export function failTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  return dbFailTask(taskId, input);
}

export function completeTask(taskId: string, input: TaskTerminalInput): { task: TaskRecord; event: TaskEvent } {
  return dbCompleteTask(taskId, input);
}

import { beforeEach, describe, expect, it, mock } from "bun:test";

const createCalls: Array<Record<string, unknown>> = [];
const dispatchCalls: Array<Record<string, unknown>> = [];
const emittedEvents: Array<{ taskId: string; type: string }> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    subscribe: mock(async function* () {}),
    emit: mock(async () => {}),
    close: mock(async () => {}),
  },
}));

mock.module("../../utils/logger.js", () => ({
  logger: {
    setLevel: mock(() => {}),
  },
}));

mock.module("../../tasks/index.js", () => ({
  completeTask: () => {
    throw new Error("not used in tasks.create tests");
  },
  createTask: (input: Record<string, unknown>) => {
    createCalls.push(input);
    return {
      task: {
        id: "task-cli-1",
        title: input.title,
        instructions: input.instructions,
        status: "open",
        priority: input.priority ?? "normal",
        progress: 0,
        createdBy: input.createdBy,
        createdByAgentId: input.createdByAgentId,
        createdBySessionName: input.createdBySessionName,
        worktree: input.worktree,
        createdAt: 1,
        updatedAt: 1,
      },
      event: {
        id: 1,
        taskId: "task-cli-1",
        type: "task.created",
        createdAt: 1,
      },
    };
  },
  createTaskWorktreeConfig: (input: { mode?: string; path?: string; branch?: string }) => {
    if (!input.mode && !input.path && !input.branch) return undefined;
    const mode = input.mode ?? (input.path || input.branch ? "path" : "inherit");
    if (mode === "inherit") return { mode: "inherit" };
    if (!input.path) throw new Error("worktree path is required when worktree mode is 'path'.");
    return {
      mode: "path",
      path: input.path,
      ...(input.branch ? { branch: input.branch } : {}),
    };
  },
  dispatchTask: async (taskId: string, input: Record<string, unknown>) => {
    dispatchCalls.push({ taskId, ...input });
    return {
      task: {
        id: taskId,
        title: "task",
        instructions: "instructions",
        status: "dispatched",
        priority: "high",
        progress: 0,
        assigneeAgentId: input.agentId,
        assigneeSessionName: input.sessionName,
        worktree: input.worktree,
        createdAt: 1,
        updatedAt: 2,
        dispatchedAt: 2,
      },
      event: {
        id: 2,
        taskId,
        type: "task.dispatched",
        createdAt: 2,
      },
      sessionName: input.sessionName,
    };
  },
  emitTaskEvent: async (task: { id: string }, event: { type: string }) => {
    emittedEvents.push({ taskId: task.id, type: event.type });
  },
  formatTaskWorktree: (worktree?: { mode?: string; path?: string; branch?: string } | null) =>
    worktree?.path ? `${worktree.path}${worktree.branch ? ` (branch ${worktree.branch})` : ""}` : "agent default cwd",
  getDefaultTaskSessionName: (taskId: string) => `${taskId}-work`,
  getTaskActor: () => ({ actor: "dev-session", agentId: "dev", sessionName: "dev-session" }),
  getTaskDetails: () => {
    throw new Error("not used in tasks.create tests");
  },
  listTasks: () => [],
  reportTaskProgress: () => {
    throw new Error("not used in tasks.create tests");
  },
  blockTask: () => {
    throw new Error("not used in tasks.create tests");
  },
  failTask: () => {
    throw new Error("not used in tasks.create tests");
  },
}));

const { TaskCommands } = await import("./tasks.js");

describe("TaskCommands create", () => {
  beforeEach(() => {
    createCalls.length = 0;
    dispatchCalls.length = 0;
    emittedEvents.length = 0;
  });

  it("keeps the legacy create path open when no assignee is provided", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "Open task",
        "do the thing",
        "high",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      title: "Open task",
      instructions: "do the thing",
      priority: "high",
      createdBy: "dev-session",
      createdByAgentId: "dev",
      createdBySessionName: "dev-session",
    });
    expect(dispatchCalls).toHaveLength(0);
    expect(emittedEvents.map((event) => event.type)).toEqual(["task.created"]);
  });

  it("auto-dispatches create when an assignee and worktree are provided", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "Auto dispatch task",
        "ship it",
        "high",
        "dev",
        undefined,
        "task-cli-work",
        undefined,
        "../feature-worktree",
        "feature/task-runtime",
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      createdBy: "dev-session",
      createdByAgentId: "dev",
      createdBySessionName: "dev-session",
    });
    expect(createCalls[0]?.worktree).toEqual({
      mode: "path",
      path: "../feature-worktree",
      branch: "feature/task-runtime",
    });
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      agentId: "dev",
      sessionName: "task-cli-work",
      assignedBy: "dev-session",
      worktree: {
        mode: "path",
        path: "../feature-worktree",
        branch: "feature/task-runtime",
      },
    });
    expect(emittedEvents.map((event) => event.type)).toEqual(["task.created", "task.dispatched"]);
  });
});

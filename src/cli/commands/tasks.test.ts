import { beforeEach, describe, expect, it, mock } from "bun:test";

const createCalls: Array<Record<string, unknown>> = [];
const dispatchCalls: Array<Record<string, unknown>> = [];
const reportCalls: Array<Record<string, unknown>> = [];
const doneCalls: Array<Record<string, unknown>> = [];
const blockCalls: Array<Record<string, unknown>> = [];
const failCalls: Array<Record<string, unknown>> = [];
const emittedEvents: Array<{ taskId: string; type: string }> = [];
let taskDetailsMock: Record<string, unknown> = {
  task: {
    id: "task-cli-1",
    title: "task",
    instructions: "instructions",
    status: "in_progress",
    priority: "high",
    progress: 45,
    parentTaskId: "task-parent-1",
    taskDir: "/tmp/ravi/tasks/task-cli-1",
    createdAt: 1,
    updatedAt: 2,
  },
  parentTask: {
    id: "task-parent-1",
    title: "parent",
    instructions: "parent instructions",
    status: "blocked",
    priority: "high",
    progress: 55,
    assigneeAgentId: "lead",
    assigneeSessionName: "task-parent-1-work",
    taskDir: "/tmp/ravi/tasks/task-parent-1",
    createdAt: 1,
    updatedAt: 2,
  },
  childTasks: [
    {
      id: "task-child-1",
      title: "child",
      instructions: "child instructions",
      status: "done",
      priority: "normal",
      progress: 100,
      assigneeAgentId: "dev",
      assigneeSessionName: "task-child-1-work",
      taskDir: "/tmp/ravi/tasks/task-child-1",
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  activeAssignment: null,
  assignments: [],
  events: [],
};
let frontmatterMock: Record<string, unknown> = {};

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
        parentTaskId: input.parentTaskId,
        createdBy: input.createdBy,
        createdByAgentId: input.createdByAgentId,
        createdBySessionName: input.createdBySessionName,
        worktree: input.worktree,
        taskDir: "/tmp/ravi/tasks/task-cli-1",
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
  getTaskDocPath: (task: { taskDir?: string; id: string }) => `${task.taskDir ?? "/tmp/ravi/tasks/task-cli-1"}/TASK.md`,
  getTaskActor: () => ({ actor: "dev-session", agentId: "dev", sessionName: "dev-session" }),
  getTaskDetails: () => taskDetailsMock,
  listTasks: () => [],
  readTaskDocFrontmatter: () => frontmatterMock,
  reportTaskProgress: (taskId: string, input: Record<string, unknown>) => {
    reportCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        status: "in_progress",
        progress: input.progress ?? 45,
      },
      event: { id: 3, taskId, type: "task.progress", createdAt: 3 },
    };
  },
  blockTask: (taskId: string, input: Record<string, unknown>) => {
    blockCalls.push({ taskId, ...input });
    return {
      task: { ...(taskDetailsMock.task as Record<string, unknown>), status: "blocked", blockerReason: input.message },
      event: { id: 4, taskId, type: "task.blocked", createdAt: 4 },
    };
  },
  failTask: (taskId: string, input: Record<string, unknown>) => {
    failCalls.push({ taskId, ...input });
    return {
      task: { ...(taskDetailsMock.task as Record<string, unknown>), status: "failed", summary: input.message },
      event: { id: 5, taskId, type: "task.failed", createdAt: 5 },
    };
  },
  completeTask: (taskId: string, input: Record<string, unknown>) => {
    doneCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        status: "done",
        progress: 100,
        summary: input.message,
      },
      event: { id: 6, taskId, type: "task.done", createdAt: 6 },
    };
  },
}));

const { TaskCommands } = await import("./tasks.js");

describe("TaskCommands create", () => {
  beforeEach(() => {
    createCalls.length = 0;
    dispatchCalls.length = 0;
    reportCalls.length = 0;
    doneCalls.length = 0;
    blockCalls.length = 0;
    failCalls.length = 0;
    emittedEvents.length = 0;
    taskDetailsMock = {
      task: {
        id: "task-cli-1",
        title: "task",
        instructions: "instructions",
        status: "in_progress",
        priority: "high",
        progress: 45,
        parentTaskId: "task-parent-1",
        taskDir: "/tmp/ravi/tasks/task-cli-1",
        createdAt: 1,
        updatedAt: 2,
      },
      parentTask: {
        id: "task-parent-1",
        title: "parent",
        instructions: "parent instructions",
        status: "blocked",
        priority: "high",
        progress: 55,
        assigneeAgentId: "lead",
        assigneeSessionName: "task-parent-1-work",
        taskDir: "/tmp/ravi/tasks/task-parent-1",
        createdAt: 1,
        updatedAt: 2,
      },
      childTasks: [
        {
          id: "task-child-1",
          title: "child",
          instructions: "child instructions",
          status: "done",
          priority: "normal",
          progress: 100,
          assigneeAgentId: "dev",
          assigneeSessionName: "task-child-1-work",
          taskDir: "/tmp/ravi/tasks/task-child-1",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      activeAssignment: null,
      assignments: [],
      events: [],
    };
    frontmatterMock = {};
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
        undefined,
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

  it("passes parent lineage through create", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "Child task",
        "do child work",
        "normal",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "task-parent-1",
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      title: "Child task",
      parentTaskId: "task-parent-1",
    });
  });

  it("reads progress from TASK.md frontmatter when report is called without flags", async () => {
    frontmatterMock = { progress: 72 };
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.report("task-cli-1", undefined, undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
      progress: 72,
    });
  });

  it("reads summary from TASK.md frontmatter when done is called without flags", async () => {
    frontmatterMock = { summary: "entregue pelo markdown" };
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.done("task-cli-1", undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      message: "entregue pelo markdown",
    });
  });

  it("reads blocker_reason from TASK.md frontmatter when block is called without flags", async () => {
    frontmatterMock = { blockerReason: "dependendo de decisão externa" };
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.block("task-cli-1", undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      message: "dependendo de decisão externa",
    });
  });

  it("shows task document and lineage metadata in JSON output", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.show("task-cli-1", true);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.taskDocument).toEqual({
      taskDir: "/tmp/ravi/tasks/task-cli-1",
      path: "/tmp/ravi/tasks/task-cli-1/TASK.md",
      frontmatter: {},
    });
    expect(payload.parentTask).toEqual({
      id: "task-parent-1",
      title: "parent",
      status: "blocked",
      progress: 55,
      assigneeAgentId: "lead",
      assigneeSessionName: "task-parent-1-work",
      taskDir: "/tmp/ravi/tasks/task-parent-1",
      path: "/tmp/ravi/tasks/task-parent-1/TASK.md",
    });
    expect(payload.childTasks).toEqual([
      {
        id: "task-child-1",
        title: "child",
        status: "done",
        progress: 100,
        assigneeAgentId: "dev",
        assigneeSessionName: "task-child-1-work",
        taskDir: "/tmp/ravi/tasks/task-child-1",
        path: "/tmp/ravi/tasks/task-child-1/TASK.md",
      },
    ]);
  });
});

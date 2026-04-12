import { beforeEach, describe, expect, it, mock } from "bun:test";

const createCalls: Array<Record<string, unknown>> = [];
const dispatchCalls: Array<Record<string, unknown>> = [];
const reportCalls: Array<Record<string, unknown>> = [];
const commentCalls: Array<Record<string, unknown>> = [];
const archiveCalls: Array<Record<string, unknown>> = [];
const unarchiveCalls: Array<Record<string, unknown>> = [];
const doneCalls: Array<Record<string, unknown>> = [];
const blockCalls: Array<Record<string, unknown>> = [];
const failCalls: Array<Record<string, unknown>> = [];
const listTasksCalls: Array<Record<string, unknown>> = [];
const validatedAgentIds: string[] = [];
const emittedEvents: Array<{ taskId: string; type: string }> = [];
let subscribeImpl: (pattern?: string) => AsyncGenerator<{ data: Record<string, unknown> }> = async function* () {};
let dispatchResultExtra: Record<string, unknown> = {};
let blockResultExtra: Record<string, unknown> = {};
let doneResultExtra: Record<string, unknown> = {};

function buildMockResolvedProfile(profileId?: string | null): Record<string, unknown> {
  const normalizedId = profileId ?? "default";
  const taskDocumentUsage =
    normalizedId === "brainstorm" || normalizedId === "task-doc-none"
      ? "none"
      : normalizedId === "task-doc-optional"
        ? "optional"
        : "required";

  return {
    id: normalizedId,
    version: "1",
    requestedId: normalizedId,
    resolvedFromFallback: false,
    label:
      normalizedId === "brainstorm"
        ? "Brainstorm"
        : normalizedId === "task-doc-none"
          ? "Runtime Only"
          : normalizedId === "task-doc-optional"
            ? "Task Doc Optional"
            : "Default",
    description:
      normalizedId === "brainstorm"
        ? "Routes dispatch/resume through the brainstorm skill and its DRAFT.md artifact."
        : normalizedId === "task-doc-none"
          ? "Operates directly on the runtime substrate without TASK.md materialization."
          : normalizedId === "task-doc-optional"
            ? "Keeps a canonical task directory but does not materialize TASK.md automatically."
            : "Canonical doc-first profile with TASK.md as the primary artifact.",
    sessionNameTemplate: "<task-id>-work",
    workspaceBootstrap: {
      mode: "inherit",
      ensureTaskDir: taskDocumentUsage !== "none",
    },
    sync: {
      artifactFirst: normalizedId === "default",
      ...(taskDocumentUsage !== "none" ? { taskDocument: { mode: taskDocumentUsage } } : {}),
    },
    rendererHints: {
      label:
        normalizedId === "brainstorm"
          ? "Brainstorm draft"
          : normalizedId === "task-doc-none"
            ? "Runtime only"
            : normalizedId === "task-doc-optional"
              ? "TASK.md optional"
              : "TASK.md first",
      showTaskDoc: taskDocumentUsage !== "none",
      showWorkspace: true,
    },
    defaultTags:
      normalizedId === "brainstorm"
        ? ["task.profile.brainstorm", "task.skill.brainstorm", "task.artifact.brainstorm-draft"]
        : normalizedId === "task-doc-none"
          ? ["task.profile.task-doc-none", "task.doc.none"]
          : normalizedId === "task-doc-optional"
            ? ["task.profile.task-doc-optional", "task.doc.optional"]
            : ["task.profile.default", "task.doc.required", "task.sync.task-doc-first"],
    inputs: [],
    completion: {
      summaryRequired: true,
      summaryLabel: "Resumo",
    },
    progress:
      normalizedId === "brainstorm"
        ? {
            requireMessage: true,
            notes: "Sincronize progresso via runtime e mantenha o draft atualizado.",
          }
        : normalizedId === "default"
          ? {
              requireMessage: true,
              notes: "Use frontmatter.progress_note ou --message.",
            }
          : {
              requireMessage: true,
            },
    templates: {
      dispatch: "dispatch {{task.id}}",
      resume: "resume {{task.id}}",
      dispatchSummary: "summary {{task.id}}",
      dispatchEventMessage: "event {{task.id}}",
    },
    sourceKind: "system",
    source: `system:${normalizedId}`,
    manifestPath: null,
  };
}

let taskDetailsMock: Record<string, unknown> = {
  task: {
    id: "task-cli-1",
    title: "task",
    instructions: "instructions",
    status: "in_progress",
    priority: "high",
    progress: 45,
    profileId: "default",
    checkpointIntervalMs: 300000,
    reportToSessionName: "dev-session",
    reportEvents: ["done"],
    parentTaskId: "task-parent-1",
    assigneeAgentId: "dev",
    assigneeSessionName: "task-cli-1-work",
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
  taskProfile: buildMockResolvedProfile("default"),
  activeAssignment: null,
  assignments: [],
  events: [],
  comments: [],
};
let frontmatterMock: Record<string, unknown> = {};
let taskListMock: Array<Record<string, unknown>> = [];

function buildMockTaskArtifacts(task: Record<string, unknown>) {
  if (task.profileId === "brainstorm") {
    return {
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      workspaceRoot: "/tmp/brainstorm-root",
      primary: {
        kind: "brainstorm-draft",
        role: "primary",
        label: "Brainstorm draft",
        exists: false,
        path: {
          absolutePath: "/tmp/brainstorm-root/.genie/brainstorms/task/DRAFT.md",
          workspaceRelativePath: ".genie/brainstorms/task/DRAFT.md",
          displayPath: ".genie/brainstorms/task/DRAFT.md",
        },
      },
      items: [
        {
          kind: "brainstorm-draft",
          role: "primary",
          label: "Brainstorm draft",
          exists: false,
          path: {
            absolutePath: "/tmp/brainstorm-root/.genie/brainstorms/task/DRAFT.md",
            workspaceRelativePath: ".genie/brainstorms/task/DRAFT.md",
            displayPath: ".genie/brainstorms/task/DRAFT.md",
          },
        },
        {
          kind: "brainstorm-design",
          role: "supporting",
          label: "Brainstorm design",
          exists: false,
          path: {
            absolutePath: "/tmp/brainstorm-root/.genie/brainstorms/task/DESIGN.md",
            workspaceRelativePath: ".genie/brainstorms/task/DESIGN.md",
            displayPath: ".genie/brainstorms/task/DESIGN.md",
          },
        },
      ],
    };
  }

  if (typeof task.taskDir === "string") {
    return {
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      workspaceRoot: null,
      primary: {
        kind: "task-doc",
        role: "primary",
        label: "TASK.md",
        exists: true,
        path: {
          absolutePath: `${task.taskDir}/TASK.md`,
          workspaceRelativePath: null,
          displayPath: `${task.taskDir}/TASK.md`,
        },
      },
      items: [
        {
          kind: "task-doc",
          role: "primary",
          label: "TASK.md",
          exists: true,
          path: {
            absolutePath: `${task.taskDir}/TASK.md`,
            workspaceRelativePath: null,
            displayPath: `${task.taskDir}/TASK.md`,
          },
        },
      ],
    };
  }

  return {
    status: "planned",
    supportedKinds: ["file", "url", "text"],
    workspaceRoot: null,
    primary: null,
    items: [],
  };
}

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
  getNats: mock(() => ({})),
  nats: {
    subscribe: mock((pattern?: string) => subscribeImpl(pattern)),
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
  TASK_REPORT_EVENTS: ["blocked", "done", "failed"],
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
        profileId: input.profileId ?? "default",
        checkpointIntervalMs: input.checkpointIntervalMs ?? 300000,
        reportToSessionName: input.reportToSessionName ?? input.createdBySessionName ?? null,
        reportEvents: input.reportEvents ?? ["done"],
        profileInput: input.profileInput,
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
        profileId: (taskDetailsMock.task as Record<string, unknown>).profileId ?? "default",
        checkpointIntervalMs: 300000,
        reportToSessionName: input.reportToSessionName ?? "dev-session",
        reportEvents: input.reportEvents ?? ["done"],
        assigneeAgentId: input.agentId,
        assigneeSessionName: input.sessionName,
        worktree: input.worktree,
        createdAt: 1,
        updatedAt: 2,
        dispatchedAt: 2,
      },
      assignment: {
        id: "asg-cli-1",
        taskId,
        agentId: input.agentId,
        sessionName: input.sessionName,
        checkpointIntervalMs: input.checkpointIntervalMs ?? 300000,
        reportToSessionName: input.reportToSessionName ?? "dev-session",
        reportEvents: input.reportEvents ?? ["done"],
        checkpointDueAt: 300002,
        checkpointOverdueCount: 0,
        status: "assigned",
        assignedAt: 2,
      },
      event: {
        id: 2,
        taskId,
        type: "task.dispatched",
        createdAt: 2,
      },
      sessionName: input.sessionName,
      ...dispatchResultExtra,
    };
  },
  emitTaskEvent: async (task: { id: string }, event: { type: string }) => {
    emittedEvents.push({ taskId: task.id, type: event.type });
  },
  formatTaskWorktree: (worktree?: { mode?: string; path?: string; branch?: string } | null) =>
    worktree?.path ? `${worktree.path}${worktree.branch ? ` (branch ${worktree.branch})` : ""}` : "agent default cwd",
  buildTaskSessionLink: (task: { id: string; assigneeSessionName?: string | null }) =>
    task.assigneeSessionName
      ? {
          alias: task.id,
          sessionName: task.assigneeSessionName,
          readCommand: `ravi sessions read ${task.assigneeSessionName}`,
          debugCommand: `ravi sessions debug ${task.assigneeSessionName}`,
          toolTopic: `ravi.session.${task.assigneeSessionName}.tool`,
        }
      : null,
  getDefaultTaskSessionName: (taskId: string) => `${taskId}-work`,
  getDefaultTaskSessionNameForTask: (task: { id: string }) => `${task.id}-work`,
  buildTaskArtifactSummary: (task: Record<string, unknown>) => buildMockTaskArtifacts(task),
  getTaskDocPath: (task: { taskDir?: string; id: string }) => `${task.taskDir ?? "/tmp/ravi/tasks/task-cli-1"}/TASK.md`,
  getTaskActor: () => ({ actor: "dev-session", agentId: "dev", sessionName: "dev-session" }),
  getTaskDetails: () => taskDetailsMock,
  resolveTaskProfile: (profileId?: string | null) => buildMockResolvedProfile(profileId),
  resolveTaskProfileForTask: (task: { profileId?: string | null }) => buildMockResolvedProfile(task.profileId),
  listTasks: (input: Record<string, unknown>) => {
    listTasksCalls.push(input);
    return taskListMock;
  },
  normalizeTaskProgressMessage: (value?: string | null) => {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    const contentLength = (normalized.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/g) ?? []).length;
    const letterCount = (normalized.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) ?? []).length;
    if (contentLength < 5 || letterCount < 3) return undefined;
    if (
      ["wip", "progress", "update", "updating", "working", "todo", "tbd", "na", "n/a", "ok"].includes(
        normalized.toLowerCase(),
      )
    ) {
      return undefined;
    }
    return normalized;
  },
  requireTaskRuntimeAgent: (agentId: string) => {
    validatedAgentIds.push(agentId);
    if (agentId === "ghost") {
      throw new Error("Agent not found in runtime config: ghost");
    }
    return {
      id: agentId,
      cwd: `/tmp/agents/${agentId}`,
    };
  },
  readTaskDocFrontmatter: () => frontmatterMock,
  taskProfileUsesArtifactFirstSync: (profile: { sync?: { artifactFirst?: boolean } }) =>
    Boolean(profile?.sync?.artifactFirst),
  taskProfileUsesTaskDocument: (profile: { sync?: { taskDocument?: unknown } }) => Boolean(profile?.sync?.taskDocument),
  taskDocExists: () => true,
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
  commentTask: async (taskId: string, input: Record<string, unknown>) => {
    commentCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        updatedAt: 7,
      },
      comment: {
        id: "cmt-1",
        taskId,
        author: input.author,
        authorAgentId: input.authorAgentId,
        authorSessionName: input.authorSessionName,
        body: input.body,
        createdAt: 7,
      },
      event: {
        id: 7,
        taskId,
        type: "task.comment",
        createdAt: 7,
        message: String(input.body),
      },
      steeredSessionName: "task-cli-1-work",
    };
  },
  archiveTask: (taskId: string, input: Record<string, unknown>) => {
    archiveCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        archivedAt: 8,
        archivedBy: input.actor,
        archiveReason: input.reason,
      },
      event: { id: 8, taskId, type: "task.archived", createdAt: 8, message: input.reason },
    };
  },
  unarchiveTask: (taskId: string, input: Record<string, unknown>) => {
    unarchiveCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        archivedAt: undefined,
        archivedBy: undefined,
        archiveReason: undefined,
      },
      event: { id: 9, taskId, type: "task.unarchived", createdAt: 9, message: "restored visibility" },
    };
  },
  blockTask: (taskId: string, input: Record<string, unknown>) => {
    blockCalls.push({ taskId, ...input });
    return {
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        status: "blocked",
        progress: input.progress ?? (taskDetailsMock.task as Record<string, unknown>).progress,
        blockerReason: input.message,
      },
      event: { id: 4, taskId, type: "task.blocked", createdAt: 4, progress: input.progress as number | undefined },
      ...blockResultExtra,
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
      ...doneResultExtra,
    };
  },
}));

const { TaskCommands } = await import("./tasks.js");

describe("TaskCommands create", () => {
  beforeEach(() => {
    createCalls.length = 0;
    dispatchCalls.length = 0;
    reportCalls.length = 0;
    commentCalls.length = 0;
    archiveCalls.length = 0;
    unarchiveCalls.length = 0;
    doneCalls.length = 0;
    blockCalls.length = 0;
    failCalls.length = 0;
    listTasksCalls.length = 0;
    validatedAgentIds.length = 0;
    emittedEvents.length = 0;
    subscribeImpl = async function* () {};
    dispatchResultExtra = {};
    blockResultExtra = {};
    doneResultExtra = {};
    taskDetailsMock = {
      task: {
        id: "task-cli-1",
        title: "task",
        instructions: "instructions",
        status: "in_progress",
        priority: "high",
        progress: 45,
        profileId: "default",
        checkpointIntervalMs: 300000,
        parentTaskId: "task-parent-1",
        assigneeAgentId: "dev",
        assigneeSessionName: "task-cli-1-work",
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
      taskProfile: buildMockResolvedProfile("default"),
      activeAssignment: null,
      assignments: [],
      events: [],
      comments: [],
    };
    frontmatterMock = {};
    taskListMock = [];
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

  it("fails create before task creation when the assignee agent is missing", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await expect(
        commands.create(
          "Invalid assignee task",
          "do the thing",
          "high",
          undefined,
          "ghost",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toThrow("Agent not found in runtime config: ghost");
    } finally {
      console.log = originalLog;
    }

    expect(validatedAgentIds).toEqual(["ghost"]);
    expect(createCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
    expect(emittedEvents).toEqual([]);
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
        undefined,
        "dev",
        undefined,
        "task-cli-work",
        undefined,
        "../feature-worktree",
        "feature/task-runtime",
        undefined,
        "10m",
        "lead-session",
        "blocked,done",
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
      checkpointIntervalMs: 600000,
      reportToSessionName: "lead-session",
      reportEvents: ["blocked", "done"],
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
      checkpointIntervalMs: 600000,
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
        undefined,
        "task-parent-1",
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
      title: "Child task",
      parentTaskId: "task-parent-1",
    });
  });

  it("forwards an explicit task profile through create", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "Runtime only task",
        "run from substrate only",
        "normal",
        "task-doc-none",
        undefined,
        undefined,
        undefined,
        undefined,
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
      title: "Runtime only task",
      profileId: "task-doc-none",
    });
  });

  it("pins profile input values on create", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "Input task",
        "use pinned profile inputs",
        "normal",
        "brainstorm",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "flavor=matcha",
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      title: "Input task",
      profileId: "brainstorm",
      profileInput: {
        flavor: "matcha",
      },
    });
  });

  it("forwards explicit report configuration through dispatch", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.dispatch("task-cli-1", "dev", "task-cli-work", "10m", "ops-session", "blocked,failed", true);
    } finally {
      console.log = originalLog;
    }

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      agentId: "dev",
      sessionName: "task-cli-work",
      assignedBy: "dev-session",
      checkpointIntervalMs: 600000,
      reportToSessionName: "ops-session",
      reportEvents: ["blocked", "failed"],
    });
  });

  it("prints the profile-owned primary artifact for brainstorm dispatches", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        profileId: "brainstorm",
        taskDir: undefined,
      },
      taskProfile: buildMockResolvedProfile("brainstorm"),
    };
    dispatchResultExtra = {
      primaryArtifact: {
        kind: "brainstorm-draft",
        label: "Brainstorm draft",
        path: "/tmp/brainstorm-worktree/.genie/brainstorms/task/DRAFT.md",
      },
      dispatchSummary:
        "The target session was instructed to load brainstorm, use the draft artifact as primary state, then sync through:",
    };

    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.dispatch("task-cli-1", "dev");
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("Brainstorm draft:  /tmp/brainstorm-worktree/.genie/brainstorms/task/DRAFT.md");
    expect(logs.join("\n")).toContain(
      "The target session was instructed to load brainstorm, use the draft artifact as primary state, then sync through:",
    );
  });

  it("passes archive filters through list", async () => {
    taskListMock = [
      {
        id: "task-cli-1",
        title: "task",
        status: "done",
        priority: "high",
        progress: 100,
        archivedAt: 8,
        archivedBy: "dev-session",
        archiveReason: "old backlog",
        updatedAt: 8,
      },
    ];

    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        true,
        false,
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(listTasksCalls).toHaveLength(1);
    expect(listTasksCalls[0]).toMatchObject({
      archiveMode: "only",
      limit: 30,
    });

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.archiveMode).toBe("only");
    expect(payload.limit).toBe(30);
    expect(payload.tasks[0]).toMatchObject({
      id: "task-cli-1",
      archivedBy: "dev-session",
      archiveReason: "old backlog",
    });
  });

  it("rejects conflicting archive filters on list", async () => {
    const commands = new TaskCommands();
    expect(() =>
      commands.list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        true,
        true,
        undefined,
        true,
      ),
    ).toThrow("Use either --archived or --all, not both.");
  });

  it("passes profile/text/session/parent filters and the default last limit through list", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.list(
        "in_progress",
        "dev",
        "task-cli-1-work",
        "brainstorm",
        "task-parent-1",
        undefined,
        false,
        "pipeline",
        false,
        false,
        false,
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(listTasksCalls).toHaveLength(1);
    expect(listTasksCalls[0]).toMatchObject({
      status: "in_progress",
      agentId: "dev",
      sessionName: "task-cli-1-work",
      profileId: "brainstorm",
      parentTaskId: "task-parent-1",
      query: "pipeline",
      limit: 30,
      archiveMode: "exclude",
    });

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.limit).toBe(30);
    expect(payload.archiveMode).toBe("exclude");
  });

  it("rejects conflicting parent and root filters on list", () => {
    const commands = new TaskCommands();
    expect(() =>
      commands.list(
        undefined,
        undefined,
        undefined,
        undefined,
        "task-parent-1",
        "task-root-1",
        false,
        undefined,
        false,
        false,
        false,
        undefined,
        true,
      ),
    ).toThrow("Use either --parent or --root, not both.");
  });

  it("reads progress and progress_note from TASK.md frontmatter when report is called without flags", async () => {
    frontmatterMock = { progress: 72, progressNote: "mapeando o fluxo do runtime" };
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
      message: "mapeando o fluxo do runtime",
      progress: 72,
    });
  });

  it("fails when report has no descriptive progress text", async () => {
    frontmatterMock = { progress: 72 };
    const commands = new TaskCommands();

    await expect(commands.report("task-cli-1", undefined, undefined, true)).rejects.toThrow(
      "Update TASK.md frontmatter.progress_note or provide --message with a descriptive progress update.",
    );
    expect(reportCalls).toHaveLength(0);
  });

  it("requires explicit progress text for runtime-only profiles instead of pointing to TASK.md", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        profileId: "task-doc-none",
        taskDir: "/tmp/ravi/tasks/task-cli-1",
      },
      taskProfile: buildMockResolvedProfile("task-doc-none"),
    };
    const commands = new TaskCommands();

    await expect(commands.report("task-cli-1", undefined, undefined, true)).rejects.toThrow(
      "Provide --message with a descriptive progress update.",
    );
    expect(reportCalls).toHaveLength(0);
  });

  it("shows progress_note in task document metadata", async () => {
    frontmatterMock = { progress: 72, progressNote: "mapeando o fluxo do runtime" };
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
    expect(payload.taskProfile).toMatchObject({
      id: "default",
      sync: {
        taskDocument: {
          mode: "required",
        },
      },
    });
    expect(payload.taskDocument.frontmatter).toMatchObject({
      progress: 72,
      progressNote: "mapeando o fluxo do runtime",
    });
  });

  it("limits show history with --last", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      events: [
        { id: 1, taskId: "task-cli-1", type: "task.created", createdAt: 1 },
        { id: 2, taskId: "task-cli-1", type: "task.dispatched", createdAt: 2 },
        { id: 3, taskId: "task-cli-1", type: "task.progress", createdAt: 3 },
      ],
      comments: [
        { id: "cmt-1", taskId: "task-cli-1", body: "primeiro", createdAt: 1 },
        { id: "cmt-2", taskId: "task-cli-1", body: "segundo", createdAt: 2 },
        { id: "cmt-3", taskId: "task-cli-1", body: "terceiro", createdAt: 3 },
      ],
    };
    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.show("task-cli-1", true, "2");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.historyLimit).toBe(2);
    expect(payload.events).toHaveLength(2);
    expect(payload.events.map((event: { id: number }) => event.id)).toEqual([2, 3]);
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments.map((comment: { id: string }) => comment.id)).toEqual(["cmt-2", "cmt-3"]);
  });

  it("adds a comment and emits a task.comment event", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.comment("task-cli-1", "muda a direção da investigação", true);
    } finally {
      console.log = originalLog;
    }

    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      author: "dev-session",
      authorAgentId: "dev",
      authorSessionName: "dev-session",
      body: "muda a direção da investigação",
    });
    expect(emittedEvents).toEqual([{ taskId: "task-cli-1", type: "task.comment" }]);
  });

  it("archives a task without changing its execution status", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.archive("task-cli-1", "tirar da lista default", true);
    } finally {
      console.log = originalLog;
    }

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
      reason: "tirar da lista default",
    });
    expect(emittedEvents).toEqual([{ taskId: "task-cli-1", type: "task.archived" }]);
  });

  it("restores an archived task to the default list", async () => {
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.unarchive("task-cli-1", true);
    } finally {
      console.log = originalLog;
    }

    expect(unarchiveCalls).toHaveLength(1);
    expect(unarchiveCalls[0]).toMatchObject({
      taskId: "task-cli-1",
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
    });
    expect(emittedEvents).toEqual([{ taskId: "task-cli-1", type: "task.unarchived" }]);
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

  it("requires explicit summary for runtime-only profiles instead of pointing to TASK.md", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        profileId: "task-doc-none",
        taskDir: "/tmp/ravi/tasks/task-cli-1",
      },
      taskProfile: buildMockResolvedProfile("task-doc-none"),
    };
    const commands = new TaskCommands();

    await expect(commands.done("task-cli-1", undefined, true)).rejects.toThrow("Provide --summary (Resumo).");
    expect(doneCalls).toHaveLength(0);
  });

  it("reads blocker_reason and progress from TASK.md frontmatter when block is called without flags", async () => {
    frontmatterMock = { blockerReason: "dependendo de decisão externa", progress: 90 };
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
      progress: 90,
    });
  });

  it("emits related parent callback events returned by blockTask", async () => {
    blockResultExtra = {
      relatedEvents: [
        {
          task: { id: "task-parent-1" },
          event: { id: 7, taskId: "task-parent-1", type: "task.child.blocked", createdAt: 7 },
        },
      ],
    };
    frontmatterMock = { blockerReason: "dependendo de decisão externa", progress: 90 };

    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.block("task-cli-1", undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(emittedEvents).toEqual([
      { taskId: "task-cli-1", type: "task.blocked" },
      { taskId: "task-parent-1", type: "task.child.blocked" },
    ]);
  });

  it("does not re-emit task.done when completion is a noop duplicate", async () => {
    doneResultExtra = { wasNoop: true };
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
    expect(emittedEvents).toEqual([]);
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
      exists: true,
      taskDir: "/tmp/ravi/tasks/task-cli-1",
      path: "/tmp/ravi/tasks/task-cli-1/TASK.md",
      frontmatter: {},
    });
    expect(payload.taskArtifacts).toEqual({
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      workspaceRoot: null,
      primary: {
        kind: "task-doc",
        role: "primary",
        label: "TASK.md",
        exists: true,
        path: {
          absolutePath: "/tmp/ravi/tasks/task-cli-1/TASK.md",
          workspaceRelativePath: null,
          displayPath: "/tmp/ravi/tasks/task-cli-1/TASK.md",
        },
      },
      items: [
        {
          kind: "task-doc",
          role: "primary",
          label: "TASK.md",
          exists: true,
          path: {
            absolutePath: "/tmp/ravi/tasks/task-cli-1/TASK.md",
            workspaceRelativePath: null,
            displayPath: "/tmp/ravi/tasks/task-cli-1/TASK.md",
          },
        },
      ],
    });
    expect(payload.primaryArtifact).toEqual(payload.taskArtifacts.primary);
    expect(payload.taskProfile).toEqual(buildMockResolvedProfile("default"));
    expect(payload.taskSession).toEqual({
      alias: "task-cli-1",
      sessionName: "task-cli-1-work",
      readCommand: "ravi sessions read task-cli-1-work",
      debugCommand: "ravi sessions debug task-cli-1-work",
      toolTopic: "ravi.session.task-cli-1-work.tool",
    });
    expect(payload.parentTask).toEqual({
      id: "task-parent-1",
      title: "parent",
      status: "blocked",
      progress: 55,
      profileId: "default",
      assigneeAgentId: "lead",
      assigneeSessionName: "task-parent-1-work",
      workSessionName: "task-parent-1-work",
      taskDir: "/tmp/ravi/tasks/task-parent-1",
      primaryArtifact: {
        kind: "task-doc",
        role: "primary",
        label: "TASK.md",
        exists: true,
        path: {
          absolutePath: "/tmp/ravi/tasks/task-parent-1/TASK.md",
          workspaceRelativePath: null,
          displayPath: "/tmp/ravi/tasks/task-parent-1/TASK.md",
        },
      },
    });
    expect(payload.childTasks).toEqual([
      {
        id: "task-child-1",
        title: "child",
        status: "done",
        progress: 100,
        profileId: "default",
        assigneeAgentId: "dev",
        assigneeSessionName: "task-child-1-work",
        workSessionName: "task-child-1-work",
        taskDir: "/tmp/ravi/tasks/task-child-1",
        primaryArtifact: {
          kind: "task-doc",
          role: "primary",
          label: "TASK.md",
          exists: true,
          path: {
            absolutePath: "/tmp/ravi/tasks/task-child-1/TASK.md",
            workspaceRelativePath: null,
            displayPath: "/tmp/ravi/tasks/task-child-1/TASK.md",
          },
        },
      },
    ]);
    expect(payload.comments).toEqual([]);
  });

  it("shows brainstorm artifact metadata in JSON output", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        profileId: "brainstorm",
        taskDir: undefined,
      },
      taskProfile: buildMockResolvedProfile("brainstorm"),
    };

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
    expect(payload.taskDocument).toBeNull();
    expect(payload.primaryArtifact).toEqual({
      kind: "brainstorm-draft",
      role: "primary",
      label: "Brainstorm draft",
      exists: false,
      path: {
        absolutePath: "/tmp/brainstorm-root/.genie/brainstorms/task/DRAFT.md",
        workspaceRelativePath: ".genie/brainstorms/task/DRAFT.md",
        displayPath: ".genie/brainstorms/task/DRAFT.md",
      },
    });
    expect(payload.taskArtifacts.items).toContainEqual(
      expect.objectContaining({
        kind: "brainstorm-design",
        role: "supporting",
        label: "Brainstorm design",
      }),
    );
  });

  it("prints profile source, inputs, and artifact-aware next steps in text output", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        status: "open",
        profileId: "brainstorm",
        profileInput: {
          flavor: "matcha",
        },
        taskDir: undefined,
      },
      taskProfile: buildMockResolvedProfile("brainstorm"),
    };

    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.show("task-cli-1");
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Profile:     brainstorm@1");
    expect(output).toContain("Profile src: system :: system:brainstorm");
    expect(output).toContain("Profile in: flavor=matcha");
    expect(output).toContain("Task profile:");
    expect(output).toContain("Version:    1");
    expect(output).toContain("Source:     system :: system:brainstorm");
    expect(output).toContain("Inputs:     flavor=matcha");
    expect(output).toContain("Primary:    Brainstorm draft");
    expect(output).toContain("2. trabalhar no artefato primário do profile (Brainstorm draft)");
    expect(output).not.toContain("refinar o TASK.md via brainstorm/edicao antes de subir");
  });

  it("prints brainstorm artifact hints in watch output", async () => {
    taskDetailsMock = {
      ...taskDetailsMock,
      task: {
        ...(taskDetailsMock.task as Record<string, unknown>),
        profileId: "brainstorm",
        taskDir: undefined,
      },
      taskProfile: buildMockResolvedProfile("brainstorm"),
      events: [],
    };
    subscribeImpl = async function* () {
      yield {
        data: {
          taskId: "task-cli-1",
          status: "in_progress",
          progress: 45,
          profileId: "brainstorm",
          taskProfile: taskDetailsMock.taskProfile as Record<string, unknown>,
          artifacts: buildMockTaskArtifacts(taskDetailsMock.task as Record<string, unknown>),
          activeAssignment: null,
          event: {
            id: 10,
            taskId: "task-cli-1",
            type: "task.progress",
            createdAt: 10,
            actor: "dev-session",
            message: "refinando o draft",
          },
        },
      };
      process.emit("SIGINT");
    };

    const commands = new TaskCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      await commands.watch("task-cli-1", false);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("profile brainstorm");
    expect(output).toContain("Brainstorm draft .genie/brainstorms/task/DRAFT.md");
  });
});

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actualTasksIndexModule = await import("../../tasks/index.js");

const createWorkflowSpecCalls: Array<Record<string, unknown>> = [];
const startWorkflowRunCalls: Array<Record<string, unknown>> = [];
const releaseWorkflowNodeRunCalls: Array<Record<string, unknown>> = [];
const attachTaskCalls: Array<Record<string, unknown>> = [];
const createTaskCalls: Array<Record<string, unknown>> = [];
const dispatchCalls: Array<Record<string, unknown>> = [];
const deletedTaskIds: string[] = [];
const emittedTaskEvents: Array<{ taskId: string; type: string }> = [];
const workflowRunDetails = {
  run: {
    id: "wf-run-1",
    workflowSpecId: "wf-spec-1",
    title: "Workflow",
    status: "ready",
  },
  spec: {
    id: "wf-spec-1",
    title: "Workflow",
  },
  counts: {
    total: 1,
    done: 0,
    ready: 1,
    awaitingRelease: 0,
    pending: 0,
    running: 0,
    blocked: 0,
    failed: 0,
  },
  nodes: [
    {
      specNodeKey: "build",
      status: "ready",
      kind: "task",
      requirement: "required",
      releaseMode: "auto",
      waitingOnNodeKeys: [],
      currentTask: null,
    },
  ],
};

mock.module("../../workflows/index.js", () => ({
  WorkflowSpecDefinitionSchema: {
    parse: (value: unknown) => value,
  },
  createWorkflowSpec: (input: Record<string, unknown>) => {
    createWorkflowSpecCalls.push(input);
    return {
      id: input.id,
      title: input.title,
      nodes: input.nodes,
      edges: input.edges,
      policy: input.policy,
    };
  },
  getWorkflowSpec: (specId: string) => ({
    id: specId,
    title: "Workflow",
    policy: { completionMode: "all_required" },
    nodes: [],
    edges: [],
  }),
  listWorkflowSpecs: () => [],
  startWorkflowRun: (specId: string, input: Record<string, unknown>) => {
    startWorkflowRunCalls.push({ specId, ...input });
    return workflowRunDetails;
  },
  listWorkflowRuns: () => [],
  getWorkflowRunDetails: () => workflowRunDetails,
  releaseWorkflowNodeRun: (runId: string, nodeKey: string, actor: Record<string, unknown>) => {
    releaseWorkflowNodeRunCalls.push({ runId, nodeKey, ...actor });
    return {
      run: workflowRunDetails.run,
      nodeRun: { specNodeKey: nodeKey, status: "done" },
      details: workflowRunDetails,
    };
  },
  skipWorkflowNodeRun: () => ({
    run: workflowRunDetails.run,
    nodeRun: { specNodeKey: "skip", status: "skipped" },
    details: workflowRunDetails,
  }),
  cancelWorkflowNodeRun: () => ({
    run: workflowRunDetails.run,
    nodeRun: { specNodeKey: "cancel", status: "cancelled" },
    details: workflowRunDetails,
  }),
  archiveWorkflowNodeRun: () => ({
    run: workflowRunDetails.run,
    nodeRun: { specNodeKey: "archive", status: "archived" },
    details: workflowRunDetails,
  }),
  assertCanAttachTaskToWorkflowNodeRun: (_runId: string, nodeKey: string) => {
    if (nodeKey === "gate") {
      throw new Error("Workflow node gate is approval; only task nodes can bind tasks.");
    }
    return { id: `node-${nodeKey}`, specNodeKey: nodeKey };
  },
  attachTaskToWorkflowNodeRun: (runId: string, nodeKey: string, taskId: string) => {
    if (nodeKey === "race") {
      throw new Error("Workflow node race already has current task task-existing.");
    }
    attachTaskCalls.push({ runId, nodeKey, taskId });
    return {
      run: workflowRunDetails.run,
      nodeRun: { specNodeKey: nodeKey, status: "ready" },
      details: workflowRunDetails,
    };
  },
}));

mock.module("../../tasks/index.js", () => ({
  ...actualTasksIndexModule,
  getTaskActor: () => ({
    actor: "cli-user",
    agentId: "main",
    sessionName: "main-session",
  }),
  createTask: async (input: Record<string, unknown>) => {
    createTaskCalls.push(input);
    return {
      task: {
        id: "task-1",
        title: input.title,
      },
      event: {
        type: "task.created",
      },
      relatedEvents: [],
    };
  },
  emitTaskEvent: async (task: { id: string }, event: { type: string }) => {
    emittedTaskEvents.push({ taskId: task.id, type: event.type });
  },
  dbDeleteTask: (taskId: string) => {
    deletedTaskIds.push(taskId);
    return true;
  },
  getDefaultTaskSessionNameForTask: () => "task-1-work",
  getCanonicalTaskDir: (taskId: string) => `/tmp/ravi/tasks/${taskId}`,
  queueOrDispatchTask: async (_taskId: string, input: Record<string, unknown>) => {
    dispatchCalls.push(input);
    return {
      mode: "dispatched",
      task: {
        id: "task-1",
      },
      event: {
        type: "task.dispatched",
      },
      assignment: {
        id: "asg-1",
      },
      sessionName: input.sessionName,
    };
  },
  requireTaskRuntimeAgent: (agentId: string) => ({
    id: agentId,
    cwd: "/tmp/agent",
  }),
}));

mock.module("../context.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { WorkflowRunCommands, WorkflowSpecCommands } = await import("./workflows.js");

afterAll(() => mock.restore());

describe("WorkflowSpecCommands", () => {
  beforeEach(() => {
    createWorkflowSpecCalls.length = 0;
    startWorkflowRunCalls.length = 0;
    releaseWorkflowNodeRunCalls.length = 0;
    attachTaskCalls.length = 0;
    createTaskCalls.length = 0;
    dispatchCalls.length = 0;
    deletedTaskIds.length = 0;
    emittedTaskEvents.length = 0;
  });

  it("creates workflow specs from inline json", () => {
    const commands = new WorkflowSpecCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.create(
        "wf-spec-1",
        JSON.stringify({
          title: "Workflow",
          nodes: [{ key: "build", label: "Build" }],
          edges: [],
          policy: { completionMode: "all_required" },
        }),
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createWorkflowSpecCalls).toEqual([
      expect.objectContaining({
        id: "wf-spec-1",
        title: "Workflow",
        nodes: [{ key: "build", label: "Build" }],
        edges: [],
        createdBy: "cli-user",
      }),
    ]);
  });
});

describe("WorkflowRunCommands", () => {
  beforeEach(() => {
    createWorkflowSpecCalls.length = 0;
    startWorkflowRunCalls.length = 0;
    releaseWorkflowNodeRunCalls.length = 0;
    attachTaskCalls.length = 0;
    createTaskCalls.length = 0;
    dispatchCalls.length = 0;
    deletedTaskIds.length = 0;
    emittedTaskEvents.length = 0;
  });

  it("starts workflow runs with actor metadata", () => {
    const commands = new WorkflowRunCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.start("wf-spec-1", "wf-run-1", true);
    } finally {
      console.log = originalLog;
    }

    expect(startWorkflowRunCalls).toEqual([
      expect.objectContaining({
        specId: "wf-spec-1",
        runId: "wf-run-1",
        createdBy: "cli-user",
        createdByAgentId: "main",
        createdBySessionName: "main-session",
      }),
    ]);
  });

  it("creates and dispatches workflow tasks through the task runtime", async () => {
    const commands = new WorkflowRunCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.taskCreate(
        "wf-run-1",
        "build",
        "Build artifact",
        "Do the work",
        "high",
        "default",
        "dev",
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createTaskCalls).toEqual([
      expect.objectContaining({
        title: "Build artifact",
        instructions: "Do the work",
        priority: "high",
        profileId: "default",
        createdBy: "cli-user",
      }),
    ]);
    expect(attachTaskCalls).toEqual([{ runId: "wf-run-1", nodeKey: "build", taskId: "task-1" }]);
    expect(dispatchCalls).toEqual([
      expect.objectContaining({
        agentId: "dev",
        sessionName: "task-1-work",
        assignedBy: "cli-user",
      }),
    ]);
    expect(emittedTaskEvents).toEqual([
      { taskId: "task-1", type: "task.created" },
      { taskId: "task-1", type: "task.dispatched" },
    ]);
  });

  it("fails before creating a task when the node cannot accept task attachment", async () => {
    const commands = new WorkflowRunCommands();

    await expect(
      commands.taskCreate(
        "wf-run-1",
        "gate",
        "Build artifact",
        "Do the work",
        "high",
        "default",
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/approval/);

    expect(createTaskCalls).toEqual([]);
    expect(attachTaskCalls).toEqual([]);
    expect(deletedTaskIds).toEqual([]);
    expect(emittedTaskEvents).toEqual([]);
  });

  it("deletes the newly created task if attach fails after creation", async () => {
    const commands = new WorkflowRunCommands();

    await expect(
      commands.taskCreate(
        "wf-run-1",
        "race",
        "Build artifact",
        "Do the work",
        "high",
        "default",
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(/already has current task/);

    expect(createTaskCalls).toHaveLength(1);
    expect(attachTaskCalls).toEqual([]);
    expect(deletedTaskIds).toEqual(["task-1"]);
    expect(emittedTaskEvents).toEqual([]);
  });
});

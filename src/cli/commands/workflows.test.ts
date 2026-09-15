import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const actualTasksIndexModule = await import("../../tasks/index.js");

const createWorkflowSpecCalls: Array<Record<string, unknown>> = [];
const startWorkflowRunCalls: Array<Record<string, unknown>> = [];
const releaseWorkflowNodeRunCalls: Array<Record<string, unknown>> = [];
const archiveNodeCalls: Array<Record<string, unknown>> = [];
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
  getWorkflowSpec: (specId: string) =>
    specId === "wf-spec-missing"
      ? null
      : {
          id: specId,
          title: "Workflow",
          policy: { completionMode: "all_required" },
          nodes: [],
          edges: [],
        },
  listWorkflowSpecs: () => [
    {
      id: "wf-spec-1",
      title: "Workflow",
      policy: { completionMode: "all_required" },
      nodes: [],
      edges: [],
    },
  ],
  startWorkflowRun: (specId: string, input: Record<string, unknown>) => {
    startWorkflowRunCalls.push({ specId, ...input });
    return workflowRunDetails;
  },
  listWorkflowRuns: () => [{ id: "wf-run-1", status: "ready", workflowSpecId: "wf-spec-1", title: "Workflow" }],
  getWorkflowRunDetails: (runId?: string) => (runId === "wf-run-missing" ? null : workflowRunDetails),
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
  archiveWorkflowNodeRun: (runId: string, nodeKey: string) => {
    archiveNodeCalls.push({ runId, nodeKey });
    return {
      run: workflowRunDetails.run,
      nodeRun: { specNodeKey: nodeKey, status: "archived" },
      details: workflowRunDetails,
    };
  },
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
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { WorkflowRunCommands, WorkflowSpecCommands } = await import("./workflows.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

describe("WorkflowSpecCommands", () => {
  beforeEach(() => {
    createWorkflowSpecCalls.length = 0;
    startWorkflowRunCalls.length = 0;
    releaseWorkflowNodeRunCalls.length = 0;
    archiveNodeCalls.length = 0;
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
    archiveNodeCalls.length = 0;
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
      commands.start("wf-spec-1", "wf-run-1", true, true);
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

describe("workflows agent-first contract", () => {
  beforeEach(() => {
    createWorkflowSpecCalls.length = 0;
    startWorkflowRunCalls.length = 0;
    releaseWorkflowNodeRunCalls.length = 0;
    archiveNodeCalls.length = 0;
    attachTaskCalls.length = 0;
    createTaskCalls.length = 0;
    dispatchCalls.length = 0;
    deletedTaskIds.length = 0;
    emittedTaskEvents.length = 0;
  });

  function capture<T>(run: () => T): { thrown: unknown; logs: string[] } {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    return { thrown, logs };
  }

  it("blocks workflows runs start without --execute (dry-run, exit 3, no run)", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.start("wf-spec-1", "wf-run-1", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("workflows runs start");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect(envelope.error.plan).toEqual({
      specId: "wf-spec-1",
      runId: "wf-run-1",
      titlePresent: true,
      nodeCount: 0,
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("Workflow");
    expect(startWorkflowRunCalls).toHaveLength(0);
  });

  it("emits WORKFLOW_SPEC_NOT_FOUND with suggestions before the brake (exit 1)", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.start("wf-spec-missing", undefined, true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("workflows runs start");
    expect(envelope.error.code).toBe("WORKFLOW_SPEC_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("wf-spec-1");
    expect(startWorkflowRunCalls).toHaveLength(0);
  });

  it("blocks workflows runs archive-node without --execute (dry-run, exit 3, no archive)", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.archiveNode("wf-run-1", "build", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("workflows runs archive-node");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect((envelope.error.plan as Record<string, unknown>).nodeKey).toBe("build");
    expect(archiveNodeCalls).toHaveLength(0);
  });

  it("archives the node with --execute", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.archiveNode("wf-run-1", "build", true, true));
    expect(thrown).toBeUndefined();
    expect(archiveNodeCalls).toEqual([{ runId: "wf-run-1", nodeKey: "build" }]);
  });

  it("emits WORKFLOW_RUN_NOT_FOUND on runs show (exit 1)", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.show("wf-run-missing", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.error.code).toBe("WORKFLOW_RUN_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("wf-run-1");
  });

  it("emits WORKFLOW_NODE_NOT_FOUND with node suggestions on archive-node (exit 1)", () => {
    const commands = new WorkflowRunCommands();
    const { thrown } = capture(() => commands.archiveNode("wf-run-1", "nope", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.error.code).toBe("WORKFLOW_NODE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("build");
    expect(archiveNodeCalls).toHaveLength(0);
  });

  it("supports --fields compact mode on workflows specs list", () => {
    const commands = new WorkflowSpecCommands();
    const { logs } = capture(() => commands.list(true, undefined, undefined, "id"));
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0])).toEqual(["id"]);
  });

  it("supports --fields compact mode on workflows runs list", () => {
    const commands = new WorkflowRunCommands();
    const { logs } = capture(() => commands.list(true, undefined, undefined, "id,status"));
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0]).sort()).toEqual(["id", "status"]);
  });
});

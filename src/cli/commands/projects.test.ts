import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const createProjectCalls: Array<Record<string, unknown>> = [];
const initProjectCalls: Array<Record<string, unknown>> = [];
const updateProjectCalls: Array<Record<string, unknown>> = [];
const linkProjectCalls: Array<Record<string, unknown>> = [];
const createProjectTaskCalls: Array<Record<string, unknown>> = [];
const attachProjectTaskCalls: Array<Record<string, unknown>> = [];
const dispatchProjectTaskCalls: Array<Record<string, unknown>> = [];
const attachProjectWorkflowRunCalls: Array<Record<string, unknown>> = [];
const startProjectWorkflowRunCalls: Array<Record<string, unknown>> = [];
const listProjectsCalls: Array<Record<string, unknown>> = [];
const listProjectStatusEntriesCalls: Array<Record<string, unknown>> = [];
const getProjectDetailsCalls: string[] = [];
const seedFixtureCalls: Array<Record<string, unknown>> = [];
const ensuredSessionCalls: Array<Record<string, unknown>> = [];
const emittedTaskEvents: Array<Record<string, unknown>> = [];
const projectResourceLinks = new Map<string, Record<string, unknown>>();

const projectDetails = {
  project: {
    id: "proj-1",
    slug: "ops-cadence",
    title: "Ops Cadence",
    status: "active",
    summary: "Keep work aligned",
    hypothesis: "Workflow is the primary attachment",
    nextStep: "Attach the run",
    lastSignalAt: 1_711_234_567_000,
  },
  links: [
    {
      id: "plink-1",
      projectId: "proj-1",
      assetType: "workflow",
      assetId: "wf-run-1",
      role: "primary",
      createdAt: 1_711_234_567_000,
      updatedAt: 1_711_234_567_000,
    },
  ],
  linkedWorkflows: [
    {
      linkId: "plink-1",
      role: "primary",
      workflowRunId: "wf-run-1",
      workflowRunTitle: "Ship smoke",
      workflowRunStatus: "ready",
      workflowSpecId: "wf-spec-1",
      workflowSpecTitle: "Ship smoke",
      createdAt: 1_711_234_567_000,
      updatedAt: 1_711_234_567_000,
    },
  ],
  workflowAggregate: {
    total: 1,
    missing: 0,
    draft: 0,
    waiting: 0,
    ready: 1,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    archived: 0,
    primaryWorkflowRunId: "wf-run-1",
    primaryWorkflowTitle: "Ship smoke",
    primaryWorkflowStatus: "ready",
    focusedWorkflowRunId: "wf-run-1",
    focusedWorkflowTitle: "Ship smoke",
    focusedWorkflowStatus: "ready",
    focusedWorkflowRole: "primary",
    overallStatus: "ready",
  },
  operational: {
    runtimeStatus: "ready",
    workflowCount: 1,
    hottestWorkflowRunId: "wf-run-1",
    hottestWorkflowTitle: "Ship smoke",
    hottestWorkflowStatus: "ready",
    hottestNodeRunId: "node-run-1",
    hottestNodeKey: "ship",
    hottestNodeLabel: "Ship smoke",
    hottestNodeKind: "task",
    hottestNodeRequirement: "required",
    hottestNodeReleaseMode: "auto",
    hottestNodeStatus: "ready",
    hottestTaskId: "task-ship",
    hottestTaskTitle: "Ship release",
    hottestTaskStatus: "in_progress",
    hottestTaskProgress: 42,
    hottestTaskPriority: "high",
  },
};

const defaultProjectResourceLink = {
  id: "plink-resource-1",
  projectId: "proj-1",
  assetType: "resource",
  assetId: "/tmp/ravi.bot",
  role: "substrate",
  metadata: {
    type: "worktree",
    label: "ravi.bot worktree",
    locator: "/tmp/ravi.bot",
    path: "/tmp/ravi.bot",
    basename: "ravi.bot",
  },
  createdAt: 1_711_234_567_000,
  updatedAt: 1_711_234_567_000,
  resourceType: "worktree",
  locator: "/tmp/ravi.bot",
  label: "ravi.bot worktree",
};

mock.module("../../projects/index.js", () => ({
  createProject: (input: Record<string, unknown>) => {
    createProjectCalls.push(input);
    return projectDetails.project;
  },
  createProjectTask: (input: Record<string, unknown>) => {
    createProjectTaskCalls.push(input);
    return {
      details: projectDetails,
      workflow: projectDetails.linkedWorkflows[0],
      defaults: {
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      },
      task: {
        id: "task-project-1",
        title: input.title,
        status: input.dispatch ? "dispatched" : "open",
      },
      createdTask: {
        id: "task-project-1",
        title: input.title,
        status: "open",
      },
      event: {
        id: 1,
        taskId: "task-project-1",
        type: "task.created",
      },
      relatedEvents: [],
      attached: {
        nodeRun: {
          specNodeKey: input.nodeKey,
          currentTaskId: "task-project-1",
        },
      },
      launch: input.dispatch
        ? {
            mode: "dispatched",
            task: {
              id: "task-project-1",
              title: input.title,
              status: "dispatched",
            },
            assignment: {
              id: "assign-1",
            },
            event: {
              id: 2,
              taskId: "task-project-1",
              type: "task.dispatched",
            },
            sessionName: input.sessionName ?? "ops-session",
            readiness: {
              state: "active",
            },
            primaryArtifact: null,
            dispatchSummary: "summary",
          }
        : null,
    };
  },
  attachProjectTask: (input: Record<string, unknown>) => {
    attachProjectTaskCalls.push(input);
    return {
      details: projectDetails,
      workflow: projectDetails.linkedWorkflows[0],
      defaults: {
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      },
      task: {
        id: input.taskId,
        title: "Attached task",
        status: input.dispatch ? "dispatched" : "open",
      },
      attached: {
        nodeRun: {
          specNodeKey: input.nodeKey,
          currentTaskId: input.taskId,
        },
      },
      launch: input.dispatch
        ? {
            mode: "launch_planned",
            task: {
              id: input.taskId,
              title: "Attached task",
              status: "open",
            },
            launchPlan: {
              taskId: input.taskId,
              agentId: input.agentId ?? "main",
              sessionName: input.sessionName ?? "ops-session",
            },
            readiness: {
              state: "waiting",
            },
            event: {
              id: 3,
              taskId: input.taskId,
              type: "task.launch-planned",
            },
          }
        : null,
    };
  },
  dispatchProjectTask: (input: Record<string, unknown>) => {
    dispatchProjectTaskCalls.push(input);
    return {
      details: projectDetails,
      defaults: {
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      },
      task: {
        id: input.taskId,
        title: "Dispatched task",
        status: "dispatched",
      },
      project: {
        projectSlug: "ops-cadence",
      },
      launch: {
        mode: "dispatched",
        task: {
          id: input.taskId,
          title: "Dispatched task",
          status: "dispatched",
        },
        assignment: {
          id: "assign-2",
        },
        event: {
          id: 4,
          taskId: input.taskId,
          type: "task.dispatched",
        },
        sessionName: input.sessionName ?? "ops-session",
        readiness: {
          state: "active",
        },
        primaryArtifact: null,
        dispatchSummary: "summary",
      },
    };
  },
  attachProjectWorkflowRun: (input: Record<string, unknown>) => {
    attachProjectWorkflowRunCalls.push(input);
    return {
      details: projectDetails,
      workflow: projectDetails.linkedWorkflows[0],
      defaults: {
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      },
    };
  },
  initProject: (input: Record<string, unknown>) => {
    initProjectCalls.push(input);
    return {
      details: projectDetails,
      ownerLink: {
        id: "plink-agent-1",
        projectId: "proj-1",
        assetType: "agent",
        assetId: "main",
        role: "owner",
        createdAt: 1_711_234_567_000,
        updatedAt: 1_711_234_567_000,
      },
      sessionLink: {
        id: "plink-session-1",
        projectId: "proj-1",
        assetType: "session",
        assetId: "ops-room",
        role: "operator",
        createdAt: 1_711_234_567_000,
        updatedAt: 1_711_234_567_000,
      },
      resourceLinks: [defaultProjectResourceLink],
      workflows: [
        {
          source: "template",
          templateId: "technical-change",
          workflowRunId: "wf-run-1",
          workflowSpecId: "wf-spec-1",
          workflowTitle: "Ship smoke",
          workflowStatus: "ready",
          role: "primary",
        },
      ],
    };
  },
  getProjectDetails: (ref: string) => {
    getProjectDetailsCalls.push(ref);
    return projectDetails;
  },
  listProjects: (query: Record<string, unknown>) => {
    listProjectsCalls.push(query);
    return [
      {
        ...projectDetails.project,
        linkCount: 1,
      },
    ];
  },
  listProjectStatusEntries: (query: Record<string, unknown>) => {
    listProjectStatusEntriesCalls.push(query);
    return [
      {
        project: {
          ...projectDetails.project,
          linkCount: 1,
        },
        links: projectDetails.links,
        linkedWorkflows: projectDetails.linkedWorkflows,
        workflowAggregate: projectDetails.workflowAggregate,
        operational: projectDetails.operational,
      },
    ];
  },
  linkProject: (input: Record<string, unknown>) => {
    linkProjectCalls.push(input);
    if (input.assetType === "resource" && typeof input.assetId === "string") {
      const metadata = (input.metadata as Record<string, unknown> | undefined) ?? {};
      const label = typeof metadata.label === "string" ? metadata.label : null;
      const resource = {
        id: `plink-resource-${linkProjectCalls.length}`,
        projectId: "proj-1",
        assetType: "resource",
        assetId: input.assetId,
        role: typeof input.role === "string" ? input.role : null,
        metadata,
        createdAt: 1_711_234_567_000,
        updatedAt: 1_711_234_567_000,
        resourceType: typeof metadata.type === "string" ? metadata.type : null,
        locator: typeof metadata.locator === "string" ? metadata.locator : input.assetId,
        label,
      };
      projectResourceLinks.set(String(input.assetId), resource);
      projectResourceLinks.set(resource.id, resource);
      if (label) {
        projectResourceLinks.set(label, resource);
      }
    }
    return projectDetails;
  },
  getProjectResourceLink: (_projectRef: string, resourceRef: string) => projectResourceLinks.get(resourceRef) ?? null,
  listProjectResourceLinks: (_projectRef: string, resourceType?: string) =>
    [...new Map([...projectResourceLinks.values()].map((resource) => [String(resource.id), resource])).values()].filter(
      (resource) => !resourceType || resource.resourceType === resourceType,
    ),
  normalizeProjectStatus: (value?: string) => value?.trim().toLowerCase() || "active",
  normalizeProjectWorkflowLinkRole: (value?: string) =>
    value?.trim().toLowerCase() === "secondary" ? "support" : value?.trim().toLowerCase(),
  requireProjectWorkflowTemplateId: (value: string) => value.trim().toLowerCase(),
  startProjectWorkflowRun: (input: Record<string, unknown>) => {
    startProjectWorkflowRunCalls.push(input);
    return {
      details: projectDetails,
      workflow: projectDetails.linkedWorkflows[0],
      defaults: {
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      },
      run: {
        run: {
          id: "wf-run-1",
          title: "Ship smoke",
          status: "ready",
        },
      },
    };
  },
  updateProject: (ref: string, input: Record<string, unknown>) => {
    updateProjectCalls.push({ ref, ...input });
    return projectDetails.project;
  },
}));

mock.module("../../projects/fixtures.js", () => ({
  seedCanonicalProjectFixtures: async (input: Record<string, unknown>) => {
    seedFixtureCalls.push(input);
    return {
      generatedAt: 1_711_234_567_000,
      total: 1,
      fixtures: [
        {
          key: "ops-cadence",
          projectId: "proj-1",
          projectSlug: "demo-ops-cadence",
          projectTitle: "Ops Cadence",
          projectStatus: "active",
          workflowSpecId: "wf-spec-1",
          workflowRunId: "wf-run-1",
          workflowStatus: "running",
          operatorSessionName: "ops-session",
          resourceAssetId: "/workspace/ravi.bot",
          resourceType: "worktree",
          tasks: [{ nodeKey: "triage", taskId: "task-1", title: "Audit the release queue", status: "in_progress" }],
          proofCommands: [
            "ravi projects status demo-ops-cadence",
            "ravi projects show demo-ops-cadence",
            "ravi tasks show task-1",
          ],
        },
      ],
    };
  },
}));

mock.module("../../router/config.js", () => ({
  getAgent: (id: string) => (id === "main" ? { id: "main", cwd: "/tmp/main" } : null),
}));

mock.module("../../router/index.js", () => ({
  resolveSession: (nameOrKey: string) =>
    nameOrKey === "ops-session" ? { name: "ops-session", sessionKey: "agent:main:main", agentId: "main" } : null,
  getOrCreateSession: (sessionKey: string, agentId: string, agentCwd: string, defaults?: Record<string, unknown>) => {
    ensuredSessionCalls.push({ sessionKey, agentId, agentCwd, defaults });
    return {
      name: typeof defaults?.name === "string" ? defaults.name : undefined,
      sessionKey,
      agentId,
    };
  },
  expandHome: (value: string) => value,
}));

mock.module("../../workflows/index.js", () => ({
  getWorkflowRunDetails: (runId: string) =>
    runId === "wf-run-1"
      ? {
          run: {
            id: "wf-run-1",
            title: "Ship smoke",
            status: "ready",
          },
        }
      : null,
}));

mock.module("../../tasks/index.js", () => ({
  emitTaskEvent: async (task: Record<string, unknown>, event: Record<string, unknown>) => {
    emittedTaskEvents.push({ task, event });
  },
}));

const {
  ProjectCommands,
  ProjectFixtureCommands,
  ProjectResourceCommands,
  ProjectTaskCommands,
  ProjectWorkflowCommands,
} = await import("./projects.js");

describe("ProjectCommands", () => {
  beforeEach(() => {
    createProjectCalls.length = 0;
    initProjectCalls.length = 0;
    updateProjectCalls.length = 0;
    linkProjectCalls.length = 0;
    createProjectTaskCalls.length = 0;
    attachProjectTaskCalls.length = 0;
    dispatchProjectTaskCalls.length = 0;
    attachProjectWorkflowRunCalls.length = 0;
    startProjectWorkflowRunCalls.length = 0;
    listProjectsCalls.length = 0;
    listProjectStatusEntriesCalls.length = 0;
    getProjectDetailsCalls.length = 0;
    seedFixtureCalls.length = 0;
    ensuredSessionCalls.length = 0;
    emittedTaskEvents.length = 0;
    projectResourceLinks.clear();
    projectResourceLinks.set(defaultProjectResourceLink.assetId, defaultProjectResourceLink);
    projectResourceLinks.set(defaultProjectResourceLink.id, defaultProjectResourceLink);
    projectResourceLinks.set(defaultProjectResourceLink.label, defaultProjectResourceLink);
  });

  it("creates projects with normalized owner/session inputs", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.create(
        "Ops Cadence",
        undefined,
        "active",
        "Keep work aligned",
        "Workflow is the primary attachment",
        "Attach the run",
        undefined,
        "main",
        "ops-session",
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createProjectCalls).toEqual([
      expect.objectContaining({
        title: "Ops Cadence",
        status: "active",
        summary: "Keep work aligned",
        hypothesis: "Workflow is the primary attachment",
        nextStep: "Attach the run",
        ownerAgentId: "main",
        operatorSessionName: "ops-session",
      }),
    ]);
    expect(getProjectDetailsCalls).toEqual(["proj-1"]);
  });

  it("initializes a project with ensured session, parsed resources, and canonical workflows", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.init(
        "Ops Cadence",
        "ops-cadence",
        "active",
        "Keep work aligned",
        "Workflow is the primary attachment",
        "Attach the run",
        "main",
        "ops-room",
        ["worktree:/workspace/ravi.bot", "url:https://docs.example.com/runbook"],
        ["technical-change"],
        ["wf-run-1"],
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(ensuredSessionCalls).toEqual([
      expect.objectContaining({
        sessionKey: "agent:main:project:ops-cadence:session:ops-room",
        agentId: "main",
        defaults: {
          name: "ops-room",
        },
      }),
    ]);
    expect(initProjectCalls).toEqual([
      expect.objectContaining({
        title: "Ops Cadence",
        slug: "ops-cadence",
        ownerAgentId: "main",
        operatorSessionName: "ops-room",
        workflowTemplates: ["technical-change"],
        workflowRunIds: ["wf-run-1"],
        resources: [
          expect.objectContaining({
            type: "worktree",
            assetId: "/workspace/ravi.bot",
            label: "ravi.bot worktree",
          }),
          expect.objectContaining({
            type: "url",
            assetId: "https://docs.example.com/runbook",
            label: "docs.example.com/runbook",
          }),
        ],
      }),
    ]);
  });

  it("updates projects and can clear owner/session state", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.update(
        "ops-cadence",
        undefined,
        "blocked",
        undefined,
        "Waiting on confirmation",
        "Review workflow state",
        undefined,
        false,
        "none",
        "none",
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(updateProjectCalls).toEqual([
      expect.objectContaining({
        ref: "ops-cadence",
        status: "blocked",
        hypothesis: "Waiting on confirmation",
        nextStep: "Review workflow state",
        ownerAgentId: null,
        operatorSessionName: null,
      }),
    ]);
  });

  it("starts project-scoped workflow runs in one step", () => {
    const commands = new ProjectWorkflowCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.start("ops-cadence", "wf-spec-1", "support", "wf-run-2", true);
    } finally {
      console.log = originalLog;
    }

    expect(startProjectWorkflowRunCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        workflowSpecId: "wf-spec-1",
        workflowRunId: "wf-run-2",
        role: "support",
      }),
    ]);
  });

  it("attaches workflow runs from the project surface in one step", () => {
    const commands = new ProjectWorkflowCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.attach("ops-cadence", "wf-run-1", "primary", true);
    } finally {
      console.log = originalLog;
    }

    expect(attachProjectWorkflowRunCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        workflowRunId: "wf-run-1",
        role: "primary",
      }),
    ]);
  });

  it("creates project-scoped task attempts with workflow node attach and dispatch defaults", async () => {
    const commands = new ProjectTaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.create(
        "ops-cadence",
        "ship",
        "Ship smoke",
        "Run the project smoke test",
        "wf-run-1",
        "high",
        "default",
        true,
        undefined,
        undefined,
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(createProjectTaskCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        workflowRunId: "wf-run-1",
        nodeKey: "ship",
        title: "Ship smoke",
        instructions: "Run the project smoke test",
        priority: "high",
        profileId: "default",
        dispatch: true,
      }),
    ]);
    expect(emittedTaskEvents.map((entry) => (entry.event as Record<string, unknown>).type)).toEqual([
      "task.created",
      "task.dispatched",
    ]);
  });

  it("attaches existing project tasks and lets explicit agent/session override defaults", async () => {
    const commands = new ProjectTaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.attach("ops-cadence", "ship", "task-1", "wf-run-1", true, "ops-agent", "ops-room", true);
    } finally {
      console.log = originalLog;
    }

    expect(attachProjectTaskCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        workflowRunId: "wf-run-1",
        nodeKey: "ship",
        taskId: "task-1",
        dispatch: true,
        agentId: "ops-agent",
        sessionName: "ops-room",
      }),
    ]);
    expect(emittedTaskEvents).toHaveLength(1);
    expect((emittedTaskEvents[0]?.event as Record<string, unknown>).type).toBe("task.launch-planned");
  });

  it("dispatches tasks from project context without requiring workflow mutation", async () => {
    const commands = new ProjectTaskCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.dispatch("ops-cadence", "task-1", undefined, undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(dispatchProjectTaskCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        taskId: "task-1",
      }),
    ]);
    expect(emittedTaskEvents).toHaveLength(1);
    expect((emittedTaskEvents[0]?.event as Record<string, unknown>).type).toBe("task.dispatched");
  });

  it("links resources with structured metadata", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.link(
        "resource",
        "ops-cadence",
        "/workspace/ravi.bot",
        "substrate",
        "worktree",
        "ravi.bot",
        '{"lane":"core"}',
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(linkProjectCalls).toEqual([
      expect.objectContaining({
        projectRef: "ops-cadence",
        assetType: "resource",
        assetId: "/workspace/ravi.bot",
        role: "substrate",
        metadata: expect.objectContaining({
          lane: "core",
          type: "worktree",
          label: "ravi.bot",
          locator: "/workspace/ravi.bot",
          path: "/workspace/ravi.bot",
          basename: "ravi.bot",
        }),
      }),
    ]);
  });

  it("prints workflow runtime rollups in project status", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      commands.status("ops-cadence");
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Project:   active");
    expect(output).toContain("Runtime:   ready");
    expect(output).toContain("Counts:    ready 1");
    expect(output).toContain("Lead:      task Ship release :: in_progress · 42%");
    expect(output).toContain("Primary:   wf-run-1 :: ready :: Ship smoke");
    expect(output).toContain("Focus:     wf-run-1 :: ready :: Ship smoke :: role primary");
  });

  it("lists operational next surfaces with runtime lead and next step", () => {
    const commands = new ProjectCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      commands.next("active");
    } finally {
      console.log = originalLog;
    }

    expect(listProjectStatusEntriesCalls).toEqual([{ status: "active" }]);
    const output = logs.join("\n");
    expect(output).toContain("Projects next (1):");
    expect(output).toContain("ops-cadence :: active :: runtime ready :: wf 1");
    expect(output).toContain("lead task Ship release :: in_progress · 42%");
    expect(output).toContain("next Attach the run");
  });

  it("seeds canonical fixtures with the default owner agent", async () => {
    const commands = new ProjectFixtureCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      await commands.seed(undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(seedFixtureCalls).toEqual([
      expect.objectContaining({
        ownerAgentId: "main",
      }),
    ]);
  });

  it("adds resources with inferred worktree metadata", () => {
    const commands = new ProjectResourceCommands();
    const tempRoot = mkdtempSync(join(tmpdir(), "ravi-project-resource-"));
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.add("ops-cadence", tempRoot, undefined, "substrate", undefined, '{"lane":"core"}', true);
    } finally {
      console.log = originalLog;
    }

    expect(linkProjectCalls.at(-1)).toEqual(
      expect.objectContaining({
        projectRef: "ops-cadence",
        assetType: "resource",
        assetId: tempRoot,
        role: "substrate",
        metadata: expect.objectContaining({
          lane: "core",
          type: "worktree",
          locator: tempRoot,
          path: tempRoot,
          basename: basename(tempRoot),
          label: `${basename(tempRoot)} worktree`,
        }),
      }),
    );
  });

  it("lists and shows project resources", () => {
    const commands = new ProjectResourceCommands();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };

    try {
      commands.list("ops-cadence", "worktree");
      commands.show("ops-cadence", "ravi.bot worktree");
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Project resources (1):");
    expect(output).toContain("resource:worktree :: ravi.bot worktree :: /tmp/ravi.bot");
    expect(output).toContain("Resource plink-resource-1");
    expect(output).toContain("Locator:    /tmp/ravi.bot");
  });

  it("imports repo, worktree, url, and group resources in batch", () => {
    const commands = new ProjectResourceCommands();
    const tempRoot = mkdtempSync(join(tmpdir(), "ravi-project-import-"));
    const tempFile = join(tempRoot, "brief.txt");
    writeFileSync(tempFile, "brief");
    const originalLog = console.log;
    console.log = () => {};

    try {
      commands.import(
        "ops-cadence",
        ["https://github.com/acme/ravi"],
        [tempRoot],
        ["https://docs.example.com/runbook"],
        ["group:120363425628305127"],
        "substrate",
        '{"lane":"core"}',
        true,
      );
    } finally {
      console.log = originalLog;
    }

    expect(linkProjectCalls.slice(-4)).toEqual([
      expect.objectContaining({
        assetId: "https://github.com/acme/ravi",
        metadata: expect.objectContaining({
          type: "repo",
          locator: "https://github.com/acme/ravi",
          label: "acme/ravi",
          lane: "core",
        }),
      }),
      expect.objectContaining({
        assetId: tempRoot,
        metadata: expect.objectContaining({
          type: "worktree",
          locator: tempRoot,
          label: `${basename(tempRoot)} worktree`,
          lane: "core",
        }),
      }),
      expect.objectContaining({
        assetId: "https://docs.example.com/runbook",
        metadata: expect.objectContaining({
          type: "url",
          locator: "https://docs.example.com/runbook",
          label: "docs.example.com/runbook",
          lane: "core",
        }),
      }),
      expect.objectContaining({
        assetId: "group:120363425628305127",
        metadata: expect.objectContaining({
          type: "group",
          locator: "group:120363425628305127",
          label: "group 120363425628305127",
          lane: "core",
        }),
      }),
    ]);
  });
});

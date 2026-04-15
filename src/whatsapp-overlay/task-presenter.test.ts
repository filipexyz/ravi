import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type TaskNode = {
  task?: {
    id?: string;
    status?: string;
    visualStatus?: string;
    progress?: number;
    createdAt?: number;
    updatedAt?: number;
    dependencies?: Array<{
      satisfied?: boolean;
    }>;
    readiness?: {
      state?: string;
      dependencyCount?: number;
      satisfiedDependencyCount?: number;
      unsatisfiedDependencyCount?: number;
      hasLaunchPlan?: boolean;
    };
    workflow?: {
      workflowRunId?: string;
      workflowRunTitle?: string;
      workflowRunStatus?: string;
      workflowSpecId?: string;
      workflowSpecTitle?: string;
      workflowNodeRunId?: string;
      nodeKey?: string;
      nodeLabel?: string;
      nodeKind?: string;
      nodeRequirement?: string;
      nodeReleaseMode?: string;
      nodeStatus?: string;
      waitingOnNodeKeys?: string[];
      currentTaskId?: string | null;
      currentTaskAttempt?: number | null;
      attemptCount?: number;
      isCurrentTask?: boolean;
    } | null;
    launchPlan?: {
      agentId?: string;
    } | null;
  };
  rows?: Array<{
    order?: number;
    session?: {
      sessionKey?: string;
    };
  }>;
  children?: TaskNode[];
};

function loadTaskPresenterApi() {
  const scriptUrl = new URL("../../extensions/whatsapp-overlay/task-presenter.js", import.meta.url);
  const source = readFileSync(scriptUrl, "utf8");
  const context = { globalThis: {} as Record<string, unknown> };

  vm.runInNewContext(source, context, {
    filename: fileURLToPath(scriptUrl),
  });

  const api = context.globalThis.RaviWaOverlayTaskPresenter;
  if (!api || typeof api !== "object") {
    throw new Error("task presenter helpers not attached to global scope");
  }

  return api as {
    getTaskVisualProgressState: (
      task: TaskNode["task"],
      node: TaskNode,
    ) => { progress: number; source: string; childCount: number };
    getTaskReadinessState: (task: TaskNode["task"]) => {
      status: string;
      totalCount: number;
      satisfiedCount: number;
      pendingCount: number;
      hasLaunchPlan: boolean;
      label: string | null;
    };
    getTaskWorkflowSummary: (task: TaskNode["task"]) => {
      runId: string | null;
      runTitle: string;
      runStatus: string | null;
      specId: string | null;
      specTitle: string | null;
      nodeRunId: string | null;
      nodeKey: string | null;
      nodeLabel: string | null;
      nodeKind: string | null;
      nodeRequirement: string | null;
      nodeReleaseMode: string | null;
      nodeStatus: string | null;
      currentTaskId: string | null;
      currentTaskAttempt: number | null;
      attemptCount: number | null;
      attemptLabel: string | null;
      waitingOnNodeKeys: string[];
      waitingOnLabel: string | null;
      compactPath: string;
      isCurrentTask: boolean;
    } | null;
    getTaskKanbanSurfaceStatus: (task: TaskNode["task"]) => string;
    pickTaskGroupPrimaryRow: (node: TaskNode) => {
      order?: number;
      session?: { sessionKey?: string };
    } | null;
    sortTaskTreeByRecency: (nodes: TaskNode[]) => TaskNode[];
  };
}

const {
  getTaskVisualProgressState,
  getTaskReadinessState,
  getTaskWorkflowSummary,
  getTaskKanbanSurfaceStatus,
  pickTaskGroupPrimaryRow,
  sortTaskTreeByRecency,
} = loadTaskPresenterApi();

describe("whatsapp overlay task presenter", () => {
  it("uses descendant aggregate when the parent has no own progress yet", () => {
    const node: TaskNode = {
      task: { status: "open", progress: 0 },
      children: [
        { task: { status: "done", progress: 0 } },
        { task: { status: "done", progress: 100 } },
        { task: { status: "done", progress: 0 } },
      ],
    };

    expect(getTaskVisualProgressState(node.task, node)).toEqual({
      progress: 100,
      source: "children",
      childCount: 3,
    });
  });

  it("keeps the parent runtime progress when the parent is already in progress", () => {
    const node: TaskNode = {
      task: { status: "in_progress", progress: 42 },
      children: [{ task: { status: "done", progress: 100 } }, { task: { status: "in_progress", progress: 60 } }],
    };

    expect(getTaskVisualProgressState(node.task, node)).toEqual({
      progress: 42,
      source: "task",
      childCount: 2,
    });
  });

  it("derives waiting readiness from dependency counts and keeps launch-plan visibility", () => {
    expect(
      getTaskReadinessState({
        status: "open",
        dependencies: [{ satisfied: true }, { satisfied: false }],
        readiness: {
          state: "waiting",
          dependencyCount: 2,
          satisfiedDependencyCount: 1,
          unsatisfiedDependencyCount: 1,
          hasLaunchPlan: true,
        },
        launchPlan: {
          agentId: "dev",
        },
      }),
    ).toEqual({
      status: "waiting",
      totalCount: 2,
      satisfiedCount: 1,
      pendingCount: 1,
      hasLaunchPlan: true,
      label: null,
    });
  });

  it("maps open tasks into ready or waiting kanban surface states", () => {
    expect(
      getTaskKanbanSurfaceStatus({
        status: "open",
        readiness: {
          state: "ready",
          dependencyCount: 0,
          satisfiedDependencyCount: 0,
          unsatisfiedDependencyCount: 0,
        },
      }),
    ).toBe("ready");

    expect(
      getTaskKanbanSurfaceStatus({
        status: "open",
        visualStatus: "waiting",
        readiness: {
          state: "waiting",
          dependencyCount: 2,
          satisfiedDependencyCount: 1,
          unsatisfiedDependencyCount: 1,
        },
      }),
    ).toBe("waiting");
  });

  it("summarizes workflow linkage for compact task surfaces", () => {
    expect(
      getTaskWorkflowSummary({
        workflow: {
          workflowRunId: "wf-run-1",
          workflowRunTitle: "Ship smoke",
          workflowRunStatus: "running",
          workflowSpecId: "wf-spec-1",
          workflowSpecTitle: "Ship smoke",
          workflowNodeRunId: "node-run-1",
          nodeKey: "ship",
          nodeLabel: "Ship release",
          nodeKind: "task",
          nodeRequirement: "required",
          nodeReleaseMode: "manual",
          nodeStatus: "awaiting_release",
          waitingOnNodeKeys: ["build"],
          currentTaskId: "task-ship",
          currentTaskAttempt: 1,
          attemptCount: 1,
          isCurrentTask: true,
        },
      }),
    ).toEqual({
      runId: "wf-run-1",
      runTitle: "Ship smoke",
      runStatus: "running",
      specId: "wf-spec-1",
      specTitle: "Ship smoke",
      nodeRunId: "node-run-1",
      nodeKey: "ship",
      nodeLabel: "Ship release",
      nodeKind: "task",
      nodeRequirement: "required",
      nodeReleaseMode: "manual",
      nodeStatus: "awaiting_release",
      currentTaskId: "task-ship",
      currentTaskAttempt: 1,
      attemptCount: 1,
      attemptLabel: "attempt 1",
      waitingOnNodeKeys: ["build"],
      waitingOnLabel: "build",
      compactPath: "Ship smoke / ship",
      isCurrentTask: true,
    });
  });

  it("picks the earliest visible row recursively for grouped task headers", () => {
    const node: TaskNode = {
      task: { status: "open", progress: 0 },
      children: [
        {
          task: { status: "in_progress", progress: 50 },
          rows: [{ order: 8, session: { sessionKey: "child-late" } }],
        },
        {
          task: { status: "done", progress: 100 },
          children: [
            {
              task: { status: "done", progress: 100 },
              rows: [{ order: 3, session: { sessionKey: "child-early" } }],
            },
          ],
        },
      ],
    };

    expect(pickTaskGroupPrimaryRow(node)?.session?.sessionKey).toBe("child-early");
  });

  it("sorts grouped task cards by the freshest descendant update", () => {
    const nodes: TaskNode[] = [
      {
        task: { id: "older-root", createdAt: 10, updatedAt: 10 },
        children: [
          { task: { id: "fresh-child", createdAt: 20, updatedAt: 90 } },
          { task: { id: "older-child", createdAt: 15, updatedAt: 40 } },
        ],
      },
      {
        task: { id: "recent-root", createdAt: 30, updatedAt: 80 },
      },
    ];

    const sorted = sortTaskTreeByRecency(nodes);

    expect(sorted.map((node) => node.task?.id)).toEqual(["older-root", "recent-root"]);
    expect(sorted[0]?.children?.map((node) => node.task?.id)).toEqual(["fresh-child", "older-child"]);
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    const nodes: TaskNode[] = [
      { task: { id: "older-root", createdAt: 10, updatedAt: 10 } },
      { task: { id: "created-only-root", createdAt: 75 } },
    ];

    const sorted = sortTaskTreeByRecency(nodes);

    expect(sorted.map((node) => node.task?.id)).toEqual(["created-only-root", "older-root"]);
  });
});

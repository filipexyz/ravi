import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type TaskNode = {
  task?: {
    id?: string;
    status?: string;
    progress?: number;
    createdAt?: number;
    updatedAt?: number;
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
    pickTaskGroupPrimaryRow: (node: TaskNode) => {
      order?: number;
      session?: { sessionKey?: string };
    } | null;
    sortTaskTreeByRecency: (nodes: TaskNode[]) => TaskNode[];
  };
}

const { getTaskVisualProgressState, pickTaskGroupPrimaryRow, sortTaskTreeByRecency } = loadTaskPresenterApi();

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

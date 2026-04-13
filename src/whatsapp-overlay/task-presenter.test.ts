import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type TaskNode = {
  task?: {
    status?: string;
    progress?: number;
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
  };
}

const { getTaskVisualProgressState, pickTaskGroupPrimaryRow } = loadTaskPresenterApi();

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
});

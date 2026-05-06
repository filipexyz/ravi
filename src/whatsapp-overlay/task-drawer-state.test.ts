import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type TaskSelection = {
  task: {
    id: string;
    status: string;
  };
};

function loadTaskDrawerStateApi() {
  const scriptUrl = new URL("../../extensions/whatsapp-overlay/task-drawer-state.js", import.meta.url);
  const source = readFileSync(scriptUrl, "utf8");
  const context = { globalThis: {} as Record<string, unknown> };

  vm.runInNewContext(source, context, {
    filename: fileURLToPath(scriptUrl),
  });

  const api = context.globalThis.__RAVI_WA_TASK_DRAWER_STATE__;
  if (!api || typeof api !== "object") {
    throw new Error("task drawer state helpers not attached to global scope");
  }

  return api as {
    syncTaskDetailDrawerState: (params: { selectedTaskId: string | null; drawerOpen: boolean; snapshot: unknown }) => {
      nextSelectedTaskId: string | null;
      nextDrawerOpen: boolean;
      taskRemoved: boolean;
    };
    resolveTaskDetailDrawerState: (params: {
      selectedTaskId: string | null;
      drawerOpen: boolean;
      snapshot: unknown;
      cachedSelection?: TaskSelection | null;
    }) => {
      effectiveTaskId: string | null;
      selectedTask: TaskSelection | null;
      detailDrawerVisible: boolean;
      isHydrating: boolean;
      selectionSource: string;
      taskStillExists: boolean;
    };
  };
}

function makeSelection(taskId: string, status = "open"): TaskSelection {
  return {
    task: {
      id: taskId,
      status,
    },
  };
}

function makeSnapshot(params: { items: string[]; selectedTaskId?: string | null; queryTaskId?: string | null }) {
  return {
    items: params.items.map((id) => ({ id })),
    selectedTask: params.selectedTaskId ? makeSelection(params.selectedTaskId) : null,
    query: {
      taskId: params.queryTaskId ?? params.selectedTaskId ?? null,
    },
  };
}

const { syncTaskDetailDrawerState, resolveTaskDetailDrawerState } = loadTaskDrawerStateApi();

describe("whatsapp overlay task drawer state", () => {
  it("keeps the local drawer selection while the fresh selectedTask is transiently missing", () => {
    const nextState = syncTaskDetailDrawerState({
      selectedTaskId: "task-1",
      drawerOpen: true,
      snapshot: makeSnapshot({
        items: ["task-1", "task-2"],
        selectedTaskId: null,
        queryTaskId: "task-2",
      }),
    });

    expect(nextState).toEqual({
      nextSelectedTaskId: "task-1",
      nextDrawerOpen: true,
      taskRemoved: false,
    });
  });

  it("reuses the cached selection and keeps the drawer visible while the snapshot rehydrates", () => {
    const drawerState = resolveTaskDetailDrawerState({
      selectedTaskId: "task-1",
      drawerOpen: true,
      snapshot: makeSnapshot({
        items: ["task-1", "task-2"],
        selectedTaskId: null,
        queryTaskId: "task-2",
      }),
      cachedSelection: makeSelection("task-1", "in_progress"),
    });

    expect(drawerState.effectiveTaskId).toBe("task-1");
    expect(drawerState.selectedTask?.task.id).toBe("task-1");
    expect(drawerState.detailDrawerVisible).toBe(true);
    expect(drawerState.isHydrating).toBe(true);
    expect(drawerState.selectionSource).toBe("cache");
    expect(drawerState.taskStillExists).toBe(true);
  });

  it("keeps selections alive when task snapshots use envelope items", () => {
    const drawerState = resolveTaskDetailDrawerState({
      selectedTaskId: "task-1",
      drawerOpen: true,
      snapshot: {
        items: [{ task: { id: "task-1", status: "in_progress" } }],
        selectedTask: null,
        query: {
          taskId: "task-2",
        },
      },
      cachedSelection: makeSelection("task-1", "in_progress"),
    });

    expect(drawerState.taskStillExists).toBe(true);
    expect(drawerState.detailDrawerVisible).toBe(true);
    expect(drawerState.isHydrating).toBe(true);
  });

  it("closes the drawer and clears the local selection when the task really disappears", () => {
    const nextState = syncTaskDetailDrawerState({
      selectedTaskId: "task-1",
      drawerOpen: true,
      snapshot: makeSnapshot({
        items: ["task-2"],
        selectedTaskId: "task-2",
      }),
    });

    expect(nextState).toEqual({
      nextSelectedTaskId: null,
      nextDrawerOpen: false,
      taskRemoved: true,
    });
  });
});

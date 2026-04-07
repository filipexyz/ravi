import { afterEach, describe, expect, it } from "bun:test";
import {
  dbCompleteTask,
  dbCreateTask,
  dbHasActiveTaskForSession,
  dbDeleteTask,
  dbDispatchTask,
  dbGetActiveAssignment,
  dbGetTask,
  dbListTaskEvents,
  dbReportTaskProgress,
} from "./task-db.js";

const createdTaskIds: string[] = [];

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
});

describe("task-db", () => {
  it("tracks a minimal task lifecycle", () => {
    const created = dbCreateTask({
      title: "Task DB Smoke",
      instructions: "Validate create -> dispatch -> report -> done",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.status).toBe("open");
    expect(created.event.type).toBe("task.created");

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    expect(dispatched.task.status).toBe("dispatched");
    expect(dispatched.assignment.agentId).toBe("dev");
    expect(dbGetActiveAssignment(created.task.id)?.sessionName).toBe(`${created.task.id}-work`);

    const progressed = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "working",
      progress: 35,
    });
    expect(progressed.task.status).toBe("in_progress");
    expect(progressed.task.progress).toBe(35);

    const completed = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done",
    });
    expect(completed.task.status).toBe("done");
    expect(completed.task.progress).toBe(100);
    expect(dbGetTask(created.task.id)?.summary).toBe("done");

    const eventTypes = dbListTaskEvents(created.task.id).map((event) => event.type);
    expect(eventTypes).toEqual(["task.created", "task.dispatched", "task.progress", "task.done"]);
  });

  it("does not reopen a terminal task on late progress", () => {
    const created = dbCreateTask({
      title: "Terminal guard smoke",
      instructions: "Late progress must not reopen done task",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done",
    });

    const late = dbReportTaskProgress(created.task.id, {
      actor: "late-agent",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "still working",
      progress: 10,
    });

    expect(late.task.status).toBe("done");
    expect(late.task.progress).toBe(100);
    expect(late.event.message).toContain("Ignored late progress");
    expect(dbGetTask(created.task.id)?.status).toBe("done");
  });

  it("tracks whether a session still has an active task", () => {
    const created = dbCreateTask({
      title: "Task activity lookup",
      instructions: "Verify active task lookup by session name",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const sessionName = `${created.task.id}-work`;

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    expect(dbHasActiveTaskForSession(sessionName)).toBe(true);

    dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName,
      message: "done",
    });

    expect(dbHasActiveTaskForSession(sessionName)).toBe(false);
  });

  it("can ignore the currently dispatched task when checking active work for a session", () => {
    const first = dbCreateTask({
      title: "First active task",
      instructions: "Keep session busy",
      createdBy: "test",
    });
    const second = dbCreateTask({
      title: "Second active task",
      instructions: "Should still see other active task",
      createdBy: "test",
    });
    createdTaskIds.push(first.task.id, second.task.id);

    const sessionName = "shared-task-session";

    dbDispatchTask(first.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });
    dbDispatchTask(second.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    expect(dbHasActiveTaskForSession(sessionName, second.task.id)).toBe(true);

    dbCompleteTask(first.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName,
      message: "done",
    });

    expect(dbHasActiveTaskForSession(sessionName, second.task.id)).toBe(false);
  });

  it("persists worktree metadata on both the task and the dispatched assignment", () => {
    const created = dbCreateTask({
      title: "Task worktree persistence",
      instructions: "Store worktree metadata across task lifecycle",
      createdBy: "test",
      worktree: {
        mode: "path",
        path: "../feature-worktree",
        branch: "feature/task-runtime",
      },
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.worktree).toEqual({
      mode: "path",
      path: "../feature-worktree",
      branch: "feature/task-runtime",
    });

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
      worktree: {
        mode: "path",
        path: "/tmp/ravi-task-worktree",
        branch: "feature/task-runtime",
      },
    });

    expect(dbGetTask(created.task.id)?.worktree).toEqual({
      mode: "path",
      path: "../feature-worktree",
      branch: "feature/task-runtime",
    });
    expect(dbGetActiveAssignment(created.task.id)?.worktree).toEqual({
      mode: "path",
      path: "/tmp/ravi-task-worktree",
      branch: "feature/task-runtime",
    });
  });
});

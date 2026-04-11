import { afterEach, describe, expect, it } from "bun:test";
import {
  dbAddTaskComment,
  dbBlockTask,
  dbCompleteTask,
  dbCreateTask,
  dbHasActiveTaskForSession,
  dbDeleteTask,
  dbDispatchTask,
  dbGetActiveAssignment,
  dbGetTask,
  dbListChildTasks,
  dbListTaskComments,
  dbListTaskEvents,
  dbRegisterTaskCheckpointMiss,
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
      createdByAgentId: "main",
      createdBySessionName: "dev",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.status).toBe("open");
    expect(created.event.type).toBe("task.created");
    expect(created.task.createdByAgentId).toBe("main");
    expect(created.task.createdBySessionName).toBe("dev");
    expect(created.task.reportToSessionName).toBe("dev");
    expect(created.task.reportEvents).toEqual(["done"]);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    expect(dispatched.task.status).toBe("dispatched");
    expect(dispatched.assignment.agentId).toBe("dev");
    expect(dispatched.assignment.checkpointIntervalMs).toBe(300000);
    expect(dispatched.assignment.checkpointOverdueCount).toBe(0);
    expect(dispatched.assignment.checkpointDueAt).toBeGreaterThan(dispatched.assignment.assignedAt);
    expect(dispatched.assignment.reportToSessionName).toBe("dev");
    expect(dispatched.assignment.reportEvents).toEqual(["done"]);
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

  it("stores a task-level checkpoint default and materializes it on dispatch", () => {
    const created = dbCreateTask({
      title: "Checkpoint default",
      instructions: "Persist task checkpoint defaults before dispatch",
      createdBy: "test",
      checkpointIntervalMs: 600000,
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.checkpointIntervalMs).toBe(600000);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    expect(dispatched.assignment.checkpointIntervalMs).toBe(600000);
    expect(dispatched.assignment.checkpointLastReportAt).toBeUndefined();
    expect(dispatched.assignment.checkpointDueAt).toBeGreaterThan(dispatched.assignment.assignedAt);
  });

  it("snapshots explicit report configuration into the assignment on dispatch", () => {
    const created = dbCreateTask({
      title: "Explicit task reporting",
      instructions: "Report target and events should be explicit and snapshotted",
      createdBy: "creator",
      createdBySessionName: "creator-session",
      reportToSessionName: "ops-session",
      reportEvents: ["blocked", "failed"],
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "dispatcher",
    });

    expect(created.task.reportToSessionName).toBe("ops-session");
    expect(created.task.reportEvents).toEqual(["blocked", "failed"]);
    expect(dispatched.assignment.reportToSessionName).toBe("ops-session");
    expect(dispatched.assignment.reportEvents).toEqual(["blocked", "failed"]);
  });

  it("resets checkpoint timing only on a real report and clears overdue count", () => {
    const created = dbCreateTask({
      title: "Checkpoint report reset",
      instructions: "Only ravi tasks report should reset the checkpoint clock",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    const firstDueAt = dispatched.assignment.checkpointDueAt!;

    dbReportTaskProgress(created.task.id, {
      actor: "sync",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      progress: 10,
      resetCheckpoint: false,
    });

    const afterDocumentSync = dbGetActiveAssignment(created.task.id)!;
    expect(afterDocumentSync.checkpointLastReportAt).toBeUndefined();
    expect(afterDocumentSync.checkpointDueAt).toBe(firstDueAt);

    const missed = dbRegisterTaskCheckpointMiss(created.task.id, afterDocumentSync.id, firstDueAt + 1);
    expect(missed?.assignment.checkpointOverdueCount).toBe(1);

    const reported = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      progress: 35,
    });

    const assignment = dbGetActiveAssignment(created.task.id)!;
    expect(reported.task.progress).toBe(35);
    expect(assignment.checkpointLastReportAt).toBeDefined();
    expect(assignment.checkpointDueAt).toBeGreaterThan(assignment.checkpointLastReportAt!);
    expect(assignment.checkpointOverdueCount).toBe(0);
  });

  it("rolls the next due checkpoint forward and records overdue events", () => {
    const created = dbCreateTask({
      title: "Checkpoint overdue",
      instructions: "Overdue checkpoints should roll forward by interval",
      createdBy: "test",
      checkpointIntervalMs: 1000,
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const missed = dbRegisterTaskCheckpointMiss(
      created.task.id,
      dispatched.assignment.id,
      dispatched.assignment.checkpointDueAt! + 2500,
    );
    expect(missed?.missedCount).toBe(3);
    expect(missed?.assignment.checkpointOverdueCount).toBe(3);
    expect(missed?.assignment.checkpointDueAt).toBe(dispatched.assignment.checkpointDueAt! + 3000);
    expect(missed?.event.type).toBe("task.checkpoint.missed");
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

  it("persists comments separately from operational events", () => {
    const created = dbCreateTask({
      title: "Comment persistence smoke",
      instructions: "Comments should not be confused with task events",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const comment = dbAddTaskComment(created.task.id, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "olha esse edge case antes de seguir",
    });

    expect(comment.taskId).toBe(created.task.id);
    expect(comment.authorAgentId).toBe("main");
    expect(comment.authorSessionName).toBe("dev");
    expect(dbListTaskComments(created.task.id)).toEqual([comment]);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual(["task.created"]);
  });

  it("surfaces a dispatch summary in the dispatched event for the operator", () => {
    const created = dbCreateTask({
      title: "Dispatch summary surface",
      instructions: "Make dispatch intent visible outside the worker history",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    expect(dispatched.event.type).toBe("task.dispatched");
    expect(dispatched.event.message).toContain("Dispatch summary surfaced here");
    expect(dispatched.event.message).toContain("ravi-system-tasks-manager");
    expect(dispatched.event.message).toContain("edit TASK.md first");
    expect(dispatched.event.message).toContain("ravi tasks report|done|block|fail");
  });

  it("respects explicit progress when a task is blocked", () => {
    const created = dbCreateTask({
      title: "Blocked progress contract",
      instructions: "Blocking should preserve the TASK.md progress when provided",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const blocked = dbBlockTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "waiting on upstream decision",
      progress: 90,
    });

    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.progress).toBe(90);
    expect(blocked.event.type).toBe("task.blocked");
    expect(blocked.event.progress).toBe(90);
  });

  it("deduplicates repeated completion for the same task", () => {
    const created = dbCreateTask({
      title: "Terminal dedupe smoke",
      instructions: "Calling done twice should not append a second terminal event",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const first = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done once",
    });
    const second = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done twice",
    });

    expect(second.wasNoop).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual([
      "task.created",
      "task.dispatched",
      "task.done",
    ]);
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

  it("persists parent-child lineage in the runtime", () => {
    const parent = dbCreateTask({
      title: "Parent task",
      instructions: "Owns child work",
      createdBy: "test",
    });
    const child = dbCreateTask({
      title: "Child task",
      instructions: "Linked to the parent task",
      createdBy: "test",
      parentTaskId: parent.task.id,
    });
    createdTaskIds.push(parent.task.id, child.task.id);

    expect(dbGetTask(child.task.id)?.parentTaskId).toBe(parent.task.id);
    expect(dbListChildTasks(parent.task.id).map((task) => task.id)).toEqual([child.task.id]);
  });
});

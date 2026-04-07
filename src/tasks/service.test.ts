import { afterEach, describe, expect, it } from "bun:test";
import {
  buildTaskEventPayload,
  buildTaskResumePrompt,
  buildTaskStreamSnapshot,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbReportTaskProgress,
  isTaskRecoveryFresh,
  isTaskStreamCommand,
} from "./index.js";

const createdTaskIds: string[] = [];

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
});

describe("task substrate contract", () => {
  it("builds a canonical event payload for the v3 substrate", () => {
    const created = dbCreateTask({
      title: "Stream payload smoke",
      instructions: "Create an event payload with the canonical task entity",
      createdBy: "test",
      worktree: {
        mode: "path",
        path: "../stream-worktree",
        branch: "feature/stream",
      },
    });
    createdTaskIds.push(created.task.id);

    const payload = buildTaskEventPayload(created.task, created.event);

    expect(payload.kind).toBe("task.event");
    expect(payload.task.id).toBe(created.task.id);
    expect(payload.task.createdBy).toBe("test");
    expect(payload.task.worktree).toEqual({
      mode: "path",
      path: "../stream-worktree",
      branch: "feature/stream",
    });
    expect(payload.event.type).toBe("task.created");
    expect(payload.task.artifacts).toEqual({
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      items: [],
    });
    expect(payload.artifacts.status).toBe("planned");
  });

  it("builds a task snapshot with selection details and forward-compatible artifact placeholders", () => {
    const created = dbCreateTask({
      title: "Snapshot smoke",
      instructions: "Create -> dispatch -> report so the snapshot exposes current task state",
      createdBy: "test",
      worktree: {
        mode: "path",
        path: "../snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
      worktree: {
        mode: "path",
        path: "/tmp/ravi-task-snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "working",
      progress: 35,
    });

    const snapshot = buildTaskStreamSnapshot({
      taskId: created.task.id,
      eventsLimit: 10,
    });

    expect(snapshot.query).toEqual({
      taskId: created.task.id,
      status: null,
      agentId: null,
      sessionName: null,
      eventsLimit: 10,
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      id: created.task.id,
      status: "in_progress",
      progress: 35,
      worktree: {
        mode: "path",
        path: "../snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    expect(snapshot.stats).toEqual({
      total: 1,
      open: 0,
      dispatched: 0,
      inProgress: 1,
      blocked: 0,
      done: 0,
      failed: 0,
    });
    expect(snapshot.selectedTask?.activeAssignment?.sessionName).toBe(`${created.task.id}-work`);
    expect(snapshot.selectedTask?.activeAssignment?.worktree).toEqual({
      mode: "path",
      path: "/tmp/ravi-task-snapshot-worktree",
      branch: "feature/snapshot",
    });
    expect(snapshot.selectedTask?.events.map((event) => event.type)).toEqual([
      "task.created",
      "task.dispatched",
      "task.progress",
    ]);
    expect(snapshot.selectedTask?.task.artifacts.supportedKinds).toEqual(["file", "url", "text"]);
    expect(snapshot.artifacts.status).toBe("planned");
  });

  it("recognizes the canonical task commands exposed by the v3 stream boundary", () => {
    expect(isTaskStreamCommand("task.create")).toBe(true);
    expect(isTaskStreamCommand("task.dispatch")).toBe(true);
    expect(isTaskStreamCommand("task.report")).toBe(true);
    expect(isTaskStreamCommand("task.done")).toBe(true);
    expect(isTaskStreamCommand("task.block")).toBe(true);
    expect(isTaskStreamCommand("task.fail")).toBe(true);
    expect(isTaskStreamCommand("snapshot.open")).toBe(false);
  });

  it("builds a resume prompt that preserves task progress across daemon restart", () => {
    const created = dbCreateTask({
      title: "Resume smoke",
      instructions: "Continue from previous progress after restart",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    const progressed = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      progress: 42,
      message: "halfway there",
    });

    const prompt = buildTaskResumePrompt(progressed.task, "dev", `${created.task.id}-work`, {
      effectiveCwd: "/tmp/ravi-task-recovery",
    });

    expect(prompt).toContain(`task ${created.task.id}`);
    expect(prompt).toContain("Status atual: in_progress");
    expect(prompt).toContain("Progresso atual: 42%");
    expect(prompt).toContain("Retome do ponto onde parou");
    expect(prompt).toContain(`ravi tasks done ${created.task.id} --summary`);
  });

  it("recovers only fresh active tasks after restart", () => {
    const now = 3_000_000;
    expect(
      isTaskRecoveryFresh(
        {
          id: "task-fresh",
          title: "Fresh",
          instructions: "Fresh task",
          status: "in_progress",
          priority: "normal",
          progress: 80,
          createdAt: now - 10_000,
          updatedAt: now - 5_000,
        },
        {
          id: "asg-fresh",
          taskId: "task-fresh",
          agentId: "dev",
          sessionName: "task-fresh-work",
          status: "accepted",
          assignedAt: now - 15_000,
          acceptedAt: now - 8_000,
        },
        now,
      ),
    ).toBe(true);

    expect(
      isTaskRecoveryFresh(
        {
          id: "task-stale",
          title: "Stale",
          instructions: "Old task",
          status: "in_progress",
          priority: "normal",
          progress: 90,
          createdAt: now - 3_000_000,
          updatedAt: now - 2_000_000,
        },
        {
          id: "asg-stale",
          taskId: "task-stale",
          agentId: "dev",
          sessionName: "task-stale-work",
          status: "accepted",
          assignedAt: now - 2_100_000,
        },
        now,
      ),
    ).toBe(false);
  });
});

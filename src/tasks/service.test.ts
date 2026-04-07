import { afterEach, describe, expect, it } from "bun:test";
import {
  buildTaskEventPayload,
  buildTaskStreamSnapshot,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbReportTaskProgress,
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
    });
    createdTaskIds.push(created.task.id);

    const payload = buildTaskEventPayload(created.task, created.event);

    expect(payload.kind).toBe("task.event");
    expect(payload.task.id).toBe(created.task.id);
    expect(payload.task.createdBy).toBe("test");
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
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
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
});

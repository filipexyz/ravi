import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  getNats: mock(() => ({})),
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emittedEvents.push({ topic, data });
    }),
  },
}));

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TaskCheckpointRunner, createTask, dbDeleteTask, dbDispatchTask, dbGetActiveAssignment, dbListTaskEvents } =
  await import("./index.js");

const createdTaskIds: string[] = [];

beforeEach(() => {
  emittedEvents.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
});

describe("task checkpoint runner", () => {
  it("emits a missed checkpoint event and steers the assignee session", async () => {
    const created = createTask({
      title: "Checkpoint runner smoke",
      instructions: "Emit overdue reminders without failing the task",
      createdBy: "test",
      checkpointIntervalMs: 5000,
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const runner = new TaskCheckpointRunner();
    await runner.start();
    try {
      const reminders = await runner.sweep(dispatched.assignment.checkpointDueAt! + 1);
      expect(reminders).toBe(1);
    } finally {
      await runner.stop();
    }

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.topic).toBe(`ravi.task.${created.task.id}.event`);
    expect(emittedEvents[0]?.data.event).toMatchObject({
      type: "task.checkpoint.missed",
    });
    expect(emittedEvents[0]?.data.activeAssignment).toMatchObject({
      checkpointOverdueCount: 1,
    });

    expect(publishCalls).toEqual([
      {
        sessionName: `${created.task.id}-work`,
        payload: expect.objectContaining({
          deliveryBarrier: "after_response",
        }),
      },
    ]);
    expect(String(publishCalls[0]?.payload.prompt)).toContain(`ravi tasks report ${created.task.id}`);

    const assignment = dbGetActiveAssignment(created.task.id)!;
    expect(assignment.checkpointOverdueCount).toBe(1);
    expect(assignment.checkpointDueAt).toBe(dispatched.assignment.checkpointDueAt! + 5000);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toContain("task.checkpoint.missed");
  });
});

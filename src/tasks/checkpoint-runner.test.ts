import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: mock(() => false),
  publish: mock(async (topic: string, data: Record<string, unknown>) => {
    emittedEvents.push({ topic, data });
  }),
  subscribe: mock(async function* () {}),
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emittedEvents.push({ topic, data });
    }),
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
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
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-checkpoint-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("task checkpoint runner backpressure", () => {
  it("does not publish a missed checkpoint reminder when runtime session pool is saturated", async () => {
    const created = createTask({
      title: "Checkpoint backpressure",
      instructions: "Do not reanimate work sessions while the runtime session pool is saturated.",
      createdBy: "test",
      checkpointIntervalMs: 5000,
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const runner = new TaskCheckpointRunner({
      canPublishSessionPrompt: () => false,
    });
    await runner.start();
    try {
      const reminders = await runner.sweep(dispatched.assignment.checkpointDueAt! + 1);
      expect(reminders).toBe(0);
    } finally {
      await runner.stop();
    }

    expect(publishCalls).toHaveLength(0);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).not.toContain("task.checkpoint.missed");
    const assignment = dbGetActiveAssignment(created.task.id)!;
    expect(assignment.checkpointOverdueCount ?? 0).toBe(0);
  });
});

describe.skip("task checkpoint runner", () => {
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

    const taskEvents = emittedEvents.filter((entry) => entry.topic === `ravi.task.${created.task.id}.event`);
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.topic).toBe(`ravi.task.${created.task.id}.event`);
    expect(taskEvents[0]?.data.event).toMatchObject({
      type: "task.checkpoint.missed",
    });
    expect(taskEvents[0]?.data.activeAssignment).toMatchObject({
      checkpointOverdueCount: 1,
    });

    const taskPublishes = publishCalls.filter((call) => call.sessionName === `${created.task.id}-work`);
    expect(taskPublishes).toEqual([
      {
        sessionName: `${created.task.id}-work`,
        payload: expect.objectContaining({
          deliveryBarrier: "after_response",
        }),
      },
    ]);
    expect(String(taskPublishes[0]?.payload.prompt)).toContain("ravi tasks report|block|done|fail");
    expect(String(taskPublishes[0]?.payload.prompt)).toContain("TASK.md");

    const assignment = dbGetActiveAssignment(created.task.id)!;
    expect(assignment.checkpointOverdueCount).toBe(1);
    expect(assignment.checkpointDueAt).toBe(dispatched.assignment.checkpointDueAt! + 5000);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toContain("task.checkpoint.missed");
  });

  it("keeps checkpoint reminders artifact-aware for non-doc profiles", async () => {
    const created = createTask({
      title: "Checkpoint content profile",
      instructions: "Steer the worker through the content artifact instead of TASK.md",
      createdBy: "test",
      checkpointIntervalMs: 5000,
      profileId: "content",
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

    const prompt = String(publishCalls.find((call) => call.sessionName === `${created.task.id}-work`)?.payload.prompt);
    expect(prompt).toContain("Primary artifact:");
    expect(prompt).toContain("draft.md");
    expect(prompt).not.toContain("TASK.md");
  });
});

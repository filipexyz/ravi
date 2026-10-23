import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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

const {
  TaskCheckpointRunner,
  listTaskCheckpointSweepTasks,
  createTask,
  dbDeleteTask,
  dbArchiveTask,
  dbDispatchTask,
  dbGetActiveAssignment,
  dbListTaskEvents,
  dbMarkTaskAcceptedForSession,
} = await import("./index.js");
const { getOrCreateSession, getSessionByName } = await import("../router/sessions.js");
const { dbCreateAgent } = await import("../router/router-db.js");
const { initTaskProfileScaffold, invalidateTaskProfileCatalogCache } = await import("./profiles.js");
const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");
const { upsertSessionTurn } = await import("../session-trace/session-trace-db.js");
const { describeObservedTaskSilence } = await import("./checkpoint-runner.js");

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-checkpoint-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
  // Other suites in the same process mock the stream differently; record through the hook.
  setTaskSessionPromptPublisherForTests(async (sessionName, payload) => {
    publishCalls.push({ sessionName, payload });
  });
});

afterEach(async () => {
  setTaskSessionPromptPublisherForTests();
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

describe("observed task silence detector", () => {
  it("never asks the worker for status and tells the requester once when nothing moves", async () => {
    getOrCreateSession("agent:main:requester", "main", "/tmp/ravi-requester", { name: "requester" });
    const created = createTask({
      title: "Observed silence",
      instructions: "Work while the task observer keeps status.",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);
    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
      reportToSessionName: "requester",
    });
    // The default profile turns the observer on, so the checkpoint is the long stall window.
    expect(dispatched.assignment.checkpointIntervalMs).toBe(30 * 60 * 1000);
    dbMarkTaskAcceptedForSession(`${created.task.id}-work`, created.task.id);
    const accepted = dbGetActiveAssignment(created.task.id)!;

    const runner = new TaskCheckpointRunner();
    await runner.start();
    try {
      expect(await runner.sweep(accepted.checkpointDueAt! + 1)).toBe(1);
      const next = dbGetActiveAssignment(created.task.id)!;
      expect(await runner.sweep(next.checkpointDueAt! + 1)).toBe(1);
    } finally {
      await runner.stop();
    }

    expect(publishCalls.filter((call) => call.sessionName === `${created.task.id}-work`)).toHaveLength(0);
    const stallReports = publishCalls.filter((call) => call.sessionName === "requester");
    expect(stallReports).toHaveLength(1);
    expect(String(stallReports[0]?.payload.prompt)).toContain(`Task stalled: ${created.task.id}`);
    expect(stallReports[0]?.payload._taskRuntime).toEqual({
      taskId: created.task.id,
      kind: "stalled",
      event: "task.stalled",
    });
    const types = dbListTaskEvents(created.task.id).map((event) => event.type);
    expect(types.filter((type) => type === "task.stalled")).toHaveLength(1);
    expect(types.filter((type) => type === "task.checkpoint.missed")).toHaveLength(2);
  });
});

describe("observed task stall wording", () => {
  function dispatchObservedTask(title: string) {
    getOrCreateSession("agent:main:requester", "main", "/tmp/ravi-requester", { name: "requester" });
    const created = createTask({
      title,
      instructions: "Work while the task observer keeps status.",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);
    const sessionName = `${created.task.id}-work`;
    getOrCreateSession(`agent:dev:${sessionName}`, "dev", "/tmp/ravi-worker", { name: sessionName });
    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
      reportToSessionName: "requester",
    });
    expect(dispatched.assignment.checkpointIntervalMs).toBe(30 * 60 * 1000);
    dbMarkTaskAcceptedForSession(sessionName, created.task.id);
    return {
      taskId: created.task.id,
      sessionKey: `agent:dev:${sessionName}`,
      assignment: dbGetActiveAssignment(created.task.id)!,
    };
  }

  async function sweepOnce(dueAt: number): Promise<void> {
    const runner = new TaskCheckpointRunner();
    await runner.start();
    try {
      expect(await runner.sweep(dueAt + 1)).toBe(1);
    } finally {
      await runner.stop();
    }
  }

  it("says the worker answered and the observer recorded nothing when the worker turn completed", async () => {
    const { taskId, sessionKey, assignment } = dispatchObservedTask("Observer blind");
    const completedAt = assignment.assignedAt + 5 * 60 * 1000;
    upsertSessionTurn({
      turnId: `${taskId}-turn-1`,
      sessionKey,
      status: "complete",
      startedAt: assignment.assignedAt + 1000,
      completedAt,
      updatedAt: completedAt,
    });

    await sweepOnce(assignment.checkpointDueAt!);

    const stalled = dbListTaskEvents(taskId).filter((event) => event.type === "task.stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.message).toContain("The worker turn ended (complete) 25 min ago");
    expect(stalled[0]?.message).toContain("the task observer may not be reading the worker");
    expect(stalled[0]?.message).not.toContain("may be hung");
  });

  it("says the turn is still running when the worker turn has not ended", async () => {
    const { taskId, sessionKey, assignment } = dispatchObservedTask("Observer blind, worker busy");
    upsertSessionTurn({
      turnId: `${taskId}-turn-1`,
      sessionKey,
      status: "running",
      startedAt: assignment.assignedAt + 1000,
      updatedAt: assignment.assignedAt + 1000,
    });

    await sweepOnce(assignment.checkpointDueAt!);

    const stalled = dbListTaskEvents(taskId).filter((event) => event.type === "task.stalled");
    expect(stalled[0]?.message).toContain("The worker turn is still running");
  });

  it("does not call a turn left running by a previous daemon still running", () => {
    const { taskId, sessionKey, assignment } = dispatchObservedTask("Worker died with the daemon");
    const startedAt = assignment.assignedAt + 1000;
    upsertSessionTurn({ turnId: `${taskId}-turn-1`, sessionKey, status: "running", startedAt, updatedAt: startedAt });

    const message = describeObservedTaskSilence(assignment, 30, startedAt + 60_000, startedAt + 1);
    expect(message).toContain("started before the last daemon restart");
    expect(message).not.toContain("still running");
  });

  it("measures silence from the last report when the observer already reported", () => {
    const { taskId, sessionKey, assignment } = dispatchObservedTask("Observer reported once");
    const completedAt = assignment.assignedAt + 5 * 60 * 1000;
    upsertSessionTurn({
      turnId: `${taskId}-turn-1`,
      sessionKey,
      status: "complete",
      startedAt: assignment.assignedAt + 1000,
      completedAt,
      updatedAt: completedAt,
    });
    const reportedAt = assignment.assignedAt + 10 * 60 * 1000;

    const message = describeObservedTaskSilence(
      { ...assignment, checkpointLastReportAt: reportedAt },
      30,
      reportedAt + 30 * 60 * 1000,
    );
    expect(message).toContain("no task status was recorded since the last report 30 min ago");
    expect(message).not.toContain("after dispatch");
  });

  it("keeps the hung-or-gone wording when the worker has no turn since dispatch", async () => {
    const { taskId, sessionKey, assignment } = dispatchObservedTask("Worker silent");
    // A turn from before this dispatch says nothing about this assignment.
    upsertSessionTurn({
      turnId: `${taskId}-turn-old`,
      sessionKey,
      status: "complete",
      startedAt: assignment.assignedAt - 60_000,
      completedAt: assignment.assignedAt - 30_000,
      updatedAt: assignment.assignedAt - 30_000,
    });

    await sweepOnce(assignment.checkpointDueAt!);

    const stalled = dbListTaskEvents(taskId).filter((event) => event.type === "task.stalled");
    expect(stalled[0]?.message).toBe("No worker activity seen for 30 min; the turn may be hung or the session gone.");
  });
});

describe("checkpoint reminder for a work session that expired", () => {
  // Only a profile with the task observer turned off reminds the worker.
  beforeEach(() => {
    const { manifestPath } = initTaskProfileScaffold("checkpoint-reminder", "runtime-only", { sourceKind: "user" });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, observer: { enabled: false } }));
    invalidateTaskProfileCatalogCache();
  });

  it("recreates the session for the assignee instead of the default agent", async () => {
    dbCreateAgent({ id: "worker", cwd: "/tmp/ravi-worker-agent" });
    const created = createTask({
      title: "Checkpoint after session expiry",
      instructions: "Remind the assignee, never the default agent.",
      createdBy: "test",
      checkpointIntervalMs: 5000,
      profileId: "checkpoint-reminder",
    });
    createdTaskIds.push(created.task.id);
    const sessionName = `${created.task.id}-work`;
    dbDispatchTask(created.task.id, { agentId: "worker", sessionName, assignedBy: "test" });
    dbMarkTaskAcceptedForSession(sessionName, created.task.id);
    const dueAt = dbGetActiveAssignment(created.task.id)!.checkpointDueAt!;
    expect(dueAt).toBeGreaterThan(0);
    // The worker's session expired after it accepted the task.
    expect(getSessionByName(sessionName)).toBeNull();

    const runner = new TaskCheckpointRunner();
    await runner.start();
    try {
      expect(await runner.sweep(dueAt + 1)).toBe(1);
    } finally {
      await runner.stop();
    }

    expect(getSessionByName(sessionName)).toMatchObject({ agentId: "worker", agentCwd: "/tmp/ravi-worker-agent" });
    const taskPublishes = publishCalls.filter((call) => call.sessionName === sessionName);
    expect(taskPublishes).toHaveLength(1);
    expect(taskPublishes[0]!.payload).toMatchObject({
      _agentId: "worker",
      deliveryBarrier: "after_task",
      taskBarrierTaskId: created.task.id,
    });
    expect(String(taskPublishes[0]!.payload.prompt)).toContain("Checkpoint overdue on task");
  });

  it("does not remind anyone when the assignee agent no longer exists", async () => {
    const created = createTask({
      title: "Checkpoint for a removed agent",
      instructions: "Do not fall back to the default agent.",
      createdBy: "test",
      checkpointIntervalMs: 5000,
      profileId: "checkpoint-reminder",
    });
    createdTaskIds.push(created.task.id);
    const sessionName = `${created.task.id}-work`;
    dbDispatchTask(created.task.id, { agentId: "gone", sessionName, assignedBy: "test" });
    dbMarkTaskAcceptedForSession(sessionName, created.task.id);
    const dueAt = dbGetActiveAssignment(created.task.id)!.checkpointDueAt!;
    expect(dueAt).toBeGreaterThan(0);

    const runner = new TaskCheckpointRunner();
    await runner.start();
    try {
      expect(await runner.sweep(dueAt + 1)).toBe(0);
    } finally {
      await runner.stop();
    }

    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toContain("task.checkpoint.missed");
    expect(publishCalls.filter((call) => call.sessionName === sessionName)).toHaveLength(0);
    expect(getSessionByName(sessionName)).toBeNull();
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

describe("task checkpoint runner sweep selection", () => {
  it("leaves archived tasks out even when they kept an in_progress status", async () => {
    const archived = createTask({
      title: "Archived mid flight",
      instructions: "The archive is a flag, not a status.",
      createdBy: "test",
      checkpointIntervalMs: 5000,
    });
    createdTaskIds.push(archived.task.id);
    dbDispatchTask(archived.task.id, {
      agentId: "dev",
      sessionName: `${archived.task.id}-work`,
      assignedBy: "test",
    });
    dbMarkTaskAcceptedForSession(`${archived.task.id}-work`, archived.task.id);
    dbArchiveTask(archived.task.id, { actor: "test", reason: "parked by the operator" });

    const active = createTask({
      title: "Active control",
      instructions: "Control task for the sweep selection.",
      createdBy: "test",
      checkpointIntervalMs: 5000,
    });
    createdTaskIds.push(active.task.id);
    dbDispatchTask(active.task.id, {
      agentId: "dev",
      sessionName: `${active.task.id}-work`,
      assignedBy: "test",
    });

    const swept = listTaskCheckpointSweepTasks().map((task) => task.id);
    expect(swept).not.toContain(archived.task.id);
    expect(swept).toContain(active.task.id);
  });
});

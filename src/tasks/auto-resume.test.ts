import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedTopics: Array<{ topic: string; data: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  closeNats: mock(async () => {}),
  connectNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: mock(() => false),
  publish: async (topic: string, data: Record<string, unknown>) => {
    emittedTopics.push({ topic, data });
  },
  subscribe: async function* () {},
  nats: {
    emit: async (topic: string, data: Record<string, unknown>) => {
      emittedTopics.push({ topic, data });
    },
  },
}));

const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");

const {
  commentTask,
  dbAutoResumeBlockedTask,
  dbBlockTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbGetTask,
  dbListTaskEvents,
  dbMarkTaskAcceptedForSession,
  dispatchTask,
} = await import("./index.js");
import { dbCreateAgent, dbDeleteAgent } from "../router/router-db.js";

const createdTaskIds: string[] = [];
const createdAgentIds: string[] = [];
let stateDir: string | null = null;
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

setDefaultTimeout(20_000);

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-auto-resume-test-");
  publishCalls.length = 0;
  emittedTopics.length = 0;
  setTaskSessionPromptPublisherForTests(async (sessionName, payload) => {
    publishCalls.push({ sessionName, payload });
  });
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  while (createdAgentIds.length > 0) {
    const id = createdAgentIds.pop();
    if (id) dbDeleteAgent(id);
  }
  setTaskSessionPromptPublisherForTests(undefined);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createBlockedTask(title = "Auto-resume test") {
  const created = dbCreateTask({
    title,
    instructions: `Test auto-resume: ${title}`,
    createdBy: "test",
  });
  createdTaskIds.push(created.task.id);

  dbDispatchTask(created.task.id, {
    agentId: "dev",
    sessionName: `${created.task.id}-work`,
    assignedBy: "test",
  });

  dbBlockTask(created.task.id, {
    actor: "worker",
    agentId: "dev",
    sessionName: `${created.task.id}-work`,
    message: "waiting on external dependency",
  });

  const task = dbGetTask(created.task.id)!;
  expect(task.status).toBe("blocked");
  expect(task.blockerReason).toBe("waiting on external dependency");
  return task;
}

describe("auto-resume blocked tasks", () => {
  describe("dbAutoResumeBlockedTask (central gate)", () => {
    it("transitions a blocked task to in_progress and records task.resumed event", () => {
      const task = createBlockedTask("central-gate smoke");
      const result = dbAutoResumeBlockedTask(task.id, "comment_steer", {
        actor: "operator",
        sessionName: "lead-session",
      });

      expect(result.resumed).toBe(true);
      if (!result.resumed) throw new Error("unreachable");

      expect(result.task.status).toBe("in_progress");
      expect(result.task.blockerReason).toBeUndefined();
      expect(result.event.type).toBe("task.resumed");
      expect(result.event.message).toContain("comment_steer");
    });

    it("is a no-op when task is not blocked", () => {
      const created = dbCreateTask({
        title: "Not blocked",
        instructions: "Should not resume",
        createdBy: "test",
      });
      createdTaskIds.push(created.task.id);

      dbDispatchTask(created.task.id, {
        agentId: "dev",
        sessionName: `${created.task.id}-work`,
        assignedBy: "test",
      });

      const task = dbGetTask(created.task.id)!;
      expect(task.status).toBe("dispatched");

      const result = dbAutoResumeBlockedTask(task.id, "dispatch");
      expect(result.resumed).toBe(false);
      expect(result.task.status).toBe("dispatched");
    });

    it("is idempotent: second call is a no-op after first resume", () => {
      const task = createBlockedTask("idempotent smoke");

      const first = dbAutoResumeBlockedTask(task.id, "comment_steer");
      expect(first.resumed).toBe(true);

      const second = dbAutoResumeBlockedTask(task.id, "dispatch");
      expect(second.resumed).toBe(false);
      expect(second.task.status).toBe("in_progress");
    });
  });

  describe("signal: comment-steer", () => {
    it("auto-resumes blocked task when a comment is added", async () => {
      const task = createBlockedTask("comment-steer resume");

      const result = await commentTask(task.id, {
        author: "operator",
        authorAgentId: "main",
        authorSessionName: "lead",
        body: "retake this and try a different approach",
      });

      expect(result.task.status).toBe("in_progress");
      expect(result.task.blockerReason).toBeUndefined();

      const events = dbListTaskEvents(task.id);
      const resumeEvents = events.filter((e) => e.type === "task.resumed");
      expect(resumeEvents).toHaveLength(1);
      expect(resumeEvents[0]!.message).toContain("comment_steer");
    });

    it("steers the assignee session after resuming", async () => {
      const task = createBlockedTask("comment-steer + steer prompt");

      await commentTask(task.id, {
        author: "operator",
        authorAgentId: "main",
        authorSessionName: "lead",
        body: "please unblock yourself and try X",
      });

      expect(publishCalls.length).toBeGreaterThanOrEqual(1);
      const steerCall = publishCalls.find((c) => c.sessionName === `${task.id}-work`);
      expect(steerCall).toBeDefined();
    });
  });

  describe("signal: dispatch", () => {
    it("auto-resumes blocked task before re-dispatch", async () => {
      createdAgentIds.push("dev");
      dbCreateAgent({ id: "dev", cwd: "/tmp/ravi-dev-agent" });

      const task = createBlockedTask("dispatch resume");

      await dispatchTask(task.id, {
        agentId: "dev",
        sessionName: `${task.id}-work`,
        assignedBy: "operator",
      });

      const events = dbListTaskEvents(task.id);
      const resumeEvents = events.filter((e) => e.type === "task.resumed");
      expect(resumeEvents).toHaveLength(1);
      expect(resumeEvents[0]!.message).toContain("dispatch");

      const dispatchEvents = events.filter((e) => e.type === "task.dispatched");
      expect(dispatchEvents.length).toBeGreaterThanOrEqual(2);

      const resumeIdx = events.indexOf(resumeEvents[0]!);
      const lastDispatchIdx = events.indexOf(dispatchEvents.at(-1)!);
      expect(resumeIdx).toBeLessThan(lastDispatchIdx);
    });
  });

  describe("signal: agent-activity (taskBarrierTaskId)", () => {
    it("auto-resumes blocked task when session marks it accepted", () => {
      const task = createBlockedTask("agent-activity resume");

      const result = dbMarkTaskAcceptedForSession(`${task.id}-work`, task.id);

      expect(result).not.toBeNull();
      expect(result!.task.status).toBe("in_progress");
      expect(result!.task.blockerReason).toBeUndefined();
      expect(result!.transitioned).toBe(true);
      expect(result!.event).not.toBeNull();
      expect(result!.event!.type).toBe("task.resumed");
      expect(result!.event!.message).toContain("agent_activity");
    });

    it("still handles dispatched -> in_progress normally", () => {
      const created = dbCreateTask({
        title: "Normal dispatch accept",
        instructions: "Should not emit task.resumed",
        createdBy: "test",
      });
      createdTaskIds.push(created.task.id);

      dbDispatchTask(created.task.id, {
        agentId: "dev",
        sessionName: `${created.task.id}-work`,
        assignedBy: "test",
      });

      const result = dbMarkTaskAcceptedForSession(`${created.task.id}-work`, created.task.id);
      expect(result).not.toBeNull();
      expect(result!.task.status).toBe("in_progress");
      expect(result!.transitioned).toBe(true);
      expect(result!.event).not.toBeNull();
      expect(result!.event!.type).toBe("task.progress");
    });
  });

  describe("idempotency under concurrent signals", () => {
    it("multiple near-simultaneous signals produce exactly one task.resumed event", () => {
      const task = createBlockedTask("concurrent resume");

      const r1 = dbAutoResumeBlockedTask(task.id, "comment_steer");
      const r2 = dbAutoResumeBlockedTask(task.id, "dispatch");
      const r3 = dbAutoResumeBlockedTask(task.id, "agent_activity");

      expect(r1.resumed).toBe(true);
      expect(r2.resumed).toBe(false);
      expect(r3.resumed).toBe(false);

      const events = dbListTaskEvents(task.id);
      const resumeEvents = events.filter((e) => e.type === "task.resumed");
      expect(resumeEvents).toHaveLength(1);
    });
  });

  describe("terminal states are not affected", () => {
    it("does not resume a done task", () => {
      const created = dbCreateTask({
        title: "Done task",
        instructions: "Should not resume from done",
        createdBy: "test",
      });
      createdTaskIds.push(created.task.id);

      const result = dbAutoResumeBlockedTask(created.task.id, "comment_steer");
      expect(result.resumed).toBe(false);
    });
  });

  describe("event payload audit trail", () => {
    it("emits task event via NATS when auto-resume fires in commentTask", async () => {
      const task = createBlockedTask("nats audit");

      await commentTask(task.id, {
        author: "operator",
        authorAgentId: "main",
        authorSessionName: "lead",
        body: "resume from this direction",
      });

      const resumeNatsEvents = emittedTopics.filter(
        (e) =>
          e.topic === `ravi.task.${task.id}.event` &&
          (e.data as { event?: { type?: string } }).event?.type === "task.resumed",
      );
      expect(resumeNatsEvents).toHaveLength(1);
    });
  });
});

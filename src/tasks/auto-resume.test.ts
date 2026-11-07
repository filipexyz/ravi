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
  reportTaskProgress,
} = await import("./index.js");
import { dbCreateAgent, dbDeleteAgent, dbGetAgent } from "../router/router-db.js";
import { deleteSession, getOrCreateSession, getSessionByName } from "../router/sessions.js";

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

function ensureAgent(id: string) {
  if (dbGetAgent(id)) return;
  createdAgentIds.push(id);
  dbCreateAgent({ id, cwd: `/tmp/ravi-${id}-agent` });
}

function createBlockedTask(title = "Auto-resume test") {
  ensureAgent("dev");
  const created = dbCreateTask({
    title,
    instructions: `Test auto-resume: ${title}`,
    createdBy: "test",
  });
  createdTaskIds.push(created.task.id);

  getOrCreateSession(`agent:dev:${created.task.id}-work`, "dev", "/tmp/ravi-dev-agent", {
    name: `${created.task.id}-work`,
  });
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

  describe("comment on a task whose work session is gone", () => {
    it("recreates the expired work session for the assignee, never the default agent", async () => {
      const task = createBlockedTask("expired work session");
      const sessionName = `${task.id}-work`;
      deleteSession(getSessionByName(sessionName)!.sessionKey);

      const result = await commentTask(task.id, {
        author: "nba-admin",
        authorAgentId: "main",
        authorSessionName: "lead",
        body: "pick this back up",
      });

      expect(result.task.status).toBe("in_progress");
      expect(result.steeredSessionName).toBe(sessionName);
      expect(getSessionByName(sessionName)).toMatchObject({ agentId: "dev", agentCwd: "/tmp/ravi-dev-agent" });

      expect(publishCalls).toHaveLength(1);
      const { payload } = publishCalls[0]!;
      expect(payload).toMatchObject({
        _agentId: "dev",
        deliveryBarrier: "after_task",
        taskBarrierTaskId: task.id,
      });
      // The new session has no context: it gets the task brief, then the comment.
      const prompt = String(payload.prompt);
      expect(prompt).toContain(`You are now responsible for Ravi task ${task.id}`);
      expect(prompt.indexOf("New comment on task")).toBeGreaterThan(prompt.indexOf("You are now responsible"));
      expect(prompt).toContain("pick this back up");
    });

    it("drops a recreated session when its first prompt cannot be published", async () => {
      const task = createBlockedTask("publish fails after recreation");
      const sessionName = `${task.id}-work`;
      deleteSession(getSessionByName(sessionName)!.sessionKey);
      setTaskSessionPromptPublisherForTests(async () => {
        throw new Error("nats down");
      });

      await expect(commentTask(task.id, { author: "operator", body: "retry" })).rejects.toThrow("nats down");
      // No empty session is left behind: the next prompt recreates it with the brief.
      expect(getSessionByName(sessionName)).toBeNull();
    });

    it("names the assignee agent when the work session still exists", async () => {
      const task = createBlockedTask("live work session");

      await commentTask(task.id, { author: "operator", body: "try X" });

      expect(publishCalls).toHaveLength(1);
      // No brief on a live session: the steer waits for the reply and runs in the task's binding.
      expect(publishCalls[0]!.payload).toMatchObject({
        _agentId: "dev",
        deliveryBarrier: "after_response",
        taskBarrierTaskId: task.id,
      });
      expect(String(publishCalls[0]!.payload.prompt)).toStartWith("[System] Inform: New comment on task");
    });

    it("keeps the task blocked and records the comment when the assignee agent is gone", async () => {
      const task = createBlockedTask("assignee agent removed");
      deleteSession(getSessionByName(`${task.id}-work`)!.sessionKey);
      dbDeleteAgent("dev");

      const result = await commentTask(task.id, { author: "operator", body: "are you there?" });

      expect(result.task.status).toBe("blocked");
      expect(result.steeredSessionName).toBeUndefined();
      expect(result.steerSkippedReason).toContain("Agent not found");
      expect(result.comment.body).toBe("are you there?");
      expect(publishCalls).toHaveLength(0);
      expect(getSessionByName(`${task.id}-work`)).toBeNull();
      expect(dbListTaskEvents(task.id).some((event) => event.type === "task.resumed")).toBe(false);
    });

    it("does not steer a work session that another agent now owns", async () => {
      ensureAgent("main");
      const task = createBlockedTask("session taken by main");
      const sessionName = `${task.id}-work`;
      deleteSession(getSessionByName(sessionName)!.sessionKey);
      getOrCreateSession(sessionName, "main", "/tmp/ravi-main-agent", { name: sessionName });

      const result = await commentTask(task.id, { author: "operator", body: "go" });

      expect(result.task.status).toBe("blocked");
      expect(result.steerSkippedReason).toContain("already belongs to agent main");
      expect(publishCalls).toHaveLength(0);
    });

    it("refuses progress from the assignment session when it runs as another agent", () => {
      const task = createBlockedTask("wrong agent report");

      expect(() =>
        reportTaskProgress(task.id, {
          actor: `${task.id}-work`,
          agentId: "main",
          sessionName: `${task.id}-work`,
          message: "progress from the wrong agent",
          progress: 10,
        }),
      ).toThrow("the task is assigned to dev");
      expect(() =>
        reportTaskProgress(task.id, {
          actor: `${task.id}-work`,
          agentId: "dev",
          sessionName: `${task.id}-work`,
          message: "progress from the assignee",
          progress: 10,
        }),
      ).not.toThrow();
    });
  });

  describe("signal: dispatch", () => {
    it("auto-resumes blocked task while retaining its original assignment", async () => {
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
      expect(dispatchEvents).toHaveLength(1);

      const resumeIdx = events.indexOf(resumeEvents[0]!);
      const lastDispatchIdx = events.indexOf(dispatchEvents.at(-1)!);
      expect(resumeIdx).toBeGreaterThan(lastDispatchIdx);
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

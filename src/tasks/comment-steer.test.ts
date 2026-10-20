import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { CliExpectedError } from "../cli/expected-error.js";
import { dbCreateAgent, dbDeleteAgent } from "../router/router-db.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  closeNats: mock(async () => {}),
  connectNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: mock(() => false),
  publish: mock(async () => {}),
  subscribe: async function* () {},
  nats: { emit: mock(async () => {}) },
}));

const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");

const {
  commentTask,
  createTask,
  dbBlockTask,
  dbDeleteTask,
  dbDispatchTask,
  dbGetTask,
  dispatchTask,
  TASK_SESSION_OWNERSHIP_CONFLICT,
} = await import("./index.js");

const createdTaskIds: string[] = [];
const createdAgentIds: string[] = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-comment-steer-test-");
  publishCalls.length = 0;
  setTaskSessionPromptPublisherForTests(async (sessionName, payload) => {
    publishCalls.push({ sessionName, payload });
  });
  for (const id of ["dev", "other"]) {
    dbCreateAgent({ id, cwd: join(stateDir, `agent-${id}`) });
    createdAgentIds.push(id);
  }
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

function createDispatchedTask(title: string): { taskId: string; sessionName: string } {
  const created = createTask({
    title,
    instructions: "Use comments to steer active work",
    createdBy: "test",
  });
  createdTaskIds.push(created.task.id);
  const sessionName = `${created.task.id}-work`;
  dbDispatchTask(created.task.id, {
    agentId: "dev",
    sessionName,
    assignedBy: "test",
  });
  return { taskId: created.task.id, sessionName };
}

describe("task comments steering", () => {
  it("steers the active assignee session when a new comment lands on an active task", async () => {
    const { taskId, sessionName } = createDispatchedTask("Comment steer smoke");
    getOrCreateSession(sessionName, "dev", join(stateDir ?? "", "agent-dev"), { name: sessionName });

    const result = await commentTask(taskId, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "ajusta a direção do patch antes de continuar",
    });

    expect(result.steeredSessionName).toBe(sessionName);
    expect(result.steerSkippedReason).toBeUndefined();
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toEqual({
      sessionName,
      payload: expect.objectContaining({
        deliveryBarrier: "after_response",
        _agentId: "dev",
      }),
    });
    expect(String(publishCalls[0]?.payload.prompt)).toContain("New comment on task");
    expect(String(publishCalls[0]?.payload.prompt)).toContain("ajusta a direção do patch antes de continuar");
  });

  it("recreates a reaped session under the assigned agent before resuming a blocked task", async () => {
    const { taskId, sessionName } = createDispatchedTask("Blocked comment steer");
    dbBlockTask(taskId, { actor: "test", sessionName, message: "waiting on input" });
    expect(resolveSession(sessionName)).toBeNull();

    const result = await commentTask(taskId, {
      author: "operator",
      body: "segue com a opção B",
    });

    expect(result.task.status).toBe("in_progress");
    expect(result.steeredSessionName).toBe(sessionName);
    expect(resolveSession(sessionName)?.agentId).toBe("dev");
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.payload).toEqual(
      expect.objectContaining({
        _agentId: "dev",
        taskBarrierTaskId: taskId,
      }),
    );
  });

  it("keeps the comment and the block when the session belongs to another agent", async () => {
    const { taskId, sessionName } = createDispatchedTask("Conflicted comment steer");
    dbBlockTask(taskId, { actor: "test", sessionName, message: "waiting on input" });
    getOrCreateSession(sessionName, "other", join(stateDir ?? "", "agent-other"), { name: sessionName });

    const result = await commentTask(taskId, {
      author: "operator",
      body: "segue com a opção B",
    });

    expect(result.comment.body).toBe("segue com a opção B");
    expect(result.steeredSessionName).toBeUndefined();
    expect(result.steerSkippedReason).toContain("already belongs to agent other");
    expect(result.task.status).toBe("blocked");
    expect(dbGetTask(taskId)?.status).toBe("blocked");
    expect(publishCalls).toHaveLength(0);
  });

  it("keeps a blocked task blocked when its assigned agent no longer exists", async () => {
    const { taskId, sessionName } = createDispatchedTask("Deleted assignee comment steer");
    dbBlockTask(taskId, { actor: "test", sessionName, message: "waiting on input" });
    dbDeleteAgent("dev");

    const result = await commentTask(taskId, {
      author: "operator",
      body: "segue com a opção B",
    });

    expect(result.steeredSessionName).toBeUndefined();
    expect(result.steerSkippedReason).toContain("Agent not found");
    expect(dbGetTask(taskId)?.status).toBe("blocked");
    expect(resolveSession(sessionName)).toBeNull();
    expect(publishCalls).toHaveLength(0);
  });

  it("dispatches with the assigned agent and the task binding", async () => {
    const created = createTask({ title: "Dispatch binding", instructions: "Bind the agent", createdBy: "test" });
    createdTaskIds.push(created.task.id);

    await dispatchTask(created.task.id, { agentId: "dev", sessionName: `${created.task.id}-work`, assignedBy: "test" });

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.payload).toEqual(
      expect.objectContaining({ _agentId: "dev", taskBarrierTaskId: created.task.id }),
    );
  });

  it("refuses a redispatch into another agent's session without resuming the blocked task", async () => {
    const { taskId, sessionName } = createDispatchedTask("Conflicted redispatch");
    dbBlockTask(taskId, { actor: "test", sessionName, message: "waiting on input" });
    getOrCreateSession(sessionName, "other", join(stateDir ?? "", "agent-other"), { name: sessionName });

    let error: unknown;
    try {
      await dispatchTask(taskId, { agentId: "dev", sessionName, assignedBy: "test" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CliExpectedError);
    expect((error as CliExpectedError).code).toBe(TASK_SESSION_OWNERSHIP_CONFLICT);
    expect(dbGetTask(taskId)?.status).toBe("blocked");
    expect(publishCalls).toHaveLength(0);
  });

  it("refuses a redispatch with an unknown report target without resuming the blocked task", async () => {
    const { taskId, sessionName } = createDispatchedTask("Unknown report target");
    dbBlockTask(taskId, { actor: "test", sessionName, message: "waiting on input" });

    await expect(
      dispatchTask(taskId, {
        agentId: "dev",
        sessionName,
        assignedBy: "test",
        reportToSessionName: "missing-report-session",
      }),
    ).rejects.toThrow();

    expect(dbGetTask(taskId)?.status).toBe("blocked");
    expect(publishCalls).toHaveLength(0);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
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
  createTask,
  dbDeleteTask,
  dbDispatchTask,
  dbGetActiveAssignment,
  dbGetTask,
  dispatchTask,
  resolveTaskAssigneeSession,
  TASK_SESSION_THREAD_IDENTITY_CONFLICT,
} = await import("./index.js");

const PARENT_KEY = "agent:dev:slack:slack-main:group:C0ABC123";
const CHILD_KEY = `${PARENT_KEY}:thread:1712345678.123456`;
const CHILD_NAME = "dev-channel-thread";

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-dispatch-thread-identity-");
  publishCalls.length = 0;
  setTaskSessionPromptPublisherForTests(async (sessionName, payload) => {
    publishCalls.push({ sessionName, payload });
  });
  dbCreateAgent({ id: "dev", cwd: join(stateDir, "agent-dev") });
  registerInboundSlackThread({
    parentSessionKey: PARENT_KEY,
    parentSessionName: "dev-channel",
    childSessionKey: CHILD_KEY,
    childSessionName: CHILD_NAME,
    accountId: "slack-main",
    instanceId: "slack-main",
    platformChatId: "C0ABC123",
    threadCanonicalChatId: "chat-thread",
    providerThreadId: "1712345678.123456",
  });
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  dbDeleteAgent("dev");
  setTaskSessionPromptPublisherForTests(undefined);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function newTask(title: string): string {
  const created = createTask({ title, instructions: "Work inside the Slack thread", createdBy: "test" });
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

async function dispatchError(taskId: string, sessionName: string): Promise<unknown> {
  try {
    await dispatchTask(taskId, { agentId: "dev", sessionName, assignedBy: "test" });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("task dispatch into a Slack thread session", () => {
  it("refuses when the open thread's session is gone, and writes no session or assignment", async () => {
    const taskId = newTask("Missing thread child");

    const error = await dispatchError(taskId, CHILD_NAME);

    expect(error).toBeInstanceOf(CliExpectedError);
    expect((error as CliExpectedError).code).toBe(TASK_SESSION_THREAD_IDENTITY_CONFLICT);
    expect((error as CliExpectedError).suggestedAction).toContain("ravi sessions threads --session dev-channel");
    expect(resolveSession(CHILD_NAME)).toBeNull();
    expect(dbGetActiveAssignment(taskId)).toBeNull();
    expect(publishCalls).toHaveLength(0);
  });

  it("refuses when the name already resolves to a session under a bare key", async () => {
    const taskId = newTask("Shadowed thread child");
    getOrCreateSession(CHILD_NAME, "dev", join(stateDir ?? "", "agent-dev"), { name: CHILD_NAME });

    const error = await dispatchError(taskId, CHILD_NAME);

    expect((error as CliExpectedError).code).toBe(TASK_SESSION_THREAD_IDENTITY_CONFLICT);
    expect((error as CliExpectedError).message).toContain(`not ${CHILD_KEY}`);
    expect(publishCalls).toHaveLength(0);
  });

  it("dispatches into the thread's own session", async () => {
    const taskId = newTask("Live thread child");
    getOrCreateSession(CHILD_KEY, "dev", join(stateDir ?? "", "agent-dev"), { name: CHILD_NAME });

    const result = await dispatchTask(taskId, { agentId: "dev", sessionName: CHILD_NAME, assignedBy: "test" });

    expect(result.sessionName).toBe(CHILD_NAME);
    expect(resolveSession(CHILD_NAME)?.sessionKey).toBe(CHILD_KEY);
    expect(publishCalls).toHaveLength(1);
  });

  it("does not recreate a vanished thread session for the assignee", () => {
    const taskId = newTask("Assignee in a vanished thread");
    dbDispatchTask(taskId, { agentId: "dev", sessionName: CHILD_NAME, assignedBy: "test" });

    const task = dbGetTask(taskId);
    if (!task) throw new Error(`missing task ${taskId}`);
    const target = resolveTaskAssigneeSession(task);

    expect(target.ok).toBe(false);
    expect(target.ok ? "" : target.reason).toContain("open thread");
    expect(resolveSession(CHILD_NAME)).toBeNull();
  });
});

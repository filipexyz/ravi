import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbCreateAgent, type ContextCapability } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());
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
const { TaskCommands } = await import("../cli/commands/tasks.js");
const {
  assertTaskTargetAuthorized,
  createTask,
  dbGetActiveAssignment,
  dbGetTask,
  dbGetTaskLaunchPlan,
  dbListTasks,
  dispatchTask,
  executeTaskStreamCommand,
  getDefaultTaskSessionNameForTask,
  queueTaskLaunch,
} = await import("./index.js");
const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");

let stateDir: string | null = null;
const originalCwd = process.cwd();
const publishCalls: string[] = [];
const PRIVATE_NAME = "worker-private";
const PRIVATE_KEY = "agent:worker:main:private";

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-worker-session-authz-");
  process.chdir(stateDir);
  dbCreateAgent({ id: "worker", cwd: join(stateDir, "worker") });
  getOrCreateSession("agent:worker:main:current", "worker", stateDir, { name: "worker-current" });
  getOrCreateSession(PRIVATE_KEY, "worker", stateDir, { name: PRIVATE_NAME });
  publishCalls.length = 0;
  setTaskSessionPromptPublisherForTests(async (session) => {
    publishCalls.push(session);
  });
});
afterEach(async () => {
  setTaskSessionPromptPublisherForTests(undefined);
  process.chdir(originalCwd);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function caller(extra: ContextCapability[] = []): ToolContext {
  return {
    agentId: "worker",
    sessionName: "worker-current",
    sessionKey: "agent:worker:main:current",
    context: {
      contextId: "test-worker-context",
      contextKey: "test-worker-key",
      kind: "agent-runtime",
      agentId: "worker",
      sessionName: "worker-current",
      sessionKey: "agent:worker:main:current",
      createdAt: 0,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "tasks" }, ...extra],
    },
  };
}
function newTask(dependsOnTaskIds?: string[]) {
  return createTask({
    title: "Scoped work",
    instructions: "Only run in an authorized worker session",
    createdByAgentId: "worker",
    createdBySessionName: "worker-current",
    dependsOnTaskIds,
  }).task;
}
function dispatchCli(taskId: string, session?: string, execute = true) {
  const args: unknown[] = [taskId, "worker", session];
  args[6] = true;
  args[14] = execute;
  return (new TaskCommands().dispatch as (...values: unknown[]) => Promise<unknown>)(...args);
}

describe("worker session authorization", () => {
  it("refuses same-agent existing targets by name and key, even with read access", () => {
    for (const ref of [PRIVATE_NAME, PRIVATE_KEY]) {
      for (const extra of [[], [{ permission: "access", objectType: "session", objectId: ref }]]) {
        expect(() =>
          runWithContext(caller(extra), () =>
            assertTaskTargetAuthorized({ agentId: "worker", workerSessionName: ref }),
          ),
        ).toThrow("Worker session not found");
      }
    }
  });

  it("accepts the current session, fresh targets and explicit modify grants by either alias", () => {
    runWithContext(caller(), () => {
      assertTaskTargetAuthorized({ agentId: "worker", workerSessionName: "worker-current" });
      assertTaskTargetAuthorized({ agentId: "worker", workerSessionName: "brand-new-work" });
    });
    for (const grant of [PRIVATE_NAME, PRIVATE_KEY]) {
      for (const target of [PRIVATE_NAME, PRIVATE_KEY]) {
        runWithContext(caller([{ permission: "modify", objectType: "session", objectId: grant }]), () =>
          assertTaskTargetAuthorized({ agentId: "worker", workerSessionName: target }),
        );
      }
    }
  });

  it("rejects create --session before inserting a task or publishing instructions", async () => {
    const before = dbListTasks({}).length;
    await expect(
      runWithContext(caller(), () =>
        new TaskCommands().create(
          "Unauthorized create",
          "Do not publish this",
          "normal",
          undefined,
          "worker",
          undefined,
          PRIVATE_NAME,
        ),
      ),
    ).rejects.toThrow("Worker session not found");
    expect(dbListTasks({})).toHaveLength(before);
    expect(publishCalls).toHaveLength(0);
  });

  it("rejects dispatch --session before any assignment or publication", async () => {
    const task = newTask();
    await expect(runWithContext(caller(), () => dispatchCli(task.id, PRIVATE_KEY))).rejects.toThrow(
      "Worker session not found",
    );
    expect(dbGetTask(task.id)?.status).toBe("open");
    expect(dbGetActiveAssignment(task.id)).toBeNull();
    expect(publishCalls).toHaveLength(0);
  });

  it("checks a resolved default session even in a dispatch preview", async () => {
    const task = newTask();
    getOrCreateSession("agent:worker:main:collision", "worker", stateDir!, {
      name: getDefaultTaskSessionNameForTask(task),
    });
    await expect(runWithContext(caller(), () => dispatchCli(task.id, undefined, false))).rejects.toThrow(
      "Worker session not found",
    );
    expect(dbGetActiveAssignment(task.id)).toBeNull();
    expect(publishCalls).toHaveLength(0);
  });

  it("enforces the worker target in direct dispatch and deferred launch plans", async () => {
    const ready = newTask();
    const dependent = newTask([ready.id]);
    const input = { agentId: "worker", sessionName: PRIVATE_NAME, assignedBy: "worker-current" };
    await expect(runWithContext(caller(), () => dispatchTask(ready.id, input))).rejects.toThrow(
      "Worker session not found",
    );
    await expect(runWithContext(caller(), () => queueTaskLaunch(dependent.id, input))).rejects.toThrow(
      "Worker session not found",
    );
    expect(dbGetTask(ready.id)?.status).toBe("open");
    expect(dbGetActiveAssignment(ready.id)).toBeNull();
    expect(dbGetTaskLaunchPlan(dependent.id)).toBeNull();
    expect(publishCalls).toHaveLength(0);
  });

  it("checks stream task.create before persisting its work", async () => {
    const before = dbListTasks({}).length;
    await expect(
      runWithContext(caller(), () =>
        executeTaskStreamCommand("task.create", {
          title: "Stream work",
          instructions: "Do not publish",
          agentId: "worker",
          sessionName: PRIVATE_NAME,
        }),
      ),
    ).rejects.toThrow("Worker session not found");
    expect(dbListTasks({})).toHaveLength(before);
    expect(publishCalls).toHaveLength(0);
  });

  it("allows a fresh worker session without a grant on a nonexistent session", async () => {
    const task = newTask();
    const result = await runWithContext(caller(), () =>
      dispatchTask(task.id, {
        agentId: "worker",
        sessionName: "fresh-worker",
        assignedBy: "worker-current",
      }),
    );
    expect(result.sessionName).toBe("fresh-worker");
    expect(publishCalls).toEqual(["fresh-worker"]);
  });

  it("allows a dispatch with an explicit session write grant", async () => {
    const task = newTask();
    const result = await runWithContext(
      caller([{ permission: "modify", objectType: "session", objectId: PRIVATE_KEY }]),
      () => dispatchTask(task.id, { agentId: "worker", sessionName: PRIVATE_NAME, assignedBy: "worker-current" }),
    );
    expect(result.sessionName).toBe(PRIVATE_NAME);
    expect(publishCalls).toEqual([PRIVATE_NAME]);
  });
});

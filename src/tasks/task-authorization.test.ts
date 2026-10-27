import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent } from "../router/router-db.js";
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

const {
  answerTaskDecision,
  archiveTask,
  assertTaskTargetAuthorized,
  blockTask,
  completeTask,
  createTask,
  dbDecideTask,
  dbDispatchTask,
  dbGetTask,
  failTask,
  isTaskVisibleToCaller,
  reportTaskProgress,
} = await import("./index.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-authz-test-");
  for (const id of ["dev", "intruder"]) dbCreateAgent({ id, cwd: join(stateDir, `agent-${id}`) });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function agentTurn(agentId: string, sessionName: string, extra: string[] = []): ToolContext {
  const capabilities: ContextCapability[] = [
    { permission: "execute", objectType: "group", objectId: "tasks", source: "test" },
    ...extra.map((value) => {
      const [permission, objectType, objectId] = value.split(":");
      return { permission: permission!, objectType: objectType!, objectId: objectId!, source: "test" };
    }),
  ];
  return {
    contextId: `ctx_${agentId}`,
    agentId,
    sessionKey: sessionName,
    sessionName,
    context: {
      contextId: `ctx_${agentId}`,
      contextKey: `rctx_${agentId}`,
      kind: "agent-runtime",
      agentId,
      sessionKey: sessionName,
      sessionName,
      capabilities,
      createdAt: 0,
    },
  };
}

function seedDispatchedTask(): { taskId: string; sessionName: string } {
  const created = createTask({
    title: "Owned work",
    instructions: "Only dev and its dispatcher may move this task",
    createdBy: "main",
    createdByAgentId: "main",
  });
  const sessionName = `${created.task.id}-work`;
  dbDispatchTask(created.task.id, { agentId: "dev", sessionName, assignedBy: "main", assignedByAgentId: "main" });
  return { taskId: created.task.id, sessionName };
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("task lifecycle mutations are bound to the task", () => {
  it("refuses an unrelated agent and leaves the task untouched", async () => {
    const { taskId } = seedDispatchedTask();
    dbDecideTask(taskId, { key: "window", ask: "When?", ownerType: "agent", ownerId: "main", actor: "main" });
    const intruder = agentTurn("intruder", "intruder-main");
    const input = { actor: "intruder-main", agentId: "intruder", sessionName: "intruder-main", message: "x" };

    await runWithContext(intruder, async () => {
      for (const attempt of [
        () => failTask(taskId, input),
        () => blockTask(taskId, input),
        () => archiveTask(taskId, { ...input, reason: "x" }),
        () => reportTaskProgress(taskId, input),
        () => answerTaskDecision(taskId, { key: "window", answer: "now", ...input }),
      ]) {
        expect(String(errorOf(attempt))).toContain(`Task not found: ${taskId}`);
      }
      await expect(completeTask(taskId, input)).rejects.toThrow(`Task not found: ${taskId}`);
    });
    expect(dbGetTask(taskId)?.status).toBe("dispatched");
  });

  it("lets the assignee from another of its sessions and the dispatcher act", async () => {
    const { taskId } = seedDispatchedTask();
    runWithContext(agentTurn("dev", "dev-main"), () =>
      reportTaskProgress(taskId, {
        actor: "dev-main",
        agentId: "dev",
        sessionName: "dev-main",
        message: "Halfway through the migration",
      }),
    );
    runWithContext(agentTurn("main", "main-main"), () =>
      blockTask(taskId, { actor: "main-main", agentId: "main", sessionName: "main-main", message: "wait" }),
    );
    expect(dbGetTask(taskId)?.status).toBe("blocked");
  });

  it("accepts an explicit task grant", () => {
    const { taskId } = seedDispatchedTask();
    runWithContext(agentTurn("intruder", "intruder-main", [`mutate:task:${taskId}`]), () =>
      failTask(taskId, { actor: "intruder-main", agentId: "intruder", sessionName: "intruder-main", message: "x" }),
    );
    expect(dbGetTask(taskId)?.status).toBe("failed");
  });
});

describe("task visibility and targets", () => {
  it("hides other agents' tasks unless the caller can view an owner", () => {
    const { taskId } = seedDispatchedTask();
    const task = dbGetTask(taskId)!;
    expect(runWithContext(agentTurn("intruder", "intruder-main"), () => isTaskVisibleToCaller(task))).toBe(false);
    expect(runWithContext(agentTurn("dev", "dev-main"), () => isTaskVisibleToCaller(task))).toBe(true);
    expect(
      runWithContext(agentTurn("intruder", "intruder-main", ["view:agent:dev"]), () => isTaskVisibleToCaller(task)),
    ).toBe(true);
    expect(isTaskVisibleToCaller(task)).toBe(true);
  });

  it("refuses dispatching to another agent or reporting to its session", () => {
    const intruder = agentTurn("intruder", "intruder-main");
    runWithContext(intruder, () => {
      expect(errorOf(() => assertTaskTargetAuthorized({ agentId: "dev" }))).toMatchObject({
        code: "TASK_AGENT_NOT_FOUND",
      });
      expect(errorOf(() => assertTaskTargetAuthorized({ reportToSessionName: "dev-main" }))).toMatchObject({
        code: "REPORT_TARGET_NOT_FOUND",
      });
      expect(errorOf(() => assertTaskTargetAuthorized({ actorSessionName: "dev-main" }))).toMatchObject({
        code: "SESSION_NOT_FOUND",
      });
      assertTaskTargetAuthorized({ agentId: "intruder", reportToSessionName: "intruder-main" });
    });
    runWithContext(agentTurn("intruder", "intruder-main", ["modify:agent:dev"]), () =>
      assertTaskTargetAuthorized({ agentId: "dev" }),
    );
  });
});

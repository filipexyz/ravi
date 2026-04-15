import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedTopics: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishedPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const createdTaskIds: string[] = [];
let stateDir: string | null = null;

mock.module("../nats.js", () => ({
  getNats: mock(() => ({})),
  nats: {
    emit: async (topic: string, data: Record<string, unknown>) => {
      emittedTopics.push({ topic, data });
    },
  },
}));

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: async (sessionName: string, payload: Record<string, unknown>) => {
    publishedPrompts.push({ sessionName, payload });
  },
}));

const { blockTask, completeTask, emitTaskEvent } = await import("./service.js");
const { dbCreateTask, dbDeleteTask, dbDispatchTask } = await import("./task-db.js");

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-notify-test-");
});

afterEach(async () => {
  emittedTopics.length = 0;
  publishedPrompts.length = 0;
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe.skip("task completion notify", () => {
  it("publishes the default completion report to the creator session on task.done", async () => {
    const created = dbCreateTask({
      title: "Notify smoke",
      instructions: "Ensure task.done reports back to the creator session by default",
      createdBy: "creator",
      createdByAgentId: "main",
      createdBySessionName: "creator-session",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "dispatcher",
      assignedByAgentId: "main",
      assignedBySessionName: "dispatcher-session",
    });

    const completed = await completeTask(created.task.id, {
      actor: `${created.task.id}-work`,
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "feito",
    });

    await emitTaskEvent(completed.task, completed.event);

    expect(emittedTopics).toHaveLength(1);
    expect(emittedTopics[0]?.topic).toBe(`ravi.task.${created.task.id}.event`);
    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toBe("creator-session");
    expect(publishedPrompts[0]?.payload.deliveryBarrier).toBe("after_response");
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain(`[from: ${created.task.id}-work]`);
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain(`Task concluída: ${created.task.id}`);
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain("Responsável: dev");
  });

  it("publishes blocked reports only when the explicit report events include blocked", async () => {
    const created = dbCreateTask({
      title: "Blocked notify smoke",
      instructions: "Ensure blocked reports use explicit configuration only",
      createdBy: "creator",
      createdByAgentId: "main",
      createdBySessionName: "creator-session",
      reportToSessionName: "ops-session",
      reportEvents: ["blocked", "failed"],
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "dispatcher",
      assignedByAgentId: "main",
      assignedBySessionName: "dispatcher-session",
    });

    const blocked = blockTask(created.task.id, {
      actor: `${created.task.id}-work`,
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "aguardando aprovacao externa",
      progress: 60,
    });

    await emitTaskEvent(blocked.task, blocked.event);

    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toBe("ops-session");
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain(`Task bloqueada: ${created.task.id}`);
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain("Blocker: aguardando aprovacao externa");
  });
});

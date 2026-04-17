import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getRecentHistory } from "../db.js";

const promptCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const taskCommentCalls: Array<{ taskId: string; payload: Record<string, unknown> }> = [];
const actualTasksIndexModule = await import("../tasks/index.js");

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    promptCalls.push({ sessionName, payload });
  }),
}));

mock.module("../tasks/index.js", () => ({
  ...actualTasksIndexModule,
  commentTask: mock(async (taskId: string, payload: Record<string, unknown>) => {
    taskCommentCalls.push({ taskId, payload });
    return {};
  }),
  listTasks: () => [],
}));

const { dbCreateHook, dbDeleteHook, dbGetHook, runHookById } = await import("./index.js");

const createdHookIds: string[] = [];

beforeEach(() => {
  promptCalls.length = 0;
  taskCommentCalls.length = 0;
});

afterEach(() => {
  while (createdHookIds.length > 0) {
    const id = createdHookIds.pop();
    if (id) {
      dbDeleteHook(id);
    }
  }
});

describe("hooks-runtime runner", () => {
  it("executes inject_context and persists fire state", async () => {
    const created = dbCreateHook({
      name: "session bridge",
      eventName: "SessionStart",
      scopeType: "session",
      scopeValue: "hook-session",
      actionType: "inject_context",
      actionPayload: {
        message: "workspace ready for {{sessionName}}",
      },
    });
    createdHookIds.push(created.id);

    const result = await runHookById(created.id, {
      eventName: "SessionStart",
      source: "test",
      sessionName: "hook-session",
      agentId: "dev",
      cwd: process.cwd(),
    });

    expect(result.skipped).toBeUndefined();
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      sessionName: "hook-session",
      payload: expect.objectContaining({
        prompt: "[System] Inform: workspace ready for hook-session",
        _hook: true,
        _hookId: created.id,
      }),
    });

    const stored = dbGetHook(created.id);
    expect(stored?.fireCount).toBe(1);
    expect(typeof stored?.lastFiredAt).toBe("number");
  });

  it("dedupes append_history hooks with the same resolved key", async () => {
    const sessionName = `history-${Date.now()}`;
    const created = dbCreateHook({
      name: "observer",
      eventName: "PostToolUse",
      scopeType: "session",
      scopeValue: sessionName,
      actionType: "append_history",
      actionPayload: {
        message: "tool={{toolName}} path={{path}}",
      },
      dedupeKey: "{{eventName}}:{{sessionName}}:{{path}}",
    });
    createdHookIds.push(created.id);

    const event = {
      eventName: "PostToolUse" as const,
      source: "test",
      sessionName,
      agentId: "dev",
      cwd: process.cwd(),
      path: `${process.cwd()}/src/file.ts`,
      toolName: "Write",
      toolInput: { file_path: "src/file.ts" },
    };

    const first = await runHookById(created.id, event);
    const second = await runHookById(created.id, event);

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe("dedupe");

    const messages = getRecentHistory(sessionName, 10).filter((message) => message.content.includes("tool=Write"));
    expect(messages).toHaveLength(1);
  });

  it("routes comment_task to the resolved task target", async () => {
    const created = dbCreateHook({
      name: "task observer",
      eventName: "Stop",
      scopeType: "task",
      scopeValue: "task-abc",
      actionType: "comment_task",
      actionPayload: {
        body: "hook saw {{eventName}} for {{taskId}}",
      },
    });
    createdHookIds.push(created.id);

    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      sessionName: "task-abc-work",
      taskId: "task-abc",
      agentId: "dev",
      cwd: process.cwd(),
    });

    expect(taskCommentCalls).toEqual([
      {
        taskId: "task-abc",
        payload: expect.objectContaining({
          body: "hook saw Stop for task-abc",
        }),
      },
    ]);
  });
});
afterAll(() => mock.restore());

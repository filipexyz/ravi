import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");

const createdHooks: Array<Record<string, unknown>> = [];
const updatedHooks: Array<{ id: string; patch: Record<string, unknown> }> = [];
const refreshCalls: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => ({ agentId: "dev", sessionName: "task-123-work" }),
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../cron/schedule.js", () => ({
  parseDurationMs: () => 5000,
  formatDurationMs: () => "5s",
}));

mock.module("../../hooks-runtime/index.js", () => ({
  HOOK_EVENT_NAMES: ["SessionStart", "PreToolUse", "PostToolUse", "CwdChanged", "FileChanged", "Stop"],
  HOOK_SCOPE_TYPES: ["global", "agent", "session", "workspace", "task"],
  HOOK_ACTION_TYPES: ["inject_context", "send_session_event", "append_history", "comment_task"],
  dbCreateHook: (input: Record<string, unknown>) => {
    createdHooks.push(input);
    return {
      id: "hook-1",
      name: input.name,
      eventName: input.eventName,
      scopeType: input.scopeType,
      scopeValue: input.scopeValue,
      actionType: input.actionType,
      actionPayload: input.actionPayload,
      matcher: input.matcher,
      enabled: input.enabled,
      async: input.async,
      cooldownMs: input.cooldownMs,
      dedupeKey: input.dedupeKey,
      fireCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
  dbDeleteHook: () => true,
  dbGetHook: (id: string) =>
    id === "hook-1"
      ? {
          id,
          name: "bridge",
          eventName: "FileChanged",
          scopeType: "workspace",
          scopeValue: "/tmp/work",
          actionType: "inject_context",
          actionPayload: { message: "hello" },
          enabled: false,
          async: false,
          cooldownMs: 5000,
          fireCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : null,
  dbListHooks: () => [],
  dbUpdateHook: (id: string, patch: Record<string, unknown>) => {
    updatedHooks.push({ id, patch });
  },
  emitHookRefresh: mock(async () => {
    refreshCalls.push({});
  }),
  runHookById: mock(async () => ({
    hookId: "hook-1",
    hookName: "bridge",
    eventName: "FileChanged",
  })),
}));

const { HooksCommands } = await import("./hooks.js");

describe("HooksCommands", () => {
  beforeEach(() => {
    createdHooks.length = 0;
    updatedHooks.length = 0;
    refreshCalls.length = 0;
  });

  it("creates a workspace-scoped hook and infers the action payload", async () => {
    const commands = new HooksCommands();

    await commands.create(
      "workspace bridge",
      "FileChanged",
      "inject_context",
      "**/*.ts",
      undefined,
      undefined,
      undefined,
      "/tmp/work",
      undefined,
      "bridge {{path}}",
      undefined,
      undefined,
      undefined,
      undefined,
      "5s",
      "{{path}}",
      true,
      false,
    );

    expect(createdHooks).toEqual([
      expect.objectContaining({
        name: "workspace bridge",
        eventName: "FileChanged",
        scopeType: "workspace",
        scopeValue: "/tmp/work",
        matcher: "**/*.ts",
        actionType: "inject_context",
        actionPayload: {
          message: "bridge {{path}}",
        },
        async: true,
        cooldownMs: 5000,
        dedupeKey: "{{path}}",
      }),
    ]);
    expect(refreshCalls).toHaveLength(1);
  });

  it("enables a hook and emits refresh", async () => {
    const commands = new HooksCommands();
    await commands.enable("hook-1");

    expect(updatedHooks).toEqual([{ id: "hook-1", patch: { enabled: true } }]);
    expect(refreshCalls).toHaveLength(1);
  });
});

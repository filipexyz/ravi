import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");

const createdHooks: Array<Record<string, unknown>> = [];
const updatedHooks: Array<{ id: string; patch: Record<string, unknown> }> = [];
const refreshCalls: Array<Record<string, unknown>> = [];
const deletedHooks: string[] = [];
let listedHooks: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => ({ agentId: "dev", sessionName: "task-123-work" }),
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
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
  dbDeleteHook: (id: string) => {
    deletedHooks.push(id);
    return true;
  },
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
  dbListHooks: () => listedHooks,
  dbUpdateHook: (id: string, patch: Record<string, unknown>) => {
    updatedHooks.push({ id, patch });
    return {
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
      createdAt: 1,
      updatedAt: 2,
      ...patch,
    };
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
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

async function captureJson(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

describe("HooksCommands", () => {
  beforeEach(() => {
    createdHooks.length = 0;
    updatedHooks.length = 0;
    refreshCalls.length = 0;
    deletedHooks.length = 0;
    listedHooks = [];
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

  it("prints enabled hook data in --json mode", async () => {
    const commands = new HooksCommands();

    const payload = await captureJson(() => commands.enable("hook-1", true));

    expect(payload).toMatchObject({
      status: "enabled",
      target: { type: "hook", id: "hook-1" },
      changedCount: 1,
      hook: {
        id: "hook-1",
        enabled: true,
        scope: "workspace:/tmp/work",
        cooldownDescription: "5s",
      },
    });
    expect(refreshCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2): write brake on `rm` (the only destructive
// op), HOOK_NOT_FOUND envelope (exit 1 + suggestions) and compact --fields.
// ---------------------------------------------------------------------------

describe("HooksCommands agent-first contract", () => {
  beforeEach(() => {
    createdHooks.length = 0;
    updatedHooks.length = 0;
    refreshCalls.length = 0;
    deletedHooks.length = 0;
    listedHooks = [];
  });

  it("rm without --execute is a dry-run: exit 3, plan shown, NO delete and NO refresh", async () => {
    const commands = new HooksCommands();
    const error = await expectContractError(
      () => commands.remove("hook-1", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      hookId: "hook-1",
      name: "bridge",
      eventName: "FileChanged",
      scope: "workspace:/tmp/work",
      actionType: "inject_context",
    });
    expect(deletedHooks).toHaveLength(0);
    expect(refreshCalls).toHaveLength(0);
  });

  it("rm with --execute deletes the hook and emits refresh", async () => {
    const commands = new HooksCommands();
    const payload = await captureJson(() => commands.remove("hook-1", true, true));

    expect(payload).toMatchObject({
      status: "deleted",
      target: { type: "hook", id: "hook-1" },
      changedCount: 1,
    });
    expect(deletedHooks).toEqual(["hook-1"]);
    expect(refreshCalls).toHaveLength(1);
  });

  it("rm on an unknown hook exits 1 with HOOK_NOT_FOUND and suggestions from the local list, before the brake", async () => {
    listedHooks = [
      { id: "hook-1", name: "bridge" },
      { id: "hook-2", name: "observer" },
    ];

    const commands = new HooksCommands();
    const error = await expectContractError(() => commands.remove("bridg", true, undefined), "HOOK_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("bridge");
    expect(error.details.suggestedAction).toContain("ravi hooks list");
    expect(deletedHooks).toHaveLength(0);
  });

  it("show on an unknown hook exits 1 with HOOK_NOT_FOUND", async () => {
    const commands = new HooksCommands();
    await expectContractError(() => commands.show("nope", true), "HOOK_NOT_FOUND", 1);
  });

  it("enable/disable on an unknown hook exit 1 with HOOK_NOT_FOUND and write nothing", async () => {
    const commands = new HooksCommands();
    await expectContractError(() => commands.enable("nope", true), "HOOK_NOT_FOUND", 1);
    await expectContractError(() => commands.disable("nope", true), "HOOK_NOT_FOUND", 1);

    expect(updatedHooks).toHaveLength(0);
    expect(refreshCalls).toHaveLength(0);
  });

  it("list --fields narrows each item to the requested fields", async () => {
    listedHooks = [
      {
        id: "hook-1",
        name: "bridge",
        eventName: "FileChanged",
        scopeType: "workspace",
        scopeValue: "/tmp/work",
        actionType: "inject_context",
        actionPayload: { message: "hello" },
        enabled: true,
        async: false,
        cooldownMs: 5000,
        fireCount: 0,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "hook-2",
        name: "observer",
        eventName: "PostToolUse",
        scopeType: "global",
        scopeValue: undefined,
        actionType: "append_history",
        actionPayload: { message: "x" },
        enabled: false,
        async: true,
        cooldownMs: 0,
        fireCount: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const commands = new HooksCommands();
    const payload = await captureJson(async () =>
      commands.list(true, undefined, undefined, undefined, "id,name,enabled"),
    );

    expect(payload.total).toBe(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["enabled", "id", "name"]);
    }
  });
});

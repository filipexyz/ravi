import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

type RequestReplyCall = {
  topic: string;
  data: Record<string, unknown>;
  timeoutMs?: number;
};

let requestReplyCalls: RequestReplyCall[] = [];
let requestReplyResult: Record<string, unknown> = {};
let resolvedSession: Record<string, unknown> | null = null;
let scopeEnforced = false;
let canAccess = true;
let canModify = true;

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
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../utils/request-reply.js", () => ({
  requestReply: mock(async (topic: string, data: Record<string, unknown>, timeoutMs?: number) => {
    requestReplyCalls.push({ topic, data, timeoutMs });
    return requestReplyResult;
  }),
}));

mock.module("../../router/sessions.js", () => ({
  resolveSession: () => resolvedSession,
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => ({ agentId: "dev" }),
  isScopeEnforced: () => scopeEnforced,
  canAccessSession: () => canAccess,
  canModifySession: () => canModify,
}));

const { SessionRuntimeCommands } = await import("./sessions-runtime.js");
const { ContractError } = await import("../agent-contract.js");
const {
  runtimeThreadForkReturnSchema,
  runtimeThreadListReturnSchema,
  runtimeThreadReadReturnSchema,
  runtimeThreadRollbackReturnSchema,
  runtimeTurnFollowUpReturnSchema,
  runtimeTurnInterruptReturnSchema,
  runtimeTurnSteerReturnSchema,
} = await import("./operational-return-schemas.js");
type SessionRuntimeCommandsInstance = InstanceType<typeof SessionRuntimeCommands>;

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const result = await run();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

describe("SessionRuntimeCommands", () => {
  beforeEach(() => {
    requestReplyCalls = [];
    requestReplyResult = {
      result: {
        ok: true,
        operation: "turn.steer",
        data: { accepted: true },
        state: { provider: "codex", threadId: "thread_1", turnId: "turn_1", activeTurn: true },
      },
    };
    resolvedSession = {
      sessionKey: "agent:dev:main",
      name: "dev-main",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    scopeEnforced = false;
    canAccess = true;
    canModify = true;
  });

  it("maps steer to a runtime control request through NATS", async () => {
    const commands = new SessionRuntimeCommands();

    const { result, output } = await captureLogs(() =>
      commands.steer("dev-main", "use this detail", "thread_1", "turn_1", "turn_1", true),
    );

    expect(result.ok).toBe(true);
    expect(output).toContain('"operation": "turn.steer"');
    expect(requestReplyCalls).toHaveLength(1);
    expect(requestReplyCalls[0]?.topic).toBe("ravi.session.runtime.control");
    expect(requestReplyCalls[0]?.timeoutMs).toBe(15000);
    expect(requestReplyCalls[0]?.data).toMatchObject({
      sessionName: "dev-main",
      sessionKey: "agent:dev:main",
      request: {
        operation: "turn.steer",
        text: "use this detail",
        threadId: "thread_1",
        turnId: "turn_1",
        expectedTurnId: "turn_1",
      },
    });
  });

  it("maps follow-up to a runtime control request through NATS", async () => {
    requestReplyResult = {
      result: {
        ok: true,
        operation: "turn.follow_up",
        data: { accepted: true },
        state: { provider: "pi", activeTurn: true },
      },
    };
    const commands = new SessionRuntimeCommands();

    const { result, output } = await captureLogs(() =>
      commands.followUp("dev-main", "faz isso depois", "thread_1", "turn_1", "turn_1", true, true),
    );

    expect(result.ok).toBe(true);
    expect(output).toContain('"operation": "turn.follow_up"');
    expect(requestReplyCalls).toHaveLength(1);
    expect(requestReplyCalls[0]?.topic).toBe("ravi.session.runtime.control");
    expect(requestReplyCalls[0]?.data).toMatchObject({
      sessionName: "dev-main",
      sessionKey: "agent:dev:main",
      request: {
        operation: "turn.follow_up",
        text: "faz isso depois",
        threadId: "thread_1",
        turnId: "turn_1",
        expectedTurnId: "turn_1",
      },
    });
  });

  it("brakes follow-up before requesting runtime control when --execute is absent", async () => {
    const commands = new SessionRuntimeCommands();
    const text = "segredo-nao-deve-aparecer";
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await commands.followUp("dev-main", text, "thread_1", "turn_1", "turn_1", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    expect(contractError.op).toBe("sessions runtime follow-up");
    const envelope = contractError.envelope();
    expect(JSON.stringify(envelope)).not.toContain(text);
    expect(envelope.error.plan).toMatchObject({
      operation: "turn.follow_up",
      threadId: "thread_1",
      turnId: "turn_1",
      expectedTurnId: "turn_1",
      textLength: text.length,
    });
    expect(requestReplyCalls).toHaveLength(0);
  });

  it("resolves the session before applying the follow-up brake", async () => {
    resolvedSession = null;
    const commands = new SessionRuntimeCommands();

    await expect(
      commands.followUp("missing", "faz isso depois", undefined, undefined, undefined, true),
    ).rejects.toThrow("Session not found: missing");
    expect(requestReplyCalls).toHaveLength(0);
  });

  it.each([
    ["rollback", (commands: SessionRuntimeCommandsInstance) => commands.rollback("dev-main", "1", undefined, true)],
    [
      "fork",
      (commands: SessionRuntimeCommandsInstance) => commands.fork("dev-main", undefined, undefined, undefined, true),
    ],
  ])("brakes %s before requesting runtime control when --execute is absent", async (operation, run) => {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await run(new SessionRuntimeCommands());
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as InstanceType<typeof ContractError>).exitCode).toBe(3);
    expect((thrown as InstanceType<typeof ContractError>).op).toBe(`sessions runtime ${operation}`);
    expect(requestReplyCalls).toHaveLength(0);
  });

  it.each([
    [
      "rollback",
      (commands: SessionRuntimeCommandsInstance): Promise<unknown> =>
        commands.rollback("dev-main", "1", undefined, true, true),
      "thread.rollback",
    ],
    [
      "fork",
      (commands: SessionRuntimeCommandsInstance): Promise<unknown> =>
        commands.fork("dev-main", undefined, undefined, undefined, true, true),
      "thread.fork",
    ],
  ])("sends %s to runtime control with --execute", async (_operation, run, runtimeOperation) => {
    requestReplyResult = {
      result: {
        ok: true,
        operation: runtimeOperation,
        data: { accepted: true },
        state: { provider: "codex" },
      },
    };

    await captureLogs(() => run(new SessionRuntimeCommands()));

    expect(requestReplyCalls).toHaveLength(1);
    expect(requestReplyCalls[0]?.data).toMatchObject({ request: { operation: runtimeOperation } });
  });

  it("maps list filters to thread.list without requiring modify access", async () => {
    scopeEnforced = true;
    canAccess = true;
    canModify = false;
    requestReplyResult = {
      result: {
        ok: true,
        operation: "thread.list",
        data: { threads: [] },
        state: { provider: "codex", supportedOperations: ["thread.list"] },
      },
    };
    const commands = new SessionRuntimeCommands();

    const { result } = await captureLogs(() =>
      commands.list("dev-main", "5", "cursor_1", "/tmp/dev", "term", true, true),
    );

    expect(result.ok).toBe(true);
    expect(requestReplyCalls[0]?.data).toMatchObject({
      request: {
        operation: "thread.list",
        limit: 5,
        cursor: "cursor_1",
        cwd: "/tmp/dev",
        searchTerm: "term",
        archived: true,
      },
    });
  });

  it("requires modify access for rollback", async () => {
    scopeEnforced = true;
    canAccess = true;
    canModify = false;
    const commands = new SessionRuntimeCommands();

    await expect(commands.rollback("dev-main", "1")).rejects.toThrow("Session not found: dev-main");
    expect(requestReplyCalls).toHaveLength(0);
  });

  it("keeps interrupt immediate without --execute", async () => {
    requestReplyResult = {
      result: {
        ok: true,
        operation: "turn.interrupt",
        data: { accepted: true },
        state: { provider: "codex", activeTurn: true },
      },
    };
    const commands = new SessionRuntimeCommands();

    await captureLogs(() => commands.interrupt("dev-main", undefined, undefined, true));

    expect(requestReplyCalls).toHaveLength(1);
    expect(requestReplyCalls[0]?.data).toMatchObject({ request: { operation: "turn.interrupt" } });
  });
});

describe("SessionRuntimeCommands return contracts", () => {
  beforeEach(() => {
    requestReplyCalls = [];
    resolvedSession = {
      sessionKey: "agent:dev:main",
      name: "dev-main",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    scopeEnforced = false;
    canAccess = true;
    canModify = true;
  });

  function reply(result: Record<string, unknown>) {
    requestReplyResult = { result };
  }

  const codexState = {
    provider: "codex",
    threadId: "thread_1",
    turnId: "turn_1",
    activeTurn: true,
    supportedOperations: ["thread.list", "thread.read", "turn.steer"],
  };

  it("normalizes a native Codex thread list into the strict list contract", async () => {
    reply({
      ok: true,
      operation: "thread.list",
      data: {
        data: [
          {
            id: "thread_1",
            name: "Main thread",
            preview: "hello",
            status: { type: "idle" },
            cwd: "/tmp/dev",
            path: "/tmp/dev/.codex/thread_1.jsonl",
            createdAt: 1700000000,
            updatedAt: 1700000100,
            modelProvider: "openai",
            gitInfo: { branch: "dev" },
          },
          { title: "missing id is dropped" },
        ],
        nextCursor: "cursor_2",
      },
      state: codexState,
    });

    const { result } = await captureLogs(() =>
      new SessionRuntimeCommands().list("dev-main", undefined, undefined, undefined, undefined, undefined, true),
    );

    expect(runtimeThreadListReturnSchema.parse(result)).toEqual({
      ok: true,
      operation: "thread.list",
      provider: "codex",
      state: { ...codexState },
      error: null,
      threads: [
        {
          threadId: "thread_1",
          title: "Main thread",
          preview: "hello",
          status: "idle",
          cwd: "/tmp/dev",
          path: "/tmp/dev/.codex/thread_1.jsonl",
          createdAt: 1700000000,
          updatedAt: 1700000100,
        },
      ],
      nextCursor: "cursor_2",
    });
  });

  it("normalizes thread read turns and keeps human output free of native payloads", async () => {
    reply({
      ok: true,
      operation: "thread.read",
      data: {
        thread: {
          id: "thread_1",
          title: "Control thread",
          turns: [{ id: "turn_1", status: "completed", items: [{ secret: "native item" }] }],
        },
      },
      state: codexState,
    });

    const { result, output } = await captureLogs(() =>
      new SessionRuntimeCommands().read("dev-main", "thread_1", undefined, false),
    );

    const parsed = runtimeThreadReadReturnSchema.parse(result);
    expect(parsed.thread?.threadId).toBe("thread_1");
    expect(parsed.turns).toEqual([{ turnId: "turn_1", status: "completed", startedAt: null, completedAt: null }]);
    expect(output).toContain('"turnId": "turn_1"');
    expect(output).not.toContain("native item");
  });

  it("normalizes steer, follow-up, interrupt, rollback and fork acknowledgements", async () => {
    const commands = new SessionRuntimeCommands();

    reply({
      ok: true,
      operation: "turn.steer",
      data: { response: { type: "response", command: "steer", success: true, queued: true } },
      state: { provider: "pi", threadId: "pi_session", activeTurn: false },
    });
    const steer = await captureLogs(() => commands.steer("dev-main", "detail", undefined, undefined, undefined, true));
    expect(runtimeTurnSteerReturnSchema.parse(steer.result)).toMatchObject({
      operation: "turn.steer",
      accepted: true,
      queued: true,
      threadId: "pi_session",
      turnId: null,
    });

    reply({
      ok: false,
      operation: "turn.follow_up",
      error: "Runtime control 'turn.follow_up' is disabled",
      state: { provider: "pi", activeTurn: true },
    });
    const followUp = await captureLogs(() =>
      commands.followUp("dev-main", "later", undefined, undefined, undefined, true, true),
    );
    expect(runtimeTurnFollowUpReturnSchema.parse(followUp.result)).toMatchObject({
      ok: false,
      operation: "turn.follow_up",
      accepted: false,
      error: "Runtime control 'turn.follow_up' is disabled",
    });

    reply({ ok: true, operation: "turn.interrupt", state: { provider: "grok", threadId: "grok_1", activeTurn: true } });
    const interrupt = await captureLogs(() => commands.interrupt("dev-main", undefined, undefined, true));
    expect(runtimeTurnInterruptReturnSchema.parse(interrupt.result)).toMatchObject({
      interrupted: true,
      pending: false,
      threadId: "grok_1",
    });

    reply({
      ok: true,
      operation: "thread.rollback",
      data: { thread: { id: "thread_1" }, rolledBackTurns: 2 },
      state: codexState,
    });
    const rollback = await captureLogs(() => commands.rollback("dev-main", "2", undefined, true, true));
    expect(runtimeThreadRollbackReturnSchema.parse(rollback.result)).toMatchObject({
      thread: { threadId: "thread_1" },
      rolledBackTurns: 2,
    });

    // A count outside the safe-integer range is not trusted.
    reply({
      ok: true,
      operation: "thread.rollback",
      data: { thread: { id: "thread_1" }, rolledBackTurns: 2 ** 53 },
      state: codexState,
    });
    const unsafeRollback = await captureLogs(() => commands.rollback("dev-main", "2", undefined, true, true));
    expect(runtimeThreadRollbackReturnSchema.parse(unsafeRollback.result).rolledBackTurns).toBeNull();

    reply({
      ok: true,
      operation: "thread.fork",
      data: { thread: { id: "thread_forked", cwd: "/tmp/fork" }, model: "gpt" },
      state: codexState,
    });
    const fork = await captureLogs(() => commands.fork("dev-main", "thread_1", undefined, undefined, true, true));
    expect(runtimeThreadForkReturnSchema.parse(fork.result)).toMatchObject({
      sourceThreadId: "thread_1",
      forkedThreadId: "thread_forked",
      thread: { threadId: "thread_forked", cwd: "/tmp/fork" },
    });
  });

  it("rejects blank steering text before publishing a runtime control request", async () => {
    await expect(
      new SessionRuntimeCommands().steer("dev-main", "   ", undefined, undefined, undefined, true),
    ).rejects.toThrow("Expected non-empty steering text.");
    expect(requestReplyCalls).toHaveLength(0);
  });
});

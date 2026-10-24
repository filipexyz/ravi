import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

type RequestReplyCall = {
  topic: string;
  data: Record<string, unknown>;
  timeoutMs?: number;
};

let requestReplyCalls: RequestReplyCall[] = [];
let requestReplyResult: Record<string, unknown> = {};
let requestReplyError: Error | null = null;
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
    if (requestReplyError) throw requestReplyError;
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
    requestReplyError = null;
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
      (commands: SessionRuntimeCommandsInstance) => commands.rollback("dev-main", "1", undefined, true, true),
      "thread.rollback",
    ],
    [
      "fork",
      (commands: SessionRuntimeCommandsInstance) =>
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

  async function captureError(run: () => Promise<unknown>): Promise<InstanceType<typeof ContractError>> {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await run();
    } catch (error) {
      return error as InstanceType<typeof ContractError>;
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    throw new Error("expected the command to fail");
  }

  it("turns a disabled steer into a typed contract error instead of COMMAND_FAILED", async () => {
    requestReplyResult = {
      result: {
        ok: false,
        operation: "turn.steer",
        code: "RUNTIME_CONTROL_DISABLED",
        retryable: false,
        disabledReason: "durable_input_journal_unavailable",
        error: "Runtime control 'turn.steer' is disabled: durable prompt input journaling is not available yet.",
        state: { provider: "codex", activeTurn: true, turnId: "turn_1" },
      },
    };

    const error = await captureError(() => new SessionRuntimeCommands().steer("dev-main", "corrige isso"));

    expect(error).toBeInstanceOf(ContractError);
    expect(error.op).toBe("sessions runtime steer");
    expect(error.code).toBe("RUNTIME_CONTROL_DISABLED");
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("is disabled");
    expect(error.envelope().error).toMatchObject({
      retryable: false,
      operation: "turn.steer",
      activeTurn: true,
      turnId: "turn_1",
      disabledReason: "durable_input_journal_unavailable",
      suggestedAction: expect.stringContaining("sessions send"),
    });
  });

  it("keeps --json printing the typed result", async () => {
    requestReplyResult = {
      result: { ok: false, operation: "turn.steer", code: "RUNTIME_CONTROL_DISABLED", error: "disabled" },
    };

    const { result, output } = await captureLogs(() =>
      new SessionRuntimeCommands().steer("dev-main", "x", undefined, undefined, undefined, true),
    );

    expect(result).toMatchObject({ ok: false, code: "RUNTIME_CONTROL_DISABLED" });
    expect(output).toContain('"code": "RUNTIME_CONTROL_DISABLED"');
  });

  it("maps a reply timeout to RUNTIME_CONTROL_TIMEOUT without raw text, retryable only for reads", async () => {
    requestReplyError = new Error("Request timeout (15000ms) on ravi.session.runtime.control");

    const read = await captureError(() => new SessionRuntimeCommands().read("dev-main"));
    const interrupt = await captureError(() => new SessionRuntimeCommands().interrupt("dev-main"));

    expect(read).toBeInstanceOf(ContractError);
    expect(read.code).toBe("RUNTIME_CONTROL_TIMEOUT");
    expect(read.envelope().error.retryable).toBe(true);
    expect(interrupt.code).toBe("RUNTIME_CONTROL_TIMEOUT");
    expect(interrupt.envelope().error.retryable).toBe(false);
    expect(read.message).not.toContain("ravi.session.runtime.control");
  });

  it("maps any other reply rejection to RUNTIME_CONTROL_UNAVAILABLE instead of an unhandled error", async () => {
    requestReplyError = new Error("PRIVATE_DAEMON_TEXT");

    const error = await captureError(() => new SessionRuntimeCommands().read("dev-main"));

    expect(error).toBeInstanceOf(ContractError);
    expect(error.code).toBe("RUNTIME_CONTROL_UNAVAILABLE");
    expect(JSON.stringify(error.envelope())).not.toContain("PRIVATE_DAEMON_TEXT");
  });

  it("does not mark a daemon error reply retryable for a mutating control", async () => {
    requestReplyError = new Error("PRIVATE_DAEMON_TEXT");

    const error = await captureError(() =>
      new SessionRuntimeCommands().rollback("dev-main", "1", undefined, false, true),
    );

    expect(error.code).toBe("RUNTIME_CONTROL_UNAVAILABLE");
    expect(error.envelope().error.retryable).toBe(false);
  });

  it("answers a missing session and a session without modify access with the same typed code", async () => {
    resolvedSession = null;
    const missing = await captureError(() => new SessionRuntimeCommands().steer("other", "x"));

    resolvedSession = { sessionKey: "agent:dev:main", name: "other", agentId: "dev" };
    scopeEnforced = true;
    canModify = false;
    const hidden = await captureError(() => new SessionRuntimeCommands().steer("other", "x"));

    expect(missing.code).toBe("SESSION_NOT_FOUND");
    expect(hidden.code).toBe("SESSION_NOT_FOUND");
    expect(hidden.envelope()).toEqual(missing.envelope());
    expect(requestReplyCalls).toHaveLength(0);
  });
});

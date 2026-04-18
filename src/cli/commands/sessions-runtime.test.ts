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
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
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
});

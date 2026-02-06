import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the interrupt/abort/combine flow in RaviBot.
 *
 * 1. abort() is called (not interrupt()) when no tool is running
 * 2. queued messages are combined into a single prompt in the finally block
 * 3. tool-running case queues without aborting
 * 4. abort errors don't emit error responses to the chat
 */

// ── SDK mock that captures abort controllers ────────────────────────────────

let lastQueryAbortController: AbortController | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    const ac: AbortController = opts.options.abortController;
    lastQueryAbortController = ac;

    // Return a Query-like async iterable that blocks until aborted
    const iterable = {
      interrupt: mock(async () => {}),
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<any>>((resolve, reject) => {
              if (ac.signal.aborted) {
                reject(new Error("Claude Code process aborted by user"));
                return;
              }
              const onAbort = () => {
                reject(new Error("Claude Code process aborted by user"));
              };
              ac.signal.addEventListener("abort", onAbort, { once: true });
            });
          },
          return() {
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    return iterable;
  },
}));

mock.module("./notif.js", () => ({
  notif: {
    emit: mock(async () => ({ id: "mock", topic: "mock" })),
    subscribe: mock(async function* () {}),
  },
}));

mock.module("./db.js", () => ({
  saveMessage: mock(() => {}),
  close: mock(() => {}),
}));

mock.module("./prompt-builder.js", () => ({
  buildSystemPrompt: () => "",
  SILENT_TOKEN: "@@SILENT@@",
}));

mock.module("./router/index.js", () => ({
  loadRouterConfig: () => ({
    defaultAgent: "main",
    agents: {
      main: { id: "main", cwd: "~/ravi/main" },
    },
    routes: [],
    settings: {},
  }),
  getOrCreateSession: (key: string, agentId: string) => ({
    sessionKey: key,
    agentId,
    sdkSessionId: null,
  }),
  updateSdkSessionId: mock(() => {}),
  updateTokens: mock(() => {}),
  updateSessionSource: mock(() => {}),
  updateSessionContext: mock(() => {}),
  updateSessionDisplayName: mock(() => {}),
  closeRouterDb: mock(() => {}),
  expandHome: (p: string) => p.replace("~", "/Users/test"),
}));

mock.module("./cli/exports.js", () => ({
  createCliMcpServer: () => ({ name: "ravi-cli" }),
  initCliTools: mock(() => {}),
}));

mock.module("./cli/tool-registry.js", () => ({
  MCP_SERVER: "ravi-cli",
  MCP_PREFIX: "mcp__ravi-cli__",
}));

mock.module("./cli/context.js", () => ({
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("./heartbeat/index.js", () => ({
  HEARTBEAT_OK: "HEARTBEAT_OK",
}));

mock.module("./bash/index.js", () => ({
  createBashPermissionHook: () => () => {},
}));

mock.module("./utils/logger.js", () => {
  const noop = () => loggerChild;
  const loggerChild = { info: noop, warn: noop, error: noop, debug: noop, child: noop };
  return { logger: { child: () => loggerChild, setLevel: noop } };
});

mock.module("./utils/config.js", () => ({}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { RaviBot, type PromptMessage } from "./bot.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createBot(): RaviBot {
  return new RaviBot({
    config: {
      model: "sonnet",
      logLevel: "error",
      apiKey: "fake",
    } as any,
  });
}

function makePrompt(text: string): PromptMessage {
  return {
    prompt: text,
    source: { channel: "whatsapp", accountId: "default", chatId: "test" },
  };
}

// ── Tests: handlePromptImmediate (abort vs interrupt) ───────────────────────

describe("handlePromptImmediate — abort flow", () => {
  let bot: RaviBot;

  beforeEach(() => {
    bot = createBot();
  });

  it("calls abort() when no tool is running", async () => {
    const sessionKey = "agent:main:test-abort";
    const abortController = new AbortController();

    // Inject fake active session
    const activeSession = {
      query: { interrupt: mock(async () => {}) },
      abortController,
      toolRunning: false,
      messageQueue: [] as any[],
      interrupted: false,
      lastActivity: Date.now(),
    };
    (bot as any).activeSessions.set(sessionKey, activeSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("new msg"));

    expect(abortController.signal.aborted).toBe(true);
    expect(activeSession.messageQueue).toHaveLength(1);
    expect(activeSession.messageQueue[0].prompt.prompt).toBe("new msg");
    expect(activeSession.interrupted).toBe(true);
    // interrupt() should NOT have been called
    expect(activeSession.query.interrupt).not.toHaveBeenCalled();
  });

  it("does NOT abort when tool is running — just queues", async () => {
    const sessionKey = "agent:main:test-tool";
    const abortController = new AbortController();

    const activeSession = {
      query: { interrupt: mock(async () => {}) },
      abortController,
      toolRunning: true,
      messageQueue: [] as any[],
      interrupted: false,
      lastActivity: Date.now(),
    };
    (bot as any).activeSessions.set(sessionKey, activeSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("while tool"));

    expect(abortController.signal.aborted).toBe(false);
    expect(activeSession.messageQueue).toHaveLength(1);
    expect(activeSession.interrupted).toBe(false);
  });

  it("queues multiple messages; abort is idempotent", async () => {
    const sessionKey = "agent:main:test-multi";
    const abortController = new AbortController();

    const activeSession = {
      query: { interrupt: mock(async () => {}) },
      abortController,
      toolRunning: false,
      messageQueue: [] as any[],
      interrupted: false,
      lastActivity: Date.now(),
    };
    (bot as any).activeSessions.set(sessionKey, activeSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("msg A"));
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("msg B"));
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("msg C"));

    expect(activeSession.messageQueue).toHaveLength(3);
    expect(activeSession.messageQueue.map((m: any) => m.prompt.prompt)).toEqual([
      "msg A", "msg B", "msg C",
    ]);
  });
});

// ── Tests: finally block combines messages ──────────────────────────────────

describe("processPrompt finally — message combining", () => {
  it("includes original prompt + queued messages when aborted before response", async () => {
    const bot = createBot();
    const sessionKey = "agent:main:combine";
    const captured: PromptMessage[] = [];

    // Intercept processNewPrompt: first call runs the real one, second
    // call (from finally block) captures the combined prompt.
    const realProcessNewPrompt = (bot as any).processNewPrompt.bind(bot);
    let callCount = 0;
    (bot as any).processNewPrompt = async (key: string, prompt: PromptMessage) => {
      callCount++;
      if (callCount === 1) {
        // First call — run the real processNewPrompt (which calls processPrompt)
        // The SDK mock blocks in for-await until we abort (no response emitted).
        const promise = realProcessNewPrompt(key, prompt);

        // Wait for the active session to be created by processPrompt
        await new Promise(resolve => setTimeout(resolve, 50));

        // Inject queued messages into the REAL active session
        const active = (bot as any).activeSessions.get(key);
        if (active) {
          active.messageQueue.push(
            { prompt: makePrompt("queued 1"), source: { channel: "whatsapp", accountId: "default", chatId: "test" } },
            { prompt: makePrompt("queued 2"), source: { channel: "whatsapp", accountId: "default", chatId: "user2" } },
          );
          active.abortController.abort();
        }

        await promise;
      } else {
        // Second call — from the finally block with combined messages
        captured.push(prompt);
      }
    };

    await (bot as any).processNewPrompt(sessionKey, makePrompt("original msg"));

    // The finally block should include the ORIGINAL prompt (no response was sent)
    // followed by the queued messages
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("original msg\n\nqueued 1\n\nqueued 2");
    // Source from last queued message
    expect(captured[0].source?.chatId).toBe("user2");
  });
});

// ── Tests: abort error handling ─────────────────────────────────────────────

describe("processNewPrompt — abort error suppression", () => {
  it("does NOT emit error response for abort errors", async () => {
    const bot = createBot();
    const { notif } = await import("./notif.js");
    const emitMock = notif.emit as ReturnType<typeof mock>;
    emitMock.mockClear();

    const sessionKey = "agent:main:abort-err";

    // Override processPrompt to throw an abort error
    (bot as any).processPrompt = mock(async () => {
      throw new Error("Claude Code process aborted by user");
    });

    await (bot as any).processNewPrompt(sessionKey, makePrompt("test"));

    const errorCalls = emitMock.mock.calls.filter(
      (call: any[]) => call[1]?.error
    );
    expect(errorCalls).toHaveLength(0);
  });

  it("DOES emit error response for real errors", async () => {
    const bot = createBot();
    const { notif } = await import("./notif.js");
    const emitMock = notif.emit as ReturnType<typeof mock>;
    emitMock.mockClear();

    const sessionKey = "agent:main:real-err";

    (bot as any).processPrompt = mock(async () => {
      throw new Error("Connection timeout");
    });

    await (bot as any).processNewPrompt(sessionKey, makePrompt("test"));

    const errorCalls = emitMock.mock.calls.filter(
      (call: any[]) => call[1]?.error
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1].error).toBe("Connection timeout");
  });
});

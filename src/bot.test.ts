import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the streaming input mode in RaviBot.
 *
 * 1. New session creates a streaming session with AsyncGenerator
 * 2. Subsequent messages push into existing generator (no new subprocess)
 * 3. Done sessions get cleaned up and new messages start fresh
 * 4. Abort errors don't emit error responses
 */

// ── SDK mock ────────────────────────────────────────────────────────────────

let lastQueryPrompt: any = null;
let lastQueryAbortController: AbortController | null = null;
let yieldedMessages: any[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    lastQueryPrompt = opts.prompt;
    const ac: AbortController = opts.options.abortController;
    lastQueryAbortController = ac;

    // Consume the async generator and collect messages
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // If prompt is an async generator, consume it
            if (lastQueryPrompt && typeof lastQueryPrompt[Symbol.asyncIterator] === "function") {
              const result = await lastQueryPrompt.next();
              if (!result.done) {
                yieldedMessages.push(result.value);
              }
            }

            // Return a result event to end the turn
            if (ac.signal.aborted) {
              throw new Error("Claude Code process aborted by user");
            }

            return {
              done: false,
              value: {
                type: "result",
                usage: { input_tokens: 100, output_tokens: 50 },
                session_id: "test-session-id",
              },
            };
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

mock.module("./hooks/index.js", () => ({
  createPreCompactHook: () => () => {},
}));

mock.module("./constants.js", () => ({
  ALL_BUILTIN_TOOLS: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
}));

mock.module("./plugins/index.js", () => ({
  discoverPlugins: () => [],
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

// ── Tests: Streaming session lifecycle ──────────────────────────────────────

describe("handlePromptImmediate — streaming sessions", () => {
  let bot: RaviBot;

  beforeEach(() => {
    bot = createBot();
    yieldedMessages = [];
    lastQueryPrompt = null;
    lastQueryAbortController = null;
  });

  it("creates a new streaming session for first message", async () => {
    const sessionKey = "agent:main:test-new";

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));

    // Wait for background event loop to start
    await new Promise(resolve => setTimeout(resolve, 100));

    const sessions = (bot as any).streamingSessions;
    expect(sessions.has(sessionKey)).toBe(true);
  });

  it("pushes message to existing session instead of creating new", async () => {
    const sessionKey = "agent:main:test-push";

    // Create a fake streaming session that is alive and waiting
    let capturedMessage: any = null;
    const streamingSession = {
      queryHandle: {},
      abortController: new AbortController(),
      pushMessage: (msg: any) => { capturedMessage = msg; },
      pendingMessages: [] as any[],
      currentSource: { channel: "whatsapp", accountId: "default", chatId: "test" },
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
    };
    (bot as any).streamingSessions.set(sessionKey, streamingSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("follow-up"));

    // Should have delivered the message directly
    expect(capturedMessage).not.toBeNull();
    expect(capturedMessage.type).toBe("user");
    expect(capturedMessage.message.content).toBe("follow-up");
    // pushMessage should be consumed (set to null)
    expect(streamingSession.pushMessage).toBeNull();
  });

  it("starts fresh session when previous is done", async () => {
    const sessionKey = "agent:main:test-done";

    // Create a done streaming session
    const doneSession = {
      queryHandle: {},
      abortController: new AbortController(),
      pushMessage: null,
      currentSource: undefined,
      toolRunning: false,
      lastActivity: Date.now(),
      done: true,
    };
    (bot as any).streamingSessions.set(sessionKey, doneSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("new conversation"));

    // Wait for background event loop
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have replaced the done session with a new one
    const sessions = (bot as any).streamingSessions;
    const current = sessions.get(sessionKey);
    expect(current).not.toBe(doneSession);
  });

  it("updates source when pushing to existing session", async () => {
    const sessionKey = "agent:main:test-source";

    const streamingSession = {
      queryHandle: {},
      abortController: new AbortController(),
      pushMessage: (_msg: any) => {},
      pendingMessages: [] as any[],
      currentSource: { channel: "whatsapp", accountId: "default", chatId: "old" },
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
    };
    (bot as any).streamingSessions.set(sessionKey, streamingSession);

    const prompt = makePrompt("update source");
    prompt.source = { channel: "whatsapp", accountId: "default", chatId: "new-chat" };

    await (bot as any).handlePromptImmediate(sessionKey, prompt);

    expect(streamingSession.currentSource?.chatId).toBe("new-chat");
  });
});

describe("stop — cleanup", () => {
  it("aborts all streaming sessions on stop", async () => {
    const bot = createBot();
    const abortController = new AbortController();

    const streamingSession = {
      queryHandle: {},
      abortController,
      pushMessage: null,
      currentSource: undefined,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
    };
    (bot as any).streamingSessions.set("agent:main:test", streamingSession);
    (bot as any).running = true;

    await bot.stop();

    expect(abortController.signal.aborted).toBe(true);
    expect((bot as any).streamingSessions.size).toBe(0);
  });
});

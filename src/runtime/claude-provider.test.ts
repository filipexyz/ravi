import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent, RuntimeStartRequest } from "./types.js";

let nextMessages: any[] = [];
let queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let querySetModelCalls: Array<string | undefined> = [];
let queryCloseCalls = 0;
let queryGate: Promise<void> | null = null;
let releaseQueryGate: (() => void) | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: Record<string, unknown>) => ({
    type: "sdk",
    name: config.name ?? "mock",
    instance: {
      connect: async () => {},
      close: async () => {},
    },
  }),
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls.push(input);
    const messages = [...nextMessages];
    return {
      interrupt: async () => {},
      setModel: async (model?: string) => {
        querySetModelCalls.push(model);
      },
      close: () => {
        queryCloseCalls++;
        releaseQueryGate?.();
      },
      async *[Symbol.asyncIterator]() {
        if (queryGate) {
          await queryGate;
        }
        for (const message of messages) {
          yield message;
        }
      },
    };
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown, options?: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
    options,
  }),
}));

const { buildClaudeCodeEnvironment, buildClaudeQueryOptions, createClaudeRuntimeProvider } = await import(
  "./claude-provider.js"
);

function makeStartRequest(
  messages: RuntimeStartRequest["prompt"],
  overrides: Partial<RuntimeStartRequest> = {},
): RuntimeStartRequest {
  return {
    prompt: messages,
    model: "claude-sonnet",
    cwd: "/tmp/ravi-claude",
    abortController: new AbortController(),
    systemPromptAppend: "",
    ...overrides,
  };
}

async function collectEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const output: RuntimeEvent[] = [];
  for await (const event of events) {
    output.push(event);
  }
  return output;
}

function findEventsByType<T extends RuntimeEvent["type"]>(
  events: RuntimeEvent[],
  type: T,
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createClaudeRuntimeProvider", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    nextMessages = [];
    queryCalls = [];
    querySetModelCalls = [];
    queryCloseCalls = 0;
    queryGate = null;
    releaseQueryGate = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("bootstraps Claude settings and env", () => {
    tempDir = mkdtempSync(join(tmpdir(), "ravi-claude-provider-"));
    const provider = createClaudeRuntimeProvider();

    const prepared = provider.prepareSession?.({
      agentId: "main",
      cwd: tempDir,
    });

    const settingsPath = join(tempDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(prepared).toEqual({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDECODE: "",
      },
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.PermissionRequest[0].matcher).toBe("*");
  });

  it("advertises the allowlisted canonical app builder through the Claude plugin", () => {
    const provider = createClaudeRuntimeProvider();
    const pluginPath = join(import.meta.dir, "..", "plugins", "internal", "ravi-dev");
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "build an app" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          plugins: [{ type: "local", path: pluginPath }],
          allowedSkills: ["ravi-dev-app-creator"],
        },
      ),
    );

    expect(session.skillVisibility?.loadedSkills).toEqual([]);
    expect(session.skillVisibility?.skills).toEqual([
      expect.objectContaining({
        id: "app-creator",
        provider: "claude",
        state: "advertised",
        confidence: "declared",
        source: "plugin:ravi-dev/app-creator",
      }),
    ]);
  });

  it("closes the active Claude SDK query idempotently", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-close" }];
    queryGate = new Promise<void>((resolve) => {
      releaseQueryGate = resolve;
    });

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "close" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const eventsPromise = collectEvents(session.events);
    await waitFor(() => queryCalls.length === 1);
    await session.close?.();
    await session.close?.();
    await eventsPromise;

    expect(queryCloseCalls).toBe(1);
  });

  it("normalizes assistant/tool/result events", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello from Claude" },
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file contents", is_error: false }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "claude-session-1",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const toolStarted = findEventsByType(events, "tool.started").at(0);
    const assistantMessages = findEventsByType(events, "assistant.message");
    const toolCompleted = findEventsByType(events, "tool.completed").at(0);
    const completions = findEventsByType(events, "turn.complete");

    expect(toolStarted?.toolUse).toEqual({
      id: "tool_1",
      name: "Read",
      input: { file_path: "README.md" },
    });
    expect(assistantMessages.map((event) => event.text)).toContain("Hello from Claude");
    expect(toolCompleted?.toolUseId).toBe("tool_1");
    expect(toolCompleted?.content).toBe("file contents");
    expect(completions[0]?.providerSessionId).toBe("claude-session-1");
    expect(completions[0]?.session).toMatchObject({
      params: {
        sessionId: "claude-session-1",
        skillVisibility: {
          loadedSkills: [],
          skills: [],
        },
      },
      displayId: "claude-session-1",
    });
    expect(completions[0]?.execution).toEqual({
      provider: "anthropic",
      model: null,
      billingType: "api",
    });
    expect(completions[0]?.usage.cacheReadTokens).toBe(2);
    expect(completions[0]?.usage.cacheCreationTokens).toBe(1);
  });

  it("maps error results into turn.failed", async () => {
    nextMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "claude-session-2",
        errors: ["Tool execution failed"],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const failures = findEventsByType(events, "turn.failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain("Tool execution failed");
    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
  });

  const runSingleTurn = async () => {
    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );
    return collectEvents(session.events);
  };

  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  it("fails the turn on Claude assistant error frames instead of delivering them as replies", async () => {
    nextMessages = [
      {
        type: "assistant",
        error: "rate_limit",
        session_id: "claude-session-rate-limit",
        message: {
          content: [{ type: "text", text: "You're out of extra usage · resets Aug 24 at 6am (America/Sao_Paulo)" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-session-rate-limit",
        usage: zeroUsage,
      },
    ];

    const events = await runSingleTurn();
    const failures = findEventsByType(events, "turn.failed");

    expect(findEventsByType(events, "assistant.message")).toHaveLength(0);
    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      error: "Claude provider error (rate_limit): You're out of extra usage · resets Aug 24 at 6am (America/Sao_Paulo)",
      recoverable: true,
      rawEvent: { type: "assistant", error: "rate_limit" },
    });
  });

  it.each([
    ["authentication_failed", "Invalid API key · Fix external API key"],
    ["oauth_org_not_allowed", "Your organization does not allow this OAuth client"],
    ["billing_error", "Credit balance is too low"],
  ])("marks Claude %s assistant errors as non-recoverable failures", async (code, text) => {
    nextMessages = [
      { type: "assistant", error: code, message: { content: [{ type: "text", text }] } },
      { type: "result", subtype: "success", is_error: false, usage: zeroUsage },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "assistant.message")).toHaveLength(0);
    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
    expect(findEventsByType(events, "turn.failed")).toEqual([
      expect.objectContaining({ error: `Claude provider error (${code}): ${text}`, recoverable: false }),
    ]);
  });

  it("keeps Claude login stubs verbatim so the host login-stub path owns them", async () => {
    nextMessages = [
      {
        type: "assistant",
        error: "authentication_failed",
        message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      },
      { type: "result", subtype: "success", is_error: false, usage: zeroUsage },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "turn.failed")).toEqual([
      expect.objectContaining({ error: "Not logged in · Please run /login", recoverable: false }),
    ]);
  });

  it("does not fail the turn on max_output_tokens assistant frames", async () => {
    nextMessages = [
      {
        type: "assistant",
        error: "max_output_tokens",
        message: { content: [{ type: "text", text: "partial answer" }] },
      },
      { type: "result", subtype: "success", is_error: false, session_id: "claude-session-max", usage: zeroUsage },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "assistant.message")).toEqual([
      expect.objectContaining({ text: "partial answer" }),
    ]);
    expect(findEventsByType(events, "turn.failed")).toHaveLength(0);
    expect(findEventsByType(events, "turn.complete")).toHaveLength(1);
  });

  it.each([
    [429, true],
    [529, true],
    [401, false],
  ])("treats a success result with is_error and api_error_status %d as a failed turn", async (status, recoverable) => {
    nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: status,
        result: "You're out of extra usage",
        session_id: "claude-session-error-success",
        usage: zeroUsage,
      },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
    expect(findEventsByType(events, "turn.failed")).toEqual([
      expect.objectContaining({
        error: `Claude provider error (http_${status}): You're out of extra usage`,
        recoverable,
        rawEvent: expect.objectContaining({ api_error_status: status }),
      }),
    ]);
  });

  it("treats an is_error success result without a status as a failed turn", async () => {
    nextMessages = [
      { type: "result", subtype: "success", is_error: true, result: "API Error: Connection error.", usage: zeroUsage },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
    expect(findEventsByType(events, "turn.failed")).toEqual([
      expect.objectContaining({ error: "Claude turn failed: API Error: Connection error.", recoverable: true }),
    ]);
  });

  it("completes a recovered success result that still carries a stale api_error_status", async () => {
    // The SDK retried a 429 and recovered: the turn succeeded, so `is_error` is
    // false even though the last API error status is still reported.
    nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        api_error_status: 429,
        result: "final answer",
        session_id: "claude-session-recovered",
        usage: zeroUsage,
      },
    ];

    const events = await runSingleTurn();

    expect(findEventsByType(events, "turn.failed")).toHaveLength(0);
    expect(findEventsByType(events, "turn.complete")).toEqual([
      expect.objectContaining({ providerSessionId: "claude-session-recovered" }),
    ]);
  });

  it("synthesizes a failed turn when the provider stream ends without a terminal result", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial answer" }],
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const failures = findEventsByType(events, "turn.failed");

    expect(findEventsByType(events, "assistant.message").map((event) => event.text)).toEqual(["partial answer"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBe("Runtime provider stream ended without a terminal event");
    expect(failures[0]?.rawEvent).toMatchObject({
      type: "stream.ended",
      reason: "missing_terminal_event",
    });
  });

  it("does not empty-join distinct assistant text blocks into one message", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "primeiro?" },
            { type: "text", text: "Olá" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "claude-session-mash",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "oi" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    expect(findEventsByType(events, "assistant.message").map((event) => event.text)).toEqual(["primeiro?", "Olá"]);
  });

  it("passes an explicit native executable path when configured", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-3" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          env: {
            RAVI_CLAUDE_CODE_EXECUTABLE: "/opt/ravi/bin/native-runtime",
            PATH: "",
          },
        },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.prompt).toBe("hello");
    expect(queryCalls[0]?.options.effort).toBe("max");
    expect(queryCalls[0]?.options.pathToClaudeCodeExecutable).toBe("/opt/ravi/bin/native-runtime");
  });

  it("maps Ravi xhigh effort to the adapter strongest effort", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-effort" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { effort: "xhigh" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.effort).toBe("max");
  });

  it("omits disabled thinking for Claude Fable 5", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-fable-thinking" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "claude-fable-5", thinking: "off" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.model).toBe("claude-fable-5");
    expect(queryCalls[0]?.options.thinking).toBeUndefined();
  });

  it("keeps summarized adaptive thinking for Claude Fable 5 verbose mode", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-fable-verbose" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "claude-fable-5", thinking: "verbose" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("updates active and subsequent query models without recreating the provider session", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-model" }];
    queryGate = new Promise<void>((resolve) => {
      releaseQueryGate = resolve;
    });

    let releaseSecondPrompt = () => {};
    const secondPromptReady = new Promise<void>((resolve) => {
      releaseSecondPrompt = resolve;
    });

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "first" },
            session_id: "",
            parent_tool_use_id: null,
          };
          await secondPromptReady;
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "second" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "model-a" },
      ),
    );

    const eventsPromise = collectEvents(session.events);
    await waitFor(() => queryCalls.length === 1);
    await session.setModel?.("model-b");
    expect(querySetModelCalls).toEqual(["model-b"]);
    releaseQueryGate?.();
    await waitFor(() => queryCalls.length === 1 && querySetModelCalls.length === 1);

    queryGate = null;
    releaseSecondPrompt();
    const events = await eventsPromise;

    expect(findEventsByType(events, "turn.complete")).toHaveLength(2);
    expect(queryCalls[0]?.options.model).toBe("model-a");
    expect(queryCalls[1]?.options.model).toBe("model-b");
  });

  it("refreshes Ravi authority env between turns without resetting conversation history", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-authority" }];
    const env: Record<string, string> = {
      PATH: "",
      RAVI_CONTEXT_KEY: "rctx_first",
      RAVI_TASK_ID: "task_stale",
    };

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "first" },
            session_id: "",
            parent_tool_use_id: null,
          };
          env.RAVI_CONTEXT_KEY = "rctx_second";
          delete env.RAVI_TASK_ID;
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "second" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { env },
      ),
    );

    const events = await collectEvents(session.events);
    expect(queryCalls).toHaveLength(2);
    const firstEnv = queryCalls[0]?.options.env as Record<string, string>;
    const secondEnv = queryCalls[1]?.options.env as Record<string, string>;

    expect(findEventsByType(events, "turn.complete")).toHaveLength(2);
    expect(firstEnv.RAVI_CONTEXT_KEY).toBe("rctx_first");
    expect(firstEnv.RAVI_TASK_ID).toBe("task_stale");
    expect(secondEnv.RAVI_CONTEXT_KEY).toBe("rctx_second");
    expect(secondEnv.RAVI_TASK_ID).toBeUndefined();
    expect(queryCalls[1]?.options.resume).toBe("claude-session-authority");
    expect(secondEnv).not.toBe(firstEnv);
  });

  it("does not let inherited process auth shadow a selected auth profile", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const inherited = "sk-ant-api03-fake-not-a-real-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inherited;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-other-fake-key";
    try {
      const { isolateSelectedClaudeAuthEnv, RAVI_CLAUDE_MANAGED_AUTH_ENV } = await import(
        "./credential-secret-shape.js"
      );
      const runtimeEnv: Record<string, string> = {
        CLAUDE_CONFIG_DIR: "/tmp/claude-profile",
        PATH: "",
        CLAUDE_CODE_OAUTH_TOKEN: inherited,
      };
      isolateSelectedClaudeAuthEnv({
        runtimeProviderId: "claude",
        binding: { authMethod: "claude-oauth", resolvedEnv: {} },
        runtimeEnv,
      });
      const env = buildClaudeCodeEnvironment(runtimeEnv);
      expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-profile");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env[RAVI_CLAUDE_MANAGED_AUTH_ENV]).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(inherited);
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("refuses to backfill an API key into the OAuth env var", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const inherited = "sk-ant-api03-fake-not-a-real-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = inherited;
    try {
      const env = buildClaudeCodeEnvironment({ PATH: "" });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(inherited);
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  });

  it("backfills daemon auth env when the runtime env is partial", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-daemon-token";

    try {
      const env = buildClaudeCodeEnvironment({
        RAVI_CLAUDE_CODE_EXECUTABLE: "/opt/ravi/bin/native-runtime",
        PATH: "",
      });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-daemon-token");
      expect(env.PATH).toBe("");
    } finally {
      if (originalToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      }
    }
  });

  it("never backfills upstream auth into a model-broker runtime", () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "daemon-oauth-secret";
    process.env.ANTHROPIC_API_KEY = "daemon-api-secret";
    try {
      const env = buildClaudeCodeEnvironment({
        RAVI_MODEL_BROKER_ACTIVE: "1",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:43123",
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43123");
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("loads only protected user settings in model-broker mode and excludes malicious project overrides", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-proxy", result: "ok", usage: {} }];
    const handle = createClaudeRuntimeProvider().startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          settingSources: ["project"],
          modelBroker: {
            version: 1,
            brokerId: "hub",
            leaseId: "grant_claude_1",
            attemptId: "attempt_claude_1",
            turnId: "turn_claude_1",
            runtimeId: "runtime_a",
            runtimeProvider: "claude",
            model: "claude-sonnet",
            routeRevision: "route_1",
            compatibilityRevision: "compat_claude_1",
            expiresAt: Date.now() + 60_000,
            transport: {
              scheme: "local-http-forwarder-v1",
              protocol: "anthropic-messages",
              origin: "http://127.0.0.1:43123",
              path: "/v1/messages",
              publicHeaders: { "x-public-route": "binding_claude_1" },
            },
            profileRef: "profile_main",
            selectionCompatibilityKey: "selection_main",
            principalIsolation: "cgroup",
          },
          env: {
            RAVI_MODEL_BROKER_ACTIVE: "1",
            CLAUDE_CONFIG_DIR: "/tmp/ravi-model-broker/claude",
          },
        },
      ),
    );
    await collectEvents(handle.events);
    expect(queryCalls[0]?.options.settingSources).toEqual(["user"]);
    expect(queryCalls[0]?.options.settingSources).not.toContain("project");
  });
});

describe("buildClaudeQueryOptions chat-only host deny", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    const { createIsolatedRaviState } = await import("../test/ravi-state.js");
    stateDir = await createIsolatedRaviState("ravi-claude-chat-only-");
  });

  afterEach(async () => {
    const { cleanupIsolatedRaviState } = await import("../test/ravi-state.js");
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("attaches canUseTool under bypassPermissions and host-denies tools for chat-only", async () => {
    const { dbCreateAgent } = await import("../router/router-db.js");
    const {
      assertChatOnlyClaudeParity,
      assertChatOnlyHostDeny,
      materializeAgentAndIdentity,
      persistAgentRuntimeProfile,
    } = await import("../permissions/chat-only-parity.js");

    dbCreateAgent({ id: "reception", cwd: "/tmp/reception" });
    persistAgentRuntimeProfile("reception", "chat-only");
    const { identity } = materializeAgentAndIdentity("reception");
    const { canUseTool } = await assertChatOnlyHostDeny("reception", identity);

    await assertChatOnlyClaudeParity(canUseTool);

    const options = buildClaudeQueryOptions(
      {
        ...makeStartRequest((async function* () {})(), {
          permissionOptions: { permissionMode: "bypassPermissions" },
          canUseTool,
        }),
      },
      {},
      {},
    );
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(typeof options.canUseTool).toBe("function");
    const denied = await options.canUseTool!(
      "Bash",
      { command: "curl https://example.com" },
      {
        signal: new AbortController().signal,
        toolUseID: "claude-chat-only-bash",
        requestId: "claude-chat-only-request",
      },
    );
    expect(denied?.behavior).toBe("deny");
    expect(String((denied as { message?: string })?.message ?? "")).toMatch(/chat-only|denied|permission/i);
  });
});
afterAll(() => mock.restore());

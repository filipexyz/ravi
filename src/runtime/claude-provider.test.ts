import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent, RuntimeStartRequest } from "./types.js";

let nextMessages: any[] = [];
let queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let querySetModelCalls: Array<string | undefined> = [];
let queryGate: Promise<void> | null = null;
let releaseQueryGate: (() => void) | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls.push(input);
    const messages = [...nextMessages];
    return {
      interrupt: async () => {},
      setModel: async (model?: string) => {
        querySetModelCalls.push(model);
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
}));

const { buildClaudeCodeEnvironment, createClaudeRuntimeProvider } = await import("./claude-provider.js");

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
    expect(completions[0]?.session).toEqual({
      params: { sessionId: "claude-session-1" },
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
    expect(queryCalls[0]?.options.pathToClaudeCodeExecutable).toBe("/opt/ravi/bin/native-runtime");
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
});
afterAll(() => mock.restore());

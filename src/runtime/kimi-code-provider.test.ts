import { describe, expect, test } from "bun:test";
import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import { buildKimiCodeRequest } from "./kimi-code-transport.js";
import { listRegisteredRuntimeProviderIds, unregisterRuntimeProvider } from "./provider-registry.js";
import type { KimiCodeStreamEvent, KimiCodeTransport } from "./kimi-code-transport.js";
import type { RuntimeEvent, RuntimeHostServices, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

function prompts(...content: string[]): AsyncGenerator<RuntimePromptMessage> {
  return (async function* () {
    for (const text of content) {
      yield {
        type: "user",
        message: { role: "user", content: text },
        session_id: "synthetic-session",
        parent_tool_use_id: null,
      };
    }
  })();
}

function startRequest(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: prompts("hello"),
    model: "k3",
    cwd: "C:/synthetic",
    abortController: new AbortController(),
    systemPromptAppend: "Ravi policy.",
    env: { KIMI_API_KEY: "synthetic-key" },
    ...overrides,
  };
}

function transportFrom(events: readonly KimiCodeStreamEvent[]): KimiCodeTransport {
  return {
    async *stream() {
      yield* events;
    },
    async close() {},
  };
}

async function collectEvents(provider: ReturnType<typeof createKimiCodeRuntimeProvider>, input: RuntimeStartRequest) {
  const events: RuntimeEvent[] = [];
  for await (const event of provider.startSession(input).events) events.push(event);
  return events;
}

function createHostServices(): RuntimeHostServices {
  return {
    authorizeCapability: async () => ({ allowed: true, inherited: false }),
    authorizeCommandExecution: async () => ({ approved: true }),
    authorizeToolUse: async () => ({ approved: true }),
    requestUserInput: async () => ({ approved: true, answers: {} }),
    listDynamicTools: () => [
      {
        name: "lookup_order",
        description: "Looks up a synthetic order.",
        inputSchema: { type: "object" },
      },
    ],
    executeDynamicTool: async (request) => ({
      success: request.toolName === "lookup_order",
      contentItems: [{ type: "inputText", text: `handled:${request.toolName}` }],
    }),
  };
}

describe("createKimiCodeRuntimeProvider", () => {
  test("exports the transport request boundary for its provider-specific mapping", () => {
    expect(typeof buildKimiCodeRequest).toBe("function");
  });

  test("declares the conservative Kimi Code v1 capability contract", () => {
    expect(createKimiCodeRuntimeProvider().getCapabilities()).toEqual({
      runtimeControl: { supported: false, operations: [] },
      dynamicTools: { mode: "host" },
      execution: { mode: "external-service" },
      sessionState: { mode: "file-backed", requiresCwdMatch: true },
      usage: { semantics: "terminal-event" },
      tools: { permissionMode: "ravi-host", accessRequirement: "tool_surface", supportsParallelCalls: false },
      systemPrompt: { mode: "append" },
      terminalEvents: { guarantee: "adapter" },
      skillVisibility: { availability: "none", loadedState: "none" },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: false,
      supportsHostSessionHooks: false,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
      toolAccessRequirement: "tool_surface",
    });
  });

  test("prepares the host dynamic-tool bridge without enabling legacy tool hooks", async () => {
    const provider = createKimiCodeRuntimeProvider();
    const prepared = await provider.prepareSession?.({
      agentId: "kimi-agent",
      cwd: "C:/synthetic-workspace",
      hostServices: createHostServices(),
    });

    expect(provider.getCapabilities().supportsToolHooks).toBe(false);
    expect(prepared?.startRequest?.dynamicTools).toEqual([
      {
        name: "lookup_order",
        description: "Looks up a synthetic order.",
        inputSchema: { type: "object" },
      },
    ]);
    expect(await prepared?.startRequest?.handleRuntimeToolCall?.({ toolName: "lookup_order" })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "handled:lookup_order" }],
    });
  });

  test("is registered as a built-in provider and cannot be unregistered", () => {
    expect(listRegisteredRuntimeProviderIds()).toContain("kimi-code");
    expect(() => unregisterRuntimeProvider("kimi-code")).toThrow(
      "Cannot unregister built-in runtime provider 'kimi-code'",
    );
  });

  test("normalizes stream chunks without exposing reasoning or indexed tool fragments (catches public raw-chunk leakage)", async () => {
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          {
            type: "message",
            data: {
              choices: [
                {
                  delta: {
                    reasoning_content: "private chain of thought",
                    content: "Hel",
                    tool_calls: [{ index: 1, id: "call-2", function: { name: "lookup", arguments: '{"id":' } }],
                  },
                },
              ],
            },
          },
          {
            type: "message",
            data: {
              choices: [
                {
                  delta: {
                    content: "lo",
                    tool_calls: [{ index: 1, function: { arguments: '"42"}' } }],
                  },
                },
              ],
            },
          },
          {
            type: "message",
            data: {
              choices: [],
              usage: {
                prompt_tokens: 7,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 3 },
                cache_creation_input_tokens: 4,
              },
            },
          },
          { type: "done" },
        ]),
    });

    const events = await collectEvents(provider, startRequest());

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status",
      "text.delta",
      "text.delta",
      "assistant.message",
      "turn.complete",
    ]);
    expect(events[1]).toMatchObject({ type: "status", status: "thinking" });
    expect(events[4]).toMatchObject({ type: "assistant.message", text: "Hello" });
    expect(events[5]).toMatchObject({
      type: "turn.complete",
      execution: { provider: "kimi-code", model: "k3", billingType: "subscription" },
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
    });
    expect(JSON.stringify(events)).not.toContain("private chain of thought");
    expect(JSON.stringify(events)).not.toContain("call-2");
  });

  test("emits one terminal event for duplicate provider finish chunks (catches duplicate terminal replay)", async () => {
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] } },
          { type: "message", data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
          { type: "done" },
        ]),
    });

    const events = await collectEvents(provider, startRequest());

    expect(events.filter((event) => event.type.startsWith("turn.") && event.type !== "turn.started")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn.complete");
  });

  test("fails with a redacted error for malformed chunks, provider errors, and EOF (catches transport-detail leakage)", async () => {
    const malformed = createKimiCodeRuntimeProvider({
      transportFactory: () => transportFrom([{ type: "message", data: "not an object" as unknown }, { type: "done" }]),
    });
    const providerError = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { error: { message: "synthetic provider secret" } } },
          { type: "done" },
        ]),
    });
    const eof = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom([{ type: "eof" }]) });

    const malformedEvents = await collectEvents(malformed, startRequest());
    const providerErrorEvents = await collectEvents(providerError, startRequest());
    const eofEvents = await collectEvents(eof, startRequest());

    expect(malformedEvents.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code stream failed" });
    expect(providerErrorEvents.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code stream failed" });
    expect(JSON.stringify(providerErrorEvents)).not.toContain("synthetic provider secret");
    expect(eofEvents.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code stream ended before completion" });
  });

  test("emits interruption before or after output without a second terminal (catches abort terminal replay)", async () => {
    const before = startRequest({ abortController: new AbortController() });
    before.abortController.abort();
    const after = startRequest({ abortController: new AbortController() });
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => ({
        async *stream() {
          yield { type: "message", data: { choices: [{ delta: { content: "partial" } }] } };
          after.abortController.abort();
          yield { type: "done" };
        },
        async close() {},
      }),
    });

    const beforeEvents = await collectEvents(provider, before);
    const afterEvents = await collectEvents(provider, after);

    expect(beforeEvents.map((event) => event.type)).toEqual(["turn.interrupted"]);
    expect(afterEvents.map((event) => event.type)).toEqual(["turn.started", "text.delta", "turn.interrupted"]);
  });

  test("publishes an empty assistant message before completion (catches empty-output omission)", async () => {
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
          { type: "done" },
        ]),
    });

    const events = await collectEvents(provider, startRequest());

    expect(events.map((event) => event.type)).toEqual(["turn.started", "assistant.message", "turn.complete"]);
    expect(events[1]).toMatchObject({ type: "assistant.message", text: "" });
  });

  test("makes interrupt and close idempotent while a stream is active (catches repeated transport teardown)", async () => {
    let closeCalls = 0;
    let release!: () => void;
    let streamEntered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      streamEntered = resolve;
    });
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => ({
        async *stream() {
          streamEntered();
          await blocked;
          yield { type: "eof" };
        },
        async close() {
          closeCalls += 1;
          release();
        },
      }),
    });
    const handle = provider.startSession(startRequest());
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("turn.started");
    const terminal = iterator.next();
    await entered;
    await handle.interrupt();
    await handle.interrupt();
    await handle.close?.();
    await handle.close?.();

    expect(closeCalls).toBe(1);
    expect((await terminal).value?.type).toBe("turn.interrupted");
  });

  test("forwards the host abort signal to the injected transport (catches uncancellable requests)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => ({
        async *stream(request) {
          receivedSignal = request.signal;
          yield { type: "done" };
        },
        async close() {},
      }),
    });
    const input = startRequest();

    await collectEvents(provider, input);

    expect(receivedSignal).toBe(input.abortController.signal);
  });
});

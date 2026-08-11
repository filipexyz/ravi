import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createKimiCodeCompletedTurnAccumulator, createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import { commitKimiCodeSessionState, createKimiCodeSessionId, loadKimiCodeSessionState } from "./kimi-code-state.js";
import {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  KimiCodeHttpError,
  KimiCodeProtocolError,
} from "./kimi-code-transport.js";
import { listRegisteredRuntimeProviderIds, unregisterRuntimeProvider } from "./provider-registry.js";
import type { KimiCodeStreamEvent, KimiCodeTransport, KimiCodeTransportRequest } from "./kimi-code-transport.js";
import type {
  RuntimeDynamicToolCallRequest,
  RuntimeEvent,
  RuntimeHostServices,
  RuntimePromptMessage,
  RuntimeSessionState,
  RuntimeStartRequest,
} from "./types.js";

const temporaryStateRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryStateRoots) rmSync(root, { recursive: true, force: true });
  temporaryStateRoots.clear();
});

function isolatedStateEnv() {
  const root = mkdtempSync(join(tmpdir(), "ravi-kimi-provider-state-"));
  temporaryStateRoots.add(root);
  return { root, env: { RAVI_STATE_DIR: join(root, "state"), KIMI_API_KEY: "provider-key-must-stay-private" } };
}

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
    env: isolatedStateEnv().env,
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

function toolTurn(
  calls: Array<{ index: number; id: string; name: string; arguments: string }>,
  options: { content?: string; reasoning?: string } = {},
): KimiCodeStreamEvent[] {
  return [
    {
      type: "message",
      data: {
        choices: [
          {
            index: 0,
            delta: {
              content: options.content ?? "",
              reasoning_content: options.reasoning ?? "",
              tool_calls: calls.map((call) => ({
                index: call.index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    },
    { type: "done" },
  ];
}

function finalTurn(content: string): KimiCodeStreamEvent[] {
  return [
    {
      type: "message",
      data: { choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] },
    },
    { type: "done" },
  ];
}

function transportSequence(
  turns: readonly (readonly KimiCodeStreamEvent[])[],
  requests: KimiCodeTransportRequest[],
): () => KimiCodeTransport {
  let turnIndex = 0;
  return () => {
    const events = turns[turnIndex];
    turnIndex += 1;
    if (!events) throw new Error("unexpected synthetic provider request");
    return {
      async *stream(request) {
        requests.push(request);
        yield* events;
      },
      async close() {},
    };
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

  test("normalizes stream chunks without exposing private reasoning (catches public raw-chunk leakage)", async () => {
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

    expect(malformedEvents.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Kimi Code protocol error: malformed response chunk",
      rawEvent: { protocol: "malformed_chunk" },
    });
    expect(providerErrorEvents.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Kimi Code protocol error: provider error event",
      rawEvent: { protocol: "provider_error" },
    });
    expect(JSON.stringify(providerErrorEvents)).not.toContain("synthetic provider secret");
    expect(eofEvents.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code stream ended before completion" });
  });

  test("projects only classified Kimi HTTP metadata into the canonical failure", async () => {
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        createKimiCodeHttpTransport({
          fetch: (async () =>
            new Response(
              JSON.stringify({
                error: {
                  message: "We're receiving too many requests at the moment. Please wait a moment and try again.",
                  code: "concurrency_limit",
                  type: "rate_limit_error",
                },
              }),
              {
                status: 429,
                headers: { "retry-after": "2", "x-request-id": "req-provider" },
              },
            )) as unknown as typeof fetch,
        }),
    });

    const events = await collectEvents(provider, startRequest());

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "We're receiving too many requests at the moment. Please wait a moment and try again.",
      rawEvent: {
        status: 429,
        code: "concurrency_limit",
        type: "rate_limit_error",
        headers: { "retry-after": "2", "x-request-id": "req-provider" },
        requestId: "req-provider",
      },
    });
  });

  test("projects a bounded protocol diagnostic from transport failures", async () => {
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => ({
        async *stream() {
          yield* [] as KimiCodeStreamEvent[];
          throw new KimiCodeProtocolError("malformed_json");
        },
        async close() {},
      }),
    });

    expect((await collectEvents(provider, startRequest())).at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Kimi Code protocol error: malformed JSON event",
      rawEvent: { protocol: "malformed_json" },
    });
  });

  test("re-sanitizes a custom transport Kimi HTTP error at the provider boundary", async () => {
    const sentinel = "PRIVATE_CUSTOM_TRANSPORT_SENTINEL";
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => ({
        async *stream() {
          yield await Promise.reject(
            new KimiCodeHttpError({
              status: 429,
              publicMessage: sentinel,
              code: sentinel,
              type: sentinel,
              headers: { authorization: `Bearer ${sentinel}`, "x-request-id": sentinel },
              requestId: sentinel,
            }),
          );
        },
        async close() {},
      }),
    });

    const events = await collectEvents(provider, startRequest());
    const serialized = JSON.stringify(events.at(-1));

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Kimi Code membership request failed (HTTP 429)",
      rawEvent: { status: 429 },
    });
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("authorization");
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

  test("interrupts only the active turn and accepts a successor prompt (catches session-wide interruption latching)", async () => {
    let calls = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => {
        calls += 1;
        return transportFrom([{ type: "done" }]);
      },
    });
    const handle = provider.startSession(startRequest({ prompt: prompts("first", "second") }));
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("turn.started");
    await handle.interrupt();
    expect((await iterator.next()).value?.type).toBe("turn.interrupted");
    expect((await iterator.next()).value?.type).toBe("turn.started");
    expect((await iterator.next()).value?.type).toBe("assistant.message");
    expect((await iterator.next()).value?.type).toBe("turn.complete");
    expect(calls).toBe(1);
  });

  test("does not start a transport after interrupt or close immediately follows turn.started (catches pre-transport race)", async () => {
    for (const action of ["interrupt", "close"] as const) {
      let calls = 0;
      const provider = createKimiCodeRuntimeProvider({
        transportFactory: () => {
          calls += 1;
          return transportFrom([{ type: "done" }]);
        },
      });
      const handle = provider.startSession(startRequest());
      const iterator = handle.events[Symbol.asyncIterator]();

      expect((await iterator.next()).value?.type).toBe("turn.started");
      await handle[action]?.();
      expect((await iterator.next()).value?.type).toBe("turn.interrupted");
      expect(calls).toBe(0);
    }
  });

  test("closes every active transport exactly once after each terminal path (catches transport leaks)", async () => {
    const cases: Array<{ name: string; events: KimiCodeStreamEvent[]; abort?: boolean }> = [
      { name: "success", events: [{ type: "done" }] },
      { name: "provider failure", events: [{ type: "message", data: { error: { message: "secret" } } }] },
      { name: "eof", events: [{ type: "eof" }] },
      {
        name: "host abort",
        events: [{ type: "message", data: { choices: [{ delta: { content: "partial" } }] } }, { type: "done" }],
        abort: true,
      },
    ];

    for (const testCase of cases) {
      let closeCalls = 0;
      const input = startRequest();
      const provider = createKimiCodeRuntimeProvider({
        transportFactory: () => ({
          async *stream() {
            for (const event of testCase.events) {
              yield event;
              if (testCase.abort) input.abortController.abort();
            }
          },
          async close() {
            closeCalls += 1;
          },
        }),
      });

      await collectEvents(provider, input);
      expect(closeCalls, testCase.name).toBe(1);
    }
  });

  test("rejects unsupported choices and post-finish deltas while retaining a usage-only tail (catches choice-state corruption)", async () => {
    const unsupportedIndex = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([{ type: "message", data: { choices: [{ index: 1, delta: {} }] } }, { type: "done" }]),
    });
    const multipleChoices = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([{ type: "message", data: { choices: [{ delta: {} }, { delta: {} }] } }, { type: "done" }]),
    });
    const malformedFinish = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { choices: [{ index: 0, delta: {}, finish_reason: {} }] } },
          { type: "done" },
        ]),
    });
    const postFinish = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
          { type: "message", data: { choices: [{ index: 0, delta: { content: "late" } }] } },
          { type: "done" },
        ]),
    });
    const usageTail = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom([
          { type: "message", data: { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] } },
          { type: "message", data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } } },
          { type: "done" },
        ]),
    });

    expect((await collectEvents(unsupportedIndex, startRequest())).at(-1)?.type).toBe("turn.failed");
    expect((await collectEvents(multipleChoices, startRequest())).at(-1)?.type).toBe("turn.failed");
    expect((await collectEvents(malformedFinish, startRequest())).at(-1)?.type).toBe("turn.failed");
    expect((await collectEvents(postFinish, startRequest())).at(-1)?.type).toBe("turn.failed");
    expect((await collectEvents(usageTail, startRequest())).at(-1)).toMatchObject({
      type: "turn.complete",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  test("reconstructs private reasoning and indexed tool fragments independently of public events (catches accumulator loss)", () => {
    const accumulator = createKimiCodeCompletedTurnAccumulator();

    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "reason-1",
              content: "answer",
              tool_calls: [{ index: 2, id: "tool-2", function: { name: "later", arguments: "{" } }],
            },
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted", textDeltas: ["answer"], reasoningDelta: true, finished: false });
    expect(
      accumulator.accept({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "reason-2",
              tool_calls: [{ index: 1, id: "tool-1", function: { name: "first", arguments: "{}" } }],
            },
          },
        ],
      }),
    ).toMatchObject({ kind: "accepted", reasoningDelta: true, finished: false });
    expect(
      accumulator.accept({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: "}" } }] } }],
      }),
    ).toMatchObject({ kind: "accepted", finished: false });

    expect(accumulator.complete()).toEqual({
      text: "answer",
      reasoning: "reason-1reason-2",
      toolCalls: [
        { index: 1, id: "tool-1", name: "first", arguments: "{}" },
        { index: 2, id: "tool-2", name: "later", arguments: "{}" },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  test("routes one tool call through the host and preserves the native assistant continuation shape", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    const hostCalls: RuntimeDynamicToolCallRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([{ index: 0, id: "call-order-42", name: "lookup_order", arguments: '{"id":42}' }], {
            reasoning: "private lookup plan",
          }),
          finalTurn("Order found"),
        ],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        dynamicTools: createHostServices().listDynamicTools(),
        handleRuntimeToolCall: async (request) => {
          hostCalls.push(request);
          return { success: true, contentItems: [{ type: "inputText", text: "order:42" }] };
        },
      }),
    );

    expect(hostCalls).toEqual([{ toolName: "lookup_order", callId: "call-order-42", arguments: { id: 42 } }]);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status",
      "tool.started",
      "tool.completed",
      "tool.result_delivered",
      "text.delta",
      "assistant.message",
      "turn.complete",
    ]);
    expect(events[2]).toMatchObject({
      type: "tool.started",
      toolUse: { id: "call-order-42", name: "lookup_order", input: { id: 42 } },
    });
    expect(events[3]).toMatchObject({
      type: "tool.completed",
      toolUseId: "call-order-42",
      toolName: "lookup_order",
      content: "order:42",
      isError: false,
    });
    expect(events[4]).toMatchObject({ type: "tool.result_delivered", toolCallId: "call-order-42" });
    expect(JSON.stringify(events)).not.toContain("private lookup plan");

    const firstBody = requests[0]?.body as unknown as Record<string, unknown>;
    expect(firstBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup_order",
          description: "Looks up a synthetic order.",
          parameters: { type: "object" },
        },
      },
    ]);
    const continuation = requests[1]?.body as unknown as { messages: unknown[] };
    expect(continuation.messages.slice(0, 3)).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "private lookup plan",
        tool_calls: [
          {
            id: "call-order-42",
            type: "function",
            function: { name: "lookup_order", arguments: '{"id":42}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-order-42", content: "order:42" },
    ]);
  });

  test("sanitizes public tool events while preserving exact host and native values", async () => {
    const rawArguments = '{"apiKey":"sk-test_argument_secret_123456","orderId":42}';
    const rawResult = "sk-test_result_secret_123456";
    const requests: KimiCodeTransportRequest[] = [];
    const hostCalls: RuntimeDynamicToolCallRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([{ index: 0, id: "call-secret", name: "lookup_order", arguments: rawArguments }]),
          finalTurn("Handled privately"),
        ],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async (request) => {
          hostCalls.push(request);
          return { success: true, contentItems: [{ type: "inputText", text: rawResult }] };
        },
      }),
    );

    expect(hostCalls).toEqual([
      {
        toolName: "lookup_order",
        callId: "call-secret",
        arguments: { apiKey: "sk-test_argument_secret_123456", orderId: 42 },
      },
    ]);
    expect(events.find((event) => event.type === "tool.started")).toMatchObject({
      type: "tool.started",
      toolUse: { id: "call-secret", name: "lookup_order", input: { apiKey: "[REDACTED]", orderId: 42 } },
    });
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      toolUseId: "call-secret",
      content: "[REDACTED:token]",
      isError: false,
    });
    expect(JSON.stringify(events)).not.toContain("sk-test_argument_secret_123456");
    expect(JSON.stringify(events)).not.toContain(rawResult);

    const continuation = requests[1]?.body as unknown as { messages: Array<Record<string, unknown>> };
    expect(continuation.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call-secret",
          type: "function",
          function: { name: "lookup_order", arguments: rawArguments },
        },
      ],
    });
    expect(continuation.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call-secret",
      content: rawResult,
    });
  });

  test("preserves a failed tool result as binary error semantics and continues", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([{ index: 0, id: "call-denied", name: "lookup_order", arguments: "{}" }]),
          finalTurn("Cannot access that order"),
        ],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async () => ({
          success: false,
          reason: "denied",
          contentItems: [{ type: "inputText", text: "access denied" }],
        }),
      }),
    );

    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      toolUseId: "call-denied",
      content: "access denied",
      isError: true,
    });
    const continuation = requests[1]?.body as unknown as { messages: Array<Record<string, unknown>> };
    expect(continuation.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call-denied",
      content: "access denied",
    });
    expect(events.at(-1)?.type).toBe("turn.complete");
  });

  test("turns a thrown tool handler into one redacted failed result without replaying the call", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    let dispatches = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [toolTurn([{ index: 0, id: "call-throw", name: "lookup_order", arguments: "{}" }]), finalTurn("Recovered")],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async () => {
          dispatches += 1;
          throw new Error("synthetic handler secret");
        },
      }),
    );

    expect(dispatches).toBe(1);
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      expect.objectContaining({
        type: "tool.completed",
        toolUseId: "call-throw",
        content: "Tool execution failed.",
        isError: true,
      }),
    ]);
    expect(events.filter((event) => event.type === "tool.result_delivered")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("synthetic handler secret");
    expect(JSON.stringify(requests[1]?.body)).not.toContain("synthetic handler secret");
  });

  test("rejects malformed, non-object, empty, and duplicate tool calls before host dispatch", async () => {
    const invalidCases: Array<{
      name: string;
      calls: Array<{ index: number; id: string; name: string; arguments: string }>;
    }> = [
      {
        name: "malformed JSON",
        calls: [{ index: 0, id: "call-1", name: "lookup_order", arguments: '{"id":' }],
      },
      { name: "array arguments", calls: [{ index: 0, id: "call-1", name: "lookup_order", arguments: "[]" }] },
      { name: "null arguments", calls: [{ index: 0, id: "call-1", name: "lookup_order", arguments: "null" }] },
      { name: "empty id", calls: [{ index: 0, id: " ", name: "lookup_order", arguments: "{}" }] },
      { name: "empty name", calls: [{ index: 0, id: "call-1", name: " ", arguments: "{}" }] },
      {
        name: "duplicate id",
        calls: [
          { index: 0, id: "duplicate", name: "lookup_order", arguments: "{}" },
          { index: 1, id: "duplicate", name: "lookup_order", arguments: "{}" },
        ],
      },
    ];

    for (const testCase of invalidCases) {
      let dispatches = 0;
      const provider = createKimiCodeRuntimeProvider({
        transportFactory: () => transportFrom(toolTurn(testCase.calls)),
      });
      const events = await collectEvents(
        provider,
        startRequest({
          handleRuntimeToolCall: async () => {
            dispatches += 1;
            return { success: true, contentItems: [] };
          },
        }),
      );

      expect(dispatches, testCase.name).toBe(0);
      expect(
        events.some((event) => event.type === "tool.started"),
        testCase.name,
      ).toBe(false);
      expect(events.at(-1), testCase.name).toMatchObject({
        type: "turn.failed",
        error: "Kimi Code tool call was invalid",
      });
    }
  });

  test("executes two tool calls serially in provider index order with exact paired events", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    const dispatchOrder: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDispatched = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([
            { index: 1, id: "call-second", name: "second", arguments: '{"step":2}' },
            { index: 0, id: "call-first", name: "first", arguments: '{"step":1}' },
          ]),
          finalTurn("Both complete"),
        ],
        requests,
      ),
    });
    const collecting = collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async (request) => {
          dispatchOrder.push(request.callId ?? "missing");
          if (request.callId === "call-first") {
            firstStarted();
            await firstBlocked;
          }
          return { success: true, contentItems: [{ type: "inputText", text: request.callId ?? "missing" }] };
        },
      }),
    );

    await Promise.race([firstDispatched, collecting]);
    expect(dispatchOrder).toEqual(["call-first"]);
    releaseFirst();
    const events = await collecting;

    expect(dispatchOrder).toEqual(["call-first", "call-second"]);
    expect(
      events
        .filter(
          (
            event,
          ): event is Extract<RuntimeEvent, { type: "tool.started" | "tool.completed" | "tool.result_delivered" }> =>
            event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.result_delivered",
        )
        .map((event) =>
          event.type === "tool.started"
            ? `${event.type}:${event.toolUse.id}`
            : event.type === "tool.completed"
              ? `${event.type}:${event.toolUseId}`
              : `${event.type}:${event.toolCallId}`,
        ),
    ).toEqual([
      "tool.started:call-first",
      "tool.completed:call-first",
      "tool.result_delivered:call-first",
      "tool.started:call-second",
      "tool.completed:call-second",
      "tool.result_delivered:call-second",
    ]);
  });

  test("stops tool dispatch between calls when the turn is aborted", async () => {
    const abortController = new AbortController();
    const dispatches: string[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom(
          toolTurn([
            { index: 0, id: "call-first", name: "first", arguments: "{}" },
            { index: 1, id: "call-second", name: "second", arguments: "{}" },
          ]),
        ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        abortController,
        handleRuntimeToolCall: async (request) => {
          dispatches.push(request.callId ?? "missing");
          abortController.abort();
          return { success: true, contentItems: [{ type: "inputText", text: "done" }] };
        },
      }),
    );

    expect(dispatches).toEqual(["call-first"]);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.started",
      "tool.completed",
      "tool.result_delivered",
      "turn.interrupted",
    ]);
  });

  test("bounds tool result text before the next provider request", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [toolTurn([{ index: 0, id: "call-large", name: "lookup_order", arguments: "{}" }]), finalTurn("ok")],
        requests,
      ),
    });

    await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async () => ({
          success: true,
          contentItems: [
            { type: "inputText", text: "x".repeat(80 * 1024) },
            { type: "inputImage", imageUrl: "https://secret.invalid/signed-token" },
          ],
        }),
      }),
    );

    const continuation = requests[1]?.body as unknown as { messages: Array<Record<string, unknown>> };
    const content = continuation.messages[2]?.content;
    expect(typeof content).toBe("string");
    expect(new TextEncoder().encode(String(content)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(content).not.toContain("signed-token");
  });

  test("fails deterministically when the tool loop exceeds its finite round bound", async () => {
    let providerRounds = 0;
    let dispatches = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => {
        providerRounds += 1;
        if (providerRounds > 20) throw new Error("synthetic unbounded loop");
        return transportFrom(
          toolTurn([
            {
              index: 0,
              id: `loop-${providerRounds}`,
              name: "lookup_order",
              arguments: "{}",
            },
          ]),
        );
      },
    });

    const events = await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async () => {
          dispatches += 1;
          return { success: true, contentItems: [{ type: "inputText", text: "again" }] };
        },
      }),
    );

    expect(providerRounds).toBeLessThanOrEqual(20);
    expect(dispatches).toBeLessThan(20);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code tool loop limit exceeded" });
  });

  test("rejects an oversized tool-call batch before any host dispatch", async () => {
    let dispatches = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () =>
        transportFrom(
          toolTurn(
            Array.from({ length: 33 }, (_, index) => ({
              index,
              id: `batch-${index}`,
              name: "lookup_order",
              arguments: "{}",
            })),
          ),
        ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        handleRuntimeToolCall: async () => {
          dispatches += 1;
          return { success: true, contentItems: [] };
        },
      }),
    );

    expect(dispatches).toBe(0);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code tool loop limit exceeded" });
  });

  test("commits complete private native state and publishes its locator only at successful terminal", async () => {
    const fixture = isolatedStateEnv();
    const requests: KimiCodeTransportRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([{ index: 0, id: "state-call", name: "lookup_order", arguments: '{"id":42}' }], {
            reasoning: "private tool reasoning",
          }),
          [
            {
              type: "message",
              data: {
                choices: [
                  {
                    index: 0,
                    delta: { content: "Persisted answer", reasoning_content: "private final reasoning" },
                    finish_reason: "stop",
                  },
                ],
              },
            },
            { type: "done" },
          ],
        ],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        handleRuntimeToolCall: async () => ({
          success: true,
          contentItems: [{ type: "inputText", text: "order:42" }],
        }),
      }),
    );
    const terminal = events.at(-1);

    expect(events.slice(0, -1).every((event) => !("session" in event))).toBe(true);
    expect(terminal).toMatchObject({
      type: "turn.complete",
      session: { params: { revision: 1, provider: "kimi-code", model: "k3" } },
    });
    expect(JSON.stringify(events)).not.toContain("private tool reasoning");
    expect(JSON.stringify(events)).not.toContain("private final reasoning");
    expect(JSON.stringify(events)).not.toContain("provider-key-must-stay-private");

    if (terminal?.type !== "turn.complete" || !terminal.session) throw new Error("missing committed test state");
    const providerSessionId = terminal.providerSessionId;
    if (!providerSessionId) throw new Error("missing provider session id");
    expect(providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests).not.toHaveLength(0);
    expect(requests.map((request) => request.body.prompt_cache_key)).toEqual(requests.map(() => providerSessionId));
    expect(terminal.session.displayId).toBe(providerSessionId);
    const snapshot = await loadKimiCodeSessionState({
      session: terminal.session,
      model: "k3",
      cwd: join(fixture.root, "workspace"),
      env: fixture.env,
    });
    expect(snapshot.messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "private tool reasoning",
        tool_calls: [
          {
            id: "state-call",
            type: "function",
            function: { name: "lookup_order", arguments: '{"id":42}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "state-call", content: "order:42" },
      {
        role: "assistant",
        content: "Persisted answer",
        reasoning_content: "private final reasoning",
        tool_calls: [],
      },
    ]);
  });

  test("keeps end-to-end private sentinels out of host input, public events, and public state", async () => {
    const fixture = isolatedStateEnv();
    const managedKey = "sk-test_kimi_managed_secret_123456789";
    const promptSentinel = "PRIVATE_PROMPT_SENTINEL";
    const pathSentinel = "C:/synthetic/PRIVATE_PATH_SENTINEL.png";
    const reasoningSentinel = "PRIVATE_REASONING_SENTINEL";
    const toolInputSentinel = "sk-test_tool_input_secret_123456789";
    const toolOutputSentinel = "sk-test_tool_output_secret_123456789";
    const requests: KimiCodeTransportRequest[] = [];
    const hostInputs: RuntimeDynamicToolCallRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn(
            [
              {
                index: 0,
                id: "sentinel-call",
                name: "lookup_order",
                arguments: JSON.stringify({ token: toolInputSentinel }),
              },
            ],
            { reasoning: reasoningSentinel },
          ),
          finalTurn("Synthetic completion"),
        ],
        requests,
      ),
    });

    const events = await collectEvents(
      provider,
      startRequest({
        prompt: prompts(`${promptSentinel} ${pathSentinel}`),
        cwd: join(fixture.root, "workspace"),
        env: { ...fixture.env, KIMI_API_KEY: managedKey },
        handleRuntimeToolCall: async (request) => {
          hostInputs.push(request);
          return { success: true, contentItems: [{ type: "inputText", text: toolOutputSentinel }] };
        },
      }),
    );

    expect(JSON.stringify(hostInputs)).not.toContain(managedKey);
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${managedKey}`);
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(managedKey);
    const publicEvents = JSON.stringify(events);
    for (const sentinel of [
      managedKey,
      promptSentinel,
      pathSentinel,
      reasoningSentinel,
      toolInputSentinel,
      toolOutputSentinel,
    ]) {
      expect(publicEvents).not.toContain(sentinel);
    }

    const terminal = events.at(-1);
    if (terminal?.type !== "turn.complete" || !terminal.session) throw new Error("missing committed sentinel state");
    const publicState = JSON.stringify(terminal.session);
    expect(publicState).not.toContain(managedKey);
    expect(publicState).not.toContain(reasoningSentinel);
    const privateState = readFileSync(String(terminal.session.params?.sessionFile), "utf8");
    expect(privateState).not.toContain(managedKey);
    expect(privateState).toContain(promptSentinel);
    expect(privateState).toContain(reasoningSentinel);
  });

  test("omits unsupported attachments and host integrations from native requests", async () => {
    const requests: KimiCodeTransportRequest[] = [];
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence([finalTurn("Text only")], requests),
    });
    const mediaPaths = "C:/synthetic/image.png C:/synthetic/video.mp4";

    const events = await collectEvents(
      provider,
      startRequest({
        prompt: prompts(mediaPaths),
        mcpServers: { privateMcp: { command: "synthetic" } },
        plugins: [{ type: "local", path: "C:/synthetic/plugin" }],
        remoteSpawn: { target: "synthetic-worker" },
      }),
    );

    const body = requests[0]?.body as unknown as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "user", content: mediaPaths },
      { role: "system", content: "Ravi policy." },
    ]);
    for (const unsupportedKey of ["images", "videos", "response_format", "plugins", "mcp_servers", "remote_spawn"]) {
      expect(body).not.toHaveProperty(unsupportedKey);
    }
    expect(events.at(-1)?.type).toBe("turn.complete");
    expect(createKimiCodeRuntimeProvider().getCapabilities().tools.supportsParallelCalls).toBe(false);
  });

  test("resumes byte-faithful reasoning and tool pairings before the next provider request", async () => {
    const fixture = isolatedStateEnv();
    const initialRequests: KimiCodeTransportRequest[] = [];
    const initialProvider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence(
        [
          toolTurn([{ index: 0, id: "resume-call", name: "lookup_order", arguments: '{"raw":"exact"}' }], {
            content: "tool preface",
            reasoning: "resume-private-reasoning",
          }),
          finalTurn("initial final"),
        ],
        initialRequests,
      ),
    });
    const initialEvents = await collectEvents(
      initialProvider,
      startRequest({
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        handleRuntimeToolCall: async () => ({
          success: true,
          contentItems: [{ type: "inputText", text: "exact-result" }],
        }),
      }),
    );
    const initialTerminal = initialEvents.at(-1);
    if (initialTerminal?.type !== "turn.complete" || !initialTerminal.session) {
      throw new Error("missing initial committed state");
    }

    const resumedRequests: KimiCodeTransportRequest[] = [];
    const resumedProvider = createKimiCodeRuntimeProvider({
      transportFactory: transportSequence([finalTurn("resumed final")], resumedRequests),
    });
    const resumedEvents = await collectEvents(
      resumedProvider,
      startRequest({
        prompt: prompts("follow-up"),
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        resumeSession: initialTerminal.session,
      }),
    );

    const requestBody = resumedRequests[0]?.body as unknown as { messages: unknown[] };
    expect(requestBody.messages.slice(0, 5)).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "tool preface",
        reasoning_content: "resume-private-reasoning",
        tool_calls: [
          {
            id: "resume-call",
            type: "function",
            function: { name: "lookup_order", arguments: '{"raw":"exact"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "resume-call", content: "exact-result" },
      { role: "assistant", content: "initial final", reasoning_content: "", tool_calls: [] },
      { role: "user", content: "follow-up" },
    ]);
    expect(resumedEvents.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: initialTerminal.providerSessionId,
      session: { params: { revision: 2 } },
    });
  });

  test("preserves the previous commit on failed and interrupted turns", async () => {
    const fixture = isolatedStateEnv();
    const seedProvider = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom(finalTurn("seed")) });
    const seedEvents = await collectEvents(
      seedProvider,
      startRequest({ cwd: join(fixture.root, "workspace"), env: fixture.env }),
    );
    const seedTerminal = seedEvents.at(-1);
    if (seedTerminal?.type !== "turn.complete" || !seedTerminal.session) throw new Error("missing seed state");
    const sessionDir = dirname(String(seedTerminal.session.params?.sessionFile));

    const failed = createKimiCodeRuntimeProvider({
      transportFactory: () => transportFrom([{ type: "message", data: { choices: "invalid" } }]),
    });
    const failedEvents = await collectEvents(
      failed,
      startRequest({
        prompt: prompts("failed"),
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        resumeSession: seedTerminal.session,
      }),
    );

    const abortController = new AbortController();
    abortController.abort();
    let interruptedRequests = 0;
    const interrupted = createKimiCodeRuntimeProvider({
      transportFactory: () => {
        interruptedRequests += 1;
        return transportFrom(finalTurn("must not run"));
      },
    });
    const interruptedEvents = await collectEvents(
      interrupted,
      startRequest({
        prompt: prompts("interrupted"),
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        resumeSession: seedTerminal.session,
        abortController,
      }),
    );

    expect(failedEvents.at(-1)?.type).toBe("turn.failed");
    expect(interruptedEvents.at(-1)?.type).toBe("turn.interrupted");
    expect(interruptedRequests).toBe(0);
    expect(readdirSync(sessionDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(failedEvents.every((event) => !("session" in event))).toBe(true);
    expect(interruptedEvents.every((event) => !("session" in event))).toBe(true);
  });

  test("leaves a completed commit orphaned when interrupted after assistant publication", async () => {
    const fixture = isolatedStateEnv();
    const provider = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom(finalTurn("answer")) });
    const handle = provider.startSession(startRequest({ cwd: join(fixture.root, "workspace"), env: fixture.env }));
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("turn.started");
    expect((await iterator.next()).value?.type).toBe("text.delta");
    expect((await iterator.next()).value?.type).toBe("assistant.message");
    await handle.interrupt();
    const terminal = (await iterator.next()).value;

    expect(terminal?.type).toBe("turn.interrupted");
    expect(terminal && "session" in terminal).toBe(false);
    expect((await iterator.next()).done).toBe(true);
  });

  test("rejects invalid resume state before opening a provider request", async () => {
    const fixture = isolatedStateEnv();
    const seedProvider = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom(finalTurn("seed")) });
    const seedEvents = await collectEvents(
      seedProvider,
      startRequest({ cwd: join(fixture.root, "workspace"), env: fixture.env }),
    );
    const seedTerminal = seedEvents.at(-1);
    if (seedTerminal?.type !== "turn.complete" || !seedTerminal.session) throw new Error("missing seed state");
    const invalid: RuntimeSessionState = {
      ...seedTerminal.session,
      params: { ...seedTerminal.session.params, model: "k2.5" },
    };
    let requests = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => {
        requests += 1;
        return transportFrom(finalTurn("must not run"));
      },
    });

    const events = await collectEvents(
      provider,
      startRequest({
        prompt: prompts("resume invalid"),
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        resumeSession: invalid,
      }),
    );

    expect(requests).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code session state is invalid" });
  });

  test("rejects conflicting canonical resume identifiers before opening a provider request", async () => {
    const fixture = isolatedStateEnv();
    const seedProvider = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom(finalTurn("seed")) });
    const seedEvents = await collectEvents(
      seedProvider,
      startRequest({ cwd: join(fixture.root, "workspace"), env: fixture.env }),
    );
    const seedTerminal = seedEvents.at(-1);
    if (seedTerminal?.type !== "turn.complete" || !seedTerminal.session) throw new Error("missing seed state");

    for (const conflict of [
      { resume: "00000000-0000-4000-8000-000000000000" },
      { resumeSession: { ...seedTerminal.session, displayId: "00000000-0000-4000-8000-000000000000" } },
      { resumeSession: { ...seedTerminal.session, displayId: undefined } },
    ]) {
      let requests = 0;
      const provider = createKimiCodeRuntimeProvider({
        transportFactory: () => {
          requests += 1;
          return transportFrom(finalTurn("must not run"));
        },
      });
      const events = await collectEvents(
        provider,
        startRequest({
          prompt: prompts("resume conflicting id"),
          cwd: join(fixture.root, "workspace"),
          env: fixture.env,
          resumeSession: seedTerminal.session,
          ...conflict,
        }),
      );

      expect(requests).toBe(0);
      expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code session state is invalid" });
    }
  }, 15_000);

  test("rejects fork state without opening a provider request", async () => {
    const fixture = isolatedStateEnv();
    let requests = 0;
    const provider = createKimiCodeRuntimeProvider({
      transportFactory: () => {
        requests += 1;
        return transportFrom(finalTurn("must not run"));
      },
    });

    const events = await collectEvents(
      provider,
      startRequest({ cwd: join(fixture.root, "workspace"), env: fixture.env, forkSession: true }),
    );

    expect(requests).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code session fork is unsupported" });
  });

  test("fails the terminal instead of publishing a commit when state exceeds its bound", async () => {
    const fixture = isolatedStateEnv();
    const nearlyFull = await commitKimiCodeSessionState({
      sessionId: createKimiCodeSessionId(),
      model: "k3",
      cwd: join(fixture.root, "workspace"),
      lastCommittedTurnId: "seed-large",
      messages: [
        { role: "user", content: "u".repeat(1_900_000) },
        { role: "assistant", content: "a".repeat(1_900_000), reasoning_content: "", tool_calls: [] },
      ],
      env: fixture.env,
    });
    const provider = createKimiCodeRuntimeProvider({ transportFactory: () => transportFrom(finalTurn("answer")) });
    const events = await collectEvents(
      provider,
      startRequest({
        prompt: prompts("x".repeat(500_000)),
        cwd: join(fixture.root, "workspace"),
        env: fixture.env,
        resumeSession: nearlyFull.session,
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "Kimi Code session state commit failed" });
    expect(events.some((event) => event.type === "turn.complete")).toBe(false);
  });
});

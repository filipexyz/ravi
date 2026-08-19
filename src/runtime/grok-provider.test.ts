import { describe, expect, it } from "bun:test";
import {
  buildGrokAcpProcessArgs,
  buildGrokAcpSpawnEnv,
  createGrokRuntimeProvider,
  selectGrokAuthMethod,
  selectGrokPermissionOutcome,
  toGrokEffort,
  type GrokAcpNotification,
  type GrokAcpStartInput,
  type GrokAcpTransport,
} from "./grok-provider.js";
import type { RuntimeEvent, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

interface TestQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

class FakeGrokAcpTransport implements GrokAcpTransport {
  readonly events: TestQueue<GrokAcpNotification> = createTestQueue<GrokAcpNotification>();
  readonly starts: GrokAcpStartInput[] = [];
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  responseFor?: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>;
  closed = false;
  closeCalls = 0;

  async start(input: GrokAcpStartInput): Promise<void> {
    this.starts.push(input);
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    const response = await this.responseFor?.(method, params);
    if (response !== undefined) {
      return response;
    }
    return defaultGrokResponse(method);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
  }

  pushEvent(event: GrokAcpNotification): void {
    this.events.push(event);
  }

  endEvents(): void {
    this.events.end();
  }
}

describe("Grok Build runtime provider", () => {
  it("advertises an explicit subprocess RPC capability matrix", () => {
    expect(createGrokRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: true,
        operations: ["turn.interrupt"],
      },
      dynamicTools: {
        mode: "none",
      },
      execution: {
        mode: "subprocess-rpc",
      },
      sessionState: {
        mode: "provider-session-id",
        requiresCwdMatch: true,
      },
      usage: {
        semantics: "terminal-event",
      },
      tools: {
        permissionMode: "provider-native",
        accessRequirement: "tool_and_executable",
        supportsParallelCalls: false,
      },
      systemPrompt: {
        mode: "append",
      },
      terminalEvents: {
        guarantee: "adapter",
      },
      skillVisibility: {
        availability: "none",
        loadedState: "none",
      },
      modelBroker: {
        protocols: ["openai-completions"],
        principalIsolation: "none",
      },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: false,
      supportsHostSessionHooks: false,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
    });
  });

  it("never reintroduces daemon secrets into the subprocess spawn envelope", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "daemon-secret-must-not-leak";
    try {
      const env = buildGrokAcpSpawnEnv({ env: { PATH: "/usr/bin", XAI_API_KEY: "from-request" } });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env).toEqual({ PATH: "/usr/bin", XAI_API_KEY: "from-request" });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("spawns grok agent stdio with conservative headless flags", () => {
    expect(
      buildGrokAcpProcessArgs({
        model: "grok-4",
        effort: "ultra",
        systemPromptAppend: "Ravi instructions",
      }),
    ).toEqual([
      "--no-auto-update",
      "--no-alt-screen",
      "--always-approve",
      "-m",
      "grok-4",
      "--effort",
      "high",
      "--append-system-prompt",
      "Ravi instructions",
      "agent",
      "stdio",
    ]);
  });

  it("maps strongest Ravi effort values onto Grok high", () => {
    expect(toGrokEffort("none")).toBe("none");
    expect(toGrokEffort("minimal")).toBe("minimal");
    expect(toGrokEffort("low")).toBe("low");
    expect(toGrokEffort("medium")).toBe("medium");
    expect(toGrokEffort("high")).toBe("high");
    expect(toGrokEffort("xhigh")).toBe("high");
    expect(toGrokEffort("max")).toBe("high");
    expect(toGrokEffort("ultra")).toBe("high");
  });

  it("prefers xai.api_key when the env key is present", () => {
    expect(selectGrokAuthMethod([{ id: "cached_token" }, { id: "xai.api_key" }], { XAI_API_KEY: "xai-test" })).toBe(
      "xai.api_key",
    );
    expect(selectGrokAuthMethod([{ id: "cached_token" }, { id: "xai.api_key" }], {})).toBe("cached_token");
  });

  it("auto-selects an allow permission option", () => {
    expect(
      selectGrokPermissionOutcome([
        { optionId: "reject-once", kind: "reject_once" },
        { optionId: "allow-once", kind: "allow_once" },
      ]),
    ).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("closes the Grok ACP transport idempotently", async () => {
    const transport = new FakeGrokAcpTransport();
    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("close"));

    await handle.close?.();
    await handle.close?.();

    expect(transport.closeCalls).toBe(1);
  });

  it("normalizes a successful ACP prompt into canonical runtime events", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_thought_chunk", {
            content: { type: "text", text: "hidden reasoning" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "ola" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: " mundo" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("usage_update", {
            used: 42,
            size: 200000,
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("faz um teste")).events,
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "provider.raw",
      "status",
      "provider.raw",
      "text.delta",
      "provider.raw",
      "text.delta",
      "provider.raw",
      "assistant.message",
      "turn.complete",
    ]);
    expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
      type: "assistant.message",
      text: "ola mundo",
    });
    expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: "grok-session-1",
      session: {
        displayId: "grok-session-1",
        params: {
          integration: "acp",
          cwd: "/tmp",
          sessionId: "grok-session-1",
          model: "grok-4",
        },
      },
      execution: {
        provider: "grok",
        model: "grok-4",
        billingType: "unknown",
      },
      usage: {
        inputTokens: 42,
        outputTokens: 0,
      },
    });
    expect(transport.starts[0]).toMatchObject({
      cwd: "/tmp",
      model: "grok-4",
      effort: "high",
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests.find((request) => request.method === "session/prompt")?.params).toEqual({
      sessionId: "grok-session-1",
      prompt: [{ type: "text", text: "faz um teste" }],
    });
    expect(transport.closed).toBe(true);
  });

  it("maps tool_call updates into canonical tool events", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("tool_call", {
            toolCallId: "call_1",
            title: "Read file",
            kind: "read",
            rawInput: { path: "README.md" },
          }),
        );
        transport.pushEvent(
          sessionUpdate("tool_call_update", {
            toolCallId: "call_1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
          }),
        );
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "li o arquivo" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("leia")).events,
    );

    expect(events.find((event) => event.type === "tool.started")).toMatchObject({
      type: "tool.started",
      toolUse: {
        id: "call_1",
        name: "Read file",
        input: { path: "README.md" },
      },
    });
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      type: "tool.completed",
      toolUseId: "call_1",
      isError: false,
    });
    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.complete",
    ]);
  });

  it("resumes an ACP session with session/load when stored state exists", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_message_chunk", {
            content: { type: "text", text: "continuidade" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(
        createStartRequest("continua", {
          resume: "stored-session",
          resumeSession: {
            params: { sessionId: "stored-session", cwd: "/tmp" },
            displayId: "stored-session",
          },
        }),
      ).events,
    );

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/load",
      "session/prompt",
    ]);
    expect(transport.requests.find((request) => request.method === "session/load")?.params).toEqual({
      sessionId: "stored-session",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: "stored-session",
    });
  });

  it("emits a failed terminal event when Grok rejects a prompt", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return Promise.reject(new Error("Grok prompt was rejected"));
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("falha")).events,
    );

    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Grok prompt was rejected",
      recoverable: true,
    });
  });

  it("emits turn.interrupted when session/prompt stops as cancelled", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return { stopReason: "cancelled" };
      }
      return defaultGrokResponse(method);
    };

    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("aborta"));
    const events = await collectRuntimeEvents(handle.events);

    expect(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.interrupted",
    ]);
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
  });

  it("sends session/cancel from interrupt and control", async () => {
    const transport = new FakeGrokAcpTransport();
    let releasePrompt: ((value: unknown) => void) | undefined;
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      }
      return defaultGrokResponse(method);
    };

    const handle = createGrokRuntimeProvider({ transport }).startSession(createStartRequest("controle"));
    const collected: RuntimeEvent[] = [];
    const consuming = (async () => {
      for await (const event of handle.events) {
        collected.push(event);
      }
    })();

    await waitFor(() => transport.requests.some((request) => request.method === "session/prompt"));
    await handle.interrupt();
    const control = await handle.control?.({ operation: "turn.interrupt" });
    releasePrompt?.({ stopReason: "cancelled" });
    await consuming;

    expect(transport.notifications.filter((notification) => notification.method === "session/cancel")).toHaveLength(2);
    expect(control).toMatchObject({
      ok: true,
      operation: "turn.interrupt",
    });
    expect(collected.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
  });

  it("does not leak thought chunks as assistant text", async () => {
    const transport = new FakeGrokAcpTransport();
    transport.responseFor = (method) => {
      if (method === "session/prompt") {
        transport.pushEvent(
          sessionUpdate("agent_thought_chunk", {
            content: { type: "text", text: "secret chain of thought" },
          }),
        );
        return { stopReason: "end_turn" };
      }
      return defaultGrokResponse(method);
    };

    const events = await collectRuntimeEvents(
      createGrokRuntimeProvider({ transport }).startSession(createStartRequest("pense")).events,
    );

    expect(events.some((event) => event.type === "assistant.message")).toBe(false);
    expect(events.filter((event) => event.type === "text.delta")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("turn.complete");
  });
});

function createStartRequest(text: string, overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: onePrompt(text),
    model: "grok-4",
    effort: "high",
    cwd: "/tmp",
    abortController: new AbortController(),
    systemPromptAppend: "Ravi runtime instructions",
    ...overrides,
  };
}

async function* onePrompt(text: string): AsyncGenerator<RuntimePromptMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
    session_id: "session",
    parent_tool_use_id: null,
  };
}

async function collectRuntimeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sessionUpdate(sessionUpdate: string, extra: Record<string, unknown> = {}): GrokAcpNotification {
  return {
    method: "session/update",
    params: {
      sessionId: "grok-session-1",
      update: {
        sessionUpdate,
        ...extra,
      },
    },
  };
}

function defaultGrokResponse(method: string): unknown {
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      authMethods: [{ id: "cached_token" }],
      agentCapabilities: { loadSession: true },
    };
  }
  if (method === "authenticate") {
    return {};
  }
  if (method === "session/new") {
    return { sessionId: "grok-session-1" };
  }
  if (method === "session/load") {
    return {};
  }
  if (method === "session/prompt") {
    return { stopReason: "end_turn" };
  }
  return {};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for Grok fake transport condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTestQueue<T>(): TestQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown;

  return {
    push(value) {
      if (ended || failure) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended || failure) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error) {
      if (ended || failure) {
        return;
      }
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve({ value: undefined as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

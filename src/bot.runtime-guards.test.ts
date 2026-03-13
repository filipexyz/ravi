import { beforeEach, describe, expect, it, mock } from "bun:test";

type RuntimeProviderId = "claude" | "codex";

type RuntimeStartRequest = {
  prompt: AsyncGenerator<{
    type: "user";
    message: { role: "user"; content: string };
    session_id: string;
    parent_tool_use_id: string | null;
  }>;
  model: string;
  cwd: string;
  resume?: string;
  forkSession?: boolean;
  abortController: AbortController;
  systemPromptAppend: string;
  env?: Record<string, string>;
};

type RuntimePlugin = {
  type: "local";
  path: string;
};

type SessionState = {
  sessionKey: string;
  name?: string;
  agentId: string;
  agentCwd: string;
  runtimeProvider?: RuntimeProviderId;
  providerSessionId?: string;
  sdkSessionId?: string;
  modelOverride?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

type RuntimeHandle = {
  provider: RuntimeProviderId;
  events: AsyncIterable<Record<string, unknown>>;
  interrupt(): Promise<void>;
};

const emittedEvents: Array<{ topic: string; data: any }> = [];
const sessions = new Map<string, SessionState>();
let activeProvider: RuntimeProviderId = "claude";
let runtimeStartCalls: RuntimeStartRequest[] = [];
let runtimePrepareImpl: (
  providerId: RuntimeProviderId,
  input: { agentId: string; cwd: string; plugins?: RuntimePlugin[] },
) => Promise<{ env?: Record<string, string> } | undefined>;
let runtimeStartImpl: (providerId: RuntimeProviderId, request: RuntimeStartRequest) => RuntimeHandle;
let discoveredPlugins: RuntimePlugin[] = [];

const clearProviderSession = mock((sessionKey: string) => {
  const session = sessions.get(sessionKey);
  if (!session) return;
  session.runtimeProvider = undefined;
  session.providerSessionId = undefined;
  session.sdkSessionId = undefined;
});

function resetRuntimeDoubles(): void {
  runtimeStartCalls = [];
  runtimePrepareImpl = async () => undefined;
  discoveredPlugins = [];
  runtimeStartImpl = (providerId) => ({
    provider: providerId,
    events: (async function* () {
      yield {
        type: "turn.complete",
        providerSessionId: `${providerId}-session`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })(),
    interrupt: async () => {},
  });
}

function getOrCreateSessionState(
  sessionKey: string,
  agentId: string,
  agentCwd: string,
  defaults?: Partial<SessionState>,
): SessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    existing.agentId = agentId;
    existing.agentCwd = agentCwd;
    existing.name = defaults?.name ?? existing.name ?? sessionKey;
    return existing;
  }

  const created: SessionState = {
    sessionKey,
    name: defaults?.name ?? sessionKey,
    agentId,
    agentCwd,
    runtimeProvider: defaults?.runtimeProvider,
    providerSessionId: defaults?.providerSessionId,
    sdkSessionId: defaults?.sdkSessionId,
    modelOverride: defaults?.modelOverride,
    lastChannel: defaults?.lastChannel,
    lastTo: defaults?.lastTo,
    lastAccountId: defaults?.lastAccountId,
  };
  sessions.set(sessionKey, created);
  return created;
}

mock.module("./nats.js", () => ({
  nats: {
    emit: mock(async (topic: string, data: any) => {
      emittedEvents.push({ topic, data });
    }),
    subscribe: mock(async function* () {}),
  },
  ensureConnected: mock(async () => ({})),
  publish: mock(async () => {}),
  subscribe: mock(async function* () {}),
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  getNats: mock(() => ({})),
}));

mock.module("./db.js", () => ({
  saveMessage: mock(() => {}),
  backfillProviderSessionId: mock(() => {}),
  close: mock(() => {}),
}));

mock.module("./prompt-builder.js", () => ({
  buildSystemPrompt: () => "",
  SILENT_TOKEN: "@@SILENT@@",
}));

mock.module("./router/index.js", () => ({
  getOrCreateSession: (key: string, agentId: string, agentCwd: string, defaults?: Partial<SessionState>) =>
    getOrCreateSessionState(key, agentId, agentCwd, defaults),
  getSession: (key: string) => sessions.get(key) ?? null,
  getSessionByName: (name: string) => {
    for (const session of sessions.values()) {
      if ((session.name ?? session.sessionKey) === name) {
        return session;
      }
    }
    return null;
  },
  clearProviderSession,
  updateProviderSession: mock((sessionKey: string, provider: RuntimeProviderId, providerSessionId: string) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    session.runtimeProvider = provider;
    session.providerSessionId = providerSessionId;
    session.sdkSessionId = providerSessionId;
  }),
  updateTokens: mock(() => {}),
  updateSessionSource: mock((sessionKey: string, source: { channel?: string; accountId?: string; chatId?: string }) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    session.lastChannel = source.channel;
    session.lastAccountId = source.accountId;
    session.lastTo = source.chatId;
  }),
  updateSessionContext: mock(() => {}),
  updateSessionDisplayName: mock(() => {}),
  closeRouterDb: mock(() => {}),
  deleteSession: mock((sessionKey: string) => sessions.delete(sessionKey)),
  expandHome: (path: string) => path.replace("~", "/tmp/ravi-test-bot"),
  getAnnounceCompaction: () => false,
  getAccountForAgent: () => null,
  dbInsertCostEvent: mock(() => {}),
}));

mock.module("./config-store.js", () => ({
  configStore: {
    getConfig: () => ({
      agents: {
        main: {
          id: "main",
          cwd: "/tmp/ravi-test-bot/main",
          provider: activeProvider,
          model: "test-model",
        },
      },
      routes: [],
      defaultAgent: "main",
      defaultDmScope: "main",
      accountAgents: {},
      instanceToAccount: {},
      instances: {},
    }),
    resolveInstanceId: () => undefined,
  },
}));

mock.module("./cli/context.js", () => ({
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("./heartbeat/index.js", () => ({
  HEARTBEAT_OK: "HEARTBEAT_OK",
}));

mock.module("./bash/index.js", () => ({
  createBashPermissionHook: () => ({
    matcher: "Bash",
    hooks: [async () => ({})],
  }),
  createToolPermissionHook: () => ({
    hooks: [async () => ({})],
  }),
}));

mock.module("./hooks/index.js", () => ({
  createPreCompactHook: () => async () => ({}),
}));

mock.module("./hooks/sanitize-bash.js", () => ({
  SANITIZED_ENV_VARS: ["RAVI_SECRET"],
  createSanitizeBashHook: () => ({
    matcher: "Bash",
    hooks: [async () => ({})],
  }),
}));

mock.module("./constants.js", () => ({
  calculateCost: () => null,
}));

mock.module("./plugins/index.js", () => ({
  discoverPlugins: () => discoveredPlugins,
}));

mock.module("./spec/server.js", () => ({
  createSpecServer: () => null,
  isSpecModeActive: () => false,
  getSpecState: () => undefined,
}));

mock.module("./remote-spawn.js", () => ({
  createRemoteSpawn: () => {
    throw new Error("Remote spawn should not be used in bot runtime guard tests");
  },
}));

mock.module("./remote-spawn-nats.js", () => ({
  createNatsRemoteSpawn: () => {
    throw new Error("NATS remote spawn should not be used in bot runtime guard tests");
  },
}));

mock.module("./permissions/engine.js", () => ({
  agentCan: () => true,
}));

mock.module("./runtime/index.js", () => ({
  createRuntimeProvider: (providerId: RuntimeProviderId = "claude") => {
    const capabilities =
      providerId === "codex"
        ? {
            supportsSessionResume: true,
            supportsSessionFork: false,
            supportsPartialText: false,
            supportsToolHooks: false,
            supportsPlugins: false,
            supportsMcpServers: false,
            supportsRemoteSpawn: false,
          }
        : {
            supportsSessionResume: true,
            supportsSessionFork: true,
            supportsPartialText: true,
            supportsToolHooks: true,
            supportsPlugins: true,
            supportsMcpServers: true,
            supportsRemoteSpawn: true,
          };

    return {
      id: providerId,
      getCapabilities: () => capabilities,
      prepareSession: (input: { agentId: string; cwd: string; plugins?: RuntimePlugin[] }) =>
        runtimePrepareImpl(providerId, input),
      startSession: (input: RuntimeStartRequest) => {
        runtimeStartCalls.push(input);
        return runtimeStartImpl(providerId, input);
      },
    };
  },
  assertRuntimeCompatibility: (
    provider: {
      id: RuntimeProviderId;
      getCapabilities(): { supportsToolHooks: boolean; supportsMcpServers: boolean; supportsRemoteSpawn: boolean };
    },
    request: {
      requiresMcpServers?: boolean;
      requiresRemoteSpawn?: boolean;
      toolAccessMode?: "restricted" | "unrestricted";
    },
  ) => {
    const capabilities = provider.getCapabilities();
    if (request.requiresMcpServers && !capabilities.supportsMcpServers) {
      throw new Error(`Runtime provider '${provider.id}' does not support spec mode sessions`);
    }
    if (request.requiresRemoteSpawn && !capabilities.supportsRemoteSpawn) {
      throw new Error(`Runtime provider '${provider.id}' does not support remote execution`);
    }
    if (request.toolAccessMode === "restricted" && !capabilities.supportsToolHooks) {
      throw new Error(
        `Runtime provider '${provider.id}' requires full tool and executable access because Ravi permission hooks are unsupported`,
      );
    }
  },
}));

mock.module("./utils/logger.js", () => {
  const noop = () => loggerChild;
  const loggerChild = { info: noop, warn: noop, error: noop, debug: noop, child: noop };
  return { logger: { child: () => loggerChild, setLevel: noop } };
});

const { RaviBot } = await import("./bot.js");

function createBot() {
  return new RaviBot({
    config: {
      model: "test-model",
      logLevel: "error",
      apiKey: "fake",
    } as any,
  });
}

function makePrompt(text: string) {
  return {
    prompt: text,
    source: { channel: "whatsapp", accountId: "main", chatId: "test" },
  };
}

describe("RaviBot runtime guards", () => {
  beforeEach(() => {
    emittedEvents.length = 0;
    sessions.clear();
    clearProviderSession.mockClear();
    activeProvider = "claude";
    resetRuntimeDoubles();
  });

  it("clears legacy provider session state before switching an agent to Codex", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:legacy-switch";
    sessions.set(sessionKey, {
      sessionKey,
      name: sessionKey,
      agentId: "main",
      agentCwd: "/tmp/ravi-test-bot/main",
      sdkSessionId: "legacy-claude-session",
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clearProviderSession).toHaveBeenCalledWith(sessionKey);
    expect(runtimeStartCalls).toHaveLength(1);
    expect(runtimeStartCalls[0]?.resume).toBeUndefined();
    expect(sessions.get(sessionKey)?.runtimeProvider).toBe("codex");
  });

  it("cleans up the in-memory streaming session when runtime startup throws", async () => {
    const sessionKey = "agent:main:start-failure";
    runtimeStartImpl = () => {
      throw new Error("boom");
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));

    expect((bot as any).streamingSessions.size).toBe(0);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.runtime` &&
          entry.data?.type === "turn.failed" &&
          entry.data?.error === "boom",
      ),
    ).toBe(true);
    expect(
      emittedEvents.some(
        (entry) => entry.topic === `ravi.session.${sessionKey}.response` && entry.data?.response === "Error: boom",
      ),
    ).toBe(true);
  });

  it("queues prompts that arrive while the runtime is still starting without interrupting startup", async () => {
    const sessionKey = "agent:main:startup-queue";
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = () => resolve();
    });
    let combinedPrompt = "";

    runtimePrepareImpl = async () => {
      await prepareGate;
      return undefined;
    };
    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        combinedPrompt = first.value?.message.content ?? "";
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
      interrupt: async () => {},
    });

    const bot = createBot();
    const firstPrompt = (bot as any).handlePromptImmediate(sessionKey, makePrompt("first"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("second"));
    releasePrepare?.();

    await firstPrompt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(combinedPrompt).toBe("first\n\nsecond");
  });

  it("passes discovered plugins into runtime prepareSession for provider-specific bridges", async () => {
    activeProvider = "codex";
    discoveredPlugins = [{ type: "local", path: "/tmp/ravi-test-bot/plugins/ravi-system" }];
    const sessionKey = "agent:main:codex-skills-bridge";
    let preparePlugins: RuntimePlugin[] | undefined;

    runtimePrepareImpl = async (_providerId, input) => {
      preparePlugins = input.plugins;
      return undefined;
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(preparePlugins).toEqual(discoveredPlugins);
  });

  it("accepts the next prompt after a completed Codex turn without interrupting the session", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:codex-follow-up";
    const interrupt = mock(async () => {});
    let secondPromptRequestReached: (() => void) | undefined;
    const waitingForSecondPrompt = new Promise<void>((resolve) => {
      secondPromptRequestReached = resolve;
    });
    let firstPrompt = "";
    let secondPrompt = "";

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        firstPrompt = first.value?.message.content ?? "";
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };

        secondPromptRequestReached?.();
        const second = await request.prompt.next();
        secondPrompt = second.value?.message.content ?? "";
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
      interrupt,
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("first"));
    await waitingForSecondPrompt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const streamingSession = (bot as any).streamingSessions.get(sessionKey);
    expect(streamingSession?.pendingMessages).toHaveLength(0);
    expect(typeof streamingSession?.pushMessage).toBe("function");

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("second"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(firstPrompt).toBe("first");
    expect(secondPrompt).toBe("second");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("restarts an active streaming session when the agent provider changes", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:provider-switch-live-session";
    const interruptedProviders: RuntimeProviderId[] = [];
    const seenPrompts: Array<{ provider: RuntimeProviderId; prompt: string }> = [];
    const lifetimeResolvers = new Map<RuntimeProviderId, () => void>();

    runtimeStartImpl = (providerId, request) => {
      const lifetime = new Promise<void>((resolve) => {
        lifetimeResolvers.set(providerId, resolve);
      });

      return {
        provider: providerId,
        events: (async function* () {
          const first = await request.prompt.next();
          seenPrompts.push({
            provider: providerId,
            prompt: first.value?.message.content ?? "",
          });
          yield {
            type: "turn.complete",
            providerSessionId: `${providerId}-session`,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          await lifetime;
        })(),
        interrupt: async () => {
          interruptedProviders.push(providerId);
          lifetimeResolvers.get(providerId)?.();
        },
      };
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("first via codex"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    activeProvider = "claude";
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("second via claude"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(runtimeStartCalls).toHaveLength(2);
    expect(runtimeStartCalls[0]?.model).toBe("test-model");
    expect(runtimeStartCalls[1]?.model).toBe("test-model");
    expect(interruptedProviders).toContain("codex");
    expect(seenPrompts).toEqual([
      { provider: "codex", prompt: "first via codex" },
      { provider: "claude", prompt: "first via codex\n\nsecond via claude" },
    ]);

    await bot.stop();
  });

  it("does not emit legacy .claude events for Codex sessions", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:codex-no-legacy-feed";

    runtimeStartImpl = (providerId) => ({
      provider: providerId,
      events: (async function* () {
        yield {
          type: "provider.raw",
          rawEvent: { type: "thread.started", thread_id: "thread-codex" },
        };
        yield {
          type: "assistant.message",
          text: "hello from codex",
        };
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
      interrupt: async () => {},
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(emittedEvents.some((entry) => entry.topic === `ravi.session.${sessionKey}.claude`)).toBe(false);
    expect(
      emittedEvents.some(
        (entry) => entry.topic === `ravi.session.${sessionKey}.runtime` && entry.data?.type === "provider.raw",
      ),
    ).toBe(true);
  });
});

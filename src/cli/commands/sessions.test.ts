import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualRouterIndexModule = await import("../../router/index.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");
const actualRouterDbModule = await import("../../router/router-db.js");

type RuntimeEventPayload = Record<string, unknown>;
type ResponseEventPayload = { response?: string; error?: string };

let runtimeEvents: RuntimeEventPayload[] = [];
let claudeEvents: RuntimeEventPayload[] = [];
let responseEvents: ResponseEventPayload[] = [];
const publishedPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const natsEmits: Array<{ topic: string; data: Record<string, unknown> }> = [];
let resolvedSession: Record<string, unknown> | null = null;
let sessionDerivedSource: { channel: string; accountId: string; chatId: string; threadId?: string } | undefined;
let listedContexts: Array<Record<string, unknown>> = [];
let listedAdapters: Array<Record<string, unknown>> = [];
const adapterSnapshots = new Map<string, Record<string, unknown>>();
let routerConfig: { agents: Record<string, Record<string, unknown>> } = { agents: {} };

function makeSubscription<T extends Record<string, unknown>>(events: T[]) {
  return (async function* () {
    for (const data of events) {
      yield { data };
    }
  })();
}

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: (topic: string) => {
    if (topic.endsWith(".runtime")) return makeSubscription(runtimeEvents);
    if (topic.endsWith(".claude")) return makeSubscription(claudeEvents);
    if (topic.endsWith(".response")) return makeSubscription(responseEvents);
    return makeSubscription([]);
  },
  nats: {
    subscribe: (topic: string) => {
      if (topic.endsWith(".runtime")) return makeSubscription(runtimeEvents);
      if (topic.endsWith(".claude")) return makeSubscription(claudeEvents);
      if (topic.endsWith(".response")) return makeSubscription(responseEvents);
      return makeSubscription([]);
    },
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      natsEmits.push({ topic, data });
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishedPrompts.push({ sessionName, payload });
  }),
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  listSessions: () => [],
  getSessionsByAgent: () => [],
  deleteSession: () => {},
  resetSession: () => {},
  resolveSession: () => resolvedSession,
  getOrCreateSession: () => null,
  findSessionByChatId: () => null,
  updateSessionDisplayName: () => {},
  updateSessionModelOverride: () => {},
  updateSessionThinkingLevel: () => {},
  setSessionEphemeral: () => {},
  extendSession: () => {},
  makeSessionPermanent: () => {},
}));

mock.module("../../router/session-key.js", () => ({
  deriveSourceFromSessionKey: () => sessionDerivedSource,
}));

mock.module("../../router/index.js", () => ({
  ...actualRouterIndexModule,
  loadRouterConfig: () => routerConfig,
  expandHome: (path: string) => path,
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbListContexts: (options?: { sessionKey?: string }) =>
    listedContexts.filter((context) => {
      if (!options?.sessionKey) return true;
      return context.sessionKey === options.sessionKey;
    }),
}));

mock.module("../../adapters/index.js", () => ({
  listSessionAdapters: (options?: { sessionKey?: string; status?: string }) =>
    listedAdapters.filter((adapter) => {
      if (options?.sessionKey && adapter.sessionKey !== options.sessionKey) return false;
      if (options?.status && adapter.status !== options.status) return false;
      return true;
    }),
  getSessionAdapterDebugSnapshot: (adapterId: string) => adapterSnapshots.get(adapterId) ?? null,
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

mock.module("../../transcripts.js", () => ({
  locateRuntimeTranscript: () => ({ path: null, reason: "Transcript not found" }),
}));

const { SessionCommands } = await import("./sessions.js");
const { extractNormalizedTranscriptMessages } = await import("./sessions.js");

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

async function captureLogsAsync(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

describe("SessionCommands wait mode", () => {
  beforeEach(() => {
    runtimeEvents = [];
    claudeEvents = [];
    responseEvents = [];
    publishedPrompts.length = 0;
    resolvedSession = null;
    sessionDerivedSource = undefined;
    listedContexts = [];
    listedAdapters = [];
    adapterSnapshots.clear();
    routerConfig = { agents: {} };
    natsEmits.length = 0;
  });

  it("throws the runtime failure when a waited session fails without response output", async () => {
    runtimeEvents = [
      {
        type: "turn.failed",
        error:
          "Runtime provider 'codex' requires full tool and executable access because Ravi permission hooks are unsupported",
      },
    ];

    const commands = new SessionCommands();

    await expect(
      (commands as any).streamToSession("codex-cli-locked", "say hi", {
        sessionKey: "codex-cli-locked",
        name: "codex-cli-locked",
        agentId: "codex-cli-locked",
        agentCwd: "/tmp/codex-cli-locked",
      }),
    ).rejects.toThrow(
      "Runtime provider 'codex' requires full tool and executable access because Ravi permission hooks are unsupported",
    );

    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toBe("codex-cli-locked");
  });

  it("does not print a success footer when send -w fails", async () => {
    const commands = new SessionCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      (commands as any).resolveTarget = () => ({
        sessionKey: "codex-cli-locked",
        name: "codex-cli-locked",
        agentId: "codex-cli-locked",
        agentCwd: "/tmp/codex-cli-locked",
      });
      (commands as any).streamToSession = async () => {
        throw new Error("blocked by runtime");
      };

      await expect(commands.send("codex-cli-locked", "say hi", false, true)).rejects.toThrow("blocked by runtime");
      expect(logCalls.some((line) => line.includes("✅ Done"))).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  it("throws on timeout instead of treating the wait as success", async () => {
    const commands = new SessionCommands();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

    try {
      await expect(
        (commands as any).streamToSession("slow-session", "say hi", {
          sessionKey: "slow-session",
          name: "slow-session",
          agentId: "agent-slow",
          agentCwd: "/tmp/slow-session",
        }),
      ).rejects.toThrow("Timed out waiting for response from slow-session after 120s");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

describe("SessionCommands set-model", () => {
  beforeEach(() => {
    resolvedSession = null;
    routerConfig = { agents: {} };
    natsEmits.length = 0;
  });

  it("notifies the live daemon with the effective model", async () => {
    resolvedSession = {
      sessionKey: "agent:main:model-switch",
      name: "model-switch",
      agentId: "main",
    };
    routerConfig = {
      agents: {
        main: {
          model: "model-default",
        },
      },
    };

    const output = await captureLogsAsync(async () => {
      await new SessionCommands().setModel("model-switch", "model-live");
    });

    expect(output).toContain('Set model to "model-live" for: model-switch');
    expect(output).toContain("Live daemon notified");
    expect(natsEmits).toHaveLength(1);
    expect(natsEmits[0]?.topic).toBe("ravi.session.model.changed");
    expect(natsEmits[0]?.data.sessionKey).toBe("agent:main:model-switch");
    expect(natsEmits[0]?.data.sessionName).toBe("model-switch");
    expect(natsEmits[0]?.data.modelOverride).toBe("model-live");
    expect(natsEmits[0]?.data.effectiveModel).toBe("model-live");
    expect(typeof natsEmits[0]?.data.changedAt).toBe("number");
  });

  it("clears to the agent default model in the live daemon event", async () => {
    resolvedSession = {
      sessionKey: "agent:main:model-clear",
      name: "model-clear",
      agentId: "main",
    };
    routerConfig = {
      agents: {
        main: {
          model: "model-default",
        },
      },
    };

    await captureLogsAsync(async () => {
      await new SessionCommands().setModel("model-clear", "clear");
    });

    expect(natsEmits).toHaveLength(1);
    expect(natsEmits[0]?.data.modelOverride).toBeNull();
    expect(natsEmits[0]?.data.effectiveModel).toBe("model-default");
  });
});

describe("SessionCommands info", () => {
  beforeEach(() => {
    resolvedSession = null;
    sessionDerivedSource = undefined;
    listedContexts = [];
    listedAdapters = [];
    adapterSnapshots.clear();
    routerConfig = { agents: {} };
    natsEmits.length = 0;
  });

  it("prints a unified inspect view with runtime identity, contexts, adapters, and next commands", () => {
    resolvedSession = {
      sessionKey: "agent:main:whatsapp:main:group:123456",
      name: "support-group",
      displayName: "Support",
      agentId: "main",
      modelOverride: "gpt-5.4-mini",
      thinkingLevel: "verbose",
      runtimeProvider: "codex",
      providerSessionId: "resp_123",
      runtimeSessionParams: { sessionId: "resp_123", cwd: "/tmp/main" },
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      contextTokens: 2200,
      lastChannel: "whatsapp",
      lastTo: "group:123456",
      lastAccountId: "main",
      queueMode: "queue",
      queueDebounceMs: 500,
      queueCap: 10,
      compactionCount: 2,
      createdAt: Date.UTC(2026, 3, 11, 12, 0, 0),
      updatedAt: Date.UTC(2026, 3, 11, 12, 30, 0),
      agentCwd: "/tmp/main",
    };
    routerConfig = {
      agents: {
        main: {
          provider: "codex",
          model: "gpt-5",
        },
      },
    };
    sessionDerivedSource = {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:123456",
      threadId: "thread-1",
    };
    listedContexts = [
      {
        contextId: "ctx_runtime",
        kind: "runtime",
        sessionKey: "agent:main:whatsapp:main:group:123456",
        sessionName: "support-group",
        agentId: "main",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "group:123456",
        },
        capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
        metadata: { runtimeProvider: "codex" },
        createdAt: Date.UTC(2026, 3, 11, 12, 0, 0),
        lastUsedAt: Date.UTC(2026, 3, 11, 12, 25, 0),
      },
      {
        contextId: "ctx_child",
        kind: "cli-runtime",
        sessionKey: "agent:main:whatsapp:main:group:123456",
        sessionName: "support-group",
        agentId: "main",
        capabilities: [
          { permission: "execute", objectType: "group", objectId: "context" },
          { permission: "access", objectType: "tool", objectId: "slack" },
        ],
        metadata: {
          parentContextId: "ctx_runtime",
          issuedFor: "adapter-cli",
          issuanceMode: "inherit",
        },
        createdAt: Date.UTC(2026, 3, 11, 12, 5, 0),
      },
    ];
    listedAdapters = [
      {
        adapterId: "adapter-1",
        name: "slack-bridge",
        transport: "stdio-json",
        sessionKey: "agent:main:whatsapp:main:group:123456",
        sessionName: "support-group",
        agentId: "main",
        status: "running",
        definition: {
          bindings: {
            context: {
              cliName: "adapter-cli",
            },
          },
        },
      },
    ];
    adapterSnapshots.set("adapter-1", {
      bind: {
        contextId: "ctx_child",
        cliName: "adapter-cli",
      },
      health: {
        state: "running",
        pendingCommands: 0,
        lastError: null,
      },
    });

    const output = captureLogs(() => {
      new SessionCommands().info("support-group");
    });

    expect(output).toContain(
      "Key:          agent:main:whatsapp:main:group:123456  [source=session-db freshness=persisted]",
    );
    expect(output).toContain("Configured:   codex  [source=config-db freshness=persisted via=router-config]");
    expect(output).toContain("Model:        gpt-5  [source=config-db freshness=persisted via=router-config]");
    expect(output).toContain("Override:     gpt-5.4-mini  [source=session-db freshness=persisted]");
    expect(output).toContain("Runtime:      codex  [source=runtime-snapshot freshness=persisted]");
    expect(output).toContain(
      'Runtime ctx:  {"sessionId":"resp_123","cwd":"/tmp/main"}  [source=runtime-snapshot freshness=persisted]',
    );
    expect(output).toContain("Derived route:[source=resolver freshness=derived-now via=session-key]");
    expect(output).toContain("thread=thread-1");
    expect(output).toContain("Related contexts (2): [source=context-db freshness=persisted]");
    expect(output).toContain("ctx_runtime runtime caps=1 source=whatsapp/main/group:123456 provider=codex");
    expect(output).toContain("ctx_child cli-runtime caps=2 parent=ctx_runtime issuedFor=adapter-cli mode=inherit");
    expect(output).toContain("Adapters (1): [source=adapter-db freshness=persisted]");
    expect(output).toContain(
      "slack-bridge live transport=stdio-json status=running health=running ctx=ctx_child cli=adapter-cli pending=0",
    );
    expect(output).toContain("Next debug commands: [source=derived freshness=derived-now via=session-inspect]");
    expect(output).toContain("ravi context list --session agent:main:whatsapp:main:group:123456");
    expect(output).toContain("ravi adapters show adapter-1");
  });
});

describe("extractNormalizedTranscriptMessages", () => {
  it("reads codex event_msg transcripts as user/assistant history", () => {
    const raw = [
      JSON.stringify({
        timestamp: "2026-03-22T14:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "[WhatsApp] Luís: oi" },
      }),
      JSON.stringify({
        timestamp: "2026-03-22T14:00:05.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Vou olhar isso agora.", phase: "commentary" },
      }),
      JSON.stringify({
        timestamp: "2026-03-22T14:00:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Feito.", phase: "final_answer" },
      }),
    ].join("\n");

    const messages = extractNormalizedTranscriptMessages(raw, "codex");

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "[WhatsApp] Luís: oi"],
      ["assistant", "Vou olhar isso agora."],
      ["assistant", "Feito."],
    ]);
  });
});

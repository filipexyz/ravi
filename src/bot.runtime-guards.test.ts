import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

afterAll(() => mock.restore());

setDefaultTimeout(20_000);

const actualDbModule = await import("./db.js");
const actualRouterIndexModule = await import("./router/index.js");
const actualCliContextModule = await import("./cli/context.js");
const actualRemoteSpawnNatsModule = await import("./remote-spawn-nats.js");
const actualPermissionsEngineModule = await import("./permissions/engine.js");
const actualRuntimeIndexModule = await import("./runtime/index.js");
const actualTaskDbModule = await import("./tasks/task-db.js");
const actualTaskServiceModule = await import("./tasks/service.js");
const actualLoggerModule = await import("./utils/logger.js");

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
const createdTaskIds: string[] = [];
let stateDir: string | null = null;
let saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
let agentCanImpl = (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) =>
  actualPermissionsEngineModule.agentCan(...args);
let canWithCapabilitiesImpl = (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
  actualPermissionsEngineModule.canWithCapabilities(...args);

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

function createDispatchedTaskForSession(
  sessionName: string,
  options: {
    profileId?: string;
    parentTaskId?: string;
    taskDir?: string;
  } = {},
) {
  const created = actualTaskDbModule.dbCreateTask({
    title: `Task for ${sessionName}`,
    instructions: "Exercise task barrier behavior through the real task DB",
    createdBy: "test",
    agentId: "main",
    profileId: options.profileId,
    parentTaskId: options.parentTaskId,
  } as any);
  createdTaskIds.push(created.task.id);
  if (options.taskDir) {
    actualTaskDbModule.dbSetTaskDir(created.task.id, options.taskDir);
  }
  return actualTaskDbModule.dbDispatchTask(created.task.id, {
    agentId: "main",
    sessionName,
    assignedBy: "test",
  });
}

function completeTaskForSession(taskId: string, sessionName: string): void {
  actualTaskDbModule.dbCompleteTask(taskId, {
    actor: "test",
    agentId: "main",
    sessionName,
    message: "done",
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
  ...actualDbModule,
  saveMessage: mock((...args: Parameters<typeof actualDbModule.saveMessage>) => saveMessageImpl(...args)),
  backfillProviderSessionId: mock(() => {}),
  close: mock(() => {}),
}));

mock.module("./prompt-builder.js", () => ({
  buildSystemPrompt: () => "",
  SILENT_TOKEN: "@@SILENT@@",
}));

mock.module("./router/index.js", () => ({
  ...actualRouterIndexModule,
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
  updateRuntimeProviderState: mock(
    (
      sessionKey: string,
      provider: RuntimeProviderId,
      options?: { providerSessionId?: string; runtimeSessionDisplayId?: string },
    ) => {
      const session = sessions.get(sessionKey);
      if (!session) return;
      session.runtimeProvider = provider;
      const providerSessionId = options?.runtimeSessionDisplayId ?? options?.providerSessionId;
      if (providerSessionId) {
        session.providerSessionId = providerSessionId;
        session.sdkSessionId = providerSessionId;
      }
    },
  ),
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
  ...actualCliContextModule,
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
  ...actualRemoteSpawnNatsModule,
  createNatsRemoteSpawn: () => {
    throw new Error("NATS remote spawn should not be used in bot runtime guard tests");
  },
}));

mock.module("./permissions/engine.js", () => ({
  ...actualPermissionsEngineModule,
  agentCan: (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) => agentCanImpl(...args),
  canWithCapabilities: (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
    canWithCapabilitiesImpl(...args),
}));

mock.module("./runtime/index.js", () => ({
  ...actualRuntimeIndexModule,
  createRuntimeContext: (input: {
    kind?: string;
    agentId?: string;
    sessionKey?: string;
    sessionName?: string;
    source?: { channel: string; accountId: string; chatId: string; threadId?: string };
    capabilities?: Array<{ permission: string; objectType: string; objectId: string; source?: string }>;
    metadata?: Record<string, unknown>;
  }) => ({
    contextId: "ctx_test_runtime",
    contextKey: "rctx_test_runtime",
    kind: input.kind ?? "runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    source: input.source,
    capabilities: input.capabilities ?? [],
    metadata: input.metadata,
    createdAt: Date.now(),
  }),
  snapshotAgentCapabilities: () => [],
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

mock.module("./tasks/service.js", () => ({
  ...actualTaskServiceModule,
  recoverActiveTasksAfterRestart: mock(async () => ({
    recoveredTaskIds: [],
    skipped: [],
  })),
}));

mock.module("./utils/logger.js", () => {
  const noop = () => loggerChild;
  const loggerChild = { info: noop, warn: noop, error: noop, debug: noop, child: noop };
  return {
    ...actualLoggerModule,
    logger: { ...actualLoggerModule.logger, child: () => loggerChild, setLevel: noop },
  };
});

const { RaviBot } = await import("./bot.js");

afterEach(async () => {
  saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
  agentCanImpl = (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) =>
    actualPermissionsEngineModule.agentCan(...args);
  canWithCapabilitiesImpl = (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
    actualPermissionsEngineModule.canWithCapabilities(...args);
  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop();
    if (taskId) {
      actualTaskDbModule.dbDeleteTask(taskId);
    }
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

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
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-bot-runtime-guards-test-");
    emittedEvents.length = 0;
    sessions.clear();
    clearProviderSession.mockClear();
    delete process.env.RAVI_BIN;
    activeProvider = "claude";
    resetRuntimeDoubles();
    saveMessageImpl = () => {};
    agentCanImpl = () => true;
    canWithCapabilitiesImpl = (
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>,
      permission: string,
      objectType: string,
      objectId: string,
    ) =>
      capabilities.some(
        (cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === objectId,
      );
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

  it("marks task bootstrap as accepted and persists runtime provider state before the first turn completes", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:task-bootstrap";
    const dispatched = createDispatchedTaskForSession(sessionKey, { profileId: "task-doc-none" });
    const originalRaviBin = process.env.RAVI_BIN;
    process.env.RAVI_BIN = "/tmp/ravi-repo/bin/ravi";

    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    runtimeStartImpl = (providerId) => ({
      provider: providerId,
      events: (async function* () {
        await turnGate;
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
      interrupt: async () => {},
    });

    try {
      const bot = createBot();
      await (bot as any).handlePromptImmediate(sessionKey, {
        ...makePrompt("bootstrap"),
        taskBarrierTaskId: dispatched.task.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const session = sessions.get(sessionKey);
      const task = actualTaskDbModule.dbGetTask(dispatched.task.id);
      const assignment = actualTaskDbModule.dbGetActiveAssignment(dispatched.task.id);
      expect(session?.runtimeProvider).toBe("codex");
      expect(session?.providerSessionId).toBeUndefined();
      expect(task?.status).toBe("in_progress");
      expect(assignment?.status).toBe("accepted");
      expect(assignment?.checkpointDueAt).toBeGreaterThan(assignment?.assignedAt ?? 0);
      expect(runtimeStartCalls[0]?.env?.RAVI_BIN).toBe("/tmp/ravi-repo/bin/ravi");
      expect(runtimeStartCalls[0]?.env?.PATH?.startsWith("/tmp/ravi-repo/bin")).toBe(true);
    } finally {
      releaseTurn?.();
      if (originalRaviBin === undefined) {
        delete process.env.RAVI_BIN;
      } else {
        process.env.RAVI_BIN = originalRaviBin;
      }
    }
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

  it("uses the session cwd instead of the agent default when a task/session overrides the workspace", async () => {
    const sessionKey = "agent:main:task-worktree";
    sessions.set(sessionKey, {
      sessionKey,
      name: sessionKey,
      agentId: "main",
      agentCwd: "/tmp/ravi-test-bot/worktrees/task-worktree",
    });

    let preparedCwd = "";
    runtimePrepareImpl = async (_providerId, input) => {
      preparedCwd = input.cwd;
      return undefined;
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello from worktree"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(preparedCwd).toBe("/tmp/ravi-test-bot/worktrees/task-worktree");
    expect(runtimeStartCalls).toHaveLength(1);
    expect(runtimeStartCalls[0]?.cwd).toBe("/tmp/ravi-test-bot/worktrees/task-worktree");
  });

  it("injects task identity env from the explicit task barrier binding", async () => {
    const sessionKey = "agent:main:task-env";
    const dispatched = createDispatchedTaskForSession(sessionKey, {
      profileId: "default",
      parentTaskId: "task-parent",
      taskDir: "/tmp/ravi-test-bot/tasks/task-explicit",
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("execute task turn"),
      taskBarrierTaskId: dispatched.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(1);
    expect(runtimeStartCalls[0]?.env).toMatchObject({
      RAVI_TASK_ID: dispatched.task.id,
      RAVI_TASK_PROFILE_ID: "default",
      RAVI_PARENT_TASK_ID: "task-parent",
      RAVI_TASK_SESSION: sessionKey,
      RAVI_TASK_WORKSPACE: "/tmp/ravi-test-bot/tasks/task-explicit",
    });
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

  it("interrupts an active text turn for p0/immediate_interrupt prompts", async () => {
    const sessionKey = "agent:main:p0-interrupt";
    const interrupt = mock(async () => {});

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        expect(first.value?.message.content).toBe("first");
        await new Promise(() => {});
      })(),
      interrupt,
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("first"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("urgent"),
      deliveryBarrier: "immediate_interrupt",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("queues p2/after_response prompts until the current turn completes", async () => {
    const sessionKey = "agent:main:p2-after-response";
    const interrupt = mock(async () => {});
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnDone = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let secondPrompt = "";

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        expect(first.value?.message.content).toBe("first");
        await firstTurnDone;
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("follow after response"),
      deliveryBarrier: "after_response",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).not.toHaveBeenCalled();
    expect(secondPrompt).toBe("");

    releaseFirstTurn?.();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(secondPrompt).toBe("follow after response");
  });

  it("keeps p3/after_task prompts parked until the task becomes inactive", async () => {
    const sessionKey = "agent:main:p3-after-task";
    let woken = false;
    const dispatched = createDispatchedTaskForSession(sessionKey);

    const bot = createBot();
    (bot as any).streamingSessions.set(sessionKey, {
      queryHandle: { provider: "claude", interrupt: async () => {} },
      abortController: new AbortController(),
      pushMessage: () => {
        woken = true;
      },
      pendingWake: false,
      pendingMessages: [],
      currentSource: { channel: "whatsapp", accountId: "main", chatId: "test" },
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      starting: false,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });

    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("wait for task"),
      deliveryBarrier: "after_task",
    });

    expect(woken).toBe(false);

    completeTaskForSession(dispatched.task.id, sessionKey);
    (bot as any).wakeStreamingSessionIfDeliverable(sessionKey);

    expect(woken).toBe(true);
  });

  it("defers cold-start p3/after_task prompts until the task is released", async () => {
    const sessionKey = "agent:main:p3-cold-start";
    const dispatched = createDispatchedTaskForSession(sessionKey);

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("cold start after task"),
      deliveryBarrier: "after_task",
    });

    expect(runtimeStartCalls).toHaveLength(0);
    expect((bot as any).deferredAfterTaskStarts.get(sessionKey)).toHaveLength(1);

    completeTaskForSession(dispatched.task.id, sessionKey);
    await (bot as any).startDeferredAfterTaskSessionIfDeliverable(sessionKey);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(1);
    expect((bot as any).deferredAfterTaskStarts.has(sessionKey)).toBe(false);
  });

  it("lets a task dispatch use after_task while ignoring its own task id", async () => {
    const sessionKey = "agent:main:p3-self-task";
    const dispatched = createDispatchedTaskForSession(sessionKey);

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("task dispatch prompt"),
      deliveryBarrier: "after_task",
      taskBarrierTaskId: dispatched.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(1);
    expect((bot as any).deferredAfterTaskStarts.has(sessionKey)).toBe(false);
  });

  it("releases a deferred task dispatch once only the dispatched task itself remains active", async () => {
    const sessionKey = "agent:main:p3-deferred-self-task";
    const blocker = createDispatchedTaskForSession(sessionKey);
    const self = createDispatchedTaskForSession(sessionKey);

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("task dispatch prompt waiting on previous task"),
      deliveryBarrier: "after_task",
      taskBarrierTaskId: self.task.id,
    });

    expect(runtimeStartCalls).toHaveLength(0);
    expect((bot as any).deferredAfterTaskStarts.get(sessionKey)).toHaveLength(1);

    completeTaskForSession(blocker.task.id, sessionKey);
    await (bot as any).startDeferredAfterTaskSessionIfDeliverable(sessionKey);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(1);
    expect((bot as any).deferredAfterTaskStarts.has(sessionKey)).toBe(false);
  });
});

describe("RaviBot streaming session lifecycle", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-bot-runtime-guards-test-");
    emittedEvents.length = 0;
    sessions.clear();
    clearProviderSession.mockClear();
    activeProvider = "claude";
    resetRuntimeDoubles();
    saveMessageImpl = () => {};
    agentCanImpl = () => true;
    canWithCapabilitiesImpl = (
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>,
      permission: string,
      objectType: string,
      objectId: string,
    ) =>
      capabilities.some(
        (cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === objectId,
      );
  });

  it("creates a new streaming session for first message", async () => {
    const sessionKey = "agent:main:test-new";
    const bot = createBot();

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));

    const streamingSessions = (bot as any).streamingSessions;
    expect(streamingSessions.has(sessionKey)).toBe(true);
  });

  it("pushes a follow-up into an existing streaming session instead of starting a new one", async () => {
    const sessionKey = "agent:main:test-push";
    const bot = createBot();
    let wokenUp = false;

    (bot as any).streamingSessions.set(sessionKey, {
      queryHandle: { provider: "claude", interrupt: async () => {} },
      abortController: new AbortController(),
      pushMessage: (_msg: unknown) => {
        wokenUp = true;
      },
      pendingWake: false,
      pendingMessages: [],
      currentSource: { channel: "whatsapp", accountId: "main", chatId: "test" },
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("follow-up"));

    const streamingSession = (bot as any).streamingSessions.get(sessionKey);
    expect(streamingSession.pendingMessages).toHaveLength(1);
    expect(streamingSession.pendingMessages[0]?.message.content).toBe("follow-up");
    expect(wokenUp).toBe(true);
    expect(streamingSession.pushMessage).toBeNull();
  });

  it("starts a fresh streaming session when the previous one is already done", async () => {
    const sessionKey = "agent:main:test-done";
    const bot = createBot();

    const doneSession = {
      queryHandle: { provider: "claude", interrupt: async () => {} },
      abortController: new AbortController(),
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      currentSource: undefined,
      toolRunning: false,
      lastActivity: Date.now(),
      done: true,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    };
    (bot as any).streamingSessions.set(sessionKey, doneSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("new conversation"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((bot as any).streamingSessions.get(sessionKey)).not.toBe(doneSession);
  });

  it("updates the response source when pushing into an existing session", async () => {
    const sessionKey = "agent:main:test-source";
    const bot = createBot();

    const streamingSession = {
      queryHandle: { provider: "claude", interrupt: async () => {} },
      abortController: new AbortController(),
      pushMessage: (_msg: unknown) => {},
      pendingWake: false,
      pendingMessages: [],
      currentSource: { channel: "whatsapp", accountId: "main", chatId: "old" },
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    };
    (bot as any).streamingSessions.set(sessionKey, streamingSession);

    const prompt = makePrompt("update source");
    prompt.source = { channel: "whatsapp", accountId: "main", chatId: "new-chat" };

    await (bot as any).handlePromptImmediate(sessionKey, prompt);

    expect(streamingSession.currentSource?.chatId).toBe("new-chat");
  });

  it("aborts and clears all streaming sessions on stop", async () => {
    const bot = createBot();
    const abortController = new AbortController();
    let interrupted = false;
    let generatorWoken = false;
    let turnSignalWoken = false;

    (bot as any).streamingSessions.set("agent:main:test", {
      queryHandle: {
        provider: "claude",
        interrupt: async () => {
          interrupted = true;
        },
      },
      abortController,
      pushMessage: () => {
        generatorWoken = true;
      },
      pendingWake: false,
      pendingMessages: [],
      currentSource: undefined,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: () => {
        turnSignalWoken = true;
      },
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });
    (bot as any).running = true;

    await bot.stop();

    expect(abortController.signal.aborted).toBe(true);
    expect(interrupted).toBe(true);
    expect(generatorWoken).toBe(true);
    expect(turnSignalWoken).toBe(true);
    expect((bot as any).streamingSessions.size).toBe(0);
  });
});

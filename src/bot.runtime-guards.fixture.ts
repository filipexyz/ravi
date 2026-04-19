import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

afterAll(() => mock.restore());

setDefaultTimeout(20_000);

const actualDbModule = await import("./db.js");
const actualRouterIndexModule = await import("./router/index.js");
const actualCliContextModule = await import("./cli/context.js");
const actualRemoteSpawnNatsModule = await import("./remote-spawn-nats.js");
const actualPermissionsEngineModule = await import("./permissions/engine.js");
const actualRuntimeProviderRegistryModule = await import("./runtime/provider-registry.js");
const actualTaskDbModule = await import("./tasks/task-db.js");
const actualAgentCan = actualPermissionsEngineModule.agentCan;
const actualCanWithCapabilities = actualPermissionsEngineModule.canWithCapabilities;

type RuntimeProviderId = "claude" | "codex";

type RuntimeStartRequest = {
  prompt: AsyncGenerator<{
    type: "user";
    message: { role: "user"; content: string };
    session_id: string;
    parent_tool_use_id: string | null;
  }>;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: "off" | "normal" | "verbose";
  cwd: string;
  resume?: string;
  forkSession?: boolean;
  abortController: AbortController;
  systemPromptAppend: string;
  env?: Record<string, string>;
  hooks?: Record<string, unknown>;
  approveRuntimeRequest?: (request: any) => Promise<any>;
  dynamicTools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  handleRuntimeToolCall?: (request: any) => Promise<any>;
};

type RuntimeHostServices = {
  authorizeCapability(request: {
    permission: string;
    objectType: string;
    objectId: string;
    eventData?: Record<string, unknown>;
  }): Promise<{ allowed: boolean; inherited: boolean; reason?: string }>;
  authorizeCommandExecution(request: {
    command: string;
    input?: Record<string, unknown>;
    eventData?: Record<string, unknown>;
  }): Promise<any>;
  authorizeToolUse(request: {
    toolName: string;
    input?: Record<string, unknown>;
    eventData?: Record<string, unknown>;
  }): Promise<any>;
  requestUserInput(request: { questions: any[]; eventData?: Record<string, unknown> }): Promise<any>;
  listDynamicTools(): RuntimeStartRequest["dynamicTools"];
  executeDynamicTool(request: any, options?: { eventData?: Record<string, unknown> }): Promise<any>;
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
  runtimeSessionParams?: Record<string, unknown>;
  runtimeSessionDisplayId?: string;
  providerSessionId?: string;
  sdkSessionId?: string;
  modelOverride?: string;
  thinkingLevel?: "off" | "normal" | "verbose";
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

type RuntimeHandle = {
  provider: RuntimeProviderId;
  events: AsyncIterable<Record<string, unknown>>;
  interrupt(): Promise<void>;
  setModel?(model: string): Promise<void>;
  control?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const emittedEvents: Array<{ topic: string; data: any }> = [];
const sessions = new Map<string, SessionState>();
let activeProvider: RuntimeProviderId = "claude";
let runtimeStartCalls: RuntimeStartRequest[] = [];
let runtimePrepareImpl: (
  providerId: RuntimeProviderId,
  input: { agentId: string; cwd: string; plugins?: RuntimePlugin[]; hostServices?: RuntimeHostServices },
) => Promise<{ env?: Record<string, string>; startRequest?: Partial<RuntimeStartRequest> } | undefined>;
let runtimeStartImpl: (providerId: RuntimeProviderId, request: RuntimeStartRequest) => RuntimeHandle;
let discoveredPlugins: RuntimePlugin[] = [];
const createdTaskIds: string[] = [];
let stateDir: string | null = null;
let saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
let agentCanImpl = (...args: Parameters<typeof actualAgentCan>) => actualAgentCan(...args);
let canWithCapabilitiesImpl = (...args: Parameters<typeof actualCanWithCapabilities>) =>
  actualCanWithCapabilities(...args);
let snapshotAgentCapabilitiesImpl = () =>
  [] as Array<{ permission: string; objectType: string; objectId: string; source?: string }>;
type TestCostResult = { inputCost: number; outputCost: number; cacheCost: number; totalCost: number } | null;
let calculateCostImpl: (
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number },
) => TestCostResult = () => null;
const dbInsertCostEventMock = mock((_event: Record<string, unknown>) => {});

const clearProviderSession = mock((sessionKey: string) => {
  const session = sessions.get(sessionKey);
  if (!session) return;
  session.runtimeProvider = undefined;
  session.runtimeSessionParams = undefined;
  session.runtimeSessionDisplayId = undefined;
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

function createMockCodexStartRequest(hostServices: RuntimeHostServices): Partial<RuntimeStartRequest> {
  return {
    approveRuntimeRequest: async (request: any) => {
      const eventData = {
        runtimeApproval: {
          provider: "codex",
          kind: request.kind,
          method: request.method,
          toolName: request.toolName,
          input: request.input,
        },
        runtimeMetadata: request.metadata,
      };

      if (request.kind === "command_execution") {
        return hostServices.authorizeCommandExecution({
          command: request.input?.command ?? "",
          input: request.input,
          eventData,
        });
      }
      if (request.kind === "file_change") {
        return hostServices.authorizeToolUse({
          toolName: request.toolName ?? "Edit",
          input: request.input,
          eventData,
        });
      }
      if (request.kind === "user_input") {
        return hostServices.requestUserInput({
          questions: Array.isArray(request.input?.questions) ? request.input.questions : [],
          eventData,
        });
      }

      const permission = request.input?.permissions;
      const capabilities =
        permission && typeof permission === "object"
          ? Object.keys(permission).map((entry) => {
              const [action = "", objectType = "", objectId = ""] = entry.split(":");
              return { permission: action, objectType, objectId };
            })
          : [];
      let inherited = true;
      for (const capability of capabilities) {
        const result = await hostServices.authorizeCapability({
          ...capability,
          eventData,
        });
        if (!result.allowed) {
          return {
            approved: false,
            reason: result.reason,
            permissions: {},
          };
        }
        inherited = inherited && result.inherited;
      }
      return {
        approved: true,
        inherited,
        permissions: permission ?? {},
      };
    },
    dynamicTools: hostServices.listDynamicTools(),
    handleRuntimeToolCall: (request: any) =>
      hostServices.executeDynamicTool(request, {
        eventData: {
          runtimeToolCall: {
            provider: "codex",
            method: "item/tool/call",
            toolName: request.toolName,
            callId: request.callId,
            arguments: request.arguments,
          },
          runtimeMetadata: request.metadata,
        },
      }),
  };
}

function createDispatchedTaskForSession(
  sessionName: string,
  options: {
    profileId?: string;
    parentTaskId?: string;
    taskDir?: string;
    taskRuntimeOverride?: {
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      thinking?: "off" | "normal" | "verbose";
    };
    dispatchRuntimeOverride?: {
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      thinking?: "off" | "normal" | "verbose";
    };
  } = {},
) {
  const created = actualTaskDbModule.dbCreateTask({
    title: `Task for ${sessionName}`,
    instructions: "Exercise task barrier behavior through the real task DB",
    createdBy: "test",
    agentId: "main",
    profileId: options.profileId,
    parentTaskId: options.parentTaskId,
    runtimeOverride: options.taskRuntimeOverride,
  } as any);
  createdTaskIds.push(created.task.id);
  if (options.taskDir) {
    actualTaskDbModule.dbSetTaskDir(created.task.id, options.taskDir);
  }
  return actualTaskDbModule.dbDispatchTask(created.task.id, {
    agentId: "main",
    sessionName,
    assignedBy: "test",
    runtimeOverride: options.dispatchRuntimeOverride,
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
    const agentChanged = existing.agentId !== agentId || existing.agentCwd !== agentCwd;
    existing.agentId = agentId;
    existing.agentCwd = agentCwd;
    existing.name = defaults?.name ?? existing.name ?? sessionKey;
    if (agentChanged) {
      existing.runtimeProvider = undefined;
      existing.runtimeSessionParams = undefined;
      existing.runtimeSessionDisplayId = undefined;
      existing.providerSessionId = undefined;
      existing.sdkSessionId = undefined;
    }
    return existing;
  }

  const created: SessionState = {
    sessionKey,
    name: defaults?.name ?? sessionKey,
    agentId,
    agentCwd,
    runtimeProvider: defaults?.runtimeProvider,
    runtimeSessionParams: defaults?.runtimeSessionParams,
    runtimeSessionDisplayId: defaults?.runtimeSessionDisplayId ?? defaults?.providerSessionId ?? defaults?.sdkSessionId,
    providerSessionId: defaults?.providerSessionId,
    sdkSessionId: defaults?.sdkSessionId,
    modelOverride: defaults?.modelOverride,
    thinkingLevel: defaults?.thinkingLevel,
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
  updateProviderSession: mock(
    (
      sessionKey: string,
      provider: RuntimeProviderId,
      providerSessionId: string,
      options?: { runtimeSessionParams?: Record<string, unknown>; runtimeSessionDisplayId?: string },
    ) => {
      const session = sessions.get(sessionKey);
      if (!session) return;
      const displayId = options?.runtimeSessionDisplayId ?? providerSessionId;
      session.runtimeProvider = provider;
      session.runtimeSessionParams = options?.runtimeSessionParams;
      session.runtimeSessionDisplayId = displayId;
      session.providerSessionId = displayId;
      session.sdkSessionId = providerSessionId;
    },
  ),
  updateRuntimeProviderState: mock(
    (
      sessionKey: string,
      provider: RuntimeProviderId,
      options?: {
        providerSessionId?: string;
        runtimeSessionParams?: Record<string, unknown>;
        runtimeSessionDisplayId?: string;
      },
    ) => {
      const session = sessions.get(sessionKey);
      if (!session) return;
      session.runtimeProvider = provider;
      session.runtimeSessionParams = options?.runtimeSessionParams;
      const providerSessionId = options?.providerSessionId;
      const displayId = options?.runtimeSessionDisplayId ?? providerSessionId;
      session.runtimeSessionDisplayId = displayId;
      session.providerSessionId = displayId;
      session.sdkSessionId = providerSessionId;
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
  dbInsertCostEvent: dbInsertCostEventMock,
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
        secondary: {
          id: "secondary",
          cwd: "/tmp/ravi-test-bot/secondary",
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

mock.module("./cli/tool-definitions.js", () => ({
  getAllCommandClasses: () => [],
  createSdkTools: () => [
    {
      name: "tools_list",
      description: "List available tools",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

mock.module("./cli/tools-export.js", () => ({
  extractTools: () => [
    {
      name: "tools_list",
      description: "List available tools",
      handler: async () => ({
        content: [{ type: "text" as const, text: "fake tools list" }],
        isError: false,
      }),
      metadata: {
        group: "tools",
        command: "list",
        method: "list",
        args: [],
        options: [],
        scope: "open",
      },
    },
  ],
}));

mock.module("./heartbeat/index.js", () => ({
  HEARTBEAT_OK: "HEARTBEAT_OK",
}));

mock.module("./bash/index.js", () => ({
  checkDangerousPatterns: () => ({ safe: true }),
  createBashPermissionHook: () => ({
    matcher: "Bash",
    hooks: [async () => ({})],
  }),
  createToolPermissionHook: () => ({
    hooks: [async () => ({})],
  }),
  emitBashDeniedAudit: mock(() => {}),
  evaluateBashPermission: () => ({ allowed: true }),
  parseBashCommand: () => ({ success: true, executables: [] }),
  UNCONDITIONAL_BLOCKS: new Set(["bash", "sh", "zsh"]),
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
  calculateCost: (model: string, usage: Parameters<typeof calculateCostImpl>[1]) => calculateCostImpl(model, usage),
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
  agentCan: (...args: Parameters<typeof actualAgentCan>) => agentCanImpl(...args),
  canWithCapabilities: (...args: Parameters<typeof actualCanWithCapabilities>) => canWithCapabilitiesImpl(...args),
}));

mock.module("./runtime/runtime-context-store.js", () => ({
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
  snapshotAgentCapabilities: () => snapshotAgentCapabilitiesImpl(),
}));

mock.module("./runtime/provider-registry.js", () => ({
  ...actualRuntimeProviderRegistryModule,
  createRuntimeProvider: (providerId: RuntimeProviderId = "claude") => {
    const capabilities =
      providerId === "codex"
        ? {
            supportsSessionResume: true,
            supportsSessionFork: false,
            supportsPartialText: false,
            supportsToolHooks: true,
            supportsHostSessionHooks: false,
            supportsPlugins: false,
            supportsMcpServers: false,
            supportsRemoteSpawn: false,
          }
        : {
            supportsSessionResume: true,
            supportsSessionFork: true,
            supportsPartialText: true,
            supportsToolHooks: true,
            supportsHostSessionHooks: true,
            supportsPlugins: true,
            supportsMcpServers: true,
            supportsRemoteSpawn: true,
          };

    return {
      id: providerId,
      getCapabilities: () => capabilities,
      prepareSession: async (input: {
        agentId: string;
        cwd: string;
        plugins?: RuntimePlugin[];
        hostServices?: RuntimeHostServices;
      }) => {
        const prepared = await runtimePrepareImpl(providerId, input);
        if (providerId !== "codex" || !input.hostServices || prepared?.startRequest) {
          return prepared;
        }
        return {
          ...(prepared ?? {}),
          startRequest: createMockCodexStartRequest(input.hostServices),
        };
      },
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

const { RaviBot } = await import("./bot.js");

afterEach(async () => {
  saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
  agentCanImpl = (...args: Parameters<typeof actualAgentCan>) => actualAgentCan(...args);
  canWithCapabilitiesImpl = (...args: Parameters<typeof actualCanWithCapabilities>) =>
    actualCanWithCapabilities(...args);
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
    dbInsertCostEventMock.mockClear();
    calculateCostImpl = () => null;
    snapshotAgentCapabilitiesImpl = () => [];
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

  it("keeps runtime failure responses bounded while preserving runtime error detail", async () => {
    const sessionKey = "agent:main:runtime-failure";
    const longError = `TypeError: oD is not a function\n${"at minified.bundle.js:1:1\n".repeat(100)}`;
    runtimeStartImpl = (providerId) => ({
      provider: providerId,
      events: (async function* () {
        yield {
          type: "turn.failed",
          error: longError,
          recoverable: true,
          rawEvent: { type: "result", subtype: "error_during_execution", errors: [longError] },
        };
      })(),
      interrupt: async () => {},
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runtimeFailure = emittedEvents.find(
      (entry) =>
        entry.topic === `ravi.session.${sessionKey}.runtime` &&
        entry.data?.type === "turn.failed" &&
        entry.data?.error === longError,
    );
    expect(runtimeFailure).toBeDefined();

    const response = emittedEvents.find((entry) => entry.topic === `ravi.session.${sessionKey}.response`)?.data
      ?.response;
    expect(String(response).startsWith("Error: TypeError: oD is not a function")).toBe(true);
    expect(String(response).length).toBeLessThanOrEqual(340);
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

  it("passes a runtime approval bridge that honors inherited Codex file-change permissions", async () => {
    activeProvider = "codex";
    snapshotAgentCapabilitiesImpl = () => [
      { permission: "use", objectType: "tool", objectId: "Write", source: "test" },
      { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
    ];

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-approval-bridge", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const approveRuntimeRequest = runtimeStartCalls[0]?.approveRuntimeRequest;
    expect(typeof approveRuntimeRequest).toBe("function");

    const result = await approveRuntimeRequest?.({
      kind: "file_change",
      method: "item/fileChange/requestApproval",
      toolName: "Write",
      input: { changes: [{ path: "hello.txt", kind: "add" }] },
      metadata: {
        provider: "codex",
        source: "codex.app-server",
        thread: { id: "thread_test" },
        turn: { id: "turn_test" },
      },
    });

    expect(result).toMatchObject({
      approved: true,
      inherited: true,
      updatedInput: { changes: [{ path: "hello.txt", kind: "add" }] },
    });

    await expect(
      approveRuntimeRequest?.({
        kind: "permission",
        method: "item/permissions/requestApproval",
        input: { permissions: { "use:tool:Bash": true } },
      }),
    ).resolves.toMatchObject({
      approved: true,
      inherited: true,
      permissions: { "use:tool:Bash": true },
    });
  });

  it("denies runtime user input when no outbound target exists", async () => {
    activeProvider = "codex";

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-user-input-no-source", { prompt: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const approveRuntimeRequest = runtimeStartCalls[0]?.approveRuntimeRequest;
    expect(typeof approveRuntimeRequest).toBe("function");

    await expect(
      approveRuntimeRequest?.({
        kind: "user_input",
        method: "item/tool/requestUserInput",
        input: {
          questions: [{ id: "choice", question: "Pick one", options: [{ label: "A" }] }],
        },
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason: "Runtime user input requires a target source.",
    });
  });

  it("denies runtime user input questions without selectable options", async () => {
    activeProvider = "codex";

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-user-input-no-options", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const approveRuntimeRequest = runtimeStartCalls[0]?.approveRuntimeRequest;
    expect(typeof approveRuntimeRequest).toBe("function");

    await expect(
      approveRuntimeRequest?.({
        kind: "user_input",
        method: "item/tool/requestUserInput",
        input: {
          questions: [{ id: "freeform", question: "What should I do?" }],
        },
      }),
    ).resolves.toMatchObject({
      approved: false,
      reason: "Runtime user input question requires selectable options: freeform",
    });
  });

  it("passes a Codex dynamic tool bridge that executes inherited Ravi CLI tools", async () => {
    activeProvider = "codex";
    snapshotAgentCapabilitiesImpl = () => [
      { permission: "use", objectType: "tool", objectId: "tools_list", source: "test" },
    ];

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-dynamic-tools", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runtimeRequest = runtimeStartCalls[0];
    expect(runtimeRequest?.dynamicTools?.some((tool) => tool.name === "tools_list")).toBe(true);
    expect(typeof runtimeRequest?.handleRuntimeToolCall).toBe("function");

    const result = await runtimeRequest?.handleRuntimeToolCall?.({
      toolName: "tools_list",
      callId: "dyn_tool_test",
      arguments: {},
      metadata: {
        provider: "codex",
        source: "codex.app-server",
        thread: { id: "thread_test" },
        turn: { id: "turn_test" },
        item: { id: "dyn_tool_test", type: "dynamic_tool_call" },
      },
    });

    expect(result?.success).toBe(true);
    expect(result?.contentItems?.[0]?.type).toBe("inputText");
    expect(result?.contentItems?.[0]?.text).toContain("fake tools list");
  });

  it("does not advertise Codex dynamic tools outside the runtime capability snapshot", async () => {
    activeProvider = "codex";
    snapshotAgentCapabilitiesImpl = () => [];

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-dynamic-tools-denied", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls[0]?.dynamicTools ?? []).toEqual([]);
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

  it("uses task runtime overrides for task-bound prompts without leaking them to later non-task turns", async () => {
    const sessionKey = "agent:main:task-runtime-model";
    sessions.set(sessionKey, {
      sessionKey,
      name: sessionKey,
      agentId: "main",
      agentCwd: "/tmp/ravi-test-bot/main",
      modelOverride: "session-model",
    });
    const dispatched = createDispatchedTaskForSession(sessionKey, {
      profileId: "task-doc-none",
      taskRuntimeOverride: {
        model: "task-model",
        effort: "xhigh",
      },
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("task turn"),
      taskBarrierTaskId: dispatched.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(1);
    expect(runtimeStartCalls[0]?.model).toBe("task-model");
    expect(runtimeStartCalls[0]?.effort).toBe("xhigh");
    expect(sessions.get(sessionKey)?.modelOverride).toBe("session-model");

    completeTaskForSession(dispatched.task.id, sessionKey);
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("normal turn"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(2);
    expect(runtimeStartCalls[1]?.model).toBe("session-model");
    expect(runtimeStartCalls[1]?.effort).toBeUndefined();
    expect(runtimeStartCalls[1]?.env?.RAVI_TASK_ID).toBeUndefined();
  });

  it("restarts when leaving a task context even if the live runtime can update models in place", async () => {
    const sessionKey = "agent:main:task-runtime-context-exit";
    sessions.set(sessionKey, {
      sessionKey,
      name: sessionKey,
      agentId: "main",
      agentCwd: "/tmp/ravi-test-bot/main",
      modelOverride: "test-model",
    });
    const dispatched = createDispatchedTaskForSession(sessionKey, {
      profileId: "task-doc-none",
      taskRuntimeOverride: {
        model: "test-model",
      },
    });
    const setModelCalls: string[] = [];
    const releaseRuntimes: Array<() => void> = [];
    runtimeStartImpl = (providerId, request) => {
      const lifetime = new Promise<void>((resolve) => {
        releaseRuntimes.push(resolve);
      });
      return {
        provider: providerId,
        events: (async function* () {
          await request.prompt.next();
          yield {
            type: "turn.complete",
            providerSessionId: `${providerId}-session`,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          await lifetime;
        })(),
        interrupt: async () => {
          releaseRuntimes.shift()?.();
        },
        setModel: async (model: string) => {
          setModelCalls.push(model);
        },
      };
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("task turn"),
      taskBarrierTaskId: dispatched.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    completeTaskForSession(dispatched.task.id, sessionKey);
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("normal turn"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls).toHaveLength(2);
    expect(setModelCalls).toEqual([]);
    expect(runtimeStartCalls[0]?.env?.RAVI_TASK_ID).toBe(dispatched.task.id);
    expect(runtimeStartCalls[1]?.env?.RAVI_TASK_ID).toBeUndefined();

    for (const release of releaseRuntimes.splice(0)) {
      release();
    }
    await bot.stop();
  });

  it("lets dispatch runtime overrides beat task runtime overrides at task start", async () => {
    const sessionKey = "agent:main:dispatch-runtime-model";
    const dispatched = createDispatchedTaskForSession(sessionKey, {
      profileId: "task-doc-none",
      taskRuntimeOverride: {
        model: "task-model",
      },
      dispatchRuntimeOverride: {
        model: "dispatch-model",
        thinking: "verbose",
      },
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("task turn"),
      taskBarrierTaskId: dispatched.task.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls[0]?.model).toBe("dispatch-model");
    expect(runtimeStartCalls[0]?.thinking).toBe("verbose");
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

  it("applies model changes to an active streaming session without daemon restart", async () => {
    const sessionKey = "agent:main:live-model-switch";
    const setModelCalls: string[] = [];
    let releaseRuntime: (() => void) | undefined;
    const runtimeLifetime = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });

    runtimeStartImpl = (providerId) => ({
      provider: providerId,
      events: (async function* () {
        await runtimeLifetime;
        yield { type: "status", status: "idle" };
      })(),
      interrupt: async () => {},
      setModel: async (model: string) => {
        setModelCalls.push(model);
      },
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = await (bot as any).applySessionModelChange(sessionKey, "test-model-2");
    const streaming = (bot as any).streamingSessions.get(sessionKey);

    expect(status).toBe("applied");
    expect(setModelCalls).toEqual(["test-model-2"]);
    expect(streaming?.currentModel).toBe("test-model-2");

    releaseRuntime?.();
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
          metadata: { provider: "codex", nativeEvent: "thread.started", thread: { id: "thread-codex" } },
        };
        yield {
          type: "text.delta",
          text: "hello ",
          metadata: {
            provider: "codex",
            nativeEvent: "item.text_delta",
            thread: { id: "thread-codex" },
            turn: { id: "turn-codex" },
            item: { id: "item-text", type: "assistant_message_delta" },
          },
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
    expect(runtimeStartCalls[0]?.hooks).toBeUndefined();
    expect(
      emittedEvents.some(
        (entry) => entry.topic === `ravi.session.${sessionKey}.runtime` && entry.data?.type === "provider.raw",
      ),
    ).toBe(true);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.runtime` &&
          entry.data?.type === "provider.raw" &&
          (entry.data.metadata as any)?.thread?.id === "thread-codex",
      ),
    ).toBe(true);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.stream` &&
          entry.data?.chunk === "hello " &&
          (entry.data.metadata as any)?.item?.id === "item-text",
      ),
    ).toBe(true);
  });

  it("does not backfill Codex cost events from the configured agent model when execution model is absent", async () => {
    activeProvider = "codex";
    const pricedModels: string[] = [];
    calculateCostImpl = (model) => {
      pricedModels.push(model);
      return { inputCost: 1, outputCost: 2, cacheCost: 0, totalCost: 3 };
    };
    runtimeStartImpl = (providerId) => ({
      provider: providerId,
      events: (async function* () {
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          execution: { provider: "openai", model: null, billingType: "subscription" },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      })(),
      interrupt: async () => {},
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-cost-no-model", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pricedModels).toEqual([]);
    expect(dbInsertCostEventMock).not.toHaveBeenCalled();
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

  it("suppresses recoverable abort failures from internally interrupted turns", async () => {
    const sessionKey = "agent:main:interrupted-abort-no-outbound";
    let releaseAfterTool: (() => void) | undefined;
    const afterTool = new Promise<void>((resolve) => {
      releaseAfterTool = resolve;
    });
    let releaseInterrupted: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupted = resolve;
    });
    let releaseRetryPrompt: (() => void) | undefined;
    const retryPromptSeen = new Promise<void>((resolve) => {
      releaseRetryPrompt = resolve;
    });
    let releaseSecondInterrupted: (() => void) | undefined;
    const secondInterrupted = new Promise<void>((resolve) => {
      releaseSecondInterrupted = resolve;
    });
    let releaseFinalRetryPrompt: (() => void) | undefined;
    const finalRetryPromptSeen = new Promise<void>((resolve) => {
      releaseFinalRetryPrompt = resolve;
    });
    let interruptCount = 0;
    const interrupt = mock(async () => {
      interruptCount += 1;
      if (interruptCount === 1) releaseInterrupted?.();
      if (interruptCount === 2) releaseSecondInterrupted?.();
    });

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        expect(first.value?.message.content).toBe("first");
        yield {
          type: "tool.started",
          toolUse: { id: "tool-read", name: "Read", input: { file_path: "/tmp/a" } },
        };
        yield {
          type: "tool.completed",
          toolUseId: "tool-read",
          content: "ok",
          isError: false,
        };
        releaseAfterTool?.();
        await interrupted;
        yield {
          type: "turn.failed",
          error: "[ede_diagnostic] stop_reason=tool_use; Error: Request was aborted.",
          recoverable: true,
          rawEvent: {
            type: "result",
            subtype: "error_during_execution",
            errors: ["[ede_diagnostic] stop_reason=tool_use", "Error: Request was aborted."],
          },
        };

        const retry = await request.prompt.next();
        expect(retry.value?.message.content).toBe("first\n\nsecond");
        releaseRetryPrompt?.();
        await secondInterrupted;
        yield {
          type: "turn.failed",
          error: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
          recoverable: true,
          rawEvent: {
            type: "result",
            subtype: "error_during_execution",
            errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
          },
        };

        const finalRetry = await request.prompt.next();
        expect(finalRetry.value?.message.content).toBe("first\n\nsecond\n\nthird");
        releaseFinalRetryPrompt?.();
        yield {
          type: "assistant.message",
          text: "handled third",
        };
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
    await afterTool;
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("second"));
    await retryPromptSeen;
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("third"));
    await finalRetryPromptSeen;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).toHaveBeenCalledTimes(2);
    const responses = emittedEvents
      .filter((entry) => entry.topic === `ravi.session.${sessionKey}.response`)
      .map((entry) => String(entry.data?.response ?? ""));
    expect(responses).toContain("handled third");
    expect(responses.some((response) => response.includes("Request was aborted"))).toBe(false);
    expect(responses.some((response) => response.startsWith("Error: [ede_diagnostic]"))).toBe(false);
    expect(responses.some((response) => response.includes("stop_reason=null"))).toBe(false);

    const runtimeEvents = emittedEvents.filter((entry) => entry.topic === `ravi.session.${sessionKey}.runtime`);
    expect(runtimeEvents.some((entry) => entry.data?.type === "turn.failed")).toBe(false);
    expect(runtimeEvents.filter((entry) => entry.data?.type === "turn.interrupted")).toHaveLength(2);
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
      agentId: "main",
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
      agentId: "main",
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

  it("restarts a live runtime when the effective agent changes for the same session", async () => {
    const sessionKey = "agent:main:test-agent-change";
    const bot = createBot();
    let interrupted = false;

    (bot as any).streamingSessions.set(sessionKey, {
      agentId: "main",
      queryHandle: {
        provider: "claude",
        interrupt: async () => {
          interrupted = true;
        },
      },
      abortController: new AbortController(),
      pushMessage: null,
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

    await (bot as any).handlePromptImmediate(sessionKey, {
      ...makePrompt("same session, new agent"),
      _agentId: "secondary",
    });

    expect(interrupted).toBe(true);
    expect(runtimeStartCalls).toHaveLength(1);
    expect(sessions.get(sessionKey)?.agentId).toBe("secondary");
  });

  it("starts a fresh streaming session when the previous one is already done", async () => {
    const sessionKey = "agent:main:test-done";
    const bot = createBot();

    const doneSession = {
      agentId: "main",
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
      agentId: "main",
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

  it("routes runtime control requests to the active session handle", async () => {
    const sessionKey = "agent:main:codex-control";
    const sessionName = "codex-control";
    const bot = createBot();
    let controlRequest: Record<string, unknown> | undefined;

    sessions.set(sessionKey, {
      sessionKey,
      name: sessionName,
      agentId: "main",
      agentCwd: "/tmp/main",
      runtimeProvider: "codex",
    });
    (bot as any).streamingSessions.set(sessionName, {
      agentId: "main",
      queryHandle: {
        provider: "codex",
        interrupt: async () => {},
        control: async (request: Record<string, unknown>) => {
          controlRequest = request;
          return {
            ok: true,
            operation: request.operation,
            state: {
              provider: "codex",
              threadId: "thread_control",
              turnId: "turn_control",
              activeTurn: true,
            },
            data: { interrupted: true },
          };
        },
      },
      abortController: new AbortController(),
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      currentSource: undefined,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: true,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });

    await (bot as any).handleRuntimeControlRequest({
      sessionName,
      sessionKey,
      replyTopic: "ravi._reply.control",
      request: { operation: "turn.interrupt", threadId: "thread_control" },
    });

    expect(controlRequest).toEqual({ operation: "turn.interrupt", threadId: "thread_control" });
    expect(emittedEvents.find((event) => event.topic === "ravi._reply.control")?.data).toMatchObject({
      result: {
        ok: true,
        operation: "turn.interrupt",
        data: { interrupted: true },
        state: { provider: "codex", threadId: "thread_control", turnId: "turn_control" },
      },
    });
    expect(emittedEvents.find((event) => event.topic === `ravi.session.${sessionName}.runtime`)?.data).toMatchObject({
      type: "runtime.control",
      provider: "codex",
      operation: "turn.interrupt",
      ok: true,
      state: { provider: "codex", threadId: "thread_control", turnId: "turn_control" },
    });
  });

  it("aborts and clears all streaming sessions on stop", async () => {
    const bot = createBot();
    const abortController = new AbortController();
    let interrupted = false;
    let generatorWoken = false;
    let turnSignalWoken = false;

    (bot as any).streamingSessions.set("agent:main:test", {
      agentId: "main",
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

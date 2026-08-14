import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import type { ApprovalServiceDependencies } from "./approval/service.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

setDefaultTimeout(20_000);

const actualDbModule = await import("./db.js");
const actualRouterIndexModule = await import("./router/index.js");
const actualRouterDbModule = await import("./router/router-db.js");
const actualCliContextModule = await import("./cli/context.js");
const actualRemoteSpawnNatsModule = await import("./remote-spawn-nats.js");
const actualPermissionProviderRuntimeModule = await import("./permissions/provider-runtime.js");
const actualRuntimeProviderRegistryModule = await import("./runtime/provider-registry.js");
const actualTaskDbModule = await import("./tasks/task-db.js");
const actualAgentCan = actualPermissionProviderRuntimeModule.agentCan;
const actualCanWithCapabilities = actualPermissionProviderRuntimeModule.canWithCapabilities;

type RuntimeProviderId = "claude" | "codex";

type RuntimeStartRequest = {
  prompt: AsyncGenerator<{
    type: "user";
    message: { role: "user"; content: string };
    session_id: string;
    parent_tool_use_id: string | null;
  }>;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh";
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
  lifecycleGeneration?: number;
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
const createdBots: Array<{ stop(): Promise<void> }> = [];
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
type TestCostResult = {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
  pricingStatus: "priced" | "unpriced";
} | null;
let calculateCostImpl: (
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number },
) => TestCostResult = () => null;
const dbInsertCostEventMock = mock((_event: Record<string, unknown>) => {});

const clearProviderSessionIfUnchanged = mock(
  (expected: Pick<SessionState, "sessionKey" | "lifecycleGeneration">): boolean => {
    const session = sessions.get(expected.sessionKey);
    if (!session || session.lifecycleGeneration !== expected.lifecycleGeneration) return false;
    session.runtimeProvider = undefined;
    session.runtimeSessionParams = undefined;
    session.runtimeSessionDisplayId = undefined;
    session.providerSessionId = undefined;
    session.sdkSessionId = undefined;
    return true;
  },
);

function resetRuntimeDoubles(): void {
  runtimeStartCalls = [];
  runtimePrepareImpl = async () => undefined;
  discoveredPlugins = [];
  runtimeStartImpl = (providerId, request) => ({
    provider: providerId,
    events: (async function* () {
      await request.prompt.next();
      yield {
        type: "turn.complete",
        providerSessionId: `${providerId}-session`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })(),
    interrupt: async () => {},
  });
}

function holdRuntimeTurnOpen(): () => void {
  let releaseRuntime!: () => void;
  const runtimeLifetime = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  runtimeStartImpl = (providerId, request) => ({
    provider: providerId,
    events: (async function* () {
      await request.prompt.next();
      await runtimeLifetime;
      yield {
        type: "turn.complete",
        providerSessionId: `${providerId}-session`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })(),
    interrupt: async () => releaseRuntime(),
  });
  return releaseRuntime;
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
      effort?: "low" | "medium" | "high" | "xhigh";
      thinking?: "off" | "normal" | "verbose";
    };
    dispatchRuntimeOverride?: {
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh";
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
    existing.lifecycleGeneration ??= 1;
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
    lifecycleGeneration: defaults?.lifecycleGeneration ?? 1,
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
  buildSystemPromptSections: () => [],
  renderPromptSections: () => "",
  SILENT_TOKEN: "@@SILENT@@",
}));

mock.module("./router/index.js", () => ({
  ...actualRouterIndexModule,
  getOrCreateSession: (key: string, agentId: string, agentCwd: string, defaults?: Partial<SessionState>) =>
    getOrCreateSessionState(key, agentId, agentCwd, defaults),
  getSession: (key: string) => {
    const session = sessions.get(key);
    if (session) session.lifecycleGeneration ??= 1;
    return session ?? null;
  },
  getSessionByName: (name: string) => {
    for (const session of sessions.values()) {
      if ((session.name ?? session.sessionKey) === name) {
        session.lifecycleGeneration ??= 1;
        return session;
      }
    }
    return null;
  },
  clearProviderSessionIfUnchanged,
  updateProviderSession: mock(
    (
      expected: Pick<
        SessionState,
        | "sessionKey"
        | "lifecycleGeneration"
        | "runtimeProvider"
        | "sdkSessionId"
        | "runtimeSessionDisplayId"
        | "runtimeSessionParams"
      >,
      provider: RuntimeProviderId,
      providerSessionId: string,
      options?: { runtimeSessionParams?: Record<string, unknown>; runtimeSessionDisplayId?: string },
    ) => {
      const session = sessions.get(expected.sessionKey);
      if (!session) return { won: false, lifecycleGeneration: null };
      if (typeof expected.lifecycleGeneration !== "number" || !Number.isSafeInteger(expected.lifecycleGeneration)) {
        return { won: false, lifecycleGeneration: session.lifecycleGeneration ?? null };
      }
      if (session.lifecycleGeneration !== expected.lifecycleGeneration) {
        return { won: false, lifecycleGeneration: session.lifecycleGeneration ?? null };
      }
      const displayId = options?.runtimeSessionDisplayId ?? providerSessionId;
      session.runtimeProvider = provider;
      session.runtimeSessionParams = options?.runtimeSessionParams;
      session.runtimeSessionDisplayId = displayId;
      session.providerSessionId = displayId;
      session.sdkSessionId = providerSessionId;
      return { won: true, lifecycleGeneration: expected.lifecycleGeneration };
    },
  ),
  updateRuntimeProviderState: mock(
    (
      expected: Pick<
        SessionState,
        | "sessionKey"
        | "lifecycleGeneration"
        | "runtimeProvider"
        | "sdkSessionId"
        | "runtimeSessionDisplayId"
        | "runtimeSessionParams"
      >,
      provider: RuntimeProviderId,
      options?: {
        providerSessionId?: string;
        runtimeSessionParams?: Record<string, unknown>;
        runtimeSessionDisplayId?: string;
      },
    ) => {
      const session = sessions.get(expected.sessionKey);
      if (!session) return { won: false, lifecycleGeneration: null };
      if (typeof expected.lifecycleGeneration !== "number" || !Number.isSafeInteger(expected.lifecycleGeneration)) {
        return { won: false, lifecycleGeneration: session.lifecycleGeneration ?? null };
      }
      if (session.lifecycleGeneration !== expected.lifecycleGeneration) {
        return { won: false, lifecycleGeneration: session.lifecycleGeneration ?? null };
      }
      session.runtimeProvider = provider;
      const hasProviderSessionId =
        typeof options?.providerSessionId === "string" && options.providerSessionId.trim().length > 0;
      const hasRuntimeSessionParams = options?.runtimeSessionParams !== undefined;
      const hasRuntimeSessionDisplayId = typeof options?.runtimeSessionDisplayId === "string";
      if (!hasProviderSessionId && !hasRuntimeSessionParams && !hasRuntimeSessionDisplayId) {
        return { won: true, lifecycleGeneration: expected.lifecycleGeneration };
      }
      session.runtimeSessionParams = options?.runtimeSessionParams;
      const providerSessionId = options?.providerSessionId?.trim() || undefined;
      const displayId = options?.runtimeSessionDisplayId ?? providerSessionId;
      session.runtimeSessionDisplayId = displayId;
      session.providerSessionId = displayId;
      session.sdkSessionId = providerSessionId;
      return { won: true, lifecycleGeneration: expected.lifecycleGeneration };
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
  getCliToolDefinition: () => undefined,
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

mock.module("./costs/pricing-catalog.js", () => ({
  calculateCost: (model: string, usage: Parameters<typeof calculateCostImpl>[1]) => calculateCostImpl(model, usage),
  prewarmPricingCatalog: () => {},
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

mock.module("./permissions/provider-runtime.js", () => ({
  ...actualPermissionProviderRuntimeModule,
  agentCan: (...args: Parameters<typeof actualAgentCan>) => agentCanImpl(...args),
  canWithCapabilities: (...args: Parameters<typeof actualCanWithCapabilities>) => canWithCapabilitiesImpl(...args),
}));

mock.module("./runtime/runtime-context-store.js", () => ({
  DEFAULT_DERIVED_CONTEXT_TTL_MS: 60 * 60 * 1000,
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
  getOrCreateAgentRuntimeContext: (input: {
    agentId?: string;
    sessionKey?: string;
    sessionName?: string;
    source?: { channel: string; accountId: string; chatId: string; threadId?: string };
    capabilities?: Array<{ permission: string; objectType: string; objectId: string; source?: string }>;
    metadata?: Record<string, unknown>;
  }) => ({
    contextId: "ctx_test_runtime",
    contextKey: "rctx_test_runtime",
    kind: "agent-runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    source: input.source,
    capabilities: input.capabilities ?? [],
    metadata: input.metadata,
    createdAt: Date.now(),
  }),
  revokeRuntimeContext: () => true,
  snapshotAgentCapabilities: () => snapshotAgentCapabilitiesImpl(),
}));

mock.module("./runtime/provider-registry.js", () => ({
  ...actualRuntimeProviderRegistryModule,
  createRuntimeProvider: (providerId: RuntimeProviderId = "claude") => {
    const capabilities =
      providerId === "codex"
        ? {
            runtimeControl: { supported: true, operations: ["turn.steer", "turn.interrupt"] },
            dynamicTools: { mode: "none" },
            execution: { mode: "subprocess-rpc" },
            sessionState: { mode: "thread-id", requiresCwdMatch: true },
            usage: { semantics: "terminal-event" },
            tools: {
              permissionMode: "ravi-host",
              accessRequirement: "tool_surface",
              supportsParallelCalls: false,
            },
            systemPrompt: { mode: "append" },
            terminalEvents: { guarantee: "adapter" },
            skillVisibility: { availability: "codex-skills", loadedState: "instruction-sources" },
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
            runtimeControl: { supported: false, operations: [] },
            dynamicTools: { mode: "none" },
            execution: { mode: "sdk" },
            sessionState: { mode: "provider-session-id" },
            usage: { semantics: "terminal-event" },
            tools: {
              permissionMode: "ravi-host",
              accessRequirement: "tool_and_executable",
              supportsParallelCalls: false,
            },
            systemPrompt: { mode: "append" },
            terminalEvents: { guarantee: "adapter" },
            skillVisibility: { availability: "plugins", loadedState: "provider-events" },
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
      getCapabilities(): {
        supportsToolHooks: boolean;
        supportsMcpServers: boolean;
        supportsRemoteSpawn: boolean;
        tools?: { permissionMode?: string };
      };
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
    const toolPermissionMode =
      capabilities.tools?.permissionMode ?? (capabilities.supportsToolHooks ? "ravi-host" : "provider-native");
    if (request.toolAccessMode === "restricted" && toolPermissionMode !== "ravi-host") {
      throw new Error(
        `Runtime provider '${provider.id}' requires full tool and executable access because Ravi permission hooks are unsupported`,
      );
    }
  },
}));

const { setApprovalServiceDependenciesForTest } = await import("./approval/service.js");
const { RaviBot } = await import("./bot.js");

beforeAll(async () => {
  // The fixture already runs in its own process. Keep its SQLite state alive
  // until every bot handle is stopped so no case can reuse a closed statement.
  stateDir = await createIsolatedRaviState("ravi-bot-runtime-guards-test-");
});

afterEach(async () => {
  for (const bot of createdBots.splice(0)) {
    await bot.stop();
  }
  setApprovalServiceDependenciesForTest();
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
});

afterAll(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  mock.restore();
});

function createBot(options: { startCrashRecovery?: boolean } = {}) {
  const bot = new RaviBot({
    config: {
      model: "test-model",
      logLevel: "error",
      apiKey: "fake",
    } as any,
  });
  if (options.startCrashRecovery !== false) {
    (bot as any).crashRecovery.start();
  }
  createdBots.push(bot);
  return bot;
}

type TestPromptSource = {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  canonicalChatId?: string;
  threadId?: string;
};

const WHATSAPP_SURFACE_HINT = "[session surface] This turn came from a WhatsApp chat. A normal reply returns there.";

function withWhatsAppSurfaceHint(text: string): string {
  return `${WHATSAPP_SURFACE_HINT}\n${text}`;
}

function makePrompt(
  text: string,
  source: TestPromptSource = { channel: "whatsapp", accountId: "main", chatId: "test" },
) {
  return {
    prompt: text,
    source,
  };
}

function attachOutputForSession(sessionKey: string): TestPromptSource {
  const now = Date.now();
  actualRouterDbModule
    .getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(sessionKey, sessionKey, "main", "/tmp/ravi-test-bot/main", now, now);
  const suffix = sessionKey.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const chat = actualRouterDbModule.dbUpsertChat({
    channel: "whatsapp",
    instanceId: "main",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `test-${suffix}`,
  });
  actualRouterDbModule.dbCreateSessionChatSubscription({
    sessionKey,
    chatId: chat.id,
    attachedReason: "runtime-guard-test-output",
    outputAttachedAt: Date.now(),
  });
  return {
    channel: "whatsapp",
    accountId: "main",
    instanceId: "main",
    chatId: chat.platformChatId,
    canonicalChatId: chat.id,
  };
}

function ensureSessionRow(sessionKey: string): void {
  const now = Date.now();
  actualRouterDbModule
    .getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(sessionKey, sessionKey, "main", "/tmp/ravi-test-bot/main", now, now);
}

function makeRuntimeGuardChat(input: {
  suffix: string;
  channel: string;
  accountId: string;
  platformChatId: string;
  chatType?: "dm" | "group" | "thread";
}) {
  return actualRouterDbModule.dbUpsertChat({
    channel: input.channel,
    instanceId: input.accountId,
    platformChatId: input.platformChatId,
    chatType: input.chatType ?? "dm",
    title: `test-${input.suffix}`,
  });
}

function attachMultiSurfaceOutputForSession(input: {
  sessionKey: string;
  defaultChat: ReturnType<typeof makeRuntimeGuardChat>;
  sourceChat: ReturnType<typeof makeRuntimeGuardChat>;
}): void {
  ensureSessionRow(input.sessionKey);
  actualRouterDbModule.dbCreateSessionChatSubscription({
    sessionKey: input.sessionKey,
    chatId: input.defaultChat.id,
    attachedReason: "runtime-guard-test-default-output",
    outputAttachedAt: Date.now(),
  });
  actualRouterDbModule.dbCreateSessionChatSubscription({
    sessionKey: input.sessionKey,
    chatId: input.sourceChat.id,
    attachedReason: "runtime-guard-test-source-speak",
  });
}

function promptForChat(text: string, chat: ReturnType<typeof makeRuntimeGuardChat>) {
  const separator = chat.platformChatId.indexOf("#");
  const chatId = separator === -1 ? chat.platformChatId : chat.platformChatId.slice(0, separator);
  const threadId = separator === -1 ? undefined : chat.platformChatId.slice(separator + 1);
  return {
    prompt: text,
    source: {
      channel: chat.channel,
      accountId: chat.instanceId,
      instanceId: chat.instanceId,
      chatId,
      ...(threadId ? { threadId } : {}),
      canonicalChatId: chat.id,
      actorType: "contact",
    },
  };
}

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function streamGeneratedImageTurn(finalText: string, options: { duplicateCompletion?: boolean } = {}) {
  runtimeStartImpl = (providerId, request) => ({
    provider: providerId,
    events: (async function* () {
      await request.prompt.next();
      yield {
        type: "tool.started",
        toolUse: { id: "image-gen", name: "image_gen.imagegen", input: { prompt: "test image" } },
      };
      const completion = {
        type: "tool.completed",
        toolUseId: "image-gen",
        toolName: "image_gen.imagegen",
        content: { id: "generated-image-1", result: TINY_PNG_BASE64 },
        isError: false,
        metadata: {
          provider: "codex",
          nativeEvent: "item.completed",
          item: { id: "item-generated-image-1", type: "imageGeneration", status: "completed" },
        },
      };
      yield completion;
      if (options.duplicateCompletion) yield { ...completion };
      yield {
        type: "assistant.message",
        text: finalText,
        metadata: {
          provider: "codex",
          nativeEvent: "item.completed",
          item: { id: "item-final-answer-1", type: "message", phase: "final_answer" },
        },
      };
      yield {
        type: "turn.complete",
        providerSessionId: `${providerId}-session`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })(),
    interrupt: async () => {},
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("RaviBot runtime guards", () => {
  beforeEach(async () => {
    emittedEvents.length = 0;
    sessions.clear();
    clearProviderSessionIfUnchanged.mockClear();
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

    expect(sessions.get(sessionKey)?.lifecycleGeneration).toBe(2);
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
    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        await request.prompt.next();
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

  it("cleans up runtime startup failures without exposing internal paths", async () => {
    const sessionKey = "agent:main:start-failure";
    const startupError =
      "ENOENT: no such file or directory, scandir '/Users/luis/.cache/ravi/plugins/ravi-system/skills/slack'";
    runtimeStartImpl = () => {
      throw new Error(startupError);
    };

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));

    expect((bot as any).streamingSessions.size).toBe(0);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.runtime` &&
          entry.data?.type === "turn.failed" &&
          entry.data?.error === startupError,
      ),
    ).toBe(true);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.response` &&
          entry.data?.response ===
            "Error: The agent could not complete this request because of an internal runtime error. Please try again.",
      ),
    ).toBe(true);
  });

  it("keeps runtime failure responses bounded while preserving runtime error detail", async () => {
    const sessionKey = "agent:main:runtime-failure";
    const source = attachOutputForSession(sessionKey);
    const longError = `TypeError: oD is not a function\n${"at minified.bundle.js:1:1\n".repeat(100)}`;
    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        await request.prompt.next();
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
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello", source));
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
    expect(response).toBe(
      "Error: The agent could not complete this request because of an internal runtime error. Please try again.",
    );
    expect(String(response)).not.toContain("TypeError");
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

    expect(combinedPrompt).toBe(withWhatsAppSurfaceHint("first\n\nsecond"));
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
    let releaseRuntime!: () => void;
    const runtimeLifetime = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        await request.prompt.next();
        await runtimeLifetime;
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
      interrupt: async () => releaseRuntime(),
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-approval-bridge", { prompt: "hello" });
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
    releaseRuntime();
  });

  it("denies runtime user input when no outbound target exists", async () => {
    activeProvider = "codex";
    const releaseRuntime = holdRuntimeTurnOpen();

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
    releaseRuntime();
  });

  it("denies runtime user input questions without selectable options", async () => {
    activeProvider = "codex";
    const releaseRuntime = holdRuntimeTurnOpen();

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
    releaseRuntime();
  });

  it("does not emit a second user-input poll after durable attempt ownership is lost", async () => {
    activeProvider = "codex";
    const releaseRuntime = holdRuntimeTurnOpen();
    const sessionKey = "agent:main:codex-user-input-multi-question-race";
    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("hello"));
    await waitFor(() => Boolean((bot as any).streamingSessions.get(sessionKey)?.currentCrashRecoveryAttemptId));

    const streamingSession = (bot as any).streamingSessions.get(sessionKey);
    const attemptId = streamingSession.currentCrashRecoveryAttemptId as string;
    const pollRequests: Array<{ topic: string; data: Record<string, unknown> }> = [];
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(topic: string, data: Record<string, unknown>) => {
        pollRequests.push({ topic, data });
        return { messageId: `poll-${pollRequests.length}` } as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      nats: {
        emit: async () => {},
        subscribe: (() => {
          const stream = (async function* () {
            yield {
              topic: "ravi.inbound.pollVote",
              data: {
                pollMessageId: "poll-1",
                votes: [{ name: "A", voters: ["actor-1"] }],
              },
            };
          })();
          const closeStream = stream.return.bind(stream);
          stream.return = async (value) => {
            streamingSession.currentCrashRecoveryAttemptId = undefined;
            return closeStream(value);
          };
          return stream;
        }) satisfies ApprovalServiceDependencies["nats"]["subscribe"],
      },
    });

    try {
      const approveRuntimeRequest = runtimeStartCalls[0]?.approveRuntimeRequest;
      await expect(
        approveRuntimeRequest?.({
          kind: "user_input",
          method: "item/tool/requestUserInput",
          input: {
            questions: [
              { id: "first", question: "First?", options: [{ label: "A" }] },
              { id: "second", question: "Second?", options: [{ label: "B" }] },
            ],
          },
        }),
      ).resolves.toMatchObject({
        approved: false,
        reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
      });
      expect(pollRequests).toHaveLength(1);
      expect(pollRequests[0]).toMatchObject({
        topic: "ravi.outbound.deliver",
        data: { poll: { name: expect.stringContaining("First?"), values: ["A"] } },
      });
    } finally {
      streamingSession.currentCrashRecoveryAttemptId = attemptId;
      setApprovalServiceDependenciesForTest();
      releaseRuntime();
    }
  });

  it("keeps Codex runtime requests free of native Ravi dynamic tools even with tool capabilities", async () => {
    activeProvider = "codex";
    snapshotAgentCapabilitiesImpl = () => [
      { permission: "use", objectType: "tool", objectId: "tools_list", source: "test" },
    ];

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-dynamic-tools", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runtimeRequest = runtimeStartCalls[0];
    expect(runtimeRequest?.dynamicTools).toBeUndefined();
    expect(runtimeRequest?.handleRuntimeToolCall).toBeUndefined();
  });

  it("does not advertise Codex dynamic tools without tool capabilities", async () => {
    activeProvider = "codex";
    snapshotAgentCapabilitiesImpl = () => [];

    const bot = createBot();
    await (bot as any).handlePromptImmediate("agent:main:codex-dynamic-tools-denied", makePrompt("hello"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStartCalls[0]?.dynamicTools).toBeUndefined();
    expect(runtimeStartCalls[0]?.handleRuntimeToolCall).toBeUndefined();
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
    expect(runtimeStartCalls[1]?.effort).toBe("xhigh");
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

    expect(firstPrompt).toBe(withWhatsAppSurfaceHint("first"));
    expect(secondPrompt).toBe(withWhatsAppSurfaceHint("second"));
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
      { provider: "codex", prompt: withWhatsAppSurfaceHint("first via codex") },
      { provider: "claude", prompt: withWhatsAppSurfaceHint("second via claude") },
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

  it("does not emit legacy .claude or unfenced structural raw events for Codex sessions", async () => {
    activeProvider = "codex";
    const sessionKey = "agent:main:codex-no-legacy-feed";

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        await request.prompt.next();
        const rawThreadStarted = { type: "thread.started", thread_id: "thread-codex" };
        yield {
          type: "provider.raw",
          rawEvent: rawThreadStarted,
          metadata: { provider: "codex", nativeEvent: "thread.started", thread: { id: "thread-codex" } },
        };
        yield {
          type: "thread.started",
          thread: { id: "thread-codex" },
          rawEvent: rawThreadStarted,
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
        const rawTurnComplete = { type: "turn.completed", thread_id: "thread-codex" };
        yield {
          type: "provider.raw",
          rawEvent: rawTurnComplete,
          metadata: { provider: "codex", nativeEvent: "turn.completed", thread: { id: "thread-codex" } },
        };
        yield {
          type: "turn.complete",
          providerSessionId: `${providerId}-session`,
          usage: { inputTokens: 1, outputTokens: 1 },
          rawEvent: rawTurnComplete,
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
    ).toBe(false);
    expect(
      emittedEvents.some(
        (entry) =>
          entry.topic === `ravi.session.${sessionKey}.runtime` &&
          entry.data?.type === "provider.raw" &&
          (entry.data.metadata as any)?.thread?.id === "thread-codex",
      ),
    ).toBe(false);
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
      return { inputCost: 1, outputCost: 2, cacheCost: 0, totalCost: 3, pricingStatus: "priced" };
    };
    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        await request.prompt.next();
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
        expect(first.value?.message.content).toBe(withWhatsAppSurfaceHint("first"));
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

  it("suppresses recoverable abort failures and retries the successor after prompt interruption", async () => {
    const sessionKey = "agent:main:interrupted-abort-no-outbound";
    let releaseAfterTool: (() => void) | undefined;
    const afterTool = new Promise<void>((resolve) => {
      releaseAfterTool = resolve;
    });
    let releaseInterrupted: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupted = resolve;
    });
    let releaseFirstFailure: (() => void) | undefined;
    const firstFailureSeen = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    let releaseRetryPrompt: (() => void) | undefined;
    const retryPromptSeen = new Promise<void>((resolve) => {
      releaseRetryPrompt = resolve;
    });
    const interrupt = mock(async () => {
      releaseInterrupted?.();
    });

    runtimeStartImpl = (providerId, request) => {
      if (runtimeStartCalls.length === 1) {
        return {
          provider: providerId,
          events: (async function* () {
            const first = await request.prompt.next();
            expect(first.value?.message.content).toBe(withWhatsAppSurfaceHint("first"));
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
            releaseFirstFailure?.();
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
          })(),
          interrupt,
        };
      }

      return {
        provider: providerId,
        events: (async function* () {
          const retry = await request.prompt.next();
          expect(retry.value?.message.content).toBe(withWhatsAppSurfaceHint("second"));
          releaseRetryPrompt?.();
          yield {
            type: "assistant.message",
            text: "handled retry",
          };
          yield {
            type: "turn.complete",
            providerSessionId: `${providerId}-session`,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        })(),
        interrupt: async () => {},
      };
    };

    const bot = createBot();
    const source = attachOutputForSession(sessionKey);
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("first", source));
    await afterTool;
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("second", source));
    await firstFailureSeen;
    await waitFor(() =>
      emittedEvents.some(
        (entry) => entry.topic === `ravi.session.${sessionKey}.runtime` && entry.data?.type === "turn.interrupted",
      ),
    );
    await retryPromptSeen;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(runtimeStartCalls).toHaveLength(2);
    const responses = emittedEvents
      .filter((entry) => entry.topic === `ravi.session.${sessionKey}.response`)
      .map((entry) => String(entry.data?.response ?? ""));
    expect(responses).toContain("handled retry");
    expect(responses.some((response) => response.includes("Request was aborted"))).toBe(false);
    expect(responses.some((response) => response.startsWith("Error: [ede_diagnostic]"))).toBe(false);
    expect(responses.some((response) => response.includes("stop_reason=null"))).toBe(false);

    const runtimeEvents = emittedEvents.filter((entry) => entry.topic === `ravi.session.${sessionKey}.runtime`);
    expect(runtimeEvents.some((entry) => entry.data?.type === "turn.failed")).toBe(false);
    expect(runtimeEvents.filter((entry) => entry.data?.type === "turn.interrupted")).toHaveLength(1);
  });

  it("suppresses recoverable abort failures from explicit internal aborts", async () => {
    const sessionKey = "agent:main:explicit-abort-no-outbound";
    let releaseFailure: (() => void) | undefined;
    const failureAllowed = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const interrupt = mock(async () => {
      releaseFailure?.();
    });

    runtimeStartImpl = (providerId, request) => ({
      provider: providerId,
      events: (async function* () {
        const first = await request.prompt.next();
        expect(first.value?.message.content).toBe(withWhatsAppSurfaceHint("first"));
        await failureAllowed;
        yield {
          type: "turn.failed",
          error: "Runtime process aborted by user",
          recoverable: true,
        };
      })(),
      interrupt,
    });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("first"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bot.abortSession(sessionKey)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupt).toHaveBeenCalledTimes(1);
    const responses = emittedEvents
      .filter((entry) => entry.topic === `ravi.session.${sessionKey}.response`)
      .map((entry) => String(entry.data?.response ?? ""));
    expect(responses.some((response) => response.includes("aborted"))).toBe(false);

    const runtimeEvents = emittedEvents.filter((entry) => entry.topic === `ravi.session.${sessionKey}.runtime`);
    expect(runtimeEvents.some((entry) => entry.data?.type === "turn.failed")).toBe(false);
    expect(
      runtimeEvents.some((entry) => entry.data?.type === "turn.interrupted" && entry.data?.reason === "explicit_abort"),
    ).toBe(true);
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
        expect(first.value?.message.content).toBe(withWhatsAppSurfaceHint("first"));
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

    expect(secondPrompt).toBe(withWhatsAppSurfaceHint("follow after response"));
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
      currentEffort: "xhigh",
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
    emittedEvents.length = 0;
    sessions.clear();
    clearProviderSessionIfUnchanged.mockClear();
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

  it("owns a boot epoch before subscriptions accept work and closes it gracefully", async () => {
    const bot = createBot({ startCrashRecovery: false });

    await bot.start();

    expect((bot as any).crashRecovery.boot).toMatchObject({
      instanceId: bot.instanceId,
      status: "active",
    });
    expect(bot.canAcceptRuntimePrompt()).toBe(true);

    await bot.stop();
    expect((bot as any).crashRecovery.boot).toMatchObject({ status: "graceful_stopped" });
    createdBots.splice(createdBots.indexOf(bot), 1);
  });

  it("fences an expired boot during stop instead of leaving its heartbeat alive", async () => {
    const bot = createBot({ startCrashRecovery: false });
    await bot.start();
    const crashRecovery = (bot as any).crashRecovery;
    const sessionName = "agent:main:expired-boot-stop";
    const abortController = new AbortController();
    const interrupt = mock(async () => {});
    const streaming = {
      agentId: "main",
      traceRunId: "run-expired-boot-stop",
      queryHandle: { provider: "claude", interrupt },
      abortController,
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      starting: false,
      interrupted: false,
      turnActive: true,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    };
    const attempt = crashRecovery.startTurnAttempt({
      attemptId: "attempt-expired-boot-stop",
      turnId: "turn-expired-boot-stop",
      runId: streaming.traceRunId,
      sessionKey: sessionName,
      sessionName,
      agentId: "main",
      provider: "claude",
      model: "test-model",
      requestBlobSha256: "sha-expired-boot-stop",
      originKind: "human",
      deliveryBarrier: "after_response",
    });
    (streaming as any).currentCrashRecoveryAttemptId = attempt.attemptId;
    (bot as any).streamingSessions.set(sessionName, streaming);
    const leaseExpiresAt = crashRecovery.boot.leaseExpiresAt;
    crashRecovery.now = () => leaseExpiresAt;

    let stopError: unknown;
    try {
      await bot.stop();
    } catch (error) {
      stopError = error;
    }

    expect(stopError).toMatchObject({ name: "RuntimeCrashRecoveryOwnershipLostError" });
    expect(crashRecovery.ownershipFailure).toBe(stopError);
    expect(crashRecovery.heartbeatTimer).toBeNull();
    expect(crashRecovery.boot).toMatchObject({ status: "active" });
    expect(bot.canAcceptRuntimePrompt()).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect((bot as any).streamingSessions.size).toBe(0);
    createdBots.splice(createdBots.indexOf(bot), 1);
  });

  it("fences intake and closes runtime sessions when crash recovery ownership is lost", async () => {
    const bot = createBot({ startCrashRecovery: false });
    await bot.start();
    const abortController = new AbortController();
    const interrupt = mock(async () => {});
    const sessionName = "agent:main:ownership-lost";
    (bot as any).streamingSessions.set(sessionName, {
      agentId: "main",
      traceRunId: "run-ownership-lost",
      queryHandle: { provider: "claude", interrupt },
      abortController,
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      starting: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });

    expect((bot as any).promptSubscription.healthTimer).not.toBeNull();
    (bot as any).crashRecovery.enterFailClosed("test ownership loss");

    expect(bot.canAcceptRuntimePrompt()).toBe(false);
    expect((bot as any).promptSubscription.healthTimer).toBeNull();
    expect((bot as any).streamingSessions.size).toBe(0);
    expect(abortController.signal.aborted).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect((bot as any).crashRecovery.boot).toMatchObject({ status: "active" });

    await bot.stop();
    createdBots.splice(createdBots.indexOf(bot), 1);
  });

  it("closes every provider when one shutdown trace fails", async () => {
    const bot = createBot();
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const firstInterrupt = mock(async () => {});
    const secondInterrupt = mock(async () => {});
    const runtimeSession = (
      abortController: AbortController,
      interrupt: ReturnType<typeof mock>,
      traceTurnId?: string,
    ) => ({
      agentId: "main",
      traceRunId: "run-shutdown-cleanup",
      currentTraceTurnId: traceTurnId,
      queryHandle: { provider: "claude", interrupt },
      abortController,
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      starting: false,
      interrupted: false,
      turnActive: Boolean(traceTurnId),
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });
    (bot as any).streamingSessions.set(
      "agent:main:shutdown-trace-failure",
      runtimeSession(firstAbortController, firstInterrupt, "turn-without-attempt-binding"),
    );
    (bot as any).streamingSessions.set(
      "agent:main:shutdown-after-failure",
      runtimeSession(secondAbortController, secondInterrupt),
    );

    let stopError: unknown;
    try {
      await bot.stop();
    } catch (error) {
      stopError = error;
    }

    expect(stopError).toMatchObject({
      message: "Crash recovery attempt binding missing before dispatcher terminal state",
    });
    expect(firstInterrupt).toHaveBeenCalledTimes(1);
    expect(secondInterrupt).toHaveBeenCalledTimes(1);
    expect(firstAbortController.signal.aborted).toBe(true);
    expect(secondAbortController.signal.aborted).toBe(true);
    expect((bot as any).streamingSessions.size).toBe(0);
    expect((bot as any).crashRecovery.boot).toMatchObject({ status: "graceful_stopped" });
    createdBots.splice(createdBots.indexOf(bot), 1);
  });

  it("finishes shutdown cleanup before propagating a restart snapshot failure", async () => {
    const bot = createBot();
    const abortController = new AbortController();
    const interrupt = mock(async () => {});
    const snapshotError = new Error("restart snapshot write failed");
    (bot as any).streamingSessions.set("agent:main:restart-snapshot-failure", {
      agentId: "main",
      traceRunId: "run-restart-snapshot-failure",
      queryHandle: { provider: "claude", interrupt },
      abortController,
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      starting: false,
      interrupted: false,
      turnActive: false,
      onTurnComplete: null,
      compacting: false,
      currentToolSafety: null,
      pendingAbort: false,
    });
    (bot as any).sessionDispatcher.recordDaemonRestartSnapshot = () => {
      throw snapshotError;
    };

    let stopError: unknown;
    try {
      await bot.stop({
        restart: {
          restartEpoch: "epoch-snapshot-failure",
          reason: "test restart snapshot failure",
        },
      });
    } catch (error) {
      stopError = error;
    }

    expect(stopError).toBe(snapshotError);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect((bot as any).streamingSessions.size).toBe(0);
    expect((bot as any).crashRecovery.boot).toMatchObject({ status: "graceful_stopped" });
    createdBots.splice(createdBots.indexOf(bot), 1);
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
      currentEffort: "xhigh",
      currentToolSafety: null,
      pendingAbort: false,
    });

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("follow-up"));

    const streamingSession = (bot as any).streamingSessions.get(sessionKey);
    expect(streamingSession.pendingMessages).toHaveLength(1);
    expect(streamingSession.pendingMessages[0]?.message.content).toBe(withWhatsAppSurfaceHint("follow-up"));
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
      currentEffort: "xhigh",
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
      currentEffort: "xhigh",
      currentToolSafety: null,
      pendingAbort: false,
    };
    (bot as any).streamingSessions.set(sessionKey, doneSession);

    await (bot as any).handlePromptImmediate(sessionKey, makePrompt("new conversation"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((bot as any).streamingSessions.get(sessionKey)).not.toBe(doneSession);
  });

  it("keeps the active response source stable until the queued turn starts", async () => {
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
      currentEffort: "xhigh",
      currentToolSafety: null,
      pendingAbort: false,
    };
    (bot as any).streamingSessions.set(sessionKey, streamingSession);

    const prompt = makePrompt("update source");
    prompt.source = { channel: "whatsapp", accountId: "main", chatId: "new-chat" };

    await (bot as any).handlePromptImmediate(sessionKey, prompt);

    const queued = (streamingSession.pendingMessages as any[])[0];
    expect(streamingSession.currentSource?.chatId).toBe("old");
    expect(queued?.launchPrompt?.source?.chatId).toBe("new-chat");
    expect(queued?.message.content).toBe(withWhatsAppSurfaceHint("update source"));
  });

  it("attaches generated media to the WhatsApp response target even when Slack is the default output", async () => {
    const sessionKey = "agent:main:generated-media-wa-source";
    const slackDefault = makeRuntimeGuardChat({
      suffix: "generated-media-slack-default",
      channel: "slack",
      accountId: "slack-main",
      platformChatId: "DDEFAULT#1781574894.010449",
      chatType: "thread",
    });
    const whatsappSource = makeRuntimeGuardChat({
      suffix: "generated-media-whatsapp-source",
      channel: "whatsapp",
      accountId: "main",
      platformChatId: "5511999999999@s.whatsapp.net",
    });
    attachMultiSurfaceOutputForSession({ sessionKey, defaultChat: slackDefault, sourceChat: whatsappSource });
    streamGeneratedImageTurn("imagem pronta");

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, promptForChat("gera imagem", whatsappSource));
    await waitFor(() => emittedEvents.some((entry) => entry.topic === `ravi.session.${sessionKey}.response`));

    const response = emittedEvents.find((entry) => entry.topic === `ravi.session.${sessionKey}.response`)?.data;
    expect(response?.target).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511999999999@s.whatsapp.net",
      canonicalChatId: whatsappSource.id,
    });
    expect(response?.target?.channel).not.toBe("slack");
    expect(response?.content).toEqual([
      expect.objectContaining({
        type: "media",
        media: expect.objectContaining({
          type: "image",
          filename: expect.stringContaining("ravi-generated-media"),
          mimeType: "image/png",
          source: "runtime.generated_media",
        }),
      }),
      { type: "text", text: "imagem pronta" },
    ]);
    const generatedMediaEvents = emittedEvents.filter(
      (entry) =>
        entry.topic === `ravi.session.${sessionKey}.runtime` || entry.topic === `ravi.session.${sessionKey}.tool`,
    );
    expect(JSON.stringify(generatedMediaEvents)).not.toContain(TINY_PNG_BASE64);
    const persistedTracePayloads = actualRouterDbModule
      .getDb()
      .prepare("SELECT payload_json FROM session_events WHERE session_key = ?")
      .all(sessionKey);
    expect(JSON.stringify(persistedTracePayloads)).not.toContain(TINY_PNG_BASE64);
  });

  it("attaches generated media to the Slack response target even when WhatsApp is the default output", async () => {
    const sessionKey = "agent:main:generated-media-slack-source";
    const whatsappDefault = makeRuntimeGuardChat({
      suffix: "generated-media-whatsapp-default",
      channel: "whatsapp",
      accountId: "main",
      platformChatId: "5511888888888@s.whatsapp.net",
    });
    const slackSource = makeRuntimeGuardChat({
      suffix: "generated-media-slack-source",
      channel: "slack",
      accountId: "slack-main",
      platformChatId: "CSOURCE#1781575000.010449",
      chatType: "thread",
    });
    attachMultiSurfaceOutputForSession({ sessionKey, defaultChat: whatsappDefault, sourceChat: slackSource });
    streamGeneratedImageTurn("slack pronto");

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, promptForChat("gera imagem no slack", slackSource));
    await waitFor(() => emittedEvents.some((entry) => entry.topic === `ravi.session.${sessionKey}.response`));

    const response = emittedEvents.find((entry) => entry.topic === `ravi.session.${sessionKey}.response`)?.data;
    expect(response?.target).toMatchObject({
      channel: "slack",
      accountId: "slack-main",
      chatId: "CSOURCE",
      threadId: "1781575000.010449",
      canonicalChatId: slackSource.id,
    });
    expect(response?.target?.channel).not.toBe("whatsapp");
    expect(response?.content).toEqual([
      expect.objectContaining({
        type: "media",
        media: expect.objectContaining({
          type: "image",
          filename: expect.stringContaining("ravi-generated-media"),
          mimeType: "image/png",
          source: "runtime.generated_media",
        }),
      }),
      { type: "text", text: "slack pronto" },
    ]);
  });

  it("emits generated media on a native Slack backend turn without duplicating the backend-owned text", async () => {
    const sessionKey = "agent:main:generated-media-slack-backend";
    const whatsappDefault = makeRuntimeGuardChat({
      suffix: "generated-media-backend-whatsapp-default",
      channel: "whatsapp",
      accountId: "main",
      platformChatId: "5511777777777@s.whatsapp.net",
    });
    const slackSource = makeRuntimeGuardChat({
      suffix: "generated-media-slack-backend-source",
      channel: "slack",
      accountId: "slack-main",
      platformChatId: "CBACKEND#1781576000.010449",
      chatType: "thread",
    });
    attachMultiSurfaceOutputForSession({ sessionKey, defaultChat: whatsappDefault, sourceChat: slackSource });
    streamGeneratedImageTurn("texto do backend");

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, {
      ...promptForChat("gera imagem no backend slack", slackSource),
      _channelBackend: {
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        ingressRequestId: "request-generated-media-slack-backend",
        correlationId: "correlation-generated-media-slack-backend",
        binding: {
          channelInstanceId: "slack-main",
          agentId: "main",
          chatId: slackSource.id,
          messageId: "message-generated-media-slack-backend",
          sessionId: sessionKey,
          turnId: "turn-generated-media-slack-backend",
        },
        target: {
          channelKind: "slack",
          connectionId: "slack-main",
          conversationId: "CBACKEND",
        },
      },
    });
    await waitFor(() => emittedEvents.some((entry) => entry.topic === `ravi.session.${sessionKey}.response`));

    const responses = emittedEvents.filter((entry) => entry.topic === `ravi.session.${sessionKey}.response`);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.data).toMatchObject({
      response: "",
      target: {
        channel: "slack",
        accountId: "slack-main",
        chatId: "CBACKEND",
        threadId: "1781576000.010449",
        canonicalChatId: slackSource.id,
      },
      content: [
        {
          type: "media",
          media: {
            type: "image",
            mimeType: "image/png",
            source: "runtime.generated_media",
          },
        },
      ],
    });
    expect(responses[0]?.data.content.some((part: { type?: string }) => part.type === "text")).toBe(false);
  });

  it("deduplicates repeated generated-image completions inside the runtime turn", async () => {
    const sessionKey = "agent:main:generated-media-duplicate-completion";
    const whatsappSource = makeRuntimeGuardChat({
      suffix: "generated-media-duplicate-source",
      channel: "whatsapp",
      accountId: "main",
      platformChatId: "5511666666666@s.whatsapp.net",
    });
    attachOutputForSession(sessionKey);
    actualRouterDbModule.dbCreateSessionChatSubscription({
      sessionKey,
      chatId: whatsappSource.id,
      attachedReason: "runtime-guard-test-generated-media-dedupe",
    });
    streamGeneratedImageTurn("imagem única", { duplicateCompletion: true });

    const bot = createBot();
    await (bot as any).handlePromptImmediate(sessionKey, promptForChat("gera uma imagem", whatsappSource));
    await waitFor(() => emittedEvents.some((entry) => entry.topic === `ravi.session.${sessionKey}.response`));

    const response = emittedEvents.find((entry) => entry.topic === `ravi.session.${sessionKey}.response`)?.data;
    expect(response?.content.filter((part: { type?: string }) => part.type === "media")).toHaveLength(1);
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

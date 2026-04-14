import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeProviderId } from "./runtime/types.js";

const actualDbModule = await import("./db.js");
const actualRouterIndexModule = await import("./router/index.js");
const actualCliContextModule = await import("./cli/context.js");
const actualPermissionsEngineModule = await import("./permissions/engine.js");
const actualRemoteSpawnNatsModule = await import("./remote-spawn-nats.js");
const actualLoggerModule = await import("./utils/logger.js");

const LIVE_TIMEOUT_MS = 180_000;

type EmittedEvent = {
  topic: string;
  data: any;
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

const emittedEvents: EmittedEvent[] = [];
const sessions = new Map<string, SessionState>();
let activeProvider: RuntimeProviderId = "claude";
let activeModel = "haiku";
let activeCwd = "/tmp/ravi-live-bot";
let saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
let agentCanImpl = (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) =>
  actualPermissionsEngineModule.agentCan(...args);
let canWithCapabilitiesImpl = (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
  actualPermissionsEngineModule.canWithCapabilities(...args);

function getOrCreateSessionState(
  sessionKey: string,
  agentId: string,
  agentCwd: string,
  defaults?: Partial<SessionState>,
): SessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    if (existing.agentId !== agentId || existing.agentCwd !== agentCwd) {
      existing.agentId = agentId;
      existing.agentCwd = agentCwd;
      existing.runtimeProvider = undefined;
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

function waitForResponse(topic: string, expectedText: string): Promise<EmittedEvent> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const event = emittedEvents.find(
        (entry) => entry.topic === topic && entry.data?.response?.includes(expectedText),
      );
      if (event) {
        clearInterval(timer);
        resolve(event);
        return;
      }
      if (Date.now() - startedAt > LIVE_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for response containing ${expectedText}`));
      }
    }, 250);
  });
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
  clearProviderSession: mock((sessionKey: string) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    session.runtimeProvider = undefined;
    session.providerSessionId = undefined;
    session.sdkSessionId = undefined;
  }),
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
  expandHome: (path: string) => path,
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
          cwd: activeCwd,
          provider: activeProvider,
          model: activeModel,
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
  SANITIZED_ENV_VARS: [],
  createSanitizeBashHook: () => ({
    matcher: "Bash",
    hooks: [async () => ({})],
  }),
}));

mock.module("./permissions/engine.js", () => ({
  ...actualPermissionsEngineModule,
  agentCan: (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) => agentCanImpl(...args),
  canWithCapabilities: (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
    canWithCapabilitiesImpl(...args),
}));

mock.module("./constants.js", () => ({
  calculateCost: () => null,
}));

mock.module("./plugins/index.js", () => ({
  discoverPlugins: () => [],
}));

mock.module("./spec/server.js", () => ({
  createSpecServer: () => null,
  isSpecModeActive: () => false,
  getSpecState: () => undefined,
}));

mock.module("./remote-spawn.js", () => ({
  createRemoteSpawn: () => {
    throw new Error("Remote spawn should not be used in live bot tests");
  },
}));

mock.module("./remote-spawn-nats.js", () => ({
  ...actualRemoteSpawnNatsModule,
  createNatsRemoteSpawn: () => {
    throw new Error("Remote spawn should not be used in live bot tests");
  },
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

function canRunProvider(provider: RuntimeProviderId): boolean {
  if (process.env.RAVI_LIVE_TESTS !== "1") return false;
  if (provider === "claude") {
    return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  }
  return hasCodexCliAuth();
}

async function runBotRoundTrip(
  provider: RuntimeProviderId,
  model: string,
  expectedText: string,
  prompt: string,
): Promise<void> {
  activeProvider = provider;
  activeModel = model;
  activeCwd = mkdtempSync(join(tmpdir(), `ravi-live-bot-${provider}-`));
  emittedEvents.length = 0;
  sessions.clear();

  const bot = new RaviBot({
    config: {
      model,
      logLevel: "error",
    } as any,
  });

  const sessionName = `agent:main:live:${provider}`;
  const responseTopic = `ravi.session.${sessionName}.response`;

  try {
    await (bot as any).handlePromptImmediate(sessionName, {
      prompt,
      source: { channel: "tui", accountId: "", chatId: "live-test" },
    });

    const response = await waitForResponse(responseTopic, expectedText);
    expect(response.data.response).toContain(expectedText);

    const session = sessions.get(sessionName);
    expect(session?.runtimeProvider).toBe(provider);
    expect(session?.providerSessionId).toBeTruthy();
  } finally {
    await bot.stop();
    rmSync(activeCwd, { recursive: true, force: true });
    sessions.clear();
    emittedEvents.length = 0;
  }
}

describe("RaviBot live provider integration", () => {
  afterEach(() => {
    emittedEvents.length = 0;
    sessions.clear();
    saveMessageImpl = (...args: Parameters<typeof actualDbModule.saveMessage>) => actualDbModule.saveMessage(...args);
    agentCanImpl = (...args: Parameters<typeof actualPermissionsEngineModule.agentCan>) =>
      actualPermissionsEngineModule.agentCan(...args);
    canWithCapabilitiesImpl = (...args: Parameters<typeof actualPermissionsEngineModule.canWithCapabilities>) =>
      actualPermissionsEngineModule.canWithCapabilities(...args);
  });

  const claudeIt = canRunProvider("claude") ? it : it.skip;
  claudeIt(
    "runs a real Claude turn through bot/event loop",
    async () => {
      await runBotRoundTrip(
        "claude",
        process.env.RAVI_LIVE_CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL ?? "haiku",
        "RAVI_BOT_CLAUDE_OK",
        "Reply with exactly RAVI_BOT_CLAUDE_OK and nothing else.",
      );
    },
    LIVE_TIMEOUT_MS,
  );

  const codexIt = canRunProvider("codex") ? it : it.skip;
  codexIt(
    "runs a real Codex turn through bot/event loop",
    async () => {
      await runBotRoundTrip(
        "codex",
        process.env.RAVI_LIVE_CODEX_MODEL ?? process.env.RAVI_CODEX_MODEL ?? "gpt-5",
        "RAVI_BOT_CODEX_OK",
        "Reply with exactly RAVI_BOT_CODEX_OK and nothing else.",
      );
    },
    LIVE_TIMEOUT_MS,
  );
});

function hasCodexCliAuth(): boolean {
  const version = spawnSync("codex", ["--version"], { stdio: "ignore" });
  if (version.status !== 0) {
    return false;
  }

  if (process.env.OPENAI_API_KEY) {
    return true;
  }

  return existsSync(join(homedir(), ".codex", "auth.json"));
}
afterAll(() => mock.restore());

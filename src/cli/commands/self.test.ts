import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const actualCliContextModule = await import("../context.js");
const actualRuntimeContextRegistryModule = await import("../../runtime/context-registry.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");

type FakeContext = {
  contextId: string;
  contextKey: string;
  kind: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: { channel: string; accountId: string; chatId: string; threadId?: string };
  capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

let inlineContext: FakeContext | undefined;
let resolvedContext: FakeContext | undefined;
let resolvedContextOptions: unknown;
let session: Record<string, unknown> | null = null;
let chatBinding: Record<string, unknown> | null = null;
let chat: Record<string, unknown> | null = null;
let boundRoute: Record<string, unknown> | null = null;
let sessionRoutes: Record<string, unknown>[] = [];
let chatParticipants: Record<string, unknown>[] = [];
let messageMeta: Record<string, unknown>[] = [];
let messageMetaLimits: number[] = [];

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  fail: (message: string) => {
    throw new Error(message);
  },
  getContext: () => (inlineContext ? { context: inlineContext } : undefined),
}));

mock.module("../../runtime/context-registry.js", () => ({
  ...actualRuntimeContextRegistryModule,
  RAVI_CONTEXT_KEY_ENV: "RAVI_CONTEXT_KEY",
  resolveRuntimeContextOrThrow: (_key: string, options?: unknown) => {
    resolvedContextOptions = options;
    if (!resolvedContext) throw new Error("Context not found");
    return resolvedContext;
  },
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  resolveSession: () => session,
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbGetSessionChatBinding: () => chatBinding,
  dbGetChat: () => chat,
  dbGetRouteById: () => boundRoute,
  dbListRoutesBySessionName: () => sessionRoutes,
  dbListChatParticipants: () => chatParticipants,
  dbListMessageMetaByChatId: (_chatId: string, limit: number) => {
    messageMetaLimits.push(limit);
    return messageMeta.slice(0, limit);
  },
}));

const { SelfCommands } = await import("./self.js");

function captureConsole<T>(run: () => T): { output: string; result: T } {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };

  try {
    const result = run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function fakeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    contextId: "ctx_self_123",
    contextKey: "rctx_secret_123",
    kind: "agent-runtime",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionName: "main",
    source: { channel: "whatsapp", accountId: "main", chatId: "120363" },
    capabilities: [
      { permission: "execute", objectType: "group", objectId: "sessions" },
      { permission: "use", objectType: "tool", objectId: "tasks_report" },
    ],
    metadata: { runtimeProvider: "codex", apiToken: "secret-token" },
    createdAt: 1000,
    expiresAt: 2000,
    lastUsedAt: 1500,
    ...overrides,
  };
}

function seedLinkedContext(): void {
  inlineContext = fakeContext();
  resolvedContext = undefined;
  session = {
    sessionKey: "agent:main:main",
    name: "main",
    agentId: "main",
    agentCwd: "/Users/luis/ravi/main",
    runtimeProvider: "codex",
    runtimeSessionDisplayId: "thread_123",
    modelOverride: undefined,
    thinkingLevel: undefined,
    channel: "whatsapp",
    accountId: "main",
    chatType: "group",
    displayName: "Ravi",
    subject: "Ravi Main",
    lastChannel: "whatsapp",
    lastAccountId: "main",
    lastTo: "120363",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    contextTokens: 40,
    compactionCount: 1,
    updatedAt: 3000,
    createdAt: 900,
  };
  chatBinding = {
    sessionKey: "agent:main:main",
    chatId: "chat_123",
    agentId: "main",
    routeId: 7,
    bindingReason: "route",
    createdAt: 1000,
    updatedAt: 3000,
  };
  chat = {
    id: "chat_123",
    channel: "whatsapp",
    instanceId: "main",
    platformChatId: "120363@g.us",
    normalizedChatId: "120363@g.us",
    chatType: "group",
    title: "Ravi Main",
    firstSeenAt: 1000,
    lastSeenAt: 3000,
    createdAt: 1000,
    updatedAt: 3000,
  };
  boundRoute = {
    id: 7,
    pattern: "group:120363",
    accountId: "main",
    agent: "main",
    priority: 10,
    channel: "whatsapp",
  };
  sessionRoutes = [];
  chatParticipants = [
    {
      id: "cp_1",
      chatId: "chat_123",
      participantType: "agent",
      agentId: "main",
      role: "agent",
      status: "active",
      source: "omni",
      firstSeenAt: 1000,
      lastSeenAt: 3000,
    },
  ];
  messageMeta = [
    {
      messageId: "msg_1",
      chatId: "chat_123",
      canonicalChatId: "chat_123",
      actorType: "contact",
      contactId: "contact_luis",
      mediaType: "audio",
      transcription: "teste",
      createdAt: 2500,
    },
    {
      messageId: "msg_2",
      chatId: "chat_123",
      actorType: "agent",
      agentId: "main",
      createdAt: 2600,
    },
  ];
}

describe("SelfCommands", () => {
  const originalContextKey = process.env.RAVI_CONTEXT_KEY;

  beforeEach(() => {
    seedLinkedContext();
    resolvedContextOptions = undefined;
    messageMetaLimits = [];
  });

  afterEach(() => {
    if (originalContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
    else process.env.RAVI_CONTEXT_KEY = originalContextKey;
    inlineContext = undefined;
    resolvedContext = undefined;
    session = null;
    chatBinding = null;
    chat = null;
    boundRoute = null;
    sessionRoutes = [];
    chatParticipants = [];
    messageMeta = [];
    messageMetaLimits = [];
  });

  it("prints the current self context without exposing the context key", () => {
    const { output, result } = captureConsole(() => new SelfCommands().context("full", "2", true));
    const payload = JSON.parse(output);

    expect(payload.identity).toMatchObject({
      contextId: "ctx_self_123",
      agentId: "main",
      sessionName: "main",
    });
    expect(payload.session.data).toMatchObject({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(payload.chat.data.chat).toMatchObject({ id: "chat_123", title: "Ravi Main" });
    expect(payload.chat.data.participants).toHaveLength(1);
    expect(payload.route.data.boundRoute).toMatchObject({ id: 7, pattern: "group:120363" });
    expect(payload.recent.data.messages).toHaveLength(2);
    expect(payload.permissions.data.count).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("rctx_secret_123");
    expect(payload.identity.metadata).toMatchObject({ apiToken: "[redacted]" });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
    expect(result).toEqual(payload);
  });

  it("resolves context from RAVI_CONTEXT_KEY in read-only mode when no inline context exists", () => {
    inlineContext = undefined;
    resolvedContext = fakeContext({ contextId: "ctx_env_123", contextKey: "rctx_env_secret" });
    process.env.RAVI_CONTEXT_KEY = "rctx_env_secret";

    const { output } = captureConsole(() => new SelfCommands().whoami(true));
    const payload = JSON.parse(output);

    expect(payload.identity.contextId).toBe("ctx_env_123");
    expect(resolvedContextOptions).toEqual({ touch: false, readOnly: true });
    expect(JSON.stringify(payload)).not.toContain("rctx_env_secret");
  });

  it("keeps recent message lookup bounded by --limit", () => {
    const { output } = captureConsole(() => new SelfCommands().recent("1", true));
    const payload = JSON.parse(output);

    expect(messageMetaLimits).toEqual([1]);
    expect(payload.data.messages).toHaveLength(1);
    expect(payload.data.messages[0]).toMatchObject({
      messageId: "msg_1",
      hasTranscription: true,
    });
  });

  it("fails clearly without a current Ravi context", () => {
    inlineContext = undefined;
    resolvedContext = undefined;
    delete process.env.RAVI_CONTEXT_KEY;

    expect(() => new SelfCommands().whoami(true)).toThrow("Missing RAVI_CONTEXT_KEY");
  });
});

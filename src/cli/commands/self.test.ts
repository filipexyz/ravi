import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";

const actualCliContextModule = await import("../context.js");
const actualRuntimeContextRegistryModule = await import("../../runtime/context-registry.js");
const actualRouterDbModule = await import("../../router/router-db.js");

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
let resolutionFailure: Error | undefined;
let resolvedContextOptions: unknown;
let session: Record<string, unknown> | null = null;
let chatBinding: Record<string, unknown> | null = null;
let chat: Record<string, unknown> | null = null;
let boundRoute: Record<string, unknown> | null = null;
let sessionRoutes: Record<string, unknown>[] = [];
let chatParticipants: Record<string, unknown>[] = [];
let messageMeta: Record<string, unknown>[] = [];
let messageMetaLimits: number[] = [];
const ACTOR_ENV_KEYS = [
  "RAVI_ACTOR_TYPE",
  "RAVI_CONTACT_ID",
  "RAVI_ACTOR_AGENT_ID",
  "RAVI_PLATFORM_IDENTITY_ID",
  "RAVI_CANONICAL_CHAT_ID",
  "RAVI_RAW_SENDER_ID",
  "RAVI_NORMALIZED_SENDER_ID",
  "RAVI_SENDER_ID",
  "RAVI_SENDER_PHONE",
] as const;
const ORIGINAL_ACTOR_ENV = Object.fromEntries(ACTOR_ENV_KEYS.map((key) => [key, process.env[key]]));

function clearActorEnv(): void {
  for (const key of ACTOR_ENV_KEYS) delete process.env[key];
}

function restoreActorEnv(): void {
  for (const key of ACTOR_ENV_KEYS) {
    const value = ORIGINAL_ACTOR_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  fail: (message: string) => {
    throw new Error(message);
  },
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  getContext: () => (inlineContext ? { context: inlineContext } : undefined),
}));

mock.module("../../runtime/context-registry.js", () => ({
  ...actualRuntimeContextRegistryModule,
  RAVI_CONTEXT_KEY_ENV: "RAVI_CONTEXT_KEY",
  resolveRuntimeContextOrThrow: (_key: string, options?: unknown) => {
    resolvedContextOptions = options;
    if (resolutionFailure) throw resolutionFailure;
    const trusted = resolvedContext ?? inlineContext;
    if (!trusted) throw new Error("Context not found");
    return trusted;
  },
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
}));

mock.module("./self-read-snapshot.js", () => ({
  readSelfSnapshot: (options: { messageLimit: number; includeParticipants: boolean }) => {
    messageMetaLimits.push(options.messageLimit);
    return {
      session,
      binding: chatBinding,
      chat,
      boundRoute,
      sessionRoutes,
      participants: options.includeParticipants ? chatParticipants : [],
      messages: messageMeta.slice(0, options.messageLimit),
    };
  },
}));

const { SelfCommands, SELF_CONTEXT_FIELDS, SELF_ENVIRONMENT_CONTRACT } = await import("./self.js");
const { CliExpectedError } = await import("../expected-error.js");
const { getCommandAccessMetadata, getGroupMetadata } = await import("../decorators.js");
const { extractTools } = await import("../tools-export.js");
const { buildRegistry } = await import("../registry-snapshot.js");
const { dispatch } = await import("../../sdk/gateway/dispatcher.js");
const {
  selfChatReturnSchema,
  selfContextReturnSchema,
  selfExplainReturnSchema,
  selfKnowledgeReturnSchema,
  selfPermissionsReturnSchema,
  selfRecentReturnSchema,
  selfRouteReturnSchema,
  selfWhoamiReturnSchema,
} = await import("./operational-return-schemas.js");

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
  resolutionFailure = undefined;
  session = {
    sessionKey: "agent:main:main",
    name: "main",
    agentId: "main",
    agentCwd: "/Users/luis/ravi/main",
    runtimeProvider: "codex",
    runtimeSessionDisplayId: "thread_123",
    modelOverride: undefined,
    effortOverride: "ultra",
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
    agentId: "main",
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
    clearActorEnv();
  });

  afterEach(() => {
    if (originalContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
    else process.env.RAVI_CONTEXT_KEY = originalContextKey;
    restoreActorEnv();
    inlineContext = undefined;
    resolvedContext = undefined;
    resolutionFailure = undefined;
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
      sourceOfTruth: "context_registry",
      contextId: "ctx_self_123",
      agentId: "main",
      sessionName: "main",
    });
    expect(payload.actor).toMatchObject({
      status: "partial",
      reason: "context did not carry actor metadata; using most recent non-agent message metadata",
      data: {
        actorType: "contact",
        contactId: "contact_luis",
        canonicalChatId: "chat_123",
        sourceMessageId: "msg_1",
        source: "recent_message",
        trust: "inferred",
      },
    });
    expect(payload.session.data).toMatchObject({
      sessionKey: "agent:main:main",
      agentId: "main",
      effortOverride: "ultra",
    });
    expect(payload.chat.data.chat).toMatchObject({ id: "chat_123", title: "Ravi Main" });
    expect(payload.chat.data.participants).toHaveLength(1);
    expect(payload.route.data.boundRoute).toMatchObject({ id: 7, pattern: "group:120363" });
    expect(payload.recent.data.messages).toHaveLength(2);
    expect(payload.permissions.data.count).toBe(2);
    expect(payload.environment).toEqual(SELF_ENVIRONMENT_CONTRACT);
    expect(JSON.stringify(payload)).not.toContain("rctx_secret_123");
    expect(payload.identity.metadata).toMatchObject({ apiToken: "[redacted]" });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
    expect(result).toEqual(payload);
  });

  it("redacts sensitive keys, headers and secret-shaped values recursively", () => {
    inlineContext = fakeContext({
      metadata: {
        authorization: "Bearer top-secret",
        cookie: "session=private",
        headers: { "x-safe": "visible", authorization: "Bearer nested" },
        nested: {
          harmless: "Bearer hidden-value",
          contextReference: "rctx_hidden_value",
          safe: "public",
        },
      },
    });

    const { result } = captureConsole(() => new SelfCommands().whoami(true));
    expect(result.identity.metadata).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
      headers: "[redacted]",
      nested: {
        harmless: "[redacted]",
        contextReference: "[redacted]",
        safe: "public",
      },
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("hidden-value");
    expect(JSON.stringify(result)).not.toContain("rctx_hidden_value");
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

  it("rejects an inline context that does not match the trusted registry", () => {
    inlineContext = fakeContext({ agentId: "victim" });
    resolvedContext = fakeContext({ agentId: "main" });

    let failure: unknown;
    try {
      new SelfCommands().whoami(true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "SELF_CONTEXT_DIVERGENT", exitCode: 1, publicMessage: true });
  });

  it("rejects a fabricated context through the local tool handler", async () => {
    const capabilities = [{ permission: "read", objectType: "self", objectId: "*" }];
    inlineContext = fakeContext({ agentId: "victim", capabilities });
    resolvedContext = fakeContext({ agentId: "main", capabilities });
    const tool = extractTools([SelfCommands]).find((candidate) => candidate.name === "self_whoami");

    const result = await tool!.handler({});
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { error?: { code?: string } };

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    expect(payload.error?.code).toBe("SELF_CONTEXT_DIVERGENT");
  });

  it("rejects a fabricated context through the gateway dispatcher", async () => {
    const capabilities = [{ permission: "read", objectType: "self", objectId: "*" }];
    inlineContext = fakeContext({ agentId: "victim", capabilities });
    resolvedContext = fakeContext({ agentId: "main", capabilities });
    const command = buildRegistry([SelfCommands]).commands.find((candidate) => candidate.fullName === "self.whoami");

    const result = await dispatch(
      command!,
      {},
      { agentId: "victim", sessionKey: "agent:main:main", sessionName: "main" },
      { contextRecord: inlineContext as never },
    );
    const payload = (await result.response.json()) as { error?: { code?: string }; data?: unknown };

    expect(result.response.status).toBe(422);
    expect(payload.error?.code).toBe("SELF_CONTEXT_DIVERGENT");
    expect(JSON.stringify(payload)).not.toContain("C:/other-agent");
    expect(payload).not.toHaveProperty("data.identity");
  });

  it.each([
    ["Context not found", "SELF_CONTEXT_NOT_FOUND"],
    ["Context expired", "SELF_CONTEXT_EXPIRED"],
    ["Context revoked", "SELF_CONTEXT_REVOKED"],
  ])("rejects an unavailable trusted context: %s", (message, code) => {
    resolutionFailure = new Error(message);

    let failure: unknown;
    try {
      new SelfCommands().whoami(true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code, exitCode: 1, publicMessage: true });
  });

  it("rejects a session owned by another agent without exposing its cwd", () => {
    session = {
      ...session,
      agentId: "other-agent",
      agentCwd: "C:/other-agent/private",
    };
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => lines.push(String(value));
    let failure: unknown;
    try {
      new SelfCommands().whoami(true);
    } catch (error) {
      failure = error;
    } finally {
      console.log = originalLog;
    }

    expect(failure).toMatchObject({
      code: "SELF_AUTHORITY_DIVERGENT",
      exitCode: 1,
      publicMessage: true,
      details: { relation: "session_agent" },
    });
    expect(lines.join("\n")).not.toContain("other-agent");
    expect(lines.join("\n")).not.toContain("C:/other-agent/private");
  });

  it.each([
    ["binding_agent", () => (chatBinding = { ...(chatBinding ?? {}), agentId: "other-agent" })],
    ["chat_agent", () => (chat = { ...(chat ?? {}), agentId: "other-agent" })],
    ["route_agent", () => (boundRoute = { ...(boundRoute ?? {}), agent: "other-agent" })],
    ["runtime_provider", () => (session = { ...(session ?? {}), runtimeProvider: "claude" })],
  ])("fails closed when %s disagrees with the registered context", (relation, mutateFixture) => {
    mutateFixture();

    let failure: unknown;
    try {
      new SelfCommands().whoami(true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "SELF_AUTHORITY_DIVERGENT",
      exitCode: 1,
      details: { relation },
    });
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

    let failure: unknown;
    try {
      new SelfCommands().whoami(true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CliExpectedError);
    expect(failure).toMatchObject({ code: "SELF_CONTEXT_REQUIRED", exitCode: 1, publicMessage: true });
    expect((failure as Error).message).toContain("Missing RAVI_CONTEXT_KEY");
  });
});

// Manual v2 contract: `self` is a read-only orientation domain — no write
// brakes and no per-entity not-found envelope apply. The contract surface here
// is compact mode on the largest payload (`self context --fields`).
describe("self agent-first contract", () => {
  beforeEach(() => {
    clearActorEnv();
    seedLinkedContext();
  });

  afterEach(() => {
    restoreActorEnv();
    inlineContext = undefined;
  });

  it("supports --fields compact mode on self context (top-level sections)", () => {
    const { output, result } = captureConsole(() =>
      new SelfCommands().context("summary", "2", true, "identity,session"),
    );
    const payload = JSON.parse(output) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(["identity", "session"]);
    expect((payload.identity as Record<string, unknown>).contextId).toBe("ctx_self_123");
    expect(result as unknown as Record<string, unknown>).toEqual(payload);
  });

  it("rejects an empty projected context return", () => {
    expect(selfContextReturnSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown --fields through the shared usage contract", () => {
    let failure: unknown;
    try {
      new SelfCommands().context("summary", "2", true, "identity,unknown");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CliExpectedError);
    expect(failure).toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      publicMessage: true,
      details: { acceptedFields: [...SELF_CONTEXT_FIELDS] },
    });
  });

  it("prints the projected packet as JSON even without --json when --fields is set", () => {
    const { output } = captureConsole(() => new SelfCommands().context("summary", "2", false, "identity"));
    const payload = JSON.parse(output) as Record<string, unknown>;

    expect(Object.keys(payload)).toEqual(["identity"]);
  });

  it("keeps the full packet when --fields is absent", () => {
    const { output } = captureConsole(() => new SelfCommands().context("summary", "2", true));
    const payload = JSON.parse(output) as Record<string, unknown>;

    for (const key of [
      "identity",
      "environment",
      "actor",
      "session",
      "chat",
      "route",
      "recent",
      "permissions",
      "knowledge",
    ]) {
      expect(payload).toHaveProperty(key);
    }
  });

  it("keeps --depth validation public and typed", () => {
    let failure: unknown;
    try {
      new SelfCommands().chat("turbo", true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ARG_INVALID", exitCode: 1, publicMessage: true });
    expect((failure as Error).message).toContain("Invalid --depth: turbo");
  });

  it("keeps --limit validation public and typed", () => {
    let failure: unknown;
    try {
      new SelfCommands().recent("0", true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ARG_INVALID", exitCode: 1, publicMessage: true });
    expect((failure as Error).message).toContain("Invalid --limit: 0");
  });
});

describe("self read-only operations", () => {
  beforeEach(() => {
    clearActorEnv();
    seedLinkedContext();
  });

  afterEach(() => {
    restoreActorEnv();
    inlineContext = undefined;
  });

  it("chat returns the typed binding, canonical chat and full participants", () => {
    const { result } = captureConsole(() => new SelfCommands().chat("full", true));
    expect(result).toMatchObject({ status: "ok", data: { binding: { chatId: "chat_123" } } });
    expect(result.data?.participants).toHaveLength(1);
    expect(() => selfChatReturnSchema.parse(result)).not.toThrow();
  });

  it("route returns the bound route provenance", () => {
    const { result } = captureConsole(() => new SelfCommands().route(true));
    expect(result).toMatchObject({ status: "ok", data: { boundRoute: { id: 7, pattern: "group:120363" } } });
    expect(() => selfRouteReturnSchema.parse(result)).not.toThrow();
  });

  it("permissions returns the same context capability facts and rollups", () => {
    const { result } = captureConsole(() => new SelfCommands().permissions(true));
    expect(result).toMatchObject({
      status: "ok",
      data: { count: 2, byPermission: { execute: 1, use: 1 }, byObjectType: { group: 1, tool: 1 } },
    });
    expect(() => selfPermissionsReturnSchema.parse(result)).not.toThrow();
  });

  it("knowledge reports an honest typed unavailable fallback", () => {
    const { result } = captureConsole(() => new SelfCommands().knowledge(true));
    expect(result).toMatchObject({
      status: "unavailable",
      data: { status: "not_implemented", expectedCommandFamily: "ravi knowledge" },
    });
    expect(() => selfKnowledgeReturnSchema.parse(result)).not.toThrow();
  });

  it("explain exposes resolution provenance and env-sourced actor trust", () => {
    process.env.RAVI_CONTACT_ID = "contact_private_value";
    const { output, result } = captureConsole(() => new SelfCommands().explain(true));

    expect(result.explain.map((step) => step.step)).toContain("environment_contract");
    expect(output).toContain("RAVI_CONTACT_ID");
    expect(output).toContain("contact_private_value");
    expect(output).toContain("unverified");
    expect(() => selfExplainReturnSchema.parse(result)).not.toThrow();
  });

  it("prefers an env-sourced actor over recent messages and marks it unverified", () => {
    process.env.RAVI_ACTOR_TYPE = "contact";
    process.env.RAVI_CONTACT_ID = "contact_env";

    const { result } = captureConsole(() => new SelfCommands().whoami(true));
    expect(result.actor).toMatchObject({
      status: "partial",
      reason: "actor values came from process environment and are unverified",
      data: { contactId: "contact_env", source: "environment", trust: "unverified" },
    });
  });

  it("prefers authoritative context metadata over env and recent messages", () => {
    process.env.RAVI_ACTOR_TYPE = "contact";
    process.env.RAVI_CONTACT_ID = "contact_env";
    inlineContext = fakeContext({
      metadata: {
        actor: { actorType: "contact", contactId: "contact_context" },
      },
    });

    const { result } = captureConsole(() => new SelfCommands().whoami(true));
    expect(result.actor).toMatchObject({
      status: "ok",
      data: {
        contactId: "contact_context",
        source: "context_metadata",
        trust: "authoritative",
      },
    });
  });

  it("validates the concrete return schema for every operation", () => {
    const commands = new SelfCommands();
    const cases: Array<{ schema: { parse(value: unknown): unknown }; operation: () => unknown }> = [
      { schema: selfWhoamiReturnSchema, operation: () => commands.whoami(true) },
      { schema: selfContextReturnSchema, operation: () => commands.context("full", "2", true) },
      { schema: selfChatReturnSchema, operation: () => commands.chat("full", true) },
      { schema: selfRouteReturnSchema, operation: () => commands.route(true) },
      { schema: selfRecentReturnSchema, operation: () => commands.recent("2", true) },
      { schema: selfPermissionsReturnSchema, operation: () => commands.permissions(true) },
      { schema: selfKnowledgeReturnSchema, operation: () => commands.knowledge(true) },
      { schema: selfExplainReturnSchema, operation: () => commands.explain(true) },
    ];

    for (const { schema, operation } of cases) {
      const { result } = captureConsole(operation);
      expect(() => schema.parse(result)).not.toThrow();
    }
  });

  it("validates a compact context projection against the public return schema", () => {
    const { result } = captureConsole(() => new SelfCommands().context(undefined, undefined, true, "identity,session"));

    expect(Object.keys(result).sort()).toEqual(["identity", "session"]);
    expect(() => selfContextReturnSchema.parse(result)).not.toThrow();
  });

  it("declares all operations as reads and imports no write surface", () => {
    const access = getCommandAccessMetadata(SelfCommands);
    expect([...access.values()]).toHaveLength(8);
    expect([...access.values()].every((entry) => entry.kind === "read")).toBe(true);
    expect([...access.values()].every((entry) => entry.effectClass === "none" && entry.audit === "none")).toBe(true);

    const source = readFileSync(new URL("./self.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bdb(?:Create|Insert|Update|Delete|Upsert|Set|Revoke|Remove|Add)/);
    expect(source).not.toMatch(/\bnats\.(?:emit|publish|request)/);
    expect(source).not.toMatch(/\b(?:resolveSession|dbGetChat|dbGetRouteById|dbGetSessionChatBinding)\b/);
  });

  it("publishes the env, degradation, schema and exit contracts in group help", () => {
    const help = getGroupMetadata(SelfCommands)?.helpAfter ?? "";
    expect(help).toContain("RAVI_ACTOR_TYPE");
    expect(help).toContain("USAGE_ERROR");
    expect(help).toContain("ARG_INVALID");
    expect(help).toContain("partial, missing, unavailable");
    expect(help).toContain("sdk returns show self.<command>");
    expect(help).not.toContain("contact_env");
  });
});

describe("self human output", () => {
  beforeEach(() => {
    clearActorEnv();
    seedLinkedContext();
  });

  afterEach(() => {
    restoreActorEnv();
    inlineContext = undefined;
  });

  it("renders actor, chat and route only once in the full context view", () => {
    const { output } = captureConsole(() => new SelfCommands().context("normal", "2", false));
    expect(output.match(/^Actor:/gm)).toHaveLength(1);
    expect(output.match(/^Chat:/gm)).toHaveLength(1);
    expect(output.match(/^Route:/gm)).toHaveLength(1);
  });
});

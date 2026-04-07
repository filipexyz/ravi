import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let resolvedContext:
  | {
      contextId: string;
      kind: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      metadata?: Record<string, unknown>;
      createdAt: number;
      expiresAt?: number;
      lastUsedAt?: number;
      revokedAt?: number;
    }
  | undefined;
let inlineContext:
  | {
      contextId: string;
      kind: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      metadata?: Record<string, unknown>;
      createdAt: number;
      expiresAt?: number;
      lastUsedAt?: number;
      revokedAt?: number;
    }
  | undefined;
let authorizeResult:
  | {
      allowed: boolean;
      approved: boolean;
      inherited: boolean;
      reason?: string;
      context: {
        contextId: string;
        agentId?: string;
        capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      };
    }
  | undefined;
let issuedContext:
  | {
      contextId: string;
      contextKey: string;
      kind: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      metadata?: Record<string, unknown>;
      createdAt: number;
      expiresAt?: number;
    }
  | undefined;
let listedContexts: Array<{
  contextId: string;
  contextKey: string;
  kind: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: { channel: string; accountId: string; chatId: string };
  capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}> = [];
let fetchedContext:
  | {
      contextId: string;
      contextKey: string;
      kind: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      metadata?: Record<string, unknown>;
      createdAt: number;
      expiresAt?: number;
      lastUsedAt?: number;
      revokedAt?: number;
    }
  | undefined;
let revokedContext:
  | {
      contextId: string;
      contextKey: string;
      kind: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: Array<{ permission: string; objectType: string; objectId: string }>;
      metadata?: Record<string, unknown>;
      createdAt: number;
      expiresAt?: number;
      lastUsedAt?: number;
      revokedAt?: number;
    }
  | undefined;

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
  getContext: () => (inlineContext ? { context: inlineContext } : undefined),
}));

mock.module("../../runtime/context-registry.js", () => ({
  RAVI_CONTEXT_KEY_ENV: "RAVI_CONTEXT_KEY",
  resolveRuntimeContextOrThrow: () => {
    if (!resolvedContext) {
      throw new Error("Context not found");
    }
    return resolvedContext;
  },
  issueRuntimeContext: (_input: unknown) =>
    issuedContext ?? {
      contextId: "ctx_child_123",
      contextKey: "rctx_child_123",
      kind: "cli-runtime",
      agentId: resolvedContext?.agentId,
      sessionKey: resolvedContext?.sessionKey,
      sessionName: resolvedContext?.sessionName,
      source: resolvedContext?.source,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      metadata: {
        parentContextId: resolvedContext?.contextId ?? "ctx_123",
        issuedFor: "sync-cli",
      },
      createdAt: 3000,
      expiresAt: 4000,
    },
  revokeRuntimeContext: (_contextId: string) =>
    revokedContext ?? {
      ...(fetchedContext ??
        resolvedContext ?? {
          contextId: "ctx_123",
          contextKey: "rctx_123",
          kind: "agent-runtime",
          capabilities: [],
          createdAt: 1000,
        }),
      revokedAt: 5000,
    },
}));

mock.module("../../router/router-db.js", () => ({
  dbGetContext: (contextId: string) => {
    if (fetchedContext?.contextId === contextId) return fetchedContext;
    return listedContexts.find((context) => context.contextId === contextId) ?? null;
  },
  dbListContexts: () => listedContexts,
}));

mock.module("../../permissions/engine.js", () => ({
  canWithCapabilities: (
    capabilities: Array<{ permission: string; objectType: string; objectId: string }>,
    permission: string,
    objectType: string,
    objectId: string,
  ) =>
    capabilities.some(
      (cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === objectId,
    ),
}));

mock.module("../../approval/service.js", () => ({
  authorizeRuntimeContext: async () =>
    authorizeResult ?? {
      allowed: true,
      approved: true,
      inherited: false,
      context: {
        contextId: resolvedContext?.contextId ?? "ctx_123",
        agentId: resolvedContext?.agentId,
        capabilities: [
          ...(resolvedContext?.capabilities ?? []),
          { permission: "execute", objectType: "group", objectId: "daemon" },
        ],
      },
    },
}));

const { ContextCommands } = await import("./context.js");

describe("ContextCommands", () => {
  const originalKey = process.env.RAVI_CONTEXT_KEY;

  beforeEach(() => {
    process.env.RAVI_CONTEXT_KEY = "rctx_test_123";
    inlineContext = undefined;
    authorizeResult = undefined;
    issuedContext = undefined;
    resolvedContext = {
      contextId: "ctx_123",
      contextKey: "rctx_parent_123",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511999999999" },
      capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
      metadata: { runtimeProvider: "codex" },
      createdAt: 1000,
      expiresAt: 2000,
      lastUsedAt: 1500,
    };
    fetchedContext = resolvedContext;
    listedContexts = [resolvedContext];
    revokedContext = undefined;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.RAVI_CONTEXT_KEY;
    } else {
      process.env.RAVI_CONTEXT_KEY = originalKey;
    }
    resolvedContext = undefined;
    inlineContext = undefined;
    authorizeResult = undefined;
    issuedContext = undefined;
    fetchedContext = undefined;
    listedContexts = [];
    revokedContext = undefined;
  });

  it("lists contexts with visible lineage and no context key", () => {
    listedContexts = [
      resolvedContext!,
      {
        contextId: "ctx_child_123",
        contextKey: "rctx_child_123",
        kind: "cli-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "dev-main",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
        metadata: {
          parentContextId: "ctx_123",
          parentContextKind: "agent-runtime",
          issuedFor: "sync-cli",
          issuedAt: 3000,
          issuanceMode: "explicit",
        },
        createdAt: 3000,
      },
    ];

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.list(undefined, undefined, undefined, false);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload.count).toBe(2);
    expect(payload.contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextId: "ctx_child_123",
          parentContextId: "ctx_123",
          issuedFor: "sync-cli",
          issuanceMode: "explicit",
          status: "active",
        }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("rctx_child_123");
  });

  it("shows context info with lineage, source and capabilities", () => {
    fetchedContext = {
      contextId: "ctx_child_123",
      contextKey: "rctx_child_123",
      kind: "cli-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511999999999" },
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      metadata: {
        parentContextId: "ctx_123",
        parentContextKind: "agent-runtime",
        issuedFor: "sync-cli",
        issuedAt: 3000,
        issuanceMode: "explicit",
      },
      createdAt: 3000,
    };

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.info("ctx_child_123");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      contextId: "ctx_child_123",
      kind: "cli-runtime",
      status: "active",
      capabilitiesCount: 1,
      source: { channel: "whatsapp", accountId: "main", chatId: "5511999999999" },
      lineage: {
        parentContextId: "ctx_123",
        issuedFor: "sync-cli",
        issuanceMode: "explicit",
      },
    });
    expect(payload.capabilities).toEqual([{ permission: "execute", objectType: "group", objectId: "daemon" }]);
    expect(JSON.stringify(payload)).not.toContain("rctx_child_123");
  });

  it("prints whoami as JSON from the resolved runtime context", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.whoami();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      contextId: "ctx_123",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
      capabilitiesCount: 1,
    });
  });

  it("prints capabilities as JSON from the resolved runtime context", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.capabilities();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload.capabilities).toEqual([{ permission: "execute", objectType: "group", objectId: "context" }]);
  });

  it("checks permissions against the current runtime context capabilities", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.check("execute", "group", "context");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      permission: "execute",
      objectType: "group",
      objectId: "context",
      allowed: true,
      capabilitiesCount: 1,
    });
  });

  it("authorizes a new capability and prints the updated context state", async () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      await command.authorize("execute", "group", "daemon");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      allowed: true,
      approved: true,
      inherited: false,
      capabilitiesCount: 2,
    });
  });

  it("issues a least-privilege child context for an external CLI", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.issue("sync-cli", "execute:group:daemon,access:session:agent:dev:main", "2h", false);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      contextId: "ctx_child_123",
      contextKey: "rctx_child_123",
      kind: "cli-runtime",
      cliName: "sync-cli",
      parentContextId: "ctx_123",
      capabilitiesCount: 1,
    });
    expect(payload.env).toEqual({ RAVI_CONTEXT_KEY: "rctx_child_123" });
  });

  it("revokes a context and prints the updated state", () => {
    revokedContext = {
      ...(fetchedContext ?? resolvedContext!),
      revokedAt: 5000,
    };

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.revoke("ctx_123");
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      contextId: "ctx_123",
      status: "revoked",
      revokedAt: 5000,
    });
  });

  it("fails on malformed capability specs", () => {
    const command = new ContextCommands();
    expect(() => command.issue("sync-cli", "execute:group", undefined, false)).toThrow(
      'Invalid capability format: "execute:group"',
    );
  });

  it("fails when the context key env var is missing", () => {
    delete process.env.RAVI_CONTEXT_KEY;
    const command = new ContextCommands();
    expect(() => command.whoami()).toThrow("Missing RAVI_CONTEXT_KEY");
  });

  it("uses the in-process tool context when available", () => {
    inlineContext = {
      contextId: "ctx_inline",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:inline",
      sessionName: "dev-inline",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
      metadata: { origin: "tool-context" },
      createdAt: 2000,
    };
    delete process.env.RAVI_CONTEXT_KEY;

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.whoami();
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      contextId: "ctx_inline",
      sessionKey: "agent:dev:inline",
      sessionName: "dev-inline",
      capabilitiesCount: 1,
    });
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualRuntimeContextRegistryModule = await import("../../runtime/context-registry.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualNatsModule = await import("../../nats.js");
const actualCliContextModule = await import("../context.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");

let publishedAuditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
let resolvedContext:
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
let inlineContext:
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
let resolvedContextOptions: { touch?: boolean; readOnly?: boolean } | undefined;
let revokedCalls: Array<{ contextId: string; options?: unknown }> = [];
let listedSessions: Array<{ sessionKey: string }> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

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
  resolveRuntimeContextOrThrow: (_contextKey: string, options?: { touch?: boolean; readOnly?: boolean }) => {
    resolvedContextOptions = options;
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
  revokeRuntimeContext: (_contextId: string, _options?: unknown) => {
    revokedCalls.push({ contextId: _contextId, options: _options });
    const matchingContext = listedContexts.find((context) => context.contextId === _contextId);
    const root =
      revokedContext ??
      ({
        ...(fetchedContext ??
          matchingContext ??
          resolvedContext ?? {
            contextId: "ctx_123",
            contextKey: "rctx_123",
            kind: "agent-runtime",
            capabilities: [],
            createdAt: 1000,
          }),
        revokedAt: 5000,
      } as Record<string, unknown>);
    return { context: root, cascaded: [], revokedAt: 5000 };
  },
  getContextLineage: (_contextId: string) => null,
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbGetContext: (contextId: string) => {
    if (fetchedContext?.contextId === contextId) return fetchedContext;
    return listedContexts.find((context) => context.contextId === contextId) ?? null;
  },
  dbListContexts: () => listedContexts,
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  listSessions: () => listedSessions,
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

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: async (topic: string, data: Record<string, unknown>) => {
    publishedAuditEvents.push({ topic, data });
  },
}));

const { ContextCommands } = await import("./context.js");

function callCodexBashHook(payload: Record<string, unknown>): Record<string, unknown> {
  return (new ContextCommands() as any).handleCodexBashHook(payload);
}

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
    resolvedContextOptions = undefined;
    revokedCalls = [];
    listedSessions = [{ sessionKey: "agent:dev:main" }];
    publishedAuditEvents = [];
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
    resolvedContextOptions = undefined;
    revokedCalls = [];
    listedSessions = [];
    publishedAuditEvents = [];
  });

  it("lists contexts with visible lineage and no context key in --json mode", () => {
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
      command.list(undefined, undefined, undefined, false, true);
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

  it("lists contexts in a human-readable summary by default", () => {
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
          issuanceMode: "explicit",
          issuedFor: "sync-cli",
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
      command.list(undefined, undefined, undefined, false, false);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("Contexts (2)");
    expect(output).toContain("- ctx_child_123 :: active :: cli-runtime :: caps=1");
    expect(output).toContain("lineage=parent=ctx_123 issuedFor=sync-cli mode=explicit");
    expect(output).not.toContain("rctx_child_123");
  });

  it("dry-runs stale agent-runtime cleanup without exposing context keys", () => {
    listedSessions = [{ sessionKey: "agent:dev:main" }];
    listedContexts = [
      {
        contextId: "ctx_old",
        contextKey: "rctx_old",
        kind: "agent-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "dev-main",
        capabilities: [],
        createdAt: 1000,
        lastUsedAt: Date.now() - 3_600_001,
      },
      {
        contextId: "ctx_fresh",
        contextKey: "rctx_fresh",
        kind: "agent-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "dev-main",
        capabilities: [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      },
      {
        contextId: "ctx_cli",
        contextKey: "rctx_cli",
        kind: "cli-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "dev-main",
        capabilities: [],
        createdAt: 1000,
        lastUsedAt: 1000,
      },
    ];

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.cleanupAgentRuntime("1h", undefined, undefined, undefined, false, true);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      dryRun: true,
      candidatesCount: 1,
      revokedCount: 0,
    });
    expect(payload.candidates[0]).toMatchObject({
      context: { contextId: "ctx_old", kind: "agent-runtime" },
      sessionExists: true,
    });
    expect(JSON.stringify(payload)).not.toContain("rctx_old");
    expect(revokedCalls).toEqual([]);
  });

  it("revokes stale agent-runtime cleanup candidates only when --revoke is set", () => {
    listedSessions = [];
    listedContexts = [
      {
        contextId: "ctx_old",
        contextKey: "rctx_old",
        kind: "agent-runtime",
        agentId: "dev",
        sessionKey: "agent:dev:old",
        sessionName: "dev-old",
        capabilities: [],
        createdAt: 1000,
        lastUsedAt: Date.now() - 3_600_001,
      },
      {
        contextId: "ctx_other_agent",
        contextKey: "rctx_other_agent",
        kind: "agent-runtime",
        agentId: "main",
        sessionKey: "agent:main:old",
        sessionName: "main-old",
        capabilities: [],
        createdAt: 1000,
        lastUsedAt: Date.now() - 3_600_001,
      },
    ];

    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.cleanupAgentRuntime("1h", "dev", undefined, "test_cleanup", true, true);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      dryRun: false,
      reason: "test_cleanup",
      candidatesCount: 1,
      revokedCount: 1,
    });
    expect(revokedCalls).toEqual([{ contextId: "ctx_old", options: { reason: "test_cleanup" } }]);
  });

  it("shows context info with lineage, source and capabilities in --json mode", () => {
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
      command.info("ctx_child_123", true);
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
      command.whoami(true);
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

  it("prints a human-readable current context by default", () => {
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

    const output = lines.join("\n");
    expect(output).toContain("Current Context: ctx_123");
    expect(output).toContain("Capabilities (1)");
    expect(output).toContain("execute:group:context");
  });

  it("prints capabilities as JSON from the resolved runtime context", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.capabilities(true);
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
      command.check("execute", "group", "context", true);
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
      await command.authorize("execute", "group", "daemon", true);
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

  it("issues a least-privilege child context for an external CLI in --json mode", () => {
    const command = new ContextCommands();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      command.issue("sync-cli", "execute:group:daemon,access:session:agent:dev:main", "2h", false, true);
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

  it("prints the child context export instructions by default", () => {
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

    const output = lines.join("\n");
    expect(output).toContain("Issued Context: ctx_child_123");
    expect(output).toContain("Capabilities (1)");
    expect(output).toContain("RAVI_CONTEXT_KEY=rctx_child_123");
  });

  it("revokes a context and prints the updated state in --json mode", () => {
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
      command.revoke("ctx_123", true, undefined, true);
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload).toMatchObject({
      context: {
        contextId: "ctx_123",
        status: "revoked",
        revokedAt: 5000,
      },
      cascaded: [],
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
      contextKey: "rctx_inline",
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
      command.whoami(true);
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

  describe("codex-bash-hook", () => {
    beforeEach(() => {
      resolvedContext = {
        contextId: "ctx_codex",
        contextKey: "rctx_codex",
        kind: "agent-runtime",
        agentId: "codex",
        sessionKey: "agent:codex:main",
        sessionName: "codex-main",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
        metadata: { runtimeProvider: "codex" },
        createdAt: 1000,
      };
      fetchedContext = resolvedContext;
      listedContexts = [resolvedContext];
    });

    it("resolves context without touching the DB from the Bash hook path", () => {
      const result = callCodexBashHook({
        tool_input: {
          command: "ravi context whoami",
        },
      });

      expect(result).toEqual({});
      expect(resolvedContextOptions).toEqual({ touch: false, readOnly: true });
    });

    it("publishes executable deny audit events for git status", () => {
      const result = callCodexBashHook({
        tool_input: {
          command: "git status",
        },
      });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Permission denied: agent:codex cannot execute: git",
        },
      });
      expect(publishedAuditEvents).toEqual([
        {
          topic: "ravi.audit.denied",
          data: {
            type: "executable",
            agentId: "codex",
            denied: "git",
            reason: "Permission denied: agent:codex cannot execute: git",
            detail: "git status",
          },
        },
      ]);
    });

    it("publishes env spoofing audit events", () => {
      const result = callCodexBashHook({
        tool_input: {
          command: "RAVI_AGENT_ID=main ravi sessions list",
        },
      });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "Cannot override RAVI environment variables",
        },
      });
      expect(publishedAuditEvents).toEqual([
        {
          topic: "ravi.audit.denied",
          data: {
            type: "env_spoofing",
            agentId: "codex",
            denied: "RAVI_* override",
            reason: "Cannot override RAVI environment variables",
            detail: "RAVI_AGENT_ID=main ravi sessions list",
          },
        },
      ]);
    });

    it("publishes session scope audit events", () => {
      const result = callCodexBashHook({
        tool_input: {
          command: "ravi sessions send main 'hello'",
        },
      });

      expect(result).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "Permission denied: agent:codex cannot access session:main",
        },
      });
      expect(publishedAuditEvents).toEqual([
        {
          topic: "ravi.audit.denied",
          data: {
            type: "session_scope",
            agentId: "codex",
            denied: "main",
            reason: "Permission denied: agent:codex cannot access session:main",
            detail: "ravi sessions send main 'hello'",
          },
        },
      ]);
    });
  });
});

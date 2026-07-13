import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const actualCliContextModule = await import("../context.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");

type AgentLike = {
  id: string;
  cwd: string;
  model?: string | null;
  modelPresetId?: string | null;
  effort?: string;
  provider?: string;
  remote?: string;
  defaults?: Record<string, unknown> | null;
};

type SessionLike = {
  sessionKey: string;
  name?: string;
  agentId: string;
  agentCwd: string;
  providerSessionId?: string | null;
  sdkSessionId?: string | null;
  runtimeProvider?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  thinkingLevel?: "off" | "normal" | "verbose" | null;
  lastChannel?: string | null;
  lastTo?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  compactionCount?: number | null;
  createdAt: number;
  updatedAt: number;
};

let currentAgent: AgentLike | null = null;
let allAgents: AgentLike[] = [];
let createAgentCalls: Array<Record<string, unknown>> = [];
let updateAgentCalls: Array<{ id: string; partial: Record<string, unknown> }> = [];
let resolvedSession: SessionLike | null = null;
let mainSession: SessionLike | null = null;
let sessionsByAgent: SessionLike[] = [];
let transcriptPath: string | null = null;
const instructionStates = new Map<string, string>();
const sessionTurnUsageSummaries = new Map<string, Record<string, unknown>>();

function defaultTurnUsageSummary(): Record<string, unknown> {
  return {
    lastTurn: null,
    recent: {
      windowMs: 86_400_000,
      completeTurns: 0,
      inputTokensAvg: 0,
      outputTokensAvg: 0,
      effectiveContextTokensAvg: 0,
      effectiveContextTokensMax: 0,
      durationMsAvg: null,
      costUsdTotal: 0,
    },
  };
}

beforeEach(() => {
  sessionTurnUsageSummaries.clear();
});

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  canAccessResource: () => true,
  filterVisibleAgents: <T>(_: unknown, agents: T[]) => agents,
  canViewAgent: () => true,
  canWriteContacts: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../../router/config.js", () => ({
  getRaviDir: () => "/tmp/ravi",
  getAgent: (id: string) => (currentAgent?.id === id ? currentAgent : null),
  getAllAgents: () => allAgents,
  createAgent: (input: Record<string, unknown>) => {
    createAgentCalls.push(input);
    currentAgent = input as AgentLike;
    return input;
  },
  updateAgent: (id: string, partial: Record<string, unknown>) => {
    updateAgentCalls.push({ id, partial });
    if (currentAgent?.id === id) {
      currentAgent = { ...currentAgent, ...partial };
    }
  },
  deleteAgent: () => false,
  setAgentDebounce: () => {},
  checkAgentDirs: () => [],
  ensureAgentDirs: () => {},
  loadRouterConfig: () => ({ defaultAgent: "main" }),
  setAgentSpecMode: () => {},
}));

mock.module("../../runtime/agent-instructions.js", () => ({
  ensureAgentInstructionFiles: (cwd: string, options?: { createAgentsStub?: string }) => {
    const current = instructionStates.get(cwd) ?? "missing-both";
    if (current === "missing-both" && options?.createAgentsStub) {
      instructionStates.set(cwd, "agents-canonical");
      return {
        createdClaude: true,
        createdAgents: true,
        updatedClaude: false,
        updatedAgents: false,
      };
    }
    if (
      current === "legacy-claude-canonical" ||
      current === "claude-only" ||
      current === "agents-only" ||
      current === "agents-bridge-only" ||
      current === "duplicated-custom"
    ) {
      instructionStates.set(cwd, "agents-canonical");
      return {
        createdClaude: false,
        createdAgents: false,
        updatedClaude: true,
        updatedAgents: true,
      };
    }
    return {
      createdClaude: false,
      createdAgents: false,
      updatedClaude: false,
      updatedAgents: false,
    };
  },
  inspectAgentInstructionFiles: (cwd: string) => ({
    state: instructionStates.get(cwd) ?? "missing-both",
    agents: null,
    claude: null,
  }),
  loadAgentWorkspaceInstructions: () => null,
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  DmScopeSchema: { safeParse: () => ({ success: true }), options: [] },
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  deleteSession: () => true,
  getSessionTurnUsageSummary: (sessionKey: string) =>
    sessionTurnUsageSummaries.get(sessionKey) ?? defaultTurnUsageSummary(),
  getSessionsByAgent: () => sessionsByAgent,
  getMainSession: () => mainSession,
  resolveSession: () => resolvedSession,
}));

mock.module("../../tags/helpers.js", () => ({
  canonicalAssetIdsForTag: () => undefined,
  filterItemsByCanonicalTag: <T>(items: T[]) => items,
}));

mock.module("../../tags/service.js", () => ({
  searchTagBindingsForSelector: () => ({
    bindings: [],
  }),
}));

mock.module("../../transcripts.js", () => ({
  locateRuntimeTranscript: () => (transcriptPath ? { path: transcriptPath } : { path: null, reason: "missing" }),
}));

type PresetLike = { id: string; provider: string; model: string; enabled: boolean; version: number };
let presetsById: Record<string, PresetLike> = {};

mock.module("../../runtime/model-preset-store.js", () => ({
  getRuntimeModelPreset: (id: string) => presetsById[id.trim().toLowerCase()] ?? null,
}));

const { AgentsCommands } = await import("./agents.js");
const { agentSetReturnSchema } = await import("./operational-return-schemas.js");

describe("AgentsCommands set model validation", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", provider: "pi" };
    allAgents = [];
    createAgentCalls = [];
    updateAgentCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
    sessionTurnUsageSummaries.clear();
    instructionStates.clear();
  });

  it("rejects Pi provider ids used as model selectors", async () => {
    const commands = new AgentsCommands();

    await expect(commands.set("dev", "model", "kimi-coding", true)).rejects.toThrow(
      "Invalid Pi model selector: 'kimi-coding' is a provider id",
    );

    expect(updateAgentCalls).toHaveLength(0);
  });

  it("rejects switching to Pi when the existing model selector is provider-only", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", model: "kimi-coding" };
    const commands = new AgentsCommands();

    await expect(commands.set("dev", "provider", "pi", true)).rejects.toThrow(
      "Invalid Pi model selector: 'kimi-coding' is a provider id",
    );

    expect(updateAgentCalls).toHaveLength(0);
  });

  it("accepts Pi provider/model selectors", async () => {
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      await commands.set("dev", "model", "kimi-coding/kimi-for-coding", true);
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: {
          model: "kimi-coding/kimi-for-coding",
        },
      },
    ]);
  });

  it("sets canonical reasoning effort on the agent default", async () => {
    const commands = new AgentsCommands();

    await commands.set("dev", "effort", "Ultra", true);

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: {
          effort: "ultra",
        },
      },
    ]);
    expect(currentAgent?.effort).toBe("ultra");
  });

  it("clears agent reasoning effort", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", provider: "pi", effort: "ultra" };
    const commands = new AgentsCommands();

    await commands.set("dev", "effort", "clear", true);

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: {
          effort: undefined,
        },
      },
    ]);
  });

  it("rejects invalid agent reasoning effort values", async () => {
    const commands = new AgentsCommands();

    await expect(commands.set("dev", "effort", "turbo", true)).rejects.toThrow("Invalid effort: turbo");
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("creates agents with provider and model in one mutation", async () => {
    currentAgent = null;
    const commands = new AgentsCommands();

    const payload = await commands.create("dev", "/tmp/dev", "codex", "gpt-5.5", true, true);

    expect(createAgentCalls).toEqual([{ id: "dev", cwd: "/tmp/dev", provider: "codex", model: "gpt-5.5" }]);
    expect(payload?.agent).toMatchObject({
      id: "dev",
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("validates model when creating an agent", async () => {
    currentAgent = null;
    const commands = new AgentsCommands();

    expect(() => commands.create("dev", "/tmp/dev", "pi", "kimi-coding", true, true)).toThrow(
      "Invalid Pi model selector: 'kimi-coding' is a provider id",
    );

    expect(createAgentCalls).toHaveLength(0);
  });
});

describe("AgentsCommands set session override reporting", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", provider: "codex", model: "gpt-5.5" };
    allAgents = [];
    createAgentCalls = [];
    updateAgentCalls = [];
    sessionsByAgent = [];
  });

  it("returns every active session override by canonical session name in JSON", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:raw-channel-829a",
        name: "zeta-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: "gpt-5.6",
        effortOverride: "high",
        thinkingLevel: "verbose",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionKey: "agent:dev:another-raw-channel",
        name: "alpha-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: null,
        effortOverride: "max",
        thinkingLevel: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionKey: "agent:dev:no-overrides",
        name: "idle-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: null,
        effortOverride: null,
        thinkingLevel: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));

    try {
      const payload = await commands.set("dev", "model", "gpt-5.6", true);

      expect(payload).toMatchObject({
        changed: true,
        sessionOverrides: [
          { sessionName: "alpha-session", effort: "max" },
          {
            sessionName: "zeta-session",
            model: "gpt-5.6",
            effort: "high",
            thinking: "verbose",
          },
        ],
      });
      expect(Object.keys(payload?.sessionOverrides[0] ?? {})).toEqual(["sessionName", "effort"]);
      expect(agentSetReturnSchema.safeParse(payload).success).toBe(true);
      expect(logCalls.join("\n")).not.toContain("raw-channel");
    } finally {
      console.log = originalLog;
    }
  });

  it("reports changed=false while preserving current session overrides for an idempotent set", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:main",
        name: "dev-main",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        thinkingLevel: "off",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      const payload = await commands.set("dev", "model", "gpt-5.5", true);

      expect(payload).toMatchObject({
        changed: false,
        sessionOverrides: [{ sessionName: "dev-main", thinking: "off" }],
      });
    } finally {
      console.log = originalLog;
    }
  });

  it("prints a concise human warning with all active fields across sessions", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:raw-bravo",
        name: "bravo-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: "gpt-5.5",
        thinkingLevel: "verbose",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionKey: "agent:dev:raw-alpha",
        name: "alpha-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        effortOverride: "max",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionKey: "agent:dev:raw-idle",
        name: "idle-session",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: null,
        effortOverride: null,
        thinkingLevel: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));

    try {
      await commands.set("dev", "model", "gpt-5.6", false);

      expect(logCalls).toEqual([
        "\u2713 model set: dev -> gpt-5.6",
        "Warning: 2 sessions have runtime overrides:",
        "  - alpha-session: effort=max",
        "  - bravo-session: model=gpt-5.5, thinking=verbose",
      ]);
      expect(logCalls.join("\n")).not.toContain("raw-");
    } finally {
      console.log = originalLog;
    }
  });

  it("confirms the absence of overrides without a warning on an idempotent human mutation", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:main",
        name: "dev-main",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        modelOverride: null,
        effortOverride: null,
        thinkingLevel: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));

    try {
      await commands.set("dev", "model", "gpt-5.5", false);

      expect(logCalls).toEqual(["\u2713 model unchanged: dev -> gpt-5.5", "  Session overrides: none"]);
      expect(logCalls.some((line) => line.startsWith("Warning:"))).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("AgentsCommands model preset mutations", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    createAgentCalls = [];
    updateAgentCalls = [];
    presetsById = {
      "fast-sonnet": { id: "fast-sonnet", provider: "anthropic", model: "sonnet", enabled: true, version: 3 },
      "off-preset": { id: "off-preset", provider: "anthropic", model: "sonnet", enabled: false, version: 1 },
    };
  });

  it("assigns a preset and clears any direct model atomically", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", model: "haiku" };
    const commands = new AgentsCommands();

    await commands.set("dev", "modelPreset", "fast-sonnet", true);

    expect(updateAgentCalls).toEqual([{ id: "dev", partial: { modelPresetId: "fast-sonnet", model: null } }]);
  });

  it("clears a preset reference", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", modelPresetId: "fast-sonnet" };
    const commands = new AgentsCommands();

    await commands.set("dev", "modelPreset", "clear", true);

    expect(updateAgentCalls).toEqual([{ id: "dev", partial: { modelPresetId: null } }]);
  });

  it("clears the preset when a direct model is written", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", modelPresetId: "fast-sonnet" };
    const commands = new AgentsCommands();

    await commands.set("dev", "model", "sonnet", true);

    expect(updateAgentCalls).toEqual([{ id: "dev", partial: { model: "sonnet", modelPresetId: null } }]);
  });

  it("rejects assigning a disabled preset", async () => {
    const commands = new AgentsCommands();
    await expect(commands.set("dev", "modelPreset", "off-preset", true)).rejects.toThrow(/disabled/);
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("rejects assigning a missing preset", async () => {
    const commands = new AgentsCommands();
    await expect(commands.set("dev", "modelPreset", "ghost", true)).rejects.toThrow(/not found/);
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("rejects a provider write incompatible with the referenced preset", async () => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", modelPresetId: "fast-sonnet" };
    const commands = new AgentsCommands();
    await expect(commands.set("dev", "provider", "codex", true)).rejects.toThrow(/incompatible|references preset/);
    expect(updateAgentCalls).toHaveLength(0);
  });
});

describe("AgentsCommands permissions", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    allAgents = [];
    createAgentCalls = [];
    updateAgentCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
    sessionTurnUsageSummaries.clear();
    instructionStates.clear();
  });

  it("sets a provider-runtime full-access profile on agent defaults", () => {
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const payload = commands.permissions("dev", "full-access", undefined, true);

      expect(payload).toMatchObject({
        action: "permissions",
        changed: true,
        agentId: "dev",
        after: { profile: "full-access" },
        defaults: { runtimePermissions: { profile: "full-access" } },
      });
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: {
          defaults: { runtimePermissions: { profile: "full-access" } },
        },
      },
    ]);
  });

  it("can show the current provider-runtime permission profile without mutating", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: { runtimePermissions: { profile: "full-access" } },
    };
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const payload = commands.permissions("dev", undefined, undefined, true);

      expect(payload).toMatchObject({
        action: "permissions",
        changed: false,
        agentId: "dev",
        profile: "full-access",
        runtimePermissions: { profile: "full-access" },
      });
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([]);
  });

  it("clears provider-runtime permissions from agent defaults", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: { runtimePermissions: { profile: "full-access" } },
    };
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const payload = commands.permissions("dev", "none", undefined, true);

      expect(payload).toMatchObject({
        action: "permissions",
        changed: true,
        agentId: "dev",
        before: { profile: "full-access" },
        after: null,
        defaults: null,
      });
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: { defaults: null },
      },
    ]);
  });

  it("clears explicit runtime capabilities while preserving profile", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: {
        runtimePermissions: {
          profile: "bootstrap",
          capabilities: ["execute:executable:omni"],
        },
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      const payload = commands.permissions("dev", undefined, undefined, true, true);

      expect(payload).toMatchObject({
        action: "permissions",
        changed: true,
        agentId: "dev",
        before: {
          profile: "bootstrap",
          capabilities: [{ permission: "execute", objectType: "executable" }],
        },
        after: { profile: "bootstrap" },
        defaults: { runtimePermissions: { profile: "bootstrap" } },
      });
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: { defaults: { runtimePermissions: { profile: "bootstrap" } } },
      },
    ]);
  });

  it("rejects combining explicit runtime capabilities with clear-capabilities", () => {
    const commands = new AgentsCommands();

    expect(() => commands.permissions("dev", undefined, "execute:executable:omni", true, true)).toThrow(
      "Use either --capabilities or --clear-capabilities, not both",
    );
    expect(updateAgentCalls).toEqual([]);
  });

  it("rejects unknown runtime permission profiles", () => {
    const commands = new AgentsCommands();

    expect(() => commands.permissions("dev", "superuser", undefined, true)).toThrow(
      "Invalid runtime permission profile: superuser",
    );
    expect(updateAgentCalls).toEqual([]);
  });
});

describe("AgentsCommands session", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    allAgents = [];
    createAgentCalls = [];
    updateAgentCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
    instructionStates.clear();
  });

  it("labels lifetime tokens separately from recent turn context", () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:main",
        name: "dev",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        providerSessionId: "provider-1",
        inputTokens: 82_000_000,
        outputTokens: 150_000,
        totalTokens: 82_150_000,
        contextTokens: 375_000,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ];
    sessionTurnUsageSummaries.set("agent:dev:main", {
      lastTurn: {
        runId: "run_1",
        status: "complete",
        startedAt: 1000,
        completedAt: 90_000,
        durationMs: 89_000,
        inputTokens: 188_000,
        outputTokens: 120,
        cacheReadTokens: 187_000,
        cacheCreationTokens: 0,
        effectiveContextTokens: 375_000,
        costUsd: 1.23,
      },
      recent: {
        windowMs: 86_400_000,
        completeTurns: 34,
        inputTokensAvg: 170_000,
        outputTokensAvg: 300,
        effectiveContextTokensAvg: 293_000,
        effectiveContextTokensMax: 466_000,
        durationMsAvg: 101_000,
        costUsdTotal: 31.37,
      },
    });

    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.session("dev");
    } finally {
      console.log = originalLog;
    }

    const output = logCalls.join("\n");
    expect(output).toContain("Lifetime tokens: 82,150,000");
    expect(output).toContain("Effective context: 375,000");
    expect(output).toContain("Last turn: context=375,000 input=188,000 cache=187,000 output=120 duration=1.5m");
    expect(output).toContain("Recent 24h: turns=34 avgContext=293,000 maxContext=466,000 avgInput=170,000 cost=$31.37");
    expect(output).not.toContain("Tokens: 82150000");
  });
});

describe("AgentsCommands debug --json", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    allAgents = [];
    createAgentCalls = [];
    updateAgentCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
    sessionTurnUsageSummaries.clear();
    instructionStates.clear();
  });

  it("prints raw JSON output for the selected session transcript", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ravi-agents-debug-"));
    const transcriptFile = join(tempDir, "transcript.jsonl");
    transcriptPath = transcriptFile;
    resolvedSession = {
      sessionKey: "dev-main",
      name: "dev-main",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      providerSessionId: "provider-1",
      runtimeProvider: "codex",
      lastChannel: "whatsapp",
      lastTo: "5511999999999",
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      contextTokens: 8,
      compactionCount: 1,
      createdAt: 1000,
      updatedAt: 2000,
    };

    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({
          timestamp: "2026-03-13T00:00:00.000Z",
          type: "user",
          message: { content: "hello" },
        }),
        JSON.stringify({
          timestamp: "2026-03-13T00:00:01.000Z",
          type: "assistant",
          message: { content: [{ type: "text", text: "world" }] },
        }),
      ].join("\n"),
    );

    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.debug("dev", "dev-main", "1", true);
    } finally {
      console.log = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload.session).toMatchObject({
      sessionKey: "dev-main",
      name: "dev-main",
      agentId: "dev",
      runtimeId: "provider-1",
      runtimeProvider: "codex",
    });
    expect(payload.transcript).toMatchObject({
      available: true,
      path: transcriptFile,
      totalEntries: 2,
      selectedEntries: 2,
    });
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({ type: "user" });
    expect(payload.entries[1]).toMatchObject({ type: "assistant" });
  });

  it("prints a JSON error payload when the session does not exist", () => {
    sessionsByAgent = [
      {
        sessionKey: "dev-main",
        name: "dev-main",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.debug("dev", "missing-session", undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload.error).toBe("No session found: missing-session");
    expect(payload.agentId).toBe("dev");
    expect(payload.availableSessions).toEqual(["dev-main"]);
  });
});

describe("AgentsCommands sync-instructions --json", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    allAgents = [
      { id: "legacy", cwd: "/tmp/legacy" },
      { id: "canonical", cwd: "/tmp/canonical" },
      { id: "missing", cwd: "/tmp/missing" },
      { id: "divergent", cwd: "/tmp/divergent" },
    ];
    createAgentCalls = [];
    updateAgentCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    transcriptPath = null;
    instructionStates.clear();
    instructionStates.set("/tmp/legacy", "legacy-claude-canonical");
    instructionStates.set("/tmp/canonical", "agents-canonical");
    instructionStates.set("/tmp/missing", "missing-both");
    instructionStates.set("/tmp/divergent", "divergent-custom-both");
  });

  it("reports migrated, canonical, and missing workspaces", () => {
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.syncInstructions(undefined, false, true);
    } finally {
      console.log = originalLog;
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload).toMatchObject({
      total: 4,
      migrated: 1,
      alreadyCanonical: 1,
      missing: 1,
      manualReview: 1,
      incomplete: 0,
    });
  });

  it("can materialize missing workspaces into AGENTS-first state", () => {
    const commands = new AgentsCommands();
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      commands.syncInstructions(undefined, true, true);
    } finally {
      console.log = originalLog;
    }

    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(logCalls[0] ?? "{}");
    expect(payload).toMatchObject({
      total: 4,
      migrated: 2,
      alreadyCanonical: 1,
      missing: 0,
      manualReview: 1,
      incomplete: 0,
    });
  });
});
afterAll(() => mock.restore());

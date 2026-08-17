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
  name?: string;
  model?: string | null;
  modelPresetId?: string | null;
  effort?: string;
  provider?: string;
  remote?: string;
  defaults?: Record<string, unknown> | null;
  heartbeat?: {
    enabled: boolean;
    intervalMs: number;
    model?: string;
    accountId?: string;
    activeStart?: string;
    activeEnd?: string;
    lastRunAt?: number;
  };
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
let deleteAgentCalls: string[] = [];
let deleteAgentResult = true;
let deleteSessionCalls: string[] = [];
let natsEmitCalls: Array<{ topic: string; payload: unknown }> = [];
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
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
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
    emit: mock(async (topic: string, payload: unknown) => {
      natsEmitCalls.push({ topic, payload });
    }),
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
  deleteAgent: (id: string) => {
    deleteAgentCalls.push(id);
    return deleteAgentResult;
  },
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
  deleteSession: (sessionKey: string) => {
    deleteSessionCalls.push(sessionKey);
    return true;
  },
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
const { ContractError } = await import("../agent-contract.js");
const {
  agentModelBrokerReturnSchema,
  agentPermissionsReturnSchema,
  agentSetReturnSchema,
  agentShowReturnSchema,
  agentsListReturnSchema,
} = await import("./operational-return-schemas.js");

describe("AgentsCommands public return contracts", () => {
  beforeEach(() => {
    currentAgent = {
      id: "main",
      cwd: "/tmp/main",
      model: "gpt-5",
      effort: "high",
      provider: "codex",
      defaults: {
        runtimePermissions: {
          profile: "bootstrap",
          capabilities: [{ permission: "view", objectType: "agent", objectId: "*" }],
        },
      },
    };
    allAgents = [currentAgent];
    presetsById = {};
  });

  it("validates list and show payloads without accepting undeclared fields", () => {
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      const listPayload = commands.list(true);
      const showPayload = commands.show("main", true);

      expect(agentsListReturnSchema.safeParse(listPayload).success).toBe(true);
      expect(agentShowReturnSchema.safeParse(showPayload).success).toBe(true);
      expect(agentsListReturnSchema.safeParse({ ...listPayload, unexpected: true }).success).toBe(false);
      expect(agentShowReturnSchema.safeParse({ ...showPayload, unexpected: true }).success).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });
});

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
      const payload = commands.permissions("dev", "full-access", undefined, true, undefined, true);

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

  it("validates a permission payload before JSON strips optional heartbeat fields", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      heartbeat: {
        enabled: false,
        intervalMs: 1_800_000,
        model: undefined,
        accountId: undefined,
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      const payload = commands.permissions("dev", undefined, undefined, true);

      expect(agentPermissionsReturnSchema.safeParse(payload).success).toBe(true);
    } finally {
      console.log = originalLog;
    }
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
      const payload = commands.permissions("dev", "none", undefined, true, undefined, true);

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
      const payload = commands.permissions("dev", undefined, undefined, true, true, true);

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

  it("narrows a wildcard capability to an already-covered exact capability without --execute", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: {
        runtimePermissions: {
          profile: "bootstrap",
          capabilities: ["mutate:agents:*"],
        },
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};

    try {
      const payload = commands.permissions("dev", undefined, "mutate:agents:debounce", true);

      expect(payload).toMatchObject({
        changed: true,
        before: {
          profile: "bootstrap",
          capabilities: [{ permission: "mutate", objectType: "agents", objectId: "*" }],
        },
        after: {
          profile: "bootstrap",
          capabilities: [{ permission: "mutate", objectType: "agents", objectId: "debounce" }],
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(updateAgentCalls).toEqual([
      {
        id: "dev",
        partial: {
          defaults: {
            runtimePermissions: {
              profile: "bootstrap",
              capabilities: [{ permission: "mutate", objectType: "agents", objectId: "debounce" }],
            },
          },
        },
      },
    ]);
  });

  it("brakes expansion from an exact capability to a wildcard and reports the scoped change", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: {
        runtimePermissions: {
          profile: "bootstrap",
          capabilities: ["mutate:agents:debounce"],
        },
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;

    try {
      commands.permissions("dev", undefined, "mutate:agents:*", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    expect(thrown).toMatchObject({
      code: "WRITE_REQUIRES_EXECUTE",
      exitCode: 3,
      op: "agents permissions",
    });
    expect((thrown as InstanceType<typeof ContractError>).envelope().error.plan).toEqual({
      agentId: "dev",
      beforePresent: true,
      beforeProfile: "bootstrap",
      beforeCapabilitiesCount: 1,
      afterPresent: true,
      afterProfile: "bootstrap",
      afterCapabilitiesCount: 1,
    });
    expect(updateAgentCalls).toHaveLength(0);
  });
});

describe("AgentsCommands model-broker", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev", defaults: { preserved: true } };
    updateAgentCalls = [];
  });

  it("sets and reads a public broker profile without secrets", () => {
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const changed = commands.modelBroker("dev", "hub", "profile_main", "false", undefined, true);
      expect(agentModelBrokerReturnSchema.parse(changed)).toMatchObject({
        action: "model-broker",
        changed: true,
        modelBroker: {
          brokerId: "hub",
          profileRef: "profile_main",
          required: false,
        },
      });
      expect(updateAgentCalls[0]?.partial).toEqual({
        defaults: {
          preserved: true,
          modelBroker: {
            brokerId: "hub",
            profileRef: "profile_main",
            required: false,
          },
        },
      });
      expect(commands.modelBroker("dev", undefined, undefined, undefined, undefined, true)).toMatchObject({
        changed: false,
        modelBroker: { brokerId: "hub", profileRef: "profile_main" },
      });
    } finally {
      console.log = originalLog;
    }
  });

  it("requires both public references for a new selection", () => {
    const commands = new AgentsCommands();
    expect(() => commands.modelBroker("dev", "hub", undefined, undefined, undefined, true)).toThrow(/Both --broker/);
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("fails typed preflight without persisting an active proxy on an unisolated adapter", () => {
    const commands = new AgentsCommands();
    try {
      commands.modelBroker("dev", "hub", "profile_main", "true", undefined, true, true);
      throw new Error("expected typed proxy preflight failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as InstanceType<typeof ContractError>).code).toBe("MODEL_BROKER_UNAVAILABLE");
    }
    expect(updateAgentCalls).toHaveLength(0);
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
describe("agents agent-first contract", () => {
  beforeEach(() => {
    currentAgent = { id: "dev", cwd: "/tmp/dev" };
    allAgents = [
      { id: "dev", cwd: "/tmp/dev" },
      { id: "vendas", cwd: "/tmp/vendas" },
    ];
    createAgentCalls = [];
    updateAgentCalls = [];
    deleteAgentCalls = [];
    deleteAgentResult = true;
    deleteSessionCalls = [];
    natsEmitCalls = [];
    resolvedSession = null;
    mainSession = null;
    sessionsByAgent = [];
    presetsById = {};
  });

  it("emits AGENT_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      commands.show("vendass", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("agents show");
    expect(envelope.error.code).toBe("AGENT_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("vendas");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("minimizes the agents delete dry-run to identity and presence flags", () => {
    currentAgent = {
      id: "dev",
      cwd: "C:/sentinel/private/file-9P3X.txt",
      name: "PRIVATE_MESSAGE_8K2R",
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      commands.delete("dev", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("agents delete");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect(envelope.error.plan).toEqual({
      agentId: "dev",
      cwdPresent: true,
      namePresent: true,
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("C:/sentinel/private/file-9P3X.txt");
    expect(JSON.stringify(envelope.error.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(deleteAgentCalls).toHaveLength(0);
  });

  it("deletes the agent when --execute is passed", () => {
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = commands.delete("dev", true, true);
      expect(payload).toMatchObject({ action: "delete", changed: true, agentId: "dev" });
    } finally {
      console.log = originalLog;
    }
    expect(deleteAgentCalls).toEqual(["dev"]);
  });

  it("minimizes agents reset all to the session count", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:main",
        name: "PRIVATE_MESSAGE_8K2R",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await commands.reset("dev", "all", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("agents reset");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.plan).toEqual({ agentId: "dev", target: "all", count: 1 });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(deleteSessionCalls).toHaveLength(0);
  });

  it("minimizes a single-session reset to its allowed identifiers", async () => {
    resolvedSession = {
      sessionKey: "agent:dev:main",
      name: "PRIVATE_MESSAGE_8K2R",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      createdAt: 1,
      updatedAt: 1,
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await commands.reset("dev", "session-alias", true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    expect(contractError.envelope().error.plan).toEqual({
      agentId: "dev",
      target: "session-alias",
      sessionKey: "agent:dev:main",
    });
    expect(JSON.stringify(contractError.envelope().error.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(deleteSessionCalls).toHaveLength(0);
  });

  it("blocks a single-session reset before abort emission or session deletion", async () => {
    resolvedSession = {
      sessionKey: "agent:dev:main",
      name: "dev-main",
      agentId: "dev",
      agentCwd: "/tmp/dev",
      createdAt: 1,
      updatedAt: 1,
    };
    const sessionBefore = { ...resolvedSession };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await commands.reset("dev", "dev-main", true, undefined);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    expect(thrown).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3, op: "agents reset" });
    expect(natsEmitCalls).toHaveLength(0);
    expect(deleteSessionCalls).toHaveLength(0);
    expect(resolvedSession).toEqual(sessionBefore);
  });

  it("resets all sessions when --execute is passed", async () => {
    sessionsByAgent = [
      {
        sessionKey: "agent:dev:main",
        name: "dev-main",
        agentId: "dev",
        agentCwd: "/tmp/dev",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = await commands.reset("dev", "all", true, true);
      expect(payload).toMatchObject({ action: "reset", changed: true, target: "all", count: 1 });
    } finally {
      console.log = originalLog;
    }
    expect(deleteSessionCalls).toEqual(["agent:dev:main"]);
  });

  it("minimizes an authority-expansion plan to profiles and capability counts", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: {
        runtimePermissions: {
          profile: "bootstrap",
          capabilities: ["execute:provider:PRIVATE_MESSAGE_8K2R"],
        },
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      commands.permissions("dev", "full-access", undefined, true);
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("agents permissions");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.plan).toEqual({
      agentId: "dev",
      beforePresent: true,
      beforeProfile: "bootstrap",
      beforeCapabilitiesCount: 1,
      afterPresent: true,
      afterProfile: "full-access",
      afterCapabilitiesCount: 1,
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("applies a full-access to none authority reduction without --execute", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: { runtimePermissions: { profile: "full-access" } },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = commands.permissions("dev", "none", undefined, true);
      expect(payload).toMatchObject({ changed: true, before: { profile: "full-access" }, after: null });
    } finally {
      console.log = originalLog;
    }
    expect(updateAgentCalls).toEqual([{ id: "dev", partial: { defaults: null } }]);
  });

  it("removes explicit capabilities without --execute", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: {
        runtimePermissions: { profile: "bootstrap", capabilities: ["execute:executable:omni"] },
      },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = commands.permissions("dev", undefined, undefined, true, true);
      expect(payload).toMatchObject({ changed: true, after: { profile: "bootstrap" } });
    } finally {
      console.log = originalLog;
    }
    expect(updateAgentCalls).toEqual([
      { id: "dev", partial: { defaults: { runtimePermissions: { profile: "bootstrap" } } } },
    ]);
  });

  it("allows a no-op permissions request without --execute", () => {
    currentAgent = {
      id: "dev",
      cwd: "/tmp/dev",
      defaults: { runtimePermissions: { profile: "full-access" } },
    };
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = commands.permissions("dev", "full-access", undefined, true);
      expect(payload).toMatchObject({
        changed: true,
        before: { profile: "full-access" },
        after: { profile: "full-access" },
      });
    } finally {
      console.log = originalLog;
    }
    expect(updateAgentCalls).toEqual([
      { id: "dev", partial: { defaults: { runtimePermissions: { profile: "full-access" } } } },
    ]);
  });

  it("keeps the read-only permissions form unbraked (no --execute needed)", () => {
    const commands = new AgentsCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const payload = commands.permissions("dev", undefined, undefined, true);
      expect(payload).toMatchObject({ action: "permissions", changed: false, agentId: "dev" });
    } finally {
      console.log = originalLog;
    }
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("supports --fields compact mode on agents list", () => {
    const commands = new AgentsCommands();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      if (typeof value === "string") logs.push(value);
    };
    try {
      commands.list(true, undefined, undefined, undefined, "id,cwd");
    } finally {
      console.log = originalLog;
    }
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(2);
    expect(Object.keys(payload.items[0]).sort()).toEqual(["cwd", "id"]);
  });
});

afterAll(() => mock.restore());

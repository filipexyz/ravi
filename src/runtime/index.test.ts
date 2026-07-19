import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "../cli/context.js";
import { dbCreateAgent, type ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  assertRuntimeCompatibility,
  createRuntimeProvider,
  DEFAULT_RUNTIME_PROVIDER_ID,
  getRuntimeCompatibilityIssues,
  listRegisteredRuntimeProviderIds,
  registerRuntimeProvider,
  unregisterRuntimeProvider,
} from "./index.js";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt.js";
import { MEMORY_PROMPT_SECTION_ID, MEMORY_PROMPT_SECTION_PRIORITY } from "../memory/index.js";
import type { AgentConfig } from "../router/types.js";
import type { RuntimeProvider } from "./types.js";
import { isNonConversationalSession } from "../skills/skill-curation-runtime.js";

describe("runtime compatibility preflight", () => {
  it("uses Codex as the default runtime provider", () => {
    expect(DEFAULT_RUNTIME_PROVIDER_ID).toBe("codex");
    expect(createRuntimeProvider().id).toBe("codex");
    expect(listRegisteredRuntimeProviderIds()).toContain("claude");
    expect(listRegisteredRuntimeProviderIds()).toEqual(expect.arrayContaining(["codex", "claude", "pi"]));
  });

  it("allows Claude providers to satisfy restricted tool access", () => {
    const provider = createRuntimeProvider("claude");

    expect(() =>
      assertRuntimeCompatibility(provider, {
        requiresMcpServers: true,
        requiresRemoteSpawn: true,
        toolAccessMode: "restricted",
      }),
    ).not.toThrow();
  });

  it("reports provider capability restrictions through the shared runtime abstraction", () => {
    const issues = getRuntimeCompatibilityIssues(createRuntimeProvider("codex"), {
      requiresMcpServers: true,
      requiresRemoteSpawn: true,
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["mcp_servers_unsupported", "remote_spawn_unsupported"]);
  });

  it("reports restricted tool access when runtime hooks are unavailable", () => {
    const provider: RuntimeProvider = {
      id: "codex",
      getCapabilities: () => ({
        runtimeControl: { supported: false, operations: [] },
        dynamicTools: { mode: "none" },
        execution: { mode: "sdk" },
        sessionState: { mode: "provider-session-id" },
        usage: { semantics: "terminal-event" },
        tools: {
          permissionMode: "provider-native",
          accessRequirement: "tool_and_executable",
          supportsParallelCalls: false,
        },
        systemPrompt: { mode: "append" },
        terminalEvents: { guarantee: "adapter" },
        skillVisibility: { availability: "none", loadedState: "none" },
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsPartialText: true,
        supportsToolHooks: false,
        supportsPlugins: true,
        supportsMcpServers: true,
        supportsRemoteSpawn: true,
      }),
    };

    const issues = getRuntimeCompatibilityIssues(provider, {
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["restricted_tool_access_unsupported"]);
  });

  it("allows Codex when the agent is already unrestricted", () => {
    const provider = createRuntimeProvider("codex");

    expect(() =>
      assertRuntimeCompatibility(provider, {
        toolAccessMode: "unrestricted",
      }),
    ).not.toThrow();
  });

  it("blocks restricted tool access for Pi until Ravi-hosted tool hooks exist", () => {
    const issues = getRuntimeCompatibilityIssues(createRuntimeProvider("pi"), {
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["restricted_tool_access_unsupported"]);
  });

  it("supports registering additional runtime providers without changing the factory switch", () => {
    try {
      registerRuntimeProvider("test-provider", () => ({
        id: "test-provider",
        getCapabilities: () => ({
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
          skillVisibility: { availability: "none", loadedState: "none" },
          supportsSessionResume: false,
          supportsSessionFork: false,
          supportsPartialText: false,
          supportsToolHooks: true,
          supportsPlugins: false,
          supportsMcpServers: false,
          supportsRemoteSpawn: false,
        }),
        startSession: () => ({
          provider: "test-provider",
          events: (async function* () {})(),
          interrupt: async () => {},
        }),
      }));

      expect(listRegisteredRuntimeProviderIds()).toContain("test-provider");
      expect(createRuntimeProvider("test-provider").id).toBe("test-provider");
    } finally {
      unregisterRuntimeProvider("test-provider");
    }
  });

  it("keeps built-in runtime providers registered", () => {
    expect(() => unregisterRuntimeProvider("codex")).toThrow("Cannot unregister built-in runtime provider 'codex'");
    expect(createRuntimeProvider("codex").id).toBe("codex");
  });
});

describe("buildRuntimeSystemPrompt with memory section (R6/R12/R13)", () => {
  let dir: string;

  const baseAgent: AgentConfig = {
    id: "runtime-mem-test",
    cwd: "/tmp/replaced-per-test",
    provider: "claude",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ravi-runtime-mem-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits the memory section when MEMORY.md is absent (R26 cold-start)", async () => {
    const result = await buildRuntimeSystemPrompt({ agent: { ...baseAgent, cwd: dir }, cwd: dir });
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
    expect(result.sections.some((s) => s.id === MEMORY_PROMPT_SECTION_ID)).toBe(false);
  });

  it("injects the memory section at the volatile-tier priority between workspace and agent append", async () => {
    writeFileSync(join(dir, "MEMORY.md"), "# runtime-mem-test — auto-memory\n\n- persisted preference\n", "utf-8");
    const result = await buildRuntimeSystemPrompt({ agent: { ...baseAgent, cwd: dir }, cwd: dir });
    const memorySection = result.sections.find((s) => s.id === MEMORY_PROMPT_SECTION_ID);
    expect(memorySection).toBeDefined();
    expect(memorySection!.priority).toBe(MEMORY_PROMPT_SECTION_PRIORITY);
    expect(memorySection!.content).toContain("- persisted preference");
    expect(result.text).toContain("- persisted preference");
  });
});

describe("skill nudge cadence — session guard (runtime wiring)", () => {
  it("never ticks curator or curation-report sessions", () => {
    expect(isNonConversationalSession("task-abc123-curator")).toBe(true);
    expect(isNonConversationalSession("memory-log")).toBe(true);
    expect(isNonConversationalSession("skill-log")).toBe(true);
  });

  it("ticks a normal conversation session", () => {
    expect(isNonConversationalSession("ravi-dev-group-57603085")).toBe(false);
    expect(isNonConversationalSession("main-dm-615153")).toBe(false);
  });

  it("honors RAVI_NUDGE_SKIP_SESSIONS for extra report groups", () => {
    const prev = process.env.RAVI_NUDGE_SKIP_SESSIONS;
    process.env.RAVI_NUDGE_SKIP_SESSIONS = "insights-log, ops-log";
    try {
      expect(isNonConversationalSession("insights-log")).toBe(true);
      expect(isNonConversationalSession("ops-log")).toBe(true);
      expect(isNonConversationalSession("some-group")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.RAVI_NUDGE_SKIP_SESSIONS;
      else process.env.RAVI_NUDGE_SKIP_SESSIONS = prev;
    }
  });
});

describe("scoped tool access on providers without permission hooks", () => {
  let stateDir: string | null = null;
  const agentId = "runtime-access-agent";
  const fullAccessCapabilities: ContextRecord["capabilities"] = [
    { permission: "admin", objectType: "system", objectId: "*", source: "test" },
  ];
  const piCapabilities = {
    tools: { permissionMode: "provider-native", accessRequirement: "tool_and_executable" },
    supportsToolHooks: false,
  } as unknown as Parameters<typeof getRuntimeToolAccessMode>[0];

  function withRuntimeContext<T>(kind: string, capabilities: ContextRecord["capabilities"], fn: () => T): T {
    return runWithContext(
      {
        agentId,
        context: {
          contextId: `ctx-${kind}`,
          contextKey: `key-${kind}`,
          kind,
          agentId,
          capabilities,
          createdAt: Date.now(),
        },
      },
      fn,
    );
  }

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-access-test-");
    dbCreateAgent({ id: agentId, cwd: "/tmp/runtime-access-agent" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("allows a full-authority agent to use a hookless provider for a scoped turn", () => {
    expect(
      withRuntimeContext("agent-runtime", fullAccessCapabilities, () =>
        getRuntimeToolAccessMode(piCapabilities, agentId, { kind: "agent-runtime", metadata: {} }),
      ),
    ).toBe("unrestricted");
  });

  it("keeps an agent without full authority restricted on a hookless provider", () => {
    expect(
      withRuntimeContext("agent-runtime", [], () =>
        getRuntimeToolAccessMode(piCapabilities, agentId, { kind: "agent-runtime", metadata: {} }),
      ),
    ).toBe("restricted");
  });

  it("keeps delegated runtime contexts restricted even for a full-authority agent", () => {
    expect(
      withRuntimeContext("turn-runtime", fullAccessCapabilities, () =>
        getRuntimeToolAccessMode(piCapabilities, agentId, { kind: "turn-runtime", metadata: {} }),
      ),
    ).toBe("restricted");
  });
});

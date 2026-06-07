import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { listPermissionDenials } from "../permissions/denials.js";
import { grantRelation } from "../permissions/relations.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createBashPermissionHook, createToolPermissionHook, evaluateBashPermission } from "./hook.js";

// Helpers
function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  grantRelation(subjectType, subjectId, relation, objectType, objectId, "test");
}

function makeToolContext(agentId: string, capabilities: ContextCapability[], kind = "test-runtime"): ToolContext {
  const context: ContextRecord = {
    contextId: `test-${agentId}`,
    contextKey: `test-key-${agentId}`,
    kind,
    agentId,
    capabilities,
    createdAt: 0,
  };

  return { agentId, context };
}

const dummyContext = { signal: new AbortController().signal };
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-bash-hook-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function callBashHook(command: string, agentId?: string, context?: ToolContext) {
  const hook = createBashPermissionHook({ getAgentId: () => agentId });
  const hookFn = hook.hooks[0];
  const run = () =>
    hookFn({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, null, dummyContext);
  return context ? runWithContext(context, run) : run();
}

async function callToolHook(toolName: string, agentId?: string, context?: ToolContext) {
  const hook = createToolPermissionHook({ getAgentId: () => agentId });
  const hookFn = hook.hooks[0];
  const run = () => hookFn({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} }, null, dummyContext);
  return context ? runWithContext(context, run) : run();
}

function isDenied(result: Record<string, unknown>): boolean {
  const output = result.hookSpecificOutput as any;
  return output?.permissionDecision === "deny";
}

function getDenyReason(result: Record<string, unknown>): string {
  const output = result.hookSpecificOutput as any;
  return output?.permissionDecisionReason ?? "";
}

// ============================================================================
// Bash Permission Hook Tests
// ============================================================================

describe("createBashPermissionHook", () => {
  it("has matcher set to 'Bash'", () => {
    const hook = createBashPermissionHook({ getAgentId: () => undefined });
    expect(hook.matcher).toBe("Bash");
  });

  // --------------------------------------------------------------------------
  // No agent context
  // --------------------------------------------------------------------------

  describe("no agent context", () => {
    it("allows any command when no agentId", async () => {
      const result = await callBashHook("rm -rf /", undefined);
      expect(isDenied(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Env spoofing
  // --------------------------------------------------------------------------

  describe("env spoofing", () => {
    it("blocks RAVI_AGENT_ID override for non-superadmin", async () => {
      grant("agent", "dev", "execute", "executable", "*");
      const result = await callBashHook("RAVI_AGENT_ID=main ravi sessions list", "dev");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("RAVI environment");
    });

    it("blocks RAVI_SESSION_KEY override", async () => {
      grant("agent", "dev", "execute", "executable", "*");
      const result = await callBashHook("RAVI_SESSION_KEY=x ravi sessions list", "dev");
      expect(isDenied(result)).toBe(true);
    });

    it("allows RAVI_* for superadmin", async () => {
      grant("agent", "main", "admin", "system", "*");
      const result = await callBashHook("RAVI_AGENT_ID=dev ravi sessions list", "main");
      expect(isDenied(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Executable permissions
  // --------------------------------------------------------------------------

  describe("executable permissions", () => {
    it("allows with wildcard executable access", async () => {
      grant("agent", "dev", "execute", "executable", "*");
      const result = await callBashHook("git status", "dev");
      expect(isDenied(result)).toBe(false);
    });

    it("allows with specific executable grant", async () => {
      grant("agent", "test", "execute", "executable", "git");
      const result = await callBashHook("git status", "test");
      expect(isDenied(result)).toBe(false);
    });

    it("blocks without executable grant", async () => {
      grant("agent", "test", "execute", "executable", "ls");
      const result = await callBashHook("git status", "test");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("git");
    });

    it("blocks unconditional blocks regardless of grants", async () => {
      grant("agent", "test", "execute", "executable", "bash");
      const result = await callBashHook("bash -c 'echo hi'", "test");
      expect(isDenied(result)).toBe(true);
    });

    it("checks all executables in piped commands", async () => {
      grant("agent", "test", "execute", "executable", "cat");
      // Has cat but not grep
      const result = await callBashHook("cat file | grep foo", "test");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("grep");
    });

    it("checks all executables in chained commands", async () => {
      grant("agent", "test", "execute", "executable", "git");
      grant("agent", "test", "execute", "executable", "ravi");
      const result = await callBashHook("git status && ravi sessions list", "test");
      expect(isDenied(result)).toBe(false);
    });

    it("blocks dangerous patterns before checking executables", async () => {
      grant("agent", "test", "execute", "executable", "echo");
      const result = await callBashHook("echo $(whoami)", "test");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("command substitution");
    });

    it("allows pwd and rg for live superadmin with stale runtime capabilities", () => {
      const decision = evaluateBashPermission("pwd && rg foo", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      });

      expect(decision.allowed).toBe(false);

      grant("agent", "dev", "admin", "system", "*");

      const superadminDecision = evaluateBashPermission("pwd && rg foo", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      });

      expect(superadminDecision.allowed).toBe(true);
    });

    it("allows specific executable grants added after a stale agent-runtime context was issued", () => {
      const decision = evaluateBashPermission("git status", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(decision.allowed).toBe(false);

      grant("agent", "dev", "execute", "executable", "git");

      const liveGrantDecision = evaluateBashPermission("git status", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(liveGrantDecision.allowed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Session scope (ravi CLI commands)
  // --------------------------------------------------------------------------

  describe("session scope", () => {
    it("blocks access to unauthorized session via ravi sessions send", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      const result = await callBashHook("ravi sessions send main 'hello'", "test", {
        agentId: "test",
        sessionName: "test-own",
      });
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("session:main");
    });

    it("allows access to authorized session", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      grant("agent", "test", "access", "session", "main");
      const result = await callBashHook("ravi sessions send main 'hello'", "test", {
        agentId: "test",
        sessionName: "test-own",
      });
      expect(isDenied(result)).toBe(false);
    });

    it("allows access to own session", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      const result = await callBashHook("ravi sessions send test-own 'hello'", "test", {
        agentId: "test",
        sessionName: "test-own",
      });
      expect(isDenied(result)).toBe(false);
    });

    it("allows non-session commands without session grants", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      const result = await callBashHook("ravi contacts list", "test", { agentId: "test" });
      expect(isDenied(result)).toBe(false);
    });

    it("allows session access for live superadmin with stale runtime capabilities", () => {
      const decision = evaluateBashPermission("ravi sessions send main 'hello'", {
        agentId: "dev",
        kind: "agent-runtime",
        sessionName: "dev-own",
        capabilities: [],
      });

      expect(decision.allowed).toBe(false);

      grant("agent", "dev", "admin", "system", "*");

      const superadminDecision = evaluateBashPermission("ravi sessions send main 'hello'", {
        agentId: "dev",
        kind: "agent-runtime",
        sessionName: "dev-own",
        capabilities: [],
      });

      expect(superadminDecision.allowed).toBe(true);
    });
  });
});

// ============================================================================
// Tool Permission Hook Tests
// ============================================================================

describe("createToolPermissionHook", () => {
  it("has no matcher (fires for all tools)", () => {
    const hook = createToolPermissionHook({ getAgentId: () => undefined });
    expect(hook.matcher).toBeUndefined();
  });

  it("allows when no agentId", async () => {
    const result = await callToolHook("Bash", undefined);
    expect(isDenied(result)).toBe(false);
  });

  it("allows SDK tool with grant", async () => {
    grant("agent", "dev", "use", "tool", "Bash");
    const result = await callToolHook("Bash", "dev");
    expect(isDenied(result)).toBe(false);
  });

  it("blocks SDK tool without grant", async () => {
    const result = await callToolHook("Bash", "dev", {
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
    });
    expect(isDenied(result)).toBe(true);
    expect(getDenyReason(result)).toContain("tool:Bash");
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })).toContainEqual(
      expect.objectContaining({
        agentId: "dev",
        sessionKey: "agent:dev:main",
        sessionName: "dev-main",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
      }),
    );
  });

  it("allows with wildcard tool grant", async () => {
    grant("agent", "dev", "use", "tool", "*");
    const result = await callToolHook("Read", "dev");
    expect(isDenied(result)).toBe(false);
  });

  it("skips non-SDK tools (MCP tools)", async () => {
    // "mcp_custom_tool" is not in SDK_TOOLS, should be skipped
    const result = await callToolHook("mcp_custom_tool", "dev");
    expect(isDenied(result)).toBe(false);
  });

  it("blocks multiple different SDK tools independently", async () => {
    grant("agent", "dev", "use", "tool", "Bash");
    // Bash allowed, Read not
    expect(isDenied(await callToolHook("Bash", "dev"))).toBe(false);
    expect(isDenied(await callToolHook("Read", "dev"))).toBe(true);
    expect(isDenied(await callToolHook("Edit", "dev"))).toBe(true);
  });

  it("superadmin allows all tools", async () => {
    grant("agent", "main", "admin", "system", "*");
    expect(isDenied(await callToolHook("Bash", "main"))).toBe(false);
    expect(isDenied(await callToolHook("Read", "main"))).toBe(false);
    expect(isDenied(await callToolHook("Write", "main"))).toBe(false);
  });

  it("allows all SDK tools for live superadmin even with stale scoped capabilities", async () => {
    const context = makeToolContext("dev", [{ permission: "use", objectType: "tool", objectId: "Read" }]);

    expect(isDenied(await callToolHook("Bash", "dev", context))).toBe(true);

    grant("agent", "dev", "admin", "system", "*");

    expect(isDenied(await callToolHook("Bash", "dev", context))).toBe(false);
    expect(isDenied(await callToolHook("Read", "dev", context))).toBe(false);
    expect(isDenied(await callToolHook("Write", "dev", context))).toBe(false);
  });
});

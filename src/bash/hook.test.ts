import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { listPermissionDenials } from "../permissions/denials.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createBashPermissionHook, createToolPermissionHook, evaluateBashPermission } from "./hook.js";

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
    it("denies commands when no agentId is available", async () => {
      const result = await callBashHook("rm -rf /", undefined);
      expect(isDenied(result)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Env spoofing
  // --------------------------------------------------------------------------

  describe("env spoofing", () => {
    it("blocks RAVI_AGENT_ID override for non-superadmin", async () => {
      const result = await callBashHook("RAVI_AGENT_ID=main ravi sessions list", "dev");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("RAVI environment");
    });

    it("blocks RAVI_SESSION_KEY override", async () => {
      const result = await callBashHook("RAVI_SESSION_KEY=x ravi sessions list", "dev");
      expect(isDenied(result)).toBe(true);
    });

    it("allows RAVI_* only for an explicit admin runtime context", async () => {
      const result = await callBashHook(
        "RAVI_AGENT_ID=dev ravi sessions list",
        "main",
        makeToolContext("main", [{ permission: "admin", objectType: "system", objectId: "*" }]),
      );
      expect(isDenied(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Executable permissions
  // --------------------------------------------------------------------------

  describe("executable permissions", () => {
    it("allows with wildcard executable access", async () => {
      const result = await callBashHook(
        "git status",
        "dev",
        makeToolContext("dev", [{ permission: "execute", objectType: "executable", objectId: "*" }]),
      );
      expect(isDenied(result)).toBe(false);
    });

    it("allows with specific executable grant", async () => {
      const result = await callBashHook(
        "git status",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "git" }]),
      );
      expect(isDenied(result)).toBe(false);
    });

    it("blocks without executable grant", async () => {
      const result = await callBashHook(
        "python3 --version",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "ls" }]),
      );
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("python3");
    });

    it("blocks unconditional blocks regardless of grants", async () => {
      const result = await callBashHook(
        "bash -c 'echo hi'",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "bash" }]),
      );
      expect(isDenied(result)).toBe(true);
    });

    it("checks all executables in piped commands", async () => {
      // Has cat but not grep
      const result = await callBashHook(
        "cat file | grep foo",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "cat" }]),
      );
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("grep");
    });

    it("checks all executables in chained commands", async () => {
      const result = await callBashHook(
        "git status && ravi sessions list",
        "test",
        makeToolContext("test", [
          { permission: "execute", objectType: "executable", objectId: "git" },
          { permission: "execute", objectType: "executable", objectId: "ravi" },
        ]),
      );
      expect(isDenied(result)).toBe(false);
    });

    it("blocks dangerous patterns before checking executables", async () => {
      const result = await callBashHook(
        "echo $(whoami)",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "echo" }]),
      );
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("command substitution");
    });

    it("allows bootstrap safe executables with stale agent-runtime capabilities", () => {
      const decision = evaluateBashPermission("pwd && rg foo", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      });

      expect(decision.allowed).toBe(true);
    });

    it("keeps executable grants bounded to the issued context", () => {
      const decision = evaluateBashPermission("python3 --version", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      });

      expect(decision.allowed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Session scope (ravi CLI commands)
  // --------------------------------------------------------------------------

  describe("session scope", () => {
    it("blocks access to unauthorized session via ravi sessions send", async () => {
      const result = await callBashHook("ravi sessions send main 'hello'", "test", {
        agentId: "test",
        sessionName: "test-own",
      });
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("session:main");
    });

    it("allows access to authorized session", async () => {
      const result = await callBashHook(
        "ravi sessions send main 'hello'",
        "test",
        makeToolContext("test", [{ permission: "access", objectType: "session", objectId: "main" }]),
      );
      expect(isDenied(result)).toBe(false);
    });

    it("allows access to own session", async () => {
      const result = await callBashHook("ravi sessions send test-own 'hello'", "test", {
        agentId: "test",
        sessionName: "test-own",
      });
      expect(isDenied(result)).toBe(false);
    });

    it("allows non-session commands without session grants", async () => {
      const result = await callBashHook("ravi contacts list", "test", { agentId: "test" });
      expect(isDenied(result)).toBe(false);
    });

    it("allows session access for an explicit admin runtime context", () => {
      const decision = evaluateBashPermission("ravi sessions send main 'hello'", {
        agentId: "dev",
        kind: "test-runtime",
        sessionName: "dev-own",
        capabilities: [],
      });

      expect(decision.allowed).toBe(false);

      const superadminDecision = evaluateBashPermission("ravi sessions send main 'hello'", {
        agentId: "dev",
        kind: "test-runtime",
        sessionName: "dev-own",
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
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

  it("denies SDK tools when no agentId is available", async () => {
    const result = await callToolHook("Bash", undefined);
    expect(isDenied(result)).toBe(true);
  });

  it("allows SDK tool with context capability", async () => {
    const result = await callToolHook(
      "Bash",
      "dev",
      makeToolContext("dev", [{ permission: "use", objectType: "tool", objectId: "Bash" }]),
    );
    expect(isDenied(result)).toBe(false);
  });

  it("blocks SDK tool when the scoped runtime context lacks the capability", async () => {
    const result = await callToolHook("Bash", "dev", {
      ...makeToolContext("dev", []),
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
    const result = await callToolHook(
      "Read",
      "dev",
      makeToolContext("dev", [{ permission: "use", objectType: "tool", objectId: "*" }]),
    );
    expect(isDenied(result)).toBe(false);
  });

  it("skips non-SDK tools (MCP tools)", async () => {
    // "mcp_custom_tool" is not in SDK_TOOLS, should be skipped
    const result = await callToolHook("mcp_custom_tool", "dev");
    expect(isDenied(result)).toBe(false);
  });

  it("blocks multiple different SDK tools independently", async () => {
    const context = makeToolContext("dev", [{ permission: "use", objectType: "tool", objectId: "Bash" }]);
    // Bash allowed, Read not
    expect(isDenied(await callToolHook("Bash", "dev", context))).toBe(false);
    expect(isDenied(await callToolHook("Read", "dev", context))).toBe(true);
    expect(isDenied(await callToolHook("Edit", "dev", context))).toBe(true);
  });

  it("superadmin allows all tools", async () => {
    const context = makeToolContext("main", [{ permission: "admin", objectType: "system", objectId: "*" }]);
    expect(isDenied(await callToolHook("Bash", "main", context))).toBe(false);
    expect(isDenied(await callToolHook("Read", "main", context))).toBe(false);
    expect(isDenied(await callToolHook("Write", "main", context))).toBe(false);
  });

  it("keeps scoped contexts bounded to their issued capabilities", async () => {
    const context = makeToolContext("dev", [{ permission: "use", objectType: "tool", objectId: "Read" }]);

    expect(isDenied(await callToolHook("Bash", "dev", context))).toBe(true);

    expect(isDenied(await callToolHook("Bash", "dev", context))).toBe(true);
    expect(isDenied(await callToolHook("Read", "dev", context))).toBe(false);
    expect(isDenied(await callToolHook("Write", "dev", context))).toBe(true);
  });
});

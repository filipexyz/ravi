import { describe, expect, it, beforeEach, mock } from "bun:test";

// ============================================================================
// Mock dependencies
// ============================================================================

let relations: Array<{
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}> = [];

mock.module("../permissions/relations.js", () => ({
  hasRelation: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
  ): boolean => {
    return relations.some(
      (r) =>
        r.subjectType === subjectType &&
        r.subjectId === subjectId &&
        r.relation === relation &&
        r.objectType === objectType &&
        r.objectId === objectId,
    );
  },
  listRelations: (filter?: { subjectType?: string; subjectId?: string; relation?: string; objectType?: string }) => {
    return relations.filter((r) => {
      if (filter?.subjectType && r.subjectType !== filter.subjectType) return false;
      if (filter?.subjectId && r.subjectId !== filter.subjectId) return false;
      if (filter?.relation && r.relation !== filter.relation) return false;
      if (filter?.objectType && r.objectType !== filter.objectType) return false;
      return true;
    });
  },
}));

// Mock CLI context
let mockContext: { agentId?: string; sessionKey?: string; sessionName?: string } | undefined;

mock.module("../cli/context.js", () => ({
  getContext: () => mockContext,
}));

// Mock logger
mock.module("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

// Import AFTER mocks
const { createBashPermissionHook, createToolPermissionHook } = await import("./hook");

// Helpers
function grant(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  relations.push({ subjectType, subjectId, relation, objectType, objectId });
}

const dummyContext = { signal: new AbortController().signal };

async function callBashHook(command: string, agentId?: string) {
  const hook = createBashPermissionHook({ getAgentId: () => agentId });
  const hookFn = hook.hooks[0];
  return hookFn({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, null, dummyContext);
}

async function callToolHook(toolName: string, agentId?: string) {
  const hook = createToolPermissionHook({ getAgentId: () => agentId });
  const hookFn = hook.hooks[0];
  return hookFn({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} }, null, dummyContext);
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
  beforeEach(() => {
    relations = [];
    mockContext = undefined;
  });

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
  });

  // --------------------------------------------------------------------------
  // Session scope (ravi CLI commands)
  // --------------------------------------------------------------------------

  describe("session scope", () => {
    it("blocks access to unauthorized session via ravi sessions send", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      mockContext = { agentId: "test", sessionName: "test-own" };
      const result = await callBashHook("ravi sessions send main 'hello'", "test");
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("session:main");
    });

    it("allows access to authorized session", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      grant("agent", "test", "access", "session", "main");
      mockContext = { agentId: "test", sessionName: "test-own" };
      const result = await callBashHook("ravi sessions send main 'hello'", "test");
      expect(isDenied(result)).toBe(false);
    });

    it("allows access to own session", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      mockContext = { agentId: "test", sessionName: "test-own" };
      const result = await callBashHook("ravi sessions send test-own 'hello'", "test");
      expect(isDenied(result)).toBe(false);
    });

    it("allows non-session commands without session grants", async () => {
      grant("agent", "test", "execute", "executable", "ravi");
      mockContext = { agentId: "test" };
      const result = await callBashHook("ravi contacts list", "test");
      expect(isDenied(result)).toBe(false);
    });
  });
});

// ============================================================================
// Tool Permission Hook Tests
// ============================================================================

describe("createToolPermissionHook", () => {
  beforeEach(() => {
    relations = [];
  });

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
    const result = await callToolHook("Bash", "dev");
    expect(isDenied(result)).toBe(true);
    expect(getDenyReason(result)).toContain("tool:Bash");
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
});

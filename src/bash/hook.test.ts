import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { listPermissionDenials } from "../permissions/denials.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { logger } from "../utils/logger.js";
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

    for (const command of [
      "env -u RAVI_CONTEXT_KEY ravi sessions list",
      "env --unset=RAVI_CONTEXT_KEY ravi sessions list",
      "env -i PATH=/usr/bin ravi sessions list",
      "unset RAVI_CONTEXT_KEY; ravi sessions list",
      "export -n RAVI_CONTEXT_KEY && ravi sessions list",
    ]) {
      it(`blocks dropping the context key: ${command}`, async () => {
        const result = await callBashHook(
          command,
          "dev",
          makeToolContext("dev", [{ permission: "execute", objectType: "executable", objectId: "*" }]),
        );
        expect(isDenied(result)).toBe(true);
        expect(getDenyReason(result)).toContain("RAVI environment");
      });
    }

    it("still allows unsetting unrelated variables", async () => {
      const result = await callBashHook(
        "unset FOO && env -u BAR git status",
        "dev",
        makeToolContext("dev", [{ permission: "execute", objectType: "executable", objectId: "*" }]),
      );
      expect(isDenied(result)).toBe(false);
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
      const command = "python3 SENTINEL_COMMAND_6H3N --version";
      const stderr: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      }) as never);

      let result: Awaited<ReturnType<typeof callBashHook>> | undefined;
      try {
        logger.setLevel("warn");
        result = await callBashHook(
          command,
          "test",
          makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "ls" }]),
        );
        expect(isDenied(result)).toBe(true);
      } finally {
        logger.setLevel("info");
        write.mockRestore();
      }

      if (result === undefined) throw new Error("Bash hook did not return a result");
      expect(stderr.join("\n")).not.toContain("SENTINEL_COMMAND_6H3N");
      expect(result).toBeDefined();
      expect(isDenied(result)).toBe(true);
      expect(getDenyReason(result)).toContain("python3");
      const denial = listPermissionDenials({ subjectType: "agent", subjectId: "test", resolved: false })[0];
      expect(denial?.command).toBe(`[REDACTED:content length=${command.length}]`);
      expect(JSON.stringify(denial)).not.toContain(command);
    });

    it("blocks unconditional blocks regardless of grants", async () => {
      const result = await callBashHook(
        "bash -c 'echo hi'",
        "test",
        makeToolContext("test", [{ permission: "execute", objectType: "executable", objectId: "bash" }]),
      );
      expect(isDenied(result)).toBe(true);
    });

    it("blocks output redirection to files for agents that cannot write files", () => {
      const ravisOnly = {
        agentId: "crypto-reception",
        kind: "test-runtime",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      };
      for (const command of [
        "ravi crypto status > ~/.ravi/crypto-production.db",
        "ravi crypto balance --json >> /tmp/x",
        "ravi crypto status &> out.txt",
        "ravi crypto status >| ~/.ravi/ravi.db",
        "ravi crypto status 1>'/tmp/a b'",
      ]) {
        const decision = evaluateBashPermission(command, ravisOnly);
        expect(decision.allowed, command).toBe(false);
        expect(decision.reason ?? "", command).toContain("cannot redirect output to files");
      }
      for (const command of [
        "ravi crypto status --json 2>/dev/null",
        "ravi crypto status 2>&1",
        "ravi crypto status >/dev/stderr",
        "ravi crypto status 1>/dev/stdout",
        'ravi crypto trades propose buy TSLAx 5 --rationale "price > 100"',
      ]) {
        expect(evaluateBashPermission(command, ravisOnly).allowed, command).toBe(true);
      }
      const canWrite = {
        ...ravisOnly,
        capabilities: [...ravisOnly.capabilities, { permission: "use", objectType: "tool", objectId: "Write" }],
      };
      expect(evaluateBashPermission("ravi crypto status > /tmp/status.txt", canWrite).allowed).toBe(true);
      const fullAccess = {
        ...ravisOnly,
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
      };
      expect(evaluateBashPermission("ravi crypto status > /tmp/status.txt", fullAccess).allowed).toBe(true);
    });

    it("blocks stripping RAVI identity env before running ravi", () => {
      const ctx = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
      };
      for (const command of [
        "env -u RAVI_CONTEXT_KEY -u RAVI_AGENT_ID ravi crypto trades approve trd_x --execute",
        "env -i PATH=/usr/bin ravi crypto settings set execution.mode live",
        "env - ravi crypto vault list",
        "/usr/bin/env --ignore-environment ravi crypto trades approve trd_x --execute",
        "env --unset=RAVI_SESSION_KEY ravi crypto balance",
        // A full path to env must not slip past the unset rule.
        "/usr/bin/env -uRAVI_CONTEXT_KEY ravi crypto balance",
        "/usr/bin/env -u RAVI_CONTEXT_KEY ravi crypto balance",
        "/usr/bin/env --unset=RAVI_CONTEXT_KEY ravi crypto balance",
        "'/usr/bin/env' -u RAVI_CONTEXT_KEY ravi crypto balance",
        "unset RAVI_CONTEXT_KEY; ravi crypto trades approve trd_x --execute",
        "exec -c ravi crypto trades list",
        // Quoting hides the name from text matching but not from the shell.
        "env -i ./bin/r'a'vi crypto trades approve trd_x --execute",
        'env -i r"av"i crypto trades approve trd_x --execute',
        "env -i r\\avi crypto trades approve trd_x --execute",
        "R'A'VI_AGENT_ID= ravi crypto vault list",
      ]) {
        const decision = evaluateBashPermission(command, ctx);
        expect(decision.allowed, command).toBe(false);
        expect(decision.denialType, command).toBe("env_spoofing");
      }
      // Ordinary env usage stays allowed.
      expect(evaluateBashPermission("env | grep PATH", ctx).denialType).not.toBe("env_spoofing");
      expect(evaluateBashPermission("env | grep -i ravi", ctx).denialType).not.toBe("env_spoofing");
      expect(evaluateBashPermission("env -u LANG ravi crypto status", ctx).denialType).not.toBe("env_spoofing");
      expect(evaluateBashPermission("/usr/bin/env -u LANG ravi crypto status", ctx).denialType).not.toBe(
        "env_spoofing",
      );
      expect(evaluateBashPermission("/usr/bin/env -uLANG ravi crypto status", ctx).denialType).not.toBe("env_spoofing");
      expect(evaluateBashPermission("env -i PATH=/usr/bin node script.js", ctx).denialType).not.toBe("env_spoofing");
    });

    it("reads env options instead of pattern-matching them", () => {
      const ctx = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
      };
      for (const command of [
        // Bundled flags and GNU abbreviations.
        "env -vu RAVI_CONTEXT_KEY ravi crypto balance",
        "/usr/bin/env -vuRAVI_CONTEXT_KEY ravi crypto balance",
        "env -iu RAVI_CONTEXT_KEY PATH=/usr/bin ravi crypto balance",
        "env --uns RAVI_CONTEXT_KEY ravi crypto balance",
        "env --uns=RAVI_CONTEXT_KEY ravi crypto balance",
        // The name arrives through an expansion.
        "env -u{R,X}AVI_CONTEXT_KEY ravi crypto balance",
        "env -u {RAVI_CONTEXT_KEY,} ravi crypto balance",
        "env -u R{A,}VI_CONTEXT_KEY ravi crypto balance",
        "X=RAVI_CONTEXT_KEY; env -u $X ravi crypto balance",
        "X=RAVI_CONTEXT_KEY; env -u ${X} ravi crypto balance",
        // Shell tricks around the env name.
        "/usr/bin/ENV -u RAVI_CONTEXT_KEY ravi crypto balance",
        "env \\\n-u RAVI_CONTEXT_KEY ravi crypto balance",
        "(env -u RAVI_CONTEXT_KEY ravi crypto balance)",
        "{ env -i ravi crypto balance; }",
        "env -i ./bin/RAVI crypto balance",
        // Blanking the key with a builtin instead of unsetting it.
        "printf -v RAVI_CONTEXT_KEY ''; ravi crypto balance",
        "declare +x RAVI_CONTEXT_KEY; ravi crypto balance",
        "typeset +x RAVI_CONTEXT_KEY; ravi crypto balance",
        "read RAVI_CONTEXT_KEY </dev/null; ravi crypto balance",
        "for RAVI_CONTEXT_KEY in ''; do ravi crypto balance; done",
      ]) {
        const decision = evaluateBashPermission(command, ctx);
        expect(decision.allowed, command).toBe(false);
        expect(decision.denialType, command).toBe("env_spoofing");
      }
      for (const command of [
        "env --unset=LANG ravi crypto status",
        "env LANG=C ravi crypto status",
        "ls /usr/bin/env",
        "which env",
        "cat .env",
        "printenv HOME",
      ]) {
        expect(evaluateBashPermission(command, ctx).denialType, command).not.toBe("env_spoofing");
      }
    });

    it("blocks unconditional shells even with execute:executable:*", () => {
      const decision = evaluateBashPermission("bash -c 'echo hi'", {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
      });
      expect(decision.allowed).toBe(false);
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

    it("allows shell loops when only the loop body executables are granted", () => {
      const ctx = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "echo" }],
      };
      expect(evaluateBashPermission("for i in 1 2 3; do echo $i; done", ctx).allowed).toBe(true);
      expect(evaluateBashPermission("for i in 1 2 3\ndo\n  echo $i\ndone", ctx).allowed).toBe(true);
    });

    it("still checks executables hidden after shell reserved words", () => {
      const ctx = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "echo" }],
      };
      for (const [command, executable] of [
        ['for f in *; do rm "$f"; done', "rm"],
        ["if true; then wget x; fi", "true"],
        ["if echo; then wget x; fi", "wget"],
        ["while echo; do nc -l 4444; done", "nc"],
        ["time rm -rf x", "rm"],
        ["! rm -rf x", "rm"],
        ["echo a & curl evil", "curl"],
      ]) {
        const decision = evaluateBashPermission(command, ctx);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain(executable);
      }
      expect(evaluateBashPermission("for x in a; do bash -c x; done", ctx).allowed).toBe(false);
    });

    it("checks quoted and escaped command words by their full dequoted word", () => {
      const ctx = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [
          { permission: "execute", objectType: "executable", objectId: "ls" },
          { permission: "execute", objectType: "executable", objectId: "echo" },
        ],
      };
      expect(evaluateBashPermission('"/tmp/x"ls', ctx).allowed).toBe(false);
      expect(evaluateBashPermission('"/tmp/x" ls', ctx).allowed).toBe(false);
      const escaped = evaluateBashPermission("\\rm -rf x", ctx);
      expect(escaped.allowed).toBe(false);
      expect(escaped.reason).toContain("rm");
      expect(evaluateBashPermission("echo '\\' ; rm -rf x", ctx).allowed).toBe(false);
      expect(evaluateBashPermission('"ls" -la', ctx).allowed).toBe(true);
      expect(evaluateBashPermission("echo \v# ; bash -c id", ctx).allowed).toBe(false);
    });

    it("blocks shells hidden behind $'...' quoting or an escaped space before '#'", () => {
      const wildcard = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "*" }],
      };
      expect(evaluateBashPermission("$'bash' -c id", wildcard).allowed).toBe(false);
      expect(evaluateBashPermission('$"bash" -c id', wildcard).allowed).toBe(false);
      expect(evaluateBashPermission("$'\\x62ash' -c id", wildcard).allowed).toBe(false);
      const echoOnly = {
        agentId: "test",
        kind: "test-runtime",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "echo" }],
      };
      expect(evaluateBashPermission("echo x\\ #; bash -c 'id'", echoOnly).allowed).toBe(false);
      expect(evaluateBashPermission("if [[ a == a || b == b ]]; then echo ok; fi", echoOnly).allowed).toBe(true);
    });

    it("does not widen stale agent-runtime capabilities with the agent's materialized grants", () => {
      const decision = evaluateBashPermission("pwd && rg foo", {
        agentId: "dev",
        kind: "agent-runtime",
        capabilities: [],
      });

      expect(decision.allowed).toBe(false);
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

describe("turn-runtime executor ceiling", () => {
  const agentId = "leo-vps";
  const bootstrapCaps: ContextCapability[] = [
    { permission: "use", objectType: "tool", objectId: "*" },
    { permission: "execute", objectType: "executable", objectId: "git" },
    { permission: "execute", objectType: "executable", objectId: "ls" },
  ];

  function whatsappTurn(
    capabilities: ContextCapability[],
    metadata: Record<string, unknown> = {},
  ): Parameters<typeof evaluateBashPermission>[1] {
    return {
      agentId,
      kind: "turn-runtime",
      capabilities,
      metadata: {
        authorityMode: "agent-identity",
        actorResolution: "resolved",
        ...metadata,
      },
    };
  }

  function whatsappToolContext(capabilities: ContextCapability[], metadata: Record<string, unknown> = {}): ToolContext {
    return {
      ...makeToolContext(agentId, capabilities, "turn-runtime"),
      context: {
        ...makeToolContext(agentId, capabilities, "turn-runtime").context!,
        metadata: {
          authorityMode: "agent-identity",
          actorResolution: "resolved",
          ...metadata,
        },
      },
    };
  }

  beforeEach(() => {
    dbCreateAgent({ id: agentId, cwd: "/tmp/leo-vps" });
  });

  it("allows ssh on a WhatsApp-like turn when the agent has full-access", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const decision = evaluateBashPermission("ssh host uptime", whatsappTurn(bootstrapCaps));
    expect(decision.allowed).toBe(true);
  });

  it("allows ssh when the agent has explicit execute:executable:* even if the turn snapshot is bootstrap-only", () => {
    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:*"] } },
    });

    const decision = evaluateBashPermission("ssh host uptime", whatsappTurn(bootstrapCaps));
    expect(decision.allowed).toBe(true);
  });

  it("picks up a mid-turn runtimePermissions expansion without resetting the session", () => {
    const stale = whatsappTurn(bootstrapCaps);
    expect(evaluateBashPermission("ssh host uptime", stale).allowed).toBe(false);

    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:*"] } },
    });
    expect(evaluateBashPermission("ssh host uptime", stale).allowed).toBe(true);
  });

  it("picks up a mid-turn runtimePermissions reduction without resetting the session", () => {
    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:*"] } },
    });
    const stale = whatsappTurn([{ permission: "execute", objectType: "executable", objectId: "*" }]);
    expect(evaluateBashPermission("ssh host uptime", stale).allowed).toBe(true);

    dbUpdateAgent(agentId, { defaults: {} });
    expect(evaluateBashPermission("ssh host uptime", stale).allowed).toBe(false);
  });

  it("keeps unresolved WhatsApp actors fail-closed even when the agent has full-access", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const decision = evaluateBashPermission(
      "ssh host uptime",
      whatsappTurn([], { actorResolution: "missing_contact" }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("does not widen observation-narrowed turns beyond the issued snapshot", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const decision = evaluateBashPermission(
      "ssh host uptime",
      whatsappTurn([{ permission: "execute", objectType: "group", objectId: "observer_report" }], {
        turnCapabilityCount: 1,
        turnCapabilities: [{ permission: "execute", objectType: "group", objectId: "observer_report" }],
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("still blocks unconditional shells under full-access", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const decision = evaluateBashPermission("bash -c 'echo hi'", whatsappTurn(bootstrapCaps));
    expect(decision.allowed).toBe(false);
  });

  it("allows the Bash tool on a stale turn-runtime after full-access is applied", async () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const result = await callToolHook("Bash", agentId, whatsappToolContext([]));
    expect(isDenied(result)).toBe(false);
  });

  it("bounds user-overlay turns by the contact's chat grants even under full-access", () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
    const overlayTurn = whatsappTurn(
      [
        { permission: "use", objectType: "tool", objectId: "Bash" },
        { permission: "execute", objectType: "executable", objectId: "git" },
      ],
      { actorAuthorizationMode: "user-overlay", userOverlay: "active" },
    );

    expect(evaluateBashPermission("git status", overlayTurn).allowed).toBe(true);
    expect(evaluateBashPermission("ssh host uptime", overlayTurn).allowed).toBe(false);
  });

  it("denies tools to a user-overlay sender without chat grants", async () => {
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });

    const result = await callToolHook(
      "Bash",
      agentId,
      whatsappToolContext([], { actorAuthorizationMode: "user-overlay", userOverlay: "active" }),
    );
    expect(isDenied(result)).toBe(true);
  });

  it("still applies a live executor reduction to user-overlay turns", () => {
    dbUpdateAgent(agentId, {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:*"] } },
    });
    const overlayTurn = whatsappTurn([{ permission: "execute", objectType: "executable", objectId: "ssh" }], {
      actorAuthorizationMode: "user-overlay",
      userOverlay: "active",
    });
    expect(evaluateBashPermission("ssh host uptime", overlayTurn).allowed).toBe(true);

    dbUpdateAgent(agentId, { defaults: {} });
    expect(evaluateBashPermission("ssh host uptime", overlayTurn).allowed).toBe(false);
  });
});

describe("non-delegated child contexts of a superadmin agent", () => {
  const agentId = "boss";
  const childCaps: ContextCapability[] = [{ permission: "execute", objectType: "executable", objectId: "git" }];

  function childContext(
    kind: string,
    capabilities: ContextCapability[] = childCaps,
  ): Parameters<typeof evaluateBashPermission>[1] {
    return { agentId, kind, sessionName: "boss-own", capabilities };
  }

  beforeEach(() => {
    dbCreateAgent({ id: agentId, cwd: "/tmp/boss" });
    dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "full-access" } } });
  });

  for (const kind of ["cli-runtime", "app-runtime"]) {
    it(`bounds a narrowed ${kind} child by its own capabilities`, () => {
      const ctx = childContext(kind);
      expect(evaluateBashPermission("git status", ctx).allowed).toBe(true);

      const ssh = evaluateBashPermission("ssh host uptime", ctx);
      expect(ssh.allowed).toBe(false);
      expect(ssh.denialType).toBe("executable");

      const session = evaluateBashPermission("ravi sessions send main 'hello'", childContext(kind, []));
      expect(session.allowed).toBe(false);
      expect(session.denialType).toBe("session_scope");

      const spoof = evaluateBashPermission("RAVI_AGENT_ID=main git status", ctx);
      expect(spoof.allowed).toBe(false);
      expect(spoof.denialType).toBe("env_spoofing");
    });
  }

  it("denies SDK tools the narrowed child was not granted", async () => {
    const context = makeToolContext(agentId, childCaps, "cli-runtime");
    expect(isDenied(await callToolHook("Bash", agentId, context))).toBe(true);

    const granted = makeToolContext(
      agentId,
      [...childCaps, { permission: "use", objectType: "tool", objectId: "Bash" }],
      "cli-runtime",
    );
    expect(isDenied(await callToolHook("Bash", agentId, granted))).toBe(false);
  });

  it("keeps the live executor ceiling for delegated turns of the same agent", async () => {
    const metadata = { authorityMode: "agent-identity", actorResolution: "resolved" };
    const turn: Parameters<typeof evaluateBashPermission>[1] = {
      agentId,
      kind: "turn-runtime",
      capabilities: childCaps,
      metadata,
    };
    expect(evaluateBashPermission("ssh host uptime", turn).allowed).toBe(true);

    const toolContext: ToolContext = {
      agentId,
      context: { ...makeToolContext(agentId, childCaps, "turn-runtime").context!, metadata },
    };
    expect(isDenied(await callToolHook("Bash", agentId, toolContext))).toBe(false);
  });

  it("still treats a context that holds admin:system:* as superadmin", () => {
    const ctx = childContext("cli-runtime", [{ permission: "admin", objectType: "system", objectId: "*" }]);
    expect(evaluateBashPermission("ssh host uptime", ctx).allowed).toBe(true);
    expect(evaluateBashPermission("ravi sessions send main 'hello'", ctx).allowed).toBe(true);
    expect(evaluateBashPermission("RAVI_AGENT_ID=main git status", ctx).allowed).toBe(true);
  });
});

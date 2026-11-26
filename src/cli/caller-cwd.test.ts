import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseCallerCwd, resolveCallerPath } from "./caller-cwd.js";
import { getOrCreateSession } from "../router/index.js";
import { dbCreateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RulesCommands } from "./commands/rules.js";
import { WidgetsCommands } from "./commands/widgets.js";
import { runWithContext, type ToolContext } from "./context.js";

describe("parseCallerCwd", () => {
  it("accepts absolute paths and ignores missing values", () => {
    expect(parseCallerCwd("/tmp/agent-workspace")).toEqual({ ok: true, cwd: "/tmp/agent-workspace" });
    expect(parseCallerCwd(undefined)).toEqual({ ok: true, cwd: undefined });
    expect(parseCallerCwd("  ")).toEqual({ ok: true, cwd: undefined });
  });

  it("rejects relative or malformed cwd values", () => {
    expect(parseCallerCwd("./index.html")).toMatchObject({ ok: false });
    expect(parseCallerCwd(12)).toMatchObject({ ok: false });
    expect(parseCallerCwd(`/tmp/${"a".repeat(5000)}`)).toMatchObject({ ok: false });
  });
});

describe("resolveCallerPath", () => {
  it("resolves relative file arguments against the caller cwd", () => {
    const resolved = runWithContext({ cwd: "/tmp/agent-workspace" }, () => resolveCallerPath("./index.html"));
    expect(resolved).toBe(join("/tmp/agent-workspace", "index.html"));
  });

  it("reads a leading ~ as the home directory, as a shell would", () => {
    expect(runWithContext({ cwd: "/tmp/agent-workspace" }, () => resolveCallerPath("~/recordings"))).toBe(
      join(homedir(), "recordings"),
    );
    expect(runWithContext({ cwd: "/tmp/agent-workspace" }, () => resolveCallerPath("./~x"))).toBe(
      join("/tmp/agent-workspace", "~x"),
    );
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolveCallerPath("/var/pages/index.html")).toBe("/var/pages/index.html");
  });
});

function agentContext(...capabilities: string[]): ToolContext {
  return {
    agentId: "reporter",
    cwd: "/tmp/reporter",
    context: {
      contextId: "ctx_reporter",
      contextKey: "rctx_reporter",
      kind: "agent-runtime",
      agentId: "reporter",
      capabilities: capabilities.map((value) => {
        const [permission, objectType, objectId] = value.split(":");
        return { permission: permission!, objectType: objectType!, objectId: objectId! };
      }),
      createdAt: 0,
    },
  };
}

describe("resolveCallerPath file authority", () => {
  const denied = expect.objectContaining({ code: "PERMISSION_DENIED" });

  it("refuses daemon-side reads and writes to a context without the file tools", () => {
    const bashOnly = agentContext("use:tool:Bash", "read:bases:*");
    expect(() => runWithContext(bashOnly, () => resolveCallerPath("/home/other/AGENTS.md", "write"))).toThrow(denied);
    expect(() => runWithContext(bashOnly, () => resolveCallerPath("/etc/hostname"))).toThrow(denied);
  });

  it("follows use:tool:Read and use:tool:Write", () => {
    const reader = agentContext("use:tool:Read");
    expect(runWithContext(reader, () => resolveCallerPath("in.json"))).toBe("/tmp/reporter/in.json");
    expect(() => runWithContext(reader, () => resolveCallerPath("out.csv", "write"))).toThrow(denied);
    const writer = agentContext("use:tool:Write");
    expect(runWithContext(writer, () => resolveCallerPath("out.csv", "write"))).toBe("/tmp/reporter/out.csv");
    expect(() => runWithContext(writer, () => resolveCallerPath(".claude/settings.json", "write"))).toThrow(denied);
  });

  it("bounds a person held below break-glass to the session's workspace, not a cwd the caller declares", async () => {
    const stateDir = await createIsolatedRaviState("caller-cwd-limited-");
    try {
      // Outside the temp roots, so only the workspace rule can allow it.
      const workspace = join(homedir(), `ravi-limited-session-workspace-${process.pid}`);
      dbCreateAgent({ id: "reporter", cwd: workspace });
      getOrCreateSession("agent:reporter:limited", "reporter", workspace, { name: "limited" });
      const limited = (cwd: string): ToolContext => {
        const base = agentContext("use:tool:Write", "deny_execute:executable:*");
        return { ...base, cwd, context: { ...base.context!, sessionKey: "agent:reporter:limited" } };
      };
      expect(runWithContext(limited(workspace), () => resolveCallerPath("notes.md", "write"))).toBe(
        join(workspace, "notes.md"),
      );
      // `cd` into another agent's workspace before calling: the boundary stays the session's.
      const elsewhere = join(homedir(), `ravi-other-agent-workspace-${process.pid}`);
      expect(() => runWithContext(limited(elsewhere), () => resolveCallerPath("AGENTS.md", "write"))).toThrow(denied);
      expect(() =>
        runWithContext(limited(workspace), () =>
          resolveCallerPath(join(homedir(), "ravi-daemon-side-test", "daemon-side.txt"), "write"),
        ),
      ).toThrow(denied);
      // Reads by the daemon for this person stay in the same place as writes.
      const limitedReader = (cwd: string): ToolContext => {
        const base = agentContext("use:tool:Read", "deny_execute:executable:*");
        return { ...base, cwd, context: { ...base.context!, sessionKey: "agent:reporter:limited" } };
      };
      expect(runWithContext(limitedReader(workspace), () => resolveCallerPath("page.html"))).toBe(
        join(workspace, "page.html"),
      );
      expect(() =>
        runWithContext(limitedReader(workspace), () => resolveCallerPath(join(homedir(), ".ravi", ".env"))),
      ).toThrow(denied);
      expect(() => runWithContext(limitedReader(elsewhere), () => resolveCallerPath("AGENTS.md"))).toThrow(denied);
      // No session on the context: only temp stays writable.
      const sessionless = { ...agentContext("use:tool:Write", "deny_execute:executable:*"), cwd: workspace };
      expect(() => runWithContext(sessionless, () => resolveCallerPath("notes.md", "write"))).toThrow(denied);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("imports rules into the caller's workspace and refuses a limited turn writing them anywhere else", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ravi-rules-caller-"));
    const outside = join(homedir(), `ravi-rules-outside-${process.pid}`);
    try {
      for (const root of [workspace, outside]) {
        mkdirSync(join(root, ".claude", "rules"), { recursive: true });
        writeFileSync(join(root, ".claude", "rules", "testing.md"), "Run focused tests.\n");
      }
      const limited: ToolContext = { ...agentContext("use:tool:Write", "deny_execute:executable:*"), cwd: workspace };
      const silent = console.log;
      console.log = () => {};
      try {
        // Relative --cwd is the caller's, not the daemon's.
        await runWithContext(limited, () => new RulesCommands().importRules("claude", ".", false, true, false, true));
        await expect(
          runWithContext(limited, () => new RulesCommands().importRules("claude", outside, false, true, false, true)),
        ).rejects.toThrow(denied);
      } finally {
        console.log = silent;
      }
      expect(existsSync(join(workspace, ".ravi", "rules", "imported", "claude", "project", "testing.md"))).toBe(true);
      // Rules are loaded as authoritative instructions: nothing lands outside.
      expect(existsSync(join(outside, ".ravi"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses widgets init into a folder before writing anything", () => {
    const dir = join(tmpdir(), `ravi-caller-path-${process.pid}-${Date.now()}`);
    expect(() =>
      runWithContext(agentContext("use:tool:Bash", "mutate:widgets:*"), () => new WidgetsCommands().init(dir)),
    ).toThrow(denied);
    expect(existsSync(dir)).toBe(false);
  });
});

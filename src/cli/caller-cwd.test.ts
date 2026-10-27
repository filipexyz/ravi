import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCallerCwd, resolveCallerPath } from "./caller-cwd.js";
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

  it("refuses widgets init into a folder before writing anything", () => {
    const dir = join(tmpdir(), `ravi-caller-path-${process.pid}-${Date.now()}`);
    expect(() =>
      runWithContext(agentContext("use:tool:Bash", "mutate:widgets:*"), () => new WidgetsCommands().init(dir)),
    ).toThrow(denied);
    expect(existsSync(dir)).toBe(false);
  });
});

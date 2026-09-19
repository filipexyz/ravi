import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseCallerCwd, resolveCallerPath } from "./caller-cwd.js";
import { runWithContext } from "./context.js";

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

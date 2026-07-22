import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthorizedMemoryGuardTarget } from "./guard-target.js";

describe("resolveAuthorizedMemoryGuardTarget", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ravi-memory-target-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows only the authenticated agent MEMORY.md and memory/ descendants", () => {
    const agent = join(root, "agent-a");
    mkdirSync(join(agent, "memory"), { recursive: true });

    expect(resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "MEMORY.md") })).toBe(
      join(agent, "MEMORY.md"),
    );
    expect(resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "memory", "topic.md") })).toBe(
      join(agent, "memory", "topic.md"),
    );
    expect(() => resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "AGENTS.md") })).toThrow(
      /MEMORY\.md or a file below its memory\/ store/,
    );
  });

  it("rejects cross-agent targets even when they are under another registered-looking cwd", () => {
    const agentA = join(root, "agent-a");
    const agentB = join(root, "agent-b");
    mkdirSync(join(agentA, "memory"), { recursive: true });
    mkdirSync(join(agentB, "memory"), { recursive: true });

    expect(() =>
      resolveAuthorizedMemoryGuardTarget({ agentCwd: agentA, targetPath: join(agentB, "MEMORY.md") }),
    ).toThrow(/authenticated agent/);
  });

  it("rejects symlink components before resolving real parents", () => {
    const agent = join(root, "agent-a");
    const outside = join(root, "outside");
    mkdirSync(agent, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(agent, "memory"));

    expect(() =>
      resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "memory", "topic.md") }),
    ).toThrow(/symlink component/);
  });

  it("rejects existing non-file targets", () => {
    const agent = join(root, "agent-a");
    mkdirSync(join(agent, "memory", "topic.md"), { recursive: true });
    expect(() =>
      resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "memory", "topic.md") }),
    ).toThrow(/regular file/);

    writeFileSync(join(agent, "memory", "ok.md"), "ok", "utf-8");
    expect(resolveAuthorizedMemoryGuardTarget({ agentCwd: agent, targetPath: join(agent, "memory", "ok.md") })).toBe(
      join(agent, "memory", "ok.md"),
    );
  });
});

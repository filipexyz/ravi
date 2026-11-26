import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAgentWorkspaceChanges } from "./workspace-inspection.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent workspace inspection", () => {
  it("never runs code the agent's repository config points at", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ravi-agent-ws-"));
    dirs.push(repo);
    const marker = join(repo, "fsmonitor-ran");
    const hook = join(repo, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook]);
    writeFileSync(join(repo, "file.txt"), "agent change\n");

    const result = await inspectAgentWorkspaceChanges(repo);

    expect(result).toEqual({ state: "unavailable", changedFiles: 0, preview: [] });
    expect(existsSync(marker)).toBe(false);
  });
});

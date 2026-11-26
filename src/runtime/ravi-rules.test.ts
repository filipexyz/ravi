import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importRaviRules, loadRaviRuleFiles } from "./ravi-rules.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ravi rules stay inside the agent workspace", () => {
  it("loads rules from a real .ravi/rules directory", async () => {
    const cwd = tempDir("ravi-rules-ws-");
    mkdirSync(join(cwd, ".ravi", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".ravi", "rules", "style.md"), "Use short sentences.\n");

    const files = await loadRaviRuleFiles(cwd);

    expect(files.map((file) => file.content)).toEqual(["Use short sentences."]);
  });

  it("reads nothing through a .ravi/rules symlink that leaves the workspace", async () => {
    const cwd = tempDir("ravi-rules-ws-");
    const outside = tempDir("ravi-rules-outside-");
    writeFileSync(join(outside, "secret.md"), "OPERATOR_SECRET=1\n");
    mkdirSync(join(cwd, ".ravi"), { recursive: true });
    symlinkSync(outside, join(cwd, ".ravi", "rules"));

    const files = await loadRaviRuleFiles(cwd);

    expect(files).toEqual([]);
  });

  it("loads rules from an in-workspace directory whose name starts with two dots", async () => {
    const cwd = tempDir("ravi-rules-ws-");
    mkdirSync(join(cwd, "..shared-rules"), { recursive: true });
    writeFileSync(join(cwd, "..shared-rules", "style.md"), "Use short sentences.\n");
    mkdirSync(join(cwd, ".ravi"), { recursive: true });
    symlinkSync(join(cwd, "..shared-rules"), join(cwd, ".ravi", "rules"));

    const files = await loadRaviRuleFiles(cwd);

    expect(files.map((file) => file.content)).toEqual(["Use short sentences."]);
  });

  it("refuses an import whose destination directory is a symlink out of the workspace", async () => {
    const cwd = tempDir("ravi-rules-ws-");
    const outside = tempDir("ravi-rules-outside-");
    mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "rules", "a.md"), "Rule A.\n");
    mkdirSync(join(cwd, ".ravi", "rules"), { recursive: true });
    symlinkSync(outside, join(cwd, ".ravi", "rules", "imported"));

    await expect(importRaviRules({ cwd, provider: "claude", write: true })).rejects.toThrow(
      "resolves outside the workspace",
    );
    expect(existsSync(join(outside, "claude"))).toBe(false);
  });
});

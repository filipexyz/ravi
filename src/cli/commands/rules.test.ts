import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesCommands } from "./rules.js";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalRulesUserHome = process.env.RAVI_RULES_USER_HOME;

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function captureConsole(fn: () => Promise<unknown>): Promise<{ output: string; result: unknown }> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    const result = await fn();
    return { output: logs.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  process.env.HOME = makeTempRoot("ravi-rules-home-");
  process.env.RAVI_RULES_USER_HOME = process.env.HOME;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalRulesUserHome === undefined) {
    delete process.env.RAVI_RULES_USER_HOME;
  } else {
    process.env.RAVI_RULES_USER_HOME = originalRulesUserHome;
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("RulesCommands", () => {
  it("dry-runs project provider imports without writing or exposing rule content in JSON", async () => {
    const cwd = makeTempRoot("ravi-rules-workspace-");
    const home = process.env.HOME!;
    mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "rules", "ops"), { recursive: true });
    mkdirSync(join(home, ".claude", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "rules", "testing.md"), "Run focused tests.\n");
    writeFileSync(join(cwd, ".agents", "rules", "ops", "handoff.md"), "Keep handoffs short.\n");
    writeFileSync(join(home, ".claude", "rules", "private.md"), "Private preference.\n");

    const commands = new RulesCommands();
    const { output } = await captureConsole(() => commands.importRules("all", cwd, false, false, false, true));
    const payload = JSON.parse(output) as {
      counts: { candidates: number };
      candidates: Array<{ provider: string; scope: string; destinationRelativePath: string; content?: string }>;
    };

    expect(payload.counts.candidates).toBe(2);
    expect(payload.candidates.map((candidate) => `${candidate.provider}/${candidate.scope}`).sort()).toEqual([
      "agents/project",
      "claude/project",
    ]);
    expect(payload.candidates.every((candidate) => candidate.content === undefined)).toBe(true);
    expect(output).not.toContain("Run focused tests.");
    expect(existsSync(join(cwd, ".ravi", "rules", "imported"))).toBe(false);
  });

  it("writes user imports only when explicitly requested and protects existing files unless forced", async () => {
    const cwd = makeTempRoot("ravi-rules-workspace-");
    const home = process.env.HOME!;
    mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
    mkdirSync(join(home, ".claude", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "rules", "testing.md"), "Run focused tests.\n");
    writeFileSync(join(home, ".claude", "rules", "workflow.md"), "Personal workflow.\n");

    const commands = new RulesCommands();
    await captureConsole(() => commands.importRules("claude", cwd, true, true, false, true));

    const projectRule = join(cwd, ".ravi", "rules", "imported", "claude", "project", "testing.md");
    const userRule = join(cwd, ".ravi", "rules", "imported", "claude", "user", "workflow.md");
    expect(readFileSync(projectRule, "utf8")).toBe("Run focused tests.\n");
    expect(readFileSync(userRule, "utf8")).toBe("Personal workflow.\n");

    writeFileSync(join(home, ".claude", "rules", "workflow.md"), "Updated workflow.\n");
    const skipped = (await captureConsole(() => commands.importRules("claude", cwd, true, true, false, true)))
      .result as {
      counts: { skippedExisting: number };
    };
    expect(skipped.counts.skippedExisting).toBe(2);
    expect(readFileSync(userRule, "utf8")).toBe("Personal workflow.\n");

    const forced = (await captureConsole(() => commands.importRules("claude", cwd, true, true, true, true))).result as {
      counts: { overwritten: number };
    };
    expect(forced.counts.overwritten).toBe(2);
    expect(readFileSync(userRule, "utf8")).toBe("Updated workflow.\n");
  });

  it("lists source directories without requiring them to exist", async () => {
    const cwd = makeTempRoot("ravi-rules-workspace-");
    const commands = new RulesCommands();
    const result = (await captureConsole(() => commands.sources("agents", cwd, true, true))).result as {
      sources: Array<{ provider: string; scope: string; exists: boolean }>;
    };

    expect(result.sources).toEqual([
      expect.objectContaining({ provider: "agents", scope: "project", exists: false }),
      expect.objectContaining({ provider: "agents", scope: "user", exists: false }),
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SpecsCommands } from "./specs.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
let isolatedStateDir: string | null = null;
let previousStateDir: string | undefined;

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-specs-cli-"));
  tempRoots.push(root);
  process.chdir(root);
  return root;
}

function captureConsole(fn: () => unknown): { output: string; result: unknown } {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    const result = fn();
    return { output: logs.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(async () => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  isolatedStateDir = await createIsolatedRaviState("ravi-specs-cli-state-");
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanupIsolatedRaviState(isolatedStateDir);
  isolatedStateDir = null;
  if (previousStateDir) {
    process.env.RAVI_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("SpecsCommands", () => {
  it("creates, lists, and gets specs as JSON", () => {
    makeWorkspace();
    const commands = new SpecsCommands();

    const created = captureConsole(() =>
      commands.new("channels/presence/lifecycle", "Presence Lifecycle", "feature", true, true),
    );
    const createPayload = JSON.parse(created.output) as {
      status: string;
      spec: { id: string; kind: string };
      missingAncestors: Array<{ id: string }>;
    };
    expect(createPayload.status).toBe("created");
    expect(createPayload.spec).toMatchObject({ id: "channels/presence/lifecycle", kind: "feature" });
    expect(createPayload.missingAncestors.map((entry) => entry.id)).toEqual(["channels", "channels/presence"]);

    const list = captureConsole(() => commands.list("channels", "feature", true));
    const listPayload = JSON.parse(list.output) as { total: number; specs: Array<{ id: string }> };
    expect(listPayload.total).toBe(1);
    expect(listPayload.specs[0]?.id).toBe("channels/presence/lifecycle");

    const got = captureConsole(() => commands.get("channels/presence/lifecycle", "full", true));
    const getPayload = JSON.parse(got.output) as {
      context: { id: string; mode: string; files: Array<{ fileName: string; exists: boolean }> };
    };
    expect(getPayload.context.id).toBe("channels/presence/lifecycle");
    expect(getPayload.context.mode).toBe("full");
    expect(getPayload.context.files.filter((file) => file.exists).map((file) => file.fileName)).toEqual([
      "SPEC.md",
      "WHY.md",
      "RUNBOOK.md",
      "CHECKS.md",
    ]);
  });

  it("syncs specs from markdown", () => {
    makeWorkspace();
    const commands = new SpecsCommands();
    captureConsole(() => commands.new("channels", "Channels", "domain", false, true));
    captureConsole(() => commands.new("channels/presence", "Presence", "capability", false, true));

    const synced = captureConsole(() => commands.sync(true));
    const payload = JSON.parse(synced.output) as { status: string; total: number };
    expect(payload).toMatchObject({ status: "synced", total: 2 });
  });

  it("prints human-readable context by default", () => {
    makeWorkspace();
    const commands = new SpecsCommands();
    captureConsole(() => commands.new("channels", "Channels", "domain", false, true));

    const got = captureConsole(() => commands.get("channels"));
    expect(got.output).toContain("# channels / SPEC.md");
    expect(got.output).toContain("This spec MUST define at least one concrete invariant.");
  });
});

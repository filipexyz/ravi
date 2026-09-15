import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { SpecsCommands } = await import("./specs.js");
const { ContractError } = await import("../agent-contract.js");

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

// Manual v2 contract: `specs` has NO braked op — `new` creates local Markdown
// (fails on existing specs) and `sync` is an idempotent local reindex, both
// declared unbraked. The contract surface is SPEC_NOT_FOUND, usage errors on
// enum flags, and compact mode on `list`.
describe("specs agent-first contract", () => {
  it("emits SPEC_NOT_FOUND envelope with suggestions on get --json (exit 1)", () => {
    makeWorkspace();
    const commands = new SpecsCommands();
    captureConsole(() => commands.new("channels", "Channels", "domain", false, true));

    let thrown: unknown;
    try {
      captureConsole(() => commands.get("chanels", "rules", true));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("specs get");
    expect(envelope.error.code).toBe("SPEC_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("channels");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("emits USAGE_ERROR envelope on invalid --mode (exit 2)", () => {
    makeWorkspace();
    const commands = new SpecsCommands();

    let thrown: unknown;
    try {
      captureConsole(() => commands.get("channels", "bogus", true));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(2);
    const envelope = contractError.envelope();
    expect(envelope.error.code).toBe("USAGE_ERROR");
    expect(envelope.error.acceptedValues).toEqual(["rules", "full", "checks", "why", "runbook"]);
  });

  it("emits USAGE_ERROR envelope on invalid --kind for list and new (exit 2)", () => {
    makeWorkspace();
    const commands = new SpecsCommands();

    let thrownList: unknown;
    try {
      captureConsole(() => commands.list(undefined, "bogus", true));
    } catch (error) {
      thrownList = error;
    }
    expect(thrownList).toBeInstanceOf(ContractError);
    expect((thrownList as InstanceType<typeof ContractError>).exitCode).toBe(2);

    let thrownNew: unknown;
    try {
      captureConsole(() => commands.new("channels", "Channels", "bogus", false, true));
    } catch (error) {
      thrownNew = error;
    }
    expect(thrownNew).toBeInstanceOf(ContractError);
    expect((thrownNew as InstanceType<typeof ContractError>).exitCode).toBe(2);
  });

  it("supports --fields compact mode on specs list", () => {
    makeWorkspace();
    const commands = new SpecsCommands();
    captureConsole(() => commands.new("channels", "Channels", "domain", false, true));

    const list = captureConsole(() => commands.list(undefined, undefined, true, undefined, undefined, "id,kind"));
    const payload = JSON.parse(list.output) as {
      items: Array<Record<string, unknown>>;
      specs: Array<Record<string, unknown>>;
    };

    expect(payload.items.length).toBe(1);
    expect(Object.keys(payload.items[0]!).sort()).toEqual(["id", "kind"]);
    expect(Object.keys(payload.specs[0]!).sort()).toEqual(["id", "kind"]);
  });

  it("keeps new and sync unbraked (no --execute required)", () => {
    makeWorkspace();
    const commands = new SpecsCommands();

    const created = captureConsole(() => commands.new("channels", "Channels", "domain", false, true));
    expect(JSON.parse(created.output)).toMatchObject({ status: "created" });

    const synced = captureConsole(() => commands.sync(true));
    expect(JSON.parse(synced.output)).toMatchObject({ status: "synced", total: 1 });
  });
});

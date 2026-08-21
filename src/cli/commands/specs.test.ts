import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { SpecsCommands, SpecsFacadeCommands, SpecsFacadeNewCommands, SpecsFacadeSyncCommands } = await import(
  "./specs.js"
);
const { ContractError } = await import("../agent-contract.js");
const { getCliOnlyMetadata, getCommandAccessMetadata } = await import("../decorators.js");
const { buildRegistry } = await import("../registry-snapshot.js");
const { buildInputSchema, buildReturnSchema } = await import("../../sdk/client-codegen/registry-shape.js");
const {
  specsFacadeApplyReturnSchema,
  specsFacadePlanReturnSchema,
  specsFacadeReadbackReturnSchema,
  specsFacadeRecoveryReturnSchema,
  specsFacadeVerificationReturnSchema,
} = await import("./operational-return-schemas.js");

setDefaultTimeout(20_000);

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

describe("SpecsFacadeCommands", () => {
  it("declares reads and local reversible writes explicitly", () => {
    const legacy = getCommandAccessMetadata(SpecsCommands);
    const facade = getCommandAccessMetadata(SpecsFacadeCommands);

    expect(legacy.get("new")).toMatchObject({ kind: "mutate", effectClass: "local-reversible" });
    expect(legacy.get("sync")).toMatchObject({ kind: "mutate", effectClass: "local-reversible" });
    expect(facade.get("plan")).toMatchObject({ kind: "read", effectClass: "none" });
    expect(facade.get("apply")).toMatchObject({ kind: "mutate", effectClass: "local-reversible" });
    expect(facade.get("readback")).toMatchObject({ kind: "read", effectClass: "none" });
    expect(facade.get("verify")).toMatchObject({ kind: "read", effectClass: "none" });
    expect(facade.get("recover")).toMatchObject({ kind: "read", effectClass: "none" });
  });

  it("keeps the generic CLI compatible while publishing operation-specific SDK contracts", () => {
    expect([...getCliOnlyMetadata(SpecsFacadeCommands)].sort()).toEqual([
      "apply",
      "plan",
      "readback",
      "recover",
      "verify",
    ]);

    const registry = buildRegistry([SpecsFacadeCommands, SpecsFacadeNewCommands, SpecsFacadeSyncCommands]);
    const generic = registry.commands.filter((command) => command.groupPath === "specs.facade");
    expect(generic).toHaveLength(5);
    expect(generic.every((command) => command.cliOnly === true)).toBe(true);

    const newPlan = registry.commands.find((command) => command.fullName === "specs.facade.new.plan")!;
    const syncPlan = registry.commands.find((command) => command.fullName === "specs.facade.sync.plan")!;
    const syncApply = registry.commands.find((command) => command.fullName === "specs.facade.sync.apply")!;
    expect(buildInputSchema(newPlan)).toMatchObject({
      type: "object",
      required: ["id", "kind", "title"],
      properties: { id: {}, kind: {}, title: {}, full: {} },
      additionalProperties: false,
    });
    expect(buildInputSchema(syncPlan)).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(buildInputSchema(syncApply)).toMatchObject({
      type: "object",
      required: ["planHash"],
      properties: { planHash: {} },
      additionalProperties: false,
    });
    expect(buildReturnSchema(newPlan)).toMatchObject({ type: "object", properties: { operation: { const: "new" } } });
    expect(buildReturnSchema(syncPlan)).toMatchObject({
      type: "object",
      properties: { operation: { const: "sync" } },
    });
  });

  it("plans without writing and applies the copied hash with independent readback", () => {
    const cwd = makeWorkspace();
    const commands = new SpecsFacadeCommands();

    const planned = captureConsole(() => commands.plan("new", "channels", "Channels", "domain", false, true));
    const plan = JSON.parse(planned.output) as { planHash: string; executable: boolean };
    expect(plan.executable).toBe(true);
    expect(existsSync(join(cwd, ".ravi"))).toBe(false);

    const applied = captureConsole(() =>
      commands.apply("new", plan.planHash, "channels", "Channels", "domain", false, true),
    );
    expect(JSON.parse(applied.output)).toMatchObject({
      operation: "new",
      state: "created",
      changed: true,
      verification: { outcome: "confirmed" },
    });

    const readback = captureConsole(() =>
      commands.readback("new", plan.planHash, "channels", "Channels", "domain", false, true),
    );
    expect(JSON.parse(readback.output)).toMatchObject({ operation: "new", files: [{ exists: true, matches: true }] });
  });

  it("publishes correlated new and sync return contracts", () => {
    makeWorkspace();
    const commands = new SpecsFacadeCommands();

    const newPlan = captureConsole(() => commands.plan("new", "channels", "Channels", "domain", false, true))
      .result as Record<string, unknown>;
    const newPlanHash = String(newPlan.planHash);
    const newApply = captureConsole(() =>
      commands.apply("new", newPlanHash, "channels", "Channels", "domain", false, true),
    ).result as Record<string, unknown>;
    const newReadback = captureConsole(() =>
      commands.readback("new", newPlanHash, "channels", "Channels", "domain", false, true),
    ).result as Record<string, unknown>;
    const newVerification = captureConsole(() =>
      commands.verify("new", newPlanHash, "channels", "Channels", "domain", false, true),
    ).result as Record<string, unknown>;
    const newRecovery = captureConsole(() =>
      commands.recover("new", newPlanHash, "channels", "Channels", "domain", false, true),
    ).result as Record<string, unknown>;

    const syncPlan = captureConsole(() => commands.plan("sync", undefined, undefined, undefined, false, true))
      .result as Record<string, unknown>;
    const syncPlanHash = String(syncPlan.planHash);
    const syncApply = captureConsole(() =>
      commands.apply("sync", syncPlanHash, undefined, undefined, undefined, false, true),
    ).result as Record<string, unknown>;
    const syncReadback = captureConsole(() =>
      commands.readback("sync", syncPlanHash, undefined, undefined, undefined, false, true),
    ).result as Record<string, unknown>;
    const syncVerification = captureConsole(() =>
      commands.verify("sync", syncPlanHash, undefined, undefined, undefined, false, true),
    ).result as Record<string, unknown>;
    const syncRecovery = captureConsole(() =>
      commands.recover("sync", syncPlanHash, undefined, undefined, undefined, false, true),
    ).result as Record<string, unknown>;

    const contractCases = [
      [specsFacadePlanReturnSchema, newPlan, syncPlan],
      [specsFacadeApplyReturnSchema, newApply, syncApply],
      [specsFacadeReadbackReturnSchema, newReadback, syncReadback],
      [specsFacadeVerificationReturnSchema, newVerification, syncVerification],
      [specsFacadeRecoveryReturnSchema, newRecovery, syncRecovery],
    ] as const;

    for (const [schema, newValue, syncValue] of contractCases) {
      expect(schema.safeParse(newValue).success).toBe(true);
      expect(schema.safeParse(syncValue).success).toBe(true);
      expect(schema.safeParse({ ...newValue, operation: "sync" }).success).toBe(false);
      expect(schema.safeParse({ ...syncValue, operation: "new" }).success).toBe(false);
    }
  });

  it("returns typed usage errors for invalid facade operation and kind", () => {
    makeWorkspace();
    const commands = new SpecsFacadeCommands();

    expect(() => captureConsole(() => commands.plan("remove", undefined, undefined, undefined, false, true))).toThrow(
      ContractError,
    );
    try {
      captureConsole(() => commands.plan("new", "channels", "Channels", "bogus", false, true));
      throw new Error("expected facade plan to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as InstanceType<typeof ContractError>).envelope().error.code).toBe("USAGE_ERROR");
    }
  });

  it("returns the stable sidecar error envelope from every facade JSON command", () => {
    makeWorkspace();
    const databasePath = join(isolatedStateDir!, "ravi.db");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE seed (value TEXT)");
    database.close();

    const commands = new SpecsFacadeCommands();
    const plan = captureConsole(() => commands.plan("sync", undefined, undefined, undefined, false, true)).result as {
      planHash: string;
    };
    writeFileSync(`${databasePath}-wal`, "partial", "utf8");

    const invocations = [
      () => commands.plan("sync", undefined, undefined, undefined, false, true),
      () => commands.apply("sync", plan.planHash, undefined, undefined, undefined, false, true),
      () => commands.readback("sync", plan.planHash, undefined, undefined, undefined, false, true),
      () => commands.verify("sync", plan.planHash, undefined, undefined, undefined, false, true),
      () => commands.recover("sync", plan.planHash, undefined, undefined, undefined, false, true),
    ];

    for (const invoke of invocations) {
      let thrown: unknown;
      try {
        captureConsole(invoke);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ContractError);
      const contractError = thrown as InstanceType<typeof ContractError>;
      expect(contractError.exitCode).toBe(1);
      expect(contractError.envelope().error.code).toBe("DB_SIDECAR_STATE_INCOMPLETE");
    }
  });
});

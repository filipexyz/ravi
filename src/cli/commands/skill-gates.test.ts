import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbGetSkillGateRule } from "../../router/router-db.js";
import { attachTagSlugsToAsset } from "../../tags/helpers.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { SkillGatesCommands } from "./skill-gates.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("skill-gates-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};

  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

describe("SkillGatesCommands", () => {
  it("creates custom rules in the skill_gate_rules table", () => {
    const commands = new SkillGatesCommands();

    commands.set("linear", "linear-skill", "^linear(?:[._]|$)");

    expect(dbGetSkillGateRule("linear")).toMatchObject({
      id: "linear",
      skill: "linear-skill",
      pattern: "^linear(?:[._]|$)",
      disabled: false,
    });
  });

  it("requires a matcher for custom rules", () => {
    const commands = new SkillGatesCommands();

    expect(() => runWithContext({}, () => commands.set("custom", "custom-skill"))).toThrow(
      "Custom skill gate rules require at least one matcher.",
    );
  });

  it("overrides, disables, and resets default rules by id", () => {
    const commands = new SkillGatesCommands();

    commands.set("image", "custom-image-skill");
    expect(dbGetSkillGateRule("image")).toMatchObject({
      id: "image",
      skill: "custom-image-skill",
      disabled: false,
    });

    commands.disable("image");
    expect(dbGetSkillGateRule("image")).toMatchObject({
      id: "image",
      disabled: true,
    });

    // The write brake makes reset dry-run by default — pass --execute to write.
    commands.reset("image", undefined, true);
    expect(dbGetSkillGateRule("image")).toBeNull();
  });

  it("lists effective defaults and configured custom rules", () => {
    const commands = new SkillGatesCommands();
    commands.set("linear", "linear-skill", "^linear(?:[._]|$)");

    const output = captureLogs(() => {
      commands.list();
    });

    expect(output).toContain("image");
    expect(output).toContain("ravi-system-image");
    expect(output).toContain("linear");
    expect(output).toContain("linear-skill");
  });

  it("filters list results by canonical skill gate tags", () => {
    const commands = new SkillGatesCommands();
    withoutLogs(() => commands.set("linear", "linear-skill", "^linear(?:[._]|$)"));
    attachTagSlugsToAsset({
      assetType: "skill_gate_rule",
      assetId: "linear",
      tags: ["ops"],
      source: "test",
    });

    const filtered = withoutLogs(() => commands.list(true, "ops"));
    const unfiltered = withoutLogs(() => commands.list(true));

    expect(filtered).toMatchObject({
      total: 1,
      filters: { tag: "ops" },
      rules: [expect.objectContaining({ id: "linear" })],
    });
    expect(unfiltered).not.toHaveProperty("filters");
  });
});

function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
  let thrown: unknown;
  try {
    withoutLogs(run);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  return thrown as InstanceType<typeof ContractError>;
}

describe("skill-gates agent-first contract", () => {
  it("emits GATE_NOT_FOUND envelope with suggestions on show --json (exit 1)", () => {
    const commands = new SkillGatesCommands();
    const contractError = expectContractError(() => runWithContext({}, () => commands.show("imagee", true)));
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("skill-gates show");
    expect(envelope.error.code).toBe("GATE_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("image");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("blocks rm without --execute (dry-run, exit 3, rule untouched)", () => {
    const commands = new SkillGatesCommands();
    withoutLogs(() => commands.set("linear", "linear-skill", "^linear(?:[._]|$)"));

    const contractError = expectContractError(() => runWithContext({}, () => commands.rm("linear", true, undefined)));
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skill-gates rm");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as { id: string; action: string };
    expect(plan.id).toBe("linear");
    expect(plan.action).toBe("delete-custom");
    // The rule survives the dry-run untouched.
    expect(dbGetSkillGateRule("linear")).not.toBeNull();
  });

  it("rm --execute deletes the custom rule", () => {
    const commands = new SkillGatesCommands();
    withoutLogs(() => commands.set("linear", "linear-skill", "^linear(?:[._]|$)"));

    const payload = withoutLogs(() => runWithContext({}, () => commands.rm("linear", true, true)));
    expect(payload).toMatchObject({ success: true, action: "deleted-custom", deleted: true });
    expect(dbGetSkillGateRule("linear")).toBeNull();
  });

  it("rm on a default id plans disable-default and only writes with --execute", () => {
    const commands = new SkillGatesCommands();

    const contractError = expectContractError(() => runWithContext({}, () => commands.rm("image", true, undefined)));
    expect(contractError.exitCode).toBe(3);
    expect((contractError.envelope().error.plan as { action: string }).action).toBe("disable-default");
    // Dry-run wrote no override row.
    expect(dbGetSkillGateRule("image")).toBeNull();

    const payload = withoutLogs(() => runWithContext({}, () => commands.rm("image", true, true)));
    expect(payload).toMatchObject({ success: true, action: "disabled-default" });
    expect(dbGetSkillGateRule("image")).toMatchObject({ id: "image", disabled: true });
  });

  it("blocks reset without --execute when an override exists (exit 3, override kept)", () => {
    const commands = new SkillGatesCommands();
    withoutLogs(() => commands.set("image", "custom-image-skill"));

    const contractError = expectContractError(() => runWithContext({}, () => commands.reset("image", true, undefined)));
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("skill-gates reset");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    const plan = envelope.error.plan as { id: string; discards: { skill: string | null } };
    expect(plan.id).toBe("image");
    expect(plan.discards.skill).toBe("custom-image-skill");
    expect(dbGetSkillGateRule("image")).not.toBeNull();
  });

  it("reset --execute discards the configured override", () => {
    const commands = new SkillGatesCommands();
    withoutLogs(() => commands.set("image", "custom-image-skill"));

    const payload = withoutLogs(() => runWithContext({}, () => commands.reset("image", true, true)));
    expect(payload).toMatchObject({ success: true, deleted: true });
    expect(dbGetSkillGateRule("image")).toBeNull();
  });

  it("reset without a configured override stays a no-op (exit 0, deleted:false)", () => {
    const commands = new SkillGatesCommands();
    const payload = withoutLogs(() => runWithContext({}, () => commands.reset("image", true, undefined)));
    expect(payload).toMatchObject({ success: true, deleted: false });
  });

  it("emits GATE_NOT_FOUND on rm of an unknown custom id even with --execute (validation before brake)", () => {
    const commands = new SkillGatesCommands();
    const contractError = expectContractError(() => runWithContext({}, () => commands.rm("no-such-gate", true, true)));
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().error.code).toBe("GATE_NOT_FOUND");
  });

  it("supports --fields compact mode on skill-gates list", () => {
    const commands = new SkillGatesCommands();
    const payload = withoutLogs(() =>
      runWithContext({}, () => commands.list(true, undefined, undefined, undefined, "id,enabled")),
    );
    expect(payload.items.length).toBeGreaterThan(0);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(["enabled", "id"]);
  });
});

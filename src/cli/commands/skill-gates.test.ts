import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbGetSkillGateRule } from "../../router/router-db.js";
import { attachTagSlugsToAsset } from "../../tags/helpers.js";
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

    commands.reset("image");
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

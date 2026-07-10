import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: { emit: mock(async () => {}) },
}));

const { createAgent } = await import("../../router/config.js");
const { RuntimeModelPresetCommands } = await import("./runtime-presets.js");

let stateDir: string | null = null;
let commands: InstanceType<typeof RuntimeModelPresetCommands>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-runtime-presets-cli-");
  commands = new RuntimeModelPresetCommands();
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("runtime presets CLI", () => {
  it("creates, shows, and lists presets with pagination metadata", () => {
    const created = commands.create("fast-sonnet", "anthropic", "sonnet", undefined, false, true);
    expect(created.action).toBe("create");
    expect(created.preset.version).toBe(1);

    const shown = commands.show("fast-sonnet", true);
    expect(shown.preset.id).toBe("fast-sonnet");
    expect(shown.referencingAgentsTotal).toBe(0);

    const listed = commands.list(undefined, false, false, true);
    expect(listed.total).toBe(1);
    expect(listed.pagination).toBeDefined();
    expect(listed.presets[0]?.id).toBe("fast-sonnet");
  });

  it("requires provider and model on create", () => {
    expect(() => commands.create("x", undefined, "sonnet", undefined, false, true)).toThrow("--provider is required");
    expect(() => commands.create("x", "anthropic", undefined, undefined, false, true)).toThrow("--model is required");
  });

  it("bumps version on real set and not on dry-run", () => {
    commands.create("rot", "anthropic", "sonnet", undefined, false, true);

    const dry = commands.set("rot", "model", "haiku", true, true);
    expect(dry.dryRun).toBe(true);
    expect(commands.show("rot", true).preset.model).toBe("sonnet");

    const real = commands.set("rot", "model", "haiku", false, true);
    expect(real.changed).toBe(true);
    expect(real.preset.version).toBe(2);
    expect(commands.show("rot", true).preset.model).toBe("haiku");
  });

  it("rejects non-model set fields", () => {
    commands.create("imm", "anthropic", "sonnet", undefined, false, true);
    expect(() => commands.set("imm", "provider", "codex", false, true)).toThrow("provider is immutable");
  });

  it("blocks disable/delete when referenced and reports impact", () => {
    commands.create("shared", "anthropic", "sonnet", undefined, false, true);
    createAgent({ id: "dev", cwd: "/tmp/dev", modelPresetId: "shared" });

    expect(() => commands.disable("shared", false, true)).toThrow(/still reference it/);
    expect(() => commands.delete("shared", false, true)).toThrow(/still reference it/);

    const impact = commands.impact("shared", true);
    expect(impact.referencingAgentsTotal).toBe(1);
    expect(impact.agents[0]?.agentId).toBe("dev");
    expect(impact.pagination).toBeDefined();
  });

  it("enables/disables/deletes an unreferenced preset", () => {
    commands.create("free", "anthropic", "sonnet", undefined, false, true);
    expect(commands.disable("free", false, true).preset.enabled).toBe(false);
    expect(commands.enable("free", false, true).preset.enabled).toBe(true);
    expect(commands.delete("free", false, true).changed).toBe(true);
    expect(() => commands.show("free", true)).toThrow(/not found/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createAgent, updateAgent } from "../router/config.js";
import {
  RuntimeModelPresetError,
  countAgentsReferencingPreset,
  createRuntimeModelPreset,
  deleteRuntimeModelPreset,
  getRuntimeModelPreset,
  getRuntimeModelPresetImpact,
  listRuntimeModelPresets,
  requireRuntimeModelPreset,
  setRuntimeModelPresetEnabled,
  setRuntimeModelPresetModel,
} from "./model-preset-store.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-model-preset-store-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("runtime model preset store", () => {
  it("creates and reads a preset with version 1", () => {
    const preset = createRuntimeModelPreset({ provider: "anthropic", id: "fast-sonnet", model: "sonnet" });
    expect(preset.id).toBe("fast-sonnet");
    expect(preset.provider).toBe("anthropic");
    expect(preset.version).toBe(1);
    expect(preset.enabled).toBe(true);
    expect(getRuntimeModelPreset("fast-sonnet")?.model).toBe("sonnet");
  });

  it("rejects duplicate ids before commit", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "dup", model: "sonnet" });
    expect(() => createRuntimeModelPreset({ provider: "anthropic", id: "dup", model: "haiku" })).toThrow(
      RuntimeModelPresetError,
    );
  });

  it("rejects invalid ids", () => {
    expect(() => createRuntimeModelPreset({ provider: "anthropic", id: "Bad Id!", model: "sonnet" })).toThrow(
      RuntimeModelPresetError,
    );
  });

  it("increments version exactly once per model mutation and no-ops when unchanged", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "rot", model: "sonnet" });
    const updated = setRuntimeModelPresetModel("rot", "haiku");
    expect(updated.version).toBe(2);
    expect(updated.model).toBe("haiku");
    const noop = setRuntimeModelPresetModel("rot", "haiku");
    expect(noop.version).toBe(2);
  });

  it("increments version exactly once per enabled mutation", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "tog", model: "sonnet" });
    const disabled = setRuntimeModelPresetEnabled("tog", false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.version).toBe(2);
    const again = setRuntimeModelPresetEnabled("tog", false);
    expect(again.version).toBe(2);
  });

  it("does not persist or bump version on dry-run", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "dry", model: "sonnet" });
    const preview = setRuntimeModelPresetModel("dry", "haiku", { dryRun: true });
    expect(preview.version).toBe(2);
    expect(preview.model).toBe("haiku");
    expect(getRuntimeModelPreset("dry")?.model).toBe("sonnet");
    expect(getRuntimeModelPreset("dry")?.version).toBe(1);
  });

  it("requireRuntimeModelPreset throws with a next command for missing presets", () => {
    try {
      requireRuntimeModelPreset("nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeModelPresetError);
      expect((err as RuntimeModelPresetError).nextCommand).toBe("ravi runtime presets list");
    }
  });

  it("lists and filters presets with pagination", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "a-one", model: "sonnet" });
    createRuntimeModelPreset({ provider: "anthropic", id: "a-two", model: "haiku", enabled: false });
    createRuntimeModelPreset({ provider: "codex", id: "c-one", model: "gpt-5.5" });

    expect(listRuntimeModelPresets().total).toBe(3);
    expect(listRuntimeModelPresets({ provider: "anthropic" }).total).toBe(2);
    expect(listRuntimeModelPresets({ enabled: false }).items.map((p) => p.id)).toEqual(["a-two"]);

    const page = listRuntimeModelPresets({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("blocks disable and delete while referenced and reports impact", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "shared", model: "sonnet" });
    createAgent({ id: "dev", cwd: "/tmp/dev", modelPresetId: "shared" });
    createAgent({ id: "ops", cwd: "/tmp/ops", modelPresetId: "shared" });

    expect(countAgentsReferencingPreset("shared")).toBe(2);
    expect(() => setRuntimeModelPresetEnabled("shared", false)).toThrow(RuntimeModelPresetError);
    expect(() => deleteRuntimeModelPreset("shared")).toThrow(RuntimeModelPresetError);

    const impact = getRuntimeModelPresetImpact("shared");
    expect(impact.referencingAgentsTotal).toBe(2);
    expect(impact.referenced).toBe(true);
    expect(impact.agents.map((a) => a.agentId).sort()).toEqual(["dev", "ops"]);
    expect(impact.agents[0]?.modelSource).toBe("agent_preset");
    expect(impact.correctionCommand).toBeTruthy();
  });

  it("allows disable and delete once unreferenced", () => {
    createRuntimeModelPreset({ provider: "anthropic", id: "free", model: "sonnet" });
    createAgent({ id: "dev", cwd: "/tmp/dev", modelPresetId: "free" });
    updateAgent("dev", { modelPresetId: null });

    expect(countAgentsReferencingPreset("free")).toBe(0);
    expect(setRuntimeModelPresetEnabled("free", false).enabled).toBe(false);
    expect(setRuntimeModelPresetEnabled("free", true).enabled).toBe(true);
    const deleted = deleteRuntimeModelPreset("free");
    expect(deleted.id).toBe("free");
    expect(getRuntimeModelPreset("free")).toBeNull();
  });
});

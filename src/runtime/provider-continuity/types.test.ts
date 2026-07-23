import { describe, expect, it } from "bun:test";
import { validateProviderContinuityPolicy } from "./policy.js";
import { PROVIDER_CONTINUITY_SNAPSHOT, PROVIDER_CONTINUITY_SPEC_VERSION } from "./types.js";

function validPolicy(): Record<string, unknown> {
  return {
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    strategy: "ordered",
    targets: [{ provider: "codex", model: "gpt-5" }],
    deadlineMs: 120_000,
    enabled: true,
  };
}

function without(key: string): unknown {
  const value = validPolicy();
  delete value[key];
  return value;
}

function withValue(key: string, value: unknown): unknown {
  return { ...validPolicy(), [key]: value };
}

function withTarget(target: unknown): unknown {
  return { ...validPolicy(), targets: [target] };
}

const negativeCases: Array<[string, unknown]> = [
  ["DC01 null policy", null],
  ["DC02 undefined policy", undefined],
  ["DC03 string policy", "policy"],
  ["DC04 array policy", []],
  ["DC05 numeric policy", 42],
  ["DC06 missing spec version", without("specVersion")],
  ["DC07 wrong spec version", withValue("specVersion", "2.0.0")],
  ["DC08 null spec version", withValue("specVersion", null)],
  ["DC09 numeric spec version", withValue("specVersion", 1)],
  ["DC10 missing snapshot", without("compatibilitySnapshotId")],
  ["DC11 wrong snapshot", withValue("compatibilitySnapshotId", "old-snapshot")],
  ["DC12 null snapshot", withValue("compatibilitySnapshotId", null)],
  ["DC13 numeric snapshot", withValue("compatibilitySnapshotId", 1)],
  ["DC14 missing strategy", without("strategy")],
  ["DC15 non-ordered strategy", withValue("strategy", "cost")],
  ["DC16 null strategy", withValue("strategy", null)],
  ["DC17 numeric strategy", withValue("strategy", 1)],
  ["DC18 missing targets", without("targets")],
  ["DC19 null targets", withValue("targets", null)],
  ["DC20 object targets", withValue("targets", {})],
  ["DC21 string targets", withValue("targets", "codex/gpt-5")],
  ["DC22 empty target chain", withValue("targets", [])],
  ["DC23 null target", withTarget(null)],
  ["DC24 string target", withTarget("codex/gpt-5")],
  ["DC25 array target", withTarget(["codex", "gpt-5"])],
  ["DC26 empty target", withTarget({})],
  ["DC27 missing provider", withTarget({ model: "gpt-5" })],
  ["DC28 missing model", withTarget({ provider: "codex" })],
  ["DC29 empty provider", withTarget({ provider: "", model: "gpt-5" })],
  ["DC30 whitespace provider", withTarget({ provider: " ", model: "gpt-5" })],
  ["DC31 empty model", withTarget({ provider: "codex", model: "" })],
  ["DC32 whitespace model", withTarget({ provider: "codex", model: " " })],
  ["DC33 numeric provider", withTarget({ provider: 1, model: "gpt-5" })],
  ["DC34 numeric model", withTarget({ provider: "codex", model: 5 })],
  ["DC35 unknown target key", withTarget({ provider: "codex", model: "gpt-5", weight: 1 })],
  [
    "DC36 duplicate target",
    withValue("targets", [
      { provider: "codex", model: "gpt-5" },
      { provider: "codex", model: "gpt-5" },
    ]),
  ],
  ["DC37 unregistered provider", withTarget({ provider: "not-registered", model: "model" })],
  ["DC38 Pi provider-only selector", withTarget({ provider: "pi", model: "openai" })],
  ["DC39 Pi missing provider prefix", withTarget({ provider: "pi", model: "/model" })],
  ["DC40 Pi missing model suffix", withTarget({ provider: "pi", model: "provider/" })],
  ["DC41 model contains whitespace", withTarget({ provider: "codex", model: "gpt 5" })],
  ["DC42 deadline below minimum", withValue("deadlineMs", 999)],
  ["DC43 deadline above maximum", withValue("deadlineMs", 3_600_001)],
  ["DC44 fractional deadline", withValue("deadlineMs", 1_000.5)],
];

describe("provider continuity data contract negatives", () => {
  it("contains the required 44 executable negative cases", () => {
    expect(negativeCases).toHaveLength(44);
  });

  for (const [name, value] of negativeCases) {
    it(name, () => {
      expect(() => validateProviderContinuityPolicy(value)).toThrow();
    });
  }
});

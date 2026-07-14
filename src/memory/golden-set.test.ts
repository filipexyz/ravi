import { describe, expect, it } from "bun:test";
import { loadGoldenSetFixtures } from "./golden-set.js";

describe("golden-set fixtures (R24)", () => {
  it("loads every fixture and validates the schema at build time", () => {
    const fixtures = loadGoldenSetFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(fixture.description.length).toBeGreaterThan(10);
      expect(fixture.candidate.identity_key).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("has at least one fixture per invariant that maps to Adaptation §5 tipos", () => {
    const fixtures = loadGoldenSetFixtures();
    const invariants = new Set(fixtures.map((f) => f.invariant));
    expect(invariants.has("R4")).toBe(true);
    expect(invariants.has("R14")).toBe(true);
    expect(invariants.has("R20")).toBe(true);
  });

  it("save fixtures never carry an existing_entry with the same identity_key and opposite content in the same slot", () => {
    // Sanity: a fixture whose action is `save` and has an existing_entry MUST
    // explicitly document the supersession (R14 in-place) — otherwise the
    // fixture is asking the curator to duplicate a live conflict.
    const conflicts = loadGoldenSetFixtures().filter(
      (f) =>
        f.expected.action === "save" && f.existing_entry && f.existing_entry.identity_key === f.candidate.identity_key,
    );
    for (const fixture of conflicts) {
      expect(fixture.invariant).toBe("R14");
      expect(fixture.expected.note ?? "").toContain("supersede");
    }
  });

  it("stage-hitl fixtures always cite R7 or an invariant that dispatches to R7 in their note", () => {
    const staged = loadGoldenSetFixtures().filter((f) => f.expected.action === "stage-hitl");
    for (const fixture of staged) {
      expect(fixture.expected.note ?? "").toMatch(/R7/i);
    }
  });
});

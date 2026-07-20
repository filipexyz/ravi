import { describe, expect, it } from "bun:test";
import { compilePredicate, evaluatePredicate } from "./predicate.js";

describe("policy predicate", () => {
  it("evaluates multiple roots with boolean precedence", () => {
    const compiled = compilePredicate(
      `source.channel == "slack" && (turn.origin == "human" || event.type == "manual")`,
      { allowedRoots: ["source", "turn", "event"] },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.predicate.roots).toEqual(["event", "source", "turn"]);
    expect(
      compiled.predicate.evaluate({
        source: { channel: "slack" },
        turn: { origin: "human" },
        event: { type: "turn.complete" },
      }),
    ).toBe(true);
  });

  it("rejects roots outside the consumer boundary", () => {
    const result = compilePredicate(`secret.token == "x"`, { allowedRoots: ["source", "turn"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not allowed");
  });

  it("lets each consumer choose invalid-expression fail mode", () => {
    expect(evaluatePredicate("invalid", {}, { failMode: "open" })).toBe(true);
    expect(evaluatePredicate("invalid", {}, { failMode: "closed" })).toBe(false);
  });

  it("never executes arbitrary JavaScript", () => {
    const result = compilePredicate(`source.constructor.constructor == "return process"`, {
      allowedRoots: ["source"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.predicate.evaluate({ source: {} })).toBe(false);
  });
});

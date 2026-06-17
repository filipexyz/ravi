import { describe, expect, test } from "bun:test";
import { evaluateHitlRequiredWhen, evaluateSendWindow } from "./pipeline-engines.js";

describe("evaluateSendWindow", () => {
  test("no window declared = allowed (fail-open)", () => {
    const result = evaluateSendWindow(undefined, new Date("2026-06-17T12:00:00Z"));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_send_window_declared");
  });

  test("within hours and days = allowed", () => {
    const at = new Date("2026-06-17T15:00:00Z"); // Wed 12:00 BRT (UTC-3)
    const result = evaluateSendWindow({ hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" }, at);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("within_window");
  });

  test("outside hours = not allowed with releaseAt next morning", () => {
    const at = new Date("2026-06-17T00:00:00Z"); // Tue 21:00 BRT (just outside 9-21)
    const result = evaluateSendWindow({ hours: "9-21", timezone: "America/Sao_Paulo" }, at);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("outside_allowed_hours");
    expect(result.releaseAtIso).toBeTruthy();
  });

  test("outside allowed days = not allowed with releaseAt next week", () => {
    // Sun 2026-06-21 15:00 UTC = Sun 12:00 BRT. mon-sat excludes Sun.
    const at = new Date("2026-06-21T15:00:00Z");
    const result = evaluateSendWindow({ hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" }, at);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside/);
    expect(result.releaseAtIso).toBeTruthy();
  });

  test("invalid hours format = fail-open allowed", () => {
    const result = evaluateSendWindow(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
      { hours: "invalid", timezone: "America/Sao_Paulo" } as any,
      new Date("2026-06-17T15:00:00Z"),
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("invalid_hours_format_failopen");
  });

  test("evaluates timezone correctly with NY", () => {
    // 2026-06-17T15:00:00Z = 11:00 EDT (NY summer = UTC-4)
    const at = new Date("2026-06-17T15:00:00Z");
    const result = evaluateSendWindow({ hours: "9-19", timezone: "America/New_York" }, at);
    expect(result.allowed).toBe(true);
  });

  test("single day allow", () => {
    // Wed 2026-06-17T15:00:00Z = Wed 12:00 BRT
    const at = new Date("2026-06-17T15:00:00Z");
    const result = evaluateSendWindow({ hours: "9-21", days: "wed", timezone: "America/Sao_Paulo" }, at);
    expect(result.allowed).toBe(true);
  });
});

describe("evaluateHitlRequiredWhen", () => {
  test("no rules = no HITL", () => {
    const result = evaluateHitlRequiredWhen(undefined, {});
    expect(result.hitlRequired).toBe(false);
    expect(result.matchedConditions).toBe(0);
  });

  test("empty conditions = no HITL", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [] }, {});
    expect(result.hitlRequired).toBe(false);
  });

  test("has_tag matches when tag present", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ has_tag: "vip" }] }, { tags: ["vip", "premium"] });
    expect(result.hitlRequired).toBe(true);
    expect(result.reasons).toContain("has_tag:vip");
  });

  test("has_tag does not match when tag absent", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ has_tag: "vip" }] }, { tags: ["regular"] });
    expect(result.hitlRequired).toBe(false);
  });

  test("lacks_tag matches when tag absent", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ lacks_tag: "consent_given" }] }, { tags: [] });
    expect(result.hitlRequired).toBe(true);
    expect(result.reasons).toContain("lacks_tag:consent_given");
  });

  test("contact_value_above matches", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ contact_value_above: 10000 }] }, { contact_value: 50000 });
    expect(result.hitlRequired).toBe(true);
    expect(result.reasons).toContain("contact_value_above:10000");
  });

  test("contact_value_above does not match when below", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ contact_value_above: 10000 }] }, { contact_value: 5000 });
    expect(result.hitlRequired).toBe(false);
  });

  test("ltv_above matches", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ ltv_above: 100000 }] }, { ltv: 250000 });
    expect(result.hitlRequired).toBe(true);
  });

  test("multiple conditions OR'd (any match triggers HITL)", () => {
    const result = evaluateHitlRequiredWhen(
      {
        conditions: [{ has_tag: "vip" }, { contact_value_above: 100000 }],
      },
      { tags: ["vip"], contact_value: 50000 },
    );
    expect(result.hitlRequired).toBe(true);
    expect(result.matchedConditions).toBe(1);
  });

  test("unknown atom type ignored (fail-open)", () => {
    const result = evaluateHitlRequiredWhen({ conditions: [{ foobar_check: true }] }, { tags: ["any"] });
    expect(result.hitlRequired).toBe(false);
  });
});

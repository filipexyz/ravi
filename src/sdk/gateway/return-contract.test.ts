import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  enforceReturnContract,
  reportReturnContractViolation,
  resetReturnContractViolationsForTest,
  returnContractViolationCount,
} from "./return-contract.js";

describe("enforceReturnContract", () => {
  beforeEach(() => resetReturnContractViolationsForTest());

  it("removes an extra field from 1 000 strict array items in one go, with a bounded violation", () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string() }).strict()) }).strict();
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, extra: i }));
    const started = performance.now();
    const result = enforceReturnContract(schema, { items });
    const elapsed = performance.now() - started;

    const sent = result.value as { items: Array<Record<string, unknown>> };
    expect(sent.items).toHaveLength(1000);
    expect(sent.items.some((item) => "extra" in item)).toBe(false);
    expect(result.violation?.exhausted).toBe(false);
    expect(result.violation?.paths.length).toBeLessThanOrEqual(50);
    expect(result.violation?.removedFields).toEqual(["items.*.extra"]);
    expect(result.violation?.truncated).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
    // The handler's own result is never mutated.
    expect((items[0] as Record<string, unknown>).extra).toBe(0);
  });

  it("settles deeply nested undeclared fields without exhausting the pass limit", () => {
    let schema: z.ZodTypeAny = z.object({ id: z.string() }).strict();
    let value: Record<string, unknown> = { id: "x", extra: 1 };
    for (let depth = 0; depth < 12; depth++) {
      schema = z.object({ child: schema }).strict();
      value = { child: value };
    }
    const result = enforceReturnContract(schema, value);
    expect(result.violation?.exhausted).toBe(false);
    expect(JSON.stringify(result.value)).not.toContain("extra");
  });

  it("keeps a valid z.date value and a transform result untouched", () => {
    const dated = z.object({ ok: z.literal(true), at: z.date() });
    const value = { ok: true as const, at: new Date(0) };
    const result = enforceReturnContract(dated, value);
    expect(result.violation).toBeNull();
    expect(result.value).toBe(value);

    const transformed = z.object({ a: z.string() }).transform((o) => ({ b: o.a }));
    const raw = { a: "x" };
    const second = enforceReturnContract(transformed, raw);
    expect(second.violation).toBeNull();
    expect(second.value).toBe(raw);
  });

  it("keeps a Date field when another field needs repair", () => {
    const schema = z.object({ at: z.date(), n: z.number() }).strict();
    const at = new Date(0);
    const result = enforceReturnContract(schema, { at, n: "bad", extra: 1 });
    expect((result.value as { at: Date }).at).toBe(at);
    expect(result.value).not.toHaveProperty("n");
    expect(result.value).not.toHaveProperty("extra");
  });

  it("reports a required field it cannot omit instead of looking repaired", () => {
    const result = enforceReturnContract(z.object({ id: z.string() }).strict(), {});
    expect(result.violation?.invalidFields).toEqual(["id"]);
  });
});

describe("reportReturnContractViolation", () => {
  beforeEach(() => resetReturnContractViolationsForTest());

  it("counts every violation, including repeats whose log line is suppressed", () => {
    const violation = {
      paths: [],
      removedFields: ["items.*.extra"],
      invalidFields: [],
      truncated: 0,
      exhausted: false,
      issues: [],
    };
    reportReturnContractViolation("demo mutate", "r1", violation, 1_000);
    reportReturnContractViolation("demo mutate", "r2", violation, 2_000);
    reportReturnContractViolation("demo mutate", "r3", violation, 62_000);
    expect(returnContractViolationCount()).toBe(3);
  });
});

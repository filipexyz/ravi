import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import { baseIdempotencyRequestHash, resolveBaseIdempotencyKey } from "./idempotency";

const INPUT = {
  operation: "console.bases.rows.create",
  baseId: "0c0c0c0c-0000-4000-8000-000000000001",
  viewId: null,
  rowId: null,
  values: { name: "Acme", amount: 10 },
  body: null,
  expectedVersion: null,
  lastWriteWins: false,
};

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsoleApiError) return error;
    throw error;
  }
  throw new Error("expected a ConsoleApiError");
}

describe("request hashes", () => {
  test("are stable across key order", () => {
    expect(baseIdempotencyRequestHash(INPUT)).toBe(baseIdempotencyRequestHash({ ...INPUT, values: { amount: 10, name: "Acme" } }));
  });

  test("change with values, body, target, or version choice", () => {
    const hash = baseIdempotencyRequestHash(INPUT);
    expect(baseIdempotencyRequestHash({ ...INPUT, values: { name: "Acme", amount: 11 } })).not.toBe(hash);
    expect(baseIdempotencyRequestHash({ ...INPUT, body: "x" })).not.toBe(hash);
    expect(baseIdempotencyRequestHash({ ...INPUT, viewId: "v" })).not.toBe(hash);
    expect(baseIdempotencyRequestHash({ ...INPUT, expectedVersion: 2 })).not.toBe(hash);
    expect(baseIdempotencyRequestHash({ ...INPUT, lastWriteWins: true })).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotency keys", () => {
  test("come from the body or the header", () => {
    expect(resolveBaseIdempotencyKey("row-create-123", null)).toBe("row-create-123");
    expect(resolveBaseIdempotencyKey(undefined, "row-create-456")).toBe("row-create-456");
    expect(resolveBaseIdempotencyKey("row-create-123", "row-create-123")).toBe("row-create-123");
  });

  test("are required, well-formed, and consistent", () => {
    for (const [body, header] of [
      [undefined, null],
      ["short", null],
      ["has spaces in it", null],
      ["row-create-123", "row-create-999"],
    ] as const) {
      const error = errorOf(() => resolveBaseIdempotencyKey(body, header));
      expect(error.status).toBe(400);
      expect(error.payload.error).toBe("validation_failed");
      expect(error.payload.fieldErrors?.idempotencyKey).toBeString();
    }
  });
});

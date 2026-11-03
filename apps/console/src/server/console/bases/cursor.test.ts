import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { BASES_LIMITS } from "@/shared/bases/limits";

import { decodeBaseCursor, encodeBaseCursor, type BaseCursorBinding } from "./cursor";

const ENV_KEYS = ["RAVI_BASES_CURSOR_SECRET", "RAVI_CLI_ACCESS_TOKEN_SECRET", "WORKOS_COOKIE_PASSWORD", "NODE_ENV"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = env[key];
  env.RAVI_BASES_CURSOR_SECRET = "test-cursor-secret-0123456789abcdef";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

const binding: BaseCursorBinding = {
  scope: "view:6e0b1a2c-0000-4000-8000-000000000001",
  viewVersion: 3,
  schemaVersion: 7,
  queryHash: "hash-abc",
  principal: "user:8e0e034f-6cce-4f10-82da-3ebf2c8b49f4",
};
const values = ["Acme", null, "2026-10-06T19:51:00.123456Z", "6e0b1a2c-0000-4000-8000-000000000002"];
const now = new Date("2026-10-06T15:00:00Z");

function expectCursorInvalid(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).status).toBe(400);
    expect((error as ConsoleApiError).payload).toEqual({ error: "cursor_invalid" });
    return;
  }
  throw new Error("expected cursor_invalid");
}

describe("bases cursors", () => {
  test("round-trips values and binding", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    expect(token.startsWith("c1.")).toBe(true);
    expect(token).toMatch(/^c1\.[A-Za-z0-9_-]+$/);
    const decoded = decodeBaseCursor(token, binding, now);
    expect(decoded.values).toEqual(values);
    expect(decoded.issuedAt).toBe(now.getTime());
    expect(decoded.scope).toBe(binding.scope);
  });

  test("is opaque: sort values do not appear in the token", () => {
    const token = encodeBaseCursor({ ...binding, values: ["very-secret-sort-value"] }, now);
    expect(token).not.toContain("very-secret");
    expect(Buffer.from(token.slice(3), "base64url").toString("latin1")).not.toContain("very-secret");
  });

  test("encrypts each cursor with a fresh IV", () => {
    expect(encodeBaseCursor({ ...binding, values }, now)).not.toBe(encodeBaseCursor({ ...binding, values }, now));
  });

  test("rejects every binding mismatch", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    const mismatches: Array<Partial<BaseCursorBinding>> = [
      { scope: "view:6e0b1a2c-0000-4000-8000-000000000009" },
      { scope: "base:6e0b1a2c-0000-4000-8000-000000000001" },
      { viewVersion: 4 },
      { schemaVersion: 8 },
      { queryHash: "hash-abd" },
      { principal: "user:1b4e28ba-2fa1-41d2-883f-0016d3cca427" },
    ];
    for (const change of mismatches) expectCursorInvalid(() => decodeBaseCursor(token, { ...binding, ...change }, now));
  });

  test("rejects expired and future cursors", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    expect(decodeBaseCursor(token, binding, new Date(now.getTime() + BASES_LIMITS.cursorTtlMs)).values).toEqual(values);
    expectCursorInvalid(() => decodeBaseCursor(token, binding, new Date(now.getTime() + BASES_LIMITS.cursorTtlMs + 1)));
    expectCursorInvalid(() => decodeBaseCursor(token, binding, new Date(now.getTime() - 5 * 60_000)));
  });

  test("rejects tampering", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    const raw = Buffer.from(token.slice(3), "base64url");
    for (const index of [0, 13, raw.length - 1, Math.floor(raw.length / 2)]) {
      const copy = Buffer.from(raw);
      copy[index] = (copy[index] as number) ^ 0x01;
      expectCursorInvalid(() => decodeBaseCursor(`c1.${copy.toString("base64url")}`, binding, now));
    }
    expectCursorInvalid(() => decodeBaseCursor(`c1.${raw.subarray(0, raw.length - 1).toString("base64url")}`, binding, now));
  });

  test("rejects malformed tokens", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    for (const bad of [null, 42, "", "c1.", "c2." + token.slice(3), token.slice(3), "c1.!!!!", "c1.abc", `c1.${"A".repeat(5000)}`]) {
      expectCursorInvalid(() => decodeBaseCursor(bad, binding, now));
    }
  });

  test("a different secret invalidates cursors", () => {
    const token = encodeBaseCursor({ ...binding, values }, now);
    env.RAVI_BASES_CURSOR_SECRET = "another-secret-0123456789abcdef";
    expectCursorInvalid(() => decodeBaseCursor(token, binding, now));
  });

  test("falls back to the next configured secret", () => {
    delete env.RAVI_BASES_CURSOR_SECRET;
    env.RAVI_CLI_ACCESS_TOKEN_SECRET = "cli-secret-0123456789abcdef";
    const token = encodeBaseCursor({ ...binding, values }, now);
    expect(decodeBaseCursor(token, binding, now).values).toEqual(values);
  });

  test("uses a per-process key outside production and refuses in production", () => {
    for (const key of ["RAVI_BASES_CURSOR_SECRET", "RAVI_CLI_ACCESS_TOKEN_SECRET", "WORKOS_COOKIE_PASSWORD"]) delete env[key];
    env.NODE_ENV = "test";
    const token = encodeBaseCursor({ ...binding, values }, now);
    expect(decodeBaseCursor(token, binding, now).values).toEqual(values);
    env.NODE_ENV = "production";
    try {
      encodeBaseCursor({ ...binding, values }, now);
      throw new Error("expected bases_cursor_unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(503);
      expect((error as ConsoleApiError).payload.error).toBe("bases_cursor_unavailable");
    }
  });

  test("rejects non-string cursor values at encode time", () => {
    expect(() => encodeBaseCursor({ ...binding, values: [1 as unknown as string] }, now)).toThrow();
  });
});

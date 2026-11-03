import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDatabaseUrl, resolveDatabaseUrl } from "./url";

const originalEnv = { ...process.env };

describe("database URL resolution", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of [
      "DATABASE_URL",
      "POSTGRES_URL",
      "POSTGRES_PRISMA_URL",
      "DATABASE_URL_UNPOOLED",
      "POSTGRES_URL_NON_POOLING",
      "RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK",
      "VERCEL",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("uses the local fallback outside Vercel", () => {
    const resolved = resolveDatabaseUrl();

    expect(resolved.isLocalFallback).toBe(true);
    expect(resolved.source).toBe("local-dev-fallback");
    expect(resolved.url).toContain("localhost:55432");
  });

  test("uses runtime pooled URLs first", () => {
    process.env.DATABASE_URL = "postgres://runtime";
    process.env.DATABASE_URL_UNPOOLED = "postgres://migration";

    const resolved = resolveDatabaseUrl();

    expect(resolved.source).toBe("DATABASE_URL");
    expect(resolved.url).toBe("postgres://runtime");
  });

  test("uses unpooled URLs first for migrations", () => {
    process.env.DATABASE_URL = "postgres://runtime";
    process.env.DATABASE_URL_UNPOOLED = "postgres://migration";

    const resolved = resolveDatabaseUrl({ purpose: "migration" });

    expect(resolved.source).toBe("DATABASE_URL_UNPOOLED");
    expect(resolved.url).toBe("postgres://migration");
  });

  test("ignores empty quoted env values", () => {
    process.env.DATABASE_URL = '""';
    process.env.POSTGRES_URL = "postgres://runtime";

    expect(resolveDatabaseUrl().source).toBe("POSTGRES_URL");
  });

  test("refuses the local fallback when explicitly disabled", () => {
    process.env.RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK = "true";

    expect(() => getDatabaseUrl()).toThrow("Refusing to use the local development database fallback");
  });

  test("refuses the local fallback when the caller disables it", () => {
    expect(() => getDatabaseUrl({ allowLocalFallback: false })).toThrow(
      "Refusing to use the local development database fallback",
    );
  });
});

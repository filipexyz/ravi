import { afterEach, describe, expect, test } from "bun:test";

import { isAnonymousModeEnabled } from "./config";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  RAVI_CONSOLE_ANONYMOUS_MODE: process.env.RAVI_CONSOLE_ANONYMOUS_MODE,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

afterEach(() => {
  restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  restoreEnv("RAVI_CONSOLE_ANONYMOUS_MODE", originalEnv.RAVI_CONSOLE_ANONYMOUS_MODE);
  restoreEnv("VERCEL", originalEnv.VERCEL);
  restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
});

describe("console auth config", () => {
  test("allows anonymous mode only outside hosted production runtimes", () => {
    process.env.RAVI_CONSOLE_ANONYMOUS_MODE = "true";
    setEnv("NODE_ENV", "development");
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    expect(isAnonymousModeEnabled()).toBe(true);

    setEnv("NODE_ENV", "production");
    expect(isAnonymousModeEnabled()).toBe(false);

    setEnv("NODE_ENV", "development");
    process.env.VERCEL_ENV = "preview";
    expect(isAnonymousModeEnabled()).toBe(false);
  });
});

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

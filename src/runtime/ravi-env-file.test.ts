import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  RAVI_ENV_ALLOWLIST,
  RaviEnvFileError,
  getRaviEnvFilePath,
  getRaviEnvKey,
  setRaviEnvKey,
  unsetRaviEnvKey,
} from "./ravi-env-file.js";

describe("ravi-env-file", () => {
  let previous: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await createIsolatedRaviState("ravi-env-file-");
    previous = {
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CODEX_HOME: process.env.CODEX_HOME,
    };
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CODEX_HOME;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanupIsolatedRaviState(process.env.RAVI_STATE_DIR);
  });

  it("writes allowlisted keys atomically with mode 0600 and redacts secrets on get", () => {
    const token = "sk-ant-oat01-super-secret-token";
    const mutation = setRaviEnvKey("CLAUDE_CODE_OAUTH_TOKEN", token);
    expect(mutation.action).toBe("set");
    expect(mutation.present).toBe(true);
    expect(mutation.redacted).toBe(true);
    expect(mutation.value).toBe("[REDACTED]");
    expect(mutation.daemonReloadRequired).toBe(true);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);

    const path = getRaviEnvFilePath();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${token}`);

    const got = getRaviEnvKey("CLAUDE_CODE_OAUTH_TOKEN");
    expect(got.value).toBe("[REDACTED]");
    expect(JSON.stringify(got)).not.toContain(token);
  });

  it("returns non-secret allowlisted values and fails closed on unknown keys", () => {
    setRaviEnvKey("CODEX_HOME", "/tmp/ravi-codex");
    expect(getRaviEnvKey("CODEX_HOME").value).toBe("/tmp/ravi-codex");

    expect(() => setRaviEnvKey("OPENAI_API_KEY", "sk-secret")).toThrow(RaviEnvFileError);
    try {
      setRaviEnvKey("OPENAI_API_KEY", "sk-secret");
    } catch (err) {
      expect(err).toBeInstanceOf(RaviEnvFileError);
      expect((err as RaviEnvFileError).code).toBe("ENV_KEY_NOT_ALLOWED");
      expect((err as Error).message).toContain(RAVI_ENV_ALLOWLIST[0]);
      expect((err as Error).message).not.toContain("sk-secret");
    }
  });

  it("rejects newlines and unsets keys without leaking values", () => {
    expect(() => setRaviEnvKey("CODEX_HOME", "one\ntwo")).toThrow(/newlines/);
    setRaviEnvKey("CODEX_HOME", "/tmp/a");
    const unset = unsetRaviEnvKey("CODEX_HOME");
    expect(unset.present).toBe(false);
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(readFileSync(getRaviEnvFilePath(), "utf8")).not.toContain("CODEX_HOME=");
  });

  it("preserves comments and other assignments when updating one key", () => {
    setRaviEnvKey("CODEX_HOME", "/tmp/a");
    const path = getRaviEnvFilePath();
    chmodSync(path, 0o600);
    const existing = `# keep me\nCODEX_HOME=/tmp/a\nGROK_HOME=/tmp/g\n`;
    writeFileSync(path, existing, { mode: 0o600 });
    setRaviEnvKey("CODEX_HOME", "/tmp/b");
    const next = readFileSync(path, "utf8");
    expect(next).toContain("# keep me");
    expect(next).toContain("CODEX_HOME=/tmp/b");
    expect(next).toContain("GROK_HOME=/tmp/g");
  });
});

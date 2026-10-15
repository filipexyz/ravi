import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildRemoteEnvSetup } from "./remote-spawn.js";

const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL"];

/** Execute the SSH export script in a real shell and read its forwarded values. */
function readRemoteEnv(
  env: Record<string, string>,
  host = "127.0.0.1",
  hostEnv: Record<string, string | undefined> = {},
) {
  const setup = buildRemoteEnvSetup(host, env, hostEnv);
  const probe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))))`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const result = spawnSync("/bin/sh", ["-c", `${setup}exec ${quote(process.execPath)} -e ${quote(probe)}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string | null>;
}

describe("SSH remote runtime environment", () => {
  it("preserves a single credential without appending a literal newline escape", () => {
    expect(readRemoteEnv({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token" }).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "synthetic-token",
    );
  });

  it("preserves auth, scoped context and gateway byte-for-byte through a real shell", () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-'token' $HOME `false` $(false)\\n\nsecond line",
      ANTHROPIC_API_KEY: "synthetic-api-key",
      RAVI_CONTEXT_KEY: "synthetic-context",
      RAVI_GATEWAY_URL: "https://gateway.example:7777",
    };
    expect(readRemoteEnv(env)).toEqual(env);
  });

  it("forwards only the allowlisted runtime variables", () => {
    const setup = buildRemoteEnvSetup(
      "worker.example",
      { RAVI_CONTEXT_KEY: "synthetic", UNRELATED_SECRET: "not-forwarded" },
      {},
    );
    expect(setup).not.toContain("UNRELATED_SECRET");
    expect(setup).not.toContain("not-forwarded");
    expect(buildRemoteEnvSetup("worker.example", { UNRELATED_SECRET: "not-forwarded" }, {})).toBe("");
  });

  it("derives a gateway only for loopback SSH hosts with an enabled HTTP server", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(readRemoteEnv({}, host, { RAVI_HTTP_PORT: "7777" }).RAVI_GATEWAY_URL).toBe("http://127.0.0.1:7777");
    }
    expect(readRemoteEnv({}, "worker.example", { RAVI_HTTP_PORT: "7777" }).RAVI_GATEWAY_URL).toBeNull();
    for (const port of ["", "0", "-1", "65536", "not-a-port"]) {
      expect(readRemoteEnv({}, "127.0.0.1", { RAVI_HTTP_PORT: port }).RAVI_GATEWAY_URL).toBeNull();
    }
  });

  it("respects explicit gateway URLs before deriving one from the daemon", () => {
    expect(
      readRemoteEnv({ RAVI_GATEWAY_URL: "https://explicit.example" }, "127.0.0.1", { RAVI_HTTP_PORT: "7777" })
        .RAVI_GATEWAY_URL,
    ).toBe("https://explicit.example");
    expect(readRemoteEnv({}, "worker.example", { RAVI_GATEWAY_URL: "https://daemon.example" }).RAVI_GATEWAY_URL).toBe(
      "https://daemon.example",
    );
    expect(
      readRemoteEnv({}, "localhost", { RAVI_WEBHOOK_PORT: "7777", RAVI_WEBHOOK_HOST: "::1" }).RAVI_GATEWAY_URL,
    ).toBe("http://[::1]:7777");
  });

  it("does not revive the webhook port alias when the HTTP port is explicitly disabled", () => {
    for (const port of ["", "   "]) {
      expect(
        readRemoteEnv({}, "localhost", { RAVI_HTTP_PORT: port, RAVI_WEBHOOK_PORT: "7777" }).RAVI_GATEWAY_URL,
      ).toBeNull();
    }
  });

  it("normalizes the preferred listener host and its alias before selecting IPv6", () => {
    for (const hostEnv of [
      { RAVI_HTTP_PORT: "7777", RAVI_HTTP_HOST: " ::1 " },
      { RAVI_HTTP_PORT: "7777", RAVI_WEBHOOK_HOST: " ::1 " },
      { RAVI_HTTP_PORT: "7777", RAVI_HTTP_HOST: "   ", RAVI_WEBHOOK_HOST: " ::1 " },
    ]) {
      expect(readRemoteEnv({}, "localhost", hostEnv).RAVI_GATEWAY_URL).toBe("http://[::1]:7777");
    }
  });
});

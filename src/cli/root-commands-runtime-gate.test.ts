import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(60_000);

const stateDir = mkdtempSync(join(tmpdir(), "ravi-root-gate-"));
const credentialsFile = join(stateDir, "cloud-auth", "credentials.json");
mkdirSync(join(stateDir, "cloud-auth"), { recursive: true });
writeFileSync(credentialsFile, "{}");

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

function runCli(args: string[], contextKey?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, RAVI_STATE_DIR: stateDir, HOME: stateDir };
  for (const key of [
    "RAVI_CONTEXT_KEY",
    "RAVI_GATEWAY_URL",
    "RAVI_SESSION_KEY",
    "RAVI_SESSION_NAME",
    "RAVI_AGENT_ID",
    "RAVI_CHANNEL",
    "RAVI_ACCOUNT_ID",
    "RAVI_CHAT_ID",
  ]) {
    delete env[key];
  }
  if (contextKey) env.RAVI_CONTEXT_KEY = contextKey;
  return spawnSync("bun", ["src/cli/index.ts", ...args], { cwd: process.cwd(), encoding: "utf8", env });
}

describe("root commands inside a runtime context", () => {
  for (const args of [
    ["logout", "--json"],
    ["login", "--json", "--no-open"],
    ["whoami", "--json"],
    ["update", "--json"],
  ]) {
    it(`refuses ravi ${args[0]} with CLI_ONLY_COMMAND`, () => {
      const result = runCli(args, "rctx_dummy_root_gate");
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("CLI_ONLY_COMMAND");
    });
  }

  it("refuses ravi stream before subscribing to anything", () => {
    const result = runCli(["stream", "--topic", ">"], "rctx_dummy_root_gate");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot run from a turn inside a runtime session");
    expect(result.stdout).not.toContain('"type":"hello"');
  });

  it("leaves the operator's Console credentials in place", () => {
    runCli(["logout", "--json"], "rctx_dummy_root_gate");
    expect(existsSync(credentialsFile)).toBe(true);
  });

  it("sends an app alias through apps run and the gateway instead of running it in-process", () => {
    const local = runCli(["youtube", "check", "--json"]);
    expect(local.status).toBe(0);

    const result = runCli(["youtube", "check", "--json"], "rctx_dummy_root_gate");
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("GATEWAY_REQUIRED");
    expect(envelope.op).toBe("apps run");
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { buildRegistry } from "../registry-snapshot.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { ContractError } from "../agent-contract.js";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualCliContextModule,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { RuntimeEnvCommands } = await import("./runtime-env.js");

function captureConsole<T>(fn: () => T): { output: string; result: T } {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    return { output: logs.join("\n"), result: fn() };
  } finally {
    console.log = originalLog;
  }
}

async function captureConsoleAsync<T>(fn: () => Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    return { output: logs.join("\n"), result: await fn() };
  } finally {
    console.log = originalLog;
  }
}

describe("RuntimeEnvCommands", () => {
  let previousToken: string | undefined;

  beforeEach(async () => {
    previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await createIsolatedRaviState("ravi-runtime-env-cli-");
  });

  afterEach(async () => {
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    await cleanupIsolatedRaviState(process.env.RAVI_STATE_DIR);
  });

  it("sets and gets a secret key without echoing the value", async () => {
    const commands = new RuntimeEnvCommands();
    const token = "sk-ant-oat01-cli-secret";
    const set = await captureConsoleAsync(() => commands.set("CLAUDE_CODE_OAUTH_TOKEN", token, false, true));
    expect(set.output).not.toContain(token);
    expect(set.result).toMatchObject({ key: "CLAUDE_CODE_OAUTH_TOKEN", value: "[REDACTED]", redacted: true });

    const got = captureConsole(() => commands.get("CLAUDE_CODE_OAUTH_TOKEN", true));
    expect(got.output).not.toContain(token);
    expect(got.result).toMatchObject({ present: true, value: "[REDACTED]" });
  });

  it("reads --stdin without a TTY and fails closed on unknown keys", async () => {
    const commands = new RuntimeEnvCommands();
    const token = "sk-ant-oat01-stdin-secret";
    const stdin = Readable.from([token]);
    (stdin as unknown as { isTTY: boolean }).isTTY = false;
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    try {
      const set = await captureConsoleAsync(() => commands.set("CLAUDE_CODE_OAUTH_TOKEN", undefined, true, true));
      expect(set.output).not.toContain(token);
      expect(set.result).toMatchObject({ present: true, redacted: true });
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
    }

    try {
      await commands.set("OPENAI_API_KEY", "sk-nope", false, true);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).code).toBe("ENV_KEY_NOT_ALLOWED");
      expect((err as ContractError).exitCode).toBe(2);
      expect(JSON.stringify((err as ContractError).envelope())).not.toContain("sk-nope");
    }
  });

  it("unsets keys and registers gateway routes", async () => {
    const commands = new RuntimeEnvCommands();
    await captureConsoleAsync(() => commands.set("GROK_DISABLE_AUTOUPDATER", "1", false, true));
    const unset = captureConsole(() => commands.unset("GROK_DISABLE_AUTOUPDATER", true));
    expect(unset.result).toMatchObject({ action: "unset", present: false, key: "GROK_DISABLE_AUTOUPDATER" });

    const table = buildRouteTable(buildRegistry([RuntimeEnvCommands]));
    expect([...table.byPath.keys()].sort()).toEqual([
      "/api/v1/runtime/env/get",
      "/api/v1/runtime/env/set",
      "/api/v1/runtime/env/unset",
    ]);
  });
});

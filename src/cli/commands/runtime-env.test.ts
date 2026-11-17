import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Pm2Process } from "../../pm2.js";
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
const noManagedProcesses = { processes: (): Pm2Process[] => [], cliBundle: (): string | undefined => undefined };

function captureConsole<T>(fn: () => T): { output: string; result: T } {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    const result = fn();
    return { output: logs.join("\n"), result };
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
    const result = await fn();
    return { output: logs.join("\n"), result };
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
    const commands = new RuntimeEnvCommands(noManagedProcesses);
    const token = "sk-ant-oat01-cli-secret";
    const set = await captureConsoleAsync(() => commands.set("CLAUDE_CODE_OAUTH_TOKEN", token, false, true));
    expect(set.output).not.toContain(token);
    expect(set.result).toMatchObject({ key: "CLAUDE_CODE_OAUTH_TOKEN", value: "[REDACTED]", redacted: true });

    const got = captureConsole(() => commands.get("CLAUDE_CODE_OAUTH_TOKEN", true));
    expect(got.output).not.toContain(token);
    expect(got.result).toMatchObject({ present: true, value: "[REDACTED]" });
  });

  it("reads --stdin without a TTY and fails closed on unknown keys", async () => {
    const commands = new RuntimeEnvCommands(noManagedProcesses);
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
    const commands = new RuntimeEnvCommands(noManagedProcesses);
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

  it("warns in JSON and text when an env write leaves live siblings behind, without disclosing the value", async () => {
    const cwd = join(process.env.RAVI_STATE_DIR!, "runtime");
    const bundlePath = join(cwd, "dist", "bundle", "index.js");
    mkdirSync(join(bundlePath, ".."), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.1.0" }));
    writeFileSync(bundlePath, "// fixture\n");
    const processes = ["ravi", "ravi-channels"].map(
      (name, index): Pm2Process => ({
        name,
        pm_id: index,
        pid: 700_001 + index,
        status: "online",
        cpu: 0,
        memory: 0,
        execPath: name === "ravi" ? bundlePath : process.execPath,
        cwd,
        args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
        createdAt: 1,
        startedAt: 1,
      }),
    );
    const commands = new RuntimeEnvCommands({ processes: () => processes, cliBundle: () => bundlePath });
    const token = "sk-ant-oat01-env-warning-secret";
    const result = await captureConsoleAsync(() => commands.set("CLAUDE_CODE_OAUTH_TOKEN", token, false, true));
    expect(result.output).not.toContain(token);
    expect(
      result.result.warnings.some((warning) => warning.includes("ravi daemon restart") && warning.includes("env")),
    ).toBe(true);
    expect(
      result.result.warnings.some(
        (warning) =>
          warning.includes("ravi-channels") && warning.includes("ravi channels restart") && warning.includes("env"),
      ),
    ).toBe(true);
    expect(JSON.parse(result.output).warnings).toEqual(result.result.warnings);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const unset = captureConsole(() => commands.unset("CLAUDE_CODE_OAUTH_TOKEN"));
      expect(unset.result.warnings).not.toHaveLength(0);
      expect(warnings.join("\n")).toContain("ravi channels restart");
      expect(warnings.join("\n")).not.toContain(token);
    } finally {
      console.warn = originalWarn;
    }
  });
});

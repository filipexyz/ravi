import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getAgent } from "../../router/config.js";
import { buildRegistry } from "../registry-snapshot.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { ContractError } from "../agent-contract.js";
import type { DeviceLoginProcess } from "../../runtime/provider-device-login.js";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualCliContextModule,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { RuntimeProvidersClaudeCommands, RuntimeProvidersCodexLoginCommands, RuntimeProvidersGrokLoginCommands } =
  await import("./runtime-providers.js");

function fakeProcess(prompt: string, pid = 4242): DeviceLoginProcess {
  const stdout = new EventEmitter();
  queueMicrotask(() => stdout.emit("data", prompt));
  return {
    pid,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
    unref() {},
    kill() {
      return true;
    },
  };
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

describe("RuntimeProvidersCommands", () => {
  let previousToken: string | undefined;

  beforeEach(async () => {
    previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await createIsolatedRaviState("ravi-runtime-providers-cli-");
  });

  afterEach(async () => {
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    await cleanupIsolatedRaviState(process.env.RAVI_STATE_DIR);
  });

  it("configures Claude OAuth without echoing the token and can set the agent provider", async () => {
    const commands = new RuntimeProvidersClaudeCommands();
    const token = "sk-ant-oat01-configure-secret";
    const result = await captureConsoleAsync(() =>
      commands.configure(token, false, "main", "claude-oauth", true, true),
    );
    expect(result.output).not.toContain(token);
    const payload = result.result as {
      env: { redacted: boolean; value: string };
      credential: { id: string; authMethod: string; agentAllowlist: string[] };
      agents: Array<{ id: string; provider: string; changed: boolean }>;
    };
    expect(payload.env).toMatchObject({ redacted: true, value: "[REDACTED]" });
    expect(payload.credential.authMethod).toBe("claude-oauth");
    expect(payload.credential.agentAllowlist).toEqual(["main"]);
    expect(payload.agents).toEqual([{ id: "main", provider: "claude", changed: true }]);
    expect(getAgent("main")?.provider).toBe("claude");
    expect(JSON.stringify(payload.credential)).not.toContain(token);
  });

  it("starts, authorizes, and completes a Codex device login", async () => {
    const commands = new RuntimeProvidersCodexLoginCommands({
      spawn: () =>
        fakeProcess(`
1. Open this link
 https://auth.openai.com/codex/device
2. Enter this one-time code
 ABCD-EFGH
`),
      isPidAlive: () => true,
      sleep: async () => {},
      startTimeoutMs: 200,
    });
    const started = await captureConsoleAsync(() => commands.start(true));
    const startPayload = started.result as {
      login: { id: string; verificationUrl: string; userCode: string; home: string };
    };
    expect(startPayload.login.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(startPayload.login.userCode).toBe("ABCD-EFGH");

    try {
      commands.complete(startPayload.login.id, "main", "codex-home", false, true);
      throw new Error("expected pending complete to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).code).toBe("LOGIN_NOT_READY");
      expect((err as ContractError).details.retryable).toBe(true);
    }

    writeFileSync(join(startPayload.login.home, "auth.json"), '{"ok":true}\n', { mode: 0o600 });
    const status = captureConsole(() => commands.status(startPayload.login.id, true));
    expect(status.result.login.status).toBe("authorized");

    const completed = captureConsole(() => commands.complete(startPayload.login.id, "main", "codex-home", false, true));
    const completePayload = completed.result as {
      credential: { runtimeProvider: string; authMethod: string };
    };
    expect(completePayload.credential).toMatchObject({ runtimeProvider: "codex", authMethod: "codex-profile" });
  });

  it("cancels a Grok login and maps not-found to the contract envelope", async () => {
    const commands = new RuntimeProvidersGrokLoginCommands({
      spawn: () => fakeProcess("Visit https://auth.x.ai/device and enter code: WXYZ-1234\n"),
      isPidAlive: () => true,
      killPid: () => {},
      sleep: async () => {},
      startTimeoutMs: 200,
    });
    const started = await captureConsoleAsync(() => commands.start(true));
    const id = started.result.login.id;
    const cancelled = captureConsole(() => commands.cancel(id, true));
    expect(cancelled.result.login.status).toBe("cancelled");

    try {
      commands.status("plogin_missing", true);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).code).toBe("LOGIN_NOT_FOUND");
      expect((err as ContractError).exitCode).toBe(1);
    }
  });

  it("registers the Hub gateway paths", () => {
    const table = buildRouteTable(
      buildRegistry([
        RuntimeProvidersClaudeCommands,
        RuntimeProvidersCodexLoginCommands,
        RuntimeProvidersGrokLoginCommands,
      ]),
    );
    expect([...table.byPath.keys()].sort()).toEqual([
      "/api/v1/runtime/providers/claude/configure",
      "/api/v1/runtime/providers/codex/login/cancel",
      "/api/v1/runtime/providers/codex/login/complete",
      "/api/v1/runtime/providers/codex/login/start",
      "/api/v1/runtime/providers/codex/login/status",
      "/api/v1/runtime/providers/grok/login/cancel",
      "/api/v1/runtime/providers/grok/login/complete",
      "/api/v1/runtime/providers/grok/login/start",
      "/api/v1/runtime/providers/grok/login/status",
    ]);
  });
});

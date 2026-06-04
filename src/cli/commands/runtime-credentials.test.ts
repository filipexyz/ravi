import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { RuntimeCredentialsCommands } from "./runtime-credentials.js";

let stateDir: string | null = null;
let previousStateDir: string | undefined;

function captureConsole(fn: () => unknown): { output: string; result: unknown } {
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

async function captureConsoleAsync(fn: () => Promise<unknown>): Promise<{ output: string; result: unknown }> {
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

describe("RuntimeCredentialsCommands", () => {
  beforeEach(async () => {
    previousStateDir = process.env.RAVI_STATE_DIR;
    stateDir = await createIsolatedRaviState("ravi-runtime-credentials-cli-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    if (previousStateDir) process.env.RAVI_STATE_DIR = previousStateDir;
    previousStateDir = undefined;
  });

  it("adds and lists credential pools as redacted JSON", () => {
    const commands = new RuntimeCredentialsCommands();
    const added = captureConsole(() =>
      commands.add(
        "codex",
        "OpenAI primary",
        "openai",
        "api-key",
        "RAVI_TEST_OPENAI_KEY",
        "OPENAI_API_KEY",
        undefined,
        "gpt-5",
        "dev",
        "coding",
        "7",
        true,
        undefined,
        false,
        true,
      ),
    );

    expect(added.output).not.toContain("RAVI_TEST_OPENAI_KEY");
    expect(added.output).toContain("RAVI_TEST_[redacted]");
    const addPayload = JSON.parse(added.output) as {
      credential: {
        id: string;
        priority: number;
        remoteForwardEnvKeys: string[];
        bindings: Array<{ secretRef: string; targetName: string; remoteForward: boolean }>;
      };
    };
    expect(addPayload.credential.priority).toBe(7);
    expect(addPayload.credential.bindings[0]).toMatchObject({
      secretRef: "env:RAVI_TEST_[redacted]",
      targetName: "OPENAI_API_[redacted]",
      remoteForward: true,
    });

    const listed = captureConsole(() => commands.list("codex", "openai", undefined, false, true, "10", "0"));
    const listPayload = JSON.parse(listed.output) as {
      total: number;
      pagination: { limit: number; offset: number; returned: number; hasMore: boolean };
      credentials: Array<{ id: string; label: string }>;
    };
    expect(listPayload.total).toBe(1);
    expect(listPayload.pagination).toMatchObject({ limit: 10, offset: 0, returned: 1, hasMore: false });
    expect(listPayload.credentials[0]).toMatchObject({ id: addPayload.credential.id, label: "OpenAI primary" });
  });

  it("classifies and records a provider failure for a credential", () => {
    const commands = new RuntimeCredentialsCommands();
    const added = captureConsole(() =>
      commands.add(
        "codex",
        "OpenAI primary",
        "openai",
        "api-key",
        "RAVI_TEST_OPENAI_KEY",
        "OPENAI_API_KEY",
        undefined,
        undefined,
        undefined,
        undefined,
        "0",
        false,
        undefined,
        false,
        true,
      ),
    );
    const credentialId = (JSON.parse(added.output) as { credential: { id: string } }).credential.id;

    const classified = captureConsole(() =>
      commands.classify(
        "codex",
        "429",
        "openai",
        credentialId,
        undefined,
        "rate_limit_error",
        "Rate limit near pool threshold",
        JSON.stringify({
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          authorization: "Bearer sk-test_secret_that_must_not_leak",
        }),
        true,
        true,
      ),
    );
    const payload = JSON.parse(classified.output) as {
      signal: { kind: string; rawHeaders: Record<string, string> };
      pressure: { nearLimit: boolean; exhausted: boolean };
      transition: { credential: { id: string; status: string }; health: { lastFailureKind: string } };
    };

    expect(payload.signal.kind).toBe("rate_limited");
    expect(payload.signal.rawHeaders.authorization).toBe("[redacted]");
    expect(payload.pressure).toMatchObject({ nearLimit: true, exhausted: true });
    expect(payload.transition.credential).toMatchObject({ id: credentialId, status: "cooldown" });
    expect(payload.transition.health.lastFailureKind).toBe("rate_limited");
    expect(classified.output).not.toContain("sk-test_secret_that_must_not_leak");
  });

  it("refreshes a pool and reports redacted JSON", async () => {
    const commands = new RuntimeCredentialsCommands();
    const added = captureConsole(() =>
      commands.add(
        "codex",
        "OpenAI primary",
        "openai",
        "api-key",
        "RAVI_TEST_OPENAI_KEY",
        "OPENAI_API_KEY",
        undefined,
        undefined,
        undefined,
        undefined,
        "0",
        false,
        undefined,
        false,
        true,
      ),
    );
    const credentialId = (JSON.parse(added.output) as { credential: { id: string } }).credential.id;
    captureConsole(() =>
      commands.classify(
        "codex",
        "429",
        "openai",
        credentialId,
        undefined,
        "rate_limit_error",
        "Rate limited",
        JSON.stringify({ "x-ratelimit-reset-requests": "Wed, 01 Jan 2020 00:00:00 GMT" }),
        true,
        true,
      ),
    );

    const refreshed = await captureConsoleAsync(() =>
      commands.refresh(undefined, "codex", "openai", undefined, undefined, undefined, false, true),
    );
    const payload = JSON.parse(refreshed.output) as {
      refreshed: Array<{ credentialId: string; action: string; statusAfter: string }>;
    };

    expect(payload.refreshed).toContainEqual(
      expect.objectContaining({
        credentialId,
        action: "recovered",
        statusAfter: "healthy",
      }),
    );
    expect(refreshed.output).not.toContain("RAVI_TEST_OPENAI_KEY");
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { RuntimeCredentialsCommands } = await import("./runtime-credentials.js");
const { ContractError } = await import("../agent-contract.js");

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

describe("runtime credentials agent-first contract", () => {
  beforeEach(async () => {
    previousStateDir = process.env.RAVI_STATE_DIR;
    stateDir = await createIsolatedRaviState("ravi-runtime-credentials-contract-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    if (previousStateDir) process.env.RAVI_STATE_DIR = previousStateDir;
    previousStateDir = undefined;
  });

  function addCredential(commands: InstanceType<typeof RuntimeCredentialsCommands>, label = "OpenAI primary"): string {
    const added = captureConsole(() =>
      commands.add(
        "codex",
        label,
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
    return (JSON.parse(added.output) as { credential: { id: string } }).credential.id;
  }

  it("emits CREDENTIAL_NOT_FOUND envelope with suggestions on status --json (exit 1)", () => {
    const commands = new RuntimeCredentialsCommands();
    const credentialId = addCredential(commands);

    let thrown: unknown;
    const captured = captureConsole(() => {
      try {
        commands.status("rc_nope", true);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("runtime credentials status");
    expect(envelope.error.code).toBe("CREDENTIAL_NOT_FOUND");
    expect(envelope.error.suggestions).toEqual(expect.arrayContaining([expect.any(String)]));
    const candidatePool = [credentialId, "OpenAI primary"];
    for (const suggestion of envelope.error.suggestions as string[]) {
      expect(candidatePool).toContain(suggestion);
    }
    // Anti-leak: the envelope carries ids/labels only — never secret env names
    // or secret values.
    const serialized = JSON.stringify(envelope) + captured.output;
    expect(serialized).not.toContain("RAVI_TEST_OPENAI_KEY");
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });

  it("maps store not-found errors on disable to CREDENTIAL_NOT_FOUND (exit 1)", () => {
    const commands = new RuntimeCredentialsCommands();
    addCredential(commands);

    let thrown: unknown;
    captureConsole(() => {
      try {
        commands.disable("rc_missing", true);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().op).toBe("runtime credentials disable");
    expect(contractError.envelope().error.code).toBe("CREDENTIAL_NOT_FOUND");
  });

  it("maps refresh of an unknown credential to CREDENTIAL_NOT_FOUND (exit 1)", async () => {
    const commands = new RuntimeCredentialsCommands();

    let thrown: unknown;
    await captureConsoleAsync(async () => {
      try {
        await commands.refresh("rc_missing", undefined, undefined, undefined, undefined, undefined, false, true);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().op).toBe("runtime credentials refresh");
    expect(contractError.envelope().error.code).toBe("CREDENTIAL_NOT_FOUND");
  });

  it("supports --fields compact mode on runtime credentials list", () => {
    const commands = new RuntimeCredentialsCommands();
    const credentialId = addCredential(commands);

    const listed = captureConsole(() =>
      commands.list(undefined, undefined, undefined, true, true, undefined, undefined, "id,label"),
    );
    const payload = JSON.parse(listed.output) as { credentials: Array<Record<string, unknown>> };
    expect(payload.credentials.length).toBe(1);
    expect(Object.keys(payload.credentials[0]).sort()).toEqual(["id", "label"]);
    expect(payload.credentials[0].id).toBe(credentialId);
  });
});

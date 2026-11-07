import { afterEach, describe, expect, it, mock } from "bun:test";
import type { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { writeSecret } from "./backends.js";
import { CredentialBrokerError } from "./errors.js";

const originalService = process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;

afterEach(() => {
  if (originalService === undefined) delete process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;
  else process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = originalService;
});

function processResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { status: 0, signal: null, pid: 123, output: [], stdout: "", stderr: "", ...overrides };
}

function runner(result = processResult()) {
  const calls: Array<{ file: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding }> = [];
  const run = mock((file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    calls.push({ file, args, options });
    return result;
  });
  return { calls, run: run as unknown as typeof spawnSync };
}

describe("Keychain secret writes", () => {
  it("sends one hex-encoded command on stdin, never secrets in argv or environment", async () => {
    const secret = 'fake-api-token "quote" \\ backslash $(`never-run`) ;\nsecond line\r\tç';
    const fixture = runner();
    const ref = await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret },
      { spawnSync: fixture.run },
    );

    expect(ref).toContain("/slack:tests");
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0]!;
    expect(call.file).toBe("/usr/bin/security");
    expect(call.args).toEqual(["-i", "-q"]);
    expect(JSON.stringify({ file: call.file, args: call.args, env: call.options.env })).not.toContain(secret);
    const command = String(call.options.input);
    expect(command.split("\n")).toHaveLength(2);
    expect(command).toMatch(/^add-generic-password -a "slack:tests" -s ".+" -X [a-f0-9]+ -U\n$/);
    const hex = command.match(/ -X ([a-f0-9]+) -U\n$/)?.[1];
    expect(Buffer.from(hex!, "hex").toString("utf8")).toBe(secret);
    expect(call.options.stdio).toEqual(["pipe", "ignore", "ignore"]);
    expect(call.options.timeout).toBe(5_000);
    expect(call.options.killSignal).toBe("SIGKILL");
  });

  it("encodes provider JSON with quotes and preserves whitespace without a command-language escape", async () => {
    const secret = JSON.stringify({ appToken: "test-app-token", botToken: "test-bot-token" }, null, 2);
    const fixture = runner();
    await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret },
      { spawnSync: fixture.run },
    );
    const input = String(fixture.calls[0]!.options.input);
    expect(input).not.toContain("appToken");
    expect(input).not.toContain("botToken");
    expect(input.split("\n")).toHaveLength(2);
    const hex = input.match(/ -X ([a-f0-9]+) -U\n$/)?.[1];
    expect(Buffer.from(hex!, "hex").toString("utf8")).toBe(secret);
  });

  it("escapes quotes and backslashes in destination arguments", async () => {
    process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = 'ravi."quoted"\\service';
    const fixture = runner();
    await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret: "fake-token" },
      { spawnSync: fixture.run },
    );
    expect(String(fixture.calls[0]!.options.input)).toContain(' -s "ravi.\\"quoted\\"\\\\service" -X ');
  });

  it("refuses line injection in destination metadata before spawning", async () => {
    process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = "ravi\nadd-generic-password";
    const fixture = runner();
    const error = await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret: "fake-token" },
      { spawnSync: fixture.run },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CredentialBrokerError);
    expect((error as Error).message).toBe("Invalid Keychain destination.");
    expect(fixture.calls).toHaveLength(0);
  });

  it.each(["", "fake\u0000token", "fake\ud800", "x".repeat(2048)])(
    "rejects an unrepresentable or oversized secret before spawning",
    async (secret) => {
      const fixture = runner();
      const error = await writeSecret(
        { backend: "keychain", provider: "slack", connection: "tests", secret },
        { spawnSync: fixture.run },
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CredentialBrokerError);
      expect(fixture.calls).toHaveLength(0);
      if (secret) expect((error as Error).message).not.toContain(secret);
    },
  );

  it.each([
    processResult({ status: 1, stderr: "fake-secret-echo", stdout: "fake-secret-echo" }),
    processResult({ status: null, signal: "SIGKILL", error: new Error("fake-secret-echo") }),
    processResult({ status: 0, error: new Error("fake-secret-echo") }),
  ])("returns a fixed error without backend output or cause", async (result) => {
    const fixture = runner(result);
    const error = await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret: "fake-secret-echo" },
      { spawnSync: fixture.run },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CredentialBrokerError);
    expect((error as CredentialBrokerError).code).toBe("backend_unavailable");
    expect((error as Error).message).toBe("The Keychain write failed or timed out.");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("fake-secret-echo");
    expect((error as Error).stack).not.toContain("fake-secret-echo");
  });

  it("does not expose synchronous spawn exceptions", async () => {
    const run = (() => {
      throw new Error("fake-secret-in-spawn-error");
    }) as typeof spawnSync;
    const error = await writeSecret(
      { backend: "keychain", provider: "slack", connection: "tests", secret: "fake-secret-in-spawn-error" },
      { spawnSync: run },
    ).catch((error: unknown) => error);
    expect((error as Error).message).toBe("The Keychain write failed or timed out.");
    expect((error as Error).cause).toBeUndefined();
  });
});

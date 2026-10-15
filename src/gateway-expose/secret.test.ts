import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult } from "../cloud-auth/secret-backends.js";
import {
  deleteTunnelCredentials,
  GATEWAY_TUNNEL_SECRET_SERVICE,
  parseTunnelCredentials,
  readTunnelCredentials,
  storeTunnelCredentials,
  type TunnelCredentials,
  tunnelCredentialsFilePath,
} from "./secret.js";

const TEST_TUNNEL_CREDENTIALS: TunnelCredentials = {
  AccountTag: "0123456789abcdef0123456789abcdef",
  TunnelID: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
  TunnelSecret: Buffer.alloc(32, 7).toString("base64"),
};

interface Call {
  command: string;
  args: string[];
  input?: string;
}

/** A fake `security` (never the real binary) that records argv and stdin separately. */
function fakeKeychain(options: { failWrites?: boolean } = {}) {
  const calls: Call[] = [];
  const items = new Map<string, string>();
  const runCommand = (command: string, args: string[], opts: { input?: string } = {}): CommandResult => {
    calls.push({ command, args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (args[0] === "-i") {
      if (options.failWrites) return { status: 1, stdout: "", stderr: "security: -25308" };
      const match = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]+)\n$/.exec(opts.input ?? "");
      if (!match) return { status: 1, stdout: "", stderr: "unexpected" };
      items.set(`${match[2]}/${match[1]}`, Buffer.from(match[3]!, "hex").toString("utf8"));
      return { status: 0, stdout: "", stderr: "" };
    }
    const key = `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
    if (args[0] === "find-generic-password") {
      const item = items.get(key);
      // `-g` prints the secret on stderr; hex form, as `security` does for non-printable payloads.
      return item
        ? { status: 0, stdout: "", stderr: `password: 0x${Buffer.from(item, "utf8").toString("hex").toUpperCase()} \n` }
        : {
            status: 44,
            stdout: "",
            stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
          };
    }
    if (args[0] === "delete-generic-password") items.delete(key);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runCommand, calls, items };
}

let gatewayDir: string;
beforeEach(() => {
  gatewayDir = join(mkdtempSync(join(tmpdir(), "ravi-gateway-secret-")), "gateway");
});
afterEach(() => {
  rmSync(dirname(gatewayDir), { recursive: true, force: true });
});

describe("tunnel credentials store", () => {
  test("file backend: 0600 file in a 0700 directory under the gateway dir", () => {
    const deps = { gatewayDir, env: { RAVI_CLOUD_AUTH_BACKEND: "file" } };
    expect(readTunnelCredentials(deps)).toEqual({ found: false, reason: "missing" });
    expect(storeTunnelCredentials(TEST_TUNNEL_CREDENTIALS, deps)).toEqual({ backend: "file" });
    const path = tunnelCredentialsFilePath(deps);
    expect(path.startsWith(gatewayDir)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readTunnelCredentials(deps)).toEqual({ found: true, credentials: TEST_TUNNEL_CREDENTIALS, backend: "file" });

    // A file other users can read is refused, not used.
    chmodSync(path, 0o644);
    expect(readTunnelCredentials(deps)).toEqual({ found: false, reason: "file_mode_unsafe" });

    deleteTunnelCredentials(deps);
    expect(readTunnelCredentials(deps)).toEqual({ found: false, reason: "missing" });
  });

  test("Keychain backend: service ravi.gateway-tunnel, secret only on stdin, never in argv", () => {
    const keychain = fakeKeychain();
    const deps = {
      gatewayDir,
      env: { RAVI_CLOUD_AUTH_BACKEND: "keychain" },
      platform: "darwin" as const,
      commandExists: () => true,
      runCommand: keychain.runCommand,
    };
    expect(storeTunnelCredentials(TEST_TUNNEL_CREDENTIALS, deps)).toEqual({ backend: "keychain" });
    expect(readTunnelCredentials(deps)).toEqual({
      found: true,
      credentials: TEST_TUNNEL_CREDENTIALS,
      backend: "keychain",
    });
    expect([...keychain.items.keys()]).toEqual([`${GATEWAY_TUNNEL_SECRET_SERVICE}/tunnel`]);
    for (const call of keychain.calls) {
      const argv = call.args.join(" ");
      expect(argv).not.toContain(TEST_TUNNEL_CREDENTIALS.TunnelSecret);
      expect(argv).not.toContain(TEST_TUNNEL_CREDENTIALS.AccountTag);
      if (call.args.includes("-s")) expect(call.args[call.args.indexOf("-s") + 1]).toBe(GATEWAY_TUNNEL_SECRET_SERVICE);
    }
    expect(keychain.calls.find((call) => call.args[0] === "-i")?.input).toBeDefined();
    // The cloud-auth service is untouched.
    expect(keychain.calls.some((call) => call.args.includes("ravi.cloud-auth"))).toBe(false);

    deleteTunnelCredentials(deps);
    expect(keychain.items.size).toBe(0);
  });

  test("a Keychain write failure falls back to the 0600 file and leaves no Keychain copy", () => {
    const keychain = fakeKeychain({ failWrites: true });
    const deps = {
      gatewayDir,
      env: { RAVI_CLOUD_AUTH_BACKEND: "keychain" },
      platform: "darwin" as const,
      commandExists: () => true,
      runCommand: keychain.runCommand,
    };
    expect(storeTunnelCredentials(TEST_TUNNEL_CREDENTIALS, deps)).toEqual({ backend: "file" });
    expect(keychain.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(true);
    expect(statSync(tunnelCredentialsFilePath(deps)).mode & 0o777).toBe(0o600);
    expect(readTunnelCredentials(deps)).toMatchObject({ found: true, backend: "file" });
  });

  test("parse is strict about the credentials-file object", () => {
    expect(parseTunnelCredentials(JSON.stringify(TEST_TUNNEL_CREDENTIALS))).toEqual(TEST_TUNNEL_CREDENTIALS);
    expect(parseTunnelCredentials({ ...TEST_TUNNEL_CREDENTIALS, Endpoint: "" })).toBeNull();
    expect(parseTunnelCredentials({ ...TEST_TUNNEL_CREDENTIALS, TunnelID: "not-a-uuid" })).toBeNull();
    expect(parseTunnelCredentials({ ...TEST_TUNNEL_CREDENTIALS, TunnelSecret: "c2hvcnQ=" })).toBeNull();
    expect(parseTunnelCredentials({ ...TEST_TUNNEL_CREDENTIALS, AccountTag: "acct" })).toBeNull();
    expect(parseTunnelCredentials("{")).toBeNull();
    expect(() => storeTunnelCredentials({ ...TEST_TUNNEL_CREDENTIALS, TunnelID: "x" }, { gatewayDir })).toThrow(
      /malformed/,
    );
  });
});

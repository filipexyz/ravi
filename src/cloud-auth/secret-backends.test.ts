import { describe, expect, it } from "bun:test";
import { SECURITY_INTERACTIVE_MAX_LINE_BYTES } from "../security/macos-keychain.js";
import { createFakeSecurity } from "../test/fake-security.js";
import { CloudAuthError } from "./errors.js";
import { createBackend, type CommandResult } from "./secret-backends.js";

interface RecordedCall {
  command: string;
  args: string[];
  input?: string;
}

/** The shared fake `security` (src/test/fake-security.ts) behind the backend's runner. Never runs the real binary. */
function fakeKeychain(options: { failWrites?: boolean } = {}) {
  const fake = createFakeSecurity();
  const calls: RecordedCall[] = [];
  const backend = createBackend("keychain", {
    usersDir: "/nonexistent/ravi-test-users",
    platform: "darwin",
    commandExists: () => true,
    runCommand: (command, args, opts = {}): CommandResult => {
      calls.push({ command, args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) });
      if (options.failWrites && args[0] === "-i")
        return { status: 1, stdout: "", stderr: "security: SecKeychainItemCreateFromContent: -25308" };
      return fake.run(args, opts);
    },
  });
  return { backend, calls, items: fake.items, fake };
}

const TRICKY_PAYLOAD = `${JSON.stringify(
  {
    version: 1,
    accessToken: 'tok"en; delete-keychain login.keychain',
    refreshToken: 'line1\nline2\r\n"; add-generic-password -a evil -s ravi.cloud-auth -w pwn',
    user: { name: "José Ñandú ✓", note: "back\\slash 'single' `tick` $HOME" },
  },
  null,
  2,
)}\n`;

describe("cloud-auth Keychain backend", () => {
  it("writes through `security -i` on stdin: the payload is in no argv element", () => {
    const { backend, calls } = fakeKeychain();

    backend.write("user_123", TRICKY_PAYLOAD);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("security");
    expect(call!.args).toEqual(["-i"]);
    const parsed = JSON.parse(TRICKY_PAYLOAD) as { accessToken: string; refreshToken: string };
    for (const arg of call!.args) {
      expect(arg).not.toContain("tok");
      expect(arg).not.toContain(parsed.refreshToken);
    }
    // One command line, payload only as hex.
    expect(call!.input).toMatch(/^add-generic-password -U -a user_123 -s ravi\.cloud-auth -X [0-9a-f]+\n$/);
    expect(call!.input).not.toContain("delete-keychain");
    expect(call!.input).not.toContain('"');
    expect(call!.input!.split("\n")).toHaveLength(2);
  });

  it("round-trips a payload with quotes, newlines and non-ASCII text", () => {
    const { backend, items } = fakeKeychain();

    backend.write("user_123", TRICKY_PAYLOAD);
    const stored = items.get("ravi.cloud-auth/user_123")!;
    const read = backend.read("user_123");

    // Stored as compact, printable ASCII JSON (shorter, and eligible for the quoted write form).
    expect([...stored].every((byte) => byte >= 0x20 && byte < 0x7f)).toBe(true);
    expect(JSON.parse(read!)).toEqual(JSON.parse(TRICKY_PAYLOAD));
  });

  it("reads with `find-generic-password -g`, never `-w`", () => {
    const { backend, calls } = fakeKeychain();
    backend.write("user_123", TRICKY_PAYLOAD);
    backend.read("user_123");

    const read = calls.find((call) => call.args[0] === "find-generic-password");
    expect(read?.args).toEqual(["find-generic-password", "-a", "user_123", "-s", "ravi.cloud-auth", "-g"]);
  });

  it("reads a non-ASCII item an older Ravi wrote with the payload in argv", () => {
    const { backend, fake } = fakeKeychain();
    const legacy = JSON.stringify({ user: { name: "José" } });
    fake.run(["add-generic-password", "-U", "-a", "user_123", "-s", "ravi.cloud-auth", "-w", legacy]);

    expect(backend.read("user_123")).toBe(legacy);
  });

  it("returns a payload made only of hex digits as text, not as decoded bytes", () => {
    const { backend } = fakeKeychain();
    for (const payload of ["123456", "000000", "c3a9", "0a", "deadbeef"]) {
      backend.write("user_123", payload);
      expect(backend.read("user_123")).toBe(payload);
    }
  });

  it("returns null for a missing item and fails closed on output it cannot parse", () => {
    const { backend } = fakeKeychain();
    expect(backend.read("user_404")).toBeNull();

    const broken = createBackend("keychain", {
      usersDir: "/nonexistent/ravi-test-users",
      platform: "darwin",
      commandExists: () => true,
      runCommand: () => ({ status: 0, stdout: "", stderr: "password: 0xFF \n" }),
    });
    expect(() => broken.read("user_123")).toThrow(CloudAuthError);
  });

  it("stores a ~3 KB payload (too long for hex) through the quoted form and reads it back", () => {
    const { backend, calls } = fakeKeychain();
    const payload = JSON.stringify({ accessToken: `eyJ${"a".repeat(2800)}`, user: { name: 'Zoë "Z" \\o/' } }, null, 2);

    backend.write("user_123", payload);

    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toContain(' -w "{\\"accessToken\\":');
    expect(JSON.parse(backend.read("user_123")!)).toEqual(JSON.parse(payload));
  });

  it("refuses a payload too large for one `security -i` line without running security", () => {
    const { backend, calls } = fakeKeychain();
    const huge = JSON.stringify({ accessToken: "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES) });

    expect(() => backend.write("user_123", huge)).toThrow(CloudAuthError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an account name the interactive parser would split, without running security", () => {
    const { backend, calls } = fakeKeychain();

    expect(() => backend.write('user 1"; delete-keychain', TRICKY_PAYLOAD)).toThrow(CloudAuthError);
    expect(calls).toHaveLength(0);
  });

  it("reports a failed write as the file-store fallback error, with secret material redacted", () => {
    const { backend } = fakeKeychain({ failWrites: true });
    let failure: unknown;
    try {
      backend.write("user_123", TRICKY_PAYLOAD);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudAuthError);
    expect((failure as Error).message).toContain("fell back to the portable file store");
  });

  it("delete is silent for a removed or missing item and fails when the Keychain refuses", () => {
    const { backend, items, fake } = fakeKeychain();
    backend.write("user_123", TRICKY_PAYLOAD);
    expect(items.has("ravi.cloud-auth/user_123")).toBe(true);

    expect(() => backend.delete("user_123")).not.toThrow();
    expect(items.has("ravi.cloud-auth/user_123")).toBe(false);
    // Nothing left: `security` exits 44 (errSecItemNotFound), which is not a failure.
    expect(() => backend.delete("user_123")).not.toThrow();

    backend.write("user_123", TRICKY_PAYLOAD);
    fake.locked = true;
    let failure: unknown;
    try {
      backend.delete("user_123");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudAuthError);
    expect((failure as Error).message).toContain("could not be removed");
    expect(((failure as Error).cause as Error).message).toContain("User interaction is not allowed");
    expect(items.has("ravi.cloud-auth/user_123")).toBe(true);
  });
});

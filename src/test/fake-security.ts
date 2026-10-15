/**
 * A fake macOS `security` for tests. It understands what Ravi sends (the
 * `security -i` stdin line, `find-generic-password -g`, `delete-generic-password`),
 * the legacy argv `add-generic-password -w <secret>` an older Ravi ran, and the
 * `-w` read Ravi no longer uses, and prints passwords exactly like Apple's
 * SecurityTool (`print_buffer` in keychain_utilities.c, `do_password_item_printing`
 * in keychain_find.c). It never runs the real binary.
 */

import type { SecurityCommandResult } from "../security/macos-keychain.js";

export interface FakeSecurityCall {
  args: string[];
  input?: string;
}

export interface FakeSecurity {
  /** Stored items by `${service}/${account}`. */
  items: Map<string, Buffer>;
  calls: FakeSecurityCall[];
  /** A locked Keychain: writes and deletes fail with "User interaction is not allowed". */
  locked: boolean;
  run: (args: string[], options?: { input?: string }) => SecurityCommandResult;
}

const NOT_FOUND: SecurityCommandResult = {
  status: 44,
  stdout: "",
  stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
};

const LOCKED: SecurityCommandResult = {
  status: 36,
  stdout: "",
  stderr: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.",
};

export function createFakeSecurity(): FakeSecurity {
  const items = new Map<string, Buffer>();
  const calls: FakeSecurityCall[] = [];
  const fake: FakeSecurity = {
    items,
    calls,
    locked: false,
    run(args, options = {}) {
      calls.push({ args: [...args], ...(options.input !== undefined ? { input: options.input } : {}) });
      const key = `${flag(args, "-s")}/${flag(args, "-a")}`;
      if (args[0] === "-i") {
        if (fake.locked) return LOCKED;
        for (const line of (options.input ?? "").split("\n").filter(Boolean)) {
          const hex = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]*)$/.exec(line);
          const quoted = /^add-generic-password -U -a (\S+) -s (\S+) -w "((?:[^"\\]|\\.)*)"$/.exec(line);
          if (hex) items.set(`${hex[2]}/${hex[1]}`, Buffer.from(hex[3]!, "hex"));
          else if (quoted) items.set(`${quoted[2]}/${quoted[1]}`, Buffer.from(quoted[3]!.replace(/\\(.)/g, "$1")));
          else return { status: 1, stdout: "", stderr: `security: unknown command "${line.slice(0, 20)}"` };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "add-generic-password") {
        // What an older Ravi ran, secret in argv.
        if (fake.locked) return LOCKED;
        items.set(key, Buffer.from(flag(args, "-w") ?? "", "utf8"));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const item = items.get(key);
        if (!item) return NOT_FOUND;
        const attributes = `keychain: "/Users/test/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="${flag(args, "-a")}"\n    "svce"<blob>="${flag(args, "-s")}"\n`;
        if (args.includes("-g")) return { status: 0, stdout: attributes, stderr: `password: ${printBuffer(item)}\n` };
        if (args.includes("-w")) return { status: 0, stdout: `${printPasswordStdout(item)}\n`, stderr: "" };
        return { status: 0, stdout: attributes, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        if (fake.locked) return LOCKED;
        return items.delete(key) ? { status: 0, stdout: "", stderr: "" } : NOT_FOUND;
      }
      return { status: 1, stdout: "", stderr: `security: unknown command "${args[0]}"` };
    },
  };
  return fake;
}

/**
 * Apple's `print_buffer`: the form `find-generic-password -g` prints after
 * `password: ` on stderr. A byte is printable when it is in `0x20..0x7e` and is
 * not a backslash; the quoted dump escapes every other byte as `\ooo`.
 */
export function printBuffer(data: Buffer): string {
  const printable = (byte: number) => byte >= 0x20 && byte <= 0x7e && byte !== 0x5c;
  const ascii = [...data].some(printable);
  const hex = [...data].some((byte) => !printable(byte));
  let out = "";
  if (hex) {
    out += `0x${data.toString("hex").toUpperCase()}`;
    if (ascii) out += " ";
    out += " ";
  }
  if (ascii) {
    out += '"';
    for (const byte of data) {
      out += printable(byte) ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
    }
    out += '"';
  }
  return out;
}

/** What `find-generic-password -w` prints on stdout: text when every byte is printable, else bare lowercase hex. */
export function printPasswordStdout(data: Buffer): string {
  const printable = [...data].every((byte) => byte >= 0x20 && byte <= 0x7e);
  return printable ? data.toString("latin1") : data.toString("hex");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

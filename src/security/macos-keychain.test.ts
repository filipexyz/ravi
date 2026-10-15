import { describe, expect, it } from "bun:test";
import { printBuffer } from "../test/fake-security.js";
import {
  buildAddGenericPasswordLine,
  findGenericPasswordArgs,
  parseSecurityPasswordOutput,
  redactSecurityOutput,
  SECURITY_INTERACTIVE_MAX_LINE_BYTES,
} from "./macos-keychain.js";

describe("buildAddGenericPasswordLine", () => {
  it("builds one stdin line with the secret only as hex", () => {
    const secret = 'a"b\nc; delete-keychain x';
    const command = buildAddGenericPasswordLine({ account: "user_1", service: "ravi.cloud-auth", secret });
    expect(command).toEqual({
      ok: true,
      line: `add-generic-password -U -a user_1 -s ravi.cloud-auth -X ${Buffer.from(secret).toString("hex")}\n`,
    });
  });

  it("uses hex up to the line limit `security -i` reads without splitting", () => {
    const overhead = "add-generic-password -U -a u -s s -X \n".length;
    const fits = "\n".repeat((SECURITY_INTERACTIVE_MAX_LINE_BYTES - overhead) / 2);
    const fitting = buildAddGenericPasswordLine({ account: "u", service: "s", secret: fits });
    expect(fitting.ok).toBe(true);
    if (fitting.ok) {
      expect(fitting.line).toContain(" -X 0a0a");
      expect(Buffer.byteLength(fitting.line)).toBe(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    }
    // One byte more of a secret that cannot be quoted (a newline) is refused.
    expect(buildAddGenericPasswordLine({ account: "u", service: "s", secret: `${fits}\n` })).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    // Measured on macOS 26: lines up to 4095 bytes (newline included) are read whole.
    expect(SECURITY_INTERACTIVE_MAX_LINE_BYTES).toBeLessThanOrEqual(4095);
  });

  it("sends a long printable secret double-quoted, escaping only quote and backslash", () => {
    const secret = `{"type":"service_account","private_key":"-----BEGIN KEY-----\\nMIIE${"A".repeat(3000)}\\n","q":"it's \\"x\\""} ; delete-keychain`;
    const command = buildAddGenericPasswordLine({ account: "slack:rbbt", service: "ravi.credentials", secret });

    expect(command.ok).toBe(true);
    if (!command.ok) return;
    expect(Buffer.byteLength(command.line)).toBeLessThanOrEqual(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(command.line.endsWith('"\n')).toBe(true);
    expect(command.line.split("\n")).toHaveLength(2);
    // What `security -i` would parse: exactly one -w token holding the secret.
    const argv = splitSecurityLine(command.line.slice(0, -1));
    expect(argv).toEqual(["add-generic-password", "-U", "-a", "slack:rbbt", "-s", "ravi.credentials", "-w", secret]);
  });

  it("refuses a long secret that is neither short enough for hex nor safe to quote", () => {
    for (const secret of [`caf\u00e9${"x".repeat(2500)}`, `line1\n${"x".repeat(2500)}`, `tab\t${"x".repeat(2500)}`]) {
      expect(buildAddGenericPasswordLine({ account: "u", service: "s", secret })).toMatchObject({
        ok: false,
        reason: "too_long",
      });
    }
    expect(
      buildAddGenericPasswordLine({
        account: "u",
        service: "s",
        secret: "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES),
      }),
    ).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("refuses names that would need quoting", () => {
    for (const account of ["", "a b", 'a"b', "a'b", "a\nb", "a\\b"]) {
      expect(buildAddGenericPasswordLine({ account, service: "s", secret: "x" })).toMatchObject({
        ok: false,
        reason: "unsafe_name",
      });
    }
    expect(buildAddGenericPasswordLine({ account: "slack:rbbt", service: "ravi credentials", secret: "x" }).ok).toBe(
      false,
    );
  });
});

describe("redactSecurityOutput", () => {
  it("removes -w values, -X hex and long hex runs", () => {
    expect(redactSecurityOutput("add-generic-password -w hunter2 -X 7b2261223a317d")).toBe(
      "add-generic-password -w [redacted] -X [redacted]",
    );
    expect(redactSecurityOutput('security: unknown command "7b22616363657373546f6b656e223a"')).toBe(
      'security: unknown command "[redacted]"',
    );
    expect(redactSecurityOutput('add-generic-password -w "a \\"secret\\" value" ravi')).toBe(
      "add-generic-password -w [redacted] ravi",
    );
    expect(redactSecurityOutput("returned -25308")).toBe("returned -25308");
    expect(redactSecurityOutput('password: "hunter2"\nclass: "genp"')).toBe('password: [redacted]\nclass: "genp"');
    expect(redactSecurityOutput('password: 0x610A62  "a\\012b"')).toBe("password: [redacted]");
  });
});

describe("findGenericPasswordArgs", () => {
  it("reads with -g, never with the ambiguous -w", () => {
    const args = findGenericPasswordArgs({ account: "user_1", service: "ravi.cloud-auth" });
    expect(args).toEqual(["find-generic-password", "-a", "user_1", "-s", "ravi.cloud-auth", "-g"]);
    expect(args).not.toContain("-w");
  });
});

describe("parseSecurityPasswordOutput", () => {
  it("reads every form Apple's print_buffer emits after `password: ` on stderr", () => {
    // Printable ASCII without a backslash: verbatim between quotes, `"` included.
    expect(parseSecurityPasswordOutput('password: "hunter2"\n')).toEqual({ ok: true, secret: "hunter2" });
    expect(parseSecurityPasswordOutput('password: "a"b"\n')).toEqual({ ok: true, secret: 'a"b' });
    // No printable byte: uppercase hex and one trailing space.
    expect(parseSecurityPasswordOutput("password: 0x0A0A \n")).toEqual({ ok: true, secret: "\n\n" });
    // Mixed: hex, two spaces, then the dump with `\ooo` escapes (backslash counts as non-printable).
    expect(parseSecurityPasswordOutput('password: 0x610A62  "a\\012b"\n')).toEqual({ ok: true, secret: "a\nb" });
    expect(parseSecurityPasswordOutput('password: 0x615C22  "a\\134""\n')).toEqual({ ok: true, secret: 'a\\"' });
    expect(parseSecurityPasswordOutput('password: 0xC3A9  "\\303\\251"\n')).toEqual({ ok: true, secret: "é" });
    // Empty secret.
    expect(parseSecurityPasswordOutput("password: \n")).toEqual({ ok: true, secret: "" });
  });

  it("never hex-decodes a printable secret made of hex digits", () => {
    for (const secret of ["123456", "000000", "0a", "c3a9", "deadbeef", "7b2261223a317d", "0x0A0A", "0A0A "]) {
      expect(parseSecurityPasswordOutput(`password: "${secret}"\n`)).toEqual({ ok: true, secret });
      expect(parseSecurityPasswordOutput(`password: ${printBuffer(Buffer.from(secret))}\n`)).toEqual({
        ok: true,
        secret,
      });
    }
  });

  it("round-trips text through the print_buffer form the fake derives from the C source", () => {
    const secrets = [
      "é",
      "café ✓",
      '{"accessToken":"tok","note":"back\\slash \\u00e9"}',
      "a\nb",
      "tab\tx",
      "\\",
      'it\'s "quoted"',
      "x".repeat(3900),
      "",
    ];
    for (const secret of secrets) {
      expect(parseSecurityPasswordOutput(`password: ${printBuffer(Buffer.from(secret, "utf8"))}\n`)).toEqual({
        ok: true,
        secret,
      });
    }
  });

  it("keeps a leading byte order mark instead of stripping it", () => {
    const secret = "\uFEFFabc";
    // U+FEFF is EF BB BF: non-printable bytes, so print_buffer emits the hex form.
    expect(parseSecurityPasswordOutput(`password: ${printBuffer(Buffer.from(secret, "utf8"))}\n`)).toEqual({
      ok: true,
      secret,
    });
    expect(parseSecurityPasswordOutput("password: 0xEFBBBF \n")).toEqual({ ok: true, secret: "\uFEFF" });
  });

  it("tolerates an earlier stderr line and refuses what it cannot parse, without echoing it", () => {
    expect(parseSecurityPasswordOutput('warning: something\npassword: "s"\n')).toEqual({ ok: true, secret: "s" });
    expect(parseSecurityPasswordOutput("")).toMatchObject({ ok: false });
    expect(parseSecurityPasswordOutput("password: not-a-form\n")).toMatchObject({ ok: false });
    expect(parseSecurityPasswordOutput("password: 0xFF \n")).toMatchObject({ ok: false });
    const failed = parseSecurityPasswordOutput("password: 0xZZZZ \n");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).not.toContain("ZZZZ");
  });

  it("the fake's printBuffer matches the C source on fixed bytes", () => {
    expect(printBuffer(Buffer.from("hunter2"))).toBe('"hunter2"');
    expect(printBuffer(Buffer.from("\n"))).toBe("0x0A ");
    expect(printBuffer(Buffer.from("a\nb"))).toBe('0x610A62  "a\\012b"');
    expect(printBuffer(Buffer.from("a\\b"))).toBe('0x615C62  "a\\134b"');
    expect(printBuffer(Buffer.from(""))).toBe("");
  });
});

/**
 * The tokenizer `security -i` applies to a line (split_line): whitespace
 * separates tokens, a backslash makes the next character literal, and single
 * or double quotes group characters until the matching quote.
 */
function splitSecurityLine(line: string): string[] {
  const tokens: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\") {
      current = (current ?? "") + (line[++index] ?? "");
    } else if (quote) {
      if (char === quote) quote = null;
      else current = (current ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current = current ?? "";
    } else if (/\s/.test(char)) {
      if (current !== null) tokens.push(current);
      current = null;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== null) tokens.push(current);
  return tokens;
}

import { describe, expect, it } from "bun:test";
import { redactJson, redactText } from "./redaction.js";
import { REDACTION_STRUCTURED_KEY_CORPUS, REDACTION_TEXT_CORPUS } from "../test/redaction-corpus.js";

describe("central redaction", () => {
  it("redacts the shared adversarial text corpus", () => {
    for (const entry of REDACTION_TEXT_CORPUS) {
      const result = redactText(entry.input);
      expect(result.redacted).toBe(true);
      expect(result.value).not.toContain(entry.secret);
    }
  });

  it("normalizes camelCase structured secret keys", () => {
    const input = Object.fromEntries(REDACTION_STRUCTURED_KEY_CORPUS.map((key) => [key, `synthetic-${key}`]));
    expect(redactJson(input).value).toEqual(
      Object.fromEntries(REDACTION_STRUCTURED_KEY_CORPUS.map((key) => [key, "[REDACTED]"])),
    );
  });
  it("redacts bare provider credentials without labels", () => {
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIA1234567890ABCDEF",
      "AIzaabcdefghijklmnopqrstuvwxyz1234567890",
      ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    ];
    for (const secret of secrets) {
      const result = redactText(`startup failed with ${secret}`);
      expect(result.redacted).toBe(true);
      expect(result.value).not.toContain(secret);
    }
  });

  it("redacts nested values, secret keys, errors, arrays, and circular input", () => {
    const circular: Record<string, unknown> = {
      nested: {
        message: "token sk-proj-abcdefghijklmnopqrstuvwxyz",
        github: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
      password: "plain-text-password",
      error: new Error("provider rejected AKIA1234567890ABCDEF"),
    };
    circular.self = circular;

    const serialized = JSON.stringify(redactJson(circular).value);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[Circular]");
    expect(serialized).not.toContain("plain-text-password");
    expect(serialized).not.toContain("sk-proj-");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("AKIA1234567890ABCDEF");
  });
});

import { describe, expect, it } from "bun:test";
import { scanSecret } from "./scan-secret.js";

describe("scanSecret (R9b redact-at-source)", () => {
  it("returns clean result for benign content", () => {
    const result = scanSecret("User prefers bun over npm and works on ravi-dev.");
    expect(result.hasSecret).toBe(false);
    expect(result.isCredentialOnly).toBe(false);
    expect(result.redacted).toBe("User prefers bun over npm and works on ravi-dev.");
  });

  it("detects github token and redacts at source", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const content = `Reminder: use token ${token} for the PR bot.`;
    const result = scanSecret(content);
    expect(result.hasSecret).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.kind).toBe("github-token");
    expect(result.redacted).toBe("Reminder: use token [REDACTED:secret] for the PR bot.");
    expect(result.redacted).not.toContain(token);
  });

  it("detects openai key", () => {
    const key = "sk-proj-ABCDEFghijkl0123456789xyz";
    const result = scanSecret(`OPENAI=${key}`);
    expect(result.hasSecret).toBe(true);
    expect(result.matches[0]!.kind).toBe("openai-key");
    expect(result.redacted).toBe("OPENAI=[REDACTED:secret]");
  });

  it("detects AWS access key + slack token", () => {
    const content = "AWS=AKIAIOSFODNN7EXAMPLE and slack=xoxb-1234567890-abcdef.";
    const result = scanSecret(content);
    expect(result.hasSecret).toBe(true);
    expect(result.matches.map((m) => m.kind).sort()).toEqual(["aws-access-key", "slack-token"]);
  });

  it("detects private key blocks", () => {
    const content = "config:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA...\n";
    const result = scanSecret(content);
    expect(result.hasSecret).toBe(true);
    expect(result.matches[0]!.kind).toBe("private-key");
    expect(result.redacted).toContain("[REDACTED:secret]");
  });

  it("detects CPF + CNPJ", () => {
    const content = "Cliente CPF 123.456.789-00 empresa 12.345.678/0001-99.";
    const result = scanSecret(content);
    expect(result.matches.map((m) => m.kind).sort()).toEqual(["cnpj", "cpf"]);
    expect(result.redacted).toBe("Cliente CPF [REDACTED:secret] empresa [REDACTED:secret].");
  });

  it("flags credential-only when the entire content is one credential", () => {
    const result = scanSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.isCredentialOnly).toBe(true);
  });

  it("does NOT flag credential-only when context around the secret is substantial", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = scanSecret(`Long paragraph about our workflow that happens to embed ${token} plus more prose.`);
    expect(result.hasSecret).toBe(true);
    expect(result.isCredentialOnly).toBe(false);
  });

  it("handles empty input", () => {
    const result = scanSecret("");
    expect(result.hasSecret).toBe(false);
    expect(result.isCredentialOnly).toBe(false);
    expect(result.redacted).toBe("");
  });

  it('detects generic hardcoded credential (`api_key = "..."`) even without a known prefix', () => {
    const configLine = `api_key = "abcDEF123456ghiJKL789xyz"`;
    const result = scanSecret(configLine);
    expect(result.hasSecret).toBe(true);
    expect(result.matches[0]!.kind).toBe("hardcoded-secret");
    expect(result.redacted).not.toContain("abcDEF123456ghiJKL789xyz");
    expect(result.redacted).toContain("[REDACTED:secret]");
  });

  it("detects hardcoded password / secret variants with colon or hyphenated key", () => {
    const pwd = scanSecret(`password: "SuperSecret_ValueThatIs22Chars"`);
    const dashKey = scanSecret(`api-key = "01234567890ABCDEFGHIJ+/="`);
    expect(pwd.hasSecret).toBe(true);
    expect(dashKey.hasSecret).toBe(true);
    expect(pwd.matches[0]!.kind).toBe("hardcoded-secret");
    expect(dashKey.matches[0]!.kind).toBe("hardcoded-secret");
  });
});

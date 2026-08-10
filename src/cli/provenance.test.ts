import { describe, expect, it } from "bun:test";
import { buildCliInvocationMetadata, hashForAudit, sanitizeCliArgv } from "./provenance.js";

describe("CLI provenance", () => {
  it("redacts sensitive argv values", () => {
    expect(
      sanitizeCliArgv([
        "ravi",
        "sessions",
        "reset",
        "--api-key",
        "secret-value",
        "--token=abc123",
        "--reason",
        "manual",
      ]),
    ).toEqual(["ravi", "sessions", "reset", "--api-key", "[REDACTED]", "--token=[REDACTED]", "--reason", "manual"]);
  });

  it("consumes Commander required-option values that begin with a hyphen", () => {
    expect(sanitizeCliArgv(["--api-key", "-secret-value"])).toEqual(["--api-key", "[REDACTED]"]);
    expect(sanitizeCliArgv(["--api-key", "--json"])).toEqual(["--api-key", "[REDACTED]"]);
    expect(sanitizeCliArgv(["--output-path", "-private-file"])).toEqual(["--output-path", "[REDACTED:path]"]);
  });

  it("classifies long URL options before bounding their public representation", () => {
    const option = `--${"x".repeat(250)}url`;

    expect(sanitizeCliArgv([option, "https://user:password@example.test/private?token=secret#fragment"])[1]).toBe(
      "https://example.test",
    );
  });

  it("bounds reconstructed long path options", () => {
    const option = `--${"x".repeat(250)}path=/x`;
    const [projected] = sanitizeCliArgv([option]);

    expect(projected).toHaveLength(240);
  });

  it("preserves negative numeric values for projecting options", () => {
    expect(sanitizeCliArgv(["--url", "-1"])).toEqual(["--url", "-1"]);
  });

  it("preserves daemon logs path as a boolean flag", () => {
    expect(sanitizeCliArgv(["ravi", "daemon", "logs", "--path", "--json"], { group: "daemon", name: "logs" })).toEqual(
      ["ravi", "daemon", "logs", "--path", "--json"],
    );
  });

  it("builds process metadata for direct CLI invocations", () => {
    const metadata = buildCliInvocationMetadata({
      group: "sessions",
      name: "reset",
      tool: "sessions_reset",
    });

    expect(metadata.invocationId).toBeTruthy();
    expect(metadata.command?.tool).toBe("sessions_reset");
    expect(metadata.process.pid).toBe(process.pid);
    expect(metadata.process.ppid).toBe(process.ppid);
    expect(metadata.process.cwd).toBe("[REDACTED:path]");
    expect(metadata.process.execPath).toBe("[REDACTED:path]");
    expect(metadata.process.argv.length).toBeGreaterThan(0);
    expect(metadata.host.hostname).toBeTruthy();
    expect(metadata.runtime.nodeVersion).toBe(process.versions.node);
    expect(typeof metadata.raviContext.hasContextKey).toBe("boolean");
    expect(JSON.stringify(metadata)).not.toContain(process.cwd());
    expect(JSON.stringify(metadata)).not.toContain(process.execPath);
  });

  it("hashes audit identifiers without exposing raw values", () => {
    const hash = hashForAudit("120363424772797713@g.us");

    expect(hash).toHaveLength(16);
    expect(hash).not.toContain("120363");
  });
});

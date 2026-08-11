import { describe, expect, it } from "bun:test";
import { buildCliInvocationMetadata, hashForAudit, sanitizeCliArgv } from "./provenance.js";

describe("CLI provenance", () => {
  it("summarizes argv without persisting values", () => {
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
    ).toEqual(["[REDACTED:argv count=8]"]);
  });

  it("summarizes values that resemble flags", () => {
    expect(sanitizeCliArgv(["--api-key", "-secret-value"])).toEqual(["[REDACTED:argv count=2]"]);
    expect(sanitizeCliArgv(["--api-key", "--json"])).toEqual(["[REDACTED:argv count=2]"]);
    expect(sanitizeCliArgv(["--output-path", "-private-file"])).toEqual(["[REDACTED:argv count=2]"]);
  });

  it("does not persist long option names or URL values", () => {
    const option = `--${"x".repeat(250)}url`;

    expect(sanitizeCliArgv([option, "https://user:password@example.test/private?token=secret#fragment"])).toEqual([
      "[REDACTED:argv count=2]",
    ]);
  });

  it("does not reconstruct long path options", () => {
    const option = `--${"x".repeat(250)}path=/x`;
    const [projected] = sanitizeCliArgv([option]);

    expect(projected).toBe("[REDACTED:argv count=1]");
  });

  it("does not persist negative numeric values", () => {
    expect(sanitizeCliArgv(["--url", "-1"])).toEqual(["[REDACTED:argv count=2]"]);
  });

  it("does not special-case boolean flags", () => {
    expect(sanitizeCliArgv(["ravi", "daemon", "logs", "--path", "--json"], { group: "daemon", name: "logs" })).toEqual([
      "[REDACTED:argv count=5]",
    ]);
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

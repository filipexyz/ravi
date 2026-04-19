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
    expect(metadata.process.cwd).toBe(process.cwd());
    expect(metadata.process.argv.length).toBeGreaterThan(0);
    expect(metadata.host.hostname).toBeTruthy();
    expect(metadata.runtime.nodeVersion).toBe(process.versions.node);
    expect(typeof metadata.raviContext.hasContextKey).toBe("boolean");
  });

  it("hashes audit identifiers without exposing raw values", () => {
    const hash = hashForAudit("120363424772797713@g.us");

    expect(hash).toHaveLength(16);
    expect(hash).not.toContain("120363");
  });
});

import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";

setDefaultTimeout(90_000);

/**
 * Process-level proof of the Manual v2 parser taxonomy. The per-domain suites
 * exercise commander via program.parse and catch the thrown ContractError, so
 * they never cross the real process boundary: with RAVI_* envs present the
 * throw used to escape bootstrapCli() and collapse into "Error: ..." exit 1.
 * These smokes pin the exit codes end to end, with and without agent context.
 */
function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...withoutRaviRuntimeContextEnv(), RAVI_SUPPRESS_AUDIT_EVENTS: "1", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("usage exit taxonomy smoke", () => {
  it("exits 2 with the USAGE_ERROR envelope on an unknown flag without agent context", () => {
    const result = runCli(["tasks", "list", "--no-such-flag", "--json"], { RAVI_AGENT_ID: undefined });
    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as { success: boolean; op: string; error: { code: string } };
    expect(payload.success).toBe(false);
    expect(payload.op).toBe("tasks list");
    expect(payload.error.code).toBe("USAGE_ERROR");
  });

  it("exits 2 with the USAGE_ERROR envelope on an unknown flag WITH agent context", () => {
    const result = runCli(["tasks", "list", "--no-such-flag", "--json"], { RAVI_AGENT_ID: "usage-smoke" });
    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as { success: boolean; error: { code: string } };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("USAGE_ERROR");
    expect(result.stderr).not.toContain("Error: error:");
  });
});

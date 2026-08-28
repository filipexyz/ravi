import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";

setDefaultTimeout(90_000);

const processStateDir = mkdtempSync(join(tmpdir(), "ravi-contract-process-smoke-"));

afterAll(() => {
  rmSync(processStateDir, { recursive: true, force: true });
});

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
    env: {
      ...withoutRaviRuntimeContextEnv(),
      RAVI_STATE_DIR: processStateDir,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("usage exit taxonomy smoke", () => {
  it("exits 2 when bare ravi tui is missing a session name", () => {
    const result = runCli(["tui"], { RAVI_AGENT_ID: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toMatch(/tui|session|required|missing|Usage/i);
    expect(result.stderr + result.stdout).not.toMatch(/\bmain\b.*default/i);
  });

  it("exits 2 with one USAGE_ERROR envelope for an unknown root command", () => {
    const result = runCli(["task", "list", "--json"], { RAVI_AGENT_ID: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "cli",
      error: { code: "USAGE_ERROR" },
    });
  });

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

  it("redacts inline values from unknown options before rendering the usage envelope", () => {
    const secret = "usage-secret-that-must-not-leak";
    const result = runCli(["tasks", "list", `--token=${secret}`, "--json"], { RAVI_AGENT_ID: undefined });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "tasks list",
      error: {
        code: "USAGE_ERROR",
        message: "error: unknown option '--token=[REDACTED]'",
      },
    });
  });

  it("redacts the complete quoted inline value when it contains spaces", () => {
    const secret = "usage secret with a private suffix";
    const result = runCli(["tasks", "list", `--token=${secret}`, "--json"], { RAVI_AGENT_ID: undefined });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("usage secret");
    expect(result.stdout).not.toContain("private suffix");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "tasks list",
      error: {
        code: "USAGE_ERROR",
        message: "error: unknown option '--token=[REDACTED]'",
      },
    });
  });

  it("renders migrated handler failures as canonical JSON at the real process boundary", () => {
    const cases = [
      {
        args: ["crm", "contact", "show", "__contract_missing_contact__", "--json"],
        op: "crm contact show",
        code: "CONTACT_NOT_FOUND",
        exitCode: 1,
      },
      {
        args: ["crm", "contact", "show", "__contract_missing_contact_with_agent__", "--json"],
        op: "crm contact show",
        code: "CONTACT_NOT_FOUND",
        exitCode: 1,
        agentId: "contract-handler-smoke",
      },
      {
        args: ["crm", "task", "show", "__contract_missing_task__", "--json"],
        op: "crm task show",
        code: "CRM_TASK_NOT_FOUND",
        exitCode: 1,
      },
      {
        args: ["audio", "generate", "--json"],
        op: "audio generate",
        code: "USAGE_ERROR",
        exitCode: 2,
      },
      {
        args: ["image", "generate", "contract probe", "--json"],
        op: "image generate",
        code: "IMAGE_PROVIDER_NOT_CONFIGURED",
        exitCode: 1,
      },
      {
        args: ["apps", "show", "contract-missing-app", "--json"],
        op: "apps show",
        code: "not_found",
        exitCode: 1,
      },
      {
        args: ["video", "analyze", "contract-probe", "--strategy", "invalid", "--json"],
        op: "video analyze",
        code: "USAGE_ERROR",
        exitCode: 2,
      },
    ] as const;

    for (const testCase of cases) {
      const result = runCli([...testCase.args], {
        RAVI_AGENT_ID: "agentId" in testCase ? testCase.agentId : undefined,
        RAVI_IMAGE_PROVIDER: undefined,
      });
      expect(result.status).toBe(testCase.exitCode);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        success: boolean;
        op: string;
        error: { code: string };
      };
      expect(payload).toMatchObject({
        success: false,
        op: testCase.op,
        error: { code: testCase.code },
      });
    }
  });

  it("exits 1 for a missing binary resource instead of reporting empty success", () => {
    const result = runCli(["audio", "blob", "__contract_missing_audio_blob__"], {
      RAVI_AGENT_ID: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Binary resource was not found.\n");
    expect(result.stderr).not.toContain("__contract_missing_audio_blob__");
  });

  it("keeps the audio missing-input text while preserving usage exit 2", () => {
    const result = runCli(["audio", "generate"], { RAVI_AGENT_ID: undefined });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Provide text or --text-file.\n");
  });

  it("renders legacy handler failures as one canonical JSON envelope", () => {
    const result = runCli(["audio", "generate", "--text-file", "../outside.txt", "--json"], {
      RAVI_AGENT_ID: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "audio generate",
      error: {
        code: "COMMAND_FAILED",
        message: "Command could not be completed.",
        retryable: false,
        suggestedAction: "Inspect the command input and retry 'audio generate'",
      },
    });
  });
});

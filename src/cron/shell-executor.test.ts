import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { classifyDiskPressureHint, isDiskPressureFailure } from "./disk-pressure.js";
import { parseEnvFile, runShellCronCommand } from "./shell-executor.js";

describe("parseEnvFile", () => {
  it("parses simple dotenv-style assignments", () => {
    expect(parseEnvFile("A=1\nexport B='two words'\n# ignored\nBAD-KEY=no\nC=\"three\"")).toEqual({
      A: "1",
      B: "two words",
      C: "three",
    });
  });
});

describe("runShellCronCommand", () => {
  it("captures successful shell output", async () => {
    const result = await runShellCronCommand("printf ok", { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("captures non-zero exit code and stderr", async () => {
    const result = await runShellCronCommand("printf fail >&2; exit 7", { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("fail");
  });

  it("loads env vars from env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-cron-shell-"));
    const envFile = join(dir, "job.env");
    writeFileSync(envFile, "RAVI_CRON_TEST_VALUE=loaded\n");

    try {
      const result = await runShellCronCommand("printf $RAVI_CRON_TEST_VALUE", { timeoutMs: 5_000, envFile });
      expect(result.stdout).toBe("loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges explicit env vars", async () => {
    const result = await runShellCronCommand("printf $RAVI_TRIGGER_TEST_VALUE", {
      timeoutMs: 5_000,
      env: { RAVI_TRIGGER_TEST_VALUE: "from-env" },
    });

    expect(result.stdout).toBe("from-env");
  });
});

describe("classifyDiskPressureHint", () => {
  it("classifies ENOSPC failures with a disk-pressure hint", () => {
    expect(isDiskPressureFailure("Error: ENOSPC: no space left on device, write")).toBe(true);
    const hint = classifyDiskPressureHint("write error: ENOSPC");
    expect(hint).toBeDefined();
    expect(hint).toContain("ENOSPC");
    expect(hint).toContain("ravi doctor");
  });

  it("classifies plain 'no space left on device' stderr", () => {
    expect(classifyDiskPressureHint("bash: cannot create temp file: No space left on device")).toBeDefined();
  });

  it("classifies temp-file creation failures", () => {
    expect(classifyDiskPressureHint("mktemp: failed to create temporary file")).toBeDefined();
  });

  it("does not classify unrelated failures", () => {
    expect(isDiskPressureFailure("command not found: foo")).toBe(false);
    expect(classifyDiskPressureHint("exit code 1: assertion failed")).toBeUndefined();
    expect(classifyDiskPressureHint(null, undefined, "")).toBeUndefined();
  });
});

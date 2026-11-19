import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { classifyDiskPressureHint, isDiskPressureFailure } from "./disk-pressure.js";
import { envFileTrustRefusal, MAX_ENV_FILE_BYTES, parseEnvFile, runShellCronCommand } from "./shell-executor.js";

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
    // Explicit mode: the loader refuses a file its group can write, which a umask of 002 would give.
    writeFileSync(envFile, "RAVI_CRON_TEST_VALUE=loaded\n", { mode: 0o600 });

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

/**
 * Runs `code` in a child bun with a time limit. A loader that blocks (opening a
 * FIFO, reading a device without end) is killed there and fails the test,
 * instead of hanging the whole run.
 */
function runInChild(code: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout };
}

/** A regular file another user owns that group and others cannot write, when there is one (not as root). */
const foreignEnvFile = ["/etc/hosts", "/etc/passwd"].find((path) => {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats?.isFile() && stats.uid !== process.getuid?.() && (stats.mode & 0o022) === 0;
});

describe("env file loading", () => {
  it("refuses a FIFO and a device without blocking, in a child process with a time limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-cron-env-file-"));
    try {
      const fifo = join(dir, "pipe.env");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const child = runInChild(`
        const { runShellCronCommand } = await import(${JSON.stringify(join(import.meta.dir, "shell-executor.ts"))});
        const errors = {};
        for (const [name, envFile] of Object.entries({ fifo: ${JSON.stringify(fifo)}, device: "/dev/zero" })) {
          try {
            await runShellCronCommand("printf ok", { timeoutMs: 5000, envFile });
            errors[name] = "loaded";
          } catch (error) {
            errors[name] = error.message;
          }
        }
        console.log(JSON.stringify(errors));
      `);
      // A blocked open or an endless read ends at the time limit with SIGKILL and no output.
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
      const errors = JSON.parse(child.stdout) as Record<string, string>;
      expect(errors.fifo).toContain("not a regular file");
      expect(errors.device).toContain("not a regular file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses a directory and an oversized file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-cron-env-file-"));
    try {
      await expect(runShellCronCommand("printf ok", { timeoutMs: 5_000, envFile: dir })).rejects.toThrow(
        "not a regular file",
      );

      const big = join(dir, "big.env");
      writeFileSync(big, `A=${"x".repeat(MAX_ENV_FILE_BYTES)}\n`, { mode: 0o600 });
      await expect(runShellCronCommand("printf ok", { timeoutMs: 5_000, envFile: big })).rejects.toThrow("larger than");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an env file its group or others can write, for shell crons and shell triggers alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-cron-env-file-"));
    try {
      const envFile = join(dir, "job.env");
      writeFileSync(envFile, "RAVI_CRON_TEST_VALUE=loaded\n", { mode: 0o600 });
      for (const mode of [0o666, 0o620, 0o602]) {
        chmodSync(envFile, mode);
        await expect(runShellCronCommand("printf ok", { timeoutMs: 5_000, envFile })).rejects.toThrow(
          "writable by its group or by others",
        );
      }
      // Readable by others is fine; only writing decides what the command runs.
      chmodSync(envFile, 0o644);
      const result = await runShellCronCommand("printf $RAVI_CRON_TEST_VALUE", { timeoutMs: 5_000, envFile });
      expect(result.stdout).toBe("loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!foreignEnvFile)("refuses an env file another user owns", async () => {
    await expect(runShellCronCommand("printf ok", { timeoutMs: 5_000, envFile: foreignEnvFile! })).rejects.toThrow(
      "belongs to another user",
    );
  });

  it("trusts a file only when the user Ravi runs as owns it and its group and others cannot write it", () => {
    expect(envFileTrustRefusal({ uid: 501, mode: 0o100600 }, 501)).toBeNull();
    expect(envFileTrustRefusal({ uid: 501, mode: 0o100644 }, 501)).toBeNull();
    expect(envFileTrustRefusal({ uid: 0, mode: 0o100600 }, 501)).toBe("not_owned");
    expect(envFileTrustRefusal({ uid: 501, mode: 0o100664 }, 501)).toBe("writable_by_others");
    expect(envFileTrustRefusal({ uid: 501, mode: 0o100602 }, 501)).toBe("writable_by_others");
  });
});

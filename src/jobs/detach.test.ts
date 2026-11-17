import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DETACH_AFTER_MS,
  MIN_DETACH_AFTER_MS,
  buildWrappedBashCommand,
  isDetachEnabled,
  jobExitStatePath,
  jobStatusFromExitCode,
  readJobExitState,
  resolveDetachAfterMs,
  shouldWrapBashCommand,
  signalFromExitCode,
} from "./detach.js";
import { renderDetachScript, resetDetachScriptCache, resolveDetachScriptPath } from "./detach-script.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-detach-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetDetachScriptCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detach threshold", () => {
  it("defaults to 25s", () => {
    expect(resolveDetachAfterMs({})).toBe(DEFAULT_DETACH_AFTER_MS);
  });

  it("reads the environment", () => {
    expect(resolveDetachAfterMs({ RAVI_JOBS_DETACH_AFTER_MS: "1234" })).toBe(1234);
  });

  it("refuses values below the floor, so every `ls` does not become a job", () => {
    expect(resolveDetachAfterMs({ RAVI_JOBS_DETACH_AFTER_MS: "10" })).toBe(MIN_DETACH_AFTER_MS);
    expect(resolveDetachAfterMs({ RAVI_JOBS_DETACH_AFTER_MS: "abc" })).toBe(DEFAULT_DETACH_AFTER_MS);
    expect(resolveDetachAfterMs({ RAVI_JOBS_DETACH_AFTER_MS: "-5" })).toBe(DEFAULT_DETACH_AFTER_MS);
  });

  it("is disabled only by the explicit switch", () => {
    expect(isDetachEnabled({})).toBe(true);
    expect(isDetachEnabled({ RAVI_JOBS_DETACH: "1" })).toBe(true);
    expect(isDetachEnabled({ RAVI_JOBS_DETACH: "0" })).toBe(false);
  });
});

describe("shouldWrapBashCommand", () => {
  const scriptPath = "/tmp/ravi-jobs-exec.sh";

  it("wraps a normal command", () => {
    expect(shouldWrapBashCommand("bun test src/jobs/", { scriptPath })).toBe(true);
  });

  it("does not wrap an empty command", () => {
    expect(shouldWrapBashCommand("", { scriptPath })).toBe(false);
    expect(shouldWrapBashCommand("   ", { scriptPath })).toBe(false);
    expect(shouldWrapBashCommand(null, { scriptPath })).toBe(false);
  });

  it("does not wrap a command that is already a job request", () => {
    expect(shouldWrapBashCommand("ravi jobs run -- sleep 100", { scriptPath })).toBe(false);
  });

  it("does not wrap a command that already passes through the wrapper", () => {
    expect(shouldWrapBashCommand(`${scriptPath} -- 'ls'`, { scriptPath })).toBe(false);
    expect(shouldWrapBashCommand("ravi-jobs-exec -- 'ls'", { scriptPath })).toBe(false);
  });

  it("respects the kill switch", () => {
    expect(shouldWrapBashCommand("bun test", { scriptPath, env: { RAVI_JOBS_DETACH: "0" } })).toBe(false);
  });
});

describe("buildWrappedBashCommand", () => {
  it("quotes the original command as a single argument, so `&` cannot leak", () => {
    const wrapped = buildWrappedBashCommand({
      scriptPath: "/tmp/ravi-jobs-exec.sh",
      command: "nohup python3 job.py & sleep 100",
    });
    expect(wrapped).toBe("'/tmp/ravi-jobs-exec.sh' -- 'nohup python3 job.py & sleep 100'");
  });

  it("passes the session and the agent before the command", () => {
    const wrapped = buildWrappedBashCommand({
      scriptPath: "/tmp/ravi-jobs-exec.sh",
      command: "bun test",
      sessionName: "dev",
      agentId: "dev",
    });
    expect(wrapped).toBe("'/tmp/ravi-jobs-exec.sh' --session 'dev' --agent 'dev' -- 'bun test'");
  });

  it("escapes single quotes instead of breaking the shell", () => {
    const wrapped = buildWrappedBashCommand({
      scriptPath: "/tmp/ravi-jobs-exec.sh",
      command: "printf 'hi'",
    });
    expect(wrapped).toBe("'/tmp/ravi-jobs-exec.sh' -- 'printf '\\''hi'\\'''");
  });
});

describe("exit state", () => {
  function writeState(logPath: string, value: string): void {
    writeFileSync(jobExitStatePath(logPath), value);
  }

  it("reads the exit code the shell wrote", () => {
    const dir = tempDir();
    const logPath = join(dir, "log");
    writeState(logPath, "0\n");
    expect(readJobExitState(logPath)).toEqual({ exitCode: 0, signal: null });
  });

  it("reads a killed process as 128 + signal", () => {
    const dir = tempDir();
    const logPath = join(dir, "log");
    writeState(logPath, "143");
    expect(readJobExitState(logPath)).toEqual({ exitCode: 143, signal: "SIGTERM" });
  });

  it("returns null when the command has not written state yet", () => {
    const dir = tempDir();
    expect(readJobExitState(join(dir, "missing"))).toBeNull();
    writeFileSync(join(dir, "garbage"), "not-a-number");
    expect(readJobExitState(join(dir, "garbage"))).toBeNull();
  });

  it("maps exit codes to job status honestly", () => {
    expect(jobStatusFromExitCode(0)).toBe("succeeded");
    expect(jobStatusFromExitCode(1)).toBe("failed");
    expect(jobStatusFromExitCode(143)).toBe("killed");
    expect(jobStatusFromExitCode(130)).toBe("killed");
    expect(signalFromExitCode(137)).toBe("SIGKILL");
    expect(signalFromExitCode(129)).toBe("SIGHUP");
    expect(signalFromExitCode(128)).toBe(null);
  });
});

describe("renderDetachScript", () => {
  it("bakes the CLI and the threshold without leaving placeholders", () => {
    const rendered = renderDetachScript({
      cli: { bin: "/usr/local/bin/bun", arg: "/opt/ravi/bundle/index.js" },
      detachAfterMs: 4000,
    });
    expect(rendered).not.toContain("@@");
    expect(rendered).toContain("RAVI_CLI_BIN='/usr/local/bin/bun'");
    expect(rendered).toContain("RAVI_CLI_ARG='/opt/ravi/bundle/index.js'");
    expect(rendered).toContain("DETACH_AFTER_MS_DEFAULT=4000");
  });

  it("escapes a quote in the CLI path", () => {
    const rendered = renderDetachScript({ cli: { bin: "/tmp/it's/bun", arg: null }, detachAfterMs: 1000 });
    expect(rendered).toContain(`RAVI_CLI_BIN='/tmp/it'\\''s/bun'`);
  });

  it("resolves the script under the state dir", () => {
    expect(resolveDetachScriptPath({ RAVI_STATE_DIR: "/tmp/state" })).toBe("/tmp/state/jobs/ravi-jobs-exec.sh");
  });
});

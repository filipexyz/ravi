import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";
import type { ReapDeps, ReapSandboxInfo } from "../../sandbox/reap.js";
import { ContractError } from "../agent-contract.js";
import { executeSandboxReap, validateSandboxRunFlags, validateTaskText } from "./sandbox.js";

setDefaultTimeout(60_000);

const stateDir = mkdtempSync(join(tmpdir(), "ravi-sandbox-cli-"));

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function usageError(run: () => unknown): ContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected a usage error");
}

describe("sandbox run flag validation", () => {
  it("accepts whole minutes from 1 to 55 and nothing else", () => {
    expect(validateSandboxRunFlags({}).timeoutMin).toBe(55);
    expect(validateSandboxRunFlags({ timeoutMin: "1" }).timeoutMin).toBe(1);
    expect(validateSandboxRunFlags({ timeoutMin: " 55 " }).timeoutMin).toBe(55);
    for (const timeoutMin of ["0", "56", "1.5", "abc", "-5", "1e1"]) {
      const error = usageError(() => validateSandboxRunFlags({ timeoutMin }, true));
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("USAGE_ERROR");
      expect(error.message).toContain("--timeout-min");
    }
  });

  it("rejects unknown --model-auth and --egress values with the accepted list", () => {
    const auth = usageError(() => validateSandboxRunFlags({ modelAuth: "bogus" }, true));
    expect(auth.exitCode).toBe(2);
    expect(auth.details.acceptedValues).toEqual(["broker", "header", "env"]);
    const egress = usageError(() => validateSandboxRunFlags({ egress: "bogus" }, true));
    expect(egress.exitCode).toBe(2);
    expect(egress.details.acceptedValues).toEqual(["dev-registries", "strict"]);
    expect(validateSandboxRunFlags({ modelAuth: "header", egress: "strict" })).toMatchObject({
      modelAuth: "header",
      egress: "strict",
    });
    // No flag: the mode is decided from the environment later, the preset is the default.
    expect(validateSandboxRunFlags({})).toMatchObject({ modelAuth: undefined, egress: "dev-registries" });
  });

  it("gates env model auth behind --allow-key-in-env and refuses --keep with it", () => {
    expect(usageError(() => validateSandboxRunFlags({ modelAuth: "env" }, true)).message).toContain(
      "--allow-key-in-env",
    );
    expect(validateSandboxRunFlags({ modelAuth: "env", allowKeyInEnv: true }).modelAuth).toBe("env");
    const keep = usageError(() => validateSandboxRunFlags({ modelAuth: "env", allowKeyInEnv: true, keep: true }, true));
    expect(keep.exitCode).toBe(2);
    expect(keep.message).toContain("--keep");
    expect(validateSandboxRunFlags({ modelAuth: "header", keep: true }).modelAuth).toBe("header");
  });

  it("accepts --github-auth header|file, defaulting to header, and rejects anything else", () => {
    expect(validateSandboxRunFlags({}).githubAuth).toBe("header");
    expect(validateSandboxRunFlags({ githubAuth: "file" }).githubAuth).toBe("file");
    expect(validateSandboxRunFlags({ githubAuth: "header" }).githubAuth).toBe("header");
    const error = usageError(() => validateSandboxRunFlags({ githubAuth: "env" }, true));
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe("USAGE_ERROR");
    expect(error.details.acceptedValues).toEqual(["header", "file"]);
  });

  it("treats --model-auth broker without RAVI_SANDBOX_ANTHROPIC_BASE_URL as a usage error", () => {
    const error = usageError(() => validateSandboxRunFlags({ modelAuth: "broker" }, true, {}));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("RAVI_SANDBOX_ANTHROPIC_BASE_URL");
    expect(
      usageError(() => validateSandboxRunFlags({ modelAuth: "broker" }, true, { RAVI_SANDBOX_ANTHROPIC_BASE_URL: " " }))
        .exitCode,
    ).toBe(2);
    expect(
      validateSandboxRunFlags({ modelAuth: "broker" }, true, { RAVI_SANDBOX_ANTHROPIC_BASE_URL: "https://b.example" })
        .modelAuth,
    ).toBe("broker");
    // Without the flag the mode is decided later from the environment; no URL is not an error here.
    expect(validateSandboxRunFlags({}, true, {}).modelAuth).toBeUndefined();
  });

  it("caps title and instructions at 100 KiB together, counting bytes", () => {
    const limit = 100 * 1024;
    expect(() => validateTaskText("t", "x".repeat(limit - 1))).not.toThrow();
    const error = usageError(() => validateTaskText("t", "x".repeat(limit), true));
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe("USAGE_ERROR");
    expect(error.message).toContain("100 KiB");
    // Two-byte characters count twice.
    expect(usageError(() => validateTaskText("", "é".repeat(limit / 2 + 1), true)).exitCode).toBe(2);
  });

  it("normalizes --allow-host entries and rejects anything that is not a host name", () => {
    expect(
      validateSandboxRunFlags({ allowHost: ["Internal.Example.com, *.corp.example", "pypi.org"] }).allowHosts,
    ).toEqual(["internal.example.com", "*.corp.example", "pypi.org"]);
    for (const bad of ["http://x.example.com", "x.example.com/path", "x.example.com:443", "localhost", "*"]) {
      expect(usageError(() => validateSandboxRunFlags({ allowHost: [bad] }, true)).exitCode).toBe(2);
    }
  });
});

describe("sandbox reap", () => {
  const HOST = "host-hash-16chars";
  const NOW = 1_700_000_000_000;
  function fleet(): ReapSandboxInfo[] {
    const base = { purpose: "ravi-task", ravi_run: "a".repeat(24), ravi_host: HOST };
    return [
      {
        sandboxId: "sbx-live",
        state: "running",
        startedAt: new Date(NOW - 60_000),
        metadata: { ...base, ravi_pid: "1" },
      },
      { sandboxId: "sbx-paused", state: "paused", startedAt: new Date(NOW - 60_000), metadata: base },
      {
        sandboxId: "sbx-dead",
        state: "running",
        startedAt: new Date(NOW - 60_000),
        metadata: { ...base, ravi_pid: "2" },
      },
      {
        sandboxId: "sbx-elsewhere",
        state: "paused",
        startedAt: new Date(NOW - 60_000),
        metadata: { ...base, ravi_host: "other-host-hash0" },
      },
    ];
  }
  function fakeDeps(items = fleet(), options: { killFails?: string[] } = {}) {
    const state = { queries: [] as Record<string, string>[], killed: [] as string[] };
    const deps: ReapDeps = {
      async list(metadata) {
        state.queries.push(metadata);
        return items.filter((info) => Object.entries(metadata).every(([k, v]) => info.metadata[k] === v));
      },
      async kill(sandboxId) {
        if (options.killFails?.includes(sandboxId)) throw new Error(`E2B refused ${sandboxId}`);
        state.killed.push(sandboxId);
      },
      now: () => NOW,
      isAlive: (pid) => pid === 1,
    };
    return { state, deps };
  }
  async function contractError(run: () => Promise<unknown>): Promise<ContractError> {
    try {
      await run();
    } catch (error) {
      if (error instanceof ContractError) return error;
      throw error;
    }
    throw new Error("expected a contract error");
  }

  it("dry-runs by default: exit 3 with the plan and no kill", async () => {
    const fake = fakeDeps();
    const error = await contractError(() => executeSandboxReap({ asJson: true }, HOST, fake.deps));
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("WRITE_REQUIRES_EXECUTE");
    // The brake names the effect: a kill, not a write.
    expect(error.message).toBe("Dry-run: nothing was killed. Re-run with --execute to kill.");
    expect(error.details.suggestedAction).toBe("Re-run 'sandbox reap' adding --execute to kill");
    const plan = error.details.plan as { kill: Array<{ sandboxId: string; cause: string }> };
    expect(plan).toMatchObject({ hostId: HOST, allHosts: false, olderThanMin: 65, skipped: 1 });
    expect(plan.kill.map(({ sandboxId, cause }) => [sandboxId, cause])).toEqual([
      ["sbx-paused", "paused"],
      ["sbx-dead", "dead-pid"],
    ]);
    expect(fake.state.killed).toEqual([]);
    expect(fake.state.queries).toEqual([{ purpose: "ravi-task", ravi_host: HOST }]);
  });

  it("with --execute kills only the matching sandboxes of this host", async () => {
    const fake = fakeDeps();
    const result = await executeSandboxReap({ execute: true, asJson: true }, HOST, fake.deps);
    expect(result.executed).toBe(true);
    expect(result.killed).toEqual(["sbx-paused", "sbx-dead"]);
    expect(result.failed).toEqual([]);
    expect(fake.state.killed).toEqual(["sbx-paused", "sbx-dead"]);
    expect(fake.state.killed).not.toContain("sbx-live");
    expect(fake.state.killed).not.toContain("sbx-elsewhere");
  });

  it("with --execute, a failed kill is reported and the rest are still killed (shared kill loop)", async () => {
    const fake = fakeDeps(fleet(), { killFails: ["sbx-paused"] });
    const result = await executeSandboxReap({ execute: true, asJson: true }, HOST, fake.deps);
    expect(result.executed).toBe(true);
    expect(result.killed).toEqual(["sbx-dead"]);
    expect(result.failed).toEqual([{ sandboxId: "sbx-paused", error: "E2B refused sbx-paused" }]);
    expect(result.candidates.map((c) => c.sandboxId)).toEqual(["sbx-paused", "sbx-dead"]);
    expect(fake.state.killed).toEqual(["sbx-dead"]);
  });

  it("reaches other hosts' sandboxes only with --all-hosts", async () => {
    const fake = fakeDeps();
    const result = await executeSandboxReap({ execute: true, allHosts: true, asJson: true }, HOST, fake.deps);
    expect(fake.state.queries).toEqual([{ purpose: "ravi-task" }]);
    expect(result.killed).toEqual(["sbx-paused", "sbx-dead", "sbx-elsewhere"]);
  });

  it("returns the empty plan with nothing to brake, and rejects a bad --older-than as a usage error", async () => {
    const quiet = fakeDeps(fleet().filter((info) => info.sandboxId === "sbx-live"));
    const result = await executeSandboxReap({ asJson: true }, HOST, quiet.deps);
    expect(result).toMatchObject({ candidates: [], executed: false, killed: [], scanned: 1 });
    for (const olderThan of ["0", "abc", "1.5", "-3"]) {
      const fake = fakeDeps();
      const error = await contractError(() => executeSandboxReap({ olderThan, asJson: true }, HOST, fake.deps));
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("USAGE_ERROR");
      expect(fake.state.queries).toEqual([]);
    }
    const fake = fakeDeps();
    const error = await contractError(() => executeSandboxReap({ olderThan: " 10 ", asJson: true }, HOST, fake.deps));
    expect(error.details.plan).toMatchObject({ olderThanMin: 10 });
  });
});

/**
 * Process-level proof: the usage errors happen before any credential is read or
 * any E2B call is made, so the spawned CLI gets no credential at all.
 */
describe("sandbox run usage exit codes", () => {
  function runCli(args: string[], options: { task?: boolean; command?: string[] } = {}) {
    const env = withoutRaviRuntimeContextEnv();
    for (const name of [
      "E2B_API_KEY",
      "ANTHROPIC_API_KEY",
      "RAVI_ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "RAVI_CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "RAVI_SANDBOX_ANTHROPIC_BASE_URL",
    ]) {
      delete env[name];
    }
    const result = spawnSync(
      "bun",
      [
        "src/cli/index.ts",
        ...(options.command ?? [
          "sandbox",
          "run",
          "--repo",
          "https://github.com/o/r.git",
          ...(options.task === false ? [] : ["--task", "x"]),
        ]),
        ...args,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...env, RAVI_STATE_DIR: stateDir, RAVI_SUPPRESS_AUDIT_EVENTS: "1" },
      },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("exits 2 with a USAGE_ERROR envelope for bad --timeout-min, --model-auth, --egress and --github-auth", () => {
    for (const args of [
      ["--timeout-min", "0"],
      ["--timeout-min", "56"],
      ["--timeout-min", "1.5"],
      ["--timeout-min", "abc"],
      ["--model-auth", "bogus"],
      // Explicit broker mode with no broker URL in the environment (runCli removes it).
      ["--model-auth", "broker"],
      ["--egress", "bogus"],
      ["--github-auth", "bogus"],
    ]) {
      const result = runCli([...args, "--json"]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        op: "sandbox run",
        error: { code: "USAGE_ERROR" },
      });
    }
  });

  it("exits 2 when the task text is over 100 KiB, before any credential is needed", () => {
    const taskFile = join(stateDir, "big-task.md");
    writeFileSync(taskFile, "x".repeat(100 * 1024));
    const result = runCli(["--task-file", taskFile, "--json"], { task: false });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, error: { code: "USAGE_ERROR" } });
    expect(JSON.parse(result.stdout).error.message).toContain("100 KiB");
  });

  it("exits 1 without E2B_API_KEY on sandbox reap, so no listing or kill is attempted", () => {
    const result = runCli(["--json"], { command: ["sandbox", "reap"] });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, op: "sandbox reap" });
    expect(JSON.parse(result.stdout).error.message).toContain("E2B_API_KEY");
  });
});

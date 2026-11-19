import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntilOutsideDaemonProcessTree } from "./daemon-process-tree.js";
import {
  buildDetachedUpdateEnv,
  createUpdateRunId,
  decideUpdateExecution,
  prepareUpdateRunDir,
  spawnDetachedUpdateProcess,
  UPDATE_HANDOFF_ENV,
  UPDATE_RUN_ID_ENV,
  UPDATE_RUN_ID_PATTERN,
  updateRunPaths,
} from "./update-run.js";

describe("update execution decision", () => {
  it("hands off from inside the daemon tree and runs inline elsewhere", () => {
    expect(decideUpdateExecution({ insideDaemonTree: true })).toBe("handoff");
    expect(decideUpdateExecution({ insideDaemonTree: false })).toBe("inline");
  });

  it("lets the run markers win over the tree check", () => {
    // The child is still inside the tree; without this it would hand off forever.
    expect(decideUpdateExecution({ handoffEnv: "1", insideDaemonTree: true })).toBe("reparent");
    expect(decideUpdateExecution({ handoffEnv: "1", workerEnv: "1", insideDaemonTree: true })).toBe("inline");
    expect(decideUpdateExecution({ workerEnv: "1", insideDaemonTree: false })).toBe("inline");
  });

  it("ignores marker values other than 1", () => {
    expect(decideUpdateExecution({ handoffEnv: "true", insideDaemonTree: true })).toBe("handoff");
    expect(decideUpdateExecution({ handoffEnv: "0", workerEnv: "", insideDaemonTree: false })).toBe("inline");
  });
});

describe("update run identity", () => {
  it("creates sortable run ids and rejects anything else as a path", () => {
    const runId = createUpdateRunId(new Date("2026-11-19T19:15:42.123Z"), () => "a1b2c3");
    expect(runId).toBe("20261119T191542Z-a1b2c3");
    expect(UPDATE_RUN_ID_PATTERN.test(runId)).toBe(true);
    expect(updateRunPaths(runId, "/state").result).toBe("/state/updates/20261119T191542Z-a1b2c3/result.json");
    for (const bad of ["", "../x", "20261119T191542Z-a1b2c3/../../etc", "20261119T191542Z-A1B2C3"]) {
      expect(() => updateRunPaths(bad, "/state")).toThrow("Invalid update run id");
    }
  });

  it("builds the detached environment without runtime context and with an absolute state directory", () => {
    const env = buildDetachedUpdateEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/op",
        PM2_HOME: "/home/op/.pm2",
        RAVI_CONTEXT_KEY: "ctx-secret",
        RAVI_SESSION_KEY: "agent:main:main",
        RAVI_SESSION_NAME: "main",
        RAVI_GATEWAY_URL: "http://127.0.0.1:4211",
        RAVI_INTERNAL_UPDATE_RUNTIME_REBIND: "request",
        RAVI_STATE_DIR: "relative-state",
        RAVI_REPO: "/src/ravi",
        RAVI_HOME: "/home/op/ravi",
      },
      "20261119T191542Z-a1b2c3",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PM2_HOME).toBe("/home/op/.pm2");
    expect(env.RAVI_REPO).toBe("/src/ravi");
    expect(env.RAVI_HOME).toBe("/home/op/ravi");
    expect(env.RAVI_STATE_DIR).toBe(join(process.cwd(), "relative-state"));
    expect(env[UPDATE_HANDOFF_ENV]).toBe("1");
    expect(env[UPDATE_RUN_ID_ENV]).toBe("20261119T191542Z-a1b2c3");
    for (const key of [
      "RAVI_CONTEXT_KEY",
      "RAVI_SESSION_KEY",
      "RAVI_SESSION_NAME",
      "RAVI_GATEWAY_URL",
      "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe("detached update process", () => {
  it("starts detached with output appended to the run log", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-run-"));
    try {
      const paths = updateRunPaths("20261119T191542Z-a1b2c3", stateDir);
      prepareUpdateRunDir(paths);
      const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      let unrefs = 0;
      const pid = spawnDetachedUpdateProcess(
        { command: "/bin/bun", args: ["cli.js", "update", "--json"], env: { A: "1" }, cwd: "/tmp", logPath: paths.log },
        (command, args, options) => {
          calls.push({ command, args, options });
          return { pid: 4242, unref: () => void unrefs++ };
        },
      );
      expect(pid).toBe(4242);
      expect(unrefs).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.options.detached).toBe(true);
      expect((calls[0]!.options.stdio as unknown[])[0]).toBe("ignore");
      expect(readFileSync(paths.log, "utf8")).toBe("");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails when the process manager returns no pid", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-run-"));
    try {
      const paths = updateRunPaths("20261119T191542Z-a1b2c3", stateDir);
      prepareUpdateRunDir(paths);
      expect(() =>
        spawnDetachedUpdateProcess({ command: "/missing", args: [], env: {}, cwd: "/tmp", logPath: paths.log }, () => ({
          pid: undefined,
          unref: () => {},
        })),
      ).toThrow("could not start /missing");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("waiting to leave the daemon tree", () => {
  it("returns once the worker is reparented and refuses after the deadline", async () => {
    let clock = 0;
    const timing = { now: () => clock, wait: async (ms: number) => void (clock += ms), pollMs: 100, timeoutMs: 1_000 };
    let checks = 0;
    expect(await waitUntilOutsideDaemonProcessTree({ ...timing, isInside: () => ++checks < 3 })).toBe(true);
    expect(checks).toBe(3);
    clock = 0;
    expect(await waitUntilOutsideDaemonProcessTree({ ...timing, isInside: () => true })).toBe(false);
    expect(clock).toBe(1_000);
  });
});

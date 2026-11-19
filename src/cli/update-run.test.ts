import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPm2Env, clearedPm2ContextEnv } from "../pm2.js";
import { waitUntilOutsideDaemonProcessTree } from "./daemon-process-tree.js";
import {
  buildDetachedUpdateEnv,
  createUpdateRunId,
  type DetachedChild,
  decideUpdateExecution,
  prepareUpdateRunDir,
  resolveDetachedUpdateStateDir,
  spawnDetachedUpdateProcess,
  UPDATE_HANDOFF_ENV,
  UPDATE_HANDOFF_WORKER_ENV,
  UPDATE_RUN_ID_ENV,
  UPDATE_RUN_ID_PATTERN,
  updateRunPaths,
} from "./update-run.js";

/** Like node:child_process, the launch outcome arrives as an event after spawn() returns. */
function fakeChild(pid: number | null, onUnref: () => void = () => {}): DetachedChild {
  const child = Object.assign(new EventEmitter(), { pid: pid ?? undefined, unref: onUnref });
  queueMicrotask(() => {
    if (pid === null) child.emit("error", new Error("spawn /missing ENOENT"));
    else child.emit("spawn");
  });
  return child;
}

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

  it("builds the detached environment without runtime context and with the resolved state directory", () => {
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
      "/srv/daemon/relative-state",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PM2_HOME).toBe("/home/op/.pm2");
    expect(env.RAVI_REPO).toBe("/src/ravi");
    expect(env.RAVI_HOME).toBe("/home/op/ravi");
    expect(env.RAVI_STATE_DIR).toBe("/srv/daemon/relative-state");
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
    // Unset state directory: nothing is added, the worker uses the default ~/.ravi like the daemon.
    expect(
      buildDetachedUpdateEnv({ RAVI_STATE_DIR: "relative-state" }, "20261119T191542Z-a1b2c3", undefined),
    ).not.toHaveProperty("RAVI_STATE_DIR");
  });

  it("anchors a relative state directory at the daemon's cwd, never the caller's (#857)", () => {
    expect(resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "state" }, "/srv/daemon")).toBe("/srv/daemon/state");
    expect(resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "../shared/state" }, "/srv/daemon")).toBe(
      "/srv/shared/state",
    );
    expect(resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "state" }, "/srv/daemon")).not.toBe(
      join(process.cwd(), "state"),
    );
    expect(resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "/abs/state" }, null)).toBe("/abs/state");
    expect(resolveDetachedUpdateStateDir({}, null)).toBeUndefined();
    expect(resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "" }, "/srv/daemon")).toBeUndefined();
    expect(() => resolveDetachedUpdateStateDir({ RAVI_STATE_DIR: "state" }, null)).toThrow(
      "the daemon's working directory is unknown",
    );
  });
});

describe("detached update process", () => {
  it("starts detached with output appended to the run log", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-run-"));
    try {
      const paths = updateRunPaths("20261119T191542Z-a1b2c3", stateDir);
      prepareUpdateRunDir(paths);
      const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      let unrefs = 0;
      const pid = await spawnDetachedUpdateProcess(
        { command: "/bin/bun", args: ["cli.js", "update", "--json"], env: { A: "1" }, cwd: "/tmp", logPath: paths.log },
        (command, args, options) => {
          calls.push({ command, args, options });
          return fakeChild(4242, () => void unrefs++);
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

  it("rejects when the launch reports an error event", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-run-"));
    try {
      const paths = updateRunPaths("20261119T191542Z-a1b2c3", stateDir);
      prepareUpdateRunDir(paths);
      await expect(
        spawnDetachedUpdateProcess({ command: "/missing", args: [], env: {}, cwd: "/tmp", logPath: paths.log }, () =>
          fakeChild(null),
        ),
      ).rejects.toThrow("spawn /missing ENOENT");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // The real spawn: a failed launch is an asynchronous error event, which used
  // to escape as an unhandled event after the caller had already refused.
  it("rejects a missing executable or working directory with the real spawn", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-run-"));
    try {
      const paths = updateRunPaths("20261119T191542Z-a1b2c3", stateDir);
      prepareUpdateRunDir(paths);
      const missingCommand = join(stateDir, "missing-binary");
      await expect(
        spawnDetachedUpdateProcess({ command: missingCommand, args: [], env: {}, cwd: stateDir, logPath: paths.log }),
      ).rejects.toThrow("ENOENT");
      await expect(
        spawnDetachedUpdateProcess({
          command: process.execPath,
          args: ["--version"],
          env: {},
          cwd: join(stateDir, "gone"),
          logPath: paths.log,
        }),
      ).rejects.toThrow("ENOENT");
      const pid = await spawnDetachedUpdateProcess({
        command: process.execPath,
        args: ["--version"],
        env: {},
        cwd: stateDir,
        logPath: paths.log,
      });
      expect(pid).toBeGreaterThan(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("run markers and the services the update starts", () => {
  it("PM2 registrations clear every update marker, so a restarted daemon hands off as a fresh run", () => {
    const keys = [UPDATE_HANDOFF_ENV, UPDATE_HANDOFF_WORKER_ENV, UPDATE_RUN_ID_ENV];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    try {
      process.env[UPDATE_HANDOFF_ENV] = "1";
      process.env[UPDATE_HANDOFF_WORKER_ENV] = "1";
      process.env[UPDATE_RUN_ID_ENV] = "20261119T191542Z-a1b2c3";
      const serviceEnv = buildPm2Env({ RAVI_STATE_DIR: "/state" });
      for (const key of keys) {
        expect(serviceEnv[key]).toBe("");
        expect(clearedPm2ContextEnv()[key]).toBe("");
      }
      expect(
        decideUpdateExecution({
          handoffEnv: serviceEnv[UPDATE_HANDOFF_ENV],
          workerEnv: serviceEnv[UPDATE_HANDOFF_WORKER_ENV],
          insideDaemonTree: true,
        }),
      ).toBe("handoff");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

  it("counts an unreadable PM2 as still inside, so the worker never proceeds on a failed read", async () => {
    let clock = 0;
    const timing = { now: () => clock, wait: async (ms: number) => void (clock += ms), pollMs: 100, timeoutMs: 1_000 };
    const unreadable = () => {
      throw new Error("Empty PM2 snapshot");
    };
    expect(await waitUntilOutsideDaemonProcessTree({ ...timing, isInside: unreadable })).toBe(false);
    expect(clock).toBe(1_000);
    clock = 0;
    let reads = 0;
    const flaky = () => {
      reads += 1;
      if (reads === 1) throw new Error("Empty PM2 snapshot");
      return false;
    };
    expect(await waitUntilOutsideDaemonProcessTree({ ...timing, isInside: flaky })).toBe(true);
    expect(reads).toBe(2);
  });
});

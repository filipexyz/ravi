import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maybeRunManagedRuntimeRebindFromEnv,
  refuseRebindInsideDaemonTree,
  UPDATE_SUPERVISOR_IN_DAEMON_TREE,
} from "../../managed-runtime-rebind.js";
import {
  UPDATE_HANDOFF_ENV,
  UPDATE_HANDOFF_WORKER_ENV,
  UPDATE_RUN_ID_ENV,
  updateRunPaths,
  type DetachedSpawn,
} from "../update-run.js";
import { runUpdate, type RaviUpdateHandoff } from "./update.js";

const RUN_ID = "20261119T191542Z-a1b2c3";
const SCRIPT = "/opt/ravi/node_modules/ravi.bot/dist/bundle/index.js";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

type SpawnCall = { command: string; args: string[]; env: Record<string, string>; cwd: string };

/** A failed launch reports itself the way node:child_process does: an error event after spawn() returns. */
function recordingSpawn(calls: SpawnCall[], pid: number | null = 4242): DetachedSpawn {
  return (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd });
    const child = Object.assign(new EventEmitter(), { pid: pid ?? undefined, unref: () => {} });
    queueMicrotask(() => {
      if (pid === null) child.emit("error", new Error(`spawn ${command} ENOENT`));
      else child.emit("spawn");
    });
    return child;
  };
}

describe("ravi update inside the daemon process tree", () => {
  let stateDir: string;
  let inheritedStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ravi-update-detach-"));
    inheritedStateDir = process.env.RAVI_STATE_DIR;
    // updateConfigPath() reads the process environment: an update that ran
    // inline would persist the channel here.
    process.env.RAVI_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (inheritedStateDir === undefined) delete process.env.RAVI_STATE_DIR;
    else process.env.RAVI_STATE_DIR = inheritedStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const baseEnv = () => ({
    PATH: "/usr/bin",
    HOME: "/home/op",
    RAVI_STATE_DIR: stateDir,
    RAVI_CONTEXT_KEY: "ctx-from-agent-turn",
    RAVI_SESSION_NAME: "main",
  });

  it("hands the request to a detached child and installs or stops nothing itself", async () => {
    const calls: SpawnCall[] = [];
    const result = (await runUpdate(
      { next: true, json: true },
      {
        env: baseEnv(),
        argv: ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"],
        execPath: "/usr/bin/bun",
        cwd: "/work",
        now: () => new Date("2026-11-19T19:15:42.000Z"),
        insideDaemonTree: () => true,
        spawnDetached: recordingSpawn(calls),
      },
    )) as RaviUpdateHandoff;

    expect(result.mode).toBe("handoff");
    expect(result.requested).toBe("next");
    expect(result.runId).toMatch(/^20261119T191542Z-[0-9a-f]{6}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/bun");
    expect(calls[0]!.args).toEqual([SCRIPT, "update", "--next", "--json"]);
    expect(calls[0]!.cwd).toBe("/work");
    expect(calls[0]!.env[UPDATE_HANDOFF_ENV]).toBe("1");
    expect(calls[0]!.env[UPDATE_RUN_ID_ENV]).toBe(result.runId);
    expect(calls[0]!.env[UPDATE_HANDOFF_WORKER_ENV]).toBeUndefined();
    expect(calls[0]!.env.RAVI_CONTEXT_KEY).toBeUndefined();
    expect(calls[0]!.env.RAVI_SESSION_NAME).toBeUndefined();

    const paths = updateRunPaths(result.runId, stateDir);
    expect(result.resultPath).toBe(paths.result);
    expect(JSON.parse(readFileSync(paths.request, "utf8"))).toMatchObject({
      runId: result.runId,
      requested: "next",
      args: ["update", "--next", "--json"],
      reason: "daemon-process-tree",
    });
    // Nothing of the update itself ran in the caller.
    expect(existsSync(join(stateDir, "update.json"))).toBe(false);
    expect(existsSync(paths.result)).toBe(false);
  });

  it("refuses instead of running inline when the detached child cannot start", async () => {
    const calls: SpawnCall[] = [];
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env: baseEnv(),
          argv: ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"],
          insideDaemonTree: () => true,
          spawnDetached: recordingSpawn(calls, null),
        },
      ),
    ).rejects.toMatchObject({
      code: "UPDATE_DETACH_FAILED",
      details: { suggestedAction: "Run ravi update from a terminal." },
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(stateDir, "update.json"))).toBe(false);
  });

  it("passes the channel it resolved to the worker instead of resolving it again", async () => {
    writeFileSync(join(stateDir, "update.json"), JSON.stringify({ updateChannel: "next" }));
    const calls: SpawnCall[] = [];
    const result = (await runUpdate(
      { json: true },
      {
        env: baseEnv(),
        argv: ["/usr/bin/bun", SCRIPT, "update", "--json"],
        insideDaemonTree: () => true,
        spawnDetached: recordingSpawn(calls),
      },
    )) as RaviUpdateHandoff;
    expect(result.requested).toBe("next");
    expect(calls[0]!.args).toEqual([SCRIPT, "update", "--next", "--json"]);
    expect(JSON.parse(readFileSync(updateRunPaths(result.runId, stateDir).request, "utf8")).args).toEqual([
      "update",
      "--next",
      "--json",
    ]);
  });

  it("refuses when PM2 cannot be read, before detaching, installing or stopping anything", async () => {
    const calls: SpawnCall[] = [];
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env: baseEnv(),
          argv: ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"],
          insideDaemonTree: () => {
            throw new Error("Empty PM2 snapshot");
          },
          spawnDetached: recordingSpawn(calls),
        },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_FAILED" });
    // An unreadable PM2 is never taken for "outside": nothing ran inline and nothing was handed off.
    expect(calls).toHaveLength(0);
    expect(existsSync(join(stateDir, "update.json"))).toBe(false);
    expect(existsSync(join(stateDir, "updates"))).toBe(false);
  });

  it("still reports a usage error first when PM2 cannot be read", async () => {
    await expect(
      runUpdate(
        { next: true, stable: true, json: true },
        {
          env: baseEnv(),
          insideDaemonTree: () => {
            throw new Error("Empty PM2 snapshot");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("anchors a relative state directory at the daemon's cwd, never the caller's (#857)", async () => {
    const daemonCwd = mkdtempSync(join(tmpdir(), "ravi-update-daemon-cwd-"));
    try {
      const calls: SpawnCall[] = [];
      const result = (await runUpdate(
        { next: true, json: true },
        {
          env: { ...baseEnv(), RAVI_STATE_DIR: "relative-state" },
          argv: ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"],
          cwd: "/work",
          insideDaemonTree: () => true,
          daemonCwd,
          spawnDetached: recordingSpawn(calls),
        },
      )) as RaviUpdateHandoff;
      const daemonStateDir = join(daemonCwd, "relative-state");
      const paths = updateRunPaths(result.runId, daemonStateDir);
      expect(calls[0]!.env.RAVI_STATE_DIR).toBe(daemonStateDir);
      expect(result.resultPath).toBe(paths.result);
      expect(existsSync(paths.request)).toBe(true);
      expect(existsSync(join(process.cwd(), "relative-state"))).toBe(false);
    } finally {
      rmSync(daemonCwd, { recursive: true, force: true });
    }
  });

  it("refuses a relative state directory when the daemon's cwd is unknown", async () => {
    const calls: SpawnCall[] = [];
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env: { ...baseEnv(), RAVI_STATE_DIR: "relative-state" },
          argv: ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"],
          insideDaemonTree: () => true,
          daemonCwd: null,
          spawnDetached: recordingSpawn(calls),
        },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_DETACH_FAILED" });
    expect(calls).toHaveLength(0);
    expect(existsSync(join(process.cwd(), "relative-state"))).toBe(false);
  });

  it("reports a usage error to the caller instead of detaching it", async () => {
    const calls: SpawnCall[] = [];
    await expect(
      runUpdate(
        { next: true, stable: true, json: true },
        {
          env: baseEnv(),
          argv: ["/usr/bin/bun", SCRIPT],
          insideDaemonTree: () => true,
          spawnDetached: recordingSpawn(calls),
        },
      ),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    expect(calls).toHaveLength(0);
  });

  it("the detached child starts the worker with the same request and exits at once", async () => {
    const calls: SpawnCall[] = [];
    const argv = ["/usr/bin/bun", SCRIPT, "update", "--next", "--json"];
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env: { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir, [UPDATE_HANDOFF_ENV]: "1", [UPDATE_RUN_ID_ENV]: RUN_ID },
          argv,
          execPath: "/usr/bin/bun",
          cwd: "/work",
          // Still inside the tree: the marker decides, not the tree check.
          insideDaemonTree: () => true,
          spawnDetached: recordingSpawn(calls),
          exit: (code) => {
            throw new ExitSignal(code);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(argv.slice(1));
    expect(calls[0]!.env[UPDATE_HANDOFF_ENV]).toBe("1");
    expect(calls[0]!.env[UPDATE_HANDOFF_WORKER_ENV]).toBe("1");
    expect(calls[0]!.env[UPDATE_RUN_ID_ENV]).toBe(RUN_ID);
    expect(existsSync(join(stateDir, "update.json"))).toBe(false);
  });

  it("a worker that never leaves the tree refuses before installing and records why", async () => {
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env: {
            PATH: "/usr/bin",
            RAVI_STATE_DIR: stateDir,
            [UPDATE_HANDOFF_ENV]: "1",
            [UPDATE_HANDOFF_WORKER_ENV]: "1",
            [UPDATE_RUN_ID_ENV]: RUN_ID,
          },
          insideDaemonTree: () => true,
          waitUntilDetached: async () => false,
        },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_DETACH_FAILED" });
    expect(JSON.parse(readFileSync(updateRunPaths(RUN_ID, stateDir).result, "utf8"))).toMatchObject({
      runId: RUN_ID,
      status: "failed",
      code: "UPDATE_DETACH_FAILED",
    });
    expect(existsSync(join(stateDir, "update.json"))).toBe(false);
  });

  it("a worker takes its run markers out of the environment before installing anything", async () => {
    const markers = [UPDATE_HANDOFF_ENV, UPDATE_HANDOFF_WORKER_ENV, UPDATE_RUN_ID_ENV];
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      RAVI_STATE_DIR: stateDir,
      [UPDATE_HANDOFF_ENV]: "1",
      [UPDATE_HANDOFF_WORKER_ENV]: "1",
      [UPDATE_RUN_ID_ENV]: RUN_ID,
    };
    let seenWhileWaiting: NodeJS.ProcessEnv = {};
    await expect(
      runUpdate(
        { next: true, json: true },
        {
          env,
          insideDaemonTree: () => true,
          waitUntilDetached: async () => {
            seenWhileWaiting = { ...env };
            return false;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_DETACH_FAILED" });
    // Installers, PM2 and the services it restarts all start after this wait.
    for (const key of markers) {
      expect(seenWhileWaiting[key]).toBeUndefined();
      expect(env[key]).toBeUndefined();
    }
    expect(seenWhileWaiting.RAVI_STATE_DIR).toBe(stateDir);
    expect(JSON.parse(readFileSync(updateRunPaths(RUN_ID, stateDir).result, "utf8"))).toMatchObject({
      runId: RUN_ID,
      status: "failed",
    });
  });

  it("an inline update that inherited only a run id leaves that run's result alone", async () => {
    await expect(
      runUpdate(
        { next: true, stable: true, json: true },
        {
          env: { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir, [UPDATE_RUN_ID_ENV]: RUN_ID },
          insideDaemonTree: () => false,
        },
      ),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    expect(existsSync(updateRunPaths(RUN_ID, stateDir).result)).toBe(false);
  });
});

describe("update supervisor inside the daemon process tree", () => {
  let stateDir: string;
  let inheritedStateDir: string | undefined;
  const REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ravi-update-supervisor-"));
    inheritedStateDir = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env[REBIND_ENV];
    if (inheritedStateDir === undefined) delete process.env.RAVI_STATE_DIR;
    else process.env.RAVI_STATE_DIR = inheritedStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses before reading the request or touching PM2, and leaves evidence", async () => {
    // An undecodable request proves the refusal comes first.
    process.env[REBIND_ENV] = "not-a-request";
    await expect(maybeRunManagedRuntimeRebindFromEnv(() => true)).rejects.toThrow(UPDATE_SUPERVISOR_IN_DAEMON_TREE);
    expect(process.env[REBIND_ENV]).toBeUndefined();
    const evidence = JSON.parse(readFileSync(join(stateDir, "updates", "supervisor-refused.json"), "utf8"));
    expect(evidence.code).toBe(UPDATE_SUPERVISOR_IN_DAEMON_TREE);
  });

  it("refuses like inside when PM2 cannot be read, and records why", async () => {
    process.env[REBIND_ENV] = "not-a-request";
    await expect(
      maybeRunManagedRuntimeRebindFromEnv(() => {
        throw new Error("Empty PM2 snapshot");
      }),
    ).rejects.toThrow(UPDATE_SUPERVISOR_IN_DAEMON_TREE);
    const evidence = JSON.parse(readFileSync(join(stateDir, "updates", "supervisor-refused.json"), "utf8"));
    expect(evidence.code).toBe(UPDATE_SUPERVISOR_IN_DAEMON_TREE);
    expect(evidence.message).toContain("could not read PM2");
    expect(evidence.message).toContain("Empty PM2 snapshot");
  });

  it("proceeds outside the tree", async () => {
    expect(() => refuseRebindInsideDaemonTree(() => false, stateDir)).not.toThrow();
    process.env[REBIND_ENV] = "not-a-request";
    await expect(maybeRunManagedRuntimeRebindFromEnv(() => false)).rejects.toThrow(
      "Invalid managed runtime rebind request",
    );
    expect(existsSync(join(stateDir, "updates", "supervisor-refused.json"))).toBe(false);
  });

  it("is not a supervisor without the request", async () => {
    expect(await maybeRunManagedRuntimeRebindFromEnv(() => true)).toBe(false);
  });
});

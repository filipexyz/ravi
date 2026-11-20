import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import {
  acquireUpdateSupervisorLock,
  buildManagedRuntimeRebindSupervisorInvocation,
  decodeManagedRuntimeRebindRequest,
  type ManagedRuntimeSupervisorOutcome,
  maybeRunManagedRuntimeRebindFromEnv,
  rebindManagedRuntimeProcesses,
  UPDATE_IN_PROGRESS,
} from "./managed-runtime-rebind.js";
import { resolveManagedRuntimeTargetFromPackageRoot } from "./managed-runtime.js";
import type { Pm2Process } from "./pm2.js";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from "./runtime-process-identity.js";
import { runUpdate } from "./cli/commands/update.js";
import { requiredFenceAdoptionWaypoint, UPDATE_WAYPOINT_REQUIRED } from "./update-preflight.js";
import { hopThroughWaypoint, type WaypointHopDependencies, waypointPreparedState } from "./update-waypoint.js";
import {
  globalInstallMethodOf,
  previousReleaseCliEnv,
  readUpdateSupervisorResult,
  resolveUpdateRollbackPlan,
  planOperatorRollback,
  rollBackUpdate,
  superviseOperatorRollback,
  UPDATE_ROLLBACK_UNAVAILABLE,
  type UpdateRollbackDependencies,
  type UpdateRollbackPlan,
} from "./update-rollback.js";
import {
  planUpdateSnapshot,
  takeUpdateSnapshot,
  UPDATE_SNAPSHOT_SPACE,
  UpdateSnapshotRestoreError,
  updateSnapshotsDir,
  type UpdateSnapshotManifest,
} from "./update-snapshot.js";

const roots: string[] = [];
const inheritedStateDir = process.env.RAVI_STATE_DIR;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (inheritedStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = inheritedStateDir;
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A global bun install of ravi.bot at `version`, the way `bun install -g` lays it out. */
function globalInstall(version: string) {
  const home = tempDir("ravi-rollback-home-");
  const root = join(home, ".bun", "install", "global", "node_modules", "ravi.bot");
  mkdirSync(join(root, "dist", "bundle"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot", version }));
  writeFileSync(join(root, "dist", "bundle", "index.js"), "// bundle\n");
  const target = resolveManagedRuntimeTargetFromPackageRoot(root)!;
  return {
    root: target.cwd,
    target,
    setVersion: (next: string) =>
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot", version: next })),
  };
}

function pm2Process(
  name: "ravi" | "ravi-channels",
  bundlePath: string,
  cwd: string,
  overrides: Partial<Pm2Process>,
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 10 : 20,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? bundlePath : "/usr/local/bin/bun",
    cwd,
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    createdAt: 1,
    ...overrides,
  };
}

function boot(stateDir: string, process: Pm2Process, bundlePath: string, runningVersion: string): void {
  writeRuntimeBootReceipt(
    {
      ...observeRuntimeBoot({
        bundlePath,
        runningVersion,
        envFile: join(stateDir, ".env"),
        now: process.startedAt!,
      }),
      schemaVersion: 1,
      name: process.name as "ravi" | "ravi-channels",
      pid: process.pid,
      startedAt: process.startedAt!,
    },
    stateDir,
  );
}

describe("update rollback plan", () => {
  it("rolls back to the release the daemon proved it was running, in the same global install", () => {
    const stateDir = tempDir("ravi-rollback-state-");
    const install = globalInstall("3.2.0");
    const startedAt = Math.ceil(statSync(install.target.bundlePath).mtimeMs) + 1;
    const daemon = pm2Process("ravi", install.target.bundlePath, install.root, { startedAt });
    const channels = pm2Process("ravi-channels", install.target.bundlePath, install.root, { startedAt });
    boot(stateDir, daemon, install.target.bundlePath, "3.1.0");

    expect(resolveUpdateRollbackPlan({ target: install.target, processes: [daemon, channels], stateDir })).toEqual({
      previousRelease: "3.1.0",
      method: "bun",
      packageRoot: install.root,
      channelsOnline: true,
    });
  });

  it("does not roll back without a proven previous release, to the same release, or from a checkout", () => {
    const stateDir = tempDir("ravi-rollback-state-");
    const install = globalInstall("3.2.0");
    const startedAt = Math.ceil(statSync(install.target.bundlePath).mtimeMs) + 1;
    const daemon = pm2Process("ravi", install.target.bundlePath, install.root, { startedAt });

    // No boot receipt: the running release is unproven.
    expect(resolveUpdateRollbackPlan({ target: install.target, processes: [daemon], stateDir })).toBeNull();
    boot(stateDir, daemon, install.target.bundlePath, "3.2.0");
    expect(resolveUpdateRollbackPlan({ target: install.target, processes: [daemon], stateDir })).toBeNull();

    expect(globalInstallMethodOf("/home/u/.bun/install/global/node_modules/ravi.bot")).toBe("bun");
    expect(globalInstallMethodOf("/usr/lib/node_modules/ravi.bot")).toBe("npm");
    expect(globalInstallMethodOf("/home/u/dev/ravi.bot")).toBeNull();
  });

  it("gives the previous release's CLI no target routing and no runtime context", () => {
    const env = previousReleaseCliEnv({
      PATH: "/bin",
      HOME: "/home/u",
      RAVI_STATE_DIR: "/home/u/.ravi",
      RAVI_BUNDLE: "/target/dist/bundle/index.js",
      RAVI_DAEMON_CWD: "/target",
      RAVI_CONTEXT_KEY: "",
      RAVI_SESSION_KEY: "",
      RAVI_UPDATE_SUPERVISOR_BUDGET_MS: "900000",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", RAVI_STATE_DIR: "/home/u/.ravi" });
  });
});

function rollbackFixture(
  input: {
    failInstall?: boolean;
    stuckPid?: boolean;
    phase?: "waiting" | "owned" | "ready" | null;
    restartAfterSave?: boolean;
    throwAfterRestore?: boolean;
    /** The release rolled back to; 3.1.0 predates the schema phase records. */
    previousRelease?: string;
    /** No snapshot: the update already stopped both processes (pids 300 and 301), and the state is untouched. */
    untouched?: boolean;
  } = {},
) {
  const previousRelease = input.previousRelease ?? "3.1.0";
  const stateDir = tempDir("ravi-rollback-state-");
  const install = globalInstall("3.2.0");
  const bundle = install.target.bundlePath;
  const epoch = Math.ceil(statSync(bundle).mtimeMs) + 1;
  let processes: Pm2Process[] = input.untouched
    ? []
    : [
        pm2Process("ravi", bundle, install.root, { pm_id: 5, pid: 300, startedAt: epoch }),
        pm2Process("ravi-channels", bundle, install.root, { pm_id: 6, pid: 301, startedAt: epoch }),
      ];
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const order: string[] = [];
  let nextPid = 400;
  const start = (name: "ravi" | "ravi-channels") => {
    const process = pm2Process(name, bundle, install.root, {
      pm_id: nextPid,
      pid: nextPid,
      startedAt: epoch + nextPid,
    });
    nextPid += 1;
    processes.push(process);
    boot(stateDir, process, bundle, previousRelease);
  };
  const plan: UpdateRollbackPlan = {
    previousRelease,
    method: "bun",
    packageRoot: install.root,
    channelsOnline: true,
  };
  const manifest = {
    id: "20261119T200000Z-abcdef",
    stores: [join(stateDir, "ravi.db")],
    files: [{ source: join(stateDir, "ravi.db"), name: "0-ravi.db", bytes: 8192 }],
    createdAt: "2026-11-19T20:00:00.000Z",
    targetRelease: "3.2.0",
  } as UpdateSnapshotManifest;
  let saved = false;
  let readsAfterSave = 0;
  let restoredState = false;
  const deps: UpdateRollbackDependencies = {
    stateDir,
    plan,
    manifest: input.untouched ? null : manifest,
    ...(input.untouched ? { stoppedPids: [300, 301] } : {}),
    previousProcesses: [
      { name: "ravi", status: "online", pid: 10, createdAt: 1 },
      { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
    ],
    bunPath: "/usr/local/bin/bun",
    env: { PATH: "/bin", RAVI_BUNDLE: bundle, RAVI_CONTEXT_KEY: "" },
    getProcesses: () => {
      if (input.throwAfterRestore && restoredState) throw new Error("Unable to read the managed PM2 processes");
      // A restored daemon that restarts once the window began (the save check and the window's first read pass):
      // a new PID and start time.
      if (saved) readsAfterSave += 1;
      if (input.restartAfterSave && readsAfterSave > 2)
        return processes.map((process) =>
          process.name === "ravi" ? { ...process, pid: 999, startedAt: (process.startedAt ?? 0) + 5_000 } : process,
        );
      return processes;
    },
    pidAlive: (pid) => input.stuckPid === true && pid === 300,
    schemaPhase: () => (input.phase === undefined ? "ready" : input.phase),
    stabilityWindowMs: 1_000,
    startTimeoutMs: 2_000,
    now: (() => {
      let time = 0;
      return () => (time += 100);
    })(),
    wait: async () => {},
    acquireOwnership: () => {
      order.push("lock");
      return { release: () => order.push("unlock") };
    },
    restore: () => {
      order.push("restore");
      restoredState = true;
      return { candidateDir: join(stateDir, "candidate"), restoredAt: "2026-11-19T20:01:00.000Z" };
    },
    settleLeftovers: () => "none",
    log: () => {},
    run: async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      if (command === "pm2" && args[0] === "delete") {
        processes = processes.filter((process) => String(process.pm_id) !== args[1]);
      } else if (command === "bun" && args[0] === "install") {
        if (input.failInstall) return { success: false, output: "registry unreachable" };
        install.setVersion(previousRelease);
      } else if (args[1] === "daemon" && args[2] === "start") start("ravi");
      else if (args[1] === "channels" && args[2] === "start") start("ravi-channels");
      else if (command === "pm2" && args[0] === "save") saved = true;
      return { success: true, output: "" };
    },
  };
  return { deps, calls, order, install };
}

describe("update rollback", () => {
  it("stops the target, restores the state under the locks, reinstalls and starts the previous release", async () => {
    const { deps, calls, order, install } = rollbackFixture();
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: true, restoredAt: "2026-11-19T20:01:00.000Z" });
    expect(order).toEqual(["lock", "restore", "unlock"]);
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "pm2 delete 6",
      "pm2 delete 5",
      "bun install -g --force ravi.bot@3.1.0",
      `/usr/local/bin/bun ${install.target.bundlePath} daemon start`,
      `/usr/local/bin/bun ${install.target.bundlePath} channels start`,
      "pm2 save --force",
    ]);
    // The previous CLI picks its own bundle and runs outside any runtime context.
    expect(calls[3]!.env).toEqual({ PATH: "/bin" });
  });

  it("brings the release back on its untouched state without a snapshot, once the stopped processes exited", async () => {
    const { deps, calls, order, install } = rollbackFixture({ untouched: true });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: true, restoredAt: null, candidateDir: null });
    // Nothing to restore: no store lock, no restore.
    expect(order).toEqual([]);
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "bun install -g --force ravi.bot@3.1.0",
      `/usr/local/bin/bun ${install.target.bundlePath} daemon start`,
      `/usr/local/bin/bun ${install.target.bundlePath} channels start`,
      "pm2 save --force",
    ]);

    // A stopped process that never exits: nothing starts beside it.
    const stuck = rollbackFixture({ untouched: true, stuckPid: true });
    const refused = await rollBackUpdate(stuck.deps);
    expect(refused).toMatchObject({ ok: false, step: "stop", restoredAt: null });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("The state is untouched");
    expect(refused.commands).toEqual([
      "bun install -g ravi.bot@3.1.0",
      "ravi daemon start",
      "ravi channels start",
      "ravi daemon status",
    ]);
    expect(stuck.calls).toEqual([]);
  });

  it("leaves the restored state and the exact commands when the previous release cannot be installed", async () => {
    const { deps, calls } = rollbackFixture({ failInstall: true });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: false, step: "reinstall", restoredAt: "2026-11-19T20:01:00.000Z" });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.commands).toEqual([
      "bun install -g ravi.bot@3.1.0",
      "ravi daemon start",
      "ravi channels start",
      "ravi daemon status",
    ]);
    expect(calls.some((call) => call.args.includes("start"))).toBe(false);
  });

  it("restores nothing while a stopped process is still alive, and gives the exact restore by hand", async () => {
    const { deps, order } = rollbackFixture({ stuckPid: true });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: false, step: "stop", restoredAt: null });
    expect(order).toEqual([]);
    if (outcome.ok) throw new Error("unreachable");
    const live = join(deps.stateDir, "ravi.db");
    const snapshotDir = join(updateSnapshotsDir(deps.stateDir), deps.manifest!.id);
    // The target's WAL and shared memory go aside with the database, before the snapshot file comes back.
    const aside = outcome.commands.findIndex((command) => command.includes(`'${live}-wal'`));
    const back = outcome.commands.indexOf(`mv -n '${join(snapshotDir, "files", "0-ravi.db")}' '${live}'`);
    expect(outcome.commands.slice(0, 2)).toEqual(["pm2 delete ravi-channels", "pm2 delete ravi"]);
    expect(outcome.commands[aside]).toBe(
      `if [ -e '${live}-wal' ]; then mkdir -p '${join(snapshotDir, "candidate")}' && mv -n '${live}-wal' '${join(snapshotDir, "candidate", "0-ravi.db-wal")}'; fi`,
    );
    expect(outcome.commands.some((command) => command.includes(`'${live}-shm'`))).toBe(true);
    expect(back).toBeGreaterThan(aside);
    expect(outcome.commands.slice(-4)).toEqual([
      "bun install -g ravi.bot@3.1.0",
      "ravi daemon start",
      "ravi channels start",
      "ravi daemon status",
    ]);
  });

  it("does not count a restored daemon that never reaches ready, even with its boot receipt", async () => {
    const { deps, calls } = rollbackFixture({ phase: "waiting", previousRelease: "3.261115.1" });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: false, step: "start", restoredAt: "2026-11-19T20:01:00.000Z" });
    expect(calls.some((call) => call.args.includes("channels"))).toBe(false);
    expect(calls.some((call) => call.args[0] === "save")).toBe(false);
  });

  it("draws the schema phase line at 3.261109.1, compared as versions", async () => {
    // At the line the phase is required; just below it, and a later patch of an older day, it is not.
    expect(await rollBackUpdate(rollbackFixture({ phase: null, previousRelease: "3.261109.1" }).deps)).toMatchObject({
      ok: false,
      step: "start",
    });
    for (const previousRelease of ["3.261107.7", "3.261104.10"])
      expect(await rollBackUpdate(rollbackFixture({ phase: null, previousRelease }).deps)).toMatchObject({ ok: true });
  });

  it("proves a release older than the schema phase records by its receipt and the window", async () => {
    // 3.1.0 writes no schema phase: an absent phase does not hold the rollback, a restart in the window still would.
    const { deps } = rollbackFixture({ phase: null });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: true, restoredAt: "2026-11-19T20:01:00.000Z" });
  });

  it("fails the rollback when the restored daemon restarts inside the stability window", async () => {
    const { deps } = rollbackFixture({ restartAfterSave: true });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: false, step: "verify", restoredAt: "2026-11-19T20:01:00.000Z" });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("did not stay up for the stability window");
  });

  it("turns an error thrown inside a step into a failure of that step, with its commands", async () => {
    const { deps } = rollbackFixture({ throwAfterRestore: true });
    const outcome = await rollBackUpdate(deps);

    expect(outcome).toMatchObject({ ok: false, step: "start", restoredAt: "2026-11-19T20:01:00.000Z" });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("Unable to read the managed PM2 processes");
    expect(outcome.message).toContain("The state is restored");
    expect(outcome.commands).toEqual(["ravi daemon start", "ravi channels start", "ravi daemon status"]);
  });

  it("hands over the commands that finish a restore that stopped, then the previous release", async () => {
    const { deps } = rollbackFixture();
    const pending = { from: "/state/human-bridge/bridge.db", to: "/snap/candidate/6-bridge.db", done: false };
    const outcome = await rollBackUpdate({
      ...deps,
      restore: () => {
        throw new UpdateSnapshotRestoreError("rename failed", [
          { from: "/state/ravi.db", to: "/snap/candidate/0-ravi.db", done: true },
          pending,
        ]);
      },
    });

    expect(outcome).toMatchObject({ ok: false, step: "restore", restoredAt: null });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.commands).toEqual([
      `mkdir -p '/snap/candidate' && mv -n '${pending.from}' '${pending.to}'`,
      "bun install -g ravi.bot@3.1.0",
      "ravi daemon start",
      "ravi channels start",
      "ravi daemon status",
    ]);
  });
});

describe("update supervisor with a rollback plan", () => {
  function supervisorFixture(input: { targetNeverReady: boolean; channelsStopped?: boolean }) {
    const stateDir = tempDir("ravi-rollback-state-");
    // Convergence reads boot receipts from the process state directory.
    process.env.RAVI_STATE_DIR = stateDir;
    const install = globalInstall("3.2.0");
    const bundle = install.target.bundlePath;
    const epoch = Math.ceil(statSync(bundle).mtimeMs) + 1;
    const ravi = join(stateDir, "ravi.db");
    const database = new Database(ravi, { create: true });
    database.run("CREATE TABLE t (v TEXT)");
    database.run("INSERT INTO t (v) VALUES ('previous')");
    database.close();
    let processes: Pm2Process[] = [
      pm2Process("ravi", bundle, install.root, { pm_id: 1, pid: 10, startedAt: epoch }),
      pm2Process(
        "ravi-channels",
        bundle,
        install.root,
        input.channelsStopped ? { pm_id: 2, pid: 0, status: "stopped" } : { pm_id: 2, pid: 20, startedAt: epoch },
      ),
    ];
    const events: string[] = [];
    let time = 0;
    let nextPmId = 3;
    const rolledBack: (UpdateSnapshotManifest | null)[] = [];
    const rolledBackPids: (number[] | undefined)[] = [];
    const run = async (_command: string, args: string[]) => {
      if (args[0] === "delete") {
        const current = processes.find((process) => String(process.pm_id) === args[1]);
        events.push(`delete:${current?.name}`);
        processes = processes.filter((process) => String(process.pm_id) !== args[1]);
      } else if (args[0] === "start") {
        const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
        events.push(`start:${name}`);
        const pmId = nextPmId++;
        const process = pm2Process(name, bundle, install.root, {
          pm_id: pmId,
          pid: 100 + pmId,
          startedAt: epoch + 10 + time,
          createdAt: epoch + 10 + time,
        });
        processes.push(process);
        boot(stateDir, process, bundle, "3.2.0");
      } else if (args[0] === "save") events.push("save");
      return { success: true, output: "" };
    };
    const rebind = (overrides: Parameters<typeof rebindManagedRuntimeProcesses>[2] = {}) =>
      rebindManagedRuntimeProcesses(
        [
          { name: "ravi", status: "online", pid: 10, createdAt: 1 },
          input.channelsStopped
            ? { name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 }
            : { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
        ],
        install.target,
        {
          stateDir,
          assertPrepared: () => "ready" as const,
          runnerEnv: () => ({}),
          getProcesses: () => processes,
          pidAlive: (pid) => processes.some((process) => process.pid === pid),
          now: () => time,
          wait: async (ms) => {
            time += ms;
          },
          readyTimeoutMs: 1_000,
          stabilityWindowMs: 0,
          // The predecessor would coordinate if this update could not roll back.
          schemaPhase: (process) => (process.pid === 10 ? "ready" : input.targetNeverReady ? null : "ready"),
          rollbackPlan: () => ({
            previousRelease: "3.1.0",
            method: "bun",
            packageRoot: install.root,
            channelsOnline: true,
          }),
          storePaths: () => [ravi],
          planSnapshot: (plan) => planUpdateSnapshot({ ...plan, reflink: () => false, free: () => 1e12 }),
          rollBack: async (dependencies) => {
            rolledBack.push(dependencies.manifest);
            rolledBackPids.push(dependencies.stoppedPids);
            return {
              ok: true,
              target: install.target,
              restoredAt: "2026-11-19T20:01:00.000Z",
              candidateDir: join(stateDir, "candidate"),
            };
          },
          run,
          ...overrides,
        },
      );
    /** Both processes running `version`, as the waypoint's own CLI leaves them. */
    const bringUp = (version: string, names: Array<"ravi" | "ravi-channels"> = ["ravi", "ravi-channels"]) => {
      for (const name of names) {
        const pmId = nextPmId++;
        const process = pm2Process(name, bundle, install.root, {
          pm_id: pmId,
          pid: 100 + pmId,
          startedAt: epoch + 10 + time,
          createdAt: epoch + 10 + time,
        });
        processes.push(process);
        boot(stateDir, process, bundle, version);
      }
    };
    return { stateDir, events, rolledBack, rolledBackPids, rebind, run, bringUp, processes: () => processes };
  }

  it("stops both before the target starts, snapshots, and rolls back when the target never gets ready", async () => {
    const fixture = supervisorFixture({ targetNeverReady: true });
    const since = Date.now() - 1_000;

    expect(await fixture.rebind()).toBe(false);
    expect(fixture.events.slice(0, 3)).toEqual(["delete:ravi-channels", "delete:ravi", "start:ravi"]);
    expect(fixture.rolledBack).toHaveLength(1);
    const manifest = fixture.rolledBack[0]!;
    expect(manifest.files.map((file) => file.name)).toEqual(["0-ravi.db"]);
    expect(existsSync(join(updateSnapshotsDir(fixture.stateDir), manifest.id, "manifest.json"))).toBe(true);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({
      outcome: "rolled-back",
      previousRelease: "3.1.0",
      targetRelease: "3.2.0",
      snapshotId: manifest.id,
      candidateDir: join(fixture.stateDir, "candidate"),
    });
    expect(result?.message).toContain("Ravi 3.1.0 runs again on its state as of");
  });

  it("records a rollback that throws as rollback-failed, with where to look", async () => {
    const fixture = supervisorFixture({ targetNeverReady: true });
    const since = Date.now() - 1_000;

    expect(
      await fixture.rebind({
        rollBack: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe(false);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "rollback-failed", previousRelease: "3.1.0" });
    expect(result?.message).toContain("the rollback threw (boom)");
    expect(result?.commands.at(-1)).toContain("restore.json");
  });

  it("records a converged update and keeps its snapshot", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;

    expect(await fixture.rebind()).toBe(true);
    expect(fixture.rolledBack).toHaveLength(0);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "converged", previousRelease: "3.1.0" });
    expect(existsSync(join(updateSnapshotsDir(fixture.stateDir), result!.snapshotId!, "files", "0-ravi.db"))).toBe(
      true,
    );
  });

  it("takes the waypoint by itself, then updates from it to the target", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;
    let prepared: string | null = null;
    let readiness: "ready" | "adopt-on-start" = "adopt-on-start";
    const hops: string[] = [];
    const kept: (string | null | undefined)[] = [];
    let firstSnapshot: string | undefined;

    expect(
      await fixture.rebind({
        assertPrepared: () => readiness,
        preparedStateRelease: () => prepared,
        planSnapshot: (plan) => {
          kept.push(plan.keep);
          return planUpdateSnapshot({ ...plan, reflink: () => false, free: () => 1e12 });
        },
        hopThroughWaypoint: async (dependencies) => {
          hops.push(dependencies.waypoint);
          // Only the snapshot taken before the waypoint exists yet (ids in one second sort by their random suffix).
          firstSnapshot = readdirSync(updateSnapshotsDir(fixture.stateDir))[0];
          prepared = dependencies.waypoint;
          fixture.bringUp(dependencies.waypoint);
          // The fence adoption belongs to the target's daemon; the update's own flow is what this test follows.
          readiness = "ready";
          return { ok: true };
        },
      }),
    ).toBe(true);
    expect(hops).toEqual(["3.261113.2"]);
    // The release that wrote the state stops first; then the waypoint's processes, before the target starts.
    expect(fixture.events.slice(0, 4)).toEqual([
      "delete:ravi-channels",
      "delete:ravi",
      "delete:ravi-channels",
      "delete:ravi",
    ]);
    expect(fixture.events).toContain("start:ravi");
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "converged" });
    // The snapshot taken before the waypoint survives the one taken before the target, whose space check does not
    // count it as room.
    const snapshots = readdirSync(updateSnapshotsDir(fixture.stateDir));
    expect(snapshots).toHaveLength(2);
    expect(firstSnapshot).toBeDefined();
    expect(snapshots).toContain(firstSnapshot!);
    expect(kept).toEqual([null, firstSnapshot]);
    expect(result?.message).toContain("So is the one taken before the waypoint, of Ravi 3.1.0's state");
  });

  it("does not take a second waypoint when the first left the state unprepared", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;
    const hops: string[] = [];

    expect(
      await fixture.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => null,
        hopThroughWaypoint: async (dependencies) => {
          hops.push(dependencies.waypoint);
          fixture.bringUp(dependencies.waypoint);
          return { ok: true };
        },
      }),
    ).toBe(false);
    expect(hops).toHaveLength(1);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result?.message).toContain(UPDATE_WAYPOINT_REQUIRED);
  });

  it("rolls back to the release that wrote the state when the waypoint fails", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;

    expect(
      await fixture.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => null,
        hopThroughWaypoint: async () => ({ ok: false, step: "start", message: "ravi did not come up" }),
      }),
    ).toBe(false);
    expect(fixture.rolledBack).toHaveLength(1);
    expect(fixture.events).not.toContain("start:ravi");
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "rolled-back", previousRelease: "3.1.0" });
    expect(result?.message).toContain("the waypoint Ravi 3.261113.2 failed at start: ravi did not come up");
  });

  it("does not take the waypoint without a snapshot, and brings the release that wrote the state back", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;

    expect(
      await fixture.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => null,
        takeSnapshot: () => {
          throw new Error("copy failed");
        },
        hopThroughWaypoint: async () => {
          throw new Error("the waypoint must not run without a snapshot");
        },
      }),
    ).toBe(false);
    // Not left stopped: the release that wrote the state comes back on it, with nothing to restore, and only once
    // the processes it stopped (pids 10 and 20) have exited.
    expect(fixture.rolledBack).toEqual([null]);
    expect(fixture.rolledBackPids).toEqual([[10, 20]]);
    expect(fixture.events).toEqual(["delete:ravi-channels", "delete:ravi"]);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "rolled-back", previousRelease: "3.1.0", snapshotId: null });
    expect(result?.message).toContain("so neither the waypoint nor Ravi 3.2.0 was started");
    expect(result?.message).toContain("Ravi 3.1.0 runs again on its untouched state");
    expect(result?.warnings).toEqual(["the snapshot failed (copy failed)"]);
  });

  it("rolls back when the waypoint throws, and records a second pass that stops before it began", async () => {
    const thrown = supervisorFixture({ targetNeverReady: false });
    expect(
      await thrown.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => null,
        hopThroughWaypoint: async () => {
          throw new Error("Unable to read the managed PM2 processes");
        },
      }),
    ).toBe(false);
    expect(thrown.rolledBack).toHaveLength(1);

    const second = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;
    let plans = 0;
    let prepared: string | null = null;
    expect(
      await second.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => prepared,
        planSnapshot: (plan) => {
          plans += 1;
          if (plans > 1) throw new Error("no room for the second snapshot");
          return planUpdateSnapshot({ ...plan, reflink: () => false, free: () => 1e12 });
        },
        hopThroughWaypoint: async (dependencies) => {
          prepared = dependencies.waypoint;
          second.bringUp(dependencies.waypoint);
          return { ok: true };
        },
      }),
    ).toBe(false);
    const result = readUpdateSupervisorResult(since, second.stateDir);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result?.message).toContain("stopped before it began (no room for the second snapshot)");
  });

  it("keeps a runner that was stopped stopped: the waypoint's runner goes before the update to the target", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false, channelsStopped: true });
    const since = Date.now() - 1_000;
    let prepared: string | null = null;
    let readiness: "ready" | "adopt-on-start" = "adopt-on-start";

    expect(
      await fixture.rebind({
        assertPrepared: () => readiness,
        preparedStateRelease: () => prepared,
        hopThroughWaypoint: async (dependencies) => {
          prepared = dependencies.waypoint;
          fixture.bringUp(dependencies.waypoint);
          readiness = "ready";
          return { ok: true };
        },
      }),
    ).toBe(true);
    expect(fixture.processes().some((process) => process.name === "ravi-channels")).toBe(false);
    expect(fixture.events.filter((event) => event === "start:ravi-channels")).toEqual([]);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "converged" });
    // The runner ran meanwhile, and the result says so.
    expect(result?.warnings).toEqual([
      "the channel runner was stopped; the waypoint Ravi 3.261113.2 ran it for its boot record, and while it ran " +
        "it could process queued inbound and outbound messages",
    ]);
  });

  it("records a second pass that returns before it could roll back", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;
    let prepared: string | null = null;
    let readiness: "ready" | "adopt-on-start" = "adopt-on-start";

    expect(
      await fixture.rebind({
        assertPrepared: () => readiness,
        preparedStateRelease: () => prepared,
        hopThroughWaypoint: async (dependencies) => {
          prepared = dependencies.waypoint;
          // Only the runner is up when the update to the target reads PM2: that pass returns at once.
          fixture.bringUp(dependencies.waypoint, ["ravi-channels"]);
          readiness = "ready";
          return { ok: true };
        },
      }),
    ).toBe(false);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result?.message).toContain("stopped before it began");
  });

  it("leaves the waypoint running and says so when the target cannot be installed again", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const since = Date.now() - 1_000;

    expect(
      await fixture.rebind({
        assertPrepared: () => "adopt-on-start",
        preparedStateRelease: () => null,
        hopThroughWaypoint: async () => ({ ok: false, step: "reinstall-target", message: "registry unreachable" }),
      }),
    ).toBe(false);
    expect(fixture.rolledBack).toHaveLength(0);
    const result = readUpdateSupervisorResult(since, fixture.stateDir);
    expect(result).toMatchObject({ outcome: "failed" });
    // The install may hold anything after a failed install: the commands begin by installing the target.
    expect(result?.message).toContain("could not be installed again (registry unreachable)");
    expect(result?.commands).toEqual([
      "bun install -g ravi.bot@3.2.0",
      "ravi daemon status",
      "ravi update --version 3.2.0",
    ]);
  });

  it("refuses the waypoint before any stop without a rollback, or as a downgrade", async () => {
    for (const plan of [null, { previousRelease: "3.261115.1" }]) {
      const fixture = supervisorFixture({ targetNeverReady: false });
      const mutations: string[][] = [];
      await expect(
        fixture.rebind({
          assertPrepared: () => "adopt-on-start",
          preparedStateRelease: () => null,
          rollbackPlan: () =>
            plan && {
              previousRelease: plan.previousRelease,
              method: "bun" as const,
              packageRoot: "/unused",
              channelsOnline: true,
            },
          hopThroughWaypoint: async () => {
            throw new Error("the waypoint must not run");
          },
          run: async (command, args) => {
            mutations.push(args);
            return fixture.run(command, args);
          },
        }),
      ).rejects.toThrow(UPDATE_WAYPOINT_REQUIRED);
      expect(mutations).toEqual([]);
    }
  });

  it("refuses before any stop when the snapshot does not fit", async () => {
    const fixture = supervisorFixture({ targetNeverReady: false });
    const mutations: string[][] = [];

    await expect(
      fixture.rebind({
        planSnapshot: (plan) => planUpdateSnapshot({ ...plan, reflink: () => false, free: () => 1 }),
        run: async (command, args) => {
          mutations.push(args);
          return fixture.run(command, args);
        },
      }),
    ).rejects.toThrow(UPDATE_SNAPSHOT_SPACE);
    expect(mutations).toEqual([]);
    expect(readFileSync(join(fixture.stateDir, "ravi.db")).length).toBeGreaterThan(0);
  });
});

describe("the waypoint rule", () => {
  it("asks for 3.261113.2 only for a pre-fence state prepared by an older release or none", () => {
    expect(requiredFenceAdoptionWaypoint({ readiness: "ready", preparedRelease: null })).toBeNull();
    expect(requiredFenceAdoptionWaypoint({ readiness: "adopt-on-start", preparedRelease: null })).toBe("3.261113.2");
    expect(requiredFenceAdoptionWaypoint({ readiness: "adopt-on-start", preparedRelease: "3.261104.2" })).toBe(
      "3.261113.2",
    );
    expect(requiredFenceAdoptionWaypoint({ readiness: "adopt-on-start", preparedRelease: "3.261113.2" })).toBeNull();
  });
});

function waypointFixture(
  input: {
    failInstall?: "waypoint" | "target";
    neverUp?: boolean;
    neverPrepared?: boolean;
    phase?: "waiting" | "owned" | "ready" | null;
    unreadableAfterInstall?: boolean;
  } = {},
) {
  const stateDir = tempDir("ravi-waypoint-state-");
  // The CLI installed the target; both processes of the release that wrote the state are stopped.
  const install = globalInstall("3.2.0");
  const bundle = install.target.bundlePath;
  const epoch = Math.ceil(statSync(bundle).mtimeMs) + 1;
  const processes: Pm2Process[] = [];
  let installed = "3.2.0";
  let prepared: string | null = null;
  let nextPid = 500;
  const calls: string[] = [];
  const installCwds: Array<string | undefined> = [];
  let installedOnce = false;
  const deps: WaypointHopDependencies = {
    stateDir,
    waypoint: "3.261113.2",
    target: install.target,
    method: "bun",
    packageRoot: install.root,
    bunPath: "/usr/local/bin/bun",
    env: { PATH: "/bin", RAVI_CONTEXT_KEY: "ctx" },
    getProcesses: () => {
      if (input.unreadableAfterInstall && installedOnce) throw new Error("Unable to read the managed PM2 processes");
      return processes;
    },
    now: (() => {
      let time = 0;
      return () => (time += 100);
    })(),
    wait: async () => {},
    log: () => {},
    preparedRelease: () => prepared,
    schemaPhase: () => (input.phase === undefined ? "ready" : input.phase),
    startTimeoutMs: 2_000,
    prepareTimeoutMs: 2_000,
    stabilityWindowMs: 1_000,
    run: async (command, args, options) => {
      calls.push([command, ...args].join(" "));
      if (options?.env?.RAVI_CONTEXT_KEY) throw new Error("a runtime context reached the waypoint's CLI");
      if (command === "bun" && args[0] === "install") {
        installCwds.push(options?.cwd);
        installedOnce = true;
        const release = args.at(-1)!.split("@")[1]!;
        if (input.failInstall === "waypoint" && release === "3.261113.2")
          return { success: false, output: "registry unreachable" };
        if (input.failInstall === "target" && release === "3.2.0")
          return { success: false, output: "registry unreachable" };
        install.setVersion(release);
        installed = release;
      } else if (args[2] === "start" && !input.neverUp) {
        const name = args[1] === "daemon" ? "ravi" : "ravi-channels";
        const process = pm2Process(name, bundle, install.root, {
          pm_id: nextPid,
          pid: nextPid,
          startedAt: epoch + nextPid,
        });
        nextPid += 1;
        processes.push(process);
        boot(stateDir, process, bundle, installed);
        // The waypoint's daemon writes its readiness markers when it prepares the state.
        if (name === "ravi" && !input.neverPrepared) prepared = "3.261113.2";
      }
      return { success: true, output: "" };
    },
  };
  return { deps, calls, install, bundle, installCwds };
}

describe("update waypoint", () => {
  it("installs the waypoint, starts both processes through its CLI, waits for the prepared state, reinstalls the target", async () => {
    const { deps, calls, install, bundle } = waypointFixture();
    const outcome = await hopThroughWaypoint(deps);

    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual([
      "bun install -g --force ravi.bot@3.261113.2",
      `/usr/local/bin/bun ${bundle} daemon start`,
      `/usr/local/bin/bun ${bundle} channels start`,
      "bun install -g --force ravi.bot@3.2.0",
    ]);
    expect(resolveManagedRuntimeTargetFromPackageRoot(install.root)?.version).toBe("3.2.0");
  });

  it("waits for the waypoint's daemon to be ready before the runner, and installs outside the package", async () => {
    const waiting = waypointFixture({ phase: "waiting" });
    expect(await hopThroughWaypoint(waiting.deps)).toMatchObject({ ok: false, step: "start" });
    expect(waiting.calls.some((call) => call.endsWith("channels start"))).toBe(false);

    const { deps, installCwds } = waypointFixture();
    expect(await hopThroughWaypoint(deps)).toEqual({ ok: true });
    expect(installCwds).toEqual([homedir(), homedir()]);
  });

  it("turns an error inside a step into a failure of that step", async () => {
    const outcome = await hopThroughWaypoint(waypointFixture({ unreadableAfterInstall: true }).deps);
    expect(outcome).toMatchObject({ ok: false, step: "start" });
    expect(outcome.ok ? "" : outcome.message).toContain("Unable to read the managed PM2 processes");
  });

  it("stops at the step that failed", async () => {
    expect(await hopThroughWaypoint(waypointFixture({ failInstall: "waypoint" }).deps)).toMatchObject({
      ok: false,
      step: "install",
    });
    expect(await hopThroughWaypoint(waypointFixture({ neverUp: true }).deps)).toMatchObject({
      ok: false,
      step: "start",
    });
    const unprepared = await hopThroughWaypoint(waypointFixture({ neverPrepared: true }).deps);
    expect(unprepared).toMatchObject({ ok: false, step: "prepare" });
    expect(unprepared.ok ? "" : unprepared.message).toContain("readiness markers of Ravi 3.261113.2");
    expect(await hopThroughWaypoint(waypointFixture({ failInstall: "target" }).deps)).toMatchObject({
      ok: false,
      step: "reinstall-target",
    });
  });

  it("counts the state prepared only with the markers and a boot record of both processes from the waypoint", () => {
    const stateDir = tempDir("ravi-waypoint-prepared-");
    expect(waypointPreparedState(stateDir, "3.261113.2", "3.261113.2")).toMatchObject({ prepared: false });
    const install = globalInstall("3.261113.2");
    const epoch = Math.ceil(statSync(install.target.bundlePath).mtimeMs) + 1;
    for (const name of ["ravi", "ravi-channels"] as const)
      boot(
        stateDir,
        pm2Process(name, install.target.bundlePath, install.root, { startedAt: epoch }),
        install.target.bundlePath,
        "3.261113.2",
      );
    expect(waypointPreparedState(stateDir, "3.261113.2", "3.261113.2")).toEqual({ prepared: true, missing: [] });
    expect(waypointPreparedState(stateDir, "3.261113.2", "3.261104.2").prepared).toBe(false);
  });
});

/** A host on 3.2.0 after an update from 3.1.0 that kept its snapshot. */
function operatorRollbackFixture(input: { running?: string; restored?: boolean; noSnapshot?: boolean } = {}) {
  const stateDir = tempDir("ravi-operator-rollback-");
  const install = globalInstall("3.2.0");
  const bundle = install.target.bundlePath;
  const epoch = Math.ceil(statSync(bundle).mtimeMs) + 1;
  const ravi = join(stateDir, "ravi.db");
  const database = new Database(ravi, { create: true });
  database.run("CREATE TABLE t (v TEXT)");
  database.close();
  const manifest = input.noSnapshot
    ? null
    : takeUpdateSnapshot({
        stateDir,
        stores: [ravi],
        method: "copy",
        previousRelease: "3.1.0",
        targetRelease: "3.2.0",
      });
  if (manifest && input.restored)
    writeFileSync(join(updateSnapshotsDir(stateDir), manifest.id, "restore.json"), '{"phase":"restored"}\n');
  const processes = [
    pm2Process("ravi", bundle, install.root, { pm_id: 1, pid: 10, startedAt: epoch }),
    pm2Process("ravi-channels", bundle, install.root, { pm_id: 2, pid: 20, startedAt: epoch }),
  ];
  for (const process of processes) boot(stateDir, process, bundle, input.running ?? "3.2.0");
  return { stateDir, install, processes, manifest };
}

describe("ravi update --rollback", () => {
  it("plans the way back to the release before the last update, from its target", () => {
    const { stateDir, install, processes, manifest } = operatorRollbackFixture();
    const planned = planOperatorRollback({ stateDir, processes });

    expect(planned.manifest.id).toBe(manifest!.id);
    expect(planned.runningRelease).toBe("3.2.0");
    expect(planned.plan).toEqual({
      previousRelease: "3.1.0",
      method: "bun",
      packageRoot: install.root,
      channelsOnline: true,
    });
    expect(planned.previousProcesses.map((process) => process.name)).toEqual(["ravi", "ravi-channels"]);
  });

  it("refuses with nothing stopped when it cannot go back from here", () => {
    const none = operatorRollbackFixture({ noSnapshot: true });
    expect(() => planOperatorRollback({ stateDir: none.stateDir, processes: none.processes })).toThrow(
      "there is no update snapshot",
    );
    const used = operatorRollbackFixture({ restored: true });
    expect(() => planOperatorRollback({ stateDir: used.stateDir, processes: used.processes })).toThrow(
      "was already restored",
    );
    const other = operatorRollbackFixture({ running: "3.3.0" });
    expect(() => planOperatorRollback({ stateDir: other.stateDir, processes: other.processes })).toThrow(
      "the daemon runs Ravi 3.3.0",
    );
    expect(() => planOperatorRollback({ stateDir: other.stateDir, processes: other.processes })).toThrow(
      UPDATE_ROLLBACK_UNAVAILABLE,
    );
  });

  it("refuses with the commands to finish by hand when nothing runs next to an unused snapshot", () => {
    const { stateDir, manifest } = operatorRollbackFixture();
    let message = "";
    try {
      planOperatorRollback({ stateDir, processes: [], installMethod: "bun" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(UPDATE_ROLLBACK_UNAVAILABLE);
    expect(message).toContain(`the snapshot of ${manifest!.createdAt}`);
    expect(message).toContain("was not restored: a rollback may have stopped both processes and been cut");
    expect(message).toContain(join(updateSnapshotsDir(stateDir), manifest!.id, "files"));
    // One command per line (a line past 2048 characters would not reach the operator), also kept in a file.
    expect(message).toContain("bun install -g ravi.bot@3.1.0\nravi daemon start\nravi channels start");
    expect(message.split("\n").every((line) => line.length < 2048)).toBe(true);
    const kept = readFileSync(join(updateSnapshotsDir(stateDir), manifest!.id, "finish-by-hand.txt"), "utf8");
    expect(kept).toContain("bun install -g ravi.bot@3.1.0\nravi daemon start\n");
    expect(message).toContain("This run stopped nothing.");

    writeFileSync(join(updateSnapshotsDir(stateDir), manifest!.id, "restore.json"), '{"phase":"moving"}\n');
    expect(() => planOperatorRollback({ stateDir, processes: [] })).toThrow("restore.json lists every move");
  });

  it("rolls back in the supervisor only the snapshot the preview named, and records the outcome", async () => {
    const { stateDir, processes, manifest } = operatorRollbackFixture();
    const since = Date.now() - 1_000;
    const calls: UpdateRollbackDependencies[] = [];
    const supervise = (snapshotId: string, ok: boolean) =>
      superviseOperatorRollback({
        stateDir,
        snapshotId,
        getProcesses: () => processes,
        run: async () => ({ success: true, output: "" }),
        bunPath: "/usr/local/bin/bun",
        pidAlive: () => false,
        stabilityWindowMs: 7_000,
        rollBack: async (dependencies) => {
          calls.push(dependencies);
          return ok
            ? {
                ok: true,
                target: dependencies.manifest as never,
                restoredAt: "2026-11-20T03:00:00.000Z",
                candidateDir: join(stateDir, "candidate"),
              }
            : {
                ok: false,
                step: "reinstall",
                message: "registry unreachable",
                commands: ["bun install -g ravi.bot@3.1.0"],
                restoredAt: "2026-11-20T03:00:00.000Z",
                candidateDir: join(stateDir, "candidate"),
              };
        },
      });

    // Another snapshot than the one previewed: refused under the lock, before any stop.
    await expect(supervise("20261120T000000Z-abcdef", true)).rejects.toThrow(UPDATE_ROLLBACK_UNAVAILABLE);
    expect(calls).toHaveLength(0);

    expect(await supervise(manifest!.id, true)).toBe(true);
    expect(calls[0]).toMatchObject({ stateDir, stabilityWindowMs: 7_000, plan: { previousRelease: "3.1.0" } });
    expect(readUpdateSupervisorResult(since, stateDir)).toMatchObject({
      outcome: "rolled-back",
      targetRelease: "3.2.0",
      previousRelease: "3.1.0",
      snapshotId: manifest!.id,
      restoredAt: "2026-11-20T03:00:00.000Z",
    });

    // A result that cannot be written does not turn a rollback that ran into a failure.
    expect(
      await superviseOperatorRollback({
        stateDir,
        snapshotId: manifest!.id,
        getProcesses: () => processes,
        run: async () => ({ success: true, output: "" }),
        bunPath: "/usr/local/bin/bun",
        pidAlive: () => false,
        rollBack: async (dependencies) => ({
          ok: true,
          target: dependencies.manifest as never,
          restoredAt: "2026-11-20T03:00:00.000Z",
          candidateDir: join(stateDir, "candidate"),
        }),
        recordResult: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      }),
    ).toBe(true);

    expect(await supervise(manifest!.id, false)).toBe(false);
    expect(readUpdateSupervisorResult(since, stateDir)).toMatchObject({
      outcome: "rollback-failed",
      message: "ravi update --rollback stopped at reinstall: registry unreachable",
      commands: ["bun install -g ravi.bot@3.1.0"],
    });
  });

  it("answers UPDATE_IN_PROGRESS while a supervisor runs, not the commands for a cut rollback", async () => {
    const { stateDir } = operatorRollbackFixture();
    const env = { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir };
    // Both processes are out of PM2 while the supervisor restores and reinstalls.
    const rollbackRuntime = {
      getProcesses: () => [] as Pm2Process[],
      supervise: async (): Promise<ManagedRuntimeSupervisorOutcome> => {
        throw new Error("a second supervisor must not start");
      },
    };
    const holder = join(stateDir, "holder.ts");
    writeFileSync(
      holder,
      `import { acquireSchemaFileLock } from ${JSON.stringify(join(process.cwd(), "src/db/schema-lock.ts"))};\n` +
        `acquireSchemaFileLock(${JSON.stringify(join(stateDir, "updates", "update.lock"))}, 0);\n` +
        'console.log("held");\nsetInterval(() => {}, 1_000);\n',
    );
    const other = spawn(process.execPath, [holder], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => other.stdout!.once("data", () => resolve()));
      for (const execute of [false, true]) {
        const refusal = await runUpdate(
          { rollback: true, execute, json: true },
          { env, insideDaemonTree: () => false, rollbackRuntime },
        ).then(
          () => null,
          (error: Error & { code?: string }) => error,
        );
        expect(refusal?.code).toBe(UPDATE_IN_PROGRESS);
        expect(refusal?.message).toContain(join(stateDir, "updates", "supervisor-result.json"));
        expect(refusal?.message).toContain(join(stateDir, "updates", "supervisor.log"));
        expect(refusal?.message).not.toContain("not running under PM2");
      }
    } finally {
      other.kill("SIGKILL");
      await new Promise((resolve) => other.once("exit", resolve));
    }
    // With no supervisor left, an empty PM2 next to the unused snapshot is a cut rollback.
    const cut = await runUpdate(
      { rollback: true, json: true },
      { env, insideDaemonTree: () => false, rollbackRuntime },
    ).then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(cut?.code).toBe(UPDATE_ROLLBACK_UNAVAILABLE);
    expect(cut?.message).toContain("not running under PM2");
  });

  it("holds the update lock for the rollback: refused while another supervisor holds it, free after", async () => {
    const { stateDir, install, processes, manifest } = operatorRollbackFixture();
    process.env.RAVI_STATE_DIR = stateDir;
    const env = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
    const invocation = buildManagedRuntimeRebindSupervisorInvocation(
      install.target,
      processes,
      { PATH: "/usr/bin" },
      {
        rollback: { snapshotId: manifest!.id },
      },
    );
    expect(decodeManagedRuntimeRebindRequest(invocation.env[env]!).rollback).toEqual({ snapshotId: manifest!.id });
    const rolledBack: string[] = [];
    const overrides = {
      getProcesses: () => processes,
      rollBack: async (dependencies: UpdateRollbackDependencies) => {
        rolledBack.push(dependencies.manifest!.id);
        return {
          ok: true as const,
          target: install.target,
          restoredAt: "2026-11-20T03:00:00.000Z",
          candidateDir: join(stateDir, "candidate"),
        };
      },
    };
    // Another supervisor, in another process, holds the lock (the lock is per process).
    const holder = join(stateDir, "holder.ts");
    writeFileSync(
      holder,
      `import { acquireSchemaFileLock } from ${JSON.stringify(join(process.cwd(), "src/db/schema-lock.ts"))};\n` +
        `acquireSchemaFileLock(${JSON.stringify(join(stateDir, "updates", "update.lock"))}, 0);\n` +
        'console.log("held");\nsetInterval(() => {}, 1_000);\n',
    );
    try {
      const other = spawn(process.execPath, [holder], { stdio: ["ignore", "pipe", "inherit"] });
      try {
        await new Promise<void>((resolve) => other.stdout!.once("data", () => resolve()));
        process.env[env] = invocation.env[env];
        await expect(maybeRunManagedRuntimeRebindFromEnv(() => false, undefined, overrides)).rejects.toThrow(
          UPDATE_IN_PROGRESS,
        );
        expect(rolledBack).toEqual([]);
      } finally {
        other.kill("SIGKILL");
        await new Promise((resolve) => other.once("exit", resolve));
      }
      process.env[env] = invocation.env[env];
      expect(await maybeRunManagedRuntimeRebindFromEnv(() => false, undefined, overrides)).toBe(true);
      expect(rolledBack).toEqual([manifest!.id]);
      // Released at the end: the next supervisor gets it.
      acquireUpdateSupervisorLock(stateDir).release();
    } finally {
      delete process.env[env];
    }
  });

  it("hands the supervisor one absolute state directory, the environment and the previewed snapshot", async () => {
    const { stateDir, processes, manifest } = operatorRollbackFixture();
    const seen: Array<{ stateDir: string; envStateDir?: string; window?: string; snapshotId?: string }> = [];
    const supervise = async (
      _target: unknown,
      _processes: unknown,
      supervisorStateDir?: string,
      options?: { rollback?: { snapshotId: string }; env?: NodeJS.ProcessEnv },
    ): Promise<ManagedRuntimeSupervisorOutcome> => {
      seen.push({
        stateDir: supervisorStateDir!,
        envStateDir: options?.env?.RAVI_STATE_DIR,
        window: options?.env?.RAVI_UPDATE_STABILITY_WINDOW_MS,
        snapshotId: options?.rollback?.snapshotId,
      });
      return rolledBackOutcome(stateDir);
    };
    // The operator names the state directory relative to their cwd; the supervisor starts elsewhere.
    const relativeStateDir = relative(process.cwd(), stateDir);
    await runUpdate(
      { rollback: true, execute: true, json: true },
      {
        env: { PATH: "/usr/bin", RAVI_STATE_DIR: relativeStateDir, RAVI_UPDATE_STABILITY_WINDOW_MS: "120000" },
        insideDaemonTree: () => false,
        rollbackRuntime: { getProcesses: () => processes, supervise },
      },
    );
    expect(seen).toEqual([{ stateDir, envStateDir: stateDir, window: "120000", snapshotId: manifest!.id }]);
  });

  it("previews by default, rolls back with --execute, and runs only from a terminal", async () => {
    const { stateDir, processes } = operatorRollbackFixture();
    const env = { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir };
    let outcome = rolledBackOutcome(stateDir);
    let supervised = 0;
    const rollbackRuntime = {
      getProcesses: () => processes,
      supervise: async (): Promise<ManagedRuntimeSupervisorOutcome> => {
        supervised += 1;
        return outcome;
      },
    };

    await expect(
      runUpdate({ rollback: true, json: true }, { env, insideDaemonTree: () => false, rollbackRuntime }),
    ).rejects.toMatchObject({ code: "WRITE_REQUIRES_EXECUTE" });
    expect(supervised).toBe(0);

    expect(
      await runUpdate(
        { rollback: true, execute: true, json: true },
        { env, insideDaemonTree: () => false, rollbackRuntime },
      ),
    ).toMatchObject({
      success: true,
      mode: "rollback",
      from: "3.2.0",
      to: "3.1.0",
      restoredAt: "2026-11-20T03:00:00.000Z",
    });
    expect(supervised).toBe(1);

    // What the supervisor recorded is the result: a refusal under the lock, or a failed rollback with its commands.
    outcome = {
      converged: false,
      refusal: { code: UPDATE_IN_PROGRESS, message: "held" } as never,
      result: null,
      logPath: null,
    };
    await expect(
      runUpdate({ rollback: true, execute: true, json: true }, { env, insideDaemonTree: () => false, rollbackRuntime }),
    ).rejects.toMatchObject({ code: UPDATE_IN_PROGRESS });
    outcome = {
      converged: false,
      refusal: null,
      result: {
        ...rolledBackOutcome(stateDir).result!,
        outcome: "rollback-failed",
        message: "stopped at start",
        commands: ["ravi daemon start"],
      },
      logPath: null,
    };
    await expect(
      runUpdate({ rollback: true, execute: true, json: true }, { env, insideDaemonTree: () => false, rollbackRuntime }),
    ).rejects.toMatchObject({
      code: "UPDATE_ROLLBACK_FAILED",
      message: expect.stringContaining("\nravi daemon start"),
    });

    await expect(
      runUpdate({ rollback: true, execute: true, json: true }, { env, insideDaemonTree: () => true, rollbackRuntime }),
    ).rejects.toMatchObject({ code: UPDATE_ROLLBACK_UNAVAILABLE });
    await expect(
      runUpdate({ rollback: true, next: true, json: true }, { env, insideDaemonTree: () => false, rollbackRuntime }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(
      runUpdate({ execute: true, json: true }, { env, insideDaemonTree: () => false, rollbackRuntime }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    expect(supervised).toBe(3);
  });

  it("goes on when the terminal closes after the first stop: the rollback runs in the detached supervisor", async () => {
    const scene = tempDir("ravi-rollback-scene-");
    const stateDir = join(scene, "state");
    mkdirSync(stateDir);
    const install = globalInstall("3.2.0");
    const repo = process.cwd();
    const deleted = join(scene, "deleted");
    const go = join(scene, "go");
    const started = join(scene, "started");
    // Stands for the first `pm2 delete`, then waits until the terminal is gone.
    const fakeRollBack = `async () => {
      writeFileSync(${JSON.stringify(deleted)}, "");
      while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(50);
      writeFileSync(${JSON.stringify(started)}, "");
      return { ok: true, target: null, restoredAt: "2026-11-20T03:00:00.000Z", candidateDir: ${JSON.stringify(join(scene, "candidate"))} };
    }`;
    const processesFile = join(scene, "processes.json");
    // The installed bundle: the supervisor this command starts, with PM2 and the rollback faked.
    writeFileSync(
      install.target.bundlePath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { maybeRunManagedRuntimeRebindFromEnv } from ${JSON.stringify(join(repo, "src/managed-runtime-rebind.ts"))};
const processes = JSON.parse(readFileSync(${JSON.stringify(processesFile)}, "utf8"));
await maybeRunManagedRuntimeRebindFromEnv(() => false, undefined, { getProcesses: () => processes, rollBack: ${fakeRollBack} });
`,
    );
    const ravi = join(stateDir, "ravi.db");
    new Database(ravi, { create: true }).close();
    takeUpdateSnapshot({ stateDir, stores: [ravi], method: "copy", previousRelease: "3.1.0", targetRelease: "3.2.0" });
    const epoch = Math.ceil(statSync(install.target.bundlePath).mtimeMs) + 1;
    const processes = [
      pm2Process("ravi", install.target.bundlePath, install.root, { pm_id: 1, pid: 10, startedAt: epoch }),
      pm2Process("ravi-channels", install.target.bundlePath, install.root, { pm_id: 2, pid: 20, startedAt: epoch }),
    ];
    for (const process of processes) boot(stateDir, process, install.target.bundlePath, "3.2.0");
    writeFileSync(processesFile, JSON.stringify(processes));
    // The operator's command. A CLI that rolled back in its own process would run the same fake there.
    const cliScript = join(scene, "cli.ts");
    writeFileSync(
      cliScript,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runUpdate } from ${JSON.stringify(join(repo, "src/cli/commands/update.ts"))};
const processes = JSON.parse(readFileSync(${JSON.stringify(processesFile)}, "utf8"));
await runUpdate(
  { rollback: true, execute: true, json: true },
  {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RAVI_STATE_DIR: ${JSON.stringify(stateDir)}, RAVI_UPDATE_STABILITY_WINDOW_MS: "0" },
    insideDaemonTree: () => false,
    rollbackRuntime: { getProcesses: () => processes, rollBack: ${fakeRollBack} },
  },
);
`,
    );
    const since = Date.now() - 1_000;
    const until = async (check: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return true;
    };
    // Its own process group, as a terminal session's foreground job.
    const cli = spawn(process.execPath, [cliScript], { detached: true, stdio: "ignore", cwd: scene });
    try {
      expect(await until(() => existsSync(deleted), 20_000)).toBe(true);
      // The terminal closes: its process group gets SIGHUP.
      process.kill(-cli.pid!, "SIGHUP");
      expect(await until(() => cli.exitCode !== null || cli.signalCode !== null, 10_000)).toBe(true);
      writeFileSync(go, "");
      expect(await until(() => readUpdateSupervisorResult(since, stateDir)?.outcome === "rolled-back", 20_000)).toBe(
        true,
      );
      expect(existsSync(started)).toBe(true);
    } finally {
      writeFileSync(go, "");
      try {
        process.kill(-cli.pid!, "SIGKILL");
      } catch {
        // no-cause: The command already ended.
      }
    }
  }, 60_000);
});

function rolledBackOutcome(stateDir: string): ManagedRuntimeSupervisorOutcome {
  return {
    converged: true,
    refusal: null,
    result: {
      protocol: "ravi.update-supervisor-result/v1",
      pid: 1,
      at: new Date().toISOString(),
      outcome: "rolled-back",
      targetRelease: "3.2.0",
      previousRelease: "3.1.0",
      snapshotId: null,
      snapshotAt: null,
      restoredAt: "2026-11-20T03:00:00.000Z",
      candidateDir: join(stateDir, "candidate"),
      message: "Ravi 3.1.0 runs again on its state.",
      commands: [],
      warnings: [],
    },
    logPath: null,
  };
}

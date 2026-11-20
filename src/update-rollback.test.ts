import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebindManagedRuntimeProcesses } from "./managed-runtime-rebind.js";
import { resolveManagedRuntimeTargetFromPackageRoot } from "./managed-runtime.js";
import type { Pm2Process } from "./pm2.js";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from "./runtime-process-identity.js";
import {
  globalInstallMethodOf,
  previousReleaseCliEnv,
  readUpdateSupervisorResult,
  resolveUpdateRollbackPlan,
  rollBackUpdate,
  type UpdateRollbackDependencies,
  type UpdateRollbackPlan,
} from "./update-rollback.js";
import {
  planUpdateSnapshot,
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
  } = {},
) {
  const previousRelease = input.previousRelease ?? "3.1.0";
  const stateDir = tempDir("ravi-rollback-state-");
  const install = globalInstall("3.2.0");
  const bundle = install.target.bundlePath;
  const epoch = Math.ceil(statSync(bundle).mtimeMs) + 1;
  let processes: Pm2Process[] = [
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
    manifest,
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
    const snapshotDir = join(updateSnapshotsDir(deps.stateDir), deps.manifest.id);
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
  function supervisorFixture(input: { targetNeverReady: boolean }) {
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
      pm2Process("ravi-channels", bundle, install.root, { pm_id: 2, pid: 20, startedAt: epoch }),
    ];
    const events: string[] = [];
    let time = 0;
    let nextPmId = 3;
    const rolledBack: UpdateSnapshotManifest[] = [];
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
          { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
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
    return { stateDir, events, rolledBack, rebind, run };
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

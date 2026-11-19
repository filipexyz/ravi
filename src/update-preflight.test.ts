import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorRefusalCode } from "./cli/commands/update.js";
import { resolveManagedRuntimeTargetFromPackageRoot } from "./managed-runtime.js";
import {
  boundedStabilityWindowMs,
  buildManagedRuntimeRebindSupervisorInvocation,
  MANAGED_RUNTIME_REBIND_TIMEOUT_MS,
  MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV,
  maybeRunManagedRuntimeRebindFromEnv,
  observeStableManagedRuntime,
  readSupervisorRefusal,
  rebindManagedRuntimeProcesses,
  recordSupervisorRefusal,
  SUPERVISOR_EXIT_MARGIN_MS,
  type SupervisorStabilityPlan,
  supervisorStabilityPlan,
} from "./managed-runtime-rebind.js";
import type { Pm2Process } from "./pm2.js";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from "./runtime-process-identity.js";
import {
  assertFenceAdoptionWaypoint,
  compareRaviVersions,
  FENCE_ADOPTION_MINIMUM_RELEASE,
  readPreparedStateRelease,
  UPDATE_WAYPOINT_REQUIRED,
  UpdateWaypointRequiredError,
} from "./update-preflight.js";

const REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";

function writeStateDb(stateDir: string, markers: string[] | null): void {
  const db = new Database(join(stateDir, "ravi.db"));
  try {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    if (markers) {
      db.exec("CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL)");
      const insert = db.query("INSERT INTO state_schema_versions (component, version) VALUES (?, ?)");
      for (const [index, version] of markers.entries()) insert.run(`c${index}`, version);
    }
  } finally {
    db.close();
  }
}

function pm2(name: string, pid: number, startedAt = 1_000, status = "online"): Pm2Process {
  return { name, pm_id: name === "ravi" ? 0 : 1, pid, status, cpu: 0, memory: 0, createdAt: 1_000, startedAt };
}

describe("release order", () => {
  it("compares releases numerically and ignores a prerelease suffix or a v prefix", () => {
    expect(compareRaviVersions("3.261113.2", "3.261019.1")).toBe(1);
    expect(compareRaviVersions("3.261019.1", "3.261113.2")).toBe(-1);
    expect(compareRaviVersions("v3.261113.2", "3.261113.2-rc.1")).toBe(0);
    expect(compareRaviVersions("3.261113.10", "3.261113.9")).toBe(1);
  });
});

describe("release that last prepared the state", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ravi-update-preflight-"));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("is null without a database or without readiness markers", () => {
    expect(readPreparedStateRelease(stateDir)).toBeNull();
    writeStateDb(stateDir, null);
    expect(readPreparedStateRelease(stateDir)).toBeNull();
  });

  it("is the newest release among the markers, ignoring malformed ones", () => {
    writeStateDb(stateDir, ["1:3.261019.1", "1:3.261113.2", "garbage", "2:9.9.9"]);
    expect(readPreparedStateRelease(stateDir)).toBe("3.261113.2");
  });
});

describe("fence adoption waypoint", () => {
  it("lets a fenced state or a state prepared by the waypoint or later through", () => {
    for (const preparedRelease of [null, "3.261019.1"]) {
      expect(() =>
        assertFenceAdoptionWaypoint({ readiness: "ready", preparedRelease, targetVersion: "3.261119.9" }),
      ).not.toThrow();
    }
    for (const preparedRelease of [FENCE_ADOPTION_MINIMUM_RELEASE, "3.261117.4"]) {
      expect(() =>
        assertFenceAdoptionWaypoint({ readiness: "adopt-on-start", preparedRelease, targetVersion: "3.261119.9" }),
      ).not.toThrow();
    }
  });

  it("refuses a pre-fence state from an older release, or one without markers, with the exact commands", () => {
    for (const preparedRelease of ["3.261019.1", null]) {
      let refusal: unknown;
      try {
        assertFenceAdoptionWaypoint({ readiness: "adopt-on-start", preparedRelease, targetVersion: "3.261119.9" });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(UpdateWaypointRequiredError);
      const message = (refusal as Error).message;
      expect((refusal as UpdateWaypointRequiredError).code).toBe(UPDATE_WAYPOINT_REQUIRED);
      expect(message).toContain("Nothing was stopped");
      expect(message).toContain(`ravi update --version ${FENCE_ADOPTION_MINIMUM_RELEASE}`);
      expect(message).toContain("ravi update --next");
      expect(message).toContain("installed package is already Ravi 3.261119.9");
    }
  });
});

describe("waypoint for a source checkout", () => {
  it("gives checkout steps, since a source install does not accept --version", () => {
    let refusal: unknown;
    try {
      assertFenceAdoptionWaypoint({
        readiness: "adopt-on-start",
        preparedRelease: null,
        targetVersion: "3.261119.9",
        sourceCheckout: "/src/my ravi",
      });
    } catch (error) {
      refusal = error;
    }
    const message = (refusal as Error).message;
    // Exact commands: the path quoted, the tag fetched first, and the restart flag the command requires.
    expect(message).toContain('git -C "/src/my ravi" fetch --tags');
    expect(message).toContain(`git -C "/src/my ravi" switch --detach v${FENCE_ADOPTION_MINIMUM_RELEASE}`);
    expect(message).toContain('ravi daemon restart -m "waypoint"');
    expect(message).toContain("ravi channels restart");
    expect(message).toContain("checkout is already Ravi 3.261119.9");
    expect(message).not.toContain("ravi update --version");
  });
});

describe("stability window", () => {
  const converged = () => true;

  function clock() {
    let now = 0;
    return { now: () => now, wait: async (ms: number) => void (now += ms) };
  }

  it("reports success after the window when the same processes stay online", async () => {
    const time = clock();
    const processes = [pm2("ravi", 10), pm2("ravi-channels", 11)];
    let reads = 0;
    const stable = await observeStableManagedRuntime({
      getProcesses: () => {
        reads += 1;
        return processes;
      },
      isConverged: converged,
      windowMs: 30_000,
      pollMs: 1_000,
      ...time,
    });
    expect(stable).toBe(true);
    expect(time.now()).toBe(30_000);
    expect(reads).toBe(31);
  });

  it("fails on a restart inside the window: a new pid or start time", async () => {
    for (const restarted of [pm2("ravi", 99), pm2("ravi", 10, 5_000)]) {
      const time = clock();
      const stable = await observeStableManagedRuntime({
        getProcesses: () =>
          time.now() < 5_000 ? [pm2("ravi", 10), pm2("ravi-channels", 11)] : [restarted, pm2("ravi-channels", 11)],
        isConverged: converged,
        windowMs: 30_000,
        pollMs: 1_000,
        ...time,
      });
      expect(stable).toBe(false);
      expect(time.now()).toBe(5_000);
    }
  });

  it("fails when the runtime stops being converged", async () => {
    const time = clock();
    const processes = [pm2("ravi", 10), pm2("ravi-channels", 11)];
    const stable = await observeStableManagedRuntime({
      getProcesses: () => processes,
      isConverged: () => time.now() < 3_000,
      windowMs: 30_000,
      pollMs: 1_000,
      ...time,
    });
    expect(stable).toBe(false);
  });

  it("counts slow PM2 reads inside the window, so it ends by its deadline", async () => {
    const time = clock();
    const processes = [pm2("ravi", 10), pm2("ravi-channels", 11)];
    const stable = await observeStableManagedRuntime({
      // Every read takes 4 s: without accounting for it, the window overran by two reads.
      getProcesses: () => {
        void time.wait(4_000);
        return processes;
      },
      isConverged: converged,
      windowMs: 10_000,
      pollMs: 1_000,
      ...time,
    });
    expect(stable).toBe(true);
    expect(time.now()).toBeLessThanOrEqual(10_000);
  });

  it("ends by the deadline of the CLI that waits for the supervisor", () => {
    expect(boundedStabilityWindowMs({ windowMs: 30_000, now: 0 })).toBe(30_000);
    expect(boundedStabilityWindowMs({ windowMs: 30_000, deadlineMs: 50_000, now: 40_000 })).toBe(10_000);
    expect(boundedStabilityWindowMs({ windowMs: 30_000, deadlineMs: 50_000, now: 60_000 })).toBe(0);
  });

  it("gives no window to a CLI that declares no budget, and ends a declared one before that wait runs out", () => {
    // 3.261113.2 and older declare nothing and wait 30 s; 3.261113.3 to this change wait 90 s.
    expect(supervisorStabilityPlan(undefined, 1_000)).toEqual({ stabilityWindowMs: 0 });
    expect(supervisorStabilityPlan("soon", 1_000)).toEqual({ stabilityWindowMs: 0 });
    expect(supervisorStabilityPlan(String(MANAGED_RUNTIME_REBIND_TIMEOUT_MS), 1_000)).toEqual({
      stabilityDeadlineMs: 1_000 + MANAGED_RUNTIME_REBIND_TIMEOUT_MS - 10_000,
    });
    expect(SUPERVISOR_EXIT_MARGIN_MS).toBe(10_000);
    const invocation = buildManagedRuntimeRebindSupervisorInvocation(
      { bundlePath: "/opt/ravi/dist/bundle/index.js", cwd: "/opt/ravi", version: "3.261119.9" },
      [pm2("ravi", 10)],
      { PATH: "/usr/bin" },
    );
    expect(invocation.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV]).toBe(String(MANAGED_RUNTIME_REBIND_TIMEOUT_MS));
  });
});

describe("supervisor refusal reaches the CLI", () => {
  let stateDir: string;
  let inheritedStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ravi-update-refusal-"));
    inheritedStateDir = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env[REBIND_ENV];
    delete process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
    if (inheritedStateDir === undefined) delete process.env.RAVI_STATE_DIR;
    else process.env.RAVI_STATE_DIR = inheritedStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("passes the starting CLI's window plan to the rebind, and none to a CLI that declares no budget", async () => {
    const packageRoot = join(stateDir, "package");
    mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.261119.9" }));
    writeFileSync(join(packageRoot, "dist", "bundle", "index.js"), "");
    const invocation = buildManagedRuntimeRebindSupervisorInvocation(
      {
        bundlePath: realpathSync(join(packageRoot, "dist", "bundle", "index.js")),
        cwd: realpathSync(packageRoot),
        version: "3.261119.9",
      },
      [pm2("ravi", 10), pm2("ravi-channels", 11)],
      { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir },
    );
    const plans: SupervisorStabilityPlan[] = [];
    const rebind = async (_previous: unknown, _target: unknown, plan?: SupervisorStabilityPlan) => {
      plans.push({ ...plan });
      return true;
    };
    // A CLI from 3.261113.2 sends the request and no budget (it gives up after 30 s).
    process.env[REBIND_ENV] = invocation.env[REBIND_ENV];
    expect(await maybeRunManagedRuntimeRebindFromEnv(() => false, rebind)).toBe(true);
    // This CLI also declares how long it waits.
    process.env[REBIND_ENV] = invocation.env[REBIND_ENV];
    process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV] = invocation.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
    const spawnedAt = Date.now() - process.uptime() * 1000;
    expect(await maybeRunManagedRuntimeRebindFromEnv(() => false, rebind)).toBe(true);
    expect(plans[0]).toEqual({ stabilityWindowMs: 0 });
    const expectedDeadline = spawnedAt + MANAGED_RUNTIME_REBIND_TIMEOUT_MS - SUPERVISOR_EXIT_MARGIN_MS;
    expect(plans[1]?.stabilityWindowMs).toBeUndefined();
    expect(Math.abs((plans[1]?.stabilityDeadlineMs ?? 0) - expectedDeadline)).toBeLessThan(1_000);
  });

  it("reads back only a refusal recorded since the supervisor started", () => {
    const before = Date.now();
    recordSupervisorRefusal(UPDATE_WAYPOINT_REQUIRED, "waypoint first", stateDir);
    expect(readSupervisorRefusal(before, stateDir)).toMatchObject({
      code: UPDATE_WAYPOINT_REQUIRED,
      message: "waypoint first",
    });
    expect(readSupervisorRefusal(Date.now() + 60_000, stateDir)).toBeNull();
    rmSync(join(stateDir, "updates"), { recursive: true, force: true });
    expect(readSupervisorRefusal(before, stateDir)).toBeNull();
  });

  it("keeps a recorded code that looks like one", () => {
    expect(supervisorRefusalCode(UPDATE_WAYPOINT_REQUIRED)).toBe(UPDATE_WAYPOINT_REQUIRED);
    expect(supervisorRefusalCode("not a code; rm -rf")).toBe("UPDATE_FAILED");
  });

  it("refuses a pre-fence state without the waypoint before any stop, and records why", async () => {
    // No readiness markers and no fence: the state of a host still on 3.261019.1.
    writeStateDb(stateDir, null);
    const packageRoot = join(stateDir, "package");
    mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.261119.9" }));
    writeFileSync(join(packageRoot, "dist", "bundle", "index.js"), "");
    const invocation = buildManagedRuntimeRebindSupervisorInvocation(
      {
        bundlePath: realpathSync(join(packageRoot, "dist", "bundle", "index.js")),
        cwd: realpathSync(packageRoot),
        version: "3.261119.9",
      },
      [pm2("ravi", 10), pm2("ravi-channels", 11)],
      { PATH: "/usr/bin", RAVI_STATE_DIR: stateDir },
    );
    process.env[REBIND_ENV] = invocation.env[REBIND_ENV];
    process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV] = invocation.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
    const since = Date.now();
    await expect(maybeRunManagedRuntimeRebindFromEnv(() => false)).rejects.toThrow(UPDATE_WAYPOINT_REQUIRED);
    expect(process.env[REBIND_ENV]).toBeUndefined();
    expect(process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV]).toBeUndefined();
    const refusal = readSupervisorRefusal(since, stateDir);
    expect(refusal?.code).toBe(UPDATE_WAYPOINT_REQUIRED);
    expect(refusal?.message).toContain(`ravi update --version ${FENCE_ADOPTION_MINIMUM_RELEASE}`);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(true);
  });
});

function runtimePackage(version: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-window-runtime-")));
  const bundlePath = join(root, "dist", "bundle", "index.js");
  mkdirSync(join(root, "dist", "bundle"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot", version }), "utf8");
  writeFileSync(bundlePath, "", "utf8");
  const target = resolveManagedRuntimeTargetFromPackageRoot(root);
  if (!target) throw new Error(`fixture package ${root} has no runtime target`);
  return { root, bundlePath: realpathSync(bundlePath), target };
}

function managedProcess(
  name: "ravi" | "ravi-channels",
  bundlePath: string,
  cwd: string,
  overrides: Partial<Pm2Process> = {},
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 101 : 202,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? bundlePath : "/usr/local/bin/bun",
    cwd,
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    createdAt: 2,
    ...overrides,
  };
}

type WindowScenario = {
  plan: SupervisorStabilityPlan;
  /** A deadline this long after the window starts (the CLI's wait). */
  deadlineAfterMs?: number;
  daemonRestartAfterMs?: number;
  runnerRestartAfterMs?: number;
  daemonLeavesReadyAfterMs?: number;
  channelsOnline?: boolean;
};

/**
 * The real rebind, from a release on 3.261019.1 to 3.261119.9, against a fake PM2 and a fake clock. The window
 * starts at the first clock read after the final `pm2 save`; the scenario's events are relative to it.
 */
async function rebindWithWindow(scenario: WindowScenario): Promise<{ ok: boolean; windowElapsedMs: number }> {
  const inherited = process.env.RAVI_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-window-state-"));
  process.env.RAVI_STATE_DIR = stateDir;
  const next = runtimePackage("3.261119.9");
  const old = runtimePackage("3.261019.1");
  try {
    let processes: Pm2Process[] = [
      managedProcess("ravi", old.bundlePath, old.root, { pid: 10, createdAt: 1 }),
      ...(scenario.channelsOnline === false
        ? []
        : [managedProcess("ravi-channels", old.bundlePath, old.root, { pid: 20, createdAt: 1 })]),
    ];
    const previous = processes.map(({ name, status, pid, createdAt }) => ({
      name,
      status,
      pid,
      createdAt: createdAt ?? null,
    }));
    let t = 1_000_000;
    let saved = false;
    let windowStart: number | null = null;
    const after = (ms: number | undefined) => ms !== undefined && windowStart !== null && t - windowStart >= ms;
    const deps: NonNullable<Parameters<typeof rebindManagedRuntimeProcesses>[2]> = {
      stateDir,
      bunPath: process.execPath,
      assertPrepared: () => "ready",
      runnerEnv: () => ({}),
      pidAlive: () => true,
      now: () => {
        if (saved && windowStart === null) windowStart = t;
        return t;
      },
      wait: async (ms: number) => {
        t += ms;
      },
      schemaPhase: (process) =>
        process.pid !== 11 ? null : after(scenario.daemonLeavesReadyAfterMs) ? "waiting" : "ready",
      getProcesses: () =>
        processes.map((process) => {
          if (process.name === "ravi" && after(scenario.daemonRestartAfterMs))
            return { ...process, pid: 99, startedAt: (process.startedAt ?? 0) + 5_000 };
          if (process.name === "ravi-channels" && after(scenario.runnerRestartAfterMs))
            return { ...process, pid: 98, startedAt: (process.startedAt ?? 0) + 5_000 };
          return process;
        }),
      run: async (_command: string, args: string[]) => {
        if (args[0] === "delete") {
          processes = processes.filter((process) => String(process.pm_id) !== args[1]);
        } else if (args[0] === "start") {
          const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
          const startedAt = Math.ceil(statSync(next.bundlePath).mtimeMs) + 1;
          const pid = name === "ravi" ? 11 : 21;
          processes.push(managedProcess(name, next.bundlePath, next.root, { pid, createdAt: 2, startedAt }));
          writeRuntimeBootReceipt({
            ...observeRuntimeBoot({
              bundlePath: next.bundlePath,
              runningVersion: next.target.version,
              envFile: join(stateDir, ".env"),
              now: startedAt,
            }),
            schemaVersion: 1,
            name,
            pid,
            startedAt,
          });
        } else if (args[0] === "save") {
          saved = true;
        }
        return { success: true, output: "" };
      },
      ...scenario.plan,
    };
    if (scenario.deadlineAfterMs !== undefined) {
      const deadlineAfterMs = scenario.deadlineAfterMs;
      // Read when the window is sized, right after convergence.
      Object.defineProperty(deps, "stabilityDeadlineMs", { get: () => (windowStart ?? t) + deadlineAfterMs });
    }
    const ok = await rebindManagedRuntimeProcesses(previous, next.target, deps);
    return { ok, windowElapsedMs: windowStart === null ? 0 : t - windowStart };
  } finally {
    rmSync(next.root, { recursive: true, force: true });
    rmSync(old.root, { recursive: true, force: true });
    if (inherited === undefined) delete process.env.RAVI_STATE_DIR;
    else process.env.RAVI_STATE_DIR = inherited;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("stability window wired into the rebind", () => {
  it("holds a stable runtime for the window", async () => {
    const result = await rebindWithWindow({ plan: { stabilityWindowMs: 5_000 } });
    expect(result.ok).toBe(true);
    expect(result.windowElapsedMs).toBeGreaterThanOrEqual(4_000);
  });

  it("fails when the daemon restarts inside the window", async () => {
    expect((await rebindWithWindow({ plan: { stabilityWindowMs: 5_000 }, daemonRestartAfterMs: 2_000 })).ok).toBe(
      false,
    );
  });

  it("fails when the runner restarts inside the window", async () => {
    expect((await rebindWithWindow({ plan: { stabilityWindowMs: 5_000 }, runnerRestartAfterMs: 2_000 })).ok).toBe(
      false,
    );
  });

  it("fails when the daemon leaves ready with the same PID", async () => {
    expect((await rebindWithWindow({ plan: { stabilityWindowMs: 5_000 }, daemonLeavesReadyAfterMs: 2_000 })).ok).toBe(
      false,
    );
  });

  it("ends the window by the CLI's deadline", async () => {
    const result = await rebindWithWindow({
      plan: { stabilityWindowMs: 30_000 },
      deadlineAfterMs: 3_000,
      daemonRestartAfterMs: 4_000,
    });
    expect(result.ok).toBe(true);
    expect(result.windowElapsedMs).toBeLessThanOrEqual(3_500);
  });

  it("watches only what was online before", async () => {
    expect((await rebindWithWindow({ plan: { stabilityWindowMs: 5_000 }, channelsOnline: false })).ok).toBe(true);
  });

  it("answers right after convergence for a CLI that declares no budget (3.261113.2 waits 30 s)", async () => {
    const result = await rebindWithWindow({
      plan: supervisorStabilityPlan(undefined, 0),
      // A restart the default 30 s window would have caught: with no window it is not watched.
      daemonRestartAfterMs: 20_000,
    });
    expect(result.ok).toBe(true);
    expect(result.windowElapsedMs).toBe(0);
  });
});

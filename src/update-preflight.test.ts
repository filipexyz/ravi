import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorRefusalCode } from "./cli/commands/update.js";
import {
  boundedStabilityWindowMs,
  buildManagedRuntimeRebindSupervisorInvocation,
  MANAGED_RUNTIME_REBIND_TIMEOUT_MS,
  MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV,
  maybeRunManagedRuntimeRebindFromEnv,
  observeStableManagedRuntime,
  readSupervisorRefusal,
  recordSupervisorRefusal,
  supervisorBudgetMs,
} from "./managed-runtime-rebind.js";
import type { Pm2Process } from "./pm2.js";
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
        sourceCheckout: "/src/ravi",
      });
    } catch (error) {
      refusal = error;
    }
    const message = (refusal as Error).message;
    expect(message).toContain(`git -C /src/ravi switch --detach v${FENCE_ADOPTION_MINIMUM_RELEASE}`);
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

  it("assumes the 90 s wait of a CLI that declares no budget", () => {
    expect(supervisorBudgetMs(undefined)).toBe(90_000);
    expect(supervisorBudgetMs("soon")).toBe(90_000);
    expect(supervisorBudgetMs(String(MANAGED_RUNTIME_REBIND_TIMEOUT_MS))).toBe(MANAGED_RUNTIME_REBIND_TIMEOUT_MS);
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

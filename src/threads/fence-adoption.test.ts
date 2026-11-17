import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStateDatabase } from "../db/state-boundary.js";
import {
  assertRuntimeMaintenanceInactive,
  persistRuntimeMaintenance,
  readRuntimeMaintenance,
  type MaintenanceProcess,
} from "../runtime-maintenance.js";
import {
  admitDaemonStart,
  adoptThreadFenceAsSuccessor,
  databaseHasThreadFence,
  describeThreadFenceMaintenance,
  planThreadFenceAdoption,
  prepareThreadFenceAdoption,
  readThreadFenceAdoption,
  recoverThreadFenceAdoption,
  resumeThreadFenceAdoption,
  successorOutcome,
  type AdoptionHost,
  type DurableResidue,
  type ManagedRegistration,
} from "./fence-adoption.js";
import { prepareThreadFence, readThreadSchemaFence } from "./schema-fence.js";

const roots: string[] = [];
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function exitedPid(): number {
  // A disposable process prints its own pid and exits: no runtime, live DB, broker or launcher.
  const result = spawnSync(process.execPath, ["--no-env-file", "-e", "console.log(process.pid)"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH },
    cwd: tmpdir(),
  });
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

const digestOf = (path: string) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // no-cause: An unreadable fixture bundle is reported as uncertifiable, like the real probe.
    return null;
  }
};

function fixture(options: { residue?: DurableResidue; bootIdentity?: (name: string) => boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-adoption-"));
  roots.push(stateDir);
  const databasePath = join(stateDir, "ravi.db");
  const legacy = openStateDatabase(databasePath);
  legacy.exec("CREATE TABLE pending_work (id TEXT); INSERT INTO pending_work VALUES ('preserved')");
  legacy.close();
  mkdirSync(join(stateDir, "bundle"));
  const bundlePath = join(stateDir, "bundle", "index.js");
  writeFileSync(bundlePath, "// target release\n");
  const legacySha = "b".repeat(64);
  const predecessors: MaintenanceProcess[] = [
    { name: "ravi", pid: exitedPid(), startedAt: 1_000, bundleSha256: legacySha },
    { name: "ravi-channels", pid: exitedPid(), startedAt: 1_001, bundleSha256: legacySha },
  ];
  const state = {
    online: { ravi: true, "ravi-channels": true } as Record<string, boolean>,
    pid: { ravi: predecessors[0]!.pid, "ravi-channels": predecessors[1]!.pid } as Record<string, number>,
    startedAt: { ravi: 1_000, "ravi-channels": 1_001 } as Record<string, number>,
    relaunchChannelsOnStop: false,
  };
  const stops: string[] = [];
  const registry = (): ManagedRegistration[] => [
    ...(["ravi", "ravi-channels"] as const).map((name) => ({
      name,
      pid: state.online[name] ? state.pid[name]! : 0,
      startedAt: state.startedAt[name]!,
      online: state.online[name]!,
      scriptPath: bundlePath,
    })),
    // An unrelated app under the same process manager is not a Ravi writer.
    { name: "nats", pid: process.pid, startedAt: 1, online: true, scriptPath: "/usr/local/bin/nats-server" },
  ];
  const host: AdoptionHost = {
    stateDir,
    databasePath,
    registry,
    bootIdentity: (registration) =>
      (options.bootIdentity?.(registration.name) ?? true)
        ? (predecessors.find((entry) => entry.name === registration.name && entry.pid === registration.pid) ?? null)
        : null,
    bundleDigest: digestOf,
    stop: async (name) => {
      stops.push(name);
      state.online[name] = false;
      if (state.relaunchChannelsOnStop && name === "ravi") state.online["ravi-channels"] = true;
    },
    residue: async () =>
      options.residue ?? {
        sources: [{ source: "jetstream:SESSION_PROMPTS/ravi", pending: 2, inFlight: 0 }],
        unknown: [],
      },
    wait: async () => {},
    exitChecks: 3,
  };
  const startSuccessor = () => {
    state.online.ravi = true;
    state.pid.ravi = process.pid;
    state.startedAt.ravi = 2_000;
  };
  const open = () => {
    const db = openStateDatabase(databasePath);
    handles.push(db);
    prepareThreadFence(db);
  };
  return { stateDir, databasePath, bundlePath, predecessors, state, stops, registry, host, startSuccessor, open };
}

function audit(path: string): { reason: string; evidence?: unknown[] } {
  return JSON.parse(readFileSync(`${path}.thread-bootstrap.jsonl`, "utf8").trim().split("\n").at(-1)!);
}

/** Another process (a recovery, a coordinator) holding the coordinator lease; the kernel lock is per process. */
async function holdCoordinatorLeaseElsewhere(stateDir: string): Promise<{ stop(): Promise<void> }> {
  const lockModule = join(import.meta.dir, "..", "db", "schema-lock.ts");
  const lockPath = join(stateDir, "runtime-maintenance", "coordinator.lock");
  const script = `(async () => {
    const { acquireSchemaFileLock } = await import(${JSON.stringify(lockModule)});
    acquireSchemaFileLock(${JSON.stringify(lockPath)}, 0);
    console.log("held");
    setInterval(() => {}, 1000);
  })();`;
  const child = spawn(process.execPath, ["--no-env-file", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
    cwd: tmpdir(),
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("held")) resolve();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once("exit", () => reject(new Error(`lease holder exited: ${errors}`)));
  });
  return {
    stop: async () => {
      child.kill();
      await exited;
    },
  };
}

describe("thread fence adoption of a legacy database", () => {
  it("stops channels then daemon, authorizes one successor, installs the fence and releases the interlock", async () => {
    const f = fixture();
    const adoption = await prepareThreadFenceAdoption(f.host, f.bundlePath);
    expect(f.stops).toEqual(["ravi-channels", "ravi"]);
    expect(adoption.phase).toBe("authorized");
    expect(readRuntimeMaintenance(f.stateDir)?.phase).toBe("stopped");
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");

    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
    const adopted = adoptThreadFenceAsSuccessor({
      stateDir: f.stateDir,
      registry: f.registry,
      bundleDigest: digestOf,
      self,
      open: f.open,
    });

    expect(adopted.phase).toBe("adopted");
    const db = handles.at(-1)!;
    expect(readThreadSchemaFence(db)).toMatchObject({ phase: "legacy_ready", epoch: 0 });
    expect(db.query("SELECT id FROM pending_work").all()).toEqual([{ id: "preserved" }]);
    expect(audit(f.databasePath)).toMatchObject({ reason: "verified-predecessor-exits" });
    expect(audit(f.databasePath).evidence).toHaveLength(3);
    // Interlock released: ordinary starts are admitted again and the records are archived.
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(readThreadFenceAdoption(f.stateDir)).toBeNull();
    expect(existsSync(join(f.stateDir, "runtime-maintenance", "history", `${adoption.maintenanceId}.json`))).toBe(true);
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "normal",
    );
  });

  it("the preview refuses before any stop when a running process has no matching boot identity", () => {
    const f = fixture({ bootIdentity: (name) => name !== "ravi-channels" });
    expect(() => planThreadFenceAdoption(f.host, f.bundlePath)).toThrow("ravi-channels boot identity");
    expect(f.stops).toEqual([]);
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
  });

  it("refuses when the launchers do not start the installed release", () => {
    const f = fixture();
    const other = join(f.stateDir, "bundle", "other.js");
    writeFileSync(other, "// another bundle\n");
    expect(() => planThreadFenceAdoption(f.host, other)).toThrow("launcher does not start the installed release");
    expect(f.stops).toEqual([]);
  });

  it("unknown accepted work blocks after the stops, keeps the interlock and leaves the database untouched", async () => {
    const f = fixture({ residue: { sources: [], unknown: ["outbox:7f3a"] } });
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("unknown outcome: outbox:7f3a");
    expect(readRuntimeMaintenance(f.stateDir)).toMatchObject({ phase: "blocked" });
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "preparation-blocked" });
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });

  it("a blocked preparation has an exit: abandon releases the interlock, nothing else changes", async () => {
    const f = fixture({ residue: { sources: [], unknown: ["outbox:7f3a"] } });
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("unknown outcome");
    // Adopting again is refused while the maintenance is open: recovery is the only way out.
    expect(() => planThreadFenceAdoption(f.host, f.bundlePath)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    const state = describeThreadFenceMaintenance({ stateDir: f.stateDir, databasePath: f.databasePath });
    expect(state).toMatchObject({ interlock: true, fenced: false, modes: ["retry", "abandon"] });
    expect(state.diagnosis).toContain("unknown outcome: outbox:7f3a");
    expect(state.maintenance).toMatchObject({ phase: "blocked" });
    expect(state.predecessors.map((entry) => entry.exit)).toEqual(["exited", "exited"]);
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "release" }),
    ).toThrow("release does not apply");
    expect(recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "abandon" })).toBe(
      "abandoned",
    );
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    const self = { pid: process.pid, startedAt: 2_000 };
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "normal",
    );
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
    // With the legacy release back online, a new adoption can be planned again.
    expect(() => planThreadFenceAdoption(f.host, f.bundlePath)).toThrow("is not running under its launcher");
  });

  it("a blocked preparation resumes once its residue is known, without stopping anything again", async () => {
    const f = fixture({ residue: { sources: [], unknown: ["jetstream: unreachable"] } });
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("unknown outcome");
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "retry" }),
    ).toThrow("resumes through the coordinator");
    f.host.residue = async () => ({
      sources: [{ source: "jetstream:CHANNEL_OUTBOUND", pending: 1, inFlight: 0 }],
      unknown: [],
    });
    const resumed = await resumeThreadFenceAdoption(f.host);
    expect(resumed.phase).toBe("authorized");
    expect(f.stops).toEqual(["ravi-channels", "ravi"]);
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
    adoptThreadFenceAsSuccessor({
      stateDir: f.stateDir,
      registry: f.registry,
      bundleDigest: digestOf,
      self,
      open: f.open,
    });
    expect(databaseHasThreadFence(f.databasePath)).toBe(true);
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("adopted");
  });

  it("a maintenance record left without an adoption record can be abandoned", async () => {
    const f = fixture();
    mkdirSync(join(f.stateDir, "runtime-maintenance", "interlock"), { recursive: true });
    persistRuntimeMaintenance(
      {
        protocol: "ravi.runtime-maintenance/v1",
        id: "m-1",
        phase: "blocked",
        targetBundleSha256: "c".repeat(64),
        predecessors: f.predecessors,
        completion: [],
        exitedPids: [],
        failure: "pm2 stop ravi-channels exited 1",
      },
      f.stateDir,
    );
    const state = describeThreadFenceMaintenance({ stateDir: f.stateDir, databasePath: f.databasePath });
    expect(state).toMatchObject({ adoption: null, modes: ["abandon"] });
    expect(state.diagnosis).toContain("pm2 stop ravi-channels exited 1");
    expect(recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "abandon" })).toBe(
      "abandoned",
    );
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
  });

  it("an interlock left without any record (coordinator killed before its first record) exits by abandon only", () => {
    const f = fixture();
    mkdirSync(join(f.stateDir, "runtime-maintenance", "interlock"), { recursive: true });
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(() => planThreadFenceAdoption(f.host, f.bundlePath)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    const state = describeThreadFenceMaintenance({ stateDir: f.stateDir, databasePath: f.databasePath });
    expect(state).toMatchObject({
      interlock: true,
      maintenance: null,
      adoption: null,
      fenced: false,
      modes: ["abandon"],
      diagnosis: "an interlock without any record",
    });
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "retry" }),
    ).toThrow("retry does not apply");
    expect(recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "abandon" })).toBe(
      "abandoned",
    );
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
  });

  it("a record moved to history between two reads reads as absent, not as an error", () => {
    const f = fixture();
    expect(readThreadFenceAdoption(f.stateDir)).toBeNull();
    expect(readRuntimeMaintenance(f.stateDir)).toBeNull();
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("failed");
  });

  it("an interlock orphaned after the fence was installed is released, and only then the outcome is adopted", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self });
    adoptThreadFenceAsSuccessor({
      stateDir: f.stateDir,
      registry: f.registry,
      bundleDigest: digestOf,
      self,
      open: f.open,
    });
    // A crash inside the release after the records moved and before the interlock went away.
    mkdirSync(join(f.stateDir, "runtime-maintenance", "interlock"));
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("pending");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    const state = describeThreadFenceMaintenance({ stateDir: f.stateDir, databasePath: f.databasePath });
    expect(state).toMatchObject({ adoption: null, maintenance: null, fenced: true, modes: ["release"] });
    expect(recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "release" })).toBe(
      "released",
    );
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("adopted");
  });

  it("admission and recovery share one boundary: while another process holds it, neither claims nor archives", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    const holder = await holdCoordinatorLeaseElsewhere(f.stateDir);
    try {
      // A recovery is acting: the successor start waits for it, then refuses, and writes nothing.
      expect(() =>
        admitDaemonStart({
          stateDir: f.stateDir,
          ownBundlePath: f.bundlePath,
          bundleDigest: digestOf,
          self,
          leaseTimeoutMs: 0,
        }),
      ).toThrow("an adoption coordinator or recovery is running");
      expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "authorized" });
      expect(existsSync(join(f.stateDir, "runtime-maintenance", "successor"))).toBe(false);
      // And a second recovery cannot act on the same records either.
      expect(() =>
        recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "abandon" }),
      ).toThrow("another adoption coordinator or recovery is running");
    } finally {
      await holder.stop();
    }
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
    // Once claimed, a recovery sees the live successor and has no mode to apply.
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "abandon" }),
    ).toThrow("abandon does not apply");
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "adopting" });
    // The successor's adoption also waits for the boundary.
    const second = await holdCoordinatorLeaseElsewhere(f.stateDir);
    try {
      expect(() =>
        adoptThreadFenceAsSuccessor({
          stateDir: f.stateDir,
          registry: f.registry,
          bundleDigest: digestOf,
          self,
          open: f.open,
          leaseTimeoutMs: 0,
        }),
      ).toThrow("another adoption coordinator or recovery is running");
      expect(databaseHasThreadFence(f.databasePath)).toBe(false);
    } finally {
      await second.stop();
    }
    adoptThreadFenceAsSuccessor({
      stateDir: f.stateDir,
      registry: f.registry,
      bundleDigest: digestOf,
      self,
      open: f.open,
    });
    expect(databaseHasThreadFence(f.databasePath)).toBe(true);
  });

  it("the successor is re-admitted only with the same pid AND start time", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self });
    expect(() =>
      admitDaemonStart({
        stateDir: f.stateDir,
        ownBundlePath: f.bundlePath,
        bundleDigest: digestOf,
        self: { pid: process.pid, startedAt: 3_000 },
      }),
    ).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
  });

  it("a launcher that relaunches a runtime during maintenance blocks the adoption", async () => {
    const f = fixture();
    f.state.relaunchChannelsOnStop = true;
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("THREAD_FENCE_ADOPTION_BLOCKED");
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "preparation-blocked" });
    expect(readRuntimeMaintenance(f.stateDir)).toMatchObject({ phase: "blocked" });
  });

  it("only the authorized bundle may start, once; the channel runner stays refused", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    const other = join(f.stateDir, "bundle", "other.js");
    writeFileSync(other, "// another bundle\n");
    const self = { pid: process.pid, startedAt: 2_000 };
    expect(() =>
      admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: other, bundleDigest: digestOf, self }),
    ).toThrow("only the authorized successor bundle");
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
    // Same process re-entering (entry guard, then daemon start) keeps its claim.
    expect(admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self })).toBe(
      "successor",
    );
    expect(() =>
      admitDaemonStart({
        stateDir: f.stateDir,
        ownBundlePath: f.bundlePath,
        bundleDigest: digestOf,
        self: { pid: exitedPid(), startedAt: 3_000 },
      }),
    ).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
  });

  it("changed evidence blocks the successor before any fence SQL; retry needs the successor gone", async () => {
    const f = fixture();
    const adoption = await prepareThreadFenceAdoption(f.host, f.bundlePath);
    writeFileSync(adoption.completion[0]!.evidencePath, "{}\n");
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self });
    expect(() =>
      adoptThreadFenceAsSuccessor({
        stateDir: f.stateDir,
        registry: f.registry,
        bundleDigest: digestOf,
        self,
        open: f.open,
      }),
    ).toThrow("external evidence changed");
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "blocked" });
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "retry" }),
    ).toThrow("present or its exit is unknown");
    expect(() =>
      recoverThreadFenceAdoption({ stateDir: f.stateDir, databasePath: f.databasePath, mode: "release" }),
    ).toThrow("release does not apply");
    expect(
      recoverThreadFenceAdoption({
        stateDir: f.stateDir,
        databasePath: f.databasePath,
        mode: "retry",
        exitState: () => "exited",
      }),
    ).toBe("reauthorized");
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "authorized" });
    expect(
      recoverThreadFenceAdoption({
        stateDir: f.stateDir,
        databasePath: f.databasePath,
        mode: "abandon",
        exitState: () => "exited",
      }),
    ).toBe("abandoned");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });

  it("a running channel runner means admissions are open; the successor refuses to install", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    f.startSuccessor();
    const self = { pid: process.pid, startedAt: 2_000 };
    admitDaemonStart({ stateDir: f.stateDir, ownBundlePath: f.bundlePath, bundleDigest: digestOf, self });
    f.state.online["ravi-channels"] = true;
    f.state.pid["ravi-channels"] = process.pid;
    expect(() =>
      adoptThreadFenceAsSuccessor({
        stateDir: f.stateDir,
        registry: f.registry,
        bundleDigest: digestOf,
        self,
        open: f.open,
      }),
    ).toThrow("admissions are not closed");
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });

  it("an already fenced database is not adopted again; ordinary restart applies", () => {
    const f = fixture();
    // The plan only probes for the fence table, read-only; a marker table is enough here.
    const fenced = openStateDatabase(f.databasePath);
    handles.push(fenced);
    fenced.exec("CREATE TABLE thread_schema_fence (id INTEGER PRIMARY KEY)");
    expect(() => planThreadFenceAdoption(f.host, f.bundlePath)).toThrow("already has the thread fence");
  });
});

describe("daemon entry settles adoption leftovers by itself (heal)", () => {
  const admit = (
    f: ReturnType<typeof fixture>,
    self = { pid: process.pid, startedAt: 2_000 },
    ownBundlePath?: string,
  ) =>
    admitDaemonStart({
      stateDir: f.stateDir,
      ownBundlePath: ownBundlePath ?? f.bundlePath,
      bundleDigest: digestOf,
      self,
      heal: true,
    });

  it("a preparation that stopped before authorizing a successor is abandoned: the start is ordinary", async () => {
    const f = fixture({ residue: { sources: [], unknown: ["outbox:7f3a"] } });
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("unknown outcome");
    expect(admit(f)).toBe("normal");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });

  it("an interlock orphaned after the fence was installed is released", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    const db = openStateDatabase(f.databasePath);
    handles.push(db);
    // The fence exists, the successor is gone: only the release is left.
    db.exec("CREATE TABLE thread_schema_fence (id INTEGER PRIMARY KEY)");
    expect(admit(f, { pid: exitedPid(), startedAt: 3_000 })).toBe("normal");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
  });

  it("an authorized successor of this very bundle is still claimed, not abandoned", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    expect(admit(f)).toBe("successor");
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "adopting" });
  });

  it("an authorization for another bundle is abandoned, so the boot adoption re-derives it", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    const other = join(f.stateDir, "bundle", "other.js");
    writeFileSync(other, "// a later release\n");
    expect(admit(f, undefined, other)).toBe("normal");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
  });

  it("a successor that may still be adopting is never healed away", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    // Claimed by a live process (this test runner) with another start time.
    expect(admit(f, { pid: process.pid, startedAt: 2_000 })).toBe("successor");
    expect(() => admit(f, { pid: exitedPid(), startedAt: 9_000 })).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(readThreadFenceAdoption(f.stateDir)).toMatchObject({ phase: "adopting" });
  });

  it("a successor that died before installing the fence is abandoned", async () => {
    const f = fixture();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    const dead = { pid: exitedPid(), startedAt: 2_500 };
    expect(admit(f, dead)).toBe("successor");
    expect(admit(f, { pid: process.pid, startedAt: 4_000 })).toBe("normal");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });
});

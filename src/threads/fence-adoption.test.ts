import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStateDatabase } from "../db/state-boundary.js";
import {
  assertRuntimeMaintenanceInactive,
  readRuntimeMaintenance,
  type MaintenanceProcess,
} from "../runtime-maintenance.js";
import {
  admitDaemonStart,
  adoptThreadFenceAsSuccessor,
  databaseHasThreadFence,
  planThreadFenceAdoption,
  prepareThreadFenceAdoption,
  readThreadFenceAdoption,
  recoverThreadFenceAdoption,
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
    expect(readThreadFenceAdoption(f.stateDir)).toBeNull();
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("RUNTIME_MAINTENANCE_ACTIVE");
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });

  it("a launcher that relaunches a runtime during maintenance blocks the adoption", async () => {
    const f = fixture();
    f.state.relaunchChannelsOnStop = true;
    await expect(prepareThreadFenceAdoption(f.host, f.bundlePath)).rejects.toThrow("THREAD_FENCE_ADOPTION_BLOCKED");
    expect(readThreadFenceAdoption(f.stateDir)).toBeNull();
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
    ).toThrow("fence is not installed");
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

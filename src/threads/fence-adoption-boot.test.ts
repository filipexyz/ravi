import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStateDatabase } from "../db/state-boundary.js";
import {
  assertRuntimeMaintenanceInactive,
  recordedProcessExitState,
  type MaintenanceProcess,
} from "../runtime-maintenance.js";
import {
  adoptThreadFenceAtBoot,
  type BootAdoptionHost,
  databaseHasThreadFence,
  type DurableResidue,
  type ManagedRegistration,
  readUpgradeFailure,
} from "./fence-adoption.js";
import { prepareThreadFence } from "./schema-fence.js";

const roots: string[] = [];
const handles: Database[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function exitedPid(): number {
  const result = spawnSync(process.execPath, ["--no-env-file", "-e", "console.log(process.pid)"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH },
    cwd: tmpdir(),
  });
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

/** A live process that is not this one (a pid some other program owns now). */
function livePid(): number {
  const child = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: { PATH: process.env.PATH },
    cwd: tmpdir(),
  });
  children.push(child);
  return child.pid!;
}

const digestOf = (path: string) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // no-cause: An unreadable fixture bundle is reported as uncertifiable, like the real probe.
    return null;
  }
};

type Registration = { online: boolean; pid: number; status: string };

function fixture(
  options: {
    residue?: DurableResidue;
    receipts?: Partial<Record<"ravi" | "ravi-channels", MaintenanceProcess | null>>;
    channels?: Registration | null;
    extra?: ManagedRegistration[];
    brokerReady?: boolean;
  } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-boot-"));
  roots.push(stateDir);
  const databasePath = join(stateDir, "ravi.db");
  const legacy = openStateDatabase(databasePath);
  legacy.exec("CREATE TABLE pending_work (id TEXT); INSERT INTO pending_work VALUES ('preserved')");
  legacy.close();
  mkdirSync(join(stateDir, "bundle"));
  const bundlePath = join(stateDir, "bundle", "index.js");
  writeFileSync(bundlePath, "// installed release\n");
  const legacySha = "b".repeat(64);
  const now = Date.now();
  const receipts: Record<"ravi" | "ravi-channels", MaintenanceProcess | null> = {
    ravi: { name: "ravi", pid: exitedPid(), startedAt: now - 60_000, bundleSha256: legacySha },
    "ravi-channels": { name: "ravi-channels", pid: exitedPid(), startedAt: now - 60_000, bundleSha256: legacySha },
    ...options.receipts,
  };
  const self = { pid: process.pid, startedAt: now };
  const channels: Registration | null =
    options.channels === undefined ? { online: true, pid: exitedPid(), status: "online" } : options.channels;
  const stops: string[] = [];
  const starts: string[] = [];
  const registry = (): ManagedRegistration[] => [
    { name: "ravi", pid: self.pid, startedAt: self.startedAt, online: true, scriptPath: bundlePath, status: "online" },
    ...(channels
      ? [
          {
            name: "ravi-channels",
            pid: channels.online ? channels.pid : 0,
            startedAt: now - 1_000,
            online: channels.online,
            scriptPath: bundlePath,
            status: channels.status,
          },
        ]
      : []),
    { name: "nats", pid: 1, startedAt: 1, online: true, scriptPath: "/usr/local/bin/nats-server", status: "online" },
    ...(options.extra ?? []),
  ];
  const host: BootAdoptionHost = {
    stateDir,
    databasePath,
    ownBundlePath: bundlePath,
    self,
    registry,
    bundleDigest: digestOf,
    lastBootIdentity: (name) => receipts[name],
    brokerReady: async () => options.brokerReady ?? true,
    stop: async (name) => {
      stops.push(name);
      if (name === "ravi-channels" && channels) {
        channels.online = false;
        channels.status = "stopped";
      }
    },
    start: (name) => {
      starts.push(name);
    },
    residue: async () =>
      options.residue ?? {
        sources: [{ source: "jetstream:SESSION_PROMPTS/ravi", pending: 1, inFlight: 0 }],
        unknown: [],
      },
    open: () => {
      const db = openStateDatabase(databasePath);
      handles.push(db);
      prepareThreadFence(db);
    },
    wait: async () => {},
    exitChecks: 3,
  };
  return { stateDir, databasePath, bundlePath, host, stops, starts, receipts };
}

function untouched(databasePath: string): void {
  expect(databaseHasThreadFence(databasePath)).toBe(false);
  const db = openStateDatabase(databasePath);
  handles.push(db);
  expect(db.query("SELECT id FROM pending_work").all()).toEqual([{ id: "preserved" }]);
}

const maintenanceDir = (stateDir: string) => join(stateDir, "runtime-maintenance");

describe("transparent thread fence adoption at daemon entry", () => {
  it("stops the channel runner, proves the residue, installs the fence, releases everything and restarts channels", async () => {
    const f = fixture();
    const result = await adoptThreadFenceAtBoot(f.host);
    expect(result).toMatchObject({ outcome: "adopted", channelsStarted: true });
    expect(f.stops).toEqual(["ravi-channels"]);
    expect(f.starts).toEqual(["ravi-channels"]);
    expect(databaseHasThreadFence(f.databasePath)).toBe(true);
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(existsSync(join(maintenanceDir(f.stateDir), "successor"))).toBe(false);
    const history = readdirSync(join(maintenanceDir(f.stateDir), "history"));
    const adoption = JSON.parse(
      readFileSync(
        join(maintenanceDir(f.stateDir), "history", history.find((n) => n.endsWith(".adoption.json"))!),
        "utf8",
      ),
    );
    expect(adoption).toMatchObject({ phase: "adopted", successor: { pid: process.pid } });
    const audit = readFileSync(`${f.databasePath}.thread-bootstrap.jsonl`, "utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(audit)).toMatchObject({ reason: "verified-predecessor-exits" });
    expect(readUpgradeFailure(f.stateDir)).toBeNull();
    // A second start on the fenced database is an ordinary start.
    expect(await adoptThreadFenceAtBoot(f.host)).toEqual({ outcome: "not-needed" });
  });

  it("refuses without writing or stopping anything while a legacy daemon is still running", async () => {
    const f = fixture({
      extra: [
        { name: "ravi", pid: exitedPid(), startedAt: 1, online: true, scriptPath: "/old/bundle.js", status: "online" },
      ],
    });
    await expect(adoptThreadFenceAtBoot(f.host)).rejects.toThrow("previous Ravi daemon is still running");
    expect(f.stops).toEqual([]);
    expect(existsSync(join(maintenanceDir(f.stateDir), "interlock"))).toBe(false);
    expect(readUpgradeFailure(f.stateDir)?.failure).toContain("ravi daemon restart");
    untouched(f.databasePath);
  });

  it("unknown residue refuses with its list, releases the interlock and leaves the database untouched", async () => {
    const f = fixture({ residue: { sources: [], unknown: ["outbox:7f3a"] } });
    await expect(adoptThreadFenceAtBoot(f.host)).rejects.toThrow("unknown outcome blocks the upgrade: outbox:7f3a");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    expect(f.starts).toEqual([]);
    expect(readUpgradeFailure(f.stateDir)?.failure).toContain("outbox:7f3a");
    untouched(f.databasePath);
    expect(f.stops).toEqual(["ravi-channels"]);
    expect(readUpgradeFailure(f.stateDir)?.channelsStopped).toBe(true);
    // Once the residue is settled the next start adopts and starts again the runner the refused attempt stopped,
    // although its launcher now reads `stopped`.
    const settled = { ...f.host, residue: async () => ({ sources: [], unknown: [] }) };
    expect(await adoptThreadFenceAtBoot(settled)).toMatchObject({ outcome: "adopted", channelsStarted: true });
    expect(f.starts).toEqual(["ravi-channels"]);
    expect(readUpgradeFailure(f.stateDir)).toBeNull();
  });

  it("a recorded pid reused after an OS reboot does not block: the process started before the boot", async () => {
    const f = fixture({
      receipts: {
        "ravi-channels": { name: "ravi-channels", pid: livePid(), startedAt: 1_000, bundleSha256: "c".repeat(64) },
      },
      channels: { online: false, pid: 0, status: "errored" },
    });
    expect(await adoptThreadFenceAtBoot(f.host)).toMatchObject({ outcome: "adopted", channelsStarted: true });
  });

  it("a recorded process that may still run blocks, and nothing is installed", async () => {
    const f = fixture({
      receipts: {
        "ravi-channels": {
          name: "ravi-channels",
          pid: livePid(),
          startedAt: Date.now(),
          bundleSha256: "c".repeat(64),
        },
      },
      channels: { online: false, pid: 0, status: "stopped" },
    });
    await expect(adoptThreadFenceAtBoot(f.host)).rejects.toThrow("did not exit");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).not.toThrow();
    untouched(f.databasePath);
  });

  it("without a boot record of the previous daemon it refuses before any write", async () => {
    const f = fixture({ receipts: { ravi: null } });
    await expect(adoptThreadFenceAtBoot(f.host)).rejects.toThrow("left no boot record");
    expect(existsSync(join(maintenanceDir(f.stateDir), "interlock"))).toBe(false);
    untouched(f.databasePath);
  });

  it("adopts when an update removed the channel runner launcher, and leaves its start to the update", async () => {
    const f = fixture({ channels: null });
    expect(await adoptThreadFenceAtBoot(f.host)).toMatchObject({ outcome: "adopted", channelsStarted: false });
    expect(f.stops).toEqual([]);
  });

  it("a runner the operator stopped stays stopped", async () => {
    const f = fixture({ channels: { online: false, pid: 0, status: "stopped" } });
    expect(await adoptThreadFenceAtBoot(f.host)).toMatchObject({ outcome: "adopted", channelsStarted: false });
    expect(f.starts).toEqual([]);
  });

  it("an unreachable broker refuses before the interlock; the next start retries", async () => {
    const f = fixture({ brokerReady: false });
    await expect(adoptThreadFenceAtBoot(f.host)).rejects.toThrow("broker is unreachable");
    expect(existsSync(join(maintenanceDir(f.stateDir), "interlock"))).toBe(false);
    expect(f.stops).toEqual([]);
    untouched(f.databasePath);
  });

  it("only a PM2-supervised daemon adopts", async () => {
    const f = fixture();
    const foreground = { ...f.host, self: { pid: exitedPid(), startedAt: Date.now() } };
    await expect(adoptThreadFenceAtBoot(foreground)).rejects.toThrow("supervised by PM2");
    untouched(f.databasePath);
  });
});

describe("recorded process exit", () => {
  it("is exited when the process started before the current OS boot, whatever owns the pid now", () => {
    expect(recordedProcessExitState({ pid: process.pid, startedAt: 1_000 })).toBe("exited");
    expect(recordedProcessExitState({ pid: process.pid, startedAt: Date.now() })).toBe("present");
    expect(recordedProcessExitState({ pid: exitedPid(), startedAt: Date.now() })).toBe("exited");
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { admitDaemonEntry, type MaintenanceProcess } from "../runtime-maintenance.js";
import {
  type AdoptionHost,
  databaseHasThreadFence,
  type ManagedRegistration,
  prepareThreadFenceAdoption,
  successorOutcome,
} from "./fence-adoption.js";
import { adoptThreadFenceAtEntry, liveResidue } from "./fence-adoption-live.js";
import { collectSqliteResidue, legacyBridgeDatabasePath, legacyResidueRules } from "./fence-adoption-residue.js";

/** ravi.db of v3.261113.2, generated from the tag (see the fixture header); never a production copy. */
const LEGACY_SCHEMA = readFileSync(join(import.meta.dir, "fixtures", "v3.261113.2-ravi-db.schema.sql"), "utf8");
const LEGACY_BRIDGE_SCHEMA = readFileSync(
  join(import.meta.dir, "fixtures", "v3.261113.2-bridge-db.schema.sql"),
  "utf8",
);

const roots: string[] = [];
afterEach(() => {
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

const digestOf = (path: string) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // no-cause: An unreadable fixture bundle is reported as uncertifiable, like the real probe.
    return null;
  }
};

function legacyState() {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-glue-"));
  roots.push(stateDir);
  const databasePath = join(stateDir, "ravi.db");
  const legacy = new Database(databasePath, { create: true });
  legacy.exec(LEGACY_SCHEMA);
  legacy.exec("PRAGMA journal_mode = WAL");
  mkdirSync(join(stateDir, "human-bridge"));
  const bridge = new Database(legacyBridgeDatabasePath(databasePath), { create: true });
  bridge.exec(LEGACY_BRIDGE_SCHEMA);
  bridge.close();
  legacy.close();
  mkdirSync(join(stateDir, "bundle"));
  const bundlePath = join(stateDir, "bundle", "index.js");
  writeFileSync(bundlePath, "// target release\n");
  const predecessors: MaintenanceProcess[] = [
    { name: "ravi", pid: exitedPid(), startedAt: 1_000, bundleSha256: "b".repeat(64) },
    { name: "ravi-channels", pid: exitedPid(), startedAt: 1_001, bundleSha256: "b".repeat(64) },
  ];
  const online: Record<string, boolean> = { ravi: true, "ravi-channels": true };
  const pid: Record<string, number> = { ravi: predecessors[0]!.pid, "ravi-channels": predecessors[1]!.pid };
  const startedAt: Record<string, number> = { ravi: 1_000, "ravi-channels": 1_001 };
  const registry = (): ManagedRegistration[] =>
    (["ravi", "ravi-channels"] as const).map((name) => ({
      name,
      pid: online[name] ? pid[name]! : 0,
      startedAt: startedAt[name]!,
      online: online[name]!,
      scriptPath: bundlePath,
    }));
  const host: AdoptionHost = {
    stateDir,
    databasePath,
    registry,
    bootIdentity: (registration) =>
      predecessors.find((entry) => entry.name === registration.name && entry.pid === registration.pid) ?? null,
    bundleDigest: digestOf,
    stop: async (name) => {
      online[name] = false;
    },
    residue: () =>
      liveResidue(databasePath, (use) =>
        use({
          streamMessages: async (stream) =>
            stream === "SESSION_PROMPTS" ? 0 : stream === "CHANNEL_OUTBOUND" ? 2 : null,
          consumerPending: async () => ({ pending: 0, ackPending: 0 }),
        }),
      ),
    wait: async () => {},
    exitChecks: 3,
  };
  const startSuccessor = () => {
    online.ravi = true;
    pid.ravi = process.pid;
    startedAt.ravi = 2_000;
  };
  return { stateDir, databasePath, bundlePath, registry, host, startSuccessor };
}

describe("fence adoption glue on the real v3.261113.2 schema", () => {
  it("every residue rule reads a real legacy table and column", () => {
    const { databasePath } = legacyState();
    const residue = collectSqliteResidue(legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath)));
    expect(residue.unknown).toEqual([]);
    // Unverified rules are searched in every database (labelled db:table); only explicit rules must find their table here.
    for (const source of residue.sources.filter((entry) => !entry.source.includes(":"))) {
      expect(source.detail).not.toMatchObject({ table: "absent" });
      expect(source.detail).not.toMatchObject({ database: "absent" });
    }
    expect(residue.sources.map((source) => source.source)).toEqual(
      expect.arrayContaining([
        "channel_outbound_publish_jobs.status",
        "cloud_agent_task_runs.state",
        "cloud_agent_task_dispatches.state",
        "session_followup_runs.status",
        "turns.status",
      ]),
    );
  });

  it("owned residue is carried, unverified non-terminal rows block, bridge turns follow the active index", () => {
    const { databasePath } = legacyState();
    const bridge = new Database(legacyBridgeDatabasePath(databasePath));
    bridge.exec(
      "INSERT INTO turns (id, conversation_id, status, lease_until, authority, created_at) VALUES ('t1', 'c1', 'completed', 0, 'x', 0), ('t2', 'c2', 'running', 0, 'x', 0)",
    );
    bridge.close();
    const residue = collectSqliteResidue(legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath)));
    expect(residue.unknown).toEqual(["turns.status=running (1): resumption not verified"]);
  });

  it("entry admission, then the production fence (prepareRegisteredThreadFence) on the legacy schema", async () => {
    const f = legacyState();
    const legacy = new Database(f.databasePath);
    legacy.exec("INSERT INTO sync_outbox (id, status) SELECT 'kept', 'pending' WHERE 0");
    const before = (legacy.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number })
      .n;
    legacy.close();
    const adoption = await prepareThreadFenceAdoption(f.host, f.bundlePath);
    expect(adoption.phase).toBe("authorized");
    f.startSuccessor();
    const entry = {
      managed: () => ({ pid: process.pid, startedAt: 2_000 }),
      ownBundlePath: () => f.bundlePath,
      bundleDigest: digestOf,
      pid: process.pid,
    };
    // Supervised by something else than the `ravi` registration: refused.
    expect(() => admitDaemonEntry(f.stateDir, { ...entry, managed: () => ({ pid: 1, startedAt: 2_000 }) })).toThrow(
      "only a PM2-supervised successor may adopt",
    );
    expect(admitDaemonEntry(f.stateDir, entry)).toBe("successor");
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("pending");
    adoptThreadFenceAtEntry(f.stateDir, { registry: f.registry, bundleDigest: digestOf, pid: process.pid });
    expect(databaseHasThreadFence(f.databasePath)).toBe(true);
    expect(successorOutcome(f.stateDir, f.databasePath)).toBe("adopted");
    expect(admitDaemonEntry(f.stateDir, entry)).toBe("normal");
    const after = new Database(f.databasePath, { readonly: true });
    const tables = (after.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number })
      .n;
    after.close();
    // Only the fence tables are added; no legacy table is dropped.
    expect(tables).toBeGreaterThan(before);
  });

  it("the successor re-reads the SQLite residue itself and refuses unknown work the record did not show", async () => {
    const f = legacyState();
    await prepareThreadFenceAdoption(f.host, f.bundlePath);
    // Written after the coordinator's evidence: the successor must see it on its own.
    const legacy = new Database(f.databasePath);
    // decision_deliveries.status is free text in v3.261113.2: a value outside the rule is unknown.
    legacy.exec(
      "INSERT INTO decision_deliveries (id, decision_id, kind, revision, status, created_at) VALUES ('d1', 'x', 'answer', 1, 'zombie', 0)",
    );
    legacy.close();
    f.startSuccessor();
    const entry = {
      managed: () => ({ pid: process.pid, startedAt: 2_000 }),
      ownBundlePath: () => f.bundlePath,
      bundleDigest: digestOf,
      pid: process.pid,
    };
    expect(admitDaemonEntry(f.stateDir, entry)).toBe("successor");
    expect(() =>
      adoptThreadFenceAtEntry(f.stateDir, { registry: f.registry, bundleDigest: digestOf, pid: process.pid }),
    ).toThrow();
    expect(databaseHasThreadFence(f.databasePath)).toBe(false);
  });
});

describe("daemon entry order", () => {
  it("admission precedes schema ownership, which precedes the successor's fence, before any store opens", () => {
    const source = readFileSync(join(import.meta.dir, "..", "cli", "env.ts"), "utf8");
    const admission = source.indexOf("admitDaemonEntry()");
    const ownership = source.indexOf("acquireDaemonSchemaOwnership()");
    const adoption = source.indexOf("adoptThreadFenceAtEntry()");
    expect(admission).toBeGreaterThan(0);
    expect(ownership).toBeGreaterThan(admission);
    expect(adoption).toBeGreaterThan(ownership);
    expect(source).not.toMatch(/openStateDatabase|getDb\(|new Database\(/);
  });
});

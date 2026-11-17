import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  adoptionDryRun,
  adoptThreadFenceAtEntry,
  legacyStateDatabasePaths,
  liveResidue,
  previewLiveSqliteResidue,
} from "./fence-adoption-live.js";
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
      liveResidue(
        databasePath,
        (use) =>
          use({
            streamMessages: async (stream) =>
              stream === "SESSION_PROMPTS" ? 0 : stream === "CHANNEL_OUTBOUND" ? 2 : null,
            consumerPending: async () => ({ pending: 0, ackPending: 0 }),
          }),
        join(stateDir, "restart-reason.txt"),
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
    const residue = collectSqliteResidue(
      legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
    );
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

  it("bridge turns follow the active index and are closed or started by the successor's bridge", () => {
    const { databasePath } = legacyState();
    const bridge = new Database(legacyBridgeDatabasePath(databasePath));
    bridge.exec(
      "INSERT INTO turns (id, conversation_id, status, lease_until, authority, created_at) VALUES ('t1', 'c1', 'completed', 0, 'x', 0), ('t2', 'c2', 'running', 0, 'x', 0), ('t3', 'c3', 'awaiting_approval', 0, 'x', 0)",
    );
    bridge.close();
    const residue = collectSqliteResidue(
      legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
    );
    expect(residue.unknown).toEqual([]);
    expect(residue.sources.find((source) => source.source === "turns.status")).toMatchObject({ inFlight: 2 });
  });

  it("the adopt preview lists a queued handoff read only, with the legacy writer's connection open", () => {
    const { stateDir, databasePath, host, bundlePath } = legacyState();
    // The legacy runtime's connection stays open during the preview (WAL with -wal/-shm present).
    const writer = new Database(databasePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      // What sessions send --thread of the tag leaves when its process dies between the insert and the send.
      writer.exec(
        "INSERT INTO thread_handoffs (id, thread_id, target_session_key, brief_text, created_at, updated_at) VALUES ('h1', 'th1', 'agent:x', 'brief', 1, 1)",
      );
      const before = readdirSync(stateDir).sort();
      const preview = previewLiveSqliteResidue(databasePath);
      expect(preview.unknown).toEqual(["ravi.db:thread_handoffs.status=queued (1): resumption not verified"]);
      const source = preview.sources.find((entry) => entry.source === "ravi.db:thread_handoffs.status");
      expect(String((source?.detail as { owner?: string } | undefined)?.owner)).toContain(
        "the RUNBOOK settle step for this table",
      );
      // The CLI's dry-run payload: the plan plus this preview; nothing is taken or written.
      const dryRun = adoptionDryRun(host, bundlePath);
      expect(dryRun.residuePreview.unknown).toEqual(preview.unknown);
      expect(dryRun.predecessors.map((entry) => entry.name).sort()).toEqual(["ravi", "ravi-channels"]);
      expect(readdirSync(stateDir).sort()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("RUNBOOK: the resend of restart snapshots saves first, records deliveries, retries, waits for Daemon ready, and only then sends from the file", () => {
    // Text comparison: it pins the written order and wording of the recipe, not the behavior.
    const runbook = readFileSync(
      join(import.meta.dir, "..", "..", ".ravi", "specs", "quality", "state-boundary", "RUNBOOK.md"),
      "utf8",
    );
    const start = runbook.indexOf("When the snapshots block, the exit is these steps, in this order:");
    const end = runbook.indexOf("**PM2's kill timeout.**", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const recipe = runbook.slice(start, end);
    const at = (marker: string) => {
      const index = recipe.indexOf(marker);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    const save = at("(a) Save what will be sent again, read only, before any write.");
    const listing = at("LEFT JOIN json_each(COALESCE(s.pending_messages_json, '[]')) m");
    const deliveries = at("INSERT OR IGNORE INTO daemon_restart_resume_deliveries");
    // Ninth review: after (b) the file is the only carrier, the legacy included.
    const carrier = at("From here on `resend-<epoch>.json` is the only carrier of these messages.");
    const retry = at("(c) The next start adopts");
    const confirm = at("(d) Confirm the successor takes prompts before anything is sent.");
    const ready = at(
      "must show the line `Daemon ready` for this boot, that is, timestamped after the adopting start of (c)",
    );
    // Tenth review: the time is noted before the send, and the receipt is the session's own line.
    const noted = at("T=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)   # noted before sending");
    const send = at("xargs -0 -r -n 2 ravi sessions send -w --");
    const notExit = at("The receipt is the session's own record, not the exit code.");
    const anyTurn = at("`-w` only waits up to 120 s for a `turn.complete` of that session, of any turn");
    const readAlways = at("Whatever `-w` returned, read the session");
    const receipt = at('select(.role == "user" and (.createdAt // "") >= $since)');
    // Eleventh review: no line means wait and read again whatever `-w` returned, and at most two sends.
    const noLine = at("No line, whatever `-w` returned");
    const wait60 = at("So wait 60 s, the life of a prompt in `SESSION_PROMPTS`");
    const cap = at("An entry is never sent more than twice.");
    const abandon = at("(f) Abandon after (b), as a step and not as an exception");
    expect(
      save < listing &&
        listing < deliveries &&
        deliveries < carrier &&
        carrier < retry &&
        retry < confirm &&
        confirm < ready &&
        ready < noted &&
        noted < send &&
        send < notExit &&
        notExit < anyTurn &&
        anyTurn < readAlways &&
        readAlways < receipt &&
        receipt < noLine &&
        noLine < wait60 &&
        wait60 < cap &&
        cap < abandon,
    ).toBe(true);
    // The send refuses entries it cannot send instead of sending "null" or exiting 0.
    expect(recipe).toContain("halt_error(2)");
    expect(recipe).toContain("halt_error(3)");
    expect(recipe).not.toContain("The receipt for each entry is `-w`");
    // Nothing is sent before (e), and no message text is ever pasted between double quotes.
    expect(recipe.slice(0, send)).not.toContain("sessions send");
    expect(recipe).not.toMatch(/sessions send[^\n]*"<text>"/);
    expect(recipe).not.toContain("s, json_each(");
    // The legacy resume skips sessions with a delivery row: the window paragraph says so.
    expect(runbook).toContain(
      "except sessions with a delivery row: after step (b) of the resend below, that is every session in the file",
    );
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
    adoptThreadFenceAtEntry(f.stateDir, {
      registry: f.registry,
      bundleDigest: digestOf,
      pid: process.pid,
      restartReasonPath: join(f.stateDir, "restart-reason.txt"),
    });
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
      adoptThreadFenceAtEntry(f.stateDir, {
        registry: f.registry,
        bundleDigest: digestOf,
        pid: process.pid,
        restartReasonPath: join(f.stateDir, "restart-reason.txt"),
      }),
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

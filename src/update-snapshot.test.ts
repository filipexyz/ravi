import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireStateStoreOwnership,
  planUpdateSnapshot,
  probeReflink,
  restoreUpdateSnapshot,
  takeUpdateSnapshot,
  UPDATE_SNAPSHOT_SPACE,
  UpdateSnapshotRestoreError,
  updateSnapshotsDir,
  updateStorePaths,
} from "./update-snapshot.js";

const roots: string[] = [];

function makeStateDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-update-snapshot-")));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeRows(path: string, rows: string[]): void {
  const database = new Database(path, { create: true });
  try {
    database.run("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    for (const row of rows) database.run("INSERT INTO t (v) VALUES (?)", [row]);
  } finally {
    database.close();
  }
}

function readRows(path: string): string[] {
  const database = new Database(path, { readonly: true });
  try {
    return (database.query("SELECT v FROM t ORDER BY rowid").all() as { v: string }[]).map((row) => row.v);
  } finally {
    database.close();
  }
}

const MiB = 1024 * 1024;

describe("update snapshot plan", () => {
  it("does not count a kept snapshot as room: a disk that holds one copy refuses the second", () => {
    const GiB = 1024 * MiB;
    const stateDir = makeStateDir();
    const store = join(stateDir, "ravi.db");
    // Sparse files: the sizes the plan reads, without the disk.
    writeFileSync(store, "");
    truncateSync(store, 3 * GiB);
    const kept = "20261120T000000Z-abcdef";
    const keptFile = join(updateSnapshotsDir(stateDir), kept, "files", "0-ravi.db");
    mkdirSync(dirname(keptFile), { recursive: true });
    writeFileSync(keptFile, "");
    truncateSync(keptFile, 3 * GiB);

    // Without a kept snapshot the earlier one is pruned before the copy, so it is room: 0.5 + 3 GiB.
    const pruned = planUpdateSnapshot({ stateDir, stores: [store], reflink: () => false, free: () => GiB / 2 });
    expect(pruned.reclaimableBytes).toBe(3 * GiB);
    // The second pass of a waypoint keeps it: 0.5 GiB free cannot hold another 3 GiB copy.
    let refusal: unknown;
    try {
      planUpdateSnapshot({ stateDir, stores: [store], reflink: () => false, free: () => GiB / 2, keep: kept });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string }).code).toBe(UPDATE_SNAPSHOT_SPACE);
  });

  it("needs only a margin for clones and refuses a full copy that does not fit, before anything stops", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["state"]);

    const clone = planUpdateSnapshot({ stateDir, stores, reflink: () => true, free: () => 300 * MiB });
    expect(clone.method).toBe("reflink");
    expect(clone.copyBytes).toBe(0);
    expect(clone.requiredBytes).toBe(256 * MiB);

    const copy = planUpdateSnapshot({ stateDir, stores, reflink: () => false, free: () => 10_000 * MiB });
    expect(copy.method).toBe("copy");
    expect(copy.copyBytes).toBe(copy.bytes);
    expect(copy.bytes).toBeGreaterThan(0);

    let refusal: unknown;
    try {
      planUpdateSnapshot({ stateDir, stores, reflink: () => false, free: () => 1_024 });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string }).code).toBe(UPDATE_SNAPSHOT_SPACE);
    expect((refusal as Error).message).toContain("Nothing was stopped");
  });

  it("counts an earlier snapshot as space it frees", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["state"]);
    const earlier = join(updateSnapshotsDir(stateDir), "20260101T000000Z-abcdef", "files");
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "0-ravi.db"), Buffer.alloc(4_096));
    const required = planUpdateSnapshot({
      stateDir,
      stores,
      reflink: () => false,
      free: () => 10_000 * MiB,
    }).requiredBytes;

    expect(
      planUpdateSnapshot({ stateDir, stores, reflink: () => false, free: () => required - 4_096 }).reclaimableBytes,
    ).toBe(4_096);
    expect(() => planUpdateSnapshot({ stateDir, stores, reflink: () => false, free: () => required - 4_097 })).toThrow(
      UPDATE_SNAPSHOT_SPACE,
    );
  });
});

describe("update snapshot and restore", () => {
  it("keeps committed WAL frames, restores the previous state and moves the target's files aside", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    const [ravi, chat] = stores as [string, string];
    const insights = stores[3]!;
    writeRows(chat, ["chat before"]);
    // A store whose last writer left committed frames in the WAL (a killed process).
    const writer = new Database(ravi, { create: true });
    writer.run("PRAGMA journal_mode=WAL");
    writer.run("PRAGMA wal_autocheckpoint=0");
    writer.run("CREATE TABLE t (v TEXT)");
    writer.run("INSERT INTO t (v) VALUES ('before')");
    expect(existsSync(`${ravi}-wal`)).toBe(true);

    const manifest = takeUpdateSnapshot({
      stateDir,
      stores,
      method: "copy",
      previousRelease: "3.1.0",
      targetRelease: "3.2.0",
    });
    expect(manifest.files.map((file) => file.name)).toEqual(["0-ravi.db", "0-ravi.db-wal", "1-chat.db"]);

    // The target writes, and creates a store the previous release never had.
    writer.run("INSERT INTO t (v) VALUES ('target')");
    writer.close();
    writeRows(chat, ["chat target"]);
    writeRows(insights, ["created by the target"]);

    const restored = restoreUpdateSnapshot({ stateDir, manifest });
    expect(readRows(ravi)).toEqual(["before"]);
    expect(readRows(chat)).toEqual(["chat before"]);
    expect(existsSync(insights)).toBe(false);
    // Nothing the target wrote is deleted.
    expect(readRows(join(restored.candidateDir, "0-ravi.db"))).toEqual(["before", "target"]);
    expect(readRows(join(restored.candidateDir, "3-insights.db"))).toEqual(["created by the target"]);
    const journal = JSON.parse(
      readFileSync(join(updateSnapshotsDir(stateDir), manifest.id, "restore.json"), "utf8"),
    ) as { phase: string };
    expect(journal.phase).toBe("restored");

    // A second restore would move the restored state aside: refused.
    expect(() => restoreUpdateSnapshot({ stateDir, manifest })).toThrow("already restored");
    expect(readRows(ravi)).toEqual(["before"]);
  });

  it("moves nothing when a snapshot file is missing", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["before"]);
    const manifest = takeUpdateSnapshot({
      stateDir,
      stores,
      method: "copy",
      previousRelease: "3.1.0",
      targetRelease: "3.2.0",
    });
    writeRows(stores[0]!, ["target"]);
    rmSync(join(updateSnapshotsDir(stateDir), manifest.id, "files", "0-ravi.db"));

    expect(() => restoreUpdateSnapshot({ stateDir, manifest })).toThrow("nothing was restored");
    expect(readRows(stores[0]!)).toEqual(["before", "target"]);
  });

  it("keeps only the latest snapshot", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["state"]);
    const take = (now: string) =>
      takeUpdateSnapshot({
        stateDir,
        stores,
        method: "copy",
        previousRelease: "3.1.0",
        targetRelease: "3.2.0",
        now: () => new Date(now),
      });
    take("2026-11-19T10:00:00Z");
    const latest = take("2026-11-19T11:00:00Z");
    expect(readdirSync(updateSnapshotsDir(stateDir))).toEqual([latest.id]);
  });

  it("clones on a filesystem that supports it", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["state"]);
    if (!probeReflink(updateSnapshotsDir(stateDir))) return;
    const manifest = takeUpdateSnapshot({
      stateDir,
      stores,
      method: "reflink",
      previousRelease: "3.1.0",
      targetRelease: "3.2.0",
    });
    const copy = join(updateSnapshotsDir(stateDir), manifest.id, "files", "0-ravi.db");
    expect(readFileSync(copy)).toEqual(readFileSync(stores[0]!));
  });
});

describe("state store ownership", () => {
  it("is refused while a daemon holds its schema lock, and granted once it is gone", async () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    const holder = spawn(
      [
        process.execPath,
        "-e",
        `import { acquireSchemaFileLock } from ${JSON.stringify(join(import.meta.dir, "db", "schema-lock.ts"))};
acquireSchemaFileLock(${JSON.stringify(join(stateDir, "daemon-schema-owner.lock"))}, 0);
console.log("held");
await Bun.sleep(30_000);`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = holder.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("held");
      expect(() => acquireStateStoreOwnership(stateDir, stores, 100)).toThrow("STATE_SCHEMA_BUSY");
    } finally {
      holder.kill();
      await holder.exited;
    }
    const lease = acquireStateStoreOwnership(stateDir, stores, 5_000);
    lease.release();
  });
});

/** ravi.db and the human bridge store, each with a row before the snapshot and one the target wrote after it. */
function twoStores() {
  const stateDir = makeStateDir();
  const stores = updateStorePaths(stateDir, {});
  const ravi = stores[0]!;
  const bridge = stores.find((store) => store.includes("human-bridge"))!;
  mkdirSync(dirname(bridge), { recursive: true });
  writeRows(ravi, ["before"]);
  writeRows(bridge, ["bridge before"]);
  const manifest = takeUpdateSnapshot({
    stateDir,
    stores,
    method: "copy",
    previousRelease: "3.1.0",
    targetRelease: "3.2.0",
  });
  writeRows(ravi, ["target"]);
  writeRows(bridge, ["bridge target"]);
  return { stateDir, stores, ravi, bridge, manifest, index: stores.indexOf(bridge) };
}

/** Runs `run` with `directory` read-only (a cut that stands for EIO or EACCES), and returns what it threw. */
function failureWithReadOnly(directory: string, run: () => void): unknown {
  chmodSync(directory, 0o555);
  try {
    run();
    return null;
  } catch (error) {
    return error;
  } finally {
    chmodSync(directory, 0o755);
  }
}

describe("update snapshot restore that stops", () => {
  it("leaves no store missing, records every move, and gives commands that finish it", () => {
    const { stateDir, ravi, bridge, manifest } = twoStores();
    const failure = failureWithReadOnly(dirname(bridge), () => restoreUpdateSnapshot({ stateDir, manifest }));

    expect(failure).toBeInstanceOf(UpdateSnapshotRestoreError);
    // The store before the stop is restored, and the one it stopped at is still the target's: none is missing.
    expect(readRows(ravi)).toEqual(["before"]);
    expect(readRows(bridge)).toEqual(["bridge before", "bridge target"]);
    const journal = JSON.parse(readFileSync(join(updateSnapshotsDir(stateDir), manifest.id, "restore.json"), "utf8"));
    expect(journal.phase).toBe("cut-short");
    const moves = journal.moves as Array<{ from: string; to: string; done: boolean }>;
    expect(moves.find((move) => move.to === ravi)?.done).toBe(true);
    expect(moves.find((move) => move.from === bridge)?.done).toBe(false);
    // The commands finish the restore as written.
    const commands = (failure as UpdateSnapshotRestoreError).commands;
    expect(commands.length).toBeGreaterThan(0);
    const finish = spawnSync("sh", ["-c", commands.join(" && ")], { encoding: "utf8" });
    expect(finish.status).toBe(0);
    expect(readRows(bridge)).toEqual(["bridge before"]);
    expect(readRows(ravi)).toEqual(["before"]);
  });

  it("stages a store on another disk next to it first: a staging failure moves nothing", () => {
    const { stateDir, ravi, bridge, manifest, index } = twoStores();
    // The human bridge directory stands for a store on another disk.
    const device = (path: string) => (path.includes("human-bridge") ? 2 : 1);
    const failure = failureWithReadOnly(dirname(bridge), () => restoreUpdateSnapshot({ stateDir, manifest, device }));

    expect(failure).toBeInstanceOf(UpdateSnapshotRestoreError);
    expect((failure as Error).message).toContain("Nothing was moved");
    expect(readRows(ravi)).toEqual(["before", "target"]);
    expect(existsSync(join(updateSnapshotsDir(stateDir), manifest.id, "restore.json"))).toBe(false);

    // With room next to it, the same restore goes through, by renames on each disk.
    restoreUpdateSnapshot({ stateDir, manifest, device });
    expect(readRows(ravi)).toEqual(["before"]);
    expect(readRows(bridge)).toEqual(["bridge before"]);
    const aside = join(dirname(bridge), `.ravi-update-candidate-${manifest.id}`);
    expect(readdirSync(aside)).toContain(`${index}-bridge.db`);
    expect(readdirSync(dirname(bridge)).filter((entry) => entry.startsWith(".ravi-update-restore-"))).toEqual([]);
  });
});

describe("update snapshot plan across disks and clones", () => {
  it("refuses before any stop when a store on another disk has no room for its restore", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    const bridge = stores.find((store) => store.includes("human-bridge"))!;
    mkdirSync(dirname(bridge), { recursive: true });
    writeRows(bridge, ["x"]);
    const device = (path: string) => (path.includes("human-bridge") ? 2 : 1);

    const plan = planUpdateSnapshot({ stateDir, stores, reflink: () => false, free: () => 10 * 1024 * MiB, device });
    expect(plan.restoreSpace).toHaveLength(1);
    expect(plan.restoreSpace[0]).toMatchObject({ directory: dirname(bridge), freeBytes: 10 * 1024 * MiB });
    expect(() =>
      planUpdateSnapshot({
        stateDir,
        stores,
        reflink: () => false,
        free: (directory) => (directory.includes("human-bridge") ? MiB : 10 * 1024 * MiB),
        device,
      }),
    ).toThrow(`free in ${dirname(bridge)}`);
  });

  it("does not count an earlier clone as free space", () => {
    const stateDir = makeStateDir();
    const stores = updateStorePaths(stateDir, {});
    writeRows(stores[0]!, ["x"]);
    // An earlier snapshot of 300 MiB (a sparse file here): a clone shares its blocks with the live stores.
    const earlier = join(updateSnapshotsDir(stateDir), "20261118T000000Z-aaaaaa", "files");
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "0-ravi.db"), "");
    truncateSync(join(earlier, "0-ravi.db"), 300 * MiB);
    const plan = (reflink: boolean) =>
      planUpdateSnapshot({ stateDir, stores, reflink: () => reflink, free: () => 100 * MiB });

    expect(() => plan(true)).toThrow(UPDATE_SNAPSHOT_SPACE);
    expect(plan(false).availableBytes).toBe(400 * MiB);
  });
});

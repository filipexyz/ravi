import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStateStoreOwnership,
  planUpdateSnapshot,
  probeReflink,
  restoreUpdateSnapshot,
  takeUpdateSnapshot,
  UPDATE_SNAPSHOT_SPACE,
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

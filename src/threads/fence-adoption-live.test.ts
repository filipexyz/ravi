import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase } from "../db/state-boundary.js";
import { adoptThreadFenceOnUpgrade, liveBootIdentity, managedRaviSnapshot } from "./fence-adoption-live.js";
import type { Pm2Process } from "../pm2.js";
import { prepareThreadFence } from "./schema-fence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateWithReceipt(receipt: Record<string, unknown>): string {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-adoption-live-"));
  roots.push(stateDir);
  mkdirSync(join(stateDir, "runtime-processes"));
  writeFileSync(join(stateDir, "runtime-processes", `${receipt.name}.json`), JSON.stringify(receipt));
  return stateDir;
}

// Shape written by recordManagedRuntimeBoot in 3.261113.2 (schemaVersion 1).
const legacyReceipt = {
  schemaVersion: 1,
  name: "ravi-channels",
  pid: 4242,
  startedAt: 1_700_000_000_000,
  runningVersion: "3.261113.2",
  bundlePath: "/opt/ravi/dist/bundle/index.js",
  bundle: { mtimeMs: 1, size: 10, ino: 7, sha256: "c".repeat(64) },
  envFile: "/opt/ravi/.env",
  env: null,
  capturedAt: 1_700_000_000_500,
};
const registration = {
  name: "ravi-channels",
  pid: 4242,
  startedAt: 1_700_000_000_000,
  online: true,
  scriptPath: "/opt/ravi/dist/bundle/index.js",
};

describe("live legacy boot identity", () => {
  it("reads the legacy receipt matched by pid and start time", () => {
    const stateDir = stateWithReceipt(legacyReceipt);
    expect(liveBootIdentity(registration, stateDir)).toEqual({
      name: "ravi-channels",
      pid: 4242,
      startedAt: 1_700_000_000_000,
      bundleSha256: "c".repeat(64),
    });
  });

  it("a receipt from another incarnation or without a certified bundle proves nothing", () => {
    const stateDir = stateWithReceipt(legacyReceipt);
    expect(liveBootIdentity({ ...registration, startedAt: 1_700_000_000_001 }, stateDir)).toBeNull();
    expect(liveBootIdentity({ ...registration, pid: 4243 }, stateDir)).toBeNull();
    expect(liveBootIdentity({ ...registration, name: "nats" }, stateDir)).toBeNull();
    const uncertified = stateWithReceipt({ ...legacyReceipt, bundle: null });
    expect(liveBootIdentity(registration, uncertified)).toBeNull();
  });
});

describe("live daemon entry on a new isolated state directory", () => {
  const isolated = () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-entry-"));
    roots.push(stateDir);
    return stateDir;
  };

  it("a daemon in the foreground starts: the entry creates nothing and the stores initialize the database", async () => {
    const stateDir = isolated();
    const databasePath = join(stateDir, "ravi.db");
    // PM2 does not report this process as `ravi`: the development foreground run.
    expect(await adoptThreadFenceOnUpgrade(stateDir, () => undefined)).toEqual({ outcome: "not-needed" });
    expect(existsSync(databasePath)).toBe(false);
    const db = openStateDatabase(databasePath);
    try {
      prepareThreadFence(db);
    } finally {
      db.close();
    }
    const audit = readFileSync(`${databasePath}.thread-bootstrap.jsonl`, "utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(audit)).toMatchObject({ reason: "empty-isolated-state" });
  });

  it("an orphan write-ahead log refuses the entry and nothing creates the database", async () => {
    const stateDir = isolated();
    const databasePath = join(stateDir, "ravi.db");
    writeFileSync(`${databasePath}-wal`, "frames");
    await expect(adoptThreadFenceOnUpgrade(stateDir, () => undefined)).rejects.toThrow(
      "-wal exists without its database",
    );
    expect(existsSync(databasePath)).toBe(false);
  });

  it("a dangling link left as the write-ahead log also refuses the entry", async () => {
    const stateDir = isolated();
    const databasePath = join(stateDir, "ravi.db");
    symlinkSync(join(stateDir, "gone"), `${databasePath}-wal`);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    await expect(adoptThreadFenceOnUpgrade(stateDir, () => undefined)).rejects.toThrow(
      "-wal exists without its database",
    );
    expect(existsSync(databasePath)).toBe(false);
  });
});

describe("the PM2 registration the daemon entry trusts", () => {
  const ravi = { name: "ravi", pid: 4242, status: "online", startedAt: 1 } as Pm2Process;

  it("a process PM2 did not start is in the foreground and reads nothing from PM2", () => {
    let listed = false;
    expect(
      managedRaviSnapshot({}, () => {
        listed = true;
        return [ravi];
      }),
    ).toBeUndefined();
    expect(listed).toBe(false);
  });

  it("under PM2 the snapshot is strict: unreadable refuses instead of passing for the foreground", () => {
    expect(() =>
      managedRaviSnapshot({ pm_id: "3" }, () => {
        throw new Error("Unable to read the managed PM2 processes");
      }),
    ).toThrow("Unable to read the managed PM2 processes");
    expect(managedRaviSnapshot({ pm_id: "3" }, () => [ravi])).toEqual(ravi);
  });
});

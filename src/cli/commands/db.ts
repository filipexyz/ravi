/**
 * DB Commands - Inspection of ravi.db state, locks and WAL.
 */

import "reflect-metadata";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Arg, Command, CliOnly, Group, Option, Scope } from "../decorators.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { join } from "node:path";

interface ProcessHolder {
  pid: number;
  command: string;
  uptime: string;
  cpu?: string;
}

interface LockProbe {
  acquired: boolean;
  elapsedMs: number;
  error?: string;
}

interface DbLockSnapshot {
  dbPath: string;
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  holders: ProcessHolder[];
  writeLockProbe: LockProbe;
  pragma: {
    journalMode: string;
    busyTimeoutMs: number;
    walAutocheckpointPages: number;
  };
  pendingCheckpointPages?: number;
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function listDbHolders(dbPath: string): ProcessHolder[] {
  let raw: string;
  try {
    raw = execFileSync("lsof", ["-F", "pcn", dbPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const holders: ProcessHolder[] = [];
  let current: Partial<ProcessHolder> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (current.pid !== undefined) holders.push(current as ProcessHolder);
      current = { pid: Number(value) };
    } else if (tag === "c") {
      current.command = value;
    }
  }
  if (current.pid !== undefined) holders.push(current as ProcessHolder);

  for (const holder of holders) {
    try {
      const ps = execFileSync("ps", ["-o", "etime=,pcpu=", "-p", String(holder.pid)], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      holder.uptime = ps[0] ?? "?";
      holder.cpu = ps[1] ?? "?";
    } catch {
      holder.uptime = "?";
    }
  }
  return holders;
}

function probeWriteLock(dbPath: string, timeoutMs: number): LockProbe {
  const start = Date.now();
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec(`PRAGMA busy_timeout = ${Math.max(timeoutMs, 100)}`);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { acquired: true, elapsedMs: Date.now() - start };
  } catch (err) {
    return {
      acquired: false,
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function readPragmas(dbPath: string): DbLockSnapshot["pragma"] & { pendingCheckpointPages?: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const busy = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    const autocheckpoint = (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
      .wal_autocheckpoint;
    return {
      journalMode,
      busyTimeoutMs: busy,
      walAutocheckpointPages: autocheckpoint,
    };
  } finally {
    db.close();
  }
}

function buildSnapshot(dbPath: string, probeTimeoutMs: number): DbLockSnapshot {
  const dbBytes = fileSize(dbPath);
  const walBytes = fileSize(`${dbPath}-wal`);
  const shmBytes = fileSize(`${dbPath}-shm`);
  const holders = listDbHolders(dbPath);
  const pragma = readPragmas(dbPath);
  const writeLockProbe = probeWriteLock(dbPath, probeTimeoutMs);
  return {
    dbPath,
    dbBytes,
    walBytes,
    shmBytes,
    holders,
    writeLockProbe,
    pragma,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)}K`;
  return `${bytes}B`;
}

function printSnapshot(snap: DbLockSnapshot): void {
  console.log(`DB: ${snap.dbPath}`);
  console.log(`  size: ${formatBytes(snap.dbBytes)}`);
  console.log(`  WAL:  ${formatBytes(snap.walBytes)} ${snap.walBytes > 50 * 1024 ** 2 ? "⚠ checkpoint pendente" : ""}`);
  console.log(`  SHM:  ${formatBytes(snap.shmBytes)}`);
  console.log("");
  console.log(`Pragmas:`);
  console.log(`  journal_mode:        ${snap.pragma.journalMode}`);
  console.log(`  busy_timeout:        ${snap.pragma.busyTimeoutMs}ms`);
  console.log(`  wal_autocheckpoint:  ${snap.pragma.walAutocheckpointPages} pages`);
  console.log("");
  console.log(`Write lock probe (BEGIN IMMEDIATE):`);
  if (snap.writeLockProbe.acquired) {
    console.log(`  ✓ acquired in ${snap.writeLockProbe.elapsedMs}ms (no contention)`);
  } else {
    console.log(`  ✗ FAILED after ${snap.writeLockProbe.elapsedMs}ms — ${snap.writeLockProbe.error}`);
    console.log(`    (lock contention detected — see holders below)`);
  }
  console.log("");
  console.log(`Holders (${snap.holders.length} processes with DB open):`);
  if (snap.holders.length === 0) {
    console.log(`  (none)`);
  } else {
    for (const h of snap.holders) {
      console.log(`  PID ${h.pid}  ${h.command.padEnd(20)} uptime=${h.uptime} cpu=${h.cpu ?? "?"}%`);
    }
  }
}

@Group({
  name: "db",
  description: "Inspect ravi.db state (locks, WAL, holders)",
})
export class DbCommands {
  @Scope("superadmin")
  @Command({ name: "locks", description: "Snapshot of ravi.db locks, WAL state and process holders" })
  @CliOnly()
  async locks(
    @Option({ flags: "--probe-ms <n>", description: "Write-lock probe timeout (default: 1000ms)" })
    probeMs?: string,
    @Option({ flags: "--checkpoint", description: "Force WAL checkpoint after probe (PASSIVE)" })
    checkpoint?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<DbLockSnapshot> {
    const dbPath = join(getRaviStateDir(), "ravi.db");
    if (!existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }
    const probeTimeoutMs = Math.max(100, Number(probeMs ?? "1000"));
    const snap = buildSnapshot(dbPath, probeTimeoutMs);

    if (checkpoint) {
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const result = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
          busy: number;
          log: number;
          checkpointed: number;
        };
        snap.pendingCheckpointPages = result.log - result.checkpointed;
      } finally {
        db.close();
      }
    }

    if (asJson) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      printSnapshot(snap);
      if (snap.pendingCheckpointPages !== undefined) {
        console.log("");
        console.log(`Checkpoint: ${snap.pendingCheckpointPages} WAL pages still pending`);
      }
    }
    return snap;
  }

  @Scope("superadmin")
  @Command({ name: "probe", description: "Quick write-lock probe (lighter than `locks`)" })
  @CliOnly()
  async probe(
    @Arg("timeoutMs", { description: "Probe timeout in ms", required: false }) timeoutArg?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<LockProbe> {
    const dbPath = join(getRaviStateDir(), "ravi.db");
    const timeoutMs = Math.max(100, Number(timeoutArg ?? "1000"));
    const result = probeWriteLock(dbPath, timeoutMs);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.acquired) {
      console.log(`✓ Write lock acquired in ${result.elapsedMs}ms`);
    } else {
      console.log(`✗ Write lock FAILED after ${result.elapsedMs}ms`);
      console.log(`  ${result.error}`);
    }
    return result;
  }
}

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { acquireSchemaFileLock, schemaDatabaseLockPath, SchemaLockBusyError } from "./schema-lock.js";
import { assertDatabaseTargetAllowed, canonicalStatePath, isSchemaConsumer } from "./state-boundary.js";
import { runtimeStateDatabasePaths } from "./state-paths.js";

export type DaemonSchemaPhase = "waiting" | "owned" | "ready";
type Receipt = { protocol: 1; pid: number; phase: DaemonSchemaPhase; observedAt: number };
let ownerRoot: string | undefined;
let ownerPaths: string[] | undefined;

function receiptPath(stateDir: string, pid: number): string {
  return join(stateDir, "runtime-processes", `schema-owner-${pid}.json`);
}

function writePhase(root: string, phase: DaemonSchemaPhase): void {
  const destination = receiptPath(root, process.pid);
  mkdirSync(join(root, "runtime-processes"), { recursive: true, mode: 0o700 });
  const receipt: Receipt = { protocol: 1, pid: process.pid, phase, observedAt: Date.now() };
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, destination);
}

/**
 * Run before the command graph can open a DB, and also at programmatic startup.
 * No TTL or stale-PID deletion: a stopped owner retains the kernel lock. Only
 * process exit releases daemon ownership, after its final possible DB write.
 */
export function acquireDaemonSchemaOwnership(stateDir = getRaviStateDir()): void {
  if (isSchemaConsumer()) throw new Error("Channel consumers cannot acquire daemon schema ownership");
  const root = canonicalStatePath(stateDir);
  const paths = runtimeStateDatabasePaths({ ...process.env, RAVI_STATE_DIR: root }).map((path) =>
    canonicalStatePath(path),
  );
  // Provenance before any coordination file/directory write. A lock is not an
  // authorization bypass for a source checkout or a consumer process.
  for (const path of paths) assertDatabaseTargetAllowed(path);
  if (ownerRoot) {
    if (ownerRoot !== root || JSON.stringify(ownerPaths) !== JSON.stringify(paths)) {
      throw new Error("Daemon state paths changed after schema ownership acquisition");
    }
    return;
  }
  const lockPaths = [...new Set([join(root, "daemon-schema-owner.lock"), ...paths.map(schemaDatabaseLockPath)])].sort();
  const acquired: Array<{ release(): void }> = [];
  const deadline = performance.now() + 60_000;
  try {
    for (const lockPath of lockPaths) {
      try {
        acquired.push(acquireSchemaFileLock(lockPath, 0));
      } catch (cause) {
        if (!(cause instanceof SchemaLockBusyError)) throw cause;
        // A waiting receipt proves this runtime reached the kernel lock gate.
        writePhase(root, "waiting");
        acquired.push(acquireSchemaFileLock(lockPath, Math.max(0, deadline - performance.now())));
      }
    }
  } catch (cause) {
    for (const lock of acquired.reverse()) lock.release();
    throw cause;
  }
  ownerRoot = root;
  ownerPaths = paths;
  writePhase(root, "owned");
}

export function markDaemonSchemaReady(): void {
  if (!ownerRoot || ownerRoot !== realpathSync(getRaviStateDir()))
    throw new Error("Daemon does not own this state root");
  acquireDaemonSchemaOwnership();
  writePhase(ownerRoot, "ready");
}

/** A receipt is evidence of phase, never authority to write or bypass a lock. */
export function readDaemonSchemaPhase(
  candidate: { pid: number; startedAt?: number },
  stateDir = getRaviStateDir(),
): DaemonSchemaPhase | null {
  if (!candidate.startedAt || candidate.pid <= 0) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(stateDir, candidate.pid), "utf8")) as Receipt;
    if (
      receipt.protocol !== 1 ||
      receipt.pid !== candidate.pid ||
      !Number.isFinite(receipt.observedAt) ||
      receipt.observedAt < candidate.startedAt ||
      !["waiting", "owned", "ready"].includes(receipt.phase)
    )
      return null;
    return receipt.phase;
  } catch {
    // no-cause: Missing/invalid phase evidence cannot certify this PM2 process.
    return null;
  }
}

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { acquireSchemaFileLock, SchemaLockBusyError } from "./schema-lock.js";

export type DaemonSchemaPhase = "waiting" | "owned" | "ready";
type Receipt = { protocol: 1; pid: number; phase: DaemonSchemaPhase; observedAt: number };
let ownerRoot: string | undefined;

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
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(stateDir);
  if (ownerRoot) {
    if (ownerRoot !== root) throw new Error("Daemon state root changed after schema ownership acquisition");
    return;
  }
  const lockPath = join(root, "daemon-schema-owner.lock");
  try {
    acquireSchemaFileLock(lockPath, 0);
  } catch (cause) {
    if (!(cause instanceof SchemaLockBusyError)) throw cause;
    // Publish standby only after proving this runtime can open the lock and
    // invoke the kernel primitive. The supervisor stops the predecessor before
    // expecting owned/ready. Waiting is not service readiness.
    writePhase(root, "waiting");
    acquireSchemaFileLock(lockPath, 60_000);
  }
  ownerRoot = root;
  writePhase(root, "owned");
}

export function markDaemonSchemaReady(): void {
  if (!ownerRoot || ownerRoot !== realpathSync(getRaviStateDir()))
    throw new Error("Daemon does not own this state root");
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

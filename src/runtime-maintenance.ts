import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "./utils/paths.js";
import { resolveAccountHome } from "./utils/account-home.js";

export type MaintenanceProcess = {
  name: "ravi" | "ravi-channels";
  pid: number;
  startedAt: number;
  bundleSha256: string;
};

/** External evidence must account for ALL accepted work, beyond component drain receipts. */
export type ProcessCompletionEvidence = {
  process: MaintenanceProcess;
  admissionsClosed: true;
  launcherDisabled: true;
  evidencePath: string;
  evidenceSha256: string;
};

export type RuntimeMaintenance = {
  protocol: "ravi.runtime-maintenance/v1";
  id: string;
  phase: "draining" | "stopping" | "stopped" | "blocked";
  targetBundleSha256: string;
  predecessors: MaintenanceProcess[];
  completion: ProcessCompletionEvidence[];
  exitedPids: number[];
  failure?: string;
};

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const recordPath = (stateDir: string) => join(stateDir, "runtime-maintenance", "active.json");

function interlockPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("RUNTIME_MAINTENANCE_UNVERIFIABLE", { cause });
  }
}

function persist(record: RuntimeMaintenance, stateDir: string): void {
  const directory = join(stateDir, "runtime-maintenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${record.id}.${process.pid}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, recordPath(stateDir));
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function readRuntimeMaintenance(stateDir = getRaviStateDir()): RuntimeMaintenance | null {
  const path = recordPath(stateDir);
  if (!interlockPathExists(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeMaintenance;
  if (
    value.protocol !== "ravi.runtime-maintenance/v1" ||
    !value.id ||
    !["draining", "stopping", "stopped", "blocked"].includes(value.phase) ||
    !/^[a-f0-9]{64}$/.test(value.targetBundleSha256) ||
    !Array.isArray(value.predecessors) ||
    !Array.isArray(value.completion) ||
    !Array.isArray(value.exitedPids)
  )
    throw new Error("RUNTIME_MAINTENANCE_CORRUPT");
  return value;
}

/** Also checked in process entrypoints: PM2 auto-restart must not evade the CLI guard. */
export function assertRuntimeMaintenanceInactive(stateDir = getRaviStateDir()): void {
  const directory = join(stateDir, "runtime-maintenance");
  if (interlockPathExists(join(directory, "interlock")) || readRuntimeMaintenance(stateDir)) {
    throw new Error("RUNTIME_MAINTENANCE_ACTIVE: both runtime starts are blocked; explicit recovery is required");
  }
}

/** EPERM/unknown and reused PIDs fail closed; only ESRCH proves absence. */
export function processExitState(pid: number, probe = process.kill): "exited" | "present" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    probe(pid, 0);
    return "present";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "unknown";
  }
}

function sameProcess(a: MaintenanceProcess, b: MaintenanceProcess): boolean {
  return a.name === b.name && a.pid === b.pid && a.startedAt === b.startedAt && a.bundleSha256 === b.bundleSha256;
}

/**
 * Preparation only: never starts a successor, migrates data or releases the interlock.
 * A verifier is deliberately REQUIRED. Readiness, silence, successful stop commands,
 * and the scoped gateway/Slack/outbound drains cannot supply legacy completion proof.
 */
export async function prepareRuntimeMaintenance(input: {
  targetBundleSha256: string;
  predecessors: MaintenanceProcess[];
  verifyCompletion: ((process: MaintenanceProcess) => Promise<ProcessCompletionEvidence>) | undefined;
  stop: (process: MaintenanceProcess) => Promise<void>;
  list: () => MaintenanceProcess[];
  stateDir?: string;
  exitState?: typeof processExitState;
  wait?: () => Promise<void>;
  exitChecks?: number;
}): Promise<RuntimeMaintenance> {
  const stateDir = input.stateDir ?? getRaviStateDir();
  assertRuntimeMaintenanceInactive(stateDir);
  if (!input.verifyCompletion) throw new Error("RUNTIME_LEGACY_COMPLETION_PROOF_REQUIRED");
  const predecessors = input.predecessors.map((entry) => ({ ...entry }));
  if (
    !/^[a-f0-9]{64}$/.test(input.targetBundleSha256) ||
    predecessors.length !== 2 ||
    new Set(predecessors.map((entry) => entry.name)).size !== 2 ||
    new Set(predecessors.map((entry) => entry.pid)).size !== 2 ||
    predecessors.some(
      (entry) =>
        !["ravi", "ravi-channels"].includes(entry.name) ||
        !Number.isSafeInteger(entry.pid) ||
        entry.pid <= 0 ||
        !Number.isFinite(entry.startedAt) ||
        entry.startedAt <= 0 ||
        !/^[a-f0-9]{64}$/.test(entry.bundleSha256),
    )
  )
    throw new Error("RUNTIME_MAINTENANCE_IDENTITY_REQUIRED");
  const initial = input.list();
  if (initial.length !== 2 || predecessors.some((entry) => !initial.some((current) => sameProcess(entry, current)))) {
    throw new Error("RUNTIME_MAINTENANCE_INVENTORY_UNPROVEN");
  }
  const directory = join(stateDir, "runtime-maintenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Atomic, persistent ownership. No timeout, stale-lock deletion or automatic recovery.
  mkdirSync(join(directory, "interlock"), { mode: 0o700 });
  const record: RuntimeMaintenance = {
    protocol: "ravi.runtime-maintenance/v1",
    id: randomUUID(),
    phase: "draining",
    targetBundleSha256: input.targetBundleSha256,
    predecessors,
    completion: [],
    exitedPids: [],
  };
  persist(record, stateDir);
  const assertUnchanged = () => {
    const current = input.list();
    if (current.some((entry) => !record.predecessors.some((before) => sameProcess(before, entry)))) {
      throw new Error("RUNTIME_MAINTENANCE_REPLACEMENT_OBSERVED");
    }
  };
  try {
    for (const predecessor of record.predecessors) {
      const proof = await input.verifyCompletion(Object.freeze({ ...predecessor }));
      if (
        !sameProcess(proof.process, predecessor) ||
        proof.admissionsClosed !== true ||
        proof.launcherDisabled !== true ||
        !/^[a-f0-9]{64}$/.test(proof.evidenceSha256) ||
        digest(proof.evidencePath) !== proof.evidenceSha256
      ) {
        throw new Error("RUNTIME_MAINTENANCE_COMPLETION_UNPROVEN");
      }
      record.completion.push({ ...proof, process: { ...proof.process } });
      persist(record, stateDir);
    }
    assertUnchanged();
    record.phase = "stopping";
    persist(record, stateDir);
    const exitState = input.exitState ?? processExitState;
    for (const name of ["ravi-channels", "ravi"] as const) {
      const predecessor = record.predecessors.find((entry) => entry.name === name)!;
      assertUnchanged();
      await input.stop(Object.freeze({ ...predecessor }));
      let exited = false;
      for (let attempt = 0; attempt < (input.exitChecks ?? 50); attempt += 1) {
        assertUnchanged();
        if (exitState(predecessor.pid) === "exited") {
          exited = true;
          break;
        }
        await (input.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 100))))();
      }
      if (!exited) throw new Error("RUNTIME_MAINTENANCE_PROCESS_EXIT_UNPROVEN");
      record.exitedPids.push(predecessor.pid);
      persist(record, stateDir);
    }
    assertUnchanged();
    if (record.predecessors.some((entry) => exitState(entry.pid) !== "exited")) {
      throw new Error("RUNTIME_MAINTENANCE_PROCESS_EXIT_UNPROVEN");
    }
    record.phase = "stopped";
    persist(record, stateDir);
    return record;
  } catch (cause) {
    record.phase = "blocked";
    record.failure = cause instanceof Error ? cause.message : String(cause);
    persist(record, stateDir);
    throw cause;
  }
}

/**
 * PR1 intentionally has no live legacy bootstrap authorizer. The external work
 * inventory/verifier must be reviewed before a populated database can be adopted.
 * Do not turn a stopped record or a health check into a deployment permission.
 */
export function assertThreadFenceBootstrapAuthorized(input: {
  existingSchema: boolean;
  databasePath: string;
}): undefined {
  const { canonicalStatePath } = require("./db/state-boundary.js") as typeof import("./db/state-boundary.js");
  const home = resolveAccountHome();
  if (!home) throw new Error("THREAD_FENCE_BOOTSTRAP_BLOCKED: OS account identity is unavailable");
  const database = canonicalStatePath(input.databasePath);
  const liveState = canonicalStatePath(join(home, ".ravi"));
  const legacy = canonicalStatePath(join(home, "ravi", "ravi.db"));
  if (!input.existingSchema && database !== legacy && !database.startsWith(`${liveState}/`) && database !== liveState)
    return;
  throw new Error(
    "THREAD_FENCE_BOOTSTRAP_BLOCKED: external persistence/completion evidence and process exits require review",
  );
}

/** Called before update can stop either predecessor. No initialization/readiness fallback. */
export function assertRuntimeReplacementPrepared(stateDir = getRaviStateDir()): void {
  assertRuntimeMaintenanceInactive(stateDir);
  const path = join(stateDir, "ravi.db");
  if (!existsSync(path))
    throw new Error("THREAD_FENCE_BOOTSTRAP_BLOCKED: no preparation evidence for the running processes");
  const { assertThreadFenceReady } = require("./threads/schema-fence.js") as typeof import("./threads/schema-fence.js");
  // The detached update supervisor is not a schema owner. Inspect only the
  // durable protocol, without lazy initialization or opening a writable handle.
  const database = new Database(path, { readonly: true, create: false });
  try {
    assertThreadFenceReady(database);
  } finally {
    database.close();
  }
}
import { Database } from "bun:sqlite";

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { constants as sqliteConstants, Database } from "bun:sqlite";
import { acquireSchemaFileLock, SchemaLockBusyError } from "../db/schema-lock.js";
import { assertDatabaseTargetAllowed, canonicalStatePath, type DatabaseBoundaryOptions } from "../db/state-boundary.js";
import {
  assertRuntimeMaintenanceInactive,
  persistRuntimeMaintenance,
  processExitState,
  readRuntimeMaintenance,
  recordedProcessExitState,
  type MaintenanceProcess,
  type ProcessCompletionEvidence,
  type RuntimeMaintenance,
} from "../runtime-maintenance.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  withExitedThreadBootstrapAuthorization,
  withFreshStateThreadAuthorization,
  type ExitedThreadBootstrapProof,
} from "./bootstrap-authorization.js";
import { THREAD_FENCE_TABLE } from "./schema-fence.js";

/**
 * One-time adoption of a database written by a legacy (pre-fence) release.
 *
 * Legacy processes cannot close admissions or report completion while alive, so
 * their proof is collected AFTER physical exit: the coordinator stops channels,
 * then the daemon, accepts only ESRCH, and then records the durable residue
 * (completed, durably pending or durably interrupted). Unknown residue blocks.
 * The fence itself is installed by the authorized successor daemon, inside
 * `withExitedThreadBootstrapAuthorization`, which re-verifies every claim.
 * Once the fence exists, ordinary restarts and updates need none of this.
 *
 * Every state after the interlock has an explicit recovery: the adoption record
 * is written before anything is stopped, and recovery also accepts a maintenance
 * record or an interlock left without one.
 */
export const THREAD_FENCE_ADOPTION_PROTOCOL = "ravi.thread-fence-adoption/v1";

type Name = MaintenanceProcess["name"];
const NAMES: readonly Name[] = ["ravi-channels", "ravi"];

/** One launcher registration as observed by the coordinator. Never carries environment. */
export type ManagedRegistration = {
  name: string;
  /** 0 when the app is not running. */
  pid: number;
  /** Start time of the current incarnation, as the process manager reports it. */
  startedAt: number;
  online: boolean;
  /** The bundle this launcher starts on its next (re)start. */
  scriptPath: string;
  /** Launcher status (`online`, `stopped`, `errored`, ...); `stopped` is an operator choice. */
  status?: string;
};

export type DurableResidueSource = { source: string; pending: number; inFlight: number; detail?: unknown };
/** `unknown` lists every accepted unit whose outcome cannot be classified; any entry blocks adoption. */
export type DurableResidue = { sources: DurableResidueSource[]; unknown: string[] };

type EvidenceReference = { path: string; sha256: string };
type DatabaseIdentity = { path: string; device: number; inode: number };

export type ThreadFenceAdoptionPhase =
  | "preparing"
  | "preparation-blocked"
  | "authorized"
  | "adopting"
  | "adopted"
  | "blocked";
const PHASES: readonly ThreadFenceAdoptionPhase[] = [
  "preparing",
  "preparation-blocked",
  "authorized",
  "adopting",
  "adopted",
  "blocked",
];
/** Phases before any successor was authorized: no evidence, no successor, never a fence. */
const PREPARATION_PHASES: readonly ThreadFenceAdoptionPhase[] = ["preparing", "preparation-blocked"];

export type ThreadFenceAdoption = {
  protocol: typeof THREAD_FENCE_ADOPTION_PROTOCOL;
  maintenanceId: string;
  phase: ThreadFenceAdoptionPhase;
  database: DatabaseIdentity;
  targetBundlePath: string;
  targetBundleSha256: string;
  predecessors: MaintenanceProcess[];
  /** Present once the preparation authorized a successor. */
  exclusionEvidence?: EvidenceReference;
  completion: ProcessCompletionEvidence[];
  successor?: { pid: number; startedAt: number };
  failure?: string;
};

export interface AdoptionHost {
  stateDir: string;
  databasePath: string;
  /** Strict launcher registry snapshot; throws when the registry cannot be verified. */
  registry(): ManagedRegistration[];
  /** Identity the running process recorded at boot, matched by pid and start time; null when unverifiable. */
  bootIdentity(registration: ManagedRegistration): MaintenanceProcess | null;
  /** sha256 of a bundle file; null when it cannot be certified. */
  bundleDigest(path: string): string | null;
  stop(name: Name): Promise<void>;
  /** Read only after BOTH predecessors physically exited. */
  /** Read after both exits; `daemonStartedAt` is the start of the stopped daemon process (its snapshots are newer). */
  residue(context?: { daemonStartedAt?: number }): Promise<DurableResidue>;
  exitState?: (pid: number) => "exited" | "present" | "unknown";
  wait?: () => Promise<void>;
  exitChecks?: number;
  now?: () => number;
}

export type ThreadFenceAdoptionPlan = {
  predecessors: MaintenanceProcess[];
  targetBundlePath: string;
  targetBundleSha256: string;
  database: DatabaseIdentity;
};

function blocked(detail: string): never {
  throw new Error(`THREAD_FENCE_ADOPTION_BLOCKED: ${detail}`);
}

const maintenanceDirectory = (stateDir: string) => join(stateDir, "runtime-maintenance");
const adoptionPath = (stateDir: string) => join(maintenanceDirectory(stateDir), "adoption.json");
const successorClaimPath = (stateDir: string) => join(maintenanceDirectory(stateDir), "successor");
const interlockPath = (stateDir: string) => join(maintenanceDirectory(stateDir), "interlock");
const coordinatorLockPath = (stateDir: string) => join(maintenanceDirectory(stateDir), "coordinator.lock");

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("THREAD_FENCE_ADOPTION_UNVERIFIABLE", { cause });
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(path: string, directory: string, value: unknown): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(directory);
}

function writeEvidence(directory: string, file: string, value: unknown): EvidenceReference {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, file);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(directory);
  return { path, sha256: createHash("sha256").update(body).digest("hex") };
}

function databaseIdentity(path: string): DatabaseIdentity {
  const canonical = canonicalStatePath(path);
  const info = statSync(canonical);
  if (!info.isFile() || info.nlink !== 1) blocked("database identity is not exclusive");
  return { path: canonical, device: info.dev, inode: info.ino };
}

function samePath(a: string, b: string): boolean {
  return canonicalStatePath(a) === canonicalStatePath(b);
}

/**
 * The coordinator, a resumed preparation and every recovery hold this OS lock
 * (released by the kernel when the process dies), so recovery never races a
 * coordinator that is still stopping processes. Successor admission and the
 * successor's adoption take the same lease, so a recovery never acts on a
 * record a successor is claiming or adopting at that moment.
 */
function acquireCoordinatorLease(stateDir: string, timeoutMs = 0): { release(): void } {
  try {
    return acquireSchemaFileLock(coordinatorLockPath(stateDir), timeoutMs);
  } catch (cause) {
    if (cause instanceof SchemaLockBusyError)
      throw new Error("THREAD_FENCE_ADOPTION_BLOCKED: another adoption coordinator or recovery is running", { cause });
    throw new Error("THREAD_FENCE_ADOPTION_UNVERIFIABLE: the coordinator lease cannot be taken", { cause });
  }
}

/**
 * Read-only connection that never creates or changes a file. A cleanly closed
 * WAL database has no `-wal`/`-shm` (the last connection checkpointed and removed
 * them), its main file holds every commit, and a read-only connection cannot
 * create the shared-memory file: that case is read as immutable. With a WAL
 * present, the ordinary read-only connection reads it, or fails and blocks.
 */
export function openStateReadOnly(path: string): Database {
  if (!existsSync(path)) throw new Error(`THREAD_FENCE_ADOPTION_UNVERIFIABLE: ${path} does not exist`);
  if (!existsSync(`${path}-wal`) && !existsSync(`${path}-shm`)) {
    const uri = `file:${path.replaceAll("%", "%25").replaceAll("?", "%3f").replaceAll("#", "%23")}?immutable=1`;
    // Explicit flags: URI filenames are off by default in the SQLite Bun embeds on Linux.
    return new Database(uri, sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI);
  }
  return new Database(path, { readonly: true, create: false });
}

/** Read-only fence probe; never installs, migrates or changes the journal mode. */
export function databaseHasThreadFence(path: string): boolean {
  const database = openStateReadOnly(path);
  try {
    return (
      database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(THREAD_FENCE_TABLE) !== null
    );
  } finally {
    database.close();
  }
}

/**
 * The pre-`~/.ravi` database the router moves into the default state directory
 * when that directory has none (router-db). Only for the default database path.
 */
export function legacyStateDatabasePath(databasePath: string, home = homedir()): string | null {
  return databasePath === join(getRaviStateDir({}), "ravi.db") ? join(home, "ravi", "ravi.db") : null;
}

const STATE_JOURNAL_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * An SQLite sidecar (`-wal`, `-shm`, `-journal`) left without its database.
 * A database created next to it could replay writes that were never
 * checkpointed, without the fence. Read-only.
 */
export function orphanStateJournal(databasePath: string): string | null {
  if (entryPresent(databasePath)) return null;
  for (const suffix of STATE_JOURNAL_SUFFIXES) {
    if (entryPresent(`${databasePath}${suffix}`)) return `${databasePath}${suffix}`;
  }
  return null;
}

/** Any directory entry, a dangling link included. An entry that cannot be read refuses. */
function entryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`THREAD_FENCE_ADOPTION_UNVERIFIABLE: ${path} cannot be inspected`, { cause });
  }
}

/** The refusal for `orphanStateJournal`, with its next step. */
export function orphanStateJournalDetail(databasePath: string, journal: string): string {
  return (
    `${journal} exists without its database ${databasePath}: it may hold writes that were never checkpointed, ` +
    "and a new database next to it would replay them without the fence. Restore the database next to it, " +
    "or move its -wal, -shm and -journal files out of the state directory, then start again"
  );
}

/**
 * A database no release ever wrote: `missing`, or `empty` (an SQLite file with
 * no schema object, such as the one a refused first start leaves). Not fresh
 * with a write-ahead log holding frames, a sidecar without its database
 * (`orphanStateJournal`), or a legacy database the router would move in.
 * Read-only; never creates a file.
 */
export function freshStateDatabase(
  databasePath: string,
  legacyDatabasePath: string | null = legacyStateDatabasePath(databasePath),
): "missing" | "empty" | null {
  if (legacyDatabasePath && existsSync(legacyDatabasePath)) return null;
  const wal = `${databasePath}-wal`;
  if (!entryPresent(databasePath)) return orphanStateJournal(databasePath) ? null : "missing";
  if (existsSync(wal) && statSync(wal).size > 0) return null;
  let database: Database;
  try {
    database = openStateReadOnly(databasePath);
  } catch {
    // no-cause: An unreadable file is not proof of an empty database; the caller keeps the existing-state rules.
    return null;
  }
  try {
    return database.query("SELECT 1 FROM sqlite_master LIMIT 1").get() === null ? "empty" : null;
  } catch {
    // no-cause: A file SQLite cannot read is not proof of an empty database; the caller keeps the existing-state rules.
    return null;
  } finally {
    database.close();
  }
}

export function readThreadFenceAdoption(stateDir: string): ThreadFenceAdoption | null {
  // One read, no existence check first: the successor may move the record to
  // history at any moment, and a vanished record means "no adoption record".
  let raw: string;
  try {
    raw = readFileSync(adoptionPath(stateDir), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("THREAD_FENCE_ADOPTION_UNVERIFIABLE", { cause });
  }
  const value = JSON.parse(raw) as ThreadFenceAdoption;
  if (
    value?.protocol !== THREAD_FENCE_ADOPTION_PROTOCOL ||
    typeof value.maintenanceId !== "string" ||
    !PHASES.includes(value.phase) ||
    !/^[a-f0-9]{64}$/.test(value.targetBundleSha256) ||
    typeof value.targetBundlePath !== "string" ||
    !Array.isArray(value.predecessors) ||
    value.predecessors.length !== 2 ||
    !Array.isArray(value.completion) ||
    !value.database
  )
    throw new Error("THREAD_FENCE_ADOPTION_CORRUPT");
  if (!PREPARATION_PHASES.includes(value.phase) && (value.completion.length !== 2 || !value.exclusionEvidence))
    throw new Error("THREAD_FENCE_ADOPTION_CORRUPT");
  return value;
}

function persistAdoption(stateDir: string, adoption: ThreadFenceAdoption): void {
  writeAtomic(adoptionPath(stateDir), maintenanceDirectory(stateDir), adoption);
}

function singleRegistration(registrations: ManagedRegistration[], name: Name): ManagedRegistration {
  const matches = registrations.filter((entry) => entry.name === name);
  if (matches.length !== 1) blocked(`expected exactly one launcher registration for ${name}`);
  return matches[0]!;
}

/** Read-only. Nothing is stopped, written or started. */
export function planThreadFenceAdoption(host: AdoptionHost, targetBundlePath: string): ThreadFenceAdoptionPlan {
  assertRuntimeMaintenanceInactive(host.stateDir);
  if (readThreadFenceAdoption(host.stateDir)) blocked("an adoption record already exists; use recovery");
  const database = databaseIdentity(host.databasePath);
  if (databaseHasThreadFence(database.path))
    blocked("the database already has the thread fence; ordinary restart and update apply");
  const targetBundleSha256 = host.bundleDigest(targetBundlePath);
  if (!targetBundleSha256 || !/^[a-f0-9]{64}$/.test(targetBundleSha256))
    blocked("the installed target bundle cannot be certified");
  const registrations = host.registry();
  for (const entry of registrations) {
    if (!NAMES.includes(entry.name as Name) && samePath(entry.scriptPath, targetBundlePath))
      blocked(`unaccounted launcher ${entry.name} starts the Ravi bundle`);
  }
  const predecessors = NAMES.map((name) => {
    const registration = singleRegistration(registrations, name);
    if (!registration.online || !Number.isSafeInteger(registration.pid) || registration.pid <= 0)
      blocked(`${name} is not running under its launcher; its identity cannot be proven`);
    if (!samePath(registration.scriptPath, targetBundlePath))
      blocked(`${name} launcher does not start the installed release; install it before adoption`);
    const identity = host.bootIdentity(registration);
    if (
      !identity ||
      identity.name !== name ||
      identity.pid !== registration.pid ||
      identity.startedAt !== registration.startedAt ||
      !/^[a-f0-9]{64}$/.test(identity.bundleSha256)
    )
      blocked(`${name} boot identity is missing or does not match the running process`);
    if (identity.bundleSha256 === targetBundleSha256)
      blocked(`${name} already runs the target bundle; this is not a legacy predecessor`);
    return { ...identity };
  });
  return { predecessors, targetBundlePath: canonicalStatePath(targetBundlePath), targetBundleSha256, database };
}

/**
 * Coordinator. Takes the interlock and writes the adoption record before the
 * first stop; never releases the interlock. The authorized successor or an
 * explicit recovery does.
 */
export async function prepareThreadFenceAdoption(
  host: AdoptionHost,
  targetBundlePath: string,
): Promise<ThreadFenceAdoption> {
  const plan = planThreadFenceAdoption(host, targetBundlePath);
  const lease = acquireCoordinatorLease(host.stateDir);
  try {
    // Re-checked under the lease: another coordinator may have finished in between.
    assertRuntimeMaintenanceInactive(host.stateDir);
    if (readThreadFenceAdoption(host.stateDir)) blocked("an adoption record already exists; use recovery");
    mkdirSync(maintenanceDirectory(host.stateDir), { recursive: true, mode: 0o700 });
    // Atomic, persistent ownership. No timeout or stale-lock deletion.
    mkdirSync(interlockPath(host.stateDir), { mode: 0o700 });
    const id = randomUUID();
    const adoption: ThreadFenceAdoption = {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId: id,
      phase: "preparing",
      database: plan.database,
      targetBundlePath: plan.targetBundlePath,
      targetBundleSha256: plan.targetBundleSha256,
      predecessors: plan.predecessors.map((entry) => ({ ...entry })),
      completion: [],
    };
    // The recovery handle exists before anything is stopped.
    persistAdoption(host.stateDir, adoption);
    const record: RuntimeMaintenance = {
      protocol: "ravi.runtime-maintenance/v1",
      id,
      phase: "draining",
      targetBundleSha256: plan.targetBundleSha256,
      predecessors: plan.predecessors,
      completion: [],
      exitedPids: [],
    };
    persistRuntimeMaintenance(record, host.stateDir);
    return await drivePreparation(host, adoption, record);
  } finally {
    lease.release();
  }
}

/**
 * Resumes a preparation that stopped (blocked or interrupted) before it
 * authorized a successor: predecessors already proven gone are not stopped
 * again, everything else is re-verified from scratch.
 */
export async function resumeThreadFenceAdoption(host: AdoptionHost): Promise<ThreadFenceAdoption> {
  const lease = acquireCoordinatorLease(host.stateDir);
  try {
    const adoption = readThreadFenceAdoption(host.stateDir);
    const record = readRuntimeMaintenance(host.stateDir);
    if (!adoption || !PREPARATION_PHASES.includes(adoption.phase))
      blocked("only a preparation that stopped before authorizing a successor resumes");
    if (!record || record.id !== adoption.maintenanceId) blocked("the maintenance record is missing; use abandon");
    if (!pathExists(interlockPath(host.stateDir))) blocked("the interlock is missing; use abandon");
    if (databaseHasThreadFence(adoption.database.path)) blocked("the fence is installed; use release");
    return await drivePreparation(host, adoption, record);
  } finally {
    lease.release();
  }
}

async function drivePreparation(
  host: AdoptionHost,
  start: ThreadFenceAdoption,
  record: RuntimeMaintenance,
): Promise<ThreadFenceAdoption> {
  const now = host.now ?? Date.now;
  const exitState = host.exitState ?? processExitState;
  const directory = maintenanceDirectory(host.stateDir);
  const target = start.targetBundlePath;
  const { failure: _previous, ...rest } = start;
  const adoption: ThreadFenceAdoption = { ...rest, phase: "preparing" };
  const assertOnlyPredecessors = () => {
    for (const entry of host.registry()) {
      // Unrelated apps (broker, gateway) are not Ravi writers; anything named or launched as Ravi is.
      if (!entry.online || !(NAMES.includes(entry.name as Name) || samePath(entry.scriptPath, target))) continue;
      if (
        !record.predecessors.some(
          (before) => before.name === entry.name && before.pid === entry.pid && before.startedAt === entry.startedAt,
        )
      )
        blocked(`replacement or unaccounted process observed: ${entry.name}`);
    }
  };
  try {
    persistAdoption(host.stateDir, adoption);
    record.phase = "stopping";
    record.failure = undefined;
    persistRuntimeMaintenance(record, host.stateDir);
    for (const name of NAMES) {
      const predecessor = record.predecessors.find((entry) => entry.name === name)!;
      if (record.exitedPids.includes(predecessor.pid) && exitState(predecessor.pid) === "exited") continue;
      assertOnlyPredecessors();
      if (host.registry().some((entry) => entry.name === name && entry.online)) await host.stop(name);
      let exited = false;
      for (let attempt = 0; attempt < (host.exitChecks ?? 100); attempt += 1) {
        assertOnlyPredecessors();
        if (exitState(predecessor.pid) === "exited") {
          exited = true;
          break;
        }
        await (host.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 100))))();
      }
      if (!exited) blocked(`${name} physical exit is unproven`);
      if (!record.exitedPids.includes(predecessor.pid)) record.exitedPids.push(predecessor.pid);
      persistRuntimeMaintenance(record, host.stateDir);
    }
    if (record.predecessors.some((entry) => exitState(entry.pid) !== "exited"))
      blocked("a predecessor exit changed after it was observed");
    const after = host.registry();
    for (const name of NAMES) {
      const registration = singleRegistration(after, name);
      if (registration.online) blocked(`${name} launcher restarted a process during maintenance`);
      if (!samePath(registration.scriptPath, target)) blocked(`${name} launcher changed its bundle during maintenance`);
    }
    if (after.some((entry) => entry.online && samePath(entry.scriptPath, target)))
      blocked("a process is running the target bundle during maintenance");
    if (host.bundleDigest(target) !== adoption.targetBundleSha256)
      blocked("the target bundle changed during maintenance");
    const residue = await host.residue({
      daemonStartedAt: adoption.predecessors.find((entry) => entry.name === "ravi")?.startedAt,
    });
    if (!residue || !Array.isArray(residue.sources) || !Array.isArray(residue.unknown))
      blocked("durable residue could not be read");
    if (residue.unknown.length > 0)
      blocked(`accepted work with unknown outcome: ${residue.unknown.slice(0, 5).join(", ")}`);
    // One evidence directory per attempt: a resumed preparation never rewrites earlier evidence.
    const evidenceDirectory = join(directory, "evidence", record.id, randomUUID());
    const observedAt = now();
    const exclusionEvidence = writeEvidence(evidenceDirectory, "exclusion.json", {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId: record.id,
      observedAt,
      target: { path: target, sha256: adoption.targetBundleSha256 },
      // Every registration that could relaunch Ravi now starts only the target bundle,
      // which honours the interlock; the legacy code is not reachable by any launcher.
      registrations: after.map((entry) => ({
        name: entry.name,
        online: entry.online,
        pid: entry.pid,
        scriptPath: entry.scriptPath,
      })),
    });
    record.completion = [];
    for (const predecessor of record.predecessors) {
      const evidence = writeEvidence(evidenceDirectory, `${predecessor.name}.json`, {
        protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
        maintenanceId: record.id,
        process: predecessor,
        exit: { observedAt, state: "exited", proof: "ESRCH" },
        rule: "every accepted unit is completed, durably pending or durably recorded as interrupted; unknown blocks",
        residue,
      });
      record.completion.push({
        process: { ...predecessor },
        admissionsClosed: true,
        launcherDisabled: true,
        evidencePath: evidence.path,
        evidenceSha256: evidence.sha256,
      });
    }
    record.phase = "stopped";
    persistRuntimeMaintenance(record, host.stateDir);
    const authorized: ThreadFenceAdoption = {
      ...adoption,
      phase: "authorized",
      exclusionEvidence,
      completion: record.completion.map((entry) => ({ ...entry, process: { ...entry.process } })),
    };
    persistAdoption(host.stateDir, authorized);
    return authorized;
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    record.phase = "blocked";
    record.failure = failure;
    persistRuntimeMaintenance(record, host.stateDir);
    persistAdoption(host.stateDir, { ...adoption, phase: "preparation-blocked", failure });
    throw cause;
  }
}

/**
 * Daemon entry admission. Without maintenance this is a normal start. Under
 * maintenance only the authorized successor bundle may start, once; every other
 * start (channels, another bundle, a second successor) is refused.
 */
export function admitDaemonStart(input: {
  stateDir: string;
  ownBundlePath: string;
  bundleDigest: (path: string) => string | null;
  self: { pid: number; startedAt: number };
  /** How long to wait for a running coordinator or recovery; then the start is refused. */
  leaseTimeoutMs?: number;
  /** Settle leftovers of an adoption that installed the fence or never will (see `healUnderLease`). */
  heal?: boolean;
}): "normal" | "successor" {
  if (!pathExists(interlockPath(input.stateDir)) && !readRuntimeMaintenance(input.stateDir)) return "normal";
  const refuse = (detail: string): never => {
    throw new Error(`RUNTIME_MAINTENANCE_ACTIVE: both runtime starts are blocked; ${detail}`);
  };
  let lease: { release(): void };
  try {
    lease = acquireCoordinatorLease(input.stateDir, input.leaseTimeoutMs ?? 5_000);
  } catch (cause) {
    throw new Error(
      "RUNTIME_MAINTENANCE_ACTIVE: both runtime starts are blocked; an adoption coordinator or recovery is running",
      { cause },
    );
  }
  try {
    return admitUnderLease(input, refuse);
  } finally {
    lease.release();
  }
}

/** The state check and the claim happen under the coordinator lease, never interleaved with a recovery. */
type AdmissionInput = {
  stateDir: string;
  ownBundlePath: string;
  bundleDigest: (path: string) => string | null;
  self: { pid: number; startedAt: number };
  heal?: boolean;
};

function admitUnderLease(input: AdmissionInput, refuse: (detail: string) => never): "normal" | "successor" {
  const record = readRuntimeMaintenance(input.stateDir);
  // A recovery may have released everything while this start waited for the lease.
  if (!pathExists(interlockPath(input.stateDir)) && !record) return "normal";
  const adoption = readThreadFenceAdoption(input.stateDir);
  if (
    adoption?.phase === "adopting" &&
    adoption.successor?.pid === input.self.pid &&
    adoption.successor.startedAt === input.self.startedAt
  )
    return "successor";
  // An installed fence means the adoption is done: nothing left to admit a successor for.
  if (input.heal && databaseHasThreadFence(join(input.stateDir, "ravi.db")) && healUnderLease(input, adoption))
    return "normal";
  // Under heal, a refusal settles the leftovers instead, unless a successor may still be running.
  const settle = (detail: string): "normal" => {
    if (!input.heal) return refuse(detail);
    if (healUnderLease(input, adoption)) return "normal";
    return refuse(`a thread fence upgrade is still running in pid ${adoption?.successor?.pid}; the next start retries`);
  };
  if (!adoption || !record || record.id !== adoption.maintenanceId) return settle("explicit recovery is required");
  if (adoption.phase !== "authorized" || record.phase !== "stopped")
    return settle(`thread fence adoption is ${adoption.phase}; explicit recovery is required`);
  if (
    !samePath(input.ownBundlePath, adoption.targetBundlePath) ||
    input.bundleDigest(input.ownBundlePath) !== adoption.targetBundleSha256
  )
    return settle("only the authorized successor bundle may start during thread fence adoption");
  try {
    mkdirSync(successorClaimPath(input.stateDir), { mode: 0o700 });
  } catch (cause) {
    // A claim left by a successor that died before recording itself settles like any other leftover.
    if (input.heal && healUnderLease(input, adoption)) return "normal";
    throw new Error("RUNTIME_MAINTENANCE_ACTIVE: another successor already claimed thread fence adoption", { cause });
  }
  persistAdoption(input.stateDir, { ...adoption, phase: "adopting", successor: { ...input.self } });
  return "successor";
}

/**
 * Automatic recovery at daemon entry, under the coordinator lease, so an upgrade
 * never waits for an operator. Whatever an interrupted adoption left, once its
 * successor is gone the interlock is released: with the fence installed the
 * adoption is done; without it nothing was ever installed, and the boot adoption
 * re-derives every proof from scratch. Only a successor that may still be
 * running (alive, or an exit that cannot be read) keeps the start refused; the
 * launcher retries it.
 */
function healUnderLease(input: { stateDir: string }, adoption: ThreadFenceAdoption | null): boolean {
  if (adoption?.successor && recordedProcessExitState(adoption.successor) !== "exited") return false;
  const record = readRuntimeMaintenance(input.stateDir);
  releaseInterlock(input.stateDir, adoption?.maintenanceId ?? record?.id ?? `orphan-${randomUUID()}`);
  return true;
}

function releaseInterlock(stateDir: string, maintenanceId: string): void {
  const directory = maintenanceDirectory(stateDir);
  const history = join(directory, "history");
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const active = join(directory, "active.json");
  if (pathExists(active)) renameSync(active, join(history, `${maintenanceId}.json`));
  if (pathExists(adoptionPath(stateDir)))
    renameSync(adoptionPath(stateDir), join(history, `${maintenanceId}.adoption.json`));
  if (pathExists(successorClaimPath(stateDir))) rmdirSync(successorClaimPath(stateDir));
  // The interlock goes last: any crash before this line keeps both starts blocked,
  // and recovery accepts an interlock left without records.
  if (pathExists(interlockPath(stateDir))) rmdirSync(interlockPath(stateDir));
  fsyncDirectory(directory);
}

/**
 * Runs in the admitted successor, before any other state is opened. `open` must
 * synchronously open the router database so the fence is installed inside the
 * authorization scope. The verifier re-derives every claim it can observe:
 * database identity, launcher state, bundle digest and, when `residue` is given,
 * the SQLite residue itself; the broker residue stays the coordinator's record.
 */
type SuccessorAdoptionInput = {
  stateDir: string;
  registry: () => ManagedRegistration[];
  bundleDigest: (path: string) => string | null;
  self: { pid: number };
  open: () => void;
  residue?: (adoption: ThreadFenceAdoption) => DurableResidue;
  /** How long to wait for a running recovery; then the successor stops without touching the database. */
  leaseTimeoutMs?: number;
};

export function adoptThreadFenceAsSuccessor(input: SuccessorAdoptionInput): ThreadFenceAdoption {
  // Held from the state check to the release of the interlock: a recovery cannot
  // archive the records of a successor that is installing the fence.
  const lease = acquireCoordinatorLease(input.stateDir, input.leaseTimeoutMs ?? 5_000);
  try {
    return adoptUnderLease(input);
  } finally {
    lease.release();
  }
}

function adoptUnderLease(input: SuccessorAdoptionInput): ThreadFenceAdoption {
  const adoption = readThreadFenceAdoption(input.stateDir);
  if (!adoption || adoption.phase !== "adopting" || adoption.successor?.pid !== input.self.pid)
    blocked("this process is not the admitted successor");
  try {
    const exclusionEvidence = adoption.exclusionEvidence;
    if (!exclusionEvidence || adoption.completion.length !== 2) blocked("the adoption record has no evidence");
    withExitedThreadBootstrapAuthorization(
      {
        databasePath: adoption.database.path,
        predecessors: adoption.predecessors,
        verify: (database): ExitedThreadBootstrapProof => {
          if (
            database.path !== adoption.database.path ||
            database.device !== adoption.database.device ||
            database.inode !== adoption.database.inode
          )
            blocked("the database is not the one the coordinator inventoried");
          const registrations = input.registry();
          const daemon = singleRegistration(registrations, "ravi");
          // An update that re-creates the launchers removes the channel runner before the daemon starts.
          const channelRegistrations = registrations.filter((entry) => entry.name === "ravi-channels");
          if (channelRegistrations.length > 1) blocked("expected at most one launcher registration for ravi-channels");
          if (!daemon.online || daemon.pid !== input.self.pid)
            blocked("the daemon launcher is not running this successor");
          if (channelRegistrations.some((entry) => entry.online))
            blocked("the channel runner is running; admissions are not closed");
          const others = registrations.filter((entry) => entry.online && entry.pid !== input.self.pid);
          if (others.some((entry) => samePath(entry.scriptPath, adoption.targetBundlePath)))
            blocked("another process runs the Ravi bundle");
          for (const registration of [daemon, ...channelRegistrations]) {
            if (!samePath(registration.scriptPath, adoption.targetBundlePath))
              blocked(`${registration.name} launcher does not start the authorized bundle`);
          }
          if (input.bundleDigest(adoption.targetBundlePath) !== adoption.targetBundleSha256)
            blocked("the authorized bundle changed");
          const residue = input.residue?.(adoption);
          if (residue && residue.unknown.length > 0)
            blocked(`accepted work with unknown outcome at adoption: ${residue.unknown.slice(0, 5).join(", ")}`);
          return {
            inventoryComplete: true,
            // Legacy processes observed now: none may run (checked above); the successor is not a legacy writer.
            inventory: [],
            admissionsClosed: true,
            launchersExcluded: true,
            exclusionEvidence: { ...exclusionEvidence },
            completion: adoption.completion.map((entry) => ({ ...entry, process: { ...entry.process } })),
          };
        },
      },
      () => {
        input.open();
      },
    );
    if (!databaseHasThreadFence(adoption.database.path)) blocked("the fence was not installed by the successor");
    const adopted: ThreadFenceAdoption = { ...adoption, phase: "adopted" };
    persistAdoption(input.stateDir, adopted);
    releaseInterlock(input.stateDir, adoption.maintenanceId);
    return adopted;
  } catch (cause) {
    persistAdoption(input.stateDir, {
      ...adoption,
      phase: "blocked",
      failure: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

export type RecoveryMode = "release" | "retry" | "abandon";
type ExitState = "exited" | "present" | "unknown";

export type ThreadFenceMaintenanceState = {
  interlock: boolean;
  maintenance: { id: string; phase: string; failure?: string; exitedPids: number[] } | null;
  adoption: { maintenanceId: string; phase: ThreadFenceAdoptionPhase; failure?: string } | null;
  successorClaim: boolean;
  fenced: boolean;
  predecessors: { name: string; pid: number; exit: ExitState }[];
  successor: { pid: number; exit: ExitState } | null;
  /** Recovery modes that apply now; empty means nothing may be recovered yet. */
  modes: RecoveryMode[];
  diagnosis: string;
};

/** Read-only view of every maintenance artifact; recovery acts only on what this reports. */
export function describeThreadFenceMaintenance(input: {
  stateDir: string;
  databasePath: string;
  exitState?: (pid: number) => ExitState;
}): ThreadFenceMaintenanceState {
  const exitState = input.exitState ?? processExitState;
  const interlock = pathExists(interlockPath(input.stateDir));
  const record = readRuntimeMaintenance(input.stateDir);
  const adoption = readThreadFenceAdoption(input.stateDir);
  const successorClaim = pathExists(successorClaimPath(input.stateDir));
  const fenced = existsSync(input.databasePath) && databaseHasThreadFence(input.databasePath);
  const predecessors = (adoption?.predecessors ?? record?.predecessors ?? []).map((entry) => ({
    name: entry.name,
    pid: entry.pid,
    exit: exitState(entry.pid),
  }));
  const successor = adoption?.successor
    ? { pid: adoption.successor.pid, exit: exitState(adoption.successor.pid) }
    : null;
  const successorGone = !successor || successor.exit === "exited";
  let modes: RecoveryMode[] = [];
  let diagnosis: string;
  if (!interlock && !record && !adoption) diagnosis = "no maintenance is active";
  else if (adoption && record && adoption.maintenanceId !== record.id)
    diagnosis = "the adoption and maintenance records belong to different maintenances";
  else if (fenced) {
    if (!successorGone && adoption?.phase !== "adopted")
      diagnosis = "the successor is still adopting; it releases the interlock itself";
    else {
      diagnosis = "the fence is installed; release returns to ordinary restarts";
      modes = ["release"];
    }
  } else if (!successorGone) diagnosis = "the claimed successor is present or its exit is unknown";
  else if (!adoption || PREPARATION_PHASES.includes(adoption.phase)) {
    const failure = adoption?.failure ?? record?.failure;
    diagnosis = adoption
      ? "the preparation stopped before authorizing a successor"
      : record
        ? "a maintenance record without an adoption record"
        : "an interlock without any record";
    if (failure) diagnosis = `${diagnosis}: ${failure}`;
    modes = adoption && record && interlock ? ["retry", "abandon"] : ["abandon"];
  } else {
    diagnosis = `the successor did not install the fence${adoption.failure ? `: ${adoption.failure}` : ""}`;
    modes = ["retry", "abandon"];
  }
  return {
    interlock,
    maintenance: record
      ? { id: record.id, phase: record.phase, failure: record.failure, exitedPids: [...record.exitedPids] }
      : null,
    adoption: adoption
      ? { maintenanceId: adoption.maintenanceId, phase: adoption.phase, failure: adoption.failure }
      : null,
    successorClaim,
    fenced,
    predecessors,
    successor,
    modes,
    diagnosis,
  };
}

/**
 * Explicit recovery. Never clears queues, claims or markers and never touches the
 * database. `release`: the fence is installed and no successor is mid-adoption.
 * `retry`: no fence; a successor that failed is replaced by one new successor
 * (a stopped preparation resumes through `resumeThreadFenceAdoption` instead).
 * `abandon`: no fence; release the interlock so the previous release can return.
 */
export function recoverThreadFenceAdoption(input: {
  stateDir: string;
  databasePath: string;
  mode: RecoveryMode;
  exitState?: (pid: number) => ExitState;
}): "released" | "reauthorized" | "abandoned" {
  const lease = acquireCoordinatorLease(input.stateDir);
  try {
    const state = describeThreadFenceMaintenance(input);
    if (!state.modes.includes(input.mode)) blocked(`${input.mode} does not apply: ${state.diagnosis}`);
    const maintenanceId = state.adoption?.maintenanceId ?? state.maintenance?.id ?? `orphan-${randomUUID()}`;
    if (input.mode === "retry") {
      const adoption = readThreadFenceAdoption(input.stateDir)!;
      if (PREPARATION_PHASES.includes(adoption.phase))
        blocked("a stopped preparation resumes through the coordinator (resumeThreadFenceAdoption)");
      if (pathExists(successorClaimPath(input.stateDir))) rmdirSync(successorClaimPath(input.stateDir));
      const { successor: _previous, failure: _failure, ...rest } = adoption;
      persistAdoption(input.stateDir, { ...rest, phase: "authorized" });
      return "reauthorized";
    }
    releaseInterlock(input.stateDir, maintenanceId);
    return input.mode === "release" ? "released" : "abandoned";
  } finally {
    lease.release();
  }
}

/**
 * What the operator command waits for after starting the successor. `adopted`
 * only when no record, claim or interlock remains and the fence exists, so the
 * channel runner never starts while its entry guard would still refuse.
 */
export function successorOutcome(stateDir: string, databasePath: string): "pending" | "adopted" | "failed" {
  const adoption = readThreadFenceAdoption(stateDir);
  if (adoption) return adoption.phase === "blocked" || adoption.phase === "preparation-blocked" ? "failed" : "pending";
  if (
    pathExists(interlockPath(stateDir)) ||
    readRuntimeMaintenance(stateDir) ||
    pathExists(successorClaimPath(stateDir))
  )
    return "pending";
  return databaseHasThreadFence(databasePath) ? "adopted" : "failed";
}

/** What the daemon entry needs to adopt a pre-fence database by itself. */
export interface BootAdoptionHost {
  stateDir: string;
  databasePath: string;
  /** The bundle this process runs. */
  ownBundlePath: string;
  self: { pid: number; startedAt: number };
  registry(): ManagedRegistration[];
  bundleDigest(path: string): string | null;
  /** Last identity a runtime recorded at its boot, whatever process manager state it is in now. */
  lastBootIdentity(name: Name): MaintenanceProcess | null;
  /** Durable broker reachable; the residue cannot be classified without it. */
  brokerReady(): Promise<boolean>;
  stop(name: Name): Promise<void>;
  residue(context?: { daemonStartedAt?: number }): Promise<DurableResidue>;
  /** Re-read by the successor verifier, inside the authorization scope. */
  successorResidue?: (adoption: ThreadFenceAdoption) => DurableResidue;
  /** Installs the fence; runs inside the authorization scope. */
  open(): void;
  exitState?: (entry: { pid: number; startedAt: number }) => ExitState;
  wait?: () => Promise<void>;
  exitChecks?: number;
  now?: () => number;
  /** The legacy database the router would move in; default: `legacyStateDatabasePath(databasePath)`. */
  legacyDatabasePath?: string | null;
  /** State boundary of this process for the target check (tests inject a sandbox home). */
  boundary?: DatabaseBoundaryOptions;
}

/** `created`: first start on a new state directory; the database was created with the fence. */
export type BootAdoptionResult =
  | { outcome: "not-needed" }
  | { outcome: "adopted"; maintenanceId: string }
  | { outcome: "created" };

/**
 * Prefix of every boot adoption refusal: the daemon exits, nothing in the
 * database changed, and the message carries the next step.
 */
export const THREAD_FENCE_UPGRADE_BLOCKED = "THREAD_FENCE_UPGRADE_BLOCKED";
function upgradeBlocked(detail: string): never {
  throw new Error(`${THREAD_FENCE_UPGRADE_BLOCKED}: ${detail}`);
}

/**
 * Transparent upgrade. A daemon of this release that finds a database written
 * by a pre-fence release, with no legacy process alive, adopts it by itself:
 * the same interlock, records, evidence and successor verification as the
 * coordinator, with the daemon as its own successor. Legacy identities come
 * from the last boot receipts; every one must have exited (a process started
 * before the current OS boot has). A running channel runner is stopped through
 * its launcher first; the intent is written before the stop, and the daemon
 * starts the runner again once it is ready (`resumeChannelsAfterUpgrade`).
 *
 * Refuses, without touching anything, while a legacy daemon still runs (an
 * older CLI's overlapping restart). After the interlock, any failure before
 * the fence is installed releases the interlock again, so the next start
 * re-derives everything; unknown residue keeps refusing with its list.
 */
export async function adoptThreadFenceAtBoot(host: BootAdoptionHost): Promise<BootAdoptionResult> {
  try {
    const result = await adoptAtBoot(host);
    if (result.outcome !== "not-needed") clearUpgradeFailure(host.stateDir);
    return result;
  } catch (cause) {
    recordUpgradeFailure(host.stateDir, cause);
    throw cause;
  }
}

const upgradeFailurePath = (stateDir: string) => join(maintenanceDirectory(stateDir), "upgrade-failure.json");
export type UpgradeFailure = { at: number; pid: number; failure: string };

/** Why the last boot adoption refused, for the CLI that is waiting on it. Never an authority to act. */
export function readUpgradeFailure(stateDir: string): UpgradeFailure | null {
  try {
    const value = JSON.parse(readFileSync(upgradeFailurePath(stateDir), "utf8")) as UpgradeFailure;
    return Number.isFinite(value?.at) && typeof value.failure === "string" ? value : null;
  } catch {
    // no-cause: No readable failure note means no failure to report; the caller keeps waiting on the fence.
    return null;
  }
}

/** Keeps the reason a daemon start refused for the CLI that waits on it. Never throws. */
export function recordUpgradeFailure(stateDir: string, cause: unknown): void {
  try {
    writeAtomic(upgradeFailurePath(stateDir), maintenanceDirectory(stateDir), {
      at: Date.now(),
      pid: process.pid,
      failure: cause instanceof Error ? cause.message : String(cause),
    } satisfies UpgradeFailure);
  } catch {
    // no-cause: The note only speeds up the waiting CLI; the refusal itself is rethrown by the caller.
  }
}

function clearUpgradeFailure(stateDir: string): void {
  try {
    rmSync(upgradeFailurePath(stateDir), { force: true });
  } catch {
    // no-cause: A stale note is ignored by readers older than the restart that wait on it.
  }
}

const legacyDatabaseOf = (host: BootAdoptionHost) =>
  host.legacyDatabasePath === undefined ? legacyStateDatabasePath(host.databasePath) : host.legacyDatabasePath;

/**
 * First start on a new state directory: nothing to adopt. The daemon creates
 * the database exclusively (or takes the empty one a refused first start left)
 * and installs the fence before any store opens it, inside
 * `withFreshStateThreadAuthorization`. Refuses, creating nothing, unless this
 * is the PM2-supervised `ravi`, no other Ravi process runs, and every previous
 * runtime that left a boot record has exited.
 */
async function createFencedStateDatabase(host: BootAdoptionHost): Promise<BootAdoptionResult> {
  // First: a process the state boundary refuses (a source checkout running as the
  // PM2 `ravi` on real state) leaves no directory, lock or database behind.
  assertDatabaseTargetAllowed(host.databasePath, host.boundary);
  const ownBundle = canonicalStatePath(host.ownBundlePath);
  const exitState = host.exitState ?? ((entry: { pid: number; startedAt: number }) => recordedProcessExitState(entry));
  const exclusion = () => {
    const registrations = host.registry();
    if (!registrations.some((entry) => entry.name === "ravi" && entry.online && entry.pid === host.self.pid))
      upgradeBlocked(
        "only a daemon supervised by PM2 as 'ravi' creates the state database; start it with 'ravi daemon start'",
      );
    const other = registrations.find(
      (entry) =>
        entry.online &&
        entry.pid !== host.self.pid &&
        (NAMES.includes(entry.name as Name) || samePath(entry.scriptPath, ownBundle)),
    );
    if (other)
      upgradeBlocked(
        `${other.name} (pid ${other.pid}) is running without a state database; stop it, then start the daemon again`,
      );
    for (const name of NAMES) {
      const previous = host.lastBootIdentity(name);
      if (previous && previous.pid !== host.self.pid && exitState(previous) !== "exited")
        upgradeBlocked(`the previous ${name} (pid ${previous.pid}) may still be running; stop it, then start again`);
    }
    return registrations.map((entry) => ({ name: entry.name, pid: entry.pid, online: entry.online }));
  };
  // Read only: nothing is created before the exclusion holds.
  exclusion();
  const lease = acquireCoordinatorLease(host.stateDir);
  try {
    assertRuntimeMaintenanceInactive(host.stateDir);
    if (readThreadFenceAdoption(host.stateDir)) upgradeBlocked("an adoption record appeared; restart to settle it");
    if (existsSync(host.databasePath) && databaseHasThreadFence(host.databasePath)) return { outcome: "not-needed" };
    if (!freshStateDatabase(host.databasePath, legacyDatabaseOf(host)))
      upgradeBlocked("the state database changed during the first start; Ravi retries on the next start");
    if (!existsSync(host.databasePath)) {
      mkdirSync(dirname(host.databasePath), { recursive: true, mode: 0o700 });
      let raced = false;
      try {
        closeSync(openSync(host.databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        // no-cause: EEXIST is the expected race outcome, reported below as its own refusal.
        raced = true;
      }
      if (raced)
        upgradeBlocked(
          "another process created the state database during the first start; Ravi retries on the next start",
        );
    }
    withFreshStateThreadAuthorization(
      { databasePath: host.databasePath, verify: () => ({ registrations: exclusion() }) },
      () => host.open(),
    );
  } finally {
    lease.release();
  }
  if (!databaseHasThreadFence(host.databasePath))
    upgradeBlocked("the fence was not installed on the new state database");
  return { outcome: "created" };
}

async function adoptAtBoot(host: BootAdoptionHost): Promise<BootAdoptionResult> {
  const exists = existsSync(host.databasePath);
  if (exists && databaseHasThreadFence(host.databasePath)) return { outcome: "not-needed" };
  // Nothing may create a database next to a sidecar it would replay, in any mode.
  const orphan = orphanStateJournal(host.databasePath);
  if (orphan) upgradeBlocked(orphanStateJournalDetail(host.databasePath, orphan));
  if (freshStateDatabase(host.databasePath, legacyDatabaseOf(host))) {
    // Only the PM2-supervised daemon creates the database here. A daemon in the
    // foreground (development, on an isolated state directory) keeps the store
    // path: an empty isolated database is authorized there (`empty-isolated-state`),
    // and the state boundary refuses it real state.
    return host.self.startedAt > 0 ? createFencedStateDatabase(host) : { outcome: "not-needed" };
  }
  if (!exists) return { outcome: "not-needed" };
  assertRuntimeMaintenanceInactive(host.stateDir);
  const exitState = host.exitState ?? ((entry: { pid: number; startedAt: number }) => recordedProcessExitState(entry));
  const ownBundle = canonicalStatePath(host.ownBundlePath);
  const isRavi = (entry: ManagedRegistration) =>
    NAMES.includes(entry.name as Name) || samePath(entry.scriptPath, ownBundle);

  // Read only: nothing is written or stopped before every precondition holds.
  const registrations = host.registry();
  const daemons = registrations.filter((entry) => entry.name === "ravi");
  const self = daemons.find((entry) => entry.online && entry.pid === host.self.pid);
  if (!self)
    upgradeBlocked(
      "only a daemon supervised by PM2 as 'ravi' upgrades the database; start it with 'ravi daemon start'",
    );
  const legacyDaemon = registrations.find(
    (entry) =>
      entry.online &&
      entry.pid !== host.self.pid &&
      entry.name !== "ravi-channels" &&
      (entry.name === "ravi" || samePath(entry.scriptPath, ownBundle)),
  );
  if (daemons.length > 1 || legacyDaemon)
    upgradeBlocked(
      `a previous Ravi daemon is still running (pid ${legacyDaemon?.pid ?? "unknown"}); run 'ravi daemon restart -m "upgrade"' with this release to finish the upgrade`,
    );
  const channels = registrations.filter((entry) => entry.name === "ravi-channels");
  if (channels.length > 1) upgradeBlocked("more than one ravi-channels launcher is registered; remove the duplicate");
  if (channels[0] && !samePath(channels[0].scriptPath, ownBundle))
    upgradeBlocked("the ravi-channels launcher starts another bundle; run 'ravi update' to align both launchers");
  if (!samePath(self.scriptPath, ownBundle)) upgradeBlocked("the ravi launcher does not start this bundle");
  const targetBundleSha256 = host.bundleDigest(ownBundle);
  if (!targetBundleSha256 || !/^[a-f0-9]{64}$/.test(targetBundleSha256))
    upgradeBlocked("this bundle cannot be certified");
  const predecessors = NAMES.map((name) => {
    const identity = host.lastBootIdentity(name);
    if (
      !identity ||
      identity.name !== name ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      identity.pid === host.self.pid ||
      !Number.isFinite(identity.startedAt) ||
      identity.startedAt <= 0 ||
      !/^[a-f0-9]{64}$/.test(identity.bundleSha256)
    )
      upgradeBlocked(
        `the previous ${name} left no boot record (releases before 3.261104.2 write none); upgrade through 3.261113.2 first`,
      );
    return { ...identity };
  });
  const database = databaseIdentity(host.databasePath);
  if (!(await host.brokerReady()))
    upgradeBlocked(
      "the message broker is unreachable; its pending work cannot be classified. Ravi retries on the next start",
    );

  const lease = acquireCoordinatorLease(host.stateDir);
  let installed = false;
  let maintenanceId = "";
  try {
    assertRuntimeMaintenanceInactive(host.stateDir);
    if (readThreadFenceAdoption(host.stateDir)) upgradeBlocked("an adoption record appeared; restart to settle it");
    if (databaseHasThreadFence(database.path)) return { outcome: "not-needed" };
    mkdirSync(maintenanceDirectory(host.stateDir), { recursive: true, mode: 0o700 });
    mkdirSync(interlockPath(host.stateDir), { mode: 0o700 });
    maintenanceId = randomUUID();
    const adoption: ThreadFenceAdoption = {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId,
      phase: "preparing",
      database,
      targetBundlePath: ownBundle,
      targetBundleSha256,
      predecessors,
      completion: [],
    };
    persistAdoption(host.stateDir, adoption);
    const record: RuntimeMaintenance = {
      protocol: "ravi.runtime-maintenance/v1",
      id: maintenanceId,
      phase: "stopping",
      targetBundleSha256,
      predecessors,
      completion: [],
      exitedPids: [],
    };
    persistRuntimeMaintenance(record, host.stateDir);

    const waitExit = async (entry: { pid: number; startedAt: number }, what: string) => {
      for (let attempt = 0; attempt < (host.exitChecks ?? 100); attempt += 1) {
        if (exitState(entry) === "exited") return;
        await (host.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 100))))();
      }
      upgradeBlocked(`${what} did not exit`);
    };
    const runningChannels = host.registry().find((entry) => entry.name === "ravi-channels" && entry.online);
    if (runningChannels) {
      // Written before the stop: whoever adopts later (this start, or a later one) restarts the runner.
      recordChannelsStoppedForUpgrade(host.stateDir, "daemon entry");
      await host.stop("ravi-channels");
      // Its incarnation may predate its boot record; wait for the pid the launcher reported.
      await waitExit(
        { pid: runningChannels.pid, startedAt: runningChannels.startedAt || host.self.startedAt },
        "ravi-channels",
      );
    }
    for (const predecessor of predecessors) {
      await waitExit(predecessor, `the previous ${predecessor.name} (pid ${predecessor.pid})`);
      record.exitedPids.push(predecessor.pid);
    }
    persistRuntimeMaintenance(record, host.stateDir);
    const after = host.registry();
    const intruder = after.find((entry) => entry.online && entry.pid !== host.self.pid && isRavi(entry));
    if (intruder) upgradeBlocked(`${intruder.name} (pid ${intruder.pid}) started during the upgrade`);
    if (host.bundleDigest(ownBundle) !== targetBundleSha256) upgradeBlocked("this bundle changed during the upgrade");
    const residue = await host.residue({
      daemonStartedAt: predecessors.find((entry) => entry.name === "ravi")?.startedAt,
    });
    if (!residue || !Array.isArray(residue.sources) || !Array.isArray(residue.unknown))
      upgradeBlocked("durable residue could not be read; Ravi retries on the next start");
    if (residue.unknown.length > 0)
      upgradeBlocked(
        `accepted work with unknown outcome blocks the upgrade: ${residue.unknown.slice(0, 5).join(", ")}${residue.unknown.length > 5 ? ` (+${residue.unknown.length - 5})` : ""}. The legacy runtime is stopped; settle these rows (spec quality/state-boundary, RUNBOOK "Settle step") and the next start retries, or reinstall 3.261113.2 to go back`,
      );
    const evidenceDirectory = join(maintenanceDirectory(host.stateDir), "evidence", maintenanceId, randomUUID());
    const observedAt = (host.now ?? Date.now)();
    const exclusionEvidence = writeEvidence(evidenceDirectory, "exclusion.json", {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId,
      observedAt,
      mode: "boot",
      target: { path: ownBundle, sha256: targetBundleSha256 },
      self: host.self,
      registrations: after.map((entry) => ({
        name: entry.name,
        online: entry.online,
        pid: entry.pid,
        scriptPath: entry.scriptPath,
      })),
    });
    record.completion = predecessors.map((predecessor) => {
      const evidence = writeEvidence(evidenceDirectory, `${predecessor.name}.json`, {
        protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
        maintenanceId,
        process: predecessor,
        exit: { observedAt, state: "exited" },
        rule: "every accepted unit is completed, durably pending or durably recorded as interrupted; unknown blocks",
        residue,
      });
      return {
        process: { ...predecessor },
        admissionsClosed: true as const,
        launcherDisabled: true as const,
        evidencePath: evidence.path,
        evidenceSha256: evidence.sha256,
      };
    });
    record.phase = "stopped";
    persistRuntimeMaintenance(record, host.stateDir);
    // The daemon claims the successor role for itself, as an admitted successor would.
    mkdirSync(successorClaimPath(host.stateDir), { mode: 0o700 });
    persistAdoption(host.stateDir, {
      ...adoption,
      phase: "adopting",
      exclusionEvidence,
      completion: record.completion.map((entry) => ({ ...entry, process: { ...entry.process } })),
      successor: { ...host.self },
    });
    adoptUnderLease({
      stateDir: host.stateDir,
      registry: host.registry,
      bundleDigest: host.bundleDigest,
      self: { pid: host.self.pid },
      open: host.open,
      residue: host.successorResidue,
    });
    installed = true;
  } catch (cause) {
    // Nothing was installed: release, so the next start derives every proof again.
    if (!installed && maintenanceId && !databaseHasThreadFence(database.path)) {
      try {
        releaseInterlock(host.stateDir, maintenanceId);
      } catch (releaseCause) {
        throw new AggregateError(
          [cause, releaseCause],
          `${THREAD_FENCE_UPGRADE_BLOCKED}: the upgrade and its release both failed`,
          {
            cause,
          },
        );
      }
    }
    throw cause;
  } finally {
    lease.release();
  }
  return { outcome: "adopted", maintenanceId };
}

/**
 * The channel runner an upgrade stopped. Written by whoever stops it for the
 * upgrade (daemon restart, update, or the daemon entry), before the stop, and
 * consumed only by a daemon that is ready on a fenced database: a refusal in
 * between, by anyone, keeps it for the start that adopts. A runner the
 * operator stopped has no intent and stays stopped.
 */
const channelsIntentPath = (stateDir: string) => join(maintenanceDirectory(stateDir), "channels-after-upgrade.json");
export type ChannelsIntent = { at: number; by: string };

export function recordChannelsStoppedForUpgrade(stateDir: string, by: string): void {
  mkdirSync(maintenanceDirectory(stateDir), { recursive: true, mode: 0o700 });
  writeAtomic(channelsIntentPath(stateDir), maintenanceDirectory(stateDir), {
    at: Date.now(),
    by,
  } satisfies ChannelsIntent);
}

export function readChannelsStoppedForUpgrade(stateDir: string): ChannelsIntent | null {
  try {
    const value = JSON.parse(readFileSync(channelsIntentPath(stateDir), "utf8")) as ChannelsIntent;
    return Number.isFinite(value?.at) ? value : null;
  } catch {
    // no-cause: No readable intent means no runner stopped by an upgrade; nothing is started.
    return null;
  }
}

export interface ChannelsResumeHost {
  stateDir: string;
  databasePath: string;
  /** The bundle the ready daemon runs; the runner must start the same one. */
  ownBundlePath: string;
  registry(): ManagedRegistration[];
  /** `pm2 start ravi-channels`: the existing registration, its script and environment. */
  startExisting(): number;
  /** Deletes any registration, then registers the runner on `ownBundlePath`. */
  recreate(): number;
}

export type ChannelsResumeOutcome = "none" | "fence-missing" | "already-running" | "started" | "failed";

/** Runs in a ready daemon. Starts the runner the upgrade stopped, on this daemon's bundle, once. */
export function resumeChannelsAfterUpgrade(host: ChannelsResumeHost): ChannelsResumeOutcome {
  if (!readChannelsStoppedForUpgrade(host.stateDir)) return "none";
  if (!databaseHasThreadFence(host.databasePath)) return "fence-missing";
  const registrations = host.registry().filter((entry) => entry.name === "ravi-channels");
  let outcome: ChannelsResumeOutcome;
  if (registrations.length === 1 && registrations[0]!.online) outcome = "already-running";
  else if (registrations.length === 1 && samePath(registrations[0]!.scriptPath, host.ownBundlePath))
    outcome = host.startExisting() === 0 ? "started" : "failed";
  else outcome = host.recreate() === 0 ? "started" : "failed";
  if (outcome !== "failed") rmSync(channelsIntentPath(host.stateDir), { force: true });
  return outcome;
}

/**
 * Settles adoption leftovers for a lifecycle command (daemon start/restart,
 * update, channels start) before it checks the interlock, with the same rule
 * and lease as the daemon entry: once the claimed successor has exited, or
 * there is none, the leftovers are released. Otherwise, or when the lease is
 * held by an adoption in progress, nothing changes and the caller's own check
 * reports it.
 */
export function settleThreadFenceLeftovers(stateDir: string, leaseTimeoutMs = 2_000): "none" | "settled" | "running" {
  if (!pathExists(interlockPath(stateDir)) && !readRuntimeMaintenance(stateDir)) return "none";
  let lease: { release(): void };
  try {
    lease = acquireCoordinatorLease(stateDir, leaseTimeoutMs);
  } catch {
    // no-cause: The lease is held by an adoption in progress; the caller's check refuses with that state.
    return "running";
  }
  try {
    if (!pathExists(interlockPath(stateDir)) && !readRuntimeMaintenance(stateDir)) return "none";
    return healUnderLease({ stateDir }, readThreadFenceAdoption(stateDir)) ? "settled" : "running";
  } finally {
    lease.release();
  }
}

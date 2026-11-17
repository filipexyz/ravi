import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalStatePath } from "../db/state-boundary.js";
import {
  assertRuntimeMaintenanceInactive,
  persistRuntimeMaintenance,
  processExitState,
  readRuntimeMaintenance,
  type MaintenanceProcess,
  type ProcessCompletionEvidence,
  type RuntimeMaintenance,
} from "../runtime-maintenance.js";
import { withExitedThreadBootstrapAuthorization, type ExitedThreadBootstrapProof } from "./bootstrap-authorization.js";
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
};

export type DurableResidueSource = { source: string; pending: number; inFlight: number; detail?: unknown };
/** `unknown` lists every accepted unit whose outcome cannot be classified; any entry blocks adoption. */
export type DurableResidue = { sources: DurableResidueSource[]; unknown: string[] };

type EvidenceReference = { path: string; sha256: string };
type DatabaseIdentity = { path: string; device: number; inode: number };

export type ThreadFenceAdoption = {
  protocol: typeof THREAD_FENCE_ADOPTION_PROTOCOL;
  maintenanceId: string;
  phase: "authorized" | "adopting" | "adopted" | "blocked";
  database: DatabaseIdentity;
  targetBundlePath: string;
  targetBundleSha256: string;
  predecessors: MaintenanceProcess[];
  exclusionEvidence: EvidenceReference;
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
  residue(): Promise<DurableResidue>;
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

/** Read-only fence probe; never installs, migrates or changes the journal mode. */
export function databaseHasThreadFence(path: string): boolean {
  const database = new Database(path, { readonly: true, create: false });
  try {
    return (
      database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(THREAD_FENCE_TABLE) !== null
    );
  } finally {
    database.close();
  }
}

export function readThreadFenceAdoption(stateDir: string): ThreadFenceAdoption | null {
  const path = adoptionPath(stateDir);
  if (!pathExists(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as ThreadFenceAdoption;
  if (
    value?.protocol !== THREAD_FENCE_ADOPTION_PROTOCOL ||
    typeof value.maintenanceId !== "string" ||
    !["authorized", "adopting", "adopted", "blocked"].includes(value.phase) ||
    !/^[a-f0-9]{64}$/.test(value.targetBundleSha256) ||
    typeof value.targetBundlePath !== "string" ||
    !Array.isArray(value.predecessors) ||
    value.predecessors.length !== 2 ||
    !Array.isArray(value.completion) ||
    value.completion.length !== 2 ||
    !value.exclusionEvidence ||
    !value.database
  )
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
 * Coordinator. Holds the interlock from the first stop onward and never
 * releases it; the authorized successor or an explicit recovery does.
 */
export async function prepareThreadFenceAdoption(
  host: AdoptionHost,
  targetBundlePath: string,
): Promise<ThreadFenceAdoption> {
  const plan = planThreadFenceAdoption(host, targetBundlePath);
  const now = host.now ?? Date.now;
  const exitState = host.exitState ?? processExitState;
  const directory = maintenanceDirectory(host.stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Atomic, persistent ownership. No timeout or stale-lock deletion.
  mkdirSync(interlockPath(host.stateDir), { mode: 0o700 });
  const record: RuntimeMaintenance = {
    protocol: "ravi.runtime-maintenance/v1",
    id: randomUUID(),
    phase: "draining",
    targetBundleSha256: plan.targetBundleSha256,
    predecessors: plan.predecessors,
    completion: [],
    exitedPids: [],
  };
  persistRuntimeMaintenance(record, host.stateDir);
  const assertOnlyPredecessors = () => {
    for (const entry of host.registry()) {
      // Unrelated apps (broker, gateway) are not Ravi writers; anything named or launched as Ravi is.
      if (!entry.online || !(NAMES.includes(entry.name as Name) || samePath(entry.scriptPath, plan.targetBundlePath)))
        continue;
      if (
        !record.predecessors.some(
          (before) => before.name === entry.name && before.pid === entry.pid && before.startedAt === entry.startedAt,
        )
      )
        blocked(`replacement or unaccounted process observed: ${entry.name}`);
    }
  };
  try {
    record.phase = "stopping";
    persistRuntimeMaintenance(record, host.stateDir);
    for (const name of NAMES) {
      const predecessor = record.predecessors.find((entry) => entry.name === name)!;
      assertOnlyPredecessors();
      await host.stop(name);
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
      record.exitedPids.push(predecessor.pid);
      persistRuntimeMaintenance(record, host.stateDir);
    }
    if (record.predecessors.some((entry) => exitState(entry.pid) !== "exited"))
      blocked("a predecessor exit changed after it was observed");
    const after = host.registry();
    for (const name of NAMES) {
      const registration = singleRegistration(after, name);
      if (registration.online) blocked(`${name} launcher restarted a process during maintenance`);
      if (!samePath(registration.scriptPath, plan.targetBundlePath))
        blocked(`${name} launcher changed its bundle during maintenance`);
    }
    if (after.some((entry) => entry.online && samePath(entry.scriptPath, plan.targetBundlePath)))
      blocked("a process is running the target bundle during maintenance");
    if (host.bundleDigest(plan.targetBundlePath) !== plan.targetBundleSha256)
      blocked("the target bundle changed during maintenance");
    const residue = await host.residue();
    if (!residue || !Array.isArray(residue.sources) || !Array.isArray(residue.unknown))
      blocked("durable residue could not be read");
    if (residue.unknown.length > 0)
      blocked(`accepted work with unknown outcome: ${residue.unknown.slice(0, 5).join(", ")}`);
    const evidenceDirectory = join(directory, "evidence", record.id);
    const observedAt = now();
    const exclusionEvidence = writeEvidence(evidenceDirectory, "exclusion.json", {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId: record.id,
      observedAt,
      target: { path: plan.targetBundlePath, sha256: plan.targetBundleSha256 },
      // Every registration that could relaunch Ravi now starts only the target bundle,
      // which honours the interlock; the legacy code is not reachable by any launcher.
      registrations: after.map((entry) => ({
        name: entry.name,
        online: entry.online,
        pid: entry.pid,
        scriptPath: entry.scriptPath,
      })),
    });
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
    const adoption: ThreadFenceAdoption = {
      protocol: THREAD_FENCE_ADOPTION_PROTOCOL,
      maintenanceId: record.id,
      phase: "authorized",
      database: plan.database,
      targetBundlePath: plan.targetBundlePath,
      targetBundleSha256: plan.targetBundleSha256,
      predecessors: record.predecessors.map((entry) => ({ ...entry })),
      exclusionEvidence,
      completion: record.completion.map((entry) => ({ ...entry, process: { ...entry.process } })),
    };
    persistAdoption(host.stateDir, adoption);
    return adoption;
  } catch (cause) {
    record.phase = "blocked";
    record.failure = cause instanceof Error ? cause.message : String(cause);
    persistRuntimeMaintenance(record, host.stateDir);
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
}): "normal" | "successor" {
  const interlock = pathExists(interlockPath(input.stateDir));
  const record = readRuntimeMaintenance(input.stateDir);
  if (!interlock && !record) return "normal";
  const refuse = (detail: string): never => {
    throw new Error(`RUNTIME_MAINTENANCE_ACTIVE: both runtime starts are blocked; ${detail}`);
  };
  const adoption = readThreadFenceAdoption(input.stateDir);
  if (!adoption || !record || record.id !== adoption.maintenanceId) return refuse("explicit recovery is required");
  if (adoption.phase === "adopting" && adoption.successor?.pid === input.self.pid) return "successor";
  if (adoption.phase !== "authorized" || record.phase !== "stopped")
    return refuse(`thread fence adoption is ${adoption.phase}; explicit recovery is required`);
  if (
    !samePath(input.ownBundlePath, adoption.targetBundlePath) ||
    input.bundleDigest(input.ownBundlePath) !== adoption.targetBundleSha256
  )
    return refuse("only the authorized successor bundle may start during thread fence adoption");
  try {
    mkdirSync(successorClaimPath(input.stateDir), { mode: 0o700 });
  } catch (cause) {
    throw new Error("RUNTIME_MAINTENANCE_ACTIVE: another successor already claimed thread fence adoption", { cause });
  }
  persistAdoption(input.stateDir, { ...adoption, phase: "adopting", successor: { ...input.self } });
  return "successor";
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
  // The interlock goes last: any crash before this line keeps both starts blocked.
  if (pathExists(interlockPath(stateDir))) rmdirSync(interlockPath(stateDir));
  fsyncDirectory(directory);
}

/**
 * Runs in the admitted successor, before any other state is opened. `open` must
 * synchronously open the router database so the fence is installed inside the
 * authorization scope. The verifier re-derives every claim; the record only
 * names what to verify.
 */
export function adoptThreadFenceAsSuccessor(input: {
  stateDir: string;
  registry: () => ManagedRegistration[];
  bundleDigest: (path: string) => string | null;
  self: { pid: number };
  open: () => void;
}): ThreadFenceAdoption {
  const adoption = readThreadFenceAdoption(input.stateDir);
  if (!adoption || adoption.phase !== "adopting" || adoption.successor?.pid !== input.self.pid)
    blocked("this process is not the admitted successor");
  try {
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
          const channels = singleRegistration(registrations, "ravi-channels");
          if (!daemon.online || daemon.pid !== input.self.pid)
            blocked("the daemon launcher is not running this successor");
          if (channels.online) blocked("the channel runner is running; admissions are not closed");
          const others = registrations.filter((entry) => entry.online && entry.pid !== input.self.pid);
          if (others.some((entry) => samePath(entry.scriptPath, adoption.targetBundlePath)))
            blocked("another process runs the Ravi bundle");
          for (const registration of [daemon, channels]) {
            if (!samePath(registration.scriptPath, adoption.targetBundlePath))
              blocked(`${registration.name} launcher does not start the authorized bundle`);
          }
          if (input.bundleDigest(adoption.targetBundlePath) !== adoption.targetBundleSha256)
            blocked("the authorized bundle changed");
          return {
            inventoryComplete: true,
            // Legacy processes observed now; the successor itself is not a legacy writer.
            inventory: [],
            admissionsClosed: true,
            launchersExcluded: true,
            exclusionEvidence: { ...adoption.exclusionEvidence },
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

/**
 * Explicit recovery. Never clears queues, claims or markers and never touches the
 * database. `release`: the fence is installed and no successor is mid-adoption.
 * `retry`: no fence, the claimed successor exited; authorize one new successor.
 * `abandon`: no fence; release the interlock so the previous release can return.
 */
export function recoverThreadFenceAdoption(input: {
  stateDir: string;
  databasePath: string;
  mode: "release" | "retry" | "abandon";
  exitState?: (pid: number) => "exited" | "present" | "unknown";
}): string {
  const exitState = input.exitState ?? processExitState;
  const adoption = readThreadFenceAdoption(input.stateDir);
  const record = readRuntimeMaintenance(input.stateDir);
  if (!adoption || !record || adoption.maintenanceId !== record.id)
    blocked("no thread fence adoption record matches the maintenance record");
  const fenced = databaseHasThreadFence(input.databasePath);
  const successorGone = !adoption.successor || exitState(adoption.successor.pid) === "exited";
  if (input.mode === "release") {
    if (!fenced) blocked("the fence is not installed; use retry or abandon");
    if (adoption.phase !== "adopted" && !successorGone)
      blocked("the successor is still adopting; it releases the interlock itself");
    releaseInterlock(input.stateDir, record.id);
    return "released";
  }
  if (fenced) blocked("the fence is installed; only release applies");
  if (!successorGone) blocked("the claimed successor is present or its exit is unknown");
  if (input.mode === "retry") {
    if (pathExists(successorClaimPath(input.stateDir))) rmdirSync(successorClaimPath(input.stateDir));
    const { successor: _previous, failure: _failure, ...rest } = adoption;
    persistAdoption(input.stateDir, { ...rest, phase: "authorized" });
    return "reauthorized";
  }
  releaseInterlock(input.stateDir, record.id);
  return "abandoned";
}

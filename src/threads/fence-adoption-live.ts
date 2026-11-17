import { dirname, join } from "node:path";
import { connect } from "nats";
import { openStateDatabase } from "../db/state-boundary.js";
import { runtimeStateDatabasePaths } from "../db/state-paths.js";
import { managedRuntimeBundlePath } from "../managed-runtime.js";
import { getPm2Process, getPm2Processes, runPm2, type Pm2Process } from "../pm2.js";
import type { MaintenanceProcess } from "../runtime-maintenance.js";
import {
  readLastRuntimeBootReceipt,
  readRuntimeBootReceipt,
  runtimeBootBundlePath,
  runtimeBundleFingerprint,
} from "../runtime-process-identity.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  type AdoptionHost,
  adoptThreadFenceAtBoot,
  adoptThreadFenceAsSuccessor,
  type BootAdoptionResult,
  type DurableResidue,
  type ManagedRegistration,
  planThreadFenceAdoption,
  type ThreadFenceAdoption,
  type ThreadFenceAdoptionPlan,
} from "./fence-adoption.js";
import {
  collectJetStreamResidue,
  collectSqliteResidue,
  type JetStreamResidueReader,
  LEGACY_RESIDUE_EXCLUSIONS,
  legacyBridgeDatabasePath,
  legacyResidueRules,
  mergeResidue,
  RESTART_REASON_FILE,
  restartSnapshotResidue,
} from "./fence-adoption-residue.js";
import { prepareRegisteredThreadFence } from "./schema-fence.js";

/** Every runtime database of the state directory that holds `ravi.db` (the unverified rules search them all). */
export function legacyStateDatabasePaths(routerDatabasePath: string): string[] {
  return runtimeStateDatabasePaths({ ...process.env, RAVI_STATE_DIR: dirname(routerDatabasePath) });
}

/** Strict PM2 snapshot reduced to launcher identity; environment is never read or kept. */
export function liveRegistrations(): ManagedRegistration[] {
  return getPm2Processes({ strict: true }).map((entry) => {
    const online = entry.status === "online" && Number.isSafeInteger(entry.pid) && entry.pid > 0;
    return {
      name: entry.name,
      pid: online ? entry.pid : 0,
      startedAt: entry.startedAt ?? 0,
      online,
      scriptPath: managedRuntimeBundlePath(entry) ?? entry.execPath ?? "",
      status: entry.status,
    };
  });
}

export function liveBundleDigest(path: string): string | null {
  return runtimeBundleFingerprint(path)?.sha256 ?? null;
}

/** Legacy identity from the boot receipt the running release wrote (format unchanged since 3.261113.2). */
export function liveBootIdentity(
  registration: ManagedRegistration,
  stateDir = getRaviStateDir(),
): MaintenanceProcess | null {
  if (registration.name !== "ravi" && registration.name !== "ravi-channels") return null;
  const observed: Pm2Process = {
    name: registration.name,
    pm_id: -1,
    pid: registration.pid,
    status: registration.online ? "online" : "stopped",
    cpu: 0,
    memory: 0,
    startedAt: registration.startedAt,
  };
  const receipt = readRuntimeBootReceipt(observed, stateDir);
  if (!receipt?.bundle || !/^[a-f0-9]{64}$/.test(receipt.bundle.sha256)) return null;
  return {
    name: registration.name,
    pid: receipt.pid,
    startedAt: receipt.startedAt,
    bundleSha256: receipt.bundle.sha256,
  };
}

/** Stops through the launcher, which also keeps it stopped until an explicit start. */
export async function liveStop(name: MaintenanceProcess["name"]): Promise<void> {
  const result = runPm2(["stop", name]);
  if (result.status !== 0) throw new Error(`THREAD_FENCE_ADOPTION_BLOCKED: pm2 stop ${name} exited ${result.status}`);
}

function isJetStreamNotFound(error: unknown): boolean {
  const code = (error as { api_error?: { err_code?: number } } | null)?.api_error?.err_code;
  // 10059 stream not found, 10014 consumer not found.
  if (code === 10059 || code === 10014) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(stream|consumer) not found$/i.test(message.trim());
}

/** Dedicated short connection to the broker (a separate PM2 app); never the runtime singleton. */
export async function withLiveJetStreamReader<T>(
  use: (reader: JetStreamResidueReader) => Promise<T>,
  url = process.env.NATS_URL || "nats://127.0.0.1:4222",
): Promise<T> {
  const connection = await connect({ servers: url, reconnect: false, timeout: 5_000 });
  try {
    const manager = await connection.jetstreamManager();
    const absentAsNull = async <V>(read: () => Promise<V>): Promise<V | null> => {
      try {
        return await read();
      } catch (error) {
        if (isJetStreamNotFound(error)) return null;
        throw error;
      }
    };
    return await use({
      streamMessages: (stream) => absentAsNull(async () => (await manager.streams.info(stream)).state.messages),
      consumerPending: (stream, consumer) =>
        absentAsNull(async () => {
          const info = await manager.consumers.info(stream, consumer);
          return { pending: info.num_pending, ackPending: info.num_ack_pending };
        }),
    });
  } finally {
    await connection.close();
  }
}

/**
 * Preview for `thread-fence-adopt` without --execute, while 3.261113.2 still runs: the same SQLite
 * rules, read only, before any stop. Advisory: rows in flight now are carried or recomputed by the
 * successor; a blocking row (`resumption not verified`) is already here and will block the window,
 * so the operator can settle it before (RUNBOOK). Not read: the broker, whose residue is what the
 * stop drains, and the restart snapshots, whose epoch only the stop creates.
 */
export function previewLiveSqliteResidue(databasePath: string): DurableResidue {
  return collectSqliteResidue(
    legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
  );
}

/** What `thread-fence-adopt` without --execute returns: the read-only plan and the residue preview. */
export function adoptionDryRun(
  host: AdoptionHost,
  targetBundlePath: string,
): ThreadFenceAdoptionPlan & { residuePreview: DurableResidue } {
  return {
    ...planThreadFenceAdoption(host, targetBundlePath),
    residuePreview: previewLiveSqliteResidue(host.databasePath),
  };
}

/** Read only after both predecessors exited: router database, broker, and the excluded tables. */
export async function liveResidue(
  databasePath: string,
  withReader: (
    use: (reader: JetStreamResidueReader) => Promise<DurableResidue>,
  ) => Promise<DurableResidue> = withLiveJetStreamReader,
  restartReasonPath = RESTART_REASON_FILE,
  daemonStartedAt?: number,
): Promise<DurableResidue> {
  const sqlite = mergeResidue(
    collectSqliteResidue(
      legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
    ),
    restartSnapshotResidue({ databasePath, restartReasonPath, stoppedProcessStartedAt: daemonStartedAt }),
  );
  let broker: DurableResidue;
  try {
    broker = await withReader((reader) => collectJetStreamResidue(reader));
  } catch (cause) {
    // no-cause: An unreachable broker is recorded as unknown residue, which blocks adoption with this message.
    broker = {
      sources: [],
      unknown: [`jetstream: unreachable (${cause instanceof Error ? cause.message : String(cause)})`],
    };
  }
  const excluded: DurableResidue = {
    sources: LEGACY_RESIDUE_EXCLUSIONS.map((entry) => ({
      source: entry.table,
      pending: 0,
      inFlight: 0,
      detail: { excluded: entry.reason },
    })),
    unknown: [],
  };
  return mergeResidue(sqlite, broker, excluded);
}

/** The SQLite residue the successor re-derives itself, inside the authorization scope. */
function successorSqliteResidue(databasePath: string, restartReasonPath: string) {
  // The restart snapshots are re-read with the successor's own clock: past the resume window the
  // adoption is refused instead of claiming sessions nobody will resume (CodeRabbit r4595928941).
  return (adoption: ThreadFenceAdoption): DurableResidue =>
    mergeResidue(
      collectSqliteResidue(
        legacyResidueRules(
          databasePath,
          legacyBridgeDatabasePath(databasePath),
          legacyStateDatabasePaths(databasePath),
        ),
      ),
      restartSnapshotResidue({
        databasePath,
        restartReasonPath,
        stoppedProcessStartedAt: adoption.predecessors.find((entry) => entry.name === "ravi")?.startedAt,
      }),
    );
}

/** Installs only the fence, in its own short connection; store initialization then runs as usual. */
function installFence(databasePath: string): () => void {
  return () => {
    const database = openStateDatabase(databasePath);
    try {
      prepareRegisteredThreadFence(database);
    } finally {
      database.close();
    }
  };
}

/**
 * Successor entry, after daemon schema ownership and before the command graph
 * can open any store: installs only the fence, in its own short connection,
 * inside the authorization scope. Store initialization then runs as usual.
 */
export function adoptThreadFenceAtEntry(
  stateDir = getRaviStateDir(),
  host: {
    registry: () => ManagedRegistration[];
    bundleDigest: (path: string) => string | null;
    pid: number;
    restartReasonPath?: string;
  } = { registry: liveRegistrations, bundleDigest: liveBundleDigest, pid: process.pid },
): ThreadFenceAdoption {
  const databasePath = join(stateDir, "ravi.db");
  return adoptThreadFenceAsSuccessor({
    stateDir,
    registry: host.registry,
    bundleDigest: host.bundleDigest,
    self: { pid: host.pid },
    // The successor re-derives the SQLite residue itself instead of trusting the coordinator's record.
    residue: successorSqliteResidue(databasePath, host.restartReasonPath ?? RESTART_REASON_FILE),
    open: installFence(databasePath),
  });
}

/** Waits for the broker the residue reads, as the daemon does for PM2 parallel startup. */
export async function waitForBroker(
  url = process.env.NATS_URL || "nats://127.0.0.1:4222",
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const connection = await connect({ servers: url, reconnect: false, timeout: 2_000 });
      await connection.close();
      return true;
    } catch {
      // no-cause: Unreachable now; the caller refuses with its own message once the deadline passes.
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Daemon entry, when no adoption was admitted: a database written by a
 * pre-fence release is adopted here, without any operator command.
 */
export async function adoptThreadFenceOnUpgrade(stateDir = getRaviStateDir()): Promise<BootAdoptionResult> {
  const databasePath = join(stateDir, "ravi.db");
  const managed = getPm2Process("ravi");
  return adoptThreadFenceAtBoot({
    stateDir,
    databasePath,
    ownBundlePath: runtimeBootBundlePath(),
    self: { pid: process.pid, startedAt: managed?.pid === process.pid ? (managed.startedAt ?? 0) : 0 },
    registry: liveRegistrations,
    bundleDigest: liveBundleDigest,
    lastBootIdentity: (name) => {
      const receipt = readLastRuntimeBootReceipt(name, stateDir);
      if (!receipt?.bundle) return null;
      return { name, pid: receipt.pid, startedAt: receipt.startedAt, bundleSha256: receipt.bundle.sha256 };
    },
    brokerReady: () => waitForBroker(),
    stop: liveStop,
    start: (name) => {
      const result = runPm2(["start", name]);
      if (result.status !== 0)
        process.stderr.write(
          `Thread fence adopted, but 'pm2 start ${name}' exited ${result.status}; run 'ravi channels start'\n`,
        );
    },
    residue: (context) => liveResidue(databasePath, undefined, undefined, context?.daemonStartedAt),
    successorResidue: successorSqliteResidue(databasePath, RESTART_REASON_FILE),
    open: installFence(databasePath),
  });
}

/** PM2 restarts a refused daemon at once; this paces the attempts while the refusal waits for its fix. */
const UPGRADE_RETRY_PAUSE_MS = 30_000;

/**
 * `daemon run` entry: adopts a pre-fence database, or does nothing. The normal
 * case prints nothing; a refusal prints its single next step and exits, before
 * the command graph can read the database (and fail with a less useful error).
 */
export async function adoptThreadFenceAtDaemonEntry(): Promise<void> {
  try {
    const upgrade = await adoptThreadFenceOnUpgrade();
    if (upgrade.outcome === "adopted")
      process.stderr.write(`Thread fence installed on upgrade (${upgrade.maintenanceId})\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    await new Promise((resolve) => setTimeout(resolve, UPGRADE_RETRY_PAUSE_MS));
    process.exit(1);
  }
}

import { dirname, join } from "node:path";
import { connect } from "nats";
import { openStateDatabase } from "../db/state-boundary.js";
import { runtimeStateDatabasePaths } from "../db/state-paths.js";
import { managedRuntimeBundlePath } from "../managed-runtime.js";
import { getPm2Processes, runPm2, type Pm2Process } from "../pm2.js";
import type { MaintenanceProcess } from "../runtime-maintenance.js";
import { readRuntimeBootReceipt, runtimeBundleFingerprint } from "../runtime-process-identity.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  adoptThreadFenceAsSuccessor,
  type DurableResidue,
  type ManagedRegistration,
  type ThreadFenceAdoption,
} from "./fence-adoption.js";
import {
  collectJetStreamResidue,
  collectSqliteResidue,
  type JetStreamResidueReader,
  LEGACY_RESIDUE_EXCLUSIONS,
  legacyBridgeDatabasePath,
  legacyResidueRules,
  mergeResidue,
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
 * rules, read only, before any stop. Advisory: work in flight now is normal and drains with the
 * stop; a row that only a dead process could settle (a queued handoff, an applying grant) is
 * already here and will block the window, so the operator clears it first (RUNBOOK). The broker is
 * not read: its residue is what the stop itself drains.
 */
export function previewLiveSqliteResidue(databasePath: string): DurableResidue {
  return collectSqliteResidue(
    legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
  );
}

/** Read only after both predecessors exited: router database, broker, and the excluded tables. */
export async function liveResidue(
  databasePath: string,
  withReader: (
    use: (reader: JetStreamResidueReader) => Promise<DurableResidue>,
  ) => Promise<DurableResidue> = withLiveJetStreamReader,
): Promise<DurableResidue> {
  const sqlite = collectSqliteResidue(
    legacyResidueRules(databasePath, legacyBridgeDatabasePath(databasePath), legacyStateDatabasePaths(databasePath)),
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
  } = { registry: liveRegistrations, bundleDigest: liveBundleDigest, pid: process.pid },
): ThreadFenceAdoption {
  const databasePath = join(stateDir, "ravi.db");
  return adoptThreadFenceAsSuccessor({
    stateDir,
    registry: host.registry,
    bundleDigest: host.bundleDigest,
    self: { pid: host.pid },
    // The successor re-derives the SQLite residue itself instead of trusting the coordinator's record.
    residue: () =>
      collectSqliteResidue(
        legacyResidueRules(
          databasePath,
          legacyBridgeDatabasePath(databasePath),
          legacyStateDatabasePaths(databasePath),
        ),
      ),
    open: () => {
      const database = openStateDatabase(databasePath);
      try {
        prepareRegisteredThreadFence(database);
      } finally {
        database.close();
      }
    },
  });
}

import { join } from "node:path";
import { connect } from "nats";
import { openStateDatabase } from "../db/state-boundary.js";
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
  legacyResidueRules,
  mergeResidue,
} from "./fence-adoption-residue.js";
import { prepareRegisteredThreadFence } from "./schema-fence.js";

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

/** Read only after both predecessors exited: router database, broker, and the excluded tables. */
export async function liveResidue(databasePath: string): Promise<DurableResidue> {
  const sqlite = collectSqliteResidue(legacyResidueRules(databasePath));
  let broker: DurableResidue;
  try {
    broker = await withLiveJetStreamReader((reader) => collectJetStreamResidue(reader));
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
export function adoptThreadFenceAtEntry(stateDir = getRaviStateDir()): ThreadFenceAdoption {
  return adoptThreadFenceAsSuccessor({
    stateDir,
    registry: liveRegistrations,
    bundleDigest: liveBundleDigest,
    self: { pid: process.pid },
    open: () => {
      const database = openStateDatabase(join(stateDir, "ravi.db"));
      try {
        prepareRegisteredThreadFence(database);
      } finally {
        database.close();
      }
    },
  });
}

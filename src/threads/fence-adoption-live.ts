import { join } from "node:path";
import { openStateDatabase } from "../db/state-boundary.js";
import { managedRuntimeBundlePath } from "../managed-runtime.js";
import { getPm2Processes } from "../pm2.js";
import { runtimeBundleFingerprint } from "../runtime-process-identity.js";
import { getRaviStateDir } from "../utils/paths.js";
import { adoptThreadFenceAsSuccessor, type ManagedRegistration, type ThreadFenceAdoption } from "./fence-adoption.js";
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

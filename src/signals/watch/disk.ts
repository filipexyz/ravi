import type { SignalProbeResult } from "../probes.js";
import { probeSignal } from "../probes.js";
import { dbGetNonTerminalSignalByKey } from "../signal-db.js";
import { raiseSignal } from "../service.js";

export const DISK_SIGNAL_KEY = "host.disk.free";
export const DISK_OPEN_BELOW_PCT = 15;
export const DISK_CLEAR_AT_OR_ABOVE_PCT = 20;
export const DISK_RECHECK_MS = 5 * 60_000;
export const DISK_GRACE_MS = 10 * 60_000;
export const DISK_COOLDOWN_MS = 6 * 3_600_000;
export const DISK_RENOTIFY_MS = 60 * 60_000;
export const DISK_TTL_MS = 24 * 3_600_000;
export const DISK_REOPEN_MS = 24 * 3_600_000;

export interface DiskWatcherResult {
  id: string;
  raised: boolean;
  resolved: boolean;
  error?: string;
  value?: number;
}

export interface DiskWatcherInput {
  now?: number;
  execute?: boolean;
  probe?: (probeId: string) => SignalProbeResult & { error?: string };
}

export function runDiskWatcher(input: DiskWatcherInput = {}): DiskWatcherResult {
  const now = input.now ?? Date.now();
  const probe = input.probe ?? ((probeId: string) => probeSignal(probeId));
  const result = probe("host.disk");
  if (result.error) {
    return { id: "signals.watch.disk", raised: false, resolved: false, error: result.error };
  }
  const freePct = Number(result.fields.free_pct);
  if (!Number.isFinite(freePct)) {
    return { id: "signals.watch.disk", raised: false, resolved: false, error: "disk probe missing free_pct" };
  }
  const existing = dbGetNonTerminalSignalByKey(DISK_SIGNAL_KEY);
  const shouldRefresh = Boolean(existing) && freePct < DISK_CLEAR_AT_OR_ABOVE_PCT;
  const shouldOpen = freePct < DISK_OPEN_BELOW_PCT;
  if (!shouldOpen && !shouldRefresh) {
    return { id: "signals.watch.disk", raised: false, resolved: false, value: freePct };
  }
  if (!input.execute) {
    return { id: "signals.watch.disk", raised: false, resolved: false, value: freePct };
  }
  const path = String(result.fields.path ?? "state volume");
  const freeGb = Number(result.fields.free_bytes ?? 0) / 1_000_000_000;
  const totalGb = Number(result.fields.total_bytes ?? 0) / 1_000_000_000;
  raiseSignal({
    key: DISK_SIGNAL_KEY,
    kind: "fact",
    producerId: "signals.watch.disk",
    producerClass: "code",
    producerType: "code",
    scopeType: "fleet",
    scopeId: "fleet",
    severity: "page",
    title: `Disk free below ${DISK_OPEN_BELOW_PCT}%`,
    detail: `${path}: ${freePct}% free (${freeGb.toFixed(1)} GB of ${totalGb.toFixed(1)} GB)`,
    evidence: {
      metric: "free_pct",
      value: freePct,
      threshold: DISK_OPEN_BELOW_PCT,
      path,
      free_bytes: result.fields.free_bytes,
      total_bytes: result.fields.total_bytes,
      checked_at: new Date(result.checkedAt ?? now).toISOString(),
    },
    clearWhen: {
      type: "probe",
      probe: "host.disk",
      expr: `free_pct >= ${DISK_CLEAR_AT_OR_ABOVE_PCT}`,
      recheck_ms: DISK_RECHECK_MS,
      grace_ms: DISK_GRACE_MS,
    },
    cooldownMs: DISK_COOLDOWN_MS,
    renotifyAfterMs: DISK_RENOTIFY_MS,
    escalateAfterMs: 0,
    maxSurfaces: 3,
    ttlMs: DISK_TTL_MS,
    reopenAfterMs: DISK_REOPEN_MS,
    now,
  });
  return { id: "signals.watch.disk", raised: true, resolved: false, value: freePct };
}

import type { DaemonSchemaPhase } from "../db/daemon-schema-owner.js";
import { MANAGED_RUNTIME_READY_TIMEOUT_MS } from "../db/state-boundary.js";

/**
 * The first start of the daemon, on a machine that never ran one.
 *
 * `pm2 start` returns once PM2 has launched the process. On a new installation the daemon creates
 * the state database as it boots, and until it has finished, every CLI command that reads state
 * answers `STATE_SCHEMA_NOT_READY`: the CLI never creates a store in real state (`db/state-boundary.ts`).
 * `ravi daemon start` therefore waits here before it returns, so the command the error message tells
 * the operator to run is the command after which the next one works.
 *
 * Readiness is the evidence the restart supervisor requires, never PM2's word: the process is
 * `online` and this incarnation published the `ready` receipt (`db/daemon-schema-owner.ts`), which
 * the daemon writes right before it logs `Daemon ready`. `online` and a live PID only say that the
 * process was launched (spec `daemon/schema-owner`).
 */

/** Covers the state guard's PM2 bound plus boot, like the restart supervisor's own wait. */
export const DEFAULT_DAEMON_START_READY_TIMEOUT_MS = MANAGED_RUNTIME_READY_TIMEOUT_MS;
export const DEFAULT_DAEMON_START_POLL_MS = 1_000;

/** PM2 statuses that do not turn into `online` on their own: waiting longer cannot help. */
const FINAL_PM2_STATUSES: ReadonlySet<string> = new Set(["stopped", "errored"]);

export interface DaemonStartCandidate {
  pid: number;
  status: string;
  /** PM2 `pm_uptime`: the start of this PID, which ties a receipt to this incarnation. */
  startedAt?: number | null;
}

export interface DaemonStartReadyDeps {
  /** The `ravi` process as PM2 lists it now; undefined when PM2 does not list it or could not be read. */
  daemon: () => DaemonStartCandidate | undefined;
  /** The phase this incarnation published, or null without evidence for exactly this PID and start. */
  phase: (candidate: { pid: number; startedAt?: number }) => DaemonSchemaPhase | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

export type DaemonStartReadiness =
  | { ready: true; waitedMs: number }
  | { ready: false; reason: "timeout" | "stopped"; waitedMs: number };

/** Resolves when the daemon has prepared its state, or says why it will not. It never throws and never waits past the bound. */
export async function waitForDaemonStateReady(deps: DaemonStartReadyDeps): Promise<DaemonStartReadiness> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DAEMON_START_READY_TIMEOUT_MS;
  const pollMs = Math.max(1, deps.pollMs ?? DEFAULT_DAEMON_START_POLL_MS);
  const startedAt = deps.now();

  for (;;) {
    const daemon = deps.daemon();
    const waitedMs = deps.now() - startedAt;
    if (
      daemon?.status === "online" &&
      deps.phase({ pid: daemon.pid, startedAt: daemon.startedAt ?? undefined }) === "ready"
    )
      return { ready: true, waitedMs };
    if (daemon && FINAL_PM2_STATUSES.has(daemon.status)) return { ready: false, reason: "stopped", waitedMs };
    if (waitedMs >= timeoutMs) return { ready: false, reason: "timeout", waitedMs };
    // The last sleep ends at the bound, so the check above runs once more exactly there.
    await deps.sleep(Math.min(pollMs, timeoutMs - waitedMs));
  }
}

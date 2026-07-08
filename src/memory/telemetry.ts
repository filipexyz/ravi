/**
 * R22 — measure the gate.
 *
 * Every curation cycle emits one structured event so eval / dashboards can
 * compute precision (fraction of saves later confirmed useful) and conflict /
 * staleness rate against the live snapshot. Also feeds R23 (recall-miss
 * audit): a session with a clear user correction that yields a cycle event
 * with `proposed=0` is a flagged miss.
 *
 * Topic is namespaced under `ravi.memory.*` to match the existing NATS layout
 * (see nats.ts). Emission is fire-and-forget — telemetry failure MUST NOT
 * break the curator (R2 best-effort).
 */

import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";

const log = logger.child("memory:telemetry");

export const MEMORY_CURATION_CYCLE_TOPIC = "ravi.memory.curation.cycle";

export type CurationSkipReason =
  | "R4:env-failure"
  | "R4:claim-negativo-tool"
  | "R4:one-off-narrative"
  | "R5:skill-candidate"
  | "R9:injection-blocked"
  | "R9b:credential-rejected"
  | "R9b:credential-redacted"
  | "R10:drift-refused"
  | "R11:consolidation-thrash"
  | "R14:conflict-staged"
  | "R14:conflict-unresolved"
  | "R15:staleness-staged"
  | "R20:spec-candidate"
  | "R20:vault-candidate"
  | "R20:skill-candidate";

export interface CurationCycleTelemetry {
  agentId: string;
  cadenceTurn: number;
  proposed: number;
  saved: number;
  skipped: number;
  stagedHitl: number;
  consolidations: number;
  sessionKey?: string;
  sessionName?: string;
  originator?: string;
  originatorSession?: string;
  taskId?: string;
  hookId?: string;
  dryRun?: boolean;
  driftDetected?: boolean;
  capBytesLimit?: number;
  capBytesBefore?: number;
  capBytesAfter?: number;
  skipReasons?: Partial<Record<CurationSkipReason, number>>;
  /**
   * Optional signal that the session had a foreground correction/preference
   * from the user. When true and `saved === 0`, R23 flags this as a recall
   * miss (not silently accepted).
   */
  hadUserCorrection?: boolean;
}

export interface EmitCurationCycleOptions {
  now?: number;
  publish?: (topic: string, data: Record<string, unknown>) => Promise<void>;
}

/**
 * Emit one curation-cycle telemetry event. Best-effort: any transport error
 * is logged and swallowed so callers stay non-blocking.
 */
export async function emitCurationCycleEvent(
  telemetry: CurationCycleTelemetry,
  options: EmitCurationCycleOptions = {},
): Promise<void> {
  const emittedAt = options.now ?? Date.now();
  const recallMiss = telemetry.hadUserCorrection === true && telemetry.saved === 0;
  const payload = {
    emittedAt,
    topic: MEMORY_CURATION_CYCLE_TOPIC,
    ...telemetry,
    recallMiss,
  };
  const publish = options.publish ?? nats.emit;
  try {
    await publish(MEMORY_CURATION_CYCLE_TOPIC, payload);
  } catch (err) {
    log.warn("Failed to emit curation cycle telemetry (best-effort)", {
      agentId: telemetry.agentId,
      cadenceTurn: telemetry.cadenceTurn,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

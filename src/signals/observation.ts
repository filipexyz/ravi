import type { SignalObservationStatus, SignalRecord, SignalTickState } from "./types.js";

export interface RenderedObservation {
  status: SignalObservationStatus;
  /** The stored evaluation time, never the render time; null when nothing was evaluated yet. */
  observedAt: number | null;
  /** The real error of the last evaluation when it failed. */
  error: string | null;
}

/**
 * The cached observation as render and the OOB gate see it (invariants 3, 15,
 * 24 and 28). Staleness compares the clock against the last successful tick,
 * not the age of the observation alone.
 *
 * `evaluatedAt` is the time of a tick that is running right now: a successful
 * evaluation it just stored is fresh even though the tick has not finished.
 */
export function readSignalObservation(
  signal: Pick<SignalRecord, "lastEvalAt" | "lastEvalError">,
  tickState: Pick<SignalTickState, "lastSuccessfulTickAt" | "staleAfterMs">,
  now: number,
  options: { evaluatedAt?: number } = {},
): RenderedObservation {
  const observedAt = signal.lastEvalAt ?? null;
  if (observedAt === null) return { status: "unknown", observedAt: null, error: null };
  if (signal.lastEvalError) return { status: "unknown", observedAt, error: signal.lastEvalError };
  if (options.evaluatedAt !== undefined && observedAt === options.evaluatedAt) {
    return { status: "fresh", observedAt, error: null };
  }
  const anchor = tickState.lastSuccessfulTickAt;
  if (anchor === null || now - anchor > tickState.staleAfterMs) {
    return { status: "stale", observedAt, error: null };
  }
  return { status: "fresh", observedAt, error: null };
}

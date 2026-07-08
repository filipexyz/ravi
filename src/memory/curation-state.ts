/**
 * R1 / R1b — deterministic cadence counter per session, resume-aligned.
 *
 * Stored inside SessionEntry.runtimeSessionParams so it survives restart
 * automatically (the params column is persisted). R1b resume-align falls out
 * for free: on boot the counter reads the last serialized value from disk
 * rather than zero.
 */

import type { SessionEntry } from "../router/index.js";

export interface MemoryCurationSessionState {
  turnCount: number;
  lastCuratedTurn: number;
  cadenceTurns: number;
}

const STATE_KEY = "memoryCuration";

interface RawState {
  turnCount?: unknown;
  lastCuratedTurn?: unknown;
  cadenceTurns?: unknown;
}

/**
 * Read the curation state from a session's runtimeSessionParams. Absent state
 * returns a fresh zero-initialized snapshot for the requested cadence — never
 * throws (R26 cold-start applies to counter too).
 */
export function readMemoryCurationState(
  session: Pick<SessionEntry, "runtimeSessionParams">,
  cadenceTurns: number,
): MemoryCurationSessionState {
  const container = session.runtimeSessionParams ?? {};
  const raw = (container as Record<string, unknown>)[STATE_KEY] as RawState | undefined;
  const turnCount = toNonNegInt(raw?.turnCount, 0);
  const lastCuratedTurn = toNonNegInt(raw?.lastCuratedTurn, 0);
  const storedCadence = toNonNegInt(raw?.cadenceTurns, cadenceTurns);
  return {
    turnCount,
    lastCuratedTurn,
    cadenceTurns: storedCadence > 0 ? storedCadence : cadenceTurns,
  };
}

/**
 * Compose the next runtimeSessionParams payload with an updated curation
 * state. Preserves any other keys already present (e.g. skillVisibility).
 */
export function writeMemoryCurationState(
  session: Pick<SessionEntry, "runtimeSessionParams">,
  next: MemoryCurationSessionState,
): Record<string, unknown> {
  const base = { ...(session.runtimeSessionParams ?? {}) } as Record<string, unknown>;
  base[STATE_KEY] = { ...next };
  return base;
}

/**
 * Advance the counter and decide whether this turn triggers curation.
 *
 * A cycle fires when `nextTurnCount % cadenceTurns === 0` AND the current
 * turn is strictly greater than the last curated turn. Returns the updated
 * state alongside a boolean the caller uses to gate task creation.
 */
export function advanceCurationCounter(current: MemoryCurationSessionState): {
  next: MemoryCurationSessionState;
  shouldCurate: boolean;
} {
  const cadence = current.cadenceTurns > 0 ? current.cadenceTurns : 1;
  const nextTurn = current.turnCount + 1;
  const shouldCurate = nextTurn % cadence === 0 && nextTurn > current.lastCuratedTurn;
  const next: MemoryCurationSessionState = {
    turnCount: nextTurn,
    lastCuratedTurn: shouldCurate ? nextTurn : current.lastCuratedTurn,
    cadenceTurns: cadence,
  };
  return { next, shouldCurate };
}

function toNonNegInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return fallback;
}

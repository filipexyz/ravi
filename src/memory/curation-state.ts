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
  /**
   * R27 — `messages.id` (SQLite AUTOINCREMENT cursor, src/db.ts) already
   * covered by the last curation cycle for this session. The dispatch_task
   * profileInputJson passes this through as `since_message_id` so the
   * curator reads only rows from `messages` strictly after this id instead
   * of the whole session history every cadence tick. Sourcing from the
   * `messages` table (not a hand-maintained transcript file) means this
   * works uniformly for every agent/session — there's nothing per-agent to
   * provision or keep in sync.
   */
  lastCuratedMessageId: number;
}

const STATE_KEY = "memoryCuration";

interface RawState {
  turnCount?: unknown;
  lastCuratedTurn?: unknown;
  cadenceTurns?: unknown;
  lastCuratedMessageId?: unknown;
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
  const lastCuratedMessageId = toNonNegInt(raw?.lastCuratedMessageId, 0);
  return {
    turnCount,
    lastCuratedTurn,
    cadenceTurns: storedCadence > 0 ? storedCadence : cadenceTurns,
    lastCuratedMessageId,
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
    // lastCuratedMessageId does NOT move here. It advances when the curator
    // task completes (runtime-driven, advanceWatermarkForCompletedCuratorTask
    // in watermark-commit.ts) or as a fallback on a successful guard write —
    // never as a side effect of bumping the turn counter, which must not assume
    // the read actually happened.
    lastCuratedMessageId: current.lastCuratedMessageId,
  };
  return { next, shouldCurate };
}

/**
 * R27 — called by `ravi memory guard`/the curator's completion path once a
 * cycle finishes successfully, recording the highest `messages.id` (src/db.ts)
 * it read. Next cycle's profileInputJson uses this as `since_message_id` so
 * the curator only reads rows added after it, not the whole session history.
 */
export function markCurationMessageProcessed(
  session: Pick<SessionEntry, "runtimeSessionParams">,
  cadenceTurns: number,
  processedThroughMessageId: number,
): Record<string, unknown> {
  const current = readMemoryCurationState(session, cadenceTurns);
  const next: MemoryCurationSessionState = {
    ...current,
    lastCuratedMessageId: Math.max(current.lastCuratedMessageId, processedThroughMessageId),
  };
  return writeMemoryCurationState(session, next);
}

function toNonNegInt(value: unknown, fallback: number): number {
  // m10: sanity clamp — a corrupted state file with an absurd counter
  // (e.g. 1e18) would otherwise keep incrementing forever. 10M turns/session
  // is ~1000+ years of use; beyond that, treat the value as corrupt.
  const MAX_SANE = 10_000_000;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const floored = Math.floor(value);
    return floored > MAX_SANE ? fallback : floored;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed > MAX_SANE ? fallback : parsed;
    }
  }
  return fallback;
}

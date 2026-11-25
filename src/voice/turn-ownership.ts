/**
 * Which session terminal event ends this voice turn.
 *
 * The door watches the whole session's runtime topic, where every prompt of
 * the session reports. Two facts make the generic `sessions send --wait`
 * heuristic unsafe here:
 * - Claude emits no `turn.started`, so "seen own turn started" never flips;
 * - any other prompt that queues on the session also emits `dispatch.queued`.
 *
 * So the door tags its prompt with a correlation id, and only its own
 * `dispatch.queued` counts. When that prompt queued behind a turn in flight,
 * exactly one terminal (that turn's) comes first; the next terminal is this
 * turn's. Prompts queued together behind the same turn are delivered together,
 * so one terminal ahead is the whole wait.
 */

/** Queue reasons that mean a turn was in flight when the prompt queued. */
const TURN_AHEAD_REASONS = new Set(["response", "tool", "tool_result_delivery", "active_task", "waiting_for_barrier"]);

export const VOICE_TURN_TERMINAL_TYPES = new Set(["turn.complete", "turn.failed", "turn.interrupted"]);

export interface VoiceTurnOwnership {
  correlationId: string;
  /** This turn's own prompt reported as queued. */
  ownQueued: boolean;
  /** Terminal events that belong to turns ahead of this one. */
  terminalsAhead: number;
  /** This turn reached the runtime (turn.started after the turns ahead, or a terminal of its own). */
  started: boolean;
}

export function createVoiceTurnOwnership(correlationId: string): VoiceTurnOwnership {
  return { correlationId, ownQueued: false, terminalsAhead: 0, started: false };
}

export type VoiceTurnOwnershipVerdict = "own_terminal" | "ahead_terminal" | "other";

/**
 * Fold one runtime event into the ownership state. `verdict` says what the
 * event means for this turn: its own terminal, a terminal of a turn ahead
 * (the transcript cursor must move past that turn's reply), or neither.
 */
export function noteVoiceTurnRuntimeEvent(
  state: VoiceTurnOwnership,
  event: Record<string, unknown>,
): { state: VoiceTurnOwnership; verdict: VoiceTurnOwnershipVerdict } {
  const type = event.type;
  if (type === "dispatch.queued") {
    if (event.correlationId !== state.correlationId || state.ownQueued) return { state, verdict: "other" };
    const ahead = typeof event.reason === "string" && TURN_AHEAD_REASONS.has(event.reason) ? 1 : 0;
    return { state: { ...state, ownQueued: true, terminalsAhead: ahead }, verdict: "other" };
  }
  if (type === "turn.started") {
    return state.terminalsAhead === 0
      ? { state: { ...state, started: true }, verdict: "other" }
      : { state, verdict: "other" };
  }
  if (typeof type === "string" && VOICE_TURN_TERMINAL_TYPES.has(type)) {
    if (state.terminalsAhead > 0) {
      return { state: { ...state, terminalsAhead: state.terminalsAhead - 1 }, verdict: "ahead_terminal" };
    }
    return { state: { ...state, started: true }, verdict: "own_terminal" };
  }
  return { state, verdict: "other" };
}

/** A turn ahead is still running: an abort now would stop someone else's turn. */
export function voiceTurnHasTurnAhead(state: VoiceTurnOwnership): boolean {
  return state.terminalsAhead > 0;
}

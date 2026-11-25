/**
 * Which session runtime events belong to this voice turn.
 *
 * The door watches the whole session's runtime topic, where every turn of the
 * session reports. Heuristics on event order fail there: Claude emits no
 * `turn.started`, isolated prompts queued ahead run as separate turns, and a
 * prompt queued during compaction still has a turn ahead of it.
 *
 * So ownership is explicit. The door's prompt carries `_correlationId`, and the
 * host stamps every runtime event of a physical turn with the
 * `_correlationIds` of the prompts that turn consumed. A terminal carrying this
 * turn's id is its own; any other terminal is a turn ahead, whose reply the
 * transcript cursor moves past.
 */

export const VOICE_TURN_TERMINAL_TYPES = new Set(["turn.complete", "turn.failed", "turn.interrupted"]);

export interface VoiceTurnOwnership {
  correlationId: string;
  /** A runtime event of this turn's own physical turn has been seen. */
  started: boolean;
}

export function createVoiceTurnOwnership(correlationId: string): VoiceTurnOwnership {
  return { correlationId, started: false };
}

export type VoiceTurnOwnershipVerdict = "own_terminal" | "other_terminal" | "own_event" | "other";

function carriesId(event: Record<string, unknown>, id: string): boolean {
  const ids = event._correlationIds;
  return Array.isArray(ids) && ids.includes(id);
}

/** Fold one runtime event into the ownership state and say what it means for this turn. */
export function noteVoiceTurnRuntimeEvent(
  state: VoiceTurnOwnership,
  event: Record<string, unknown>,
): { state: VoiceTurnOwnership; verdict: VoiceTurnOwnershipVerdict } {
  const own = carriesId(event, state.correlationId);
  const type = event.type;
  if (typeof type === "string" && VOICE_TURN_TERMINAL_TYPES.has(type)) {
    return own ? { state: { ...state, started: true }, verdict: "own_terminal" } : { state, verdict: "other_terminal" };
  }
  if (own) return { state: { ...state, started: true }, verdict: "own_event" };
  return { state, verdict: "other" };
}

export type SessionSendWaitState = {
  queuedBehindActiveTurn: boolean;
  seenOwnTurnStarted: boolean;
};

export const SESSION_SEND_TERMINAL_TYPES = new Set(["turn.complete", "turn.failed", "turn.interrupted"]);

export function createSessionSendWaitState(): SessionSendWaitState {
  return {
    queuedBehindActiveTurn: false,
    seenOwnTurnStarted: false,
  };
}

export function noteSessionSendWaitRuntimeEvent(state: SessionSendWaitState, type: unknown): SessionSendWaitState {
  if (type === "dispatch.queued") {
    return { ...state, queuedBehindActiveTurn: true };
  }
  if (type === "turn.started") {
    return { ...state, seenOwnTurnStarted: true };
  }
  return state;
}

export function isSessionSendWaitTerminal(state: SessionSendWaitState, type: unknown): boolean {
  if (typeof type !== "string" || !SESSION_SEND_TERMINAL_TYPES.has(type)) {
    return false;
  }
  if (state.seenOwnTurnStarted) {
    return true;
  }
  // Single-send fallback: we subscribed before publish, so a terminal without
  // dispatch.queued belongs to this send (turn.started may have been missed).
  // After an overlap queue, ignore the in-flight turn's terminal.
  return !state.queuedBehindActiveTurn;
}

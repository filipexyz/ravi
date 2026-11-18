/** These retire a credential without cancelling work already admitted from it. */
export function isOrdinaryTurnCompletionRevocation(reason: unknown): boolean {
  return (
    reason === "turn_context_rotated" ||
    reason === "turn_context_completed" ||
    reason === "stale_turn_context_reclaimed"
  );
}

/**
 * A human request a turn already handed off survives that turn ending, and
 * also its abort: a turn is aborted when a newer message interrupts it or the
 * runtime stops it, which says nothing about whether the person still wants
 * the work they asked for. Withdrawals stay fail-closed: an explicit revoke,
 * a profile reduction, a context that stopped being live and an actor who is
 * no longer eligible all carry other reasons.
 */
export function isHandoffPreservingRevocation(reason: unknown): boolean {
  return isOrdinaryTurnCompletionRevocation(reason) || reason === "turn_context_aborted";
}

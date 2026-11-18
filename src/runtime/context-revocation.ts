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
 * also a newer message superseding it (`turn_context_superseded`): the person
 * kept talking, they did not take the request back. Withdrawals stay
 * fail-closed: an explicit stop or any other abort (`turn_context_aborted`),
 * an explicit revoke, a profile reduction, a context that stopped being live
 * and an actor who is no longer eligible.
 */
export function isHandoffPreservingRevocation(reason: unknown): boolean {
  return isOrdinaryTurnCompletionRevocation(reason) || reason === "turn_context_superseded";
}

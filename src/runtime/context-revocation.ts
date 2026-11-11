/** These retire a credential without cancelling work already admitted from it. */
export function isOrdinaryTurnCompletionRevocation(reason: unknown): boolean {
  return (
    reason === "turn_context_rotated" ||
    reason === "turn_context_completed" ||
    reason === "stale_turn_context_reclaimed"
  );
}

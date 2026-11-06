/** Credential retirement ends a turn; it does not withdraw already admitted work. */
export function isOrdinaryContextRetirement(reason: unknown): boolean {
  return (
    reason === "turn_context_completed" ||
    reason === "turn_context_rotated" ||
    reason === "stale_turn_context_reclaimed"
  );
}

/**
 * Weak return-schema quality baseline.
 *
 * This list is now empty: all public return schemas have been strengthened
 * to concrete JSON-safe contracts. Default validation rejects any weak
 * public return schema; the baseline mechanism is retained only for
 * migration tooling compatibility.
 */

export const WEAK_PUBLIC_RETURN_COMMANDS_BASELINE: readonly string[] = [];

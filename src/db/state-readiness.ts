/**
 * The vocabulary for state that is not prepared for this release. This module
 * imports nothing, so the CLI's contract layer can recognize the condition
 * without loading the state boundary (SQLite, PM2, child processes).
 */

/** How the operator is told to have the installed daemon prepare state. `daemon restart` requires a reason. */
export const PREPARE_STATE_COMMAND = 'ravi daemon restart -m "prepare state"';

/** Whether an error, or what caused it, says that state is not prepared for this release. */
export function isStateNotReadyError(error: unknown): error is Error & { code: "STATE_SCHEMA_NOT_READY" } {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "STATE_SCHEMA_NOT_READY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

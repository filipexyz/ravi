/**
 * Trigger Filter Evaluator
 *
 * Evaluates filter expressions against event data.
 * Uses a restricted expression parser — no eval, no new Function().
 *
 * Syntax:
 *   data.<path> <operator> "<value>"
 *
 * Operators: ==, !=, startsWith, endsWith, includes
 *
 * Examples:
 *   data.cwd == "/Users/luis/Dev/fm"
 *   data.permission_mode != "bypassPermissions"
 *   data.cwd startsWith "/Users/luis/ravi"
 *   data.cwd endsWith "/copilot"
 *   data.cwd includes "Dev"
 */

import { logger } from "../utils/logger.js";

const log = logger.child("triggers:filter");

// Regex: captures `data.<path>`, operator, and quoted string (single or double)
const FILTER_RE = /^(data\.[a-zA-Z_][a-zA-Z0-9_.]*)\s+(==|!=|startsWith|endsWith|includes)\s+(['"])(.*?)\3\s*$/;

/**
 * Resolve a dot-notation path into an object.
 * e.g. "data.hook_event_name" with root { hook_event_name: "Stop" } -> "Stop"
 * The leading "data." is stripped before resolution.
 */
function resolvePath(obj: unknown, path: string): unknown {
  // Strip leading "data."
  const parts = path.replace(/^data\./, "").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a filter expression against event data.
 *
 * Returns true if:
 * - filter is undefined or empty (no filter = always fires)
 * - filter matches the data
 * - filter is invalid (fail open, logs warning)
 *
 * Returns false if the filter expression evaluates to false.
 */
export function evaluateFilter(filter: string | undefined, data: unknown): boolean {
  // No filter = always fire
  if (!filter || filter.trim() === "") {
    return true;
  }

  const match = FILTER_RE.exec(filter.trim());
  if (!match) {
    log.warn("Trigger filter: invalid syntax, failing open", { filter });
    return true;
  }

  const [, path, operator, , expected] = match;

  const rawValue = resolvePath(data, path);

  // Non-existent path = no match (not a crash)
  if (rawValue === undefined) {
    return false;
  }

  // Coerce value to string for comparison
  const value = String(rawValue);

  switch (operator) {
    case "==":
      return value === expected;
    case "!=":
      return value !== expected;
    case "startsWith":
      return value.startsWith(expected);
    case "endsWith":
      return value.endsWith(expected);
    case "includes":
      return value.includes(expected);
    default:
      // Should not happen given the regex, but fail open
      log.warn("Trigger filter: unknown operator, failing open", { operator, filter });
      return true;
  }
}

/**
 * Caller working directory for remote CLI dispatch.
 *
 * Isolated CLIs and SDK gateway handlers run in the daemon process, so
 * relative file arguments such as `--html ./index.html` must resolve against
 * the caller's cwd, not `process.cwd()` on the host.
 *
 * Protocol:
 * - Remote CLI sends `x-ravi-cwd` on every gateway POST.
 * - `dispatch()` also accepts `cwd` in `DispatchOptions` and a reserved body
 *   field when the command does not already declare `cwd`.
 * - Handlers read it through {@link getCallerCwd} / {@link resolveCallerPath}.
 * - The value is only used for path resolution. It does not change auth or scope.
 */

import { isAbsolute, resolve } from "node:path";
import { getContext } from "./context.js";

export const CALLER_CWD_HEADER = "x-ravi-cwd";
export const MAX_CALLER_CWD_LENGTH = 4096;

export type CallerCwdParseResult = { ok: true; cwd: string | undefined } | { ok: false; reason: string };

export function parseCallerCwd(value: unknown): CallerCwdParseResult {
  if (value === undefined || value === null) return { ok: true, cwd: undefined };
  if (typeof value !== "string") return { ok: false, reason: "Caller cwd must be a string." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, cwd: undefined };
  if (trimmed.length > MAX_CALLER_CWD_LENGTH) return { ok: false, reason: "Caller cwd is too long." };
  if (trimmed.includes("\0")) return { ok: false, reason: "Caller cwd is invalid." };
  if (!isAbsolute(trimmed)) return { ok: false, reason: "Caller cwd must be an absolute path." };
  return { ok: true, cwd: trimmed };
}

/** Resolve the caller's working directory; fall back to this process cwd. */
export function getCallerCwd(): string {
  const parsed = parseCallerCwd(getContext({ localOnly: true })?.cwd);
  return parsed.ok && parsed.cwd ? parsed.cwd : process.cwd();
}

/** Resolve a CLI file argument against the caller cwd when it is relative. */
export function resolveCallerPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || isAbsolute(trimmed)) return trimmed;
  return resolve(getCallerCwd(), trimmed);
}

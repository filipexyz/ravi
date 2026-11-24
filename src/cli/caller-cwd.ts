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
 *
 * The daemon reads and writes these paths with its own filesystem authority,
 * so in a runtime context {@link resolveCallerPath} also checks that the
 * caller may read (`use:tool:Read`) or write (`use:tool:Write`) local files,
 * the same tools it would need to touch them directly.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { providerConfigWriteDenial, isActorBreakGlassLimited } from "../permissions/provider-config-paths.js";
import { canWithCapabilityContext } from "../permissions/provider-runtime.js";
import { getContext } from "./context.js";
import { CliExpectedError } from "./expected-error.js";

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

export type CallerPathMode = "read" | "write";

/**
 * Resolve a CLI file argument against the caller cwd when it is relative, and
 * refuse it when the calling runtime context cannot read or write local files.
 */
export function resolveCallerPath(path: string, mode: CallerPathMode = "read"): string {
  // A leading `~` is the home directory, as a shell would read it: values from a
  // profile or the gateway arrive unexpanded, and the path handed to a worker
  // must be the one checked here.
  const trimmed = path.trim().replace(/^~(?=\/|$)/, homedir());
  const resolved = !trimmed || isAbsolute(trimmed) ? trimmed : resolve(getCallerCwd(), trimmed);
  assertCallerFileAccess(resolved || getCallerCwd(), mode);
  return resolved;
}

/** Authorize an exact filesystem path without trimming manifest filenames. */
export function assertCallerFileAccess(path: string, mode: CallerPathMode): void {
  const ctx = getContext();
  const context = ctx?.context;
  if (!context) return;
  const can = (permission: string, objectType: string, objectId: string) =>
    canWithCapabilityContext(context, permission, objectType, objectId);
  const tool = mode === "write" ? "Write" : "Read";
  const allowed = can("use", "tool", tool) || can("execute", "executable", "*") || can("admin", "system", "*");
  const denial = !allowed
    ? `Permission denied: this context cannot ${mode} local files (${path}); it needs use:tool:${tool}`
    : mode === "write"
      ? providerConfigWriteDenial({
          can,
          agentId: ctx?.agentId ?? context.agentId,
          targets: [path],
          // A limited person's workspace is the authenticated session's, never the cwd the
          // caller declares (`x-ravi-cwd` is chosen by the caller: a `cd` would move it).
          cwd: isActorBreakGlassLimited(context) ? authenticatedSessionWorkspace(context) : getCallerCwd(),
          restrictToWorkspace: isActorBreakGlassLimited(context),
        })
      : undefined;
  if (denial) {
    throw new CliExpectedError(denial, "PERMISSION_DENIED", 1, "Ask the operator for file access, or use stdout");
  }
}

/**
 * The workspace of the session the runtime context was issued for, as the
 * runtime runs it (`expandHome(session.agentCwd)`). Without a session the
 * filesystem root is returned, which the write boundary never treats as a
 * workspace: only temp directories stay writable.
 */
function authenticatedSessionWorkspace(context: { sessionKey?: string }): string {
  if (!context.sessionKey) return "/";
  // Lazily required: the session store reaches the router DB, which reaches
  // the permissions modules that import this file.
  const { getSession } = require("../router/sessions.js") as typeof import("../router/sessions.js");
  const { expandHome } = require("../router/resolver.js") as typeof import("../router/resolver.js");
  const agentCwd = getSession(context.sessionKey)?.agentCwd;
  return agentCwd ? expandHome(agentCwd) : "/";
}

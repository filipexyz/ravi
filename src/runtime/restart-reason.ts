import { isAbsolute, join, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

/**
 * The restart reason is runtime state, so it lives in the state directory, not
 * in `$HOME`. With `RAVI_STATE_DIR` unset this is `~/.ravi/restart-reason.txt`,
 * the path every released daemon and the fence adoption already use.
 */
export function getRestartReasonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "restart-reason.txt");
}

/**
 * What the boot should announce. A reason file means the stop that preceded
 * this boot recorded its intent: use it. Without one, a plain `pm2 restart`
 * still deserves a notice, but only when there is a session to receive it; on
 * the first boot of an empty state nothing was restarted and nobody exists to
 * tell, so the boot stays quiet instead of inventing a `supervised_restart`.
 */
export function resolveBootRestartReason<T>(input: {
  fromFile: T | null;
  fallbackSessionExists: boolean;
  synthesize: () => T;
}): T | null {
  if (input.fromFile) return input.fromFile;
  if (!input.fallbackSessionExists) return null;
  return input.synthesize();
}

/**
 * A relative `RAVI_STATE_DIR` means "relative to the cwd of the process that
 * resolves it". The daemon resolves it against its own cwd, so it pins the
 * absolute path once, at boot: every child it starts (tool shells, workers)
 * then inherits one unambiguous directory.
 */
export function anchorStateDirEnv(env: NodeJS.ProcessEnv, cwd: string): void {
  const value = env.RAVI_STATE_DIR;
  if (value && !isAbsolute(value)) env.RAVI_STATE_DIR = resolve(cwd, value);
}

/**
 * `RAVI_STATE_DIR` as the detached restart worker must receive it, and the path
 * the caller must write `restart-reason.txt` in. An absolute value passes
 * through. A relative value was inherited from a daemon that predates the boot
 * anchor, and that daemon resolves it against its own cwd (`daemonCwd`, the
 * restart target's cwd): anchor it there, never at the caller's cwd, or the
 * successor would open a different, empty state directory. Unset or empty stays
 * unset (default `~/.ravi`).
 */
export function resolveHandoffStateDir(env: NodeJS.ProcessEnv, daemonCwd: string): string | undefined {
  const value = env.RAVI_STATE_DIR;
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(daemonCwd, value);
}

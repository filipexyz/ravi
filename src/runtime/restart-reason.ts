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
 * `RAVI_STATE_DIR` as the detached restart worker must receive it. The worker
 * starts in another cwd, so a relative value would resolve to a different
 * directory than the one the caller wrote `restart-reason.txt` in: anchor it to
 * the caller's cwd. Unset or empty stays unset.
 */
export function resolveHandoffStateDir(env: NodeJS.ProcessEnv, callerCwd: string): string | undefined {
  const value = env.RAVI_STATE_DIR;
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(callerCwd, value);
}

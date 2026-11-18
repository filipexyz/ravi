/**
 * Which state directory a test process must use. Test-only: never import from runtime code.
 *
 * The state boundary refuses the operator's real state (`~/.ravi`) to anything that is not the installed
 * runtime, so a test that falls back to the default path fails with "Refusing the real Ravi state database".
 * CI used to hide this by exporting RAVI_STATE_DIR in every job; any other environment (a developer's shell,
 * the ravi-stress container, a new CI job) turned dozens of unrelated tests red. The default preload makes
 * isolation a property of `bun test`, not of the caller's environment.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolves aliases even when the path itself does not exist yet. */
export function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * True when the process has no usable test state: RAVI_STATE_DIR is unset, blank, or points into the real
 * `~/.ravi`. An explicit directory outside it (CI's `$RUNNER_TEMP/ravi-ci-state`, a test's own sandbox) is kept.
 */
export function needsIsolatedState(env: Record<string, string | undefined>, home: string): boolean {
  const selected = env.RAVI_STATE_DIR?.trim();
  if (!selected) return true;
  return isWithin(canonicalPath(selected), canonicalPath(join(home, ".ravi")));
}

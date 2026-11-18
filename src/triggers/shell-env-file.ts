/**
 * Where a shell trigger's env file may live.
 *
 * The env file is what a shell trigger's command gets on purpose, on top of the
 * allowlisted agent env. A file inside the Ravi state dir (the daemon's own
 * `.env`, a credentials file) would hand the command every secret the
 * allowlist keeps out, so it is refused on create and edit, and the runner
 * does not run a trigger that points at one.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * The real path, so a symlink cannot hide the state dir. For a path that does
 * not exist yet, the nearest existing ancestor is resolved and the rest is
 * appended, so both sides of the comparison use the same real prefix (on macOS
 * `/var` is `/private/var`).
 */
function realOrResolved(path: string): string {
  let existing = resolve(expandHome(path));
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(existsSync(existing) ? realpathSync(existing) : existing, ...rest);
}

export function shellEnvFileInsideStateDir(envFile: string, stateDir: string = getRaviStateDir()): boolean {
  const file = realOrResolved(envFile);
  const dir = realOrResolved(stateDir);
  const fromDir = relative(dir, file);
  return fromDir === "" || (!fromDir.startsWith("..") && !isAbsolute(fromDir));
}

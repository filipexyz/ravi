/**
 * Where a shell trigger's env file may live.
 *
 * The env file is what a shell trigger's command gets on purpose, on top of the
 * allowlisted agent env. A file inside the Ravi state dir (the daemon's own
 * `.env`, a credentials file) would hand the command every secret the
 * allowlist keeps out, so it is refused on create and edit, and the runner
 * does not run a trigger that points at one.
 *
 * This is a path check at create and at fire time, not an access boundary.
 * The file can change between the check and the read, and the daemon and the
 * command run as the same OS user, so whoever can write the file system can
 * still reach the state dir. The check stops the plain mistakes and the known
 * tricks: `..`, symlinks and hard links.
 */

import { existsSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_ENV_FILE_BYTES } from "../cron/shell-executor.js";
import { getRaviStateDir } from "../utils/paths.js";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/** Absolute, without lexical normalization: `..` is left for the OS to resolve. */
function absoluteRaw(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : `${process.cwd()}/${expanded}`;
}

/**
 * `stat` of a path, which follows symlinks but never opens the file, or null
 * when it does not exist. Every check looks at this before any `realpath`:
 * Bun's `realpathSync` opens the path on macOS, and opening a FIFO blocks the
 * daemon's thread until someone writes to it.
 */
function statWithoutOpening(path: string): Stats | null {
  return existsSync(path) ? statSync(path) : null;
}

/**
 * The real path, so a symlink cannot hide the state dir. `realpath` runs only
 * on a regular file or a directory (see `statWithoutOpening`); an existing path
 * of any other type is resolved lexically and is refused elsewhere. An existing
 * path is resolved as given, the way the OS opens it (symlinks first, then
 * `..`). For a path that does not exist yet (it has no `..`, see below), the
 * nearest existing ancestor is resolved, only when it is a directory, and the
 * rest is appended, so both sides of the comparison share the same real prefix
 * (on macOS `/var` is `/private/var`).
 */
function realOrResolved(path: string): string {
  const raw = absoluteRaw(path);
  const stats = statWithoutOpening(raw);
  if (stats) return stats.isFile() || stats.isDirectory() ? realpathSync(raw) : resolve(raw);
  let existing = resolve(raw);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const ancestor = statWithoutOpening(existing);
  return join(ancestor?.isDirectory() ? realpathSync(existing) : existing, ...rest);
}

/**
 * True when the env file is, or may be, inside the state dir. A path with a
 * `..` segment counts as inside: the OS follows a symlink before applying the
 * `..` after it (`link/../.env`), which a lexical check cannot reproduce for a
 * file that does not exist yet.
 */
export function shellEnvFileInsideStateDir(envFile: string, stateDir: string = getRaviStateDir()): boolean {
  if (
    expandHome(envFile)
      .split(/[\\/]+/)
      .includes("..")
  )
    return true;
  const file = realOrResolved(envFile);
  const dir = realOrResolved(stateDir);
  const fromDir = relative(dir, file);
  if (fromDir === "") return true;
  // Outside only through a real parent segment: a child named `..secrets.env`
  // also starts with two dots and is inside.
  const outside = fromDir === ".." || fromDir.startsWith(`..${sep}`) || isAbsolute(fromDir);
  return !outside;
}

/** True when the env file exists and is not a regular file (a FIFO, a device, a directory, a socket). */
export function shellEnvFileNotRegular(envFile: string): boolean {
  const stats = statWithoutOpening(absoluteRaw(envFile));
  return stats !== null && !stats.isFile();
}

/**
 * True when the env file is a regular file with more than one hard link. A
 * hard link to the daemon's `.env` placed outside the state dir has its own
 * path, so no path check can see where its content lives; a file with one
 * link cannot be that.
 */
export function shellEnvFileHasHardLinks(envFile: string): boolean {
  const stats = statWithoutOpening(absoluteRaw(envFile));
  return stats !== null && stats.isFile() && stats.nlink > 1;
}

/**
 * True when the env file is a regular file larger than the most the loader
 * reads (`MAX_ENV_FILE_BYTES`). Refused here so the fire takes the
 * turn-off-and-notify path instead of failing in the loader on every event.
 */
export function shellEnvFileTooLarge(envFile: string): boolean {
  const stats = statWithoutOpening(absoluteRaw(envFile));
  return stats !== null && stats.isFile() && stats.size > MAX_ENV_FILE_BYTES;
}

export type ShellEnvFileRefusal = "in_state_dir" | "not_regular_file" | "hard_link" | "too_large";

/**
 * Why a shell trigger may not use this env file, or null when it may. The
 * type is checked first, without opening anything, so a FIFO or a device is
 * refused before any `realpath`: `in_state_dir` (inside, or a `..` that may
 * lead there), `not_regular_file`, `hard_link`, or `too_large` (more than the
 * loader reads).
 */
export function shellEnvFileRefusal(envFile: string, stateDir: string = getRaviStateDir()): ShellEnvFileRefusal | null {
  if (
    expandHome(envFile)
      .split(/[\\/]+/)
      .includes("..")
  )
    return "in_state_dir";
  if (shellEnvFileNotRegular(envFile)) return "not_regular_file";
  if (shellEnvFileInsideStateDir(envFile, stateDir)) return "in_state_dir";
  if (shellEnvFileHasHardLinks(envFile)) return "hard_link";
  if (shellEnvFileTooLarge(envFile)) return "too_large";
  return null;
}

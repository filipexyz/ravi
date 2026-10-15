/**
 * Private state files
 *
 * `ravi.db` holds sessions, contacts and runtime context records, and the
 * credential broker DB holds secret references. SQLite creates them with the
 * process umask (usually 0644), so on a shared host any local user could read
 * them even though the state dir itself is 0700 (a dir that was 0755 before
 * #627, or a db copied elsewhere, keeps the loose file mode).
 *
 * These helpers strip group/other bits from a file when it is a regular file
 * owned by the current user. Like `state-dir-permissions.ts` they never follow
 * a symlink (open with O_NOFOLLOW and fchmod the descriptor, after checking it
 * is still the file that was inspected), never chmod a file owned by somebody
 * else, honour RAVI_STATE_DIR_KEEP_PERMISSIONS=1, and never throw.
 *
 * SQLite gives `-wal` and `-shm` the mode of the database file, so once the db
 * is 0600 the journal files it creates later are 0600 too. Openers call
 * `preparePrivateSqliteFile()` before `new Database()`: a missing db is
 * created empty with mode 0600 (SQLite treats an empty file as a new
 * database), so there is no window in which it exists with the umask's mode.
 */

import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { formatMode, KEEP_STATE_DIR_PERMISSIONS_ENV } from "./state-dir-permissions.js";

const GROUP_OTHER_BITS = 0o077;
const OWNER_BITS = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const SQLITE_COMPANION_SUFFIXES = ["-wal", "-shm"] as const;

export type PrivateFileAction =
  | "tightened"
  | "already_private"
  | "missing"
  | "symlink"
  | "not_file"
  | "not_owner"
  | "opted_out"
  | "unsupported"
  | "error";

export interface PrivateFileResult {
  path: string;
  action: PrivateFileAction;
  /** e.g. "0644", null when unknown. */
  previousMode: string | null;
  mode: string | null;
  error?: string;
}

export interface PrivateFilesDeps {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  lstat?: (path: string) => Stats;
  /** Changes the mode without following symlinks; `inspected` is the lstat result it must still match. */
  chmod?: (path: string, mode: number, inspected: Stats) => void;
  env?: NodeJS.ProcessEnv;
}

function currentUid(deps: PrivateFilesDeps): number | undefined {
  if (deps.getuid) return deps.getuid();
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * fchmod through an O_NOFOLLOW descriptor, refusing when the path now names a
 * different file than the one inspected (swapped between lstat and open).
 * O_NONBLOCK keeps a FIFO planted at the path from blocking the open.
 */
function chmodFileNoFollow(path: string, mode: number, inspected: Stats): void {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== inspected.ino || opened.dev !== inspected.dev) {
      throw new Error("file changed while its permissions were being tightened");
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove group/other permission bits from `path` (0644 → 0600) when it is a
 * regular file owned by the current user. Missing files are reported, not
 * created. Never throws.
 */
export function ensurePrivateFile(path: string, deps: PrivateFilesDeps = {}): PrivateFileResult {
  const result = (
    action: PrivateFileAction,
    previous: number | null = null,
    extra: Partial<PrivateFileResult> = {},
  ): PrivateFileResult => ({
    path,
    action,
    previousMode: formatMode(previous),
    mode: formatMode(previous),
    ...extra,
  });

  if ((deps.platform ?? process.platform) === "win32") return result("unsupported");

  let stats: Stats;
  try {
    stats = (deps.lstat ?? lstatSync)(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return result("missing");
    return result("error", null, { error: errorMessage(error) });
  }

  const mode = stats.mode & 0o777;
  if (stats.isSymbolicLink()) return result("symlink", mode);
  if (!stats.isFile()) return result("not_file", mode);
  const uid = currentUid(deps);
  if (uid === undefined || stats.uid !== uid) return result("not_owner", mode);
  if ((mode & GROUP_OTHER_BITS) === 0) return result("already_private", mode);
  if ((deps.env ?? process.env)[KEEP_STATE_DIR_PERMISSIONS_ENV] === "1") return result("opted_out", mode);

  const nextMode = mode & OWNER_BITS;
  try {
    (deps.chmod ?? chmodFileNoFollow)(path, nextMode, stats);
    return result("tightened", mode, { mode: formatMode(nextMode) });
  } catch (error) {
    return result("error", mode, { error: errorMessage(error) });
  }
}

/** `ensurePrivateFile` for a SQLite database and its `-wal`/`-shm` companions. */
export function ensurePrivateSqliteFiles(dbPath: string, deps: PrivateFilesDeps = {}): PrivateFileResult[] {
  return [dbPath, ...SQLITE_COMPANION_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)].map((path) =>
    ensurePrivateFile(path, deps),
  );
}

export type CreatePrivateFileAction = "created" | "exists" | "skipped" | "unsupported" | "error";

/**
 * Create `path` as an empty 0600 file when nothing is there yet
 * (O_CREAT|O_EXCL|O_NOFOLLOW, then fchmod so the umask cannot change the
 * mode). An existing file or symlink is left alone. Only absolute paths are
 * created, so `:memory:` and `file:` URIs are skipped. Never throws.
 */
export function createPrivateFileIfMissing(
  path: string,
  deps: Pick<PrivateFilesDeps, "platform"> = {},
): CreatePrivateFileAction {
  if ((deps.platform ?? process.platform) === "win32") return "unsupported";
  if (!isAbsolute(path)) return "skipped";
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EEXIST" ? "exists" : "error";
  }
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    return "created";
  } catch {
    return "error";
  } finally {
    closeSync(fd);
  }
}

/**
 * Call before opening a SQLite database: create it 0600 when missing, and
 * tighten an existing db and its `-wal`/`-shm`. Never throws.
 */
export function preparePrivateSqliteFile(dbPath: string, deps: PrivateFilesDeps = {}): PrivateFileResult[] {
  // The opt-out keeps whatever mode the operator's umask gives new files too.
  if ((deps.env ?? process.env)[KEEP_STATE_DIR_PERMISSIONS_ENV] !== "1") createPrivateFileIfMissing(dbPath, deps);
  return ensurePrivateSqliteFiles(dbPath, deps);
}

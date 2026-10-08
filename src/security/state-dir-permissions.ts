/**
 * State dir permissions
 *
 * ~/.ravi holds `.env` (Claude/Anthropic credentials), ravi.db and the
 * credential broker. Group/other access to the directory lets other local
 * users read them. These helpers inspect the directory and, when it is ours,
 * tighten it to 0700. They never recurse, never follow a symlinked state dir
 * when changing modes, and never chmod anything owned by another user. They
 * also leave alone a state dir that is the home directory itself or a setgid
 * (deliberately group-shared) directory, and honour
 * RAVI_STATE_DIR_KEEP_PERMISSIONS=1 as an explicit opt-out.
 */

import { closeSync, constants, fchmodSync, lstatSync, openSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const GROUP_OTHER_BITS = 0o077;
const SETGID_BIT = 0o2000;
const PRIVATE_DIR_MODE = 0o700;

export const KEEP_STATE_DIR_PERMISSIONS_ENV = "RAVI_STATE_DIR_KEEP_PERMISSIONS";

/**
 * chmod a directory without following a symlink swapped in after inspection:
 * open it with O_NOFOLLOW|O_DIRECTORY and fchmod the descriptor.
 */
function chmodDirNoFollow(path: string, mode: number): void {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

export interface StateDirPermissionsDeps {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  lstat?: (path: string) => Stats;
  stat?: (path: string) => Stats;
  chmod?: (path: string, mode: number) => void;
  homedir?: () => string;
  env?: NodeJS.ProcessEnv;
}

export interface StateDirPermissionsInspection {
  path: string;
  /** false on platforms without POSIX modes (win32). */
  supported: boolean;
  exists: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  ownedByCurrentUser: boolean | null;
  /** Permission bits (`mode & 0o777`), null when unknown. */
  mode: number | null;
  /** e.g. "0755", null when unknown. */
  modeOctal: string | null;
  groupOrOtherAccess: boolean;
  /** setgid bit set: a deliberately group-shared directory. */
  setgid: boolean;
  error?: string;
}

export type TightenStateDirAction =
  | "tightened"
  | "already_private"
  | "missing"
  | "not_directory"
  | "symlink"
  | "not_owner"
  | "home_dir"
  | "shared_group"
  | "opted_out"
  | "unsupported"
  | "error";

export interface TightenStateDirResult {
  path: string;
  action: TightenStateDirAction;
  previousMode: string | null;
  mode: string | null;
  error?: string;
}

export function formatMode(mode: number | null): string | null {
  return mode === null ? null : `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function currentUid(deps: StateDirPermissionsDeps): number | undefined {
  if (deps.getuid) return deps.getuid();
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function inspectStateDirPermissions(
  dir: string,
  deps: StateDirPermissionsDeps = {},
): StateDirPermissionsInspection {
  const base: StateDirPermissionsInspection = {
    path: dir,
    supported: true,
    exists: false,
    isDirectory: false,
    isSymlink: false,
    ownedByCurrentUser: null,
    mode: null,
    modeOctal: null,
    groupOrOtherAccess: false,
    setgid: false,
  };
  if ((deps.platform ?? process.platform) === "win32") return { ...base, supported: false };

  let linkStats: Stats;
  try {
    linkStats = (deps.lstat ?? lstatSync)(dir);
  } catch (error) {
    return isMissing(error) ? base : { ...base, error: errorMessage(error) };
  }

  const isSymlink = linkStats.isSymbolicLink();
  let stats = linkStats;
  if (isSymlink) {
    // Read-only: report what the link points at, but tighten never follows it.
    try {
      stats = (deps.stat ?? statSync)(dir);
    } catch (error) {
      return isMissing(error)
        ? { ...base, isSymlink }
        : { ...base, exists: true, isSymlink, error: errorMessage(error) };
    }
  }

  const uid = currentUid(deps);
  const mode = stats.mode & 0o777;
  return {
    ...base,
    exists: true,
    isDirectory: stats.isDirectory(),
    isSymlink,
    ownedByCurrentUser: uid === undefined ? null : stats.uid === uid,
    mode,
    modeOctal: formatMode(mode),
    groupOrOtherAccess: (mode & GROUP_OTHER_BITS) !== 0,
    setgid: (stats.mode & SETGID_BIT) !== 0,
  };
}

/**
 * chmod the state dir to 0700 when it exists, is a real directory (not a
 * symlink), is owned by the current user, and has any group/other bit set.
 * Never throws.
 */
export function tightenStateDirPermissions(dir: string, deps: StateDirPermissionsDeps = {}): TightenStateDirResult {
  const inspection = inspectStateDirPermissions(dir, deps);
  const result = (
    action: TightenStateDirAction,
    extra: Partial<TightenStateDirResult> = {},
  ): TightenStateDirResult => ({
    path: dir,
    action,
    previousMode: inspection.modeOctal,
    mode: inspection.modeOctal,
    ...extra,
  });

  if (!inspection.supported) return result("unsupported");
  if (inspection.error) return result("error", { error: inspection.error });
  if (!inspection.exists) return result("missing");
  if (inspection.isSymlink) return result("symlink");
  if (!inspection.isDirectory) return result("not_directory");
  if (inspection.ownedByCurrentUser !== true) return result("not_owner");
  if (!inspection.groupOrOtherAccess) return result("already_private");
  if ((deps.env ?? process.env)[KEEP_STATE_DIR_PERMISSIONS_ENV] === "1") return result("opted_out");
  if (resolve(dir) === resolve((deps.homedir ?? homedir)())) return result("home_dir");
  if (inspection.setgid) return result("shared_group");

  try {
    (deps.chmod ?? chmodDirNoFollow)(dir, PRIVATE_DIR_MODE);
    return result("tightened", { mode: formatMode(PRIVATE_DIR_MODE) });
  } catch (error) {
    return result("error", { error: errorMessage(error) });
  }
}

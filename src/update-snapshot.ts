/**
 * Snapshot of the runtime state stores, taken by the update supervisor while
 * no process owns them, and its restore.
 *
 * A snapshot is only restored together with the exact release that wrote it
 * (`update-rollback.ts`): an older release never runs on a state a newer one
 * wrote. The snapshot is taken after both managed processes stopped and while
 * the supervisor holds every schema lock a daemon takes for its whole life,
 * so no daemon can write during the copy.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireSchemaFileLock, schemaDatabaseLockPath } from "./db/schema-lock.js";
import { canonicalStatePath } from "./db/state-boundary.js";
import { runtimeStateDatabasePaths } from "./db/state-paths.js";

export const UPDATE_SNAPSHOT_SPACE = "UPDATE_SNAPSHOT_SPACE";
const SNAPSHOT_PROTOCOL = "ravi.update-snapshot/v1";
const MANIFEST_FILE = "manifest.json";
const RESTORE_FILE = "restore.json";
/** `-shm` is an index SQLite rebuilds from the WAL; the database, its WAL and a hot journal are the state. */
const SNAPSHOT_SUFFIXES = ["", "-wal", "-journal"] as const;
const LIVE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const MIN_FREE_MARGIN_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export type UpdateSnapshotMethod = "reflink" | "copy";

export type UpdateSnapshotFile = {
  /** Absolute live path the file was copied from and is restored to. */
  source: string;
  /** File name under `<snapshot>/files/`. */
  name: string;
  bytes: number;
};

export type UpdateSnapshotManifest = {
  protocol: typeof SNAPSHOT_PROTOCOL;
  id: string;
  createdAt: string;
  previousRelease: string;
  targetRelease: string;
  method: UpdateSnapshotMethod;
  /** Every store path considered, in order; a store absent at snapshot time is absent after a restore. */
  stores: string[];
  files: UpdateSnapshotFile[];
};

export type UpdateSnapshotPlan = {
  method: UpdateSnapshotMethod;
  /** Bytes of the store files when the plan was made. */
  bytes: number;
  /** Bytes a full copy needs (every byte in copy mode; files on another filesystem in reflink mode). */
  copyBytes: number;
  freeBytes: number;
  /** Bytes held by earlier snapshots, deleted before this one is taken. */
  reclaimableBytes: number;
  requiredBytes: number;
};

export class UpdateSnapshotSpaceError extends Error {
  readonly code = UPDATE_SNAPSHOT_SPACE;
  constructor(readonly plan: UpdateSnapshotPlan) {
    super(
      `${UPDATE_SNAPSHOT_SPACE}: the update keeps a snapshot of the state stores so it can roll back, and it needs ` +
        `${formatBytes(plan.requiredBytes)} free on the state disk; ${formatBytes(plan.freeBytes + plan.reclaimableBytes)} ` +
        `is available (${plan.method === "copy" ? "this filesystem has no copy-on-write clones, so the copy is full" : "copy-on-write clones"}). ` +
        "Nothing was stopped: the running daemon keeps serving, but the installed package is already the target " +
        "release, and a restart would start it on this state. Free disk space, then run `ravi update` again.",
    );
    this.name = "UpdateSnapshotSpaceError";
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

export function updateSnapshotsDir(stateDir: string): string {
  return join(stateDir, "updates", "snapshots");
}

/**
 * The stores a daemon owns for its whole life (`runtimeStateDatabasePaths`),
 * for this state directory, with symlinks resolved as the daemon's locks are.
 */
export function updateStorePaths(stateDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return runtimeStateDatabasePaths({ ...env, RAVI_STATE_DIR: stateDir }).map((path) => canonicalStatePath(path));
}

function fileSize(path: string): { bytes: number; device: number } | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return null;
    return { bytes: info.size, device: info.dev };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/** The files that make up the stores now: database, WAL and hot journal. */
export function listStoreFiles(
  stores: string[],
): Array<{ store: number; source: string; bytes: number; device: number }> {
  const files: Array<{ store: number; source: string; bytes: number; device: number }> = [];
  stores.forEach((store, index) => {
    for (const suffix of SNAPSHOT_SUFFIXES) {
      const source = `${store}${suffix}`;
      const size = fileSize(source);
      if (size) files.push({ store: index, source, ...size });
    }
  });
  return files;
}

function directoryBytes(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
  for (const entry of entries) {
    const child = join(path, entry);
    const info = lstatSync(child);
    if (info.isDirectory()) total += directoryBytes(child);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

/** Whether this filesystem makes copy-on-write clones (APFS, btrfs, XFS); ext4 does not. */
export function probeReflink(directory: string): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const source = join(directory, `.reflink-probe-${randomBytes(6).toString("hex")}`);
  const clone = `${source}.clone`;
  try {
    writeFileSync(source, randomBytes(64 * 1024), { mode: 0o600 });
    copyFileSync(source, clone, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    // no-cause: A filesystem without clones takes full copies; the space check accounts for them.
    return false;
  } finally {
    rmSync(source, { force: true });
    rmSync(clone, { force: true });
  }
}

export function freeBytes(directory: string): number {
  const info = statfsSync(directory);
  return Number(info.bavail) * Number(info.bsize);
}

/**
 * Before any stop: how the snapshot will be taken and whether the disk can
 * hold it. Throws `UPDATE_SNAPSHOT_SPACE` when it cannot.
 */
export function planUpdateSnapshot(input: {
  stateDir: string;
  stores: string[];
  reflink?: (directory: string) => boolean;
  free?: (directory: string) => number;
}): UpdateSnapshotPlan {
  const directory = updateSnapshotsDir(input.stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const method: UpdateSnapshotMethod = (input.reflink ?? probeReflink)(directory) ? "reflink" : "copy";
  const stateDevice = statSync(directory).dev;
  const files = listStoreFiles(input.stores);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const copyBytes = files
    .filter((file) => method === "copy" || file.device !== stateDevice)
    .reduce((sum, file) => sum + file.bytes, 0);
  const plan: UpdateSnapshotPlan = {
    method,
    bytes,
    copyBytes,
    freeBytes: (input.free ?? freeBytes)(directory),
    reclaimableBytes: directoryBytes(directory),
    requiredBytes: copyBytes + Math.max(Math.ceil(copyBytes / 10), MIN_FREE_MARGIN_BYTES),
  };
  if (plan.freeBytes + plan.reclaimableBytes < plan.requiredBytes) throw new UpdateSnapshotSpaceError(plan);
  return plan;
}

/**
 * Holds every lock a daemon takes before it opens a store, in the daemon's
 * order. Acquiring them proves no daemon owns the state; a daemon that starts
 * meanwhile waits at its schema barrier.
 */
export function acquireStateStoreOwnership(stateDir: string, stores: string[], timeoutMs: number): { release(): void } {
  const root = canonicalStatePath(stateDir);
  const lockPaths = [
    ...new Set([join(root, "daemon-schema-owner.lock"), ...stores.map((store) => schemaDatabaseLockPath(store))]),
  ].sort();
  const acquired: Array<{ release(): void }> = [];
  const deadline = performance.now() + timeoutMs;
  const release = () => {
    for (const lock of acquired.splice(0).reverse()) lock.release();
  };
  try {
    for (const lockPath of lockPaths) {
      acquired.push(acquireSchemaFileLock(lockPath, Math.max(0, deadline - performance.now())));
    }
  } catch (cause) {
    release();
    throw cause;
  }
  return { release };
}

export function createUpdateSnapshotId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function cloneUnsupported(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EINVAL" || code === "ENOSYS";
}

function copyStoreFile(source: string, destination: string, method: UpdateSnapshotMethod): void {
  if (method === "reflink") {
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
      return;
    } catch (cause) {
      // A store on another filesystem cannot be cloned; the plan counted it as a full copy.
      if (!cloneUnsupported(cause)) throw cause;
      rmSync(destination, { force: true });
    }
  }
  copyFileSync(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(dirname(path));
}

/** Earlier snapshots go first: only the last update's snapshot is kept. */
function pruneUpdateSnapshots(directory: string, keep: string | null = null): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    if (entry === keep || !SNAPSHOT_ID_PATTERN.test(entry)) continue;
    rmSync(join(directory, entry), { recursive: true, force: true });
  }
}

/**
 * Copies the stores into `<state>/updates/snapshots/<id>/files/`. Call only
 * while both managed processes are stopped and the store locks are held. The
 * manifest is written last: a snapshot without one is incomplete.
 */
export function takeUpdateSnapshot(input: {
  stateDir: string;
  stores: string[];
  method: UpdateSnapshotMethod;
  previousRelease: string;
  targetRelease: string;
  now?: () => Date;
}): UpdateSnapshotManifest {
  const root = updateSnapshotsDir(input.stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  pruneUpdateSnapshots(root);
  const id = createUpdateSnapshotId(input.now?.() ?? new Date());
  const directory = join(root, id);
  const filesDirectory = join(directory, "files");
  mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
  // Listed again: a clean stop may have checkpointed or removed a WAL since the plan.
  const files: UpdateSnapshotFile[] = listStoreFiles(input.stores).map((file) => {
    const name = `${file.store}-${basename(file.source)}`;
    const destination = join(filesDirectory, name);
    copyStoreFile(file.source, destination, input.method);
    fsyncPath(destination);
    return { source: file.source, name, bytes: statSync(destination).size };
  });
  fsyncPath(filesDirectory);
  const manifest: UpdateSnapshotManifest = {
    protocol: SNAPSHOT_PROTOCOL,
    id,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    previousRelease: input.previousRelease,
    targetRelease: input.targetRelease,
    method: input.method,
    stores: [...input.stores],
    files,
  };
  writeJsonAtomic(join(directory, MANIFEST_FILE), manifest);
  return manifest;
}

export function readUpdateSnapshot(stateDir: string, id: string): UpdateSnapshotManifest {
  if (!SNAPSHOT_ID_PATTERN.test(id)) throw new Error(`Invalid update snapshot id: ${id}`);
  const manifest = JSON.parse(
    readFileSync(join(updateSnapshotsDir(stateDir), id, MANIFEST_FILE), "utf8"),
  ) as UpdateSnapshotManifest;
  if (manifest.protocol !== SNAPSHOT_PROTOCOL || manifest.id !== id || !Array.isArray(manifest.files)) {
    throw new Error(`Update snapshot ${id} has an unreadable manifest`);
  }
  return manifest;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** Rename without replacing anything; across filesystems, copy, flush, then remove the source. */
function moveFile(source: string, destination: string): void {
  if (entryExists(destination)) throw new Error(`Refusing to replace ${destination}`);
  try {
    renameSync(source, destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    copyFileSync(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    fsyncPath(destination);
    unlinkSync(source);
  }
}

/**
 * Puts the snapshot back. The live files (what the candidate wrote, plus any
 * store it created) are moved to `<snapshot>/candidate/`, never deleted; the
 * snapshot files are renamed into place, so the restore needs no free space.
 * Call only while both managed processes are stopped and the store locks are
 * held. `restore.json` records the phase for an operator if this is cut short.
 */
export function restoreUpdateSnapshot(input: {
  stateDir: string;
  manifest: UpdateSnapshotManifest;
  now?: () => Date;
}): { candidateDir: string; restoredAt: string } {
  const { manifest } = input;
  const directory = join(updateSnapshotsDir(input.stateDir), manifest.id);
  const filesDirectory = join(directory, "files");
  const journal = join(directory, RESTORE_FILE);
  if (entryExists(journal)) {
    throw new Error(
      `Update snapshot ${manifest.id} was already restored, or a restore was cut short: see ${journal}. Nothing was moved.`,
    );
  }
  for (const file of manifest.files) {
    if (!entryExists(join(filesDirectory, file.name)))
      throw new Error(`Update snapshot ${manifest.id} is missing ${file.name}; nothing was restored`);
  }
  const candidateDir = join(directory, "candidate");
  mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  writeJsonAtomic(journal, { phase: "restoring", startedAt, candidateDir });
  const parents = new Set<string>();
  manifest.stores.forEach((store, index) => {
    for (const suffix of LIVE_SUFFIXES) {
      const live = `${store}${suffix}`;
      if (!entryExists(live)) continue;
      moveFile(live, join(candidateDir, `${index}-${basename(store)}${suffix}`));
      parents.add(dirname(live));
    }
  });
  for (const file of manifest.files) {
    mkdirSync(dirname(file.source), { recursive: true, mode: 0o700 });
    moveFile(join(filesDirectory, file.name), file.source);
    parents.add(dirname(file.source));
  }
  for (const parent of parents) fsyncPath(parent);
  fsyncPath(candidateDir);
  const restoredAt = (input.now?.() ?? new Date()).toISOString();
  writeJsonAtomic(journal, { phase: "restored", startedAt, restoredAt, candidateDir });
  return { candidateDir, restoredAt };
}

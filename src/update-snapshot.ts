/**
 * Snapshot of the runtime state stores, taken by the update supervisor while
 * no daemon owns them, and its restore.
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
/** Next to a store on another disk: what the restore moves aside, and the snapshot copy it stages there. */
const CANDIDATE_PREFIX = ".ravi-update-candidate-";
const STAGED_PREFIX = ".ravi-update-restore-";

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
  /**
   * What the snapshot can count on: free space, plus the earlier snapshot in copy mode only. A clone shares its
   * blocks with the live stores, so deleting an earlier clone frees almost nothing.
   */
  availableBytes: number;
  requiredBytes: number;
  /**
   * Stores on another disk than the state directory: the restore copies their snapshot next to them before it
   * moves anything, so that disk needs the room too.
   */
  restoreSpace: Array<{ directory: string; requiredBytes: number; freeBytes: number }>;
};

export class UpdateSnapshotSpaceError extends Error {
  readonly code = UPDATE_SNAPSHOT_SPACE;
  constructor(readonly plan: UpdateSnapshotPlan) {
    const short = plan.restoreSpace.find((space) => space.freeBytes < space.requiredBytes);
    const need =
      plan.availableBytes < plan.requiredBytes
        ? `${formatBytes(plan.requiredBytes)} free on the state disk; ${formatBytes(plan.availableBytes)} is available ` +
          `(${plan.method === "copy" ? "this filesystem has no copy-on-write clones, so the copy is full" : "copy-on-write clones"})`
        : `${formatBytes(short?.requiredBytes ?? 0)} free in ${short?.directory}, a store on another disk, to restore ` +
          `it; ${formatBytes(short?.freeBytes ?? 0)} is available`;
    super(
      `${UPDATE_SNAPSHOT_SPACE}: the update keeps a snapshot of the state stores so it can roll back, and it needs ` +
        `${need}. Nothing was stopped: the running daemon keeps serving, but the installed package is already the ` +
        "target release, and a restart would start it on this state. Free disk space, then run `ravi update` again.",
    );
    this.name = "UpdateSnapshotSpaceError";
  }
}

function spaceWithMargin(bytes: number): number {
  return bytes + Math.max(Math.ceil(bytes / 10), MIN_FREE_MARGIN_BYTES);
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
  /** Device of an existing path (test seam); the default is `stat().dev`. */
  device?: (path: string) => number;
}): UpdateSnapshotPlan {
  const directory = updateSnapshotsDir(input.stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const method: UpdateSnapshotMethod = (input.reflink ?? probeReflink)(directory) ? "reflink" : "copy";
  const free = input.free ?? freeBytes;
  const stateDevice = input.device ? input.device(directory) : statSync(directory).dev;
  const files = listStoreFiles(input.stores).map((file) => ({
    ...file,
    device: input.device ? input.device(file.source) : file.device,
  }));
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const copyBytes = files
    .filter((file) => method === "copy" || file.device !== stateDevice)
    .reduce((sum, file) => sum + file.bytes, 0);
  const elsewhere = new Map<number, { directory: string; bytes: number }>();
  for (const file of files.filter((candidate) => candidate.device !== stateDevice)) {
    const entry = elsewhere.get(file.device) ?? { directory: dirname(file.source), bytes: 0 };
    entry.bytes += file.bytes;
    elsewhere.set(file.device, entry);
  }
  const freeOnState = free(directory);
  const reclaimableBytes = directoryBytes(directory);
  const plan: UpdateSnapshotPlan = {
    method,
    bytes,
    copyBytes,
    freeBytes: freeOnState,
    reclaimableBytes,
    availableBytes: method === "copy" ? freeOnState + reclaimableBytes : freeOnState,
    requiredBytes: spaceWithMargin(copyBytes),
    restoreSpace: [...elsewhere.values()].map((entry) => ({
      directory: entry.directory,
      requiredBytes: spaceWithMargin(entry.bytes),
      freeBytes: free(entry.directory),
    })),
  };
  if (
    plan.availableBytes < plan.requiredBytes ||
    plan.restoreSpace.some((space) => space.freeBytes < space.requiredBytes)
  )
    throw new UpdateSnapshotSpaceError(plan);
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

/** What an earlier restore left next to stores on another disk (a candidate directory, a staged copy). */
function pruneStoreSiblings(stores: string[]): void {
  for (const parent of new Set(stores.map((store) => dirname(store)))) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    for (const entry of entries) {
      if (entry.startsWith(CANDIDATE_PREFIX) || entry.startsWith(STAGED_PREFIX))
        rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }
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
  pruneStoreSiblings(input.stores);
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

export type UpdateSnapshotMove = { from: string; to: string; done: boolean };

/** POSIX single quotes: exact for any path, `$`, backquotes and quotes included. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Exact commands for the moves not done yet, in order. `mv -n` never replaces a file. */
export function updateSnapshotMoveCommands(moves: UpdateSnapshotMove[]): string[] {
  return moves
    .filter((move) => !move.done)
    .map((move) => `mkdir -p ${shellQuote(dirname(move.to))} && mv -n ${shellQuote(move.from)} ${shellQuote(move.to)}`);
}

/** A restore that stopped: `moves` says what was done, and `commands` finish it from there. */
export class UpdateSnapshotRestoreError extends Error {
  readonly commands: string[];
  constructor(
    message: string,
    readonly moves: UpdateSnapshotMove[],
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "UpdateSnapshotRestoreError";
    this.commands = updateSnapshotMoveCommands(moves);
  }
}

/**
 * Commands that put a snapshot back by hand, for an operator whose processes are stopped: every live file of a
 * store (database, WAL, shared memory, journal) goes aside first, so no WAL of the target is left next to a
 * restored database, then each snapshot file goes to its place.
 */
export function updateSnapshotManualRestoreCommands(stateDir: string, manifest: UpdateSnapshotManifest): string[] {
  const directory = join(updateSnapshotsDir(stateDir), manifest.id);
  const aside = join(directory, "candidate");
  const commands: string[] = [];
  manifest.stores.forEach((store, index) => {
    for (const suffix of LIVE_SUFFIXES) {
      const live = shellQuote(`${store}${suffix}`);
      const to = shellQuote(join(aside, `${index}-${basename(store)}${suffix}`));
      commands.push(`if [ -e ${live} ]; then mkdir -p ${shellQuote(aside)} && mv -n ${live} ${to}; fi`);
    }
  });
  for (const file of manifest.files) {
    commands.push(`mv -n ${shellQuote(join(directory, "files", file.name))} ${shellQuote(file.source)}`);
  }
  return commands;
}

/**
 * Puts the snapshot back with renames only. The live files (what the candidate wrote, plus any store it created)
 * go aside on their own disk, never deleted: under `<snapshot>/candidate/`, or next to a store that lives on
 * another disk (`.ravi-update-candidate-<id>/`). A store on another disk first gets its snapshot copy staged next
 * to it, before anything moves: a staging failure leaves the state untouched. `restore.json` lists every move and
 * whether it was done; a restore that stops raises `UpdateSnapshotRestoreError` with the commands that finish it.
 * Call only while both managed processes are stopped and the store locks are held.
 */
export function restoreUpdateSnapshot(input: {
  stateDir: string;
  manifest: UpdateSnapshotManifest;
  now?: () => Date;
  /** Device of an existing path (test seam); the default is `stat().dev`. */
  device?: (path: string) => number;
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
  const deviceOf = input.device ?? ((path: string) => statSync(path).dev);
  const snapshotDevice = deviceOf(directory);
  const candidateDir = join(directory, "candidate");
  const moves: UpdateSnapshotMove[] = [];
  const staged: UpdateSnapshotMove[] = [];
  manifest.stores.forEach((store, index) => {
    const parent = dirname(store);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const local = deviceOf(parent) === snapshotDevice;
    const aside = local ? candidateDir : join(parent, `${CANDIDATE_PREFIX}${manifest.id}`);
    for (const suffix of LIVE_SUFFIXES) {
      const live = `${store}${suffix}`;
      if (entryExists(live))
        moves.push({ from: live, to: join(aside, `${index}-${basename(store)}${suffix}`), done: false });
    }
    for (const file of manifest.files.filter((entry) =>
      SNAPSHOT_SUFFIXES.some((suffix) => entry.source === `${store}${suffix}`),
    )) {
      const copy = join(filesDirectory, file.name);
      if (local) {
        moves.push({ from: copy, to: file.source, done: false });
        continue;
      }
      const stagedPath = join(parent, `${STAGED_PREFIX}${manifest.id}-${file.name}`);
      staged.push({ from: copy, to: stagedPath, done: false });
      moves.push({ from: stagedPath, to: file.source, done: false });
    }
  });
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const writeJournal = (phase: string, extra: Record<string, unknown> = {}) =>
    writeJsonAtomic(journal, { phase, startedAt, candidateDir, moves, ...extra });

  // 1. Stage the snapshot copies of stores on another disk next to them. Nothing live has moved yet.
  writeJournal("staging");
  try {
    for (const stage of staged) {
      copyFileSync(stage.from, stage.to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      fsyncPath(stage.to);
    }
  } catch (cause) {
    for (const stage of staged) rmSync(stage.to, { force: true });
    rmSync(journal, { force: true });
    const unstaged = moves.map((move) => ({
      ...move,
      from: staged.find((stage) => stage.to === move.from)?.from ?? move.from,
    }));
    throw new UpdateSnapshotRestoreError(
      `The snapshot of a store on another disk could not be copied next to it (${describeCause(cause)}). ` +
        "Nothing was moved: the state is still the target's.",
      unstaged,
      { cause },
    );
  }

  // 2. Swap, one rename at a time, each recorded before the next.
  for (const move of moves) {
    try {
      mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
      moveFile(move.from, move.to);
      move.done = true;
      writeJournal("restoring");
    } catch (cause) {
      try {
        writeJournal("cut-short", { stoppedAt: move.from });
      } catch {
        // no-cause: The journal write failed too; the error below still carries every move and the commands.
      }
      throw new UpdateSnapshotRestoreError(
        `The restore stopped moving ${move.from} to ${move.to} (${describeCause(cause)}). ${journal} lists every ` +
          "move and whether it was done; the commands finish the restore.",
        moves,
        { cause },
      );
    }
  }
  for (const parent of new Set(moves.flatMap((move) => [dirname(move.from), dirname(move.to)]))) fsyncPath(parent);
  const restoredAt = (input.now?.() ?? new Date()).toISOString();
  writeJournal("restored", { restoredAt });
  return { candidateDir, restoredAt };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

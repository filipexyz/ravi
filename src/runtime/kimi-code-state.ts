import { execFile, spawnSync } from "node:child_process";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getRaviStateDir } from "../utils/paths.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import {
  parseProviderStateCleanupLocator,
  type ProviderStateCleanupLocator,
  serializeProviderStateCleanupLocator,
} from "./provider-state-cleanup-store.js";
import type { RuntimeSessionState } from "./types.js";

const KIMI_CODE_STATE_SCHEMA_VERSION = 1 as const;
const KIMI_CODE_MAX_STATE_BYTES = 1 * 1024 * 1024;
const KIMI_CODE_MAX_WORKSPACE_REALPATH_BYTES = 64 * 1024;
const KIMI_CODE_MAX_INTENT_BYTES = 20 * 1024;
const KIMI_CODE_MAX_INTENT_PAGE_SIZE = 32;
const KIMI_CODE_MAX_INTENT_SCAN_ENTRIES = 256;
const KIMI_CODE_WINDOWS_MOVE_TIMEOUT_MS = 10_000;
const KIMI_CODE_WINDOWS_MOVE_COLLISION_EXIT = 17;
const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTENT_FILENAME_PATTERN = /^\.publish-intent-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const WINDOWS_WRITE_THROUGH_MOVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$member = '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)][return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] public static extern bool MoveFileExW(string source, string destination, int flags);'",
  "[void](Add-Type -MemberDefinition $member -Name 'KimiMove' -Namespace 'Ravi.Native' -ErrorAction Stop)",
  "$deadline = [DateTime]::UtcNow.AddSeconds(1)",
  `do { $moved = [Ravi.Native.KimiMove]::MoveFileExW($env:RAVI_KIMI_MOVE_SOURCE, $env:RAVI_KIMI_MOVE_DESTINATION, 8); if ($moved) { exit 0 }; $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); if ($code -eq 80 -or $code -eq 183) { exit ${KIMI_CODE_WINDOWS_MOVE_COLLISION_EXIT} }; if ($code -ne 5 -and $code -ne 32 -and $code -ne 33) { exit 18 }; Start-Sleep -Milliseconds 20 } while ([DateTime]::UtcNow -lt $deadline)`,
  "exit 18",
].join("; ");
const LOCATOR_KEYS = [
  "schemaVersion",
  "provider",
  "model",
  "sessionId",
  "revision",
  "cwd",
  "workspaceIdentity",
  "sessionFile",
  "lastCommittedTurnId",
] as const;
const LOCATOR_HOST_METADATA_KEYS = ["runtimeCredential", "skillVisibility"] as const;
const SNAPSHOT_KEYS = [
  "schemaVersion",
  "provider",
  "model",
  "sessionId",
  "revision",
  "cwd",
  "workspaceIdentity",
  "lastCommittedTurnId",
  "credentialProfileFingerprint",
  "messages",
] as const;
const WORKSPACE_IDENTITY_KEYS = ["realpath", "device", "inode"] as const;
const INTENT_KEYS = ["schemaVersion", "locatorJson", "taskId", "ownerAttemptId"] as const;

export const KIMI_CODE_STATE_ERROR_CODES = [
  "state_missing",
  "io_transient",
  "state_busy",
  "invalid_locator",
  "schema_mismatch",
  "binding_mismatch",
  "foreign_root",
  "reparse_detected",
  "credential_detected",
  "unknown",
] as const;

export type KimiCodeStateErrorCode = (typeof KIMI_CODE_STATE_ERROR_CODES)[number];

const KIMI_CODE_STATE_ERROR_MESSAGES: Record<KimiCodeStateErrorCode, string> = {
  state_missing: "Kimi Code state is missing",
  io_transient: "Kimi Code state filesystem operation failed transiently",
  state_busy: "Kimi Code state is busy",
  invalid_locator: "Kimi Code state locator is invalid",
  schema_mismatch: "Kimi Code state schema is invalid",
  binding_mismatch: "Kimi Code state binding does not match",
  foreign_root: "Kimi Code state is outside its private root",
  reparse_detected: "Kimi Code state path contains a reparse point",
  credential_detected: "Kimi Code state contains configured credential material",
  unknown: "Kimi Code state operation failed closed",
};

export class KimiCodeStateError extends Error {
  readonly code: KimiCodeStateErrorCode;

  constructor(code: KimiCodeStateErrorCode) {
    super(KIMI_CODE_STATE_ERROR_MESSAGES[code]);
    this.name = "KimiCodeStateError";
    this.code = code;
  }
}

class KimiCodeWindowsMoveError extends KimiCodeStateError {
  readonly ambiguous: boolean;

  constructor(code: "io_transient" | "state_busy" | "unknown", ambiguous: boolean) {
    super(code);
    this.name = "KimiCodeWindowsMoveError";
    this.ambiguous = ambiguous;
  }
}

class KimiCodeFaultInjectionError extends Error {
  readonly injected: unknown;

  constructor(injected: unknown) {
    super("Kimi Code test fault injected");
    this.name = "KimiCodeFaultInjectionError";
    this.injected = injected;
  }
}

export function classifyKimiCodeStateError(error: unknown): KimiCodeStateError {
  if (error instanceof KimiCodeStateError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "ENOENT") return new KimiCodeStateError("state_missing");
  if (["EBUSY", "EAGAIN", "EWOULDBLOCK", "ETXTBSY"].includes(code ?? "")) {
    return new KimiCodeStateError("state_busy");
  }
  if (["EIO", "ENOSPC", "EMFILE", "ENFILE", "ENOMEM", "EACCES", "EPERM"].includes(code ?? "")) {
    return new KimiCodeStateError("io_transient");
  }
  return new KimiCodeStateError("unknown");
}

export interface KimiCodeWorkspaceIdentity {
  realpath: string;
  device: string;
  inode: string;
}

export interface KimiCodeCleanupLocator extends ProviderStateCleanupLocator {
  schemaVersion: typeof KIMI_CODE_STATE_SCHEMA_VERSION;
  provider: typeof KIMI_CODE_PROVIDER_ID;
  workspaceIdentity: KimiCodeWorkspaceIdentity;
}

interface PrivatePermissionTarget {
  path: string;
  directory: boolean;
}

export interface KimiCodeSessionSnapshot {
  schemaVersion: typeof KIMI_CODE_STATE_SCHEMA_VERSION;
  provider: typeof KIMI_CODE_PROVIDER_ID;
  model: string;
  sessionId: string;
  revision: number;
  cwd: string;
  workspaceIdentity: KimiCodeWorkspaceIdentity;
  lastCommittedTurnId: string;
  credentialProfileFingerprint: string;
  messages: KimiCodeConversationMessage[];
}

export interface CommitKimiCodeSessionStateInput {
  sessionId: string;
  model: string;
  cwd: string;
  lastCommittedTurnId: string;
  messages: readonly KimiCodeConversationMessage[];
  previousSnapshot?: KimiCodeSessionSnapshot;
  env?: NodeJS.ProcessEnv;
  /** Test-only crash boundary; production callers must omit it. */
  faultInjection?: {
    beforePublish?: () => void | Promise<void>;
    beforePromote?: () => void | Promise<void>;
    observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void;
  };
}

export interface CommittedKimiCodeSessionState {
  snapshot: KimiCodeSessionSnapshot;
  session: RuntimeSessionState;
}

export interface LoadKimiCodeSessionStateInput {
  session: RuntimeSessionState;
  model: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface PrepareKimiCodeSessionStateInput extends Omit<CommitKimiCodeSessionStateInput, "faultInjection"> {
  taskId: string;
  ownerAttemptId: string;
  /** Test-only crash boundaries; production callers must omit it. */
  faultInjection?: {
    beforeIntentSync?: () => void | Promise<void>;
    afterIntentSync?: () => void | Promise<void>;
    beforePublishDirectorySync?: () => void;
    observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void;
    observeWindowsMoveProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void;
    publishWindowsMoveTimeoutMs?: number;
    afterDiscardPayloadsDurable?: () => void | Promise<void>;
  };
}

export interface KimiCodePublishIntent {
  schemaVersion: typeof KIMI_CODE_STATE_SCHEMA_VERSION;
  locatorJson: string;
  taskId: string;
  ownerAttemptId: string;
}

export interface ListKimiCodePublishIntentsInput {
  env?: NodeJS.ProcessEnv;
  limit: number;
  cursor?: string;
}

export interface KimiCodePublishIntentPage {
  intentPaths: string[];
  nextCursor: string | undefined;
}

export interface PreparedKimiCodeSessionState extends CommittedKimiCodeSessionState {
  locatorJson: string;
  taskId: string;
  ownerAttemptId: string;
  intentPath: string;
  temporaryPath: string;
  publish: () => void;
  discard: () => Promise<void>;
}

export interface ExecuteKimiCodeProvisionalExactCleanupInput {
  locatorJson: string;
  taskId: string;
  ownerAttemptId: string;
  env?: NodeJS.ProcessEnv;
  isLocatorOwned: (locator: Readonly<KimiCodeCleanupLocator>) => boolean | Promise<boolean>;
  /** Test-only crash boundaries; production callers must omit it. */
  faultInjection?: {
    afterPayloadsDurable?: () => void | Promise<void>;
    afterWindowsArtifactMove?: (kind: "snapshot" | "temporary" | "intent") => void | Promise<void>;
  };
}

export async function executeKimiCodeProvisionalExactCleanup(
  input: ExecuteKimiCodeProvisionalExactCleanupInput,
): Promise<void> {
  try {
    await executeKimiCodeProvisionalExactCleanupInternal(input);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

async function executeKimiCodeProvisionalExactCleanupInternal(
  input: ExecuteKimiCodeProvisionalExactCleanupInput,
): Promise<void> {
  validateReservationId(input.taskId, input.env);
  validateReservationId(input.ownerAttemptId, input.env);
  const locator = parseKimiCodeCleanupLocator(input.locatorJson, input.env);
  const { root, sessionDirectory } = resolveKimiCodeLocatorPath(locator, input.env);
  const intentPath = join(sessionDirectory, `.publish-intent-${input.taskId}.json`);
  const temporaryPath = join(sessionDirectory, `.prepared-${input.taskId}.tmp`);
  const snapshotTombstone = cleanupTombstonePath(sessionDirectory, input.taskId, "snapshot");
  const temporaryTombstone = cleanupTombstonePath(sessionDirectory, input.taskId, "temporary");
  const intentTombstone = cleanupTombstonePath(sessionDirectory, input.taskId, "intent");

  if (!(await validateKimiCodeSessionDirectory(root, sessionDirectory))) return;

  const finalInfo = await inspectExactArtifact(locator.sessionFile);
  const intentInfo = await inspectExactArtifact(intentPath);
  const temporaryInfo = await inspectExactArtifact(temporaryPath);
  const snapshotTombstoneInfo = await inspectExactArtifact(snapshotTombstone);
  const temporaryTombstoneInfo = await inspectExactArtifact(temporaryTombstone);
  const intentTombstoneInfo = await inspectExactArtifact(intentTombstone);
  if (
    !finalInfo &&
    !intentInfo &&
    !temporaryInfo &&
    !snapshotTombstoneInfo &&
    !temporaryTombstoneInfo &&
    !intentTombstoneInfo
  ) {
    return;
  }
  if (!intentInfo && !intentTombstoneInfo) {
    if (!finalInfo && !temporaryInfo && !snapshotTombstoneInfo && !temporaryTombstoneInfo) return;
    const hasOtherIntent = (await readdir(sessionDirectory)).some((name) => INTENT_FILENAME_PATTERN.test(name));
    throw new KimiCodeStateError(hasOtherIntent ? "binding_mismatch" : "state_missing");
  }

  const intent = intentInfo
    ? await readKimiCodePublishIntent(intentPath, input.env)
    : intentTombstoneInfo && intentTombstoneInfo.size > 0
      ? await readKimiCodePublishIntentArtifact(intentTombstone, input.taskId, input.env)
      : undefined;
  if (!intent) {
    if (!finalInfo && !temporaryInfo && !snapshotTombstoneInfo && !temporaryTombstoneInfo) {
      if (process.platform === "win32" && intentTombstoneInfo) {
        await durablyRemoveWindowsArtifact(intentPath, intentTombstone, "intent");
      }
      return;
    }
    throw new KimiCodeStateError("state_missing");
  }
  if (
    intent.locatorJson !== input.locatorJson ||
    intent.taskId !== input.taskId ||
    intent.ownerAttemptId !== input.ownerAttemptId
  ) {
    throw new KimiCodeStateError("binding_mismatch");
  }
  if (finalInfo) await readLocatorBoundSnapshot(locator, input.env);
  if (snapshotTombstoneInfo?.size) await readLocatorBoundSnapshot(locator, input.env, snapshotTombstone);
  if (temporaryInfo) await readLocatorBoundSnapshot(locator, input.env, temporaryPath);
  if (temporaryTombstoneInfo?.size) await readLocatorBoundSnapshot(locator, input.env, temporaryTombstone);
  let owned: boolean;
  try {
    owned = await input.isLocatorOwned(locator);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
  if (owned) throw new KimiCodeStateError("state_busy");

  if (process.platform === "win32") {
    await durablyRemoveWindowsArtifact(
      locator.sessionFile,
      snapshotTombstone,
      "snapshot",
      input.faultInjection?.afterWindowsArtifactMove,
    );
    await durablyRemoveWindowsArtifact(
      temporaryPath,
      temporaryTombstone,
      "temporary",
      input.faultInjection?.afterWindowsArtifactMove,
    );
  } else {
    await unlinkExactArtifact(locator.sessionFile);
    await unlinkExactArtifact(temporaryPath);
    await syncDirectory(sessionDirectory);
  }
  await input.faultInjection?.afterPayloadsDurable?.();
  if (process.platform === "win32") {
    await durablyRemoveWindowsArtifact(
      intentPath,
      intentTombstone,
      "intent",
      input.faultInjection?.afterWindowsArtifactMove,
    );
  } else {
    await unlinkExactArtifact(intentPath);
    await syncDirectory(sessionDirectory);
  }
}

export async function prepareKimiCodeSessionState(
  input: PrepareKimiCodeSessionStateInput,
): Promise<PreparedKimiCodeSessionState> {
  try {
    return await prepareKimiCodeSessionStateInternal(input);
  } catch (error) {
    if (error instanceof KimiCodeFaultInjectionError) throw error.injected;
    throw classifyKimiCodeStateError(error);
  }
}

async function prepareKimiCodeSessionStateInternal(
  input: PrepareKimiCodeSessionStateInput,
): Promise<PreparedKimiCodeSessionState> {
  validateReservationId(input.taskId, input.env);
  validateReservationId(input.ownerAttemptId, input.env);
  const { snapshot, serialized, root, sessionDirectory } = await buildKimiCodeSnapshot(input);
  const observeAclProcessEnv = wrapFaultObserver(input.faultInjection?.observeAclProcessEnv);
  const observeWindowsMoveProcessEnv = wrapFaultObserver(input.faultInjection?.observeWindowsMoveProcessEnv);
  await ensurePrivateSessionDirectory(root, sessionDirectory, observeAclProcessEnv);

  const finalPath = join(sessionDirectory, revisionFilename(snapshot.revision));
  const temporaryPath = join(sessionDirectory, `.prepared-${input.taskId}.tmp`);
  const intentPath = join(sessionDirectory, `.publish-intent-${input.taskId}.json`);
  const intentStagingPath = join(sessionDirectory, `.publish-intent-${input.taskId}.staging`);
  const temporaryTombstone = cleanupTombstonePath(sessionDirectory, input.taskId, "temporary");
  const intentTombstone = cleanupTombstonePath(sessionDirectory, input.taskId, "intent");
  const session = sessionStateForSnapshot(snapshot, finalPath);
  const locatorJson = serializeKimiCodeCleanupLocator(session, input.env);
  const intent: KimiCodePublishIntent = {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    locatorJson,
    taskId: input.taskId,
    ownerAttemptId: input.ownerAttemptId,
  };
  const serializedIntent = JSON.stringify(intent);
  if (Buffer.byteLength(serializedIntent, "utf8") > KIMI_CODE_MAX_INTENT_BYTES) {
    throw new KimiCodeStateError("schema_mismatch");
  }

  let temporaryCreated = false;
  let intentCreated = false;
  let intentStagingCreated = false;
  let intentDurable = false;
  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await applyPrivatePermissions([{ path: temporaryPath, directory: false }], observeAclProcessEnv);
      await temporaryFile.writeFile(serialized, "utf8");
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }

    const intentWritePath = process.platform === "win32" ? intentStagingPath : intentPath;
    const intentFile = await open(intentWritePath, "wx", 0o600);
    if (process.platform === "win32") intentStagingCreated = true;
    else intentCreated = true;
    try {
      await applyPrivatePermissions([{ path: intentWritePath, directory: false }], observeAclProcessEnv);
      await intentFile.writeFile(serializedIntent, "utf8");
      await invokeFaultInjection(input.faultInjection?.beforeIntentSync);
      await intentFile.sync();
    } finally {
      await intentFile.close();
    }
    if (process.platform === "win32") {
      await moveFileWriteThroughWindows(intentStagingPath, intentPath, {
        observeProcessEnv: observeWindowsMoveProcessEnv,
      });
      intentStagingCreated = false;
      intentCreated = true;
    } else {
      await syncDirectory(sessionDirectory);
    }
    intentDurable = true;
    await invokeFaultInjection(input.faultInjection?.afterIntentSync);
  } catch (error) {
    const ambiguousWindowsMove = error instanceof KimiCodeWindowsMoveError && error.ambiguous;
    if (!intentDurable && !ambiguousWindowsMove) {
      if (intentCreated) await unlink(intentPath).catch(() => undefined);
      if (intentStagingCreated) await unlink(intentStagingPath).catch(() => undefined);
      if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    }
    if (isRecord(error) && error.code === "EEXIST") throw new KimiCodeStateError("state_busy");
    throw error;
  }

  let publicationAttempted = false;
  const publish = (): void => {
    if (publicationAttempted) throw new KimiCodeStateError("binding_mismatch");
    publicationAttempted = true;
    assertNoExistingReparsePointsSync(sessionDirectory);
    assertRegularFileSync(temporaryPath, "state_missing");
    assertRegularFileSync(intentPath, "state_missing");
    if (process.platform === "win32") {
      moveFileWriteThroughWindowsSync(temporaryPath, finalPath, {
        timeoutMs: input.faultInjection?.publishWindowsMoveTimeoutMs,
        observeProcessEnv: input.faultInjection?.observeWindowsMoveProcessEnv,
      });
      input.faultInjection?.beforePublishDirectorySync?.();
    } else {
      try {
        linkSync(temporaryPath, finalPath);
        unlinkSync(temporaryPath);
      } catch (error) {
        throw classifyKimiCodeStateError(error);
      }
      input.faultInjection?.beforePublishDirectorySync?.();
      syncDirectorySync(sessionDirectory);
    }
  };
  let discardPayloadBoundaryCrossed = false;
  const discard = async (): Promise<void> => {
    if (publicationAttempted || (await pathExists(finalPath))) throw new KimiCodeStateError("binding_mismatch");
    const currentIntent = await readKimiCodePublishIntent(intentPath, input.env);
    if (
      currentIntent.locatorJson !== locatorJson ||
      currentIntent.taskId !== input.taskId ||
      currentIntent.ownerAttemptId !== input.ownerAttemptId
    ) {
      throw new KimiCodeStateError("binding_mismatch");
    }
    const discardLocator = parseKimiCodeCleanupLocator(locatorJson, input.env);
    const temporaryInfo = await inspectExactArtifact(temporaryPath);
    const temporaryTombstoneInfo = await inspectExactArtifact(temporaryTombstone);
    if (temporaryInfo) await readLocatorBoundSnapshot(discardLocator, input.env, temporaryPath);
    if (temporaryTombstoneInfo?.size) {
      await readLocatorBoundSnapshot(discardLocator, input.env, temporaryTombstone);
    }
    if (process.platform === "win32") {
      await durablyRemoveWindowsArtifact(temporaryPath, temporaryTombstone, "temporary");
    } else {
      await unlinkExactArtifact(temporaryPath);
      await syncDirectory(sessionDirectory);
    }
    if (!discardPayloadBoundaryCrossed) {
      discardPayloadBoundaryCrossed = true;
      await input.faultInjection?.afterDiscardPayloadsDurable?.();
    }
    if (process.platform === "win32") {
      await durablyRemoveWindowsArtifact(intentPath, intentTombstone, "intent");
    } else {
      await removeKimiCodePublishIntent(intentPath, input.env);
    }
  };

  return {
    snapshot,
    session,
    locatorJson,
    taskId: input.taskId,
    ownerAttemptId: input.ownerAttemptId,
    intentPath,
    temporaryPath,
    publish,
    discard,
  };
}

export async function listKimiCodePublishIntents(
  input: ListKimiCodePublishIntentsInput,
): Promise<KimiCodePublishIntentPage> {
  try {
    return await listKimiCodePublishIntentsInternal(input);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

async function listKimiCodePublishIntentsInternal(
  input: ListKimiCodePublishIntentsInput,
): Promise<KimiCodePublishIntentPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > KIMI_CODE_MAX_INTENT_PAGE_SIZE) {
    throw new KimiCodeStateError("invalid_locator");
  }
  if (input.cursor !== undefined && !isKimiCodeIntentCursor(input.cursor)) {
    throw new KimiCodeStateError("invalid_locator");
  }
  const root = stateRoot(input.env);
  const rootInfo = await lstatOrMissing(root);
  if (!rootInfo) return { intentPaths: [], nextCursor: undefined };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new KimiCodeStateError("reparse_detected");
  await assertNoExistingReparsePoints(root);
  const candidates: Array<{ key: string; path: string }> = [];
  let scannedEntries = 0;
  for await (const sessionEntry of await opendir(root)) {
    scannedEntries += 1;
    if (scannedEntries > KIMI_CODE_MAX_INTENT_SCAN_ENTRIES) throw new KimiCodeStateError("state_busy");
    if (!UUID_PATTERN.test(sessionEntry.name)) continue;
    const sessionDirectory = join(root, sessionEntry.name);
    const sessionInfo = await lstatOrMissing(sessionDirectory);
    if (!sessionInfo?.isDirectory() || sessionInfo.isSymbolicLink()) {
      throw new KimiCodeStateError("reparse_detected");
    }
    for await (const entry of await opendir(sessionDirectory)) {
      scannedEntries += 1;
      if (scannedEntries > KIMI_CODE_MAX_INTENT_SCAN_ENTRIES) throw new KimiCodeStateError("state_busy");
      if (!INTENT_FILENAME_PATTERN.test(entry.name)) continue;
      const path = join(sessionDirectory, entry.name);
      await readKimiCodePublishIntent(path, input.env);
      const key = `${sessionEntry.name}/${entry.name}`;
      if (input.cursor === undefined || key > input.cursor) candidates.push({ key, path });
    }
  }
  candidates.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const selected = candidates.slice(0, input.limit);
  return {
    intentPaths: selected.map((candidate) => candidate.path),
    nextCursor: candidates.length > input.limit ? selected.at(-1)?.key : undefined,
  };
}

function isKimiCodeIntentCursor(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 256) return false;
  const separator = value.indexOf("/");
  return (
    separator > 0 &&
    value.indexOf("/", separator + 1) === -1 &&
    UUID_PATTERN.test(value.slice(0, separator)) &&
    INTENT_FILENAME_PATTERN.test(value.slice(separator + 1))
  );
}

export async function readKimiCodePublishIntent(
  intentPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<KimiCodePublishIntent> {
  try {
    return await readKimiCodePublishIntentInternal(intentPath, env);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

async function readKimiCodePublishIntentInternal(
  intentPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<KimiCodePublishIntent> {
  const match = INTENT_FILENAME_PATTERN.exec(basename(intentPath));
  const root = stateRoot(env);
  const sessionDirectory = dirname(intentPath);
  if (
    !match ||
    !isAbsolute(intentPath) ||
    hasTraversalSegment(intentPath) ||
    !isPathInside(root, intentPath) ||
    !UUID_PATTERN.test(basename(sessionDirectory)) ||
    !samePath(dirname(sessionDirectory), root)
  ) {
    throw new KimiCodeStateError("foreign_root");
  }
  return readKimiCodePublishIntentArtifact(intentPath, match[1], env);
}

async function readKimiCodePublishIntentArtifact(
  path: string,
  expectedTaskId: string,
  env?: NodeJS.ProcessEnv,
): Promise<KimiCodePublishIntent> {
  const root = stateRoot(env);
  const sessionDirectory = dirname(path);
  if (
    !isAbsolute(path) ||
    hasTraversalSegment(path) ||
    !isPathInside(root, path) ||
    !UUID_PATTERN.test(basename(sessionDirectory)) ||
    !samePath(dirname(sessionDirectory), root)
  ) {
    throw new KimiCodeStateError("foreign_root");
  }
  await assertNoExistingReparsePoints(path);
  const info = await lstatOrMissing(path);
  if (!info) throw new KimiCodeStateError("state_missing");
  if (!info.isFile() || info.isSymbolicLink()) throw new KimiCodeStateError("reparse_detected");
  if (info.size > KIMI_CODE_MAX_INTENT_BYTES) throw new KimiCodeStateError("schema_mismatch");
  const bytes = await open(path, "r").then(async (file) => {
    try {
      return await file.readFile();
    } finally {
      await file.close().catch(() => undefined);
    }
  });
  if (bytes.byteLength > KIMI_CODE_MAX_INTENT_BYTES) throw new KimiCodeStateError("schema_mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new KimiCodeStateError("schema_mismatch");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, INTENT_KEYS) ||
    parsed.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION ||
    typeof parsed.locatorJson !== "string" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.ownerAttemptId !== "string" ||
    JSON.stringify(parsed) !== bytes.toString("utf8")
  ) {
    throw new KimiCodeStateError("schema_mismatch");
  }
  validateReservationId(parsed.taskId, env);
  validateReservationId(parsed.ownerAttemptId, env);
  if (expectedTaskId !== parsed.taskId) throw new KimiCodeStateError("binding_mismatch");
  if (containsConfiguredCredential(parsed, env)) throw new KimiCodeStateError("credential_detected");
  const locator = parseKimiCodeCleanupLocator(parsed.locatorJson, env);
  if (!samePath(dirname(locator.sessionFile), sessionDirectory)) {
    throw new KimiCodeStateError("binding_mismatch");
  }
  return {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    locatorJson: parsed.locatorJson,
    taskId: parsed.taskId,
    ownerAttemptId: parsed.ownerAttemptId,
  };
}

export async function removeKimiCodePublishIntent(intentPath: string, env?: NodeJS.ProcessEnv): Promise<void> {
  try {
    const match = INTENT_FILENAME_PATTERN.exec(basename(intentPath));
    if (!match) throw new KimiCodeStateError("foreign_root");
    if (process.platform === "win32") {
      const tombstonePath = cleanupTombstonePath(dirname(intentPath), match[1], "intent");
      const intentInfo = await inspectExactArtifact(intentPath);
      const tombstoneInfo = await inspectExactArtifact(tombstonePath);
      if (!intentInfo && !tombstoneInfo) return;
      if (intentInfo) await readKimiCodePublishIntent(intentPath, env);
      else if (tombstoneInfo?.size) await readKimiCodePublishIntentArtifact(tombstonePath, match[1], env);
      await durablyRemoveWindowsArtifact(intentPath, tombstonePath, "intent");
    } else {
      await readKimiCodePublishIntent(intentPath, env);
      await unlink(intentPath);
      await syncDirectory(dirname(intentPath));
    }
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

export function projectKimiCodeCleanupLocator(
  session: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): KimiCodeCleanupLocator {
  const params = session.params;
  if (!isRecord(params)) throw new KimiCodeStateError("invalid_locator");
  if (params.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION) {
    throw new KimiCodeStateError("schema_mismatch");
  }
  if (
    params.provider !== KIMI_CODE_PROVIDER_ID ||
    typeof params.model !== "string" ||
    !params.model.trim() ||
    typeof params.sessionId !== "string" ||
    !UUID_PATTERN.test(params.sessionId) ||
    typeof params.revision !== "number" ||
    !Number.isSafeInteger(params.revision) ||
    params.revision < 1 ||
    typeof params.cwd !== "string" ||
    !params.cwd.trim() ||
    !isWorkspaceIdentity(params.workspaceIdentity) ||
    typeof params.sessionFile !== "string" ||
    typeof params.lastCommittedTurnId !== "string" ||
    !params.lastCommittedTurnId.trim()
  ) {
    throw new KimiCodeStateError("invalid_locator");
  }
  const locator: KimiCodeCleanupLocator = {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    provider: KIMI_CODE_PROVIDER_ID,
    model: params.model,
    sessionId: params.sessionId,
    revision: params.revision,
    cwd: params.cwd,
    workspaceIdentity: copyWorkspaceIdentity(params.workspaceIdentity),
    sessionFile: params.sessionFile,
    lastCommittedTurnId: params.lastCommittedTurnId,
  };
  validateKimiCodeCleanupLocator(locator, env);
  return locator;
}

export function serializeKimiCodeCleanupLocator(session: RuntimeSessionState, env?: NodeJS.ProcessEnv): string {
  const locator = projectKimiCodeCleanupLocator(session, env);
  try {
    return serializeProviderStateCleanupLocator(locator);
  } catch {
    throw new KimiCodeStateError("invalid_locator");
  }
}

export function parseKimiCodeCleanupLocator(serialized: string, env?: NodeJS.ProcessEnv): KimiCodeCleanupLocator {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new KimiCodeStateError("invalid_locator");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new KimiCodeStateError("invalid_locator");
  }
  if (!isRecord(raw) || !hasExactKeys(raw, LOCATOR_KEYS)) {
    throw new KimiCodeStateError("invalid_locator");
  }
  if (raw.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION) {
    throw new KimiCodeStateError("schema_mismatch");
  }
  let canonical: ProviderStateCleanupLocator;
  try {
    canonical = parseProviderStateCleanupLocator(serialized);
  } catch {
    throw new KimiCodeStateError("invalid_locator");
  }
  const locator = projectKimiCodeCleanupLocator({ params: { ...canonical } }, env);
  if (JSON.stringify(locator) !== serialized) throw new KimiCodeStateError("invalid_locator");
  return locator;
}

function validateKimiCodeCleanupLocator(locator: KimiCodeCleanupLocator, env?: NodeJS.ProcessEnv): void {
  if (containsConfiguredCredential(locator, env)) throw new KimiCodeStateError("credential_detected");
  if (
    !isAbsolute(locator.cwd) ||
    hasTraversalSegment(locator.cwd) ||
    hasTraversalSegment(locator.workspaceIdentity.realpath) ||
    !isAbsolute(locator.sessionFile) ||
    hasTraversalSegment(locator.sessionFile)
  ) {
    throw new KimiCodeStateError("foreign_root");
  }
  const root = stateRoot(env);
  const expectedDirectory = join(root, locator.sessionId);
  if (!isPathInside(root, locator.sessionFile)) throw new KimiCodeStateError("foreign_root");
  if (
    !samePath(dirname(locator.sessionFile), expectedDirectory) ||
    !isRevisionFilename(basename(locator.sessionFile), locator.revision)
  ) {
    throw new KimiCodeStateError("binding_mismatch");
  }
}

async function inspectExactArtifact(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  await assertNoExistingReparsePoints(path);
  const info = await lstatOrMissing(path);
  if (!info) return undefined;
  if (info.isSymbolicLink()) throw new KimiCodeStateError("reparse_detected");
  if (!info.isFile()) throw new KimiCodeStateError("schema_mismatch");
  return info;
}

async function unlinkExactArtifact(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw classifyKimiCodeStateError(error);
  });
}

type KimiCodeCleanupArtifactKind = "snapshot" | "temporary" | "intent";

function cleanupTombstonePath(sessionDirectory: string, taskId: string, kind: KimiCodeCleanupArtifactKind): string {
  return join(sessionDirectory, `.cleanup-${taskId}-${kind}.tombstone`);
}

async function invokeFaultInjection(callback: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (error) {
    throw new KimiCodeFaultInjectionError(error);
  }
}

function wrapFaultObserver<T>(observer: ((value: T) => void) | undefined): ((value: T) => void) | undefined {
  if (!observer) return undefined;
  return (value) => {
    try {
      observer(value);
    } catch (error) {
      throw new KimiCodeFaultInjectionError(error);
    }
  };
}

async function durablyRemoveWindowsArtifact(
  canonicalPath: string,
  tombstonePath: string,
  kind: KimiCodeCleanupArtifactKind,
  afterMove?: (kind: KimiCodeCleanupArtifactKind) => void | Promise<void>,
): Promise<void> {
  const canonicalInfo = await inspectExactArtifact(canonicalPath);
  let tombstoneInfo = await inspectExactArtifact(tombstonePath);
  if (canonicalInfo && tombstoneInfo) throw new KimiCodeStateError("state_busy");
  if (canonicalInfo) {
    await moveFileWriteThroughWindows(canonicalPath, tombstonePath);
    await afterMove?.(kind);
    tombstoneInfo = await inspectExactArtifact(tombstonePath);
    if (!tombstoneInfo) throw new KimiCodeStateError("io_transient");
  }
  if (!tombstoneInfo) return;
  const tombstone = await open(tombstonePath, "r+");
  try {
    await tombstone.truncate(0);
    await tombstone.sync();
  } finally {
    await tombstone.close().catch(() => undefined);
  }
  await unlink(tombstonePath).catch(() => undefined);
}

async function buildKimiCodeSnapshot(input: CommitKimiCodeSessionStateInput): Promise<{
  snapshot: KimiCodeSessionSnapshot;
  serialized: string;
  root: string;
  sessionDirectory: string;
}> {
  const cwd = normalizeCwd(input.cwd);
  const workspaceIdentity = await resolveWorkspaceIdentity(cwd);
  const credentialProfileFingerprint = resolveCredentialProfileFingerprint(input.env);
  if (!UUID_PATTERN.test(input.sessionId)) throw stateError("session id is invalid");
  if (input.previousSnapshot) {
    validatePreviousSnapshot(input.previousSnapshot, input.model, cwd, workspaceIdentity, credentialProfileFingerprint);
  }
  if (input.previousSnapshot && input.previousSnapshot.sessionId !== input.sessionId) {
    throw stateError("session id mismatch");
  }
  if (!input.lastCommittedTurnId.trim()) throw stateError("turn id is invalid");
  if (containsConfiguredCredential(input.messages, input.env)) {
    throw stateErrorWithMessage("credential_detected", "Kimi Code session state contains configured credential");
  }
  const snapshot: KimiCodeSessionSnapshot = {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    provider: KIMI_CODE_PROVIDER_ID,
    model: input.model,
    sessionId: input.sessionId,
    revision: (input.previousSnapshot?.revision ?? 0) + 1,
    cwd,
    workspaceIdentity,
    lastCommittedTurnId: input.lastCommittedTurnId,
    credentialProfileFingerprint,
    messages: validateMessages(input.messages),
  };
  if (containsConfiguredCredential(snapshot, input.env)) {
    throw stateErrorWithMessage("credential_detected", "Kimi Code session state contains configured credential");
  }
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > KIMI_CODE_MAX_STATE_BYTES) {
    throw stateErrorWithMessage("schema_mismatch", "Kimi Code session state exceeds maximum size");
  }
  const root = stateRoot(input.env);
  if (containsConfiguredCredential(root, input.env)) {
    throw stateErrorWithMessage("credential_detected", "Kimi Code session state contains configured credential");
  }
  return { snapshot, serialized, root, sessionDirectory: join(root, snapshot.sessionId) };
}

async function ensurePrivateSessionDirectory(
  root: string,
  sessionDirectory: string,
  observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void,
): Promise<void> {
  const privateDirectories = await ensureDurablePrivateStateDirectories(root, sessionDirectory, observeAclProcessEnv);
  if (privateDirectories.length > 0) {
    await applyPrivatePermissions(
      privateDirectories.map((path) => ({ path, directory: true })),
      observeAclProcessEnv,
    );
  }
}

export async function commitKimiCodeSessionState(
  input: CommitKimiCodeSessionStateInput,
): Promise<CommittedKimiCodeSessionState> {
  const { snapshot, serialized, root, sessionDirectory } = await buildKimiCodeSnapshot(input);
  await ensurePrivateSessionDirectory(root, sessionDirectory, input.faultInjection?.observeAclProcessEnv);

  const filename = revisionFilename(snapshot.revision);
  const finalPath = join(sessionDirectory, filename);
  const temporaryPath = join(sessionDirectory, `.${filename}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await applyPrivatePermissions(
        [{ path: temporaryPath, directory: false }],
        input.faultInjection?.observeAclProcessEnv,
      );
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await assertNoExistingReparsePoints(sessionDirectory);
    await input.faultInjection?.beforePublish?.();
    await link(temporaryPath, finalPath);
    await unlink(temporaryPath);
    temporaryCreated = false;
    await syncDirectory(sessionDirectory);
    await input.faultInjection?.beforePromote?.();
  } catch (error) {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  // A failed best-effort prune must never invalidate the newly promoted locator.
  await pruneUnpublishedSessionArtifacts(sessionDirectory, basename(finalPath)).catch(() => undefined);

  return {
    snapshot,
    session: sessionStateForSnapshot(snapshot, finalPath),
  };
}

/**
 * Removes provider-owned state after its host session has been deleted. The
 * supplied locator is treated as untrusted: it can only select its own UUID
 * directory below this provider's derived state root.
 */
export async function cleanupKimiCodeSessionState(
  session: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await cleanupKimiCodeSessionStateInternal(session, env);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

async function cleanupKimiCodeSessionStateInternal(
  session: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const locator = parseLocator(session, env);
  assertValidKimiCodeLocator(locator);
  const { root, sessionDirectory } = resolveKimiCodeLocatorPath(locator, env);
  if (!(await validateKimiCodeSessionDirectory(root, sessionDirectory))) return;
  await readLocatorBoundSnapshot(locator, env);

  await removeOwnedSessionArtifacts(sessionDirectory, locator.revision);
  await rmdir(sessionDirectory).catch((error) => {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return;
    throw error;
  });
}

export async function retireSupersededKimiCodeSessionState(
  previousSession: RuntimeSessionState,
  nextSession: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await retireSupersededKimiCodeSessionStateInternal(previousSession, nextSession, env);
  } catch (error) {
    throw classifyKimiCodeStateError(error);
  }
}

async function retireSupersededKimiCodeSessionStateInternal(
  previousSession: RuntimeSessionState,
  nextSession: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const previous = parseLocator(previousSession, env);
  const next = parseLocator(nextSession, env);
  assertValidKimiCodeLocator(previous);
  assertValidKimiCodeLocator(next);
  const previousPath = resolveKimiCodeLocatorPath(previous, env);
  const nextPath = resolveKimiCodeLocatorPath(next, env);
  if (
    previous.sessionId !== next.sessionId ||
    next.revision <= previous.revision ||
    previous.model !== next.model ||
    !sameCwd(previous.cwd, next.cwd) ||
    !sameWorkspaceIdentity(previous.workspaceIdentity, next.workspaceIdentity) ||
    !samePath(previousPath.sessionDirectory, nextPath.sessionDirectory)
  ) {
    throw stateError("locator lineage mismatch");
  }
  if (!(await validateKimiCodeSessionDirectory(nextPath.root, nextPath.sessionDirectory))) return;

  // The durable successor must bind to a real immutable snapshot before the
  // predecessor can be retired. A fabricated terminal locator therefore
  // leaves the previous resumable state untouched.
  await readLocatorBoundSnapshot(next, env);
  const previousInfo = await lstatOrMissing(previous.sessionFile);
  if (!previousInfo) return;
  await readLocatorBoundSnapshot(previous, env);
  await unlink(previous.sessionFile).catch((error) => {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  });
  await rmdir(previousPath.sessionDirectory).catch((error) => {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return;
    throw error;
  });
}

export async function loadKimiCodeSessionState(input: LoadKimiCodeSessionStateInput): Promise<KimiCodeSessionSnapshot> {
  const params = parseLocator(input.session, input.env);
  const expectedCwd = normalizeCwd(input.cwd);
  if (params.provider !== KIMI_CODE_PROVIDER_ID) throw stateError("provider mismatch");
  if (params.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION) throw stateError("schema mismatch");
  if (params.model !== input.model) throw stateError("model mismatch");
  if (!sameCwd(params.cwd, expectedCwd)) throw stateError("cwd mismatch");
  const expectedWorkspaceIdentity = await resolveWorkspaceIdentity(expectedCwd);
  if (!sameWorkspaceIdentity(params.workspaceIdentity, expectedWorkspaceIdentity)) {
    throw stateError("workspace identity mismatch");
  }
  if (!UUID_PATTERN.test(params.sessionId)) throw stateError("session id is invalid");
  if (!Number.isSafeInteger(params.revision) || params.revision < 1) throw stateError("revision is invalid");
  if (!params.lastCommittedTurnId.trim()) throw stateError("turn id is invalid");
  if (!isAbsolute(params.sessionFile) || hasTraversalSegment(params.sessionFile)) {
    throw stateError("session path is invalid");
  }

  const root = stateRoot(input.env);
  const sessionDirectory = join(root, params.sessionId);
  if (
    !samePath(dirname(params.sessionFile), sessionDirectory) ||
    !isRevisionFilename(basename(params.sessionFile), params.revision) ||
    !isPathInside(root, params.sessionFile)
  ) {
    throw stateError("session path is invalid");
  }

  await assertNoExistingReparsePoints(params.sessionFile);
  const fileInfo = await lstat(params.sessionFile).catch(() => undefined);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw stateError("session file is missing");
  if (fileInfo.size > KIMI_CODE_MAX_STATE_BYTES) throw stateError("session file is oversized");
  const rootRealPath = await realpath(root).catch(() => undefined);
  const fileRealPath = await realpath(params.sessionFile).catch(() => undefined);
  if (!rootRealPath || !fileRealPath || !isPathInside(rootRealPath, fileRealPath)) {
    throw stateError("session path escaped its root");
  }

  const file = await open(params.sessionFile, "r").catch(() => undefined);
  if (!file) throw stateError("session file is missing");
  let bytes: Buffer;
  try {
    const openedInfo = await file.stat();
    if (!openedInfo.isFile() || openedInfo.size > KIMI_CODE_MAX_STATE_BYTES) {
      throw stateError(
        openedInfo.size > KIMI_CODE_MAX_STATE_BYTES ? "session file is oversized" : "session file is missing",
      );
    }
    bytes = await file.readFile();
  } finally {
    await file.close().catch(() => undefined);
  }
  if (bytes.byteLength > KIMI_CODE_MAX_STATE_BYTES) throw stateError("session file is oversized");
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw stateError("session file is corrupt");
  }
  if (containsConfiguredCredential(decoded, input.env)) {
    throw stateError("session file contains configured credential");
  }
  const snapshot = parseSnapshot(decoded);
  if (snapshot.credentialProfileFingerprint !== resolveCredentialProfileFingerprint(input.env)) {
    throw stateError("credential profile mismatch");
  }
  if (
    snapshot.schemaVersion !== params.schemaVersion ||
    snapshot.provider !== params.provider ||
    snapshot.model !== params.model ||
    snapshot.sessionId !== params.sessionId ||
    snapshot.revision !== params.revision ||
    !sameCwd(snapshot.cwd, params.cwd) ||
    !sameWorkspaceIdentity(snapshot.workspaceIdentity, params.workspaceIdentity) ||
    snapshot.lastCommittedTurnId !== params.lastCommittedTurnId
  ) {
    throw stateError("snapshot binding mismatch");
  }
  return snapshot;
}

async function pruneUnpublishedSessionArtifacts(sessionDirectory: string, liveFilename: string): Promise<void> {
  await assertNoExistingReparsePoints(sessionDirectory);
  for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
    if (entry.name === liveFilename) continue;
    const path = join(sessionDirectory, entry.name);
    const temporary = isTemporaryRevisionFilename(entry.name);
    if (!temporary) continue;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw stateError("session path uses a reparse point");
    // A fresh temporary file can still be in a concurrent publisher's
    // write/link window, so only reap abandoned temporary artifacts. Published
    // revisions remain until a lifecycle owner has proof that no locator lives.
    if (Date.now() - info.mtimeMs < 60_000) continue;
    await unlink(path);
  }
}

async function readLocatorBoundSnapshot(
  locator: ReturnType<typeof parseLocator>,
  env?: NodeJS.ProcessEnv,
  snapshotPath = locator.sessionFile,
): Promise<KimiCodeSessionSnapshot> {
  await assertNoExistingReparsePoints(snapshotPath);
  const fileInfo = await lstatOrMissing(snapshotPath);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw stateError("session file is missing");
  if (fileInfo.size > KIMI_CODE_MAX_STATE_BYTES) throw stateError("session file is oversized");
  const file = await open(snapshotPath, "r").catch((error) => {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw classifyKimiCodeStateError(error);
  });
  if (!file) throw stateError("session file is missing");
  let bytes: Buffer;
  try {
    const openedInfo = await file.stat();
    if (!openedInfo.isFile() || openedInfo.size > KIMI_CODE_MAX_STATE_BYTES) {
      throw stateError(
        openedInfo.size > KIMI_CODE_MAX_STATE_BYTES ? "session file is oversized" : "session file is missing",
      );
    }
    bytes = await file.readFile();
  } finally {
    await file.close().catch(() => undefined);
  }
  if (bytes.byteLength > KIMI_CODE_MAX_STATE_BYTES) throw stateError("session file is oversized");
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw stateError("session file is corrupt");
  }
  if (containsConfiguredCredential(decoded, env)) throw stateError("session file contains configured credential");
  const snapshot = parseSnapshot(decoded);
  if (
    snapshot.schemaVersion !== locator.schemaVersion ||
    snapshot.provider !== locator.provider ||
    snapshot.model !== locator.model ||
    snapshot.sessionId !== locator.sessionId ||
    snapshot.revision !== locator.revision ||
    !sameCwd(snapshot.cwd, locator.cwd) ||
    !sameWorkspaceIdentity(snapshot.workspaceIdentity, locator.workspaceIdentity) ||
    snapshot.lastCommittedTurnId !== locator.lastCommittedTurnId
  ) {
    throw stateError("snapshot binding mismatch");
  }
  return snapshot;
}

async function removeOwnedSessionArtifacts(sessionDirectory: string, maximumRevision: number): Promise<void> {
  await assertNoExistingReparsePoints(sessionDirectory);
  for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
    const revision = revisionFromFilename(entry.name);
    const isRetiredSnapshot = revision !== undefined && revision <= maximumRevision;
    const isAgedTemporary = isTemporaryRevisionFilename(entry.name);
    if (!isRetiredSnapshot && !isAgedTemporary) continue;
    const path = join(sessionDirectory, entry.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw stateError("session path uses a reparse point");
    if (!isRetiredSnapshot && Date.now() - info.mtimeMs < 60_000) continue;
    await unlink(path);
  }
}

function revisionFromFilename(filename: string): number | undefined {
  const revision = /^revision-(\d{8})-([0-9a-f-]{36})\.json$/i.exec(filename);
  if (revision === null || !UUID_PATTERN.test(revision[2])) return undefined;
  const parsed = Number(revision[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function isTemporaryRevisionFilename(filename: string): boolean {
  const temporary = /^\.revision-\d{8}-([0-9a-f-]{36})\.json\.([0-9a-f-]{36})\.tmp$/i.exec(filename);
  return temporary !== null && UUID_PATTERN.test(temporary[1]) && UUID_PATTERN.test(temporary[2]);
}

function stateRoot(env?: NodeJS.ProcessEnv): string {
  return resolve(getRaviStateDir(env), "runtime", "kimi-code", "sessions");
}

function revisionFilename(revision: number): string {
  return `revision-${revision.toString().padStart(8, "0")}-${randomUUID()}.json`;
}

function isRevisionFilename(filename: string, revision: number): boolean {
  const prefix = `revision-${revision.toString().padStart(8, "0")}-`;
  const suffix = ".json";
  return (
    filename.startsWith(prefix) &&
    filename.endsWith(suffix) &&
    UUID_PATTERN.test(filename.slice(prefix.length, -suffix.length))
  );
}

function assertValidKimiCodeLocator(locator: ReturnType<typeof parseLocator>): void {
  if (
    locator.provider !== KIMI_CODE_PROVIDER_ID ||
    locator.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION ||
    !UUID_PATTERN.test(locator.sessionId) ||
    !Number.isSafeInteger(locator.revision) ||
    locator.revision < 1
  ) {
    throw stateError("locator is invalid");
  }
}

function resolveKimiCodeLocatorPath(
  locator: ReturnType<typeof parseLocator>,
  env?: NodeJS.ProcessEnv,
): { root: string; sessionDirectory: string } {
  const root = stateRoot(env);
  const sessionDirectory = join(root, locator.sessionId);
  if (
    !isAbsolute(locator.sessionFile) ||
    hasTraversalSegment(locator.sessionFile) ||
    !samePath(dirname(locator.sessionFile), sessionDirectory) ||
    !isRevisionFilename(basename(locator.sessionFile), locator.revision) ||
    !isPathInside(root, locator.sessionFile)
  ) {
    throw stateError("session path is invalid");
  }
  return { root, sessionDirectory };
}

async function validateKimiCodeSessionDirectory(root: string, sessionDirectory: string): Promise<boolean> {
  const directoryInfo = await lstatOrMissing(sessionDirectory);
  if (!directoryInfo) return false;
  if (directoryInfo.isSymbolicLink()) throw new KimiCodeStateError("reparse_detected");
  if (!directoryInfo.isDirectory()) throw stateError("session directory is invalid");
  await assertNoExistingReparsePoints(sessionDirectory);
  const rootRealPath = await realpathOrMissing(root);
  const directoryRealPath = await realpathOrMissing(sessionDirectory);
  if (!rootRealPath || !directoryRealPath || !isPathInside(rootRealPath, directoryRealPath)) {
    throw stateError("session path escaped its root");
  }
  return true;
}

function parseLocator(
  session: RuntimeSessionState,
  env?: NodeJS.ProcessEnv,
): {
  schemaVersion: number;
  provider: string;
  model: string;
  sessionId: string;
  revision: number;
  cwd: string;
  workspaceIdentity: KimiCodeWorkspaceIdentity;
  sessionFile: string;
  lastCommittedTurnId: string;
} {
  const params = session.params;
  if (
    !isRecord(params) ||
    !hasRequiredAndAllowedKeys(params, LOCATOR_KEYS, LOCATOR_HOST_METADATA_KEYS) ||
    ("runtimeCredential" in params && !isRuntimeCredentialMetadata(params.runtimeCredential)) ||
    ("skillVisibility" in params && !isSkillVisibilitySnapshot(params.skillVisibility)) ||
    containsConfiguredCredential(params, env)
  ) {
    throw stateError("locator is invalid");
  }
  if (
    typeof params.schemaVersion !== "number" ||
    typeof params.provider !== "string" ||
    typeof params.model !== "string" ||
    typeof params.sessionId !== "string" ||
    typeof params.revision !== "number" ||
    typeof params.cwd !== "string" ||
    !isWorkspaceIdentity(params.workspaceIdentity) ||
    typeof params.sessionFile !== "string" ||
    typeof params.lastCommittedTurnId !== "string"
  ) {
    throw stateError("locator is invalid");
  }
  return {
    schemaVersion: params.schemaVersion,
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    revision: params.revision,
    cwd: params.cwd,
    workspaceIdentity: copyWorkspaceIdentity(params.workspaceIdentity),
    sessionFile: params.sessionFile,
    lastCommittedTurnId: params.lastCommittedTurnId,
  };
}

function parseSnapshot(value: unknown): KimiCodeSessionSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) throw stateError("session file is corrupt");
  if (
    value.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION ||
    value.provider !== KIMI_CODE_PROVIDER_ID ||
    typeof value.model !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.cwd !== "string" ||
    !isWorkspaceIdentity(value.workspaceIdentity) ||
    typeof value.lastCommittedTurnId !== "string" ||
    typeof value.credentialProfileFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.credentialProfileFingerprint) ||
    !Array.isArray(value.messages)
  ) {
    throw stateError("session file is corrupt");
  }
  return {
    schemaVersion: value.schemaVersion,
    provider: value.provider,
    model: value.model,
    sessionId: value.sessionId,
    revision: value.revision,
    cwd: value.cwd,
    workspaceIdentity: copyWorkspaceIdentity(value.workspaceIdentity),
    lastCommittedTurnId: value.lastCommittedTurnId,
    credentialProfileFingerprint: value.credentialProfileFingerprint,
    messages: validateMessages(value.messages),
  };
}

function validatePreviousSnapshot(
  snapshot: KimiCodeSessionSnapshot,
  model: string,
  cwd: string,
  workspaceIdentity: KimiCodeWorkspaceIdentity,
  credentialProfileFingerprint: string,
): void {
  if (
    snapshot.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION ||
    snapshot.provider !== KIMI_CODE_PROVIDER_ID ||
    snapshot.model !== model ||
    !UUID_PATTERN.test(snapshot.sessionId) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !sameCwd(snapshot.cwd, cwd) ||
    !isWorkspaceIdentity(snapshot.workspaceIdentity) ||
    !sameWorkspaceIdentity(snapshot.workspaceIdentity, workspaceIdentity) ||
    snapshot.credentialProfileFingerprint !== credentialProfileFingerprint ||
    !snapshot.lastCommittedTurnId.trim()
  ) {
    throw stateError("previous snapshot is invalid");
  }
  validateMessages(snapshot.messages);
}

function resolveCredentialProfileFingerprint(env?: NodeJS.ProcessEnv): string {
  const key = env?.KIMI_API_KEY;
  if (!key) throw stateError("credential profile is unavailable");
  return `sha256:${createHash("sha256").update(`${KIMI_CODE_PROVIDER_ID}\0${key}`, "utf8").digest("hex")}`;
}

function validateMessages(messages: readonly unknown[]): KimiCodeConversationMessage[] {
  const validated: KimiCodeConversationMessage[] = messages.map((message): KimiCodeConversationMessage => {
    if (!isRecord(message) || typeof message.role !== "string") throw stateError("native messages are invalid");
    if (message.role === "user" && hasExactKeys(message, ["role", "content"])) {
      if (typeof message.content !== "string") throw stateError("native messages are invalid");
      return { role: "user", content: message.content };
    }
    if (message.role === "tool" && hasExactKeys(message, ["role", "tool_call_id", "content"])) {
      if (typeof message.tool_call_id !== "string" || typeof message.content !== "string") {
        throw stateError("native messages are invalid");
      }
      return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
    }
    if (message.role === "assistant" && hasExactKeys(message, ["role", "content", "reasoning_content", "tool_calls"])) {
      if (
        typeof message.content !== "string" ||
        typeof message.reasoning_content !== "string" ||
        !Array.isArray(message.tool_calls)
      ) {
        throw stateError("native messages are invalid");
      }
      const toolCalls = message.tool_calls.map((call) => {
        if (!isRecord(call) || !hasExactKeys(call, ["id", "type", "function"]) || call.type !== "function") {
          throw stateError("native messages are invalid");
        }
        const fn = call.function;
        if (
          typeof call.id !== "string" ||
          !isRecord(fn) ||
          !hasExactKeys(fn, ["name", "arguments"]) ||
          typeof fn.name !== "string" ||
          typeof fn.arguments !== "string"
        ) {
          throw stateError("native messages are invalid");
        }
        return { id: call.id, type: "function" as const, function: { name: fn.name, arguments: fn.arguments } };
      });
      return {
        role: "assistant",
        content: message.content,
        reasoning_content: message.reasoning_content,
        tool_calls: toolCalls,
      };
    }
    throw stateError("native messages are invalid");
  });
  validateMessageSequence(validated);
  return validated;
}

function validateMessageSequence(messages: readonly KimiCodeConversationMessage[]): void {
  let expected: "user" | "assistant" | "tool" = "user";
  let pendingToolIds: string[] = [];
  const seenToolIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== expected) throw stateError("native messages are invalid");
    if (message.role === "user") {
      seenToolIds.clear();
      expected = "assistant";
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls) {
        if (!call.id.trim() || seenToolIds.has(call.id) || !call.function.name.trim()) {
          throw stateError("native messages are invalid");
        }
        seenToolIds.add(call.id);
      }
      pendingToolIds = message.tool_calls.map((call) => call.id);
      expected = pendingToolIds.length > 0 ? "tool" : "user";
      continue;
    }
    if (message.tool_call_id !== pendingToolIds[0]) throw stateError("native messages are invalid");
    pendingToolIds.shift();
    expected = pendingToolIds.length > 0 ? "tool" : "assistant";
  }

  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.tool_calls.length > 0 || expected !== "user") {
    throw stateError("native messages are invalid");
  }
}

async function assertNoExistingReparsePoints(target: string): Promise<void> {
  const resolvedTarget = resolve(target);
  const filesystemRoot = parse(resolvedTarget).root;
  let current = filesystemRoot;
  const segments = relative(filesystemRoot, resolvedTarget).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink() && !(await isCanonicalMacOSVarAlias(current))) {
      throw stateError("session path uses a reparse point");
    }
    if (!info) return;
  }
}

async function isCanonicalMacOSVarAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || path !== `${sep}var`) return false;
  return (await realpath(path).catch(() => undefined)) === `${sep}private${sep}var`;
}

async function applyPrivatePermissions(
  targets: readonly PrivatePermissionTarget[],
  observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void,
): Promise<void> {
  await Promise.all(targets.map((target) => chmod(target.path, target.directory ? 0o700 : 0o600)));
  if (process.platform !== "win32") return;
  const script = [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$sids = @($identity.User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
    "$sections = [System.Security.AccessControl.AccessControlSections]::Access",
    "foreach ($entry in (ConvertFrom-Json $env:RAVI_KIMI_ACL_TARGETS)) { $target = [string]$entry.path; $isDirectory = [bool]$entry.directory; $inheritance = if ($isDirectory) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }; $security = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($target, $sections) } else { [System.IO.File]::GetAccessControl($target, $sections) }; $security.SetAccessRuleProtection($true, $false); @($security.Access) | ForEach-Object { [void]$security.RemoveAccessRuleSpecific($_) }; foreach ($sid in $sids) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow); [void]$security.AddAccessRule($rule) }; if ($isDirectory) { [System.IO.Directory]::SetAccessControl($target, $security) } else { [System.IO.File]::SetAccessControl($target, $security) } }",
  ].join("; ");
  const childEnv = aclProcessEnv(targets);
  observeAclProcessEnv?.({ ...childEnv });
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: childEnv,
    windowsHide: true,
  });
}

async function ensureDurablePrivateStateDirectories(
  root: string,
  sessionDirectory: string,
  observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void,
): Promise<string[]> {
  const stateDirectory = dirname(dirname(dirname(root)));
  const runtimeDirectory = join(stateDirectory, "runtime");
  const providerDirectory = join(runtimeDirectory, "kimi-code");
  const parentDirectories = [stateDirectory, runtimeDirectory];
  const privateDirectories = [providerDirectory, root, sessionDirectory];
  for (const directory of parentDirectories) {
    await createAndValidateDirectory(directory);
  }
  if (process.platform === "win32") {
    await createPrivateWindowsDirectoriesAtomically(privateDirectories, observeAclProcessEnv);
    for (const directory of privateDirectories) {
      await assertNoExistingReparsePoints(directory);
      await syncDirectory(dirname(directory));
    }
    return [];
  }
  for (const directory of privateDirectories) {
    await createAndValidateDirectory(directory);
  }
  return privateDirectories;
}

async function createAndValidateDirectory(directory: string): Promise<void> {
  await assertNoExistingReparsePoints(directory);
  await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  });
  await assertNoExistingReparsePoints(directory);
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw stateError("session directory is invalid");
  await syncDirectory(dirname(directory));
}

async function createPrivateWindowsDirectoriesAtomically(
  directories: readonly string[],
  observeAclProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void,
): Promise<void> {
  const script = [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$allowed = @($identity.User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
    "$allowedValues = @($allowed | ForEach-Object { $_.Value })",
    "$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner",
    "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "foreach ($entry in (ConvertFrom-Json $env:RAVI_KIMI_ACL_TARGETS)) { $target = [string]$entry.path; $security = New-Object System.Security.AccessControl.DirectorySecurity; $security.SetAccessRuleProtection($true, $false); $security.SetOwner($identity.User); foreach ($sid in $allowed) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow); [void]$security.AddAccessRule($rule) }; $item = New-Object System.IO.DirectoryInfo($target); if (-not $item.Exists) { $item.Create($security) }; $item.Refresh(); if (-not $item.Exists -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Kimi state directory is missing or a reparse point' }; $actual = [System.IO.Directory]::GetAccessControl($target, $sections); if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'Kimi state directory owner or DACL protection is invalid' }; $rules = @($actual.Access); if ($rules.Count -ne $allowedValues.Count) { throw 'Kimi state directory DACL is not exact' }; foreach ($rule in $rules) { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if ($allowedValues -notcontains $sid -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'Kimi state directory DACL rule is invalid' } } }",
  ].join("; ");
  const targets = directories.map((path) => ({ path, directory: true }));
  const childEnv = aclProcessEnv(targets);
  observeAclProcessEnv?.({ ...childEnv });
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: childEnv,
    windowsHide: true,
  });
}

interface WindowsMoveOptions {
  timeoutMs?: number;
  observeProcessEnv?: (env: Readonly<NodeJS.ProcessEnv>) => void;
}

async function moveFileWriteThroughWindows(
  source: string,
  destination: string,
  options: WindowsMoveOptions = {},
): Promise<void> {
  const childEnv = windowsMoveProcessEnv(source, destination);
  options.observeProcessEnv?.({ ...childEnv });
  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_WRITE_THROUGH_MOVE_SCRIPT],
      {
        env: childEnv,
        windowsHide: true,
        timeout: resolveWindowsMoveTimeout(options.timeoutMs),
        maxBuffer: 1024,
      },
    );
  } catch (error) {
    throw classifyWindowsMoveError(error);
  }
}

function moveFileWriteThroughWindowsSync(source: string, destination: string, options: WindowsMoveOptions = {}): void {
  const childEnv = windowsMoveProcessEnv(source, destination);
  options.observeProcessEnv?.({ ...childEnv });
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_WRITE_THROUGH_MOVE_SCRIPT],
    {
      env: childEnv,
      windowsHide: true,
      timeout: resolveWindowsMoveTimeout(options.timeoutMs),
      stdio: "ignore",
    },
  );
  if (result.error) throw classifyWindowsMoveError(result.error);
  if (result.status === 0 && result.signal === null) return;
  if (result.status === KIMI_CODE_WINDOWS_MOVE_COLLISION_EXIT) {
    throw new KimiCodeWindowsMoveError("state_busy", false);
  }
  throw new KimiCodeWindowsMoveError(result.status === null ? "unknown" : "io_transient", result.status === null);
}

function classifyWindowsMoveError(error: unknown): KimiCodeWindowsMoveError {
  const code = isRecord(error) ? error.code : undefined;
  if (code === KIMI_CODE_WINDOWS_MOVE_COLLISION_EXIT || code === String(KIMI_CODE_WINDOWS_MOVE_COLLISION_EXIT)) {
    return new KimiCodeWindowsMoveError("state_busy", false);
  }
  if (code === "ETIMEDOUT" || (isRecord(error) && error.killed === true)) {
    return new KimiCodeWindowsMoveError("io_transient", true);
  }
  if (typeof code === "number") return new KimiCodeWindowsMoveError("io_transient", false);
  return new KimiCodeWindowsMoveError("unknown", false);
}

function resolveWindowsMoveTimeout(value: number | undefined): number {
  if (value === undefined) return KIMI_CODE_WINDOWS_MOVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > KIMI_CODE_WINDOWS_MOVE_TIMEOUT_MS) {
    throw new KimiCodeStateError("invalid_locator");
  }
  return value;
}

function windowsMoveProcessEnv(source: string, destination: string): NodeJS.ProcessEnv {
  return {
    ...minimalWindowsProcessEnv(),
    RAVI_KIMI_MOVE_SOURCE: source,
    RAVI_KIMI_MOVE_DESTINATION: destination,
  };
}

function minimalWindowsProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/*
 * Windows has no handle-relative openat/O_NOFOLLOW equivalent in the current
 * Node/Bun fs surface. The provider root and its descendants are therefore
 * created with their final protected DACL in the atomic DirectoryInfo.Create
 * call and then reparse/DACL-validated. This excludes other-SID races below the
 * provider root; it does not claim protection from a hostile same-SID process.
 */
function aclProcessEnv(targets: readonly PrivatePermissionTarget[]): NodeJS.ProcessEnv {
  return {
    ...minimalWindowsProcessEnv(),
    RAVI_KIMI_ACL_TARGETS: JSON.stringify(targets),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM" && code !== "ENOSYS") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM" && code !== "ENOSYS") {
      throw classifyKimiCodeStateError(error);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertNoExistingReparsePointsSync(target: string): void {
  const resolvedTarget = resolve(target);
  const filesystemRoot = parse(resolvedTarget).root;
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, resolvedTarget).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw classifyKimiCodeStateError(error);
    }
    const canonicalMacOSVarAlias =
      process.platform === "darwin" && current === `${sep}var` && realpathSync(current) === `${sep}private${sep}var`;
    if (info.isSymbolicLink() && !canonicalMacOSVarAlias) throw new KimiCodeStateError("reparse_detected");
  }
}

function assertRegularFileSync(path: string, missingCode: KimiCodeStateErrorCode): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") throw new KimiCodeStateError(missingCode);
    throw classifyKimiCodeStateError(error);
  }
  if (info.isSymbolicLink()) throw new KimiCodeStateError("reparse_detected");
  if (!info.isFile()) throw new KimiCodeStateError("schema_mismatch");
}

function validateReservationId(value: string, env?: NodeJS.ProcessEnv): void {
  if (typeof value !== "string" || !RESERVATION_ID_PATTERN.test(value)) {
    throw new KimiCodeStateError("invalid_locator");
  }
  if (containsConfiguredCredential(value, env)) throw new KimiCodeStateError("credential_detected");
}

function sessionStateForSnapshot(snapshot: KimiCodeSessionSnapshot, finalPath: string): RuntimeSessionState {
  return {
    params: {
      schemaVersion: snapshot.schemaVersion,
      provider: snapshot.provider,
      model: snapshot.model,
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      cwd: snapshot.cwd,
      workspaceIdentity: copyWorkspaceIdentity(snapshot.workspaceIdentity),
      sessionFile: finalPath,
      lastCommittedTurnId: snapshot.lastCommittedTurnId,
    },
    displayId: snapshot.sessionId,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstatOrMissing(path)) !== undefined;
}

async function lstatOrMissing(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  return lstat(path).catch((error) => {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw classifyKimiCodeStateError(error);
  });
}

async function realpathOrMissing(path: string): Promise<string | undefined> {
  return realpath(path).catch((error) => {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw classifyKimiCodeStateError(error);
  });
}

function normalizeCwd(cwd: string): string {
  if (!cwd.trim()) throw stateError("cwd is invalid");
  return resolve(cwd);
}

async function resolveWorkspaceIdentity(cwd: string): Promise<KimiCodeWorkspaceIdentity> {
  const canonical = await realpath(cwd).catch(() => {
    throw stateError("workspace identity is unavailable");
  });
  const info = await stat(canonical, { bigint: true }).catch(() => {
    throw stateError("workspace identity is unavailable");
  });
  if (
    info.ino <= 0n ||
    !isAbsolute(canonical) ||
    Buffer.byteLength(canonical, "utf8") > KIMI_CODE_MAX_WORKSPACE_REALPATH_BYTES
  ) {
    throw stateError("workspace identity is unavailable");
  }
  return { realpath: canonical, device: String(info.dev), inode: String(info.ino) };
}

function isWorkspaceIdentity(value: unknown): value is KimiCodeWorkspaceIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORKSPACE_IDENTITY_KEYS) &&
    typeof value.realpath === "string" &&
    isAbsolute(value.realpath) &&
    Buffer.byteLength(value.realpath, "utf8") <= KIMI_CODE_MAX_WORKSPACE_REALPATH_BYTES &&
    typeof value.device === "string" &&
    /^(?:0|[1-9]\d{0,39}|-[1-9]\d{0,39})$/.test(value.device) &&
    typeof value.inode === "string" &&
    /^[1-9]\d{0,39}$/.test(value.inode)
  );
}

function copyWorkspaceIdentity(identity: KimiCodeWorkspaceIdentity): KimiCodeWorkspaceIdentity {
  return { realpath: identity.realpath, device: identity.device, inode: identity.inode };
}

function sameWorkspaceIdentity(left: KimiCodeWorkspaceIdentity, right: KimiCodeWorkspaceIdentity): boolean {
  const sameRealpath =
    process.platform === "win32"
      ? left.realpath.toLowerCase() === right.realpath.toLowerCase()
      : left.realpath === right.realpath;
  return sameRealpath && left.device === right.device && left.inode === right.inode;
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return normalizedLeft === normalizedRight;
}

function sameCwd(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function createKimiCodeSessionId(): string {
  return randomUUID();
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function containsConfiguredCredential(value: unknown, env?: NodeJS.ProcessEnv): boolean {
  const apiKey = env?.KIMI_API_KEY ?? process.env.KIMI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) return false;
  return containsStringValue(value, apiKey);
}

function containsStringValue(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsStringValue(item, needle));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => containsStringValue(item, needle));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isRuntimeCredentialMetadata(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(
      value,
      ["credentialId", "fingerprint", "runtimeProvider"],
      ["attemptId", "upstreamProvider", "authMethod", "sessionCompatibilityKey"],
    )
  ) {
    return false;
  }
  if (
    typeof value.credentialId !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.runtimeProvider !== "string" ||
    !value.credentialId.trim() ||
    !value.fingerprint.trim() ||
    value.runtimeProvider !== KIMI_CODE_PROVIDER_ID
  ) {
    return false;
  }
  return (
    (value.attemptId === undefined || value.attemptId === null || typeof value.attemptId === "string") &&
    (value.upstreamProvider === undefined || typeof value.upstreamProvider === "string") &&
    (value.authMethod === undefined || typeof value.authMethod === "string") &&
    (value.sessionCompatibilityKey === undefined || typeof value.sessionCompatibilityKey === "string")
  );
}

function isSkillVisibilitySnapshot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["skills", "loadedSkills", "updatedAt"]) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.loadedSkills) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    !value.skills.every(isSkillVisibilityRecord) ||
    !value.loadedSkills.every((skill) => typeof skill === "string" && skill.trim())
  ) {
    return false;
  }

  const skills = value.skills as Array<Record<string, unknown>>;
  const loadedSkills = value.loadedSkills as unknown[];
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) return false;
  const expectedLoadedSkills = skills
    .filter((skill) => skill.state === "loaded" && skill.confidence === "observed")
    .map((skill) => skill.id);
  return (
    expectedLoadedSkills.length === loadedSkills.length &&
    expectedLoadedSkills.every((skill, index) => skill === loadedSkills[index])
  );
}

function isSkillVisibilityRecord(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(
      value,
      ["id", "provider", "state", "confidence", "lastSeenAt"],
      ["source", "evidence", "loadedAt"],
    ) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.provider !== KIMI_CODE_PROVIDER_ID ||
    !isSkillVisibilityState(value.state) ||
    !isSkillVisibilityConfidence(value.confidence) ||
    typeof value.lastSeenAt !== "number" ||
    !Number.isFinite(value.lastSeenAt) ||
    (value.source !== undefined && typeof value.source !== "string") ||
    (value.loadedAt !== undefined &&
      value.loadedAt !== null &&
      (typeof value.loadedAt !== "number" || !Number.isFinite(value.loadedAt)))
  ) {
    return false;
  }
  return (
    value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.every(isSkillVisibilityEvidence))
  );
}

function isSkillVisibilityEvidence(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(
      value,
      ["kind"],
      ["observedAt", "path", "eventType", "eventId", "turnId", "itemId", "detail"],
    ) ||
    !isSkillVisibilityEvidenceKind(value.kind) ||
    (value.observedAt !== undefined && (typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt)))
  ) {
    return false;
  }
  return ["path", "eventType", "eventId", "turnId", "itemId", "detail"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function isSkillVisibilityState(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["available", "synced", "advertised", "requested", "loaded", "stale", "unknown"].includes(value)
  );
}

function isSkillVisibilityConfidence(value: unknown): boolean {
  return typeof value === "string" && ["observed", "inferred", "declared", "unknown"].includes(value);
}

function isSkillVisibilityEvidenceKind(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
      "provider-event",
      "skill-gate",
      "tool-call",
      "sync-manifest",
      "system-prompt",
      "control-api",
      "rpc-state",
      "plugin-bootstrap",
      "instruction-source",
    ].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateError(reason: string): KimiCodeStateError {
  const code: KimiCodeStateErrorCode = (() => {
    switch (reason) {
      case "session file is missing":
      case "credential profile is unavailable":
      case "workspace identity is unavailable":
        return "state_missing";
      case "session path uses a reparse point":
        return "reparse_detected";
      case "session path escaped its root":
        return "foreign_root";
      case "session file contains configured credential":
        return "credential_detected";
      case "locator lineage mismatch":
      case "model mismatch":
      case "cwd mismatch":
      case "workspace identity mismatch":
      case "credential profile mismatch":
      case "snapshot binding mismatch":
      case "previous snapshot is invalid":
      case "session id mismatch":
        return "binding_mismatch";
      case "schema mismatch":
      case "session file is oversized":
      case "session file is corrupt":
      case "native messages are invalid":
        return "schema_mismatch";
      default:
        return "invalid_locator";
    }
  })();
  return stateErrorWithMessage(code, `Kimi Code session state is invalid: ${reason}`);
}

function stateErrorWithMessage(code: KimiCodeStateErrorCode, staticMessage: string): KimiCodeStateError {
  const error = new KimiCodeStateError(code);
  error.message = staticMessage;
  return error;
}

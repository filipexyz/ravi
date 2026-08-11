import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getRaviStateDir } from "../utils/paths.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import type { RuntimeSessionState } from "./types.js";

const KIMI_CODE_STATE_SCHEMA_VERSION = 1 as const;
const KIMI_CODE_MAX_STATE_BYTES = 4 * 1024 * 1024;
const KIMI_CODE_MAX_WORKSPACE_REALPATH_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export interface KimiCodeWorkspaceIdentity {
  realpath: string;
  device: string;
  inode: string;
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

export async function commitKimiCodeSessionState(
  input: CommitKimiCodeSessionStateInput,
): Promise<CommittedKimiCodeSessionState> {
  const cwd = normalizeCwd(input.cwd);
  const workspaceIdentity = await resolveWorkspaceIdentity(cwd);
  const credentialProfileFingerprint = resolveCredentialProfileFingerprint(input.env);
  if (!UUID_PATTERN.test(input.sessionId)) throw stateError("session id is invalid");
  const previous = input.previousSnapshot;
  if (previous) {
    validatePreviousSnapshot(previous, input.model, cwd, workspaceIdentity, credentialProfileFingerprint);
  }
  if (previous && previous.sessionId !== input.sessionId) throw stateError("session id mismatch");
  if (!input.lastCommittedTurnId.trim()) throw stateError("turn id is invalid");
  if (containsConfiguredCredential(input.messages, input.env)) {
    throw new Error("Kimi Code session state contains configured credential");
  }
  const messages = validateMessages(input.messages);
  const snapshot: KimiCodeSessionSnapshot = {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    provider: KIMI_CODE_PROVIDER_ID,
    model: input.model,
    sessionId: input.sessionId,
    revision: (previous?.revision ?? 0) + 1,
    cwd,
    workspaceIdentity,
    lastCommittedTurnId: input.lastCommittedTurnId,
    credentialProfileFingerprint,
    messages,
  };
  if (containsConfiguredCredential(snapshot, input.env)) {
    throw new Error("Kimi Code session state contains configured credential");
  }
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > KIMI_CODE_MAX_STATE_BYTES) {
    throw new Error("Kimi Code session state exceeds maximum size");
  }

  const root = stateRoot(input.env);
  if (containsConfiguredCredential(root, input.env)) {
    throw new Error("Kimi Code session state contains configured credential");
  }
  const sessionDirectory = join(root, snapshot.sessionId);
  const privateDirectories = await ensureDurablePrivateStateDirectories(
    root,
    sessionDirectory,
    input.faultInjection?.observeAclProcessEnv,
  );
  if (privateDirectories.length > 0) {
    await applyPrivatePermissions(
      privateDirectories.map((path) => ({ path, directory: true })),
      input.faultInjection?.observeAclProcessEnv,
    );
  }

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

  return {
    snapshot,
    session: {
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
    },
  };
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
    if (info?.isSymbolicLink()) throw stateError("session path uses a reparse point");
    if (!info) return;
  }
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

/*
 * Windows has no handle-relative openat/O_NOFOLLOW equivalent in the current
 * Node/Bun fs surface. The provider root and its descendants are therefore
 * created with their final protected DACL in the atomic DirectoryInfo.Create
 * call and then reparse/DACL-validated. This excludes other-SID races below the
 * provider root; it does not claim protection from a hostile same-SID process.
 */
function aclProcessEnv(targets: readonly PrivatePermissionTarget[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    RAVI_KIMI_ACL_TARGETS: JSON.stringify(targets),
  };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
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
    info.dev < 0n ||
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
    /^(?:0|[1-9]\d{0,39})$/.test(value.device) &&
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

function stateError(reason: string): Error {
  return new Error(`Kimi Code session state is invalid: ${reason}`);
}

import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getRaviStateDir } from "../utils/paths.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import type { RuntimeSessionState } from "./types.js";

const KIMI_CODE_STATE_SCHEMA_VERSION = 1 as const;
const KIMI_CODE_MAX_STATE_BYTES = 4 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATOR_KEYS = [
  "schemaVersion",
  "provider",
  "model",
  "sessionId",
  "revision",
  "cwd",
  "sessionFile",
  "lastCommittedTurnId",
] as const;
const SNAPSHOT_KEYS = [
  "schemaVersion",
  "provider",
  "model",
  "sessionId",
  "revision",
  "cwd",
  "lastCommittedTurnId",
  "messages",
] as const;

export interface KimiCodeSessionSnapshot {
  schemaVersion: typeof KIMI_CODE_STATE_SCHEMA_VERSION;
  provider: typeof KIMI_CODE_PROVIDER_ID;
  model: string;
  sessionId: string;
  revision: number;
  cwd: string;
  lastCommittedTurnId: string;
  messages: KimiCodeConversationMessage[];
}

export interface CommitKimiCodeSessionStateInput {
  model: string;
  cwd: string;
  lastCommittedTurnId: string;
  messages: readonly KimiCodeConversationMessage[];
  previousSnapshot?: KimiCodeSessionSnapshot;
  env?: NodeJS.ProcessEnv;
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
  const previous = input.previousSnapshot;
  if (previous) validatePreviousSnapshot(previous, input.model, cwd);
  if (!input.lastCommittedTurnId.trim()) throw stateError("turn id is invalid");
  const messages = validateMessages(input.messages);
  const snapshot: KimiCodeSessionSnapshot = {
    schemaVersion: KIMI_CODE_STATE_SCHEMA_VERSION,
    provider: KIMI_CODE_PROVIDER_ID,
    model: input.model,
    sessionId: previous?.sessionId ?? randomUUID(),
    revision: (previous?.revision ?? 0) + 1,
    cwd,
    lastCommittedTurnId: input.lastCommittedTurnId,
    messages,
  };
  const serialized = JSON.stringify(snapshot);
  if (containsConfiguredCredential(serialized, input.env)) {
    throw new Error("Kimi Code session state contains configured credential");
  }
  if (Buffer.byteLength(serialized, "utf8") > KIMI_CODE_MAX_STATE_BYTES) {
    throw new Error("Kimi Code session state exceeds maximum size");
  }

  const root = stateRoot(input.env);
  const sessionDirectory = join(root, snapshot.sessionId);
  await assertNoExistingReparsePoints(sessionDirectory);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await assertNoExistingReparsePoints(sessionDirectory);
  await applyPrivatePermissions(sessionDirectory, true);

  const finalPath = join(sessionDirectory, revisionFilename(snapshot.revision));
  const reservationPath = `${finalPath}.lock`;
  const temporaryPath = join(sessionDirectory, `.${revisionFilename(snapshot.revision)}.${randomUUID()}.tmp`);
  let reserved = false;
  let temporaryCreated = false;
  try {
    const reservation = await open(reservationPath, "wx", 0o600);
    reserved = true;
    await reservation.close();
    if (await pathExists(finalPath)) throw stateError("revision already exists");

    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await applyPrivatePermissions(temporaryPath, false);
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await assertNoExistingReparsePoints(sessionDirectory);
    await link(temporaryPath, finalPath);
    await unlink(temporaryPath);
    temporaryCreated = false;
    await syncDirectory(sessionDirectory);
  } catch (error) {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (reserved) await unlink(reservationPath).catch(() => undefined);
    throw error;
  }
  await unlink(reservationPath).catch(() => undefined);

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
        sessionFile: finalPath,
        lastCommittedTurnId: snapshot.lastCommittedTurnId,
      },
      displayId: snapshot.sessionId,
    },
  };
}

export async function loadKimiCodeSessionState(input: LoadKimiCodeSessionStateInput): Promise<KimiCodeSessionSnapshot> {
  const params = parseLocator(input.session);
  const expectedCwd = normalizeCwd(input.cwd);
  if (params.provider !== KIMI_CODE_PROVIDER_ID) throw stateError("provider mismatch");
  if (params.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION) throw stateError("schema mismatch");
  if (params.model !== input.model) throw stateError("model mismatch");
  if (!samePath(params.cwd, expectedCwd)) throw stateError("cwd mismatch");
  if (!UUID_PATTERN.test(params.sessionId)) throw stateError("session id is invalid");
  if (!Number.isSafeInteger(params.revision) || params.revision < 1) throw stateError("revision is invalid");
  if (!params.lastCommittedTurnId.trim()) throw stateError("turn id is invalid");
  if (!isAbsolute(params.sessionFile) || hasTraversalSegment(params.sessionFile)) {
    throw stateError("session path is invalid");
  }

  const root = stateRoot(input.env);
  const sessionDirectory = join(root, params.sessionId);
  const expectedFile = join(sessionDirectory, revisionFilename(params.revision));
  if (!samePath(params.sessionFile, expectedFile) || !isPathInside(root, params.sessionFile)) {
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

  const bytes = await readFile(params.sessionFile);
  if (bytes.byteLength > KIMI_CODE_MAX_STATE_BYTES) throw stateError("session file is oversized");
  if (containsConfiguredCredential(bytes.toString("utf8"), input.env)) {
    throw stateError("session file contains configured credential");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw stateError("session file is corrupt");
  }
  const snapshot = parseSnapshot(decoded);
  if (
    snapshot.schemaVersion !== params.schemaVersion ||
    snapshot.provider !== params.provider ||
    snapshot.model !== params.model ||
    snapshot.sessionId !== params.sessionId ||
    snapshot.revision !== params.revision ||
    !samePath(snapshot.cwd, params.cwd) ||
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
  return `revision-${revision.toString().padStart(8, "0")}.json`;
}

function parseLocator(session: RuntimeSessionState): {
  schemaVersion: number;
  provider: string;
  model: string;
  sessionId: string;
  revision: number;
  cwd: string;
  sessionFile: string;
  lastCommittedTurnId: string;
} {
  const params = session.params;
  if (!isRecord(params) || !hasExactKeys(params, LOCATOR_KEYS)) throw stateError("locator is invalid");
  if (
    typeof params.schemaVersion !== "number" ||
    typeof params.provider !== "string" ||
    typeof params.model !== "string" ||
    typeof params.sessionId !== "string" ||
    typeof params.revision !== "number" ||
    typeof params.cwd !== "string" ||
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
    typeof value.lastCommittedTurnId !== "string" ||
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
    lastCommittedTurnId: value.lastCommittedTurnId,
    messages: validateMessages(value.messages),
  };
}

function validatePreviousSnapshot(snapshot: KimiCodeSessionSnapshot, model: string, cwd: string): void {
  if (
    snapshot.schemaVersion !== KIMI_CODE_STATE_SCHEMA_VERSION ||
    snapshot.provider !== KIMI_CODE_PROVIDER_ID ||
    snapshot.model !== model ||
    !UUID_PATTERN.test(snapshot.sessionId) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !samePath(snapshot.cwd, cwd) ||
    !snapshot.lastCommittedTurnId.trim()
  ) {
    throw stateError("previous snapshot is invalid");
  }
  validateMessages(snapshot.messages);
}

function validateMessages(messages: readonly unknown[]): KimiCodeConversationMessage[] {
  return messages.map((message) => {
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

async function applyPrivatePermissions(path: string, directory: boolean): Promise<void> {
  await chmod(path, directory ? 0o700 : 0o600);
  if (process.platform !== "win32") return;
  const username = process.env.USERNAME?.trim() || userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  const account = domain ? `${domain}\\${username}` : username;
  const inheritance = directory ? "(OI)(CI)F" : "(F)";
  await execFileAsync("icacls", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${account}:${inheritance}`,
    `*S-1-5-18:${inheritance}`,
    `*S-1-5-32-544:${inheritance}`,
    "/Q",
  ]);
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
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function containsConfiguredCredential(serialized: string, env?: NodeJS.ProcessEnv): boolean {
  const apiKey = env?.KIMI_API_KEY ?? process.env.KIMI_API_KEY;
  return typeof apiKey === "string" && apiKey.length > 0 && serialized.includes(apiKey);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateError(reason: string): Error {
  return new Error(`Kimi Code session state is invalid: ${reason}`);
}

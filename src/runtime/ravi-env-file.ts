/**
 * Atomic allowlisted writes to the Ravi env file (`$RAVI_STATE_DIR/.env`).
 *
 * Hub and the SDK gateway use this instead of the interactive `ravi setup`
 * wizard. Values are never logged here; callers must keep secrets out of
 * stdout, audit, and error envelopes.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { describeResolvedSecretShapeMismatch } from "./credential-secret-shape.js";
import { clearRaviEnvFileSourced, isRaviEnvFileSourced, markRaviEnvFileSourced } from "./ravi-env-file-origin.js";

const ENV_DIR_MODE = 0o700;
const ENV_FILE_MODE = 0o600;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_UNQUOTED_VALUE_RE = /^[A-Za-z0-9_./:@+-]+$/;

/**
 * v1 allowlist. Extend only with a comment naming the consumer.
 * Fail closed on any other key — this file is world-readable to the
 * daemon process and must not become a generic secret dump.
 */
export const RAVI_ENV_ALLOWLIST = [
  // Claude Code subscription / OAuth (primary Claude auth in Ravi)
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Anthropic API key (secondary / explicit API-key agents)
  "ANTHROPIC_API_KEY",
  // Anthropic auth token (enterprise / cloud)
  "ANTHROPIC_AUTH_TOKEN",
  // Codex isolated profile home (Hub: ~/.ravi/codex)
  "CODEX_HOME",
  // Grok isolated profile home (Hub: ~/.ravi/grok)
  "GROK_HOME",
  // Closed-box grok CLI must not self-update
  "GROK_DISABLE_AUTOUPDATER",
] as const;

export type RaviEnvAllowlistKey = (typeof RAVI_ENV_ALLOWLIST)[number];

const ALLOWLIST = new Set<string>(RAVI_ENV_ALLOWLIST);

/** Keys whose stored values must never be returned by `get`. */
export const RAVI_ENV_SECRET_KEYS = new Set<string>([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
]);

export class RaviEnvFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RaviEnvFileError";
    this.code = code;
  }
}

export type RaviEnvOrigin = "file" | "process" | "file+process" | "absent";

export type RaviEnvEntry = {
  key: string;
  present: boolean;
  processPresent: boolean;
  origin: RaviEnvOrigin;
  secret: boolean;
  redacted: boolean;
  value: string | null;
  path: string;
};

export type RaviEnvMutation = RaviEnvEntry & {
  action: "set" | "unset";
  daemonReloadRequired: boolean;
};

type EnvLine = { raw: string; ending: string; key?: string; value?: string };
type Snapshot = { bytes: Buffer; info?: Stats };
type Directory = { path: string; info: Stats };
const MAX_ENV_BYTES = 1024 * 1024;

export function getRaviEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), ".env");
}

export function isRaviEnvAllowlisted(key: string): boolean {
  return ALLOWLIST.has(key);
}

export function isRaviEnvSecretKey(key: string): boolean {
  return RAVI_ENV_SECRET_KEYS.has(key);
}

export function assertRaviEnvKey(key: string): string {
  const normalized = key.trim();
  if (!ENV_KEY_RE.test(normalized)) {
    throw new RaviEnvFileError("ENV_KEY_INVALID", `Invalid env key '${key}'. Keys must match ^[A-Z][A-Z0-9_]*$.`);
  }
  if (!isRaviEnvAllowlisted(normalized)) {
    throw new RaviEnvFileError(
      "ENV_KEY_NOT_ALLOWED",
      `Env key '${normalized}' is not in the v1 allowlist. Allowed: ${RAVI_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  return normalized;
}

function envOrigin(filePresent: boolean, processPresent: boolean): RaviEnvOrigin {
  if (filePresent && processPresent) return "file+process";
  if (filePresent) return "file";
  if (processPresent) return "process";
  return "absent";
}

function assertRaviEnvSecretShape(key: string, value: string): void {
  const mismatch = describeResolvedSecretShapeMismatch({
    label: "Ravi env file",
    authMethod:
      key === "CLAUDE_CODE_OAUTH_TOKEN" ? "claude-oauth" : key === "ANTHROPIC_API_KEY" ? "api-key" : undefined,
    targetName: key,
    value,
  });
  if (!mismatch) return;
  throw new RaviEnvFileError(
    "SECRET_SHAPE_MISMATCH",
    mismatch.expected === "oauth"
      ? `${key} must be a Claude OAuth token (sk-ant-oat), not an Anthropic API key. Put API keys in ANTHROPIC_API_KEY.`
      : `${key} must be an Anthropic API key (sk-ant-api), not an OAuth token. Put OAuth tokens in CLAUDE_CODE_OAUTH_TOKEN.`,
  );
}

export function assertRaviEnvValue(value: string): string {
  if (value.length === 0) {
    throw new RaviEnvFileError("ENV_VALUE_INVALID", "Env value must not be empty. Use unset to remove a key.");
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\u0000")) {
    throw new RaviEnvFileError("ENV_VALUE_INVALID", "Env value must not contain newlines or NUL bytes.");
  }
  if (/[\uFEFF\u2028\u2029]/.test(value) || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new RaviEnvFileError(
      "ENV_VALUE_INVALID",
      "Env value must be valid Unicode without BOM or Unicode line separators.",
    );
  }
  return value;
}

export function getRaviEnvKey(key: string, env: NodeJS.ProcessEnv = process.env): RaviEnvEntry {
  const normalized = assertRaviEnvKey(key);
  const path = getRaviEnvFilePath(env);
  const fileEnv = readRaviEnvMap(env);
  const present = fileEnv.has(normalized);
  // The CLI/daemon copy the env file into process.env at startup; that copy is
  // the file value, not an inherited process value. Once the file changes or
  // drops the key (e.g. from another CLI process), the retained copy is a real
  // process value again: this process keeps using it until restart.
  const fileCopy = isRaviEnvFileSourced(env, normalized, path) && fileEnv.get(normalized) === env[normalized];
  const processPresent = Boolean(env[normalized]?.trim()) && !fileCopy;
  const secret = isRaviEnvSecretKey(normalized);
  return {
    key: normalized,
    present,
    processPresent,
    origin: envOrigin(present, processPresent),
    secret,
    redacted: secret && (present || processPresent),
    value: present ? (secret ? "[REDACTED]" : (fileEnv.get(normalized) ?? null)) : null,
    path,
  };
}

export function setRaviEnvKey(key: string, value: string, env: NodeJS.ProcessEnv = process.env): RaviEnvMutation {
  return putRaviEnvKey(key, value, env, false);
}

/** Add-only is checked under the same file lock as every managed set/unset. */
export function addRaviEnvKey(key: string, value: string, env: NodeJS.ProcessEnv = process.env): RaviEnvMutation {
  return putRaviEnvKey(key, value, env, true);
}

function putRaviEnvKey(key: string, value: string, env: NodeJS.ProcessEnv, addOnly: boolean): RaviEnvMutation {
  const normalized = assertRaviEnvKey(key);
  const nextValue = assertRaviEnvValue(value);
  assertRaviEnvSecretShape(normalized, nextValue);
  mutateEnvFile(normalized, nextValue, env, addOnly);
  env[normalized] = nextValue;
  markRaviEnvFileSourced(env, normalized, nextValue, getRaviEnvFilePath(env));
  const secret = isRaviEnvSecretKey(normalized);
  return {
    key: normalized,
    present: true,
    processPresent: false,
    origin: "file",
    secret,
    redacted: secret,
    value: secret ? "[REDACTED]" : nextValue,
    path: getRaviEnvFilePath(env),
    action: "set",
    daemonReloadRequired: true,
  };
}

export function unsetRaviEnvKey(key: string, env: NodeJS.ProcessEnv = process.env): RaviEnvMutation {
  const normalized = assertRaviEnvKey(key);
  const fileHadKey = mutateEnvFile(normalized, undefined, env, false);
  if (fileHadKey) {
    if (isRaviEnvFileSourced(env, normalized, getRaviEnvFilePath(env))) delete env[normalized];
    clearRaviEnvFileSourced(env, normalized);
  }
  return { ...getRaviEnvKey(normalized, env), action: "unset", daemonReloadRequired: fileHadKey };
}

function fixedError(code: string): RaviEnvFileError {
  return new RaviEnvFileError(code, code);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function infoIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    // no-cause: Only absence is recoverable; filesystem diagnostics never leave the env boundary.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw fixedError("ENV_FILE_UNAVAILABLE");
  }
}

function assertFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== ENV_FILE_MODE || info.uid !== process.getuid?.()) {
    throw fixedError("ENV_PATH_UNSAFE");
  }
}

/** Only local POSIX state directories. No project paths, link resolution or permission repairs. */
function directories(env: NodeJS.ProcessEnv, create: boolean): Directory[] {
  const dir = getRaviStateDir(env);
  if (!process.getuid || !["darwin", "linux"].includes(process.platform) || !isAbsolute(dir) || resolve(dir) !== dir) {
    throw fixedError("ENV_PATH_UNSAFE");
  }
  const paths: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    paths.unshift(current);
    if (current === dirname(current)) break;
  }
  const result: Directory[] = [];
  for (const path of paths) {
    let info = infoIfExists(path);
    if (!info && create) {
      mkdirSync(path, { mode: ENV_DIR_MODE });
      info = lstatSync(path);
    }
    if (!info) return [];
    // A root-owned sticky /tmp may contain the private state directory. Other
    // group/world writable ancestors, symlinks and foreign owners are refused.
    const stickyRoot = path !== dir && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid()) ||
      ((info.mode & 0o022) !== 0 && !stickyRoot) ||
      (path === dir && info.uid !== process.getuid())
    ) {
      throw fixedError("ENV_PATH_UNSAFE");
    }
    result.push({ path, info });
  }
  return result;
}

function assertDirectories(expected: Directory[]): void {
  for (const entry of expected) {
    const info = infoIfExists(entry.path);
    if (!info || !sameFile(entry.info, info) || info.mode !== entry.info.mode || info.uid !== entry.info.uid) {
      throw fixedError("ENV_FILE_CONFLICT");
    }
  }
}

function snapshot(path: string): Snapshot {
  const before = infoIfExists(path);
  if (!before) return { bytes: Buffer.alloc(0) };
  assertFile(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    assertFile(info);
    if (!sameFile(before, info) || info.size > MAX_ENV_BYTES) throw fixedError("ENV_FILE_CONFLICT");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      bytes.length > MAX_ENV_BYTES ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    ) {
      throw fixedError("ENV_FILE_CONFLICT");
    }
    return { bytes, info: after };
  } finally {
    closeSync(fd);
  }
}

export function readRaviEnvMap(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  try {
    const dirs = directories(env, false);
    if (!dirs.length) return new Map();
    const current = snapshot(getRaviEnvFilePath(env));
    assertDirectories(dirs);
    return parseEnvAssignments(decode(current.bytes));
  } catch (error) {
    // no-cause: Env reads must not expose paths, raw file content or OS errors.
    if (error instanceof RaviEnvFileError) throw error;
    throw fixedError("ENV_FILE_UNAVAILABLE");
  }
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // no-cause: Invalid file bytes are secret-bearing data, not diagnostics.
    throw fixedError("ENV_FORMAT_UNSUPPORTED");
  }
}

/** Cleanup only the inode this call created; never remove a preexisting path. */
function removeOwned(path: string, info: Stats | undefined): void {
  if (!info) return;
  try {
    const current = infoIfExists(path);
    if (current && sameFile(current, info)) unlinkSync(path);
  } catch {
    // no-cause: Best-effort cleanup leaves a fail-closed lock/temp on error; no raw filesystem details.
  }
}

function mutateEnvFile(key: string, value: string | undefined, env: NodeJS.ProcessEnv, addOnly: boolean): boolean {
  let lockFd: number | undefined;
  let lockInfo: Stats | undefined;
  let temporaryFd: number | undefined;
  let temporaryInfo: Stats | undefined;
  let directoryFd: number | undefined;
  let temporary: string | undefined;
  const path = getRaviEnvFilePath(env);
  const lockPath = `${path}.lock`;
  let committed = false;
  try {
    const dirs = directories(env, true);
    const parent = dirs[dirs.length - 1]!;
    directoryFd = openSync(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameFile(parent.info, fstatSync(directoryFd))) throw fixedError("ENV_FILE_CONFLICT");
    try {
      lockFd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        ENV_FILE_MODE,
      );
    } catch (error) {
      // no-cause: A preexisting lock is busy/unsafe, never followed or stolen; OS diagnostics may include paths.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw fixedError("ENV_FILE_BUSY");
      throw fixedError("ENV_PATH_UNSAFE");
    }
    lockInfo = fstatSync(lockFd);
    assertFile(lockInfo);
    assertDirectories(dirs);
    const current = snapshot(path);
    const lines = parseEnvLines(decode(current.bytes));
    const matches = lines.filter((line) => line.key === key);
    if (addOnly && (matches.length > 0 || Object.hasOwn(env, key))) throw fixedError("ENV_KEY_EXISTS");
    if (matches.length > 1) throw fixedError("ENV_FORMAT_UNSUPPORTED");
    if (value === undefined && matches.length === 0) return false;
    const next = patchEnvLines(lines, key, value);
    if (value !== undefined && parseEnvAssignments(next).get(key) !== value) throw fixedError("ENV_VALUE_INVALID");
    if (Buffer.byteLength(next) > MAX_ENV_BYTES) throw fixedError("ENV_FORMAT_UNSUPPORTED");
    assertDirectories(dirs);
    temporary = `${path}.${randomUUID()}.tmp`;
    temporaryFd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      ENV_FILE_MODE,
    );
    temporaryInfo = fstatSync(temporaryFd);
    assertFile(temporaryInfo);
    assertDirectories(dirs);
    writeFileSync(temporaryFd, next, "utf8");
    fsyncSync(temporaryFd);
    // Detect non-cooperating edits observed before commit, including same-size
    // edits, replacement and new files. This is not a lock on external editors.
    const latest = snapshot(path);
    if (
      Boolean(current.info) !== Boolean(latest.info) ||
      (current.info &&
        latest.info &&
        (!sameFile(current.info, latest.info) ||
          current.info.mtimeMs !== latest.info.mtimeMs ||
          current.info.ctimeMs !== latest.info.ctimeMs)) ||
      !current.bytes.equals(latest.bytes)
    )
      throw fixedError("ENV_FILE_CONFLICT");
    assertDirectories(dirs);
    const namedTemp = infoIfExists(temporary);
    const namedLock = infoIfExists(lockPath);
    if (!namedTemp || !namedLock || !sameFile(namedTemp, temporaryInfo) || !sameFile(namedLock, lockInfo))
      throw fixedError("ENV_FILE_CONFLICT");
    assertFile(namedTemp);
    assertFile(namedLock);
    renameSync(temporary, path);
    committed = true;
    temporary = undefined;
    fsyncSync(directoryFd);
    return matches.length > 0;
  } catch (error) {
    // no-cause: No raw OS error/cause or env bytes cross the writer boundary. Post-rename failures are uncertain.
    if (committed) throw fixedError("ENV_WRITE_UNCERTAIN");
    if (error instanceof RaviEnvFileError) throw error;
    throw fixedError("ENV_WRITE_FAILED");
  } finally {
    for (const fd of [temporaryFd, lockFd, directoryFd]) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // no-cause: Descriptor cleanup cannot change the known write result or leak secret-bearing OS diagnostics.
        }
      }
    }
    if (temporary) removeOwned(temporary, temporaryInfo);
    removeOwned(lockPath, lockInfo);
  }
}

export function parseEnvAssignments(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of parseEnvLines(content)) if (line.key !== undefined) values.set(line.key, line.value!);
  return values;
}

/** The real daemon/CLI dialect: one physical line, literal values, outer quotes only. */
function parseEnvLines(content: string): EnvLine[] {
  if (content.includes("\0") || content.includes("\uFEFF")) throw fixedError("ENV_FORMAT_UNSUPPORTED");
  const lines: EnvLine[] = [];
  for (const part of content.matchAll(/([^\n]*)(\n|$)/g)) {
    if (!part[0]) continue;
    let raw = part[1]!;
    let ending = part[2]!;
    if (ending && raw.endsWith("\r")) {
      raw = raw.slice(0, -1);
      ending = "\r\n";
    }
    if (raw.includes("\r")) throw fixedError("ENV_FORMAT_UNSUPPORTED");
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      lines.push({ raw, ending });
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (!match) throw fixedError("ENV_FORMAT_UNSUPPORTED");
    const key = match[1]!;
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith(value[0]!)) throw fixedError("ENV_FORMAT_UNSUPPORTED");
      value = value.slice(1, -1);
    }
    lines.push({ raw, ending, key, value });
  }
  return lines;
}

function patchEnvLines(lines: EnvLine[], key: string, value: string | undefined): string {
  let found = false;
  const rendered = lines
    .map((line) => {
      if (line.key !== key) return line.raw + line.ending;
      found = true;
      return value === undefined ? "" : `${key}=${serializeEnvValue(value)}${line.ending}`;
    })
    .join("");
  if (found || value === undefined) return rendered;
  const ending = lines.find((line) => line.ending)?.ending ?? "\n";
  return `${rendered}${rendered && !rendered.endsWith("\n") ? ending : ""}${key}=${serializeEnvValue(value)}${ending}`;
}

function serializeEnvValue(value: string): string {
  // No escaping: both production consumers strip exactly one outer quote pair.
  // Quotes/backslashes/$/# inside remain literal, including leading/trailing whitespace.
  return SAFE_UNQUOTED_VALUE_RE.test(value) ? value : `"${value}"`;
}

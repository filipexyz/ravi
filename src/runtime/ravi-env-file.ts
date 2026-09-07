/**
 * Atomic allowlisted writes to the Ravi env file (`$RAVI_STATE_DIR/.env`).
 *
 * Hub and the SDK gateway use this instead of the interactive `ravi setup`
 * wizard. Values are never logged here; callers must keep secrets out of
 * stdout, audit, and error envelopes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

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

export type RaviEnvEntry = {
  key: string;
  present: boolean;
  secret: boolean;
  redacted: boolean;
  value: string | null;
  path: string;
};

export type RaviEnvMutation = RaviEnvEntry & {
  action: "set" | "unset";
  daemonReloadRequired: boolean;
};

type EnvLine =
  | { kind: "blank"; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "assignment"; key: string; value: string; raw: string }
  | { kind: "other"; raw: string };

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

export function assertRaviEnvValue(value: string): string {
  if (value.length === 0) {
    throw new RaviEnvFileError("ENV_VALUE_INVALID", "Env value must not be empty. Use unset to remove a key.");
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\u0000")) {
    throw new RaviEnvFileError("ENV_VALUE_INVALID", "Env value must not contain newlines or NUL bytes.");
  }
  return value;
}

export function getRaviEnvKey(key: string, env: NodeJS.ProcessEnv = process.env): RaviEnvEntry {
  const normalized = assertRaviEnvKey(key);
  const path = getRaviEnvFilePath(env);
  const fileEnv = readRaviEnvMap(env);
  const present = fileEnv.has(normalized);
  const secret = isRaviEnvSecretKey(normalized);
  return {
    key: normalized,
    present,
    secret,
    redacted: secret && present,
    value: present ? (secret ? "[REDACTED]" : (fileEnv.get(normalized) ?? null)) : null,
    path,
  };
}

export function setRaviEnvKey(key: string, value: string, env: NodeJS.ProcessEnv = process.env): RaviEnvMutation {
  const normalized = assertRaviEnvKey(key);
  const nextValue = assertRaviEnvValue(value);
  writeRaviEnvMap(upsertEnvMap(readRaviEnvMap(env), normalized, nextValue), env);
  env[normalized] = nextValue;
  return {
    ...getRaviEnvKey(normalized, env),
    action: "set",
    daemonReloadRequired: true,
  };
}

export function unsetRaviEnvKey(key: string, env: NodeJS.ProcessEnv = process.env): RaviEnvMutation {
  const normalized = assertRaviEnvKey(key);
  const current = readRaviEnvMap(env);
  if (current.has(normalized)) {
    current.delete(normalized);
    writeRaviEnvMap(current, env);
  }
  delete env[normalized];
  return {
    ...getRaviEnvKey(normalized, env),
    action: "unset",
    daemonReloadRequired: true,
  };
}

export function readRaviEnvMap(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const path = getRaviEnvFilePath(env);
  if (!existsSync(path)) return new Map();
  return parseEnvAssignments(readFileSync(path, "utf8"));
}

function writeRaviEnvMap(values: Map<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  const path = getRaviEnvFilePath(env);
  const dir = getRaviStateDir(env);
  mkdirSync(dir, { recursive: true, mode: ENV_DIR_MODE });
  chmodSync(dir, ENV_DIR_MODE);

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = renderEnvFile(existing, values);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, next, { mode: ENV_FILE_MODE });
  chmodSync(tmpPath, ENV_FILE_MODE);
  renameSync(tmpPath, path);
  chmodSync(path, ENV_FILE_MODE);
}

function upsertEnvMap(current: Map<string, string>, key: string, value: string): Map<string, string> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

export function parseEnvAssignments(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of parseEnvLines(content)) {
    if (line.kind === "assignment") values.set(line.key, line.value);
  }
  return values;
}

function parseEnvLines(content: string): EnvLine[] {
  if (content.length === 0) return [];
  const rawLines = content.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  return rawLines.map((raw) => parseEnvLine(raw));
}

function parseEnvLine(raw: string): EnvLine {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "blank", raw };
  if (trimmed.startsWith("#")) return { kind: "comment", raw };
  const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = assignment.indexOf("=");
  if (eq <= 0) return { kind: "other", raw };
  const key = assignment.slice(0, eq).trim();
  if (!ENV_KEY_RE.test(key)) return { kind: "other", raw };
  return { kind: "assignment", key, value: unquoteEnvValue(assignment.slice(eq + 1).trim()), raw };
}

function renderEnvFile(existing: string, values: Map<string, string>): string {
  const remaining = new Map(values);
  const rendered: string[] = [];
  for (const line of parseEnvLines(existing)) {
    if (line.kind !== "assignment") {
      rendered.push(line.raw);
      continue;
    }
    const next = remaining.get(line.key);
    if (next === undefined) continue;
    rendered.push(`${line.key}=${serializeEnvValue(next)}`);
    remaining.delete(line.key);
  }
  for (const [key, value] of remaining) {
    rendered.push(`${key}=${serializeEnvValue(value)}`);
  }
  return `${rendered.join("\n")}\n`;
}

function serializeEnvValue(value: string): string {
  if (SAFE_UNQUOTED_VALUE_RE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return value;
}

/**
 * Headless device-code login for Codex and Grok CLIs.
 *
 * Hub drives this through the SDK gateway: start returns verificationUrl +
 * userCode for the UI, then status/complete after the human authorizes.
 * Tokens never land in session files, logs, or returned payloads.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { getRaviEnvKey, setRaviEnvKey } from "./ravi-env-file.js";

const STORE_DIR_MODE = 0o700;
const SESSION_FILE_MODE = 0o600;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export const DEVICE_LOGIN_PROVIDERS = ["codex", "grok"] as const;
export type DeviceLoginProvider = (typeof DEVICE_LOGIN_PROVIDERS)[number];
export type DeviceLoginStatus = "pending" | "authorized" | "failed" | "cancelled";

export class ProviderDeviceLoginError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProviderDeviceLoginError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type DeviceLoginSession = {
  id: string;
  provider: DeviceLoginProvider;
  status: DeviceLoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  home: string;
  pid: number | null;
  command: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  replacedLoginId?: string;
  error?: string;
};

export type DeviceLoginProcess = {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  unref?: () => void;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type DeviceLoginDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  spawn?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; detached: boolean },
  ) => DeviceLoginProcess;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal?: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  startTimeoutMs?: number;
};

export function getProviderLoginDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "provider-logins");
}

export function defaultProviderHome(provider: DeviceLoginProvider, env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), provider);
}

export function parseDeviceLoginPrompt(text: string): { verificationUrl?: string; userCode?: string } {
  const clean = stripAnsi(text);
  const fromJson = parseEmbeddedJsonPrompt(clean);
  const verificationUrl = fromJson.verificationUrl ?? firstHttpUrl(clean);
  const userCode = fromJson.userCode ?? standaloneUserCode(clean) ?? labeledUserCode(clean);
  return { ...(verificationUrl ? { verificationUrl } : {}), ...(userCode ? { userCode } : {}) };
}

export function listDeviceLogins(
  provider?: DeviceLoginProvider,
  env: NodeJS.ProcessEnv = process.env,
): DeviceLoginSession[] {
  const dir = getProviderLoginDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => readSessionFile(join(dir, name)))
    .filter((session): session is DeviceLoginSession => Boolean(session))
    .filter((session) => (provider ? session.provider === provider : true))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getDeviceLogin(id: string, env: NodeJS.ProcessEnv = process.env): DeviceLoginSession | null {
  return readSessionFile(sessionPath(id, env));
}

export function requireDeviceLogin(id: string, env: NodeJS.ProcessEnv = process.env): DeviceLoginSession {
  const session = getDeviceLogin(id, env);
  if (!session) {
    throw new ProviderDeviceLoginError("LOGIN_NOT_FOUND", `Provider login not found: ${id}`);
  }
  return session;
}

export async function startDeviceLogin(
  provider: DeviceLoginProvider,
  deps: DeviceLoginDeps = {},
): Promise<DeviceLoginSession> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const home = resolveProviderHome(provider, env);
  persistProviderHome(provider, home, env);

  const pending = listDeviceLogins(provider, env).filter((session) => session.status === "pending");
  let replacedLoginId: string | undefined;
  for (const previous of pending) {
    cancelDeviceLogin(previous.id, { ...deps, env });
    replacedLoginId = previous.id;
  }

  const command = resolveProviderCommand(provider, env);
  const child = (deps.spawn ?? defaultSpawn)(command, ["login", "--device-auth"], {
    env: buildLoginEnv(provider, home, env),
    detached: true,
  });
  const id = `plogin_${randomBytes(8).toString("hex")}`;
  const session: DeviceLoginSession = {
    id,
    provider,
    status: "pending",
    verificationUrl: null,
    userCode: null,
    home,
    pid: child.pid ?? null,
    command,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + DEFAULT_EXPIRES_MS).toISOString(),
    ...(replacedLoginId ? { replacedLoginId } : {}),
  };
  writeSession(session, env);
  child.unref?.();

  const prompt = await collectPrompt(child, deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, deps.sleep);
  const parsed = parseDeviceLoginPrompt(prompt);
  if (!parsed.verificationUrl || !parsed.userCode) {
    child.kill("SIGTERM");
    const failed: DeviceLoginSession = {
      ...session,
      status: "failed",
      updatedAt: new Date(now()).toISOString(),
      error: "LOGIN_PROMPT_TIMEOUT",
    };
    writeSession(failed, env);
    throw new ProviderDeviceLoginError(
      "LOGIN_PROMPT_TIMEOUT",
      `The ${provider} login process did not print a verification URL and user code. Confirm '${command} login --device-auth' is installed and supports device auth.`,
    );
  }

  const ready: DeviceLoginSession = {
    ...session,
    verificationUrl: parsed.verificationUrl,
    userCode: parsed.userCode,
    updatedAt: new Date(now()).toISOString(),
  };
  writeSession(ready, env);
  return refreshDeviceLogin(ready.id, deps);
}

export function refreshDeviceLogin(id: string, deps: DeviceLoginDeps = {}): DeviceLoginSession {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const session = requireDeviceLogin(id, env);
  if (session.status === "cancelled" || session.status === "authorized") return session;

  const currentTime = now();
  if (providerAuthReady(session.provider, session.home)) {
    const authorized: DeviceLoginSession = {
      ...session,
      status: "authorized",
      updatedAt: new Date(currentTime).toISOString(),
      error: undefined,
    };
    writeSession(authorized, env);
    return authorized;
  }

  const pidAlive = session.pid != null && (deps.isPidAlive ?? isPidAlive)(session.pid);
  if (!pidAlive) {
    const failed: DeviceLoginSession = {
      ...session,
      status: "failed",
      pid: null,
      updatedAt: new Date(currentTime).toISOString(),
      error: "LOGIN_PROCESS_EXITED",
    };
    writeSession(failed, env);
    return failed;
  }

  if (currentTime >= Date.parse(session.expiresAt)) {
    (deps.killPid ?? killPid)(session.pid!, "SIGTERM");
    const expired: DeviceLoginSession = {
      ...session,
      status: "failed",
      updatedAt: new Date(currentTime).toISOString(),
      error: "LOGIN_EXPIRED",
    };
    writeSession(expired, env);
    return expired;
  }

  return session;
}

export function cancelDeviceLogin(id: string, deps: DeviceLoginDeps = {}): DeviceLoginSession {
  const env = deps.env ?? process.env;
  const session = requireDeviceLogin(id, env);
  if (session.status === "cancelled") return session;
  if (session.pid != null) {
    try {
      (deps.killPid ?? killPid)(session.pid, "SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }
  const cancelled: DeviceLoginSession = {
    ...session,
    status: "cancelled",
    pid: null,
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    error: undefined,
  };
  writeSession(cancelled, env);
  return cancelled;
}

export function requireAuthorizedLogin(id: string, deps: DeviceLoginDeps = {}): DeviceLoginSession {
  const session = refreshDeviceLogin(id, deps);
  if (session.status === "authorized") return session;
  if (session.status === "pending") {
    throw new ProviderDeviceLoginError(
      "LOGIN_NOT_READY",
      `Provider login ${id} is still pending. Complete the device code in the browser, then retry status/complete.`,
      true,
    );
  }
  if (session.status === "cancelled") {
    throw new ProviderDeviceLoginError("LOGIN_CANCELLED", `Provider login ${id} was cancelled.`);
  }
  throw new ProviderDeviceLoginError(
    "LOGIN_FAILED",
    `Provider login ${id} failed${session.error ? ` (${session.error})` : ""}. Start a new login.`,
  );
}

export function providerAuthReady(provider: DeviceLoginProvider, home: string): boolean {
  const candidates =
    provider === "codex" ? [join(home, "auth.json")] : [join(home, "auth.json"), join(home, ".grok", "auth.json")];
  return candidates.some((path) => existsSync(path));
}

export function publicDeviceLogin(session: DeviceLoginSession): DeviceLoginSession {
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    home: session.home,
    pid: session.pid,
    command: session.command,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    ...(session.replacedLoginId ? { replacedLoginId: session.replacedLoginId } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function resolveProviderHome(provider: DeviceLoginProvider, env: NodeJS.ProcessEnv): string {
  const key = provider === "codex" ? "CODEX_HOME" : "GROK_HOME";
  const fromEnv = env[key]?.trim();
  if (fromEnv) return fromEnv;
  const stored = getRaviEnvKey(key, env);
  if (stored.present && stored.value && stored.value !== "[REDACTED]") return stored.value;
  return defaultProviderHome(provider, env);
}

function persistProviderHome(provider: DeviceLoginProvider, home: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(home, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(home, STORE_DIR_MODE);
  setRaviEnvKey(provider === "codex" ? "CODEX_HOME" : "GROK_HOME", home, env);
  if (provider === "grok") setRaviEnvKey("GROK_DISABLE_AUTOUPDATER", "1", env);
}

function resolveProviderCommand(provider: DeviceLoginProvider, env: NodeJS.ProcessEnv): string {
  if (provider === "codex") return env.RAVI_CODEX_COMMAND?.trim() || "codex";
  return env.RAVI_GROK_COMMAND?.trim() || "grok";
}

function buildLoginEnv(provider: DeviceLoginProvider, home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    USER: env.USER,
    LANG: env.LANG,
  };
  if (provider === "codex") {
    next.CODEX_HOME = home;
  } else {
    next.GROK_HOME = home;
    next.GROK_DISABLE_AUTOUPDATER = "1";
  }
  return next;
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; detached: boolean },
): DeviceLoginProcess {
  return spawn(command, args, {
    detached: options.detached,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function collectPrompt(
  child: DeviceLoginProcess,
  timeoutMs: number,
  sleep: DeviceLoginDeps["sleep"],
): Promise<string> {
  let output = "";
  const append = (chunk: unknown) => {
    output += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const wait = sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parsed = parseDeviceLoginPrompt(output);
    if (parsed.verificationUrl && parsed.userCode) return output;
    await wait(50);
  }
  return output;
}

function sessionPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(getProviderLoginDir(env), `${id}.json`);
}

function writeSession(session: DeviceLoginSession, env: NodeJS.ProcessEnv): void {
  const dir = getProviderLoginDir(env);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);
  const path = sessionPath(session.id, env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(publicDeviceLogin(session), null, 2)}\n`, { mode: SESSION_FILE_MODE });
  chmodSync(tmp, SESSION_FILE_MODE);
  renameSync(tmp, path);
  chmodSync(path, SESSION_FILE_MODE);
}

function readSessionFile(path: string): DeviceLoginSession | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DeviceLoginSession;
    if (!parsed?.id || !parsed.provider) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  process.kill(pid, signal);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function firstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s)\]>'"]+/i);
  return match?.[0]?.replace(/[.,;]+$/, "");
}

const DEVICE_USER_CODE_RE = /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+$/;

function labeledUserCode(text: string): string | undefined {
  const labeledLine = text.match(
    /(?:user[_ -]?code|one-time code|enter(?: this)?(?: one-time)? code)[^\n]*\n+\s*([A-Z0-9][A-Z0-9-]{3,15})/i,
  );
  if (labeledLine?.[1] && isDeviceUserCode(labeledLine[1])) return labeledLine[1];
  const inline = text.match(/(?:user[_ -]?code|enter code|code:)\s*([A-Z0-9][A-Z0-9-]{3,15})/i);
  if (inline?.[1] && isDeviceUserCode(inline[1])) return inline[1];
  return undefined;
}

function standaloneUserCode(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (isDeviceUserCode(trimmed)) return trimmed;
  }
  return undefined;
}

function isDeviceUserCode(value: string): boolean {
  return DEVICE_USER_CODE_RE.test(value);
}

function parseEmbeddedJsonPrompt(text: string): { verificationUrl?: string; userCode?: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const verificationUrl =
      stringField(parsed, "verificationUrl") ??
      stringField(parsed, "verification_url") ??
      stringField(parsed, "verification_uri") ??
      stringField(parsed, "url");
    const userCode = stringField(parsed, "userCode") ?? stringField(parsed, "user_code") ?? stringField(parsed, "code");
    return { ...(verificationUrl ? { verificationUrl } : {}), ...(userCode ? { userCode } : {}) };
  } catch {
    return {};
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

export function deleteDeviceLogin(id: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(sessionPath(id, env), { force: true });
}

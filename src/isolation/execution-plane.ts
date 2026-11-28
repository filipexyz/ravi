/**
 * Detect whether this CLI process is running on the host or inside a provider
 * sandbox, and whether host-side Ravi state is visible.
 *
 * Used by doctor and Console/Pages error classification. Do not infer provider
 * identity from unused registry entries (especially built-in `pi`).
 */

import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

export const RAVI_EXECUTION_PLANE_ENV = "RAVI_EXECUTION_PLANE";
export const HOST_CLI_GATEWAY_ENV = "RAVI_HOST_CLI_GATEWAY";
export const HOST_CLI_GATEWAY_INTERNAL_ENV = "RAVI_GATEWAY_INTERNAL";
export const HOST_CLI_GATEWAY_SOCKET_NAME = "cli-gateway.sock";

export type ExecutionPlane = "host" | "provider-sandbox";

export interface HostEvidence {
  stateDir: boolean;
  sqliteDb: boolean;
  cloudCredentials: boolean;
  cliGatewaySocket: boolean;
}

export interface ExecutionPlaneSnapshot {
  plane: ExecutionPlane;
  runtimeContext: boolean;
  hostEvidence: HostEvidence;
  markers: string[];
  daemonIsolationLikely: boolean;
  sourceTree: boolean;
}

export interface InspectExecutionPlaneInput {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateDir?: string;
  exists?: (path: string) => boolean;
}

const CODEX_SANDBOX_ENV_KEYS = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK", "CODEX_THREAD_SANDBOX"] as const;

export function getHostCliGatewaySocketPath(stateDir = getRaviStateDir()): string {
  return join(stateDir, HOST_CLI_GATEWAY_SOCKET_NAME);
}

export function looksLikeRaviSourceTree(cwd: string, exists: (path: string) => boolean = existsSync): boolean {
  if (exists(join(cwd, "src", "permissions", "provider-runtime.ts"))) return true;
  return (
    exists(join(cwd, "src", "cli", "commands", "doctor.ts")) && exists(join(cwd, "src", "cli", "commands", "pages.ts"))
  );
}

export function isNetworkIsolationError(error: unknown): boolean {
  const parts = [errorMessage(error)];
  if (typeof error === "object" && error && "code" in error) {
    parts.push(String((error as { code: unknown }).code));
  }
  if (error instanceof Error && error.cause !== undefined) {
    parts.push(errorMessage(error.cause));
    if (typeof error.cause === "object" && error.cause && "code" in error.cause) {
      parts.push(String((error.cause as { code: unknown }).code));
    }
  }
  const haystack = parts.join(" ").toLowerCase();
  return /econnrefused|enotfound|eai_again|enetunreach|ehostunreach|etimedout|econnreset|eperm|eacces|cert|ssl|tls|fetch failed|network|aborted|unable to connect|socket/.test(
    haystack,
  );
}

export function inspectExecutionPlane(input: InspectExecutionPlaneInput = {}): ExecutionPlaneSnapshot {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const cwd = input.cwd ?? process.cwd();
  const stateDir = input.stateDir ?? getRaviStateDir(env);
  const markers: string[] = [];

  const runtimeContext = Boolean(env.RAVI_CONTEXT_KEY?.trim() || env.RAVI_SESSION_NAME?.trim());
  if (env.RAVI_CONTEXT_KEY?.trim()) markers.push("runtime-context-key");
  if (env.RAVI_SESSION_NAME?.trim()) markers.push("runtime-session-name");

  const explicit = env[RAVI_EXECUTION_PLANE_ENV]?.trim();
  if (explicit === "provider-sandbox") markers.push("ravi-execution-plane");
  if (explicit === "host") markers.push("ravi-execution-plane-host");

  for (const key of CODEX_SANDBOX_ENV_KEYS) {
    if (env[key]?.trim()) markers.push(codexMarkerName(key));
  }

  const inContainer = exists("/.dockerenv") || exists("/run/.containerenv");
  if (inContainer) markers.push("container");

  const hostEvidence: HostEvidence = {
    stateDir: exists(stateDir),
    sqliteDb: exists(join(stateDir, "ravi.db")),
    cloudCredentials: exists(join(stateDir, "cloud-auth", "credentials.json")),
    cliGatewaySocket: exists(getHostCliGatewaySocketPath(stateDir)),
  };

  const plane = resolvePlane({
    explicit,
    hasCodexSandbox: CODEX_SANDBOX_ENV_KEYS.some((key) => Boolean(env[key]?.trim())),
    runtimeContext,
    inContainer,
  });

  return {
    plane,
    runtimeContext,
    hostEvidence,
    markers,
    daemonIsolationLikely: hostEvidence.sqliteDb && (plane === "provider-sandbox" || runtimeContext),
    sourceTree: looksLikeRaviSourceTree(cwd, exists),
  };
}

/**
 * Why a unix socket did not answer. `missing` is definite (no socket file);
 * `timeout` is NOT proof the daemon is gone: a daemon whose event loop stalls
 * for a moment simply has not accepted yet.
 */
export type UnixSocketProbeFailure = "missing" | "refused" | "timeout" | "error";

export type UnixSocketProbeResult =
  | { ok: true }
  | { ok: false; reason: UnixSocketProbeFailure; code?: string; attempts?: number; elapsedMs?: number };

export interface UnixSocketProbeOptions {
  /** Per-attempt connect timeout. */
  timeoutMs?: number;
  /** Connect attempts before giving up (>= 1). */
  attempts?: number;
  /** Waits between attempts; the last entry repeats. */
  backoffMs?: readonly number[];
  /** Test seam: builds the socket used for each attempt. */
  createSocket?: () => Socket;
}

const PROBE_ATTEMPT_TIMEOUT_MS = 500;
const PROBE_ATTEMPTS = 3;
const PROBE_BACKOFF_MS = [100, 200] as const;

function probeUnixSocketOnce(
  socketPath: string,
  timeoutMs: number,
  createSocket: () => Socket,
): Promise<UnixSocketProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createSocket();
    const finish = (result: UnixSocketProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // A late error after destroy() must not crash the process.
      socket.on("error", () => {});
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code;
      // Linux answers a non-blocking connect on a unix socket whose listen queue
      // is full with EAGAIN: the daemon is alive and loaded, which is the same
      // situation as a connect that did not complete in time.
      const reason: UnixSocketProbeFailure =
        code === "ECONNREFUSED"
          ? "refused"
          : code === "ENOENT"
            ? "missing"
            : code === "EAGAIN" || code === "EWOULDBLOCK"
              ? "timeout"
              : "error";
      finish({ ok: false, reason, ...(code ? { code } : {}) });
    });
    socket.once("connect", () => finish({ ok: true }));
    try {
      socket.connect({ path: socketPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      finish({ ok: false, reason: "error", ...(code ? { code } : {}) });
    }
  });
}

/**
 * Probe a unix socket with retries. One short attempt misreads a daemon that is
 * momentarily busy as "not running", and callers that carry a runtime context
 * key fail closed on that answer. A missing socket file is definite and is not
 * retried; everything else is retried with backoff.
 */
export async function probeUnixSocketDetailed(
  socketPath: string,
  options: UnixSocketProbeOptions = {},
): Promise<UnixSocketProbeResult> {
  if (!socketPath || !existsSync(socketPath)) return { ok: false, reason: "missing" };
  const timeoutMs = options.timeoutMs ?? PROBE_ATTEMPT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? PROBE_ATTEMPTS);
  const backoff = options.backoffMs ?? PROBE_BACKOFF_MS;
  let last: UnixSocketProbeResult = { ok: false, reason: "error" };
  const startedAt = Date.now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probeUnixSocketOnce(socketPath, timeoutMs, options.createSocket ?? (() => new Socket()));
    if (last.ok) return last;
    // Attempts and elapsed time let a later report separate "the daemon never
    // accepted" from "this process was too busy to notice the connect".
    last = { ...last, attempts: attempt + 1, elapsedMs: Date.now() - startedAt };
    if (last.reason === "missing") return last;
    if (attempt < attempts - 1 && backoff.length > 0) {
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return last;
}

export async function probeUnixSocket(socketPath: string, timeoutMs = PROBE_ATTEMPT_TIMEOUT_MS): Promise<boolean> {
  return (await probeUnixSocketDetailed(socketPath, { timeoutMs })).ok;
}

function resolvePlane(input: {
  explicit: string | undefined;
  hasCodexSandbox: boolean;
  runtimeContext: boolean;
  inContainer: boolean;
}): ExecutionPlane {
  if (input.explicit === "host") return "host";
  if (input.explicit === "provider-sandbox") return "provider-sandbox";
  if (input.hasCodexSandbox) return "provider-sandbox";
  if (input.runtimeContext && input.inContainer) return "provider-sandbox";
  return "host";
}

function codexMarkerName(key: string): string {
  return key.toLowerCase().replaceAll("_", "-");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return String(error);
}

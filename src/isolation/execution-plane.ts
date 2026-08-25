/**
 * Detect whether this CLI process is running on the host or inside a provider
 * sandbox, and whether host-side Ravi state is visible.
 *
 * Used by doctor and Console/Pages error classification. Do not infer provider
 * identity from unused registry entries (especially built-in `pi`).
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
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

export async function probeUnixSocket(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
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

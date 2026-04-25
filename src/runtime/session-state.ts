import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeCapabilities } from "./types.js";

export type RuntimeSessionStateInvalidReason =
  | "missing_provider_session"
  | "missing_session_params"
  | "missing_session_file"
  | "session_file_missing"
  | "missing_cwd"
  | "cwd_mismatch";

export interface RuntimeSessionStateValidation {
  valid: boolean;
  reason?: RuntimeSessionStateInvalidReason;
}

export interface ValidateRuntimeSessionStateInput {
  capabilities: RuntimeCapabilities;
  storedProviderSessionId?: string;
  storedRuntimeSessionParams?: Record<string, unknown>;
  sessionCwd: string;
}

export function validateRuntimeSessionState(input: ValidateRuntimeSessionStateInput): RuntimeSessionStateValidation {
  if (!input.storedProviderSessionId) {
    return { valid: false, reason: "missing_provider_session" };
  }

  const params = input.storedRuntimeSessionParams;
  const mode = input.capabilities.sessionState.mode;

  if (mode === "file-backed") {
    if (!params) {
      return { valid: false, reason: "missing_session_params" };
    }

    const sessionFile = firstString(params.sessionFile, params.filePath, params.path);
    if (!sessionFile) {
      return { valid: false, reason: "missing_session_file" };
    }

    if (!existsSync(resolveRuntimePath(sessionFile, input.sessionCwd))) {
      return { valid: false, reason: "session_file_missing" };
    }

    if (input.capabilities.sessionState.requiresCwdMatch) {
      const storedCwd = firstString(params.cwd);
      if (!storedCwd) {
        return { valid: false, reason: "missing_cwd" };
      }
      if (normalizePath(storedCwd) !== normalizePath(input.sessionCwd)) {
        return { valid: false, reason: "cwd_mismatch" };
      }
    }

    return { valid: true };
  }

  if (input.capabilities.sessionState.requiresCwdMatch && params) {
    const storedCwd = firstString(params.cwd);
    if (storedCwd && normalizePath(storedCwd) !== normalizePath(input.sessionCwd)) {
      return { valid: false, reason: "cwd_mismatch" };
    }
  }

  return { valid: true };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveRuntimePath(path: string, cwd: string): string {
  const expanded = expandHome(path);
  return expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

function expandHome(path: string): string {
  if (path === "~") {
    return process.env.HOME ?? path;
  }
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? `${home}${path.slice(1)}` : path;
  }
  return path;
}

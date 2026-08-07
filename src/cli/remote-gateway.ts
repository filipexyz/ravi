/**
 * Remote gateway dispatch for the Ravi CLI.
 *
 * Spec: `runtime/context-keys`, `sdk/auth`, `sdk/gateway`.
 *
 * When `RAVI_GATEWAY_URL` is set (or, in the future, `gateway.url` from
 * `~/.ravi/config.toml`), every decorated CLI command transparently turns into
 * a `POST /api/v1/<group-segments>/<command>` request authenticated with the
 * resolved runtime context-key (`rctx_*`).
 *
 * The remote dispatcher is intentionally minimal: it builds a flat JSON body
 * (matching `src/sdk/gateway/dispatcher.ts`), forwards the response unchanged
 * (text bodies for non-JSON, pretty-printed JSON otherwise) and exits with a
 * non-zero status when the gateway returns 4xx/5xx so shell pipelines can
 * detect failure the same way they do in local mode.
 */

import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { readCredentialsFile, selectDefaultCredentialsKey } from "../runtime/credentials-store.js";
import { ContractError, CONTRACT_EXIT_USAGE, permissionDeniedToContractError } from "./agent-contract.js";

export const REMOTE_GATEWAY_URL_ENV = "RAVI_GATEWAY_URL";
export const REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS = 30_000;

export interface RemoteGatewayConfig {
  url: string;
  /** Source of the configuration value, used for log/error messages. */
  source: "env";
}

export function getRemoteGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  op = "cli",
): RemoteGatewayConfig | null {
  const raw = env[REMOTE_GATEWAY_URL_ENV]?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidRemoteGatewayError(op);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalidRemoteGatewayError(op);
  return { url: raw.replace(/\/+$/, ""), source: "env" };
}

function invalidRemoteGatewayError(op: string): ContractError {
  return new ContractError(
    op,
    "REMOTE_GATEWAY_INVALID",
    `${REMOTE_GATEWAY_URL_ENV} must be a valid HTTP(S) URL.`,
    CONTRACT_EXIT_USAGE,
    { suggestedAction: `Correct or unset ${REMOTE_GATEWAY_URL_ENV} before retrying` },
  );
}

/**
 * Resolve the runtime context-key the CLI should send as `Authorization`.
 *
 * Mirrors the local-mode resolution order so a remote invocation transparently
 * works with the same `RAVI_CONTEXT_KEY` / credentials default the user already
 * has set up.
 */
export function resolveContextKeyForRemote(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.RAVI_CONTEXT_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return selectDefaultCredentialsKey(readCredentialsFile());
  } catch {
    return null;
  }
}

export interface RemoteDispatchInput {
  groupSegments: string[];
  command: string;
  body: Record<string, unknown>;
  config: RemoteGatewayConfig;
  contextKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RemoteDispatchResult {
  status: number;
  ok: boolean;
  body: string;
  contentType: string | null;
}

/** Preserve the process CLI taxonomy when a remote gateway returns a contract envelope. */
export function remoteGatewayExitCode(result: RemoteDispatchResult): 0 | 1 | 2 | 3 {
  if (result.ok) return 0;
  if (result.contentType?.includes("application/json")) {
    try {
      const body = JSON.parse(result.body) as unknown;
      if (isCompleteContractErrorBody(body)) return body.exitCode;
    } catch {
      // A malformed or legacy error response remains a generic execution failure.
    }
  }
  return 1;
}

/** Normalize legacy/non-contract gateway failures before the CLI renders them. */
export function remoteGatewayErrorToContractError(op: string, result: RemoteDispatchResult): ContractError | null {
  if (result.ok) return null;
  if (result.contentType?.includes("application/json")) {
    try {
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (isCompleteContractErrorBody(body, op)) return null;
      if (body.error === "PermissionDenied") {
        const reason = typeof body.reason === "string" ? body.reason : "Permission denied.";
        return permissionDeniedToContractError(op, reason);
      }
      if (body.error === "Unauthorized") {
        return new ContractError(op, "AUTH_REQUIRED", "Remote gateway authentication failed.", 1, {
          suggestedAction: "Refresh the runtime context credential and retry",
        });
      }
      if (body.error === "ValidationError" || body.error === "BadRequest") {
        return new ContractError(op, "USAGE_ERROR", "Remote gateway rejected the command input.", 2, {
          suggestedAction: `Inspect '${op} --help' and retry with valid input`,
        });
      }
    } catch {
      // Fall through to a redacted transport failure.
    }
  }
  return new ContractError(op, "SERVER_UNAVAILABLE", "Remote gateway request failed.", 1, {
    retryable: result.status >= 500,
    suggestedAction: "Check gateway availability and retry",
  });
}

interface CompleteContractErrorBody {
  success: false;
  op: string;
  exitCode: 1 | 2 | 3;
  outcome: "failed" | "usage_error" | "blocked" | "denied";
  error: { code: string; message: string; retryable: boolean };
}

function isCompleteContractErrorBody(value: unknown, expectedOp?: string): value is CompleteContractErrorBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.success !== false || typeof body.op !== "string" || (expectedOp !== undefined && body.op !== expectedOp)) {
    return false;
  }
  if (body.exitCode !== 1 && body.exitCode !== 2 && body.exitCode !== 3) return false;
  const expectedOutcomes =
    body.exitCode === 1 ? ["failed", "denied"] : body.exitCode === 2 ? ["usage_error"] : ["blocked"];
  if (typeof body.outcome !== "string" || !expectedOutcomes.includes(body.outcome)) return false;
  if (!body.error || typeof body.error !== "object" || Array.isArray(body.error)) return false;
  const error = body.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean";
}

export async function dispatchRemote(input: RemoteDispatchInput): Promise<RemoteDispatchResult> {
  const path = `/api/v1/${[...input.groupSegments, input.command].join("/")}`;
  const url = `${input.config.url}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS);
  try {
    const fetchFn = input.fetchImpl ?? fetch;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.contextKey}`,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: text,
      contentType: response.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * If a runtime context key resolves locally, also prove it is still live in
 * the local registry. Returns the live context-key when available so the CLI
 * can surface a friendly error instead of letting the gateway return 401.
 */
export function probeLocalRuntimeContext(contextKey: string): boolean {
  try {
    const record = resolveRuntimeContext(contextKey, { touch: false, readOnly: true });
    return Boolean(record);
  } catch {
    return false;
  }
}

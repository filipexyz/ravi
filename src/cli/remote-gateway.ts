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
 * (matching `src/sdk/gateway/dispatcher.ts`), forwards successful responses
 * and projects non-success responses into a local canonical contract before
 * rendering. Shell pipelines still receive the same non-zero exit taxonomy as
 * local mode without trusting arbitrary remote error fields.
 */

import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { readCredentialsFile, selectDefaultCredentialsKey } from "../runtime/credentials-store.js";
import {
  ContractError,
  CONTRACT_EXIT_USAGE,
  permissionDeniedToContractError,
  type ContractErrorDetails,
} from "./agent-contract.js";
import { sanitizePublicValue } from "./redaction.js";

export const REMOTE_GATEWAY_URL_ENV = "RAVI_GATEWAY_URL";
export const REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS = 30_000;
// The authenticated target gateway owns the protocol code. Preserve it for
// transport parity, but reject free-form strings; a shared code catalog would
// be a broader contract change than this boundary repair.
const REMOTE_CONTRACT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REMOTE_FLAG_PATTERN = /^--[a-z0-9][a-z0-9-]{0,63}$/;
const REMOTE_POSITIONAL_PATTERN = /^(?:<[a-z][A-Za-z0-9_-]{0,63}(?:\.\.\.)?>|\[[a-z][A-Za-z0-9_-]{0,63}(?:\.\.\.)?\])$/;
const REMOTE_SUGGESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RemoteGatewayConfig {
  url: string;
  /** Source of the configuration value, used for log/error messages. */
  source: "env";
}

export function getRemoteGatewayConfig(env: NodeJS.ProcessEnv = process.env, op = "cli"): RemoteGatewayConfig | null {
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
      if (isCompleteContractErrorBody(body, op)) {
        return new ContractError(
          op,
          body.error.code,
          remoteContractFailureMessage(body.outcome),
          body.exitCode,
          projectRemoteContractDetails(op, body),
        );
      }
      if (body.error === "PermissionDenied") {
        return permissionDeniedToContractError(op, "Remote gateway denied the command.");
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
  error: { code: string; message: string; retryable: boolean; [key: string]: unknown };
}

function remoteContractFailureMessage(outcome: CompleteContractErrorBody["outcome"]): string {
  if (outcome === "denied") return "Remote gateway denied the command.";
  if (outcome === "usage_error") return "Remote gateway rejected the command input.";
  if (outcome === "blocked") return "Remote command was blocked by policy.";
  return "Remote command failed.";
}

function remoteSuggestedAction(op: string, outcome: CompleteContractErrorBody["outcome"]): string {
  if (outcome === "denied") return "Request the required remote permission before retrying the command";
  if (outcome === "usage_error") return `Inspect '${op} --help' and retry with valid input`;
  if (outcome === "blocked") return "Review the remote policy block before retrying the command";
  return "Inspect redacted remote logs and retry when the underlying cause is resolved";
}

function boundedStringList(value: unknown, pattern: RegExp): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string" && pattern.test(item))
    .map((item) => sanitizePublicValue(item))
    .filter((item): item is string => typeof item === "string" && pattern.test(item))
    .slice(0, 32);
  return items.length > 0 ? items : undefined;
}

function projectRemoteContractDetails(op: string, body: CompleteContractErrorBody): ContractErrorDetails {
  const remote = body.error;
  const details: ContractErrorDetails = { retryable: remote.retryable };
  if (typeof remote.suggestedAction === "string") {
    details.suggestedAction = remoteSuggestedAction(op, body.outcome);
  }
  const suggestions = boundedStringList(remote.suggestions, REMOTE_SUGGESTION_ID_PATTERN);
  if (suggestions) details.suggestions = suggestions;
  const acceptedFlags = boundedStringList(remote.acceptedFlags, REMOTE_FLAG_PATTERN);
  if (acceptedFlags) details.acceptedFlags = acceptedFlags;
  const acceptedPositionals = boundedStringList(remote.acceptedPositionals, REMOTE_POSITIONAL_PATTERN);
  if (acceptedPositionals) details.acceptedPositionals = acceptedPositionals;
  if (typeof remote.dryRun === "boolean") details.dryRun = remote.dryRun;
  if (remote.plan && typeof remote.plan === "object" && !Array.isArray(remote.plan)) {
    details.plan = sanitizePublicValue(remote.plan);
  }
  return details;
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
  if (
    typeof error.code !== "string" ||
    !REMOTE_CONTRACT_CODE_PATTERN.test(error.code) ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    return false;
  }
  if (body.outcome === "denied" && error.code !== "PERMISSION_DENIED") return false;
  if (error.code === "PERMISSION_DENIED" && body.outcome !== "denied") return false;
  return true;
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

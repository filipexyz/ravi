/**
 * Remote gateway dispatch for the Ravi CLI.
 *
 * Spec: `runtime/context-keys`, `sdk/auth`, `sdk/gateway`.
 *
 * When `RAVI_GATEWAY_URL` is set (http(s) or `unix://`), every decorated CLI
 * command transparently turns into a `POST /api/v1/<group-segments>/<command>`
 * request authenticated with the resolved runtime context-key (`rctx_*`).
 *
 * Isolated CLIs (`RAVI_CONTEXT_KEY` set) also auto-bridge to the host unix
 * socket at `~/.ravi/cli-gateway.sock` when that socket is connectable. They
 * MUST NOT auto-open raw loopback HTTP.
 *
 * The remote dispatcher is intentionally minimal: it builds a flat JSON body
 * (matching `src/sdk/gateway/dispatcher.ts`), forwards successful responses
 * and projects non-success responses into a local canonical contract before
 * rendering. Shell pipelines still receive the same non-zero exit taxonomy as
 * local mode without trusting arbitrary remote error fields.
 */

import { request as httpRequest } from "node:http";
import {
  HOST_CLI_GATEWAY_ENV,
  HOST_CLI_GATEWAY_INTERNAL_ENV,
  getHostCliGatewaySocketPath,
  probeUnixSocket,
} from "../isolation/execution-plane.js";
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
export const HOST_CLI_GATEWAY_URL_PREFIX = "unix://";
// The authenticated target gateway owns the protocol code. Preserve it for
// transport parity, but reject free-form strings; a shared code catalog would
// be a broader contract change than this boundary repair.
const REMOTE_CONTRACT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REMOTE_FLAG_PATTERN = /^--[a-z0-9][a-z0-9-]{0,63}$/;
const REMOTE_POSITIONAL_PATTERN = /^(?:<[a-z][A-Za-z0-9_-]{0,63}(?:\.\.\.)?>|\[[a-z][A-Za-z0-9_-]{0,63}(?:\.\.\.)?\])$/;
const REMOTE_SUGGESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REMOTE_PLAN_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const REMOTE_PLAN_BLOCKED_STRING_KEY_SEGMENTS = new Set([
  "body",
  "caption",
  "command",
  "content",
  "credential",
  "credentials",
  "details",
  "endpoint",
  "error",
  "file",
  "instructions",
  "issues",
  "message",
  "metadata",
  "output",
  "password",
  "path",
  "prompt",
  "query",
  "raw",
  "reason",
  "secret",
  "text",
  "token",
  "url",
]);
const REMOTE_PLAN_IDENTIFIER_KEY_PATTERN = /(?:Id|Ref)$/;
const REMOTE_PLAN_IDENTIFIER_KEYS = new Set(["project", "site", "slug"]);
const REMOTE_PLAN_IDENTIFIER_VALUE_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|sha256:[a-f0-9]{16})$/;
const REMOTE_PLAN_ENUM_KEY_PATTERN =
  /(?:Channel|Effect|Kind|Mode|Operation|Profile|Provider|Resource|Status|Type|Visibility)$/;
const REMOTE_PLAN_ENUM_KEYS = new Set([
  "action",
  "channel",
  "effect",
  "kind",
  "mode",
  "operation",
  "provider",
  "resource",
  "status",
  "visibility",
]);
const REMOTE_PLAN_TARGET_VALUES = new Set(["all", "main"]);
const REMOTE_PLAN_ENUM_VALUE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const REMOTE_PLAN_TYPED_SUMMARY_KEY_PATTERN = /(?:Bytes|Chars|Configured|Count|Enabled|Length|Present|Requested)$/;
const REMOTE_PLAN_MAX_DEPTH = 3;
const REMOTE_PLAN_MAX_PROPERTIES = 64;

export interface RemoteGatewayConfig {
  url: string;
  /** Source of the configuration value, used for log/error messages. */
  source: "env" | "host-socket";
  socketPath?: string;
}

export function getRemoteGatewayConfig(env: NodeJS.ProcessEnv = process.env, op = "cli"): RemoteGatewayConfig | null {
  const raw = env[REMOTE_GATEWAY_URL_ENV]?.trim();
  if (!raw) return null;
  const unix = parseUnixGatewayUrl(raw);
  if (unix) {
    return { url: `${HOST_CLI_GATEWAY_URL_PREFIX}${unix}`, source: "env", socketPath: unix };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidRemoteGatewayError(op);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalidRemoteGatewayError(op);
  return { url: raw.replace(/\/+$/, ""), source: "env" };
}

export interface ResolveRemoteGatewayConfigOptions {
  probeSocket?: (socketPath: string) => Promise<boolean>;
  stateDir?: string;
}

/**
 * Resolve an explicit HTTP(S)/unix gateway, or auto-bridge to the host unix
 * socket when this process is an isolated CLI (`RAVI_CONTEXT_KEY`) and the
 * socket is actually connectable. Never auto-sets a loopback HTTP URL.
 */
export async function resolveRemoteGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  op = "cli",
  options: ResolveRemoteGatewayConfigOptions = {},
): Promise<RemoteGatewayConfig | null> {
  const explicit = getRemoteGatewayConfig(env, op);
  if (explicit) return explicit;
  return resolveAutoHostCliGateway(env, options);
}

export async function resolveAutoHostCliGateway(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRemoteGatewayConfigOptions = {},
): Promise<RemoteGatewayConfig | null> {
  if (!shouldAutoUseHostCliGateway(env)) return null;
  const socketPath = getHostCliGatewaySocketPath(options.stateDir);
  const probe = options.probeSocket ?? probeUnixSocket;
  try {
    if (!(await probe(socketPath))) return null;
  } catch {
    return null;
  }
  return {
    url: `${HOST_CLI_GATEWAY_URL_PREFIX}${socketPath}`,
    source: "host-socket",
    socketPath,
  };
}

export function shouldAutoUseHostCliGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[REMOTE_GATEWAY_URL_ENV]?.trim()) return false;
  const disabled = env[HOST_CLI_GATEWAY_ENV]?.trim();
  if (disabled === "0" || disabled?.toLowerCase() === "false" || disabled?.toLowerCase() === "off") return false;
  if (env[HOST_CLI_GATEWAY_INTERNAL_ENV]?.trim() === "1") return false;
  return Boolean(env.RAVI_CONTEXT_KEY?.trim());
}

export function parseUnixGatewayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("unix:")) return null;
  let rest = trimmed.slice("unix:".length);
  if (rest.startsWith("//")) rest = rest.slice(2);
  if (!rest.startsWith("/")) return null;
  return rest.replace(/\/+$/, "") || null;
}

function invalidRemoteGatewayError(op: string): ContractError {
  return new ContractError(
    op,
    "REMOTE_GATEWAY_INVALID",
    `${REMOTE_GATEWAY_URL_ENV} must be a valid HTTP(S) or unix socket URL.`,
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
  /** Exact response bytes, used for binary @Returns responses. */
  bodyBytes?: Uint8Array;
  contentType: string | null;
}

export type RemoteDispatchOutput = { kind: "bytes"; value: Uint8Array } | { kind: "text"; value: string };

export function remoteDispatchOutput(result: RemoteDispatchResult): RemoteDispatchOutput {
  if (result.bodyBytes && isBinaryRemoteContentType(result.contentType)) {
    return { kind: "bytes", value: result.bodyBytes };
  }
  if (result.body.length === 0) return { kind: "text", value: "" };
  if (!result.contentType?.includes("application/json")) {
    return { kind: "text", value: result.body.endsWith("\n") ? result.body : `${result.body}\n` };
  }
  try {
    return { kind: "text", value: `${JSON.stringify(JSON.parse(result.body), null, 2)}\n` };
  } catch {
    return { kind: "text", value: result.body.endsWith("\n") ? result.body : `${result.body}\n` };
  }
}

function isBinaryRemoteContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml")) return false;
  return (
    normalized.startsWith("audio/") ||
    normalized.startsWith("image/") ||
    normalized.startsWith("video/") ||
    normalized === "application/octet-stream" ||
    normalized === "application/pdf" ||
    normalized === "application/zip"
  );
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
  const plan = projectRemotePlan(remote.plan);
  if (plan) details.plan = plan;
  return details;
}

function projectRemotePlan(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > REMOTE_PLAN_MAX_DEPTH) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>).slice(
    0,
    REMOTE_PLAN_MAX_PROPERTIES,
  )) {
    if (!REMOTE_PLAN_KEY_PATTERN.test(key)) continue;
    const blockedStringKey = isBlockedRemotePlanStringKey(key);
    if (typeof candidate === "boolean") {
      if (blockedStringKey && !REMOTE_PLAN_TYPED_SUMMARY_KEY_PATTERN.test(key)) continue;
      projected[key] = candidate;
      continue;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      if (blockedStringKey && !REMOTE_PLAN_TYPED_SUMMARY_KEY_PATTERN.test(key)) continue;
      projected[key] = candidate;
      continue;
    }
    if (blockedStringKey) continue;
    const safeString = typeof candidate === "string" ? projectRemotePlanString(candidate) : undefined;
    if (key === "target" && safeString !== undefined && REMOTE_PLAN_TARGET_VALUES.has(safeString)) {
      projected[key] = safeString;
      continue;
    }
    if (
      (REMOTE_PLAN_ENUM_KEYS.has(key) || REMOTE_PLAN_ENUM_KEY_PATTERN.test(key)) &&
      safeString !== undefined &&
      REMOTE_PLAN_ENUM_VALUE_PATTERN.test(safeString)
    ) {
      projected[key] = safeString;
      continue;
    }
    if (
      (REMOTE_PLAN_IDENTIFIER_KEYS.has(key) || REMOTE_PLAN_IDENTIFIER_KEY_PATTERN.test(key)) &&
      safeString !== undefined &&
      REMOTE_PLAN_IDENTIFIER_VALUE_PATTERN.test(safeString)
    ) {
      projected[key] = safeString;
      continue;
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nested = projectRemotePlan(candidate, depth + 1);
      if (nested) projected[key] = nested;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemotePlanString(value: string): string | undefined {
  const sanitized = sanitizePublicValue(value);
  return typeof sanitized === "string" && sanitized === value ? value : undefined;
}

function isBlockedRemotePlanStringKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._-]/)
    .flatMap((segment) => segment.split(" "))
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.some((segment) => REMOTE_PLAN_BLOCKED_STRING_KEY_SEGMENTS.has(segment));
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
  const socketPath = input.config.socketPath ?? parseUnixGatewayUrl(input.config.url);
  const url = socketPath ? `http://ravi-cli-gateway.local${path}` : `${input.config.url}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${input.contextKey}`,
    ...(socketPath ? { "x-ravi-gateway-internal": "1" } : {}),
  };
  const body = JSON.stringify(input.body);
  const timeoutMs = input.timeoutMs ?? REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS;

  if (socketPath && !input.fetchImpl) {
    return fetchViaUnixSocket({ socketPath, path, headers, body, timeoutMs });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchFn = input.fetchImpl ?? fetch;
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      ...(socketPath ? { unix: socketPath } : {}),
    } as RequestInit);
    return await remoteResultFromResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchViaUnixSocket(input: {
  socketPath: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<RemoteDispatchResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: input.socketPath,
        path: input.path,
        method: "POST",
        headers: input.headers,
        timeout: input.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          resolve({
            status: res.statusCode ?? 500,
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            body: new TextDecoder().decode(bytes),
            bodyBytes: bytes,
            contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Host CLI gateway request timed out"));
    });
    req.write(input.body);
    req.end();
  });
}

async function remoteResultFromResponse(response: Response): Promise<RemoteDispatchResult> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    ok: response.ok,
    body: new TextDecoder().decode(bytes),
    bodyBytes: bytes,
    contentType: response.headers.get("content-type"),
  };
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

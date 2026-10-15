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
 * MUST NOT auto-open raw loopback HTTP, and they MUST NOT fall back to local
 * execution: without a reachable gateway the command fails closed with
 * `GATEWAY_REQUIRED` (see `requiresRemoteGateway`).
 *
 * The remote dispatcher is intentionally minimal: it builds a flat JSON body
 * (matching `src/sdk/gateway/dispatcher.ts`), forwards the caller cwd as
 * `x-ravi-cwd`, forwards successful responses and projects non-success
 * responses into a local canonical contract before rendering. Shell pipelines
 * still receive the same non-zero exit taxonomy as local mode without trusting
 * arbitrary remote error fields. Safe local PAYLOAD_INVALID reasons (and
 * structured issues) are preserved so file/project failures stay actionable.
 */

import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  HOST_CLI_GATEWAY_ENV,
  HOST_CLI_GATEWAY_INTERNAL_ENV,
  getHostCliGatewaySocketPath,
  probeUnixSocket,
} from "../isolation/execution-plane.js";
import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { isLoopbackHost } from "../security/nats-exposure.js";
import { readCredentialsFile, selectDefaultCredentialsKey } from "../runtime/credentials-store.js";
import {
  ContractError,
  CONTRACT_EXIT_USAGE,
  permissionDeniedToContractError,
  sanitizePublicContractMessage,
  type ContractErrorDetails,
} from "./agent-contract.js";
import { APPROVAL_ID_PATTERN } from "../link/client.js";
import { CALLER_CWD_HEADER, parseCallerCwd } from "./caller-cwd.js";
import { cloudContractCatalogCopy, commandOperation } from "./cloud-error-contract.js";
import { localMediaSendCatalogCopy } from "./media-send-auth.js";
import { isSafeLocalPayloadMessage } from "./payload-error-message.js";
import { projectPublicIssues, sanitizePublicValue } from "./redaction.js";
import { stripTerminalControls } from "../sandbox/outputs.js";

export { CALLER_CWD_HEADER } from "./caller-cwd.js";

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
  source: "env" | "host-socket" | "home";
  socketPath?: string;
  /**
   * How the request authenticates. `context-key` (the default) sends the
   * runtime context-key as a bearer token. `sandbox-grant` is `ravi home`: no
   * bearer, no caller cwd, no internal marker; the Console sandbox grant is
   * the only credential, normally injected by the sandbox egress proxy.
   */
  auth?: "context-key" | "sandbox-grant";
}

export const HOME_GATEWAY_URL_ENV = "RAVI_HOME_GATEWAY_URL";
export const SANDBOX_GRANT_ENV = "RAVI_SANDBOX_GRANT";
export const SANDBOX_GRANT_HEADER = "X-Ravi-Sandbox-Grant";
export const HOME_REQUEST_ID_HEADER = "X-Ravi-Request-Id";
/** Above the Gate's 30 s upstream timeout, so the Gate's own answer arrives first. */
export const HOME_GATEWAY_DEFAULT_TIMEOUT_MS = 35_000;
/** The most a HOME response may carry; beyond it the read is aborted (`HOME_RESPONSE_TOO_LARGE`). */
export const HOME_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** What every HOME output shows in place of the sandbox grant. */
export const HOME_GRANT_PLACEHOLDER = "[grant]";
const SANDBOX_GRANT_MAX_LENGTH = 8192;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HOME_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const HOME_REQUEST_ID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const HOME_LISTENER_SOURCE = "ravi-listener";

/**
 * The HOME gateway for `ravi home` (`RAVI_HOME_GATEWAY_URL`): the Gate URL of
 * the installation that started this sandbox run. https only, with no
 * credentials, query or fragment. Errors never echo the value.
 */
export function getHomeGatewayConfig(env: NodeJS.ProcessEnv = process.env, op = "home"): RemoteGatewayConfig {
  const raw = env[HOME_GATEWAY_URL_ENV]?.trim();
  if (!raw) {
    throw new ContractError(op, "HOME_GATEWAY_REQUIRED", `ravi home needs ${HOME_GATEWAY_URL_ENV}.`, 1, {
      suggestedAction: `Run inside a connected sandbox run, which sets ${HOME_GATEWAY_URL_ENV}`,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidHomeGatewayError(op, "is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ContractError(
      op,
      "HOME_GATEWAY_INSECURE",
      `${HOME_GATEWAY_URL_ENV} must use https://.`,
      CONTRACT_EXIT_USAGE,
      {
        suggestedAction: `Set ${HOME_GATEWAY_URL_ENV} to the https:// gateway URL of this run`,
      },
    );
  }
  if (parsed.username || parsed.password || /[@\s]/.test(raw))
    throw invalidHomeGatewayError(op, "must not carry credentials");
  if (raw.includes("?") || raw.includes("#")) throw invalidHomeGatewayError(op, "must not carry a query or fragment");
  if (!parsed.hostname) throw invalidHomeGatewayError(op, "has no host");
  if (sameOriginAsRemoteGateway(parsed, env)) {
    throw new ContractError(
      op,
      "HOME_GATEWAY_CONFLICT",
      `${HOME_GATEWAY_URL_ENV} and ${REMOTE_GATEWAY_URL_ENV} share an origin; nothing was sent.`,
      CONTRACT_EXIT_USAGE,
      {
        suggestedAction: `Point ${REMOTE_GATEWAY_URL_ENV} at this sandbox's own gateway (or unset it); ${HOME_GATEWAY_URL_ENV} is the HOME Gate only`,
      },
    );
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, source: "home", auth: "sandbox-grant" };
}

/** The context-key gateway and the HOME Gate must never be the same origin. */
function sameOriginAsRemoteGateway(home: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = env[REMOTE_GATEWAY_URL_ENV]?.trim();
  if (!raw) return false;
  try {
    return new URL(raw).origin === home.origin;
  } catch {
    return false;
  }
}

function invalidHomeGatewayError(op: string, why: string): ContractError {
  return new ContractError(op, "HOME_GATEWAY_INVALID", `${HOME_GATEWAY_URL_ENV} ${why}.`, CONTRACT_EXIT_USAGE, {
    suggestedAction: `Correct ${HOME_GATEWAY_URL_ENV} before retrying`,
  });
}

/**
 * The `RAVI_SANDBOX_GRANT` fallback, or null when unset. Only a single compact
 * JWS is sent; anything else is refused without ever echoing the value.
 */
export function readSandboxGrantFallback(env: NodeJS.ProcessEnv, op: string): string | null {
  const raw = env[SANDBOX_GRANT_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const grant = raw.trim();
  if (grant.length > SANDBOX_GRANT_MAX_LENGTH || !COMPACT_JWS_PATTERN.test(grant)) {
    throw new ContractError(
      op,
      "HOME_GRANT_INVALID",
      `${SANDBOX_GRANT_ENV} is set but is not a single compact token; nothing was sent.`,
      CONTRACT_EXIT_USAGE,
      { suggestedAction: `Unset ${SANDBOX_GRANT_ENV} or set it to the grant of this run` },
    );
  }
  return grant;
}

/** The `RAVI_SANDBOX_GRANT` value that would be sent, or null; never throws. */
export function knownSandboxGrant(env: NodeJS.ProcessEnv = process.env): string | null {
  const grant = env[SANDBOX_GRANT_ENV]?.trim();
  if (!grant || grant.length > SANDBOX_GRANT_MAX_LENGTH || !COMPACT_JWS_PATTERN.test(grant)) return null;
  return grant;
}

/**
 * A compact JWS whose header and payload are base64url JSON objects (`eyJ…`):
 * the shape of a Console grant, scrubbed even when the egress proxy injected it
 * and the CLI never saw the value.
 */
const JWS_SHAPED_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Replace the known grant and any JWS-shaped token in `text` with `[grant]`. */
export function scrubHomeGrantText(text: string, grant: string | null): string {
  const known = grant ? text.split(grant).join(HOME_GRANT_PLACEHOLDER) : text;
  return known.replace(JWS_SHAPED_PATTERN, HOME_GRANT_PLACEHOLDER);
}

/** `fn` over every string (keys included) of a JSON-like value. */
export function mapJsonStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[fn(key)] = mapJsonStrings(item, fn);
    return out;
  }
  return value;
}

/** `scrubHomeGrantText` over every string (keys included) of a JSON-like value. */
export function scrubHomeGrant(value: unknown, grant: string | null): unknown {
  return mapJsonStrings(value, (text) => scrubHomeGrantText(text, grant));
}

/** The same error with the grant scrubbed from its message and details. */
export function scrubHomeContractError(error: ContractError, grant: string | null): ContractError {
  return new ContractError(
    error.op,
    error.code,
    scrubHomeGrantText(error.message, grant),
    error.exitCode,
    scrubHomeGrant(error.details, grant) as ContractErrorDetails,
  );
}

/**
 * A HOME error body with the grant scrubbed and terminal controls stripped from
 * every string before the projection reads it.
 */
function scrubHomeResult(result: RemoteDispatchResult, grant: string | null): RemoteDispatchResult {
  const clean = (text: string) => stripTerminalControls(scrubHomeGrantText(text, grant));
  let body: string;
  try {
    body = result.contentType?.includes("json")
      ? JSON.stringify(mapJsonStrings(JSON.parse(result.body), clean))
      : clean(result.body);
  } catch {
    body = clean(result.body);
  }
  const { bodyBytes: _bytes, ...rest } = result;
  return { ...rest, body };
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
  // The gateway request carries the runtime context-key as a bearer token:
  // plaintext HTTP is only acceptable when it never leaves this host.
  if (parsed.protocol === "http:" && !isLoopbackGatewayHost(parsed.hostname)) throw insecureRemoteGatewayError(op);
  return { url: raw.replace(/\/+$/, ""), source: "env" };
}

/**
 * `localhost`, or an IP literal in 127.0.0.0/8 or ::1. `hostname` comes from
 * WHATWG URL parsing (the same parser `fetch` uses for the request), so
 * userinfo tricks such as `http://user@127.0.0.1@evil` resolve to `evil`.
 * Other names (`*.localhost`, `127.0.0.1.evil.com`) are refused: DNS decides
 * where they go.
 */
export function isLoopbackGatewayHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  const bare = host.replace(/^\[|\]$/g, "");
  return isIP(bare) !== 0 && isLoopbackHost(bare);
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
  const stateDirs = options.stateDir ? [options.stateDir] : resolveHostCliGatewayStateDirs(env);
  const probe = options.probeSocket ?? probeUnixSocket;
  for (const stateDir of stateDirs) {
    const socketPath = getHostCliGatewaySocketPath(stateDir);
    try {
      if (!(await probe(socketPath))) continue;
    } catch {
      continue;
    }
    return {
      url: `${HOST_CLI_GATEWAY_URL_PREFIX}${socketPath}`,
      source: "host-socket",
      socketPath,
    };
  }
  return null;
}

export function shouldAutoUseHostCliGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[REMOTE_GATEWAY_URL_ENV]?.trim()) return false;
  const disabled = env[HOST_CLI_GATEWAY_ENV]?.trim();
  if (disabled === "0" || disabled?.toLowerCase() === "false" || disabled?.toLowerCase() === "off") return false;
  if (env[HOST_CLI_GATEWAY_INTERNAL_ENV]?.trim() === "1") return false;
  return Boolean(env.RAVI_CONTEXT_KEY?.trim());
}

/**
 * State dirs that may hold the host CLI gateway socket, in probe order.
 * `RAVI_STATE_DIR` wins (the daemon's sessions inherit it). Otherwise only the
 * OS account home is used, never `$HOME`: `HOME=/tmp/x ravi ...` must neither
 * lose the host socket nor reach a socket the caller planted under that HOME.
 * A daemon with a non-default state dir publishes it via `RAVI_STATE_DIR`.
 * Either way a missing socket fails closed (`requiresRemoteGateway`).
 */
export function resolveHostCliGatewayStateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.RAVI_STATE_DIR?.trim();
  if (explicit) return [explicit];
  const accountHome = accountHomedir();
  return accountHome ? [join(accountHome, ".ravi")] : [];
}

/**
 * Home directory from the passwd entry. `os.homedir()` is not a fallback: it
 * reads `$HOME`. Without a passwd entry (some containers) nothing is probed,
 * so the daemon must publish `RAVI_STATE_DIR`, or the command fails closed.
 */
function accountHomedir(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

/**
 * A process that carries `RAVI_CONTEXT_KEY` acts for a runtime context, so its
 * command must be authorized by the daemon that owns that context. Local
 * execution would authorize against whatever DB this process's env points to.
 */
export function requiresRemoteGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RAVI_CONTEXT_KEY?.trim());
}

export function gatewayRequiredError(op: string): ContractError {
  return new ContractError(
    op,
    "GATEWAY_REQUIRED",
    "Commands running with RAVI_CONTEXT_KEY must go through the Ravi gateway, and none is reachable.",
    1,
    {
      retryable: true,
      suggestedAction: `Start the Ravi daemon so its host CLI gateway socket is available, or set ${REMOTE_GATEWAY_URL_ENV}`,
    },
  );
}

/**
 * A `@CliOnly()` command inside a runtime session. It is excluded from the
 * gateway route table by design, so the dispatch could only ever answer 404; the
 * real reason is that the command belongs to the operator's terminal.
 */
export function cliOnlyCommandError(op: string): ContractError {
  return new ContractError(
    op,
    "CLI_ONLY_COMMAND",
    "This command is exclusive to the local CLI and has no remote-call semantics: it cannot run from a turn inside a runtime session.",
    2,
    {
      retryable: false,
      suggestedAction: "Run it from a terminal on the host, outside a session turn.",
    },
  );
}

export function parseUnixGatewayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("unix:")) return null;
  let rest = trimmed.slice("unix:".length);
  if (rest.startsWith("//")) rest = rest.slice(2);
  if (!rest.startsWith("/")) return null;
  return rest.replace(/\/+$/, "") || null;
}

function insecureRemoteGatewayError(op: string): ContractError {
  return new ContractError(
    op,
    "REMOTE_GATEWAY_INSECURE",
    `${REMOTE_GATEWAY_URL_ENV} must use https:// unless it points at this machine (localhost, 127.0.0.0/8 or [::1]).`,
    CONTRACT_EXIT_USAGE,
    { suggestedAction: `Use an https:// URL or a unix:// socket in ${REMOTE_GATEWAY_URL_ENV} before retrying` },
  );
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
  /** Required unless `config.auth` is `sandbox-grant`, which never sends it. */
  contextKey?: string;
  /** Caller's working directory; sent as `x-ravi-cwd` so relative file args resolve. Never sent to HOME. */
  cwd?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Environment read for the `RAVI_SANDBOX_GRANT` fallback in home mode (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface RemoteDispatchResult {
  status: number;
  ok: boolean;
  body: string;
  /** Exact response bytes, used for binary @Returns responses. */
  bodyBytes?: Uint8Array;
  contentType: string | null;
  /** `X-Ravi-Request-Id` of a HOME response, when it is a UUID. */
  requestId?: string | null;
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
        const connectorTurn = connectorTurnRemoteCopy(op, body.error);
        return new ContractError(
          op,
          body.error.code,
          connectorTurn?.message ??
            remoteContractFailureMessage(
              op,
              body.outcome,
              projectPublicIssues(body.error.issues),
              body.error.message,
              body.error.code,
            ),
          body.exitCode,
          { ...projectRemoteContractDetails(op, body, result.status), ...(connectorTurn?.details ?? {}) },
        );
      }
      if (body.error === "PermissionDenied") {
        const denied = permissionDeniedToContractError(op, "Remote gateway denied the command.");
        return new ContractError(denied.op, denied.code, denied.message, denied.exitCode, {
          ...denied.details,
          status: result.status,
        });
      }
      if (body.error === "Unauthorized") {
        return new ContractError(op, "AUTH_REQUIRED", "Remote gateway authentication failed.", 1, {
          suggestedAction: "Refresh the runtime context credential and retry",
          status: result.status,
        });
      }
      const nestedError =
        body.error && typeof body.error === "object" && !Array.isArray(body.error)
          ? (body.error as Record<string, unknown>)
          : null;
      const issues = projectPublicIssues(body.issues ?? nestedError?.issues);
      if (
        body.error === "ValidationError" ||
        body.error === "BadRequest" ||
        (issues && result.status >= 400 && result.status < 500)
      ) {
        return new ContractError(op, "USAGE_ERROR", remoteValidationFailureMessage(issues), CONTRACT_EXIT_USAGE, {
          suggestedAction: `Inspect '${op} --help' and retry with valid input`,
          status: result.status,
          ...(issues ? { issues } : {}),
        });
      }
    } catch {
      // Fall through to a redacted transport failure.
    }
  }
  return new ContractError(op, "SERVER_UNAVAILABLE", "Remote gateway request failed.", 1, {
    retryable: result.status >= 500,
    suggestedAction: "Check gateway availability and retry",
    status: result.status,
  });
}

interface CompleteContractErrorBody {
  success: false;
  op: string;
  exitCode: 1 | 2 | 3;
  outcome: "failed" | "usage_error" | "blocked" | "denied";
  error: { code: string; message: string; retryable: boolean; [key: string]: unknown };
}

/** `ravi link` failures are relayed to people, so they keep the local cloud copy instead of a generic line. */
const IDENTITY_LINK_OPS = new Set(["identity link", "identity unlink"]);

/**
 * Personal-connector commands. Their blocks tell the agent what to say and
 * where (a chat line, the reply target, a reconnect link), so the relay keeps
 * that copy instead of a generic line. Other failures get the local catalog.
 */
function isConnectorOp(op: string): boolean {
  return op.startsWith("gmail ") || op.startsWith("connectors ");
}

const CONNECTOR_REMOTE_MESSAGE_MAX = 1_200;
const CONNECTOR_CHAT_LINE_MAX = 300;
const CONNECTOR_REPLY_TO_VALUES = new Set(["same_chat"]);

/**
 * A connector block built by the daemon's turn classification: it is the only
 * kind that carries a chat line. Errors relayed from Link or the Console were
 * already reduced to catalog copy there and carry none.
 */
function connectorTurnRemoteCopy(
  op: string,
  remote: CompleteContractErrorBody["error"],
): { message: string; details: ContractErrorDetails } | null {
  if (!isConnectorOp(op) || !remote.code.startsWith("CONNECTOR_")) return null;
  const chatLine = boundedRemoteLine(remote.chatLine, CONNECTOR_CHAT_LINE_MAX, "chatLine");
  if (!chatLine) return null;
  const message = boundedRemoteLine(remote.message, CONNECTOR_REMOTE_MESSAGE_MAX);
  if (!message) return null;
  const details: ContractErrorDetails = { chatLine };
  const chatLinePt = boundedRemoteLine(remote.chatLinePt, CONNECTOR_CHAT_LINE_MAX, "chatLinePt");
  if (chatLinePt) details.chatLinePt = chatLinePt;
  if (typeof remote.replyTo === "string" && CONNECTOR_REPLY_TO_VALUES.has(remote.replyTo)) {
    details.replyTo = remote.replyTo;
  }
  const reconnectLink = connectorConsoleLink(remote.reconnectLink, "/connectors");
  if (reconnectLink) details.reconnectLink = reconnectLink;
  Object.assign(details, connectorApprovalDetails(remote));
  Object.assign(details, connectorConsentDetails(remote));
  return { message, details };
}

const CONNECTOR_CONSENT_PATH = /\/connectors\/consent\/([A-Za-z0-9_-]{16,256})$/;

/**
 * What a consent answer needs to be acted on: the person's consent page (only
 * a Console `/connectors/consent/<token>` page, under the link rules below)
 * and its expiry.
 */
function connectorConsentDetails(remote: CompleteContractErrorBody["error"]): ContractErrorDetails {
  if (remote.code !== "CONNECTOR_CONSENT_REQUIRED" || typeof remote.consentLink !== "string") return {};
  let pathname: string;
  try {
    pathname = new URL(remote.consentLink).pathname;
  } catch {
    return {};
  }
  const token = CONNECTOR_CONSENT_PATH.exec(pathname)?.[1];
  const consentLink = token ? connectorConsoleLink(remote.consentLink, `/connectors/consent/${token}`) : undefined;
  if (!consentLink) return {};
  const details: ContractErrorDetails = { consentLink };
  const expiresAt = connectorExpiresAt(remote.expiresAt);
  if (expiresAt) details.expiresAt = expiresAt;
  return details;
}

const CONNECTOR_EXPIRES_AT_MAX = 64;

/**
 * What an approval answer needs to be acted on: the approval id, its Console
 * page, its expiry and the flag to re-run with. Each is kept only in the
 * shape the daemon builds: the page is the approval page of that id and the
 * flag names that id.
 */
function connectorApprovalDetails(remote: CompleteContractErrorBody["error"]): ContractErrorDetails {
  const approvalId = remote.approvalId;
  if (typeof approvalId !== "string" || !APPROVAL_ID_PATTERN.test(approvalId)) return {};
  const details: ContractErrorDetails = { approvalId };
  const approvalLink = connectorConsoleLink(remote.approvalLink, `/connectors/approvals/${approvalId}`);
  if (approvalLink) details.approvalLink = approvalLink;
  if (remote.retryWith === `--approval ${approvalId}`) details.retryWith = remote.retryWith;
  const expiresAt = connectorExpiresAt(remote.expiresAt);
  if (expiresAt) details.expiresAt = expiresAt;
  return details;
}

function connectorExpiresAt(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= CONNECTOR_EXPIRES_AT_MAX &&
    !hasControlCharacters(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/** A message, or a chat line under `detailKey` (sanitized as the envelope sanitizes that detail, links kept). */
function boundedRemoteLine(value: unknown, max: number, detailKey?: string): string | undefined {
  if (typeof value !== "string" || value.length > max || hasControlCharacters(value)) return undefined;
  const safe = detailKey ? sanitizePublicValue(value, detailKey) : sanitizePublicContractMessage(value);
  return typeof safe === "string" && safe.trim() && safe.length <= max ? safe : undefined;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only a Console page whose path ends with `suffix` (the connectors page, an
 * approval or consent page): https (http on localhost), no credentials, query
 * or fragment.
 */
function connectorConsoleLink(value: unknown, suffix: string): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(suffix) ||
    !/^(?:\/[A-Za-z0-9._-]+)*$/.test(url.pathname.slice(0, url.pathname.length - suffix.length))
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname}`;
}

const REMOTE_DRY_RUN_MESSAGE = "Dry-run: nothing was written. Re-run with --execute to perform the write.";

function isRemoteWriteBrake(body: CompleteContractErrorBody): boolean {
  return body.outcome === "blocked" && body.error.code === "WRITE_REQUIRES_EXECUTE";
}

function remoteContractFailureMessage(
  op: string,
  outcome: CompleteContractErrorBody["outcome"],
  issues?: ReturnType<typeof projectPublicIssues>,
  sourceMessage?: string,
  code?: string,
): string {
  if (outcome === "denied") return "Remote gateway denied the command.";
  if (outcome === "usage_error") return remoteValidationFailureMessage(issues, sourceMessage);
  if (isConnectorOp(op) && code && (outcome === "failed" || code.startsWith("CONNECTOR_"))) {
    const catalog = cloudContractCatalogCopy(code);
    if (catalog) return catalog.message;
  }
  // The write brake is a dry-run, not a policy denial: say how to proceed with local copy.
  if (outcome === "blocked" && code === "WRITE_REQUIRES_EXECUTE") return REMOTE_DRY_RUN_MESSAGE;
  if (outcome === "blocked") return "Remote command was blocked by policy.";
  if (issues?.[0]) return remoteValidationFailureMessage(issues, sourceMessage);
  if (code === "PAYLOAD_INVALID") return remoteValidationFailureMessage(issues, sourceMessage);
  if (op === "media send" && code) {
    const catalog = localMediaSendCatalogCopy(code);
    if (catalog) return catalog.message;
  }
  if (IDENTITY_LINK_OPS.has(op) && code) {
    const catalog = cloudContractCatalogCopy(code);
    if (catalog) return catalog.message;
  }
  return "Remote command failed.";
}

function remoteValidationFailureMessage(
  issues?: ReturnType<typeof projectPublicIssues>,
  sourceMessage?: string,
): string {
  const first = issues?.[0];
  if (first) {
    const path = first.path.filter((item) => item !== "<unknown>").join(".");
    return path ? `${path}: ${first.message}` : first.message;
  }
  const safe = safeRemotePayloadMessage(sourceMessage);
  if (safe) return safe;
  return "Remote gateway rejected the command input.";
}

function safeRemotePayloadMessage(message?: string): string | undefined {
  if (!message) return undefined;
  const issues = projectPublicIssues([{ path: [], code: "invalid", message }]);
  const projected = issues?.[0]?.message;
  if (!projected || !isSafeLocalPayloadMessage(projected)) return undefined;
  return projected;
}

function remoteSuggestedAction(op: string, outcome: CompleteContractErrorBody["outcome"], code?: string): string {
  if (outcome === "denied") return "Request the required remote permission before retrying the command";
  if (outcome === "usage_error" && code === "PAYLOAD_INVALID") return "Correct the command input and retry";
  if (outcome === "usage_error") return `Inspect '${op} --help' and retry with valid input`;
  if (outcome === "blocked" && code === "WRITE_REQUIRES_EXECUTE")
    return `Re-run '${op}' adding --execute to perform the write`;
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

function projectRemoteContractDetails(
  op: string,
  body: CompleteContractErrorBody,
  status: number,
): ContractErrorDetails {
  const remote = body.error;
  const details: ContractErrorDetails = { retryable: remote.retryable, status };
  const mediaCatalog = op === "media send" ? localMediaSendCatalogCopy(remote.code) : undefined;
  const identityCatalog = IDENTITY_LINK_OPS.has(op) ? cloudContractCatalogCopy(remote.code) : undefined;
  const connectorCatalog =
    isConnectorOp(op) && (body.outcome === "failed" || remote.code.startsWith("CONNECTOR_"))
      ? cloudContractCatalogCopy(remote.code)
      : undefined;
  if (mediaCatalog) {
    details.suggestedAction = mediaCatalog.suggestedAction;
  } else if (identityCatalog && body.outcome === "failed") {
    details.suggestedAction = identityCatalog.suggestedAction;
  } else if (connectorCatalog) {
    details.suggestedAction = connectorCatalog.suggestedAction;
  } else if (typeof remote.suggestedAction === "string" || isRemoteWriteBrake(body)) {
    details.suggestedAction = remoteSuggestedAction(op, body.outcome, remote.code);
  }
  const suggestions = boundedStringList(remote.suggestions, REMOTE_SUGGESTION_ID_PATTERN);
  if (suggestions) details.suggestions = suggestions;
  const acceptedFlags = boundedStringList(remote.acceptedFlags, REMOTE_FLAG_PATTERN);
  if (acceptedFlags) details.acceptedFlags = acceptedFlags;
  const acceptedPositionals = boundedStringList(remote.acceptedPositionals, REMOTE_POSITIONAL_PATTERN);
  if (acceptedPositionals) details.acceptedPositionals = acceptedPositionals;
  if (typeof remote.dryRun === "boolean") details.dryRun = remote.dryRun;
  const issues = projectPublicIssues(remote.issues);
  if (issues) details.issues = issues;
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
  if (input.config.auth === "sandbox-grant") return dispatchHome(input, path);
  if (!input.contextKey) throw new Error("Remote gateway dispatch requires a context key");
  const socketPath = input.config.socketPath ?? parseUnixGatewayUrl(input.config.url);
  const url = socketPath ? `http://ravi-cli-gateway.local${path}` : `${input.config.url}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${input.contextKey}`,
    ...(socketPath ? { "x-ravi-gateway-internal": "1" } : {}),
  };
  const parsedCwd = parseCallerCwd(input.cwd ?? process.cwd());
  if (parsedCwd.ok && parsedCwd.cwd) {
    headers[CALLER_CWD_HEADER] = parsedCwd.cwd;
  }
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

/**
 * `ravi home`: POST the decorated command's flat body to the HOME gateway.
 * The request carries no `authorization`, no `x-ravi-cwd`, no
 * `x-ravi-gateway-internal`, no cookie and nothing from the caller's `RAVI_*`
 * identity env. The only credential is the sandbox grant, which the egress
 * proxy injects; `RAVI_SANDBOX_GRANT` is the fallback. Redirects are not
 * followed.
 */
async function dispatchHome(input: RemoteDispatchInput, path: string): Promise<RemoteDispatchResult> {
  const op = commandOperation(input.groupSegments.join("_"), input.command);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const grant = readSandboxGrantFallback(input.env ?? process.env, op);
  if (grant) headers[SANDBOX_GRANT_HEADER] = grant;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? HOME_GATEWAY_DEFAULT_TIMEOUT_MS);
  try {
    const fetchFn = input.fetchImpl ?? fetch;
    const response = await fetchFn(`${input.config.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    const rawRequestId = response.headers.get(HOME_REQUEST_ID_HEADER);
    const requestId = rawRequestId && HOME_REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : null;
    const bytes = await readBoundedHomeBody(response, controller, op, requestId);
    return {
      status: response.status,
      ok: response.ok,
      body: new TextDecoder().decode(bytes),
      contentType: response.headers.get("content-type"),
      requestId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read at most `HOME_RESPONSE_MAX_BYTES` of a HOME response. A larger declared
 * length or body aborts the request and fails `HOME_RESPONSE_TOO_LARGE`
 * without keeping what was read.
 */
async function readBoundedHomeBody(
  response: Response,
  controller: AbortController,
  op: string,
  requestId: string | null,
): Promise<Uint8Array> {
  const tooLarge = () => {
    controller.abort();
    return new ContractError(
      op,
      "HOME_RESPONSE_TOO_LARGE",
      `HOME answered with more than ${HOME_RESPONSE_MAX_BYTES / (1024 * 1024)} MiB; the response was discarded.${requestIdSuffix(requestId)}`,
      1,
      {
        status: response.status,
        requestId,
        suggestedAction: "Check the HOME gateway; a task command answer is never this large",
      },
    );
  };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > HOME_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > HOME_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Project a HOME failure. The Gate answers `{error:{code,requestId}}` and the
 * listener `{error:{code,requestId,source:"ravi-listener"}}`; both become
 * `HOME_<CODE>` with the request id in the message. A complete contract
 * envelope relayed from the daemon's dispatcher keeps the remote projection.
 * Nothing else from the body is shown. The grant (`RAVI_SANDBOX_GRANT` from
 * `env`, and any JWS-shaped token) is scrubbed from the body before projection
 * and from the error after it.
 */
export function homeGatewayErrorToContractError(
  op: string,
  result: RemoteDispatchResult,
  env: NodeJS.ProcessEnv = process.env,
): ContractError | null {
  if (result.ok) return null;
  const grant = knownSandboxGrant(env);
  const error = projectHomeError(op, scrubHomeResult(result, grant));
  return error && scrubHomeContractError(error, grant);
}

function projectHomeError(op: string, result: RemoteDispatchResult): ContractError | null {
  const headerRequestId = result.requestId ?? null;
  if (result.status >= 300 && result.status < 400) {
    return new ContractError(
      op,
      "HOME_GATEWAY_REDIRECT",
      `HOME gateway answered ${result.status} with a redirect, which is not followed.${requestIdSuffix(headerRequestId)}`,
      1,
      { status: result.status, requestId: headerRequestId, suggestedAction: `Check ${HOME_GATEWAY_URL_ENV}` },
    );
  }
  let body: unknown;
  try {
    body = result.contentType?.includes("json") ? JSON.parse(result.body) : undefined;
  } catch {
    body = undefined;
  }
  const envelope = homeErrorEnvelope(body);
  if (envelope) {
    const requestId = envelope.requestId ?? headerRequestId;
    const exitCode = homeErrorExitCode(result.status, envelope.code);
    return new ContractError(
      op,
      `HOME_${envelope.code.toUpperCase()}`,
      `HOME refused the command: ${envelope.code} (status ${result.status}, from ${envelope.source}).${requestIdSuffix(requestId)}`,
      exitCode,
      {
        retryable: HOME_RETRYABLE_STATUSES.has(result.status) && !HOME_NON_RETRYABLE_CODES.has(envelope.code),
        status: result.status,
        homeCode: envelope.code,
        source: envelope.source,
        requestId,
        suggestedAction: HOME_SUGGESTED_ACTIONS[envelope.code] ?? "Inspect HOME's audit for this request id",
      },
    );
  }
  if (isCompleteContractErrorBody(body, op)) return remoteGatewayErrorToContractError(op, result);
  return new ContractError(
    op,
    "HOME_GATEWAY_FAILED",
    `HOME gateway request failed (status ${result.status}).${requestIdSuffix(headerRequestId)}`,
    1,
    {
      retryable: result.status >= 500,
      status: result.status,
      requestId: headerRequestId,
      suggestedAction: "Check HOME gateway availability and retry",
    },
  );
}

/**
 * Bad input is a usage error (2), a command outside the grant is a policy block
 * (3), the rest fail (1). `grant_header_invalid` is a 400 the caller cannot fix
 * by changing its input, so it fails (1).
 */
function homeErrorExitCode(status: number, code: string): 1 | 2 | 3 {
  if (code === "grant_header_invalid") return 1;
  if (status === 400 || status === 413) return CONTRACT_EXIT_USAGE;
  if (code === "command_not_allowed") return 3;
  return 1;
}

const HOME_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
/** Gate codes on a retryable status that the same request will hit again. */
const HOME_NON_RETRYABLE_CODES = new Set(["response_too_large"]);

const HOME_SUGGESTED_ACTIONS: Record<string, string> = {
  grant_missing: `Run inside a connected sandbox run; the egress proxy adds the grant (or set ${SANDBOX_GRANT_ENV} when the run allows it)`,
  grant_invalid: "Start a new connected run; this run's grant is not accepted",
  grant_revoked: "This run was revoked or has expired; start a new connected run",
  grant_header_invalid: `HOME received more than one grant (or a malformed one). When the egress proxy injects ${SANDBOX_GRANT_HEADER}, unset ${SANDBOX_GRANT_ENV} and retry`,
  command_not_allowed: "Use one of the commands listed by `ravi home --help`",
  task_not_allowed: "Use the HOME task id given to this run",
  resource_forbidden: "Use the HOME task id given to this run",
  body_invalid: "Inspect `ravi home <group> <command> --help` and retry with valid input",
  argument_invalid: "Inspect `ravi home <group> <command> --help` and retry with valid input",
  rate_limited: "Wait and retry",
  daemon_offline: "HOME is offline; retry later",
  gate_unavailable: "The HOME Gate is unavailable; retry later",
  gateway_misconfigured: "The HOME Gate is misconfigured; report the request id to HOME's operator",
  payload_too_large: "Send a smaller request (shorter text or fewer fields)",
  response_too_large:
    "HOME's answer exceeded the Gate's 4 MiB limit; ask for less (for example a narrower `tasks show`)",
  not_found: `Check ${HOME_GATEWAY_URL_ENV} and that HOME serves this command`,
  method_not_allowed: `Check ${HOME_GATEWAY_URL_ENV}; HOME commands are sent as POST`,
};

function requestIdSuffix(requestId: string | null): string {
  return requestId ? ` Request id: ${requestId}.` : "";
}

function homeErrorEnvelope(body: unknown): { code: string; requestId: string | null; source: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || !HOME_ERROR_CODE_PATTERN.test(record.code)) return null;
  if (record.source !== undefined && record.source !== HOME_LISTENER_SOURCE) return null;
  const requestId =
    typeof record.requestId === "string" && HOME_REQUEST_ID_PATTERN.test(record.requestId) ? record.requestId : null;
  return {
    code: record.code,
    requestId,
    source: record.source === HOME_LISTENER_SOURCE ? HOME_LISTENER_SOURCE : "gate",
  };
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

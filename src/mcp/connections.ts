/**
 * Connections of the MCP gateway (spec mcp, Gateway).
 *
 * One `Client` of `@modelcontextprotocol/client` per registered server, in
 * the daemon, shared by every agent. A connection opens on first use, closes
 * after it has been idle for a while (a stdio child is stopped with it), is
 * dropped when the server's registration or secret changes, and is closed
 * when the daemon stops. There is no reconnect loop: the next use connects
 * again.
 *
 * Version negotiation is passed explicitly from the `protocol` column (the
 * SDK default is the legacy handshake). The era verdict is stored in
 * `discover_json` as `{kind, discover?, decidedAt}` and fed back as the
 * `prior` of the next connect, so a server is not probed on every connect. A
 * legacy verdict on an http row is trusted for 24 hours. A stored modern
 * verdict that the server refuses (an unsupported version, a failed era
 * negotiation) is dropped and the server probed again at once, and a fresh
 * legacy answer from a server whose last verdict was modern is probed once
 * more before it is believed.
 *
 * Secrets: the full URL and the env values come from the credentials store
 * on every connect and are never logged; every error text that leaves this
 * module passes `safeMcpErrorText`, which removes them.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  type AuthProvider,
  Client,
  type DiscoverResult,
  type ElicitRequest,
  type ElicitResult,
  InsufficientScopeError,
  type OAuthClientProvider,
  type PriorDiscovery,
  ProtocolError,
  type ResponseCacheStore,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";

import packageInfo from "../../package.json" with { type: "json" };
import { getRaviStateDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { mcpDisplayUrl, parseMcpServerUrl } from "./names.js";
import { MCP_DAMAGED_ENV_KEYS, type McpEra, type McpProtocolMode, type McpServerRecord } from "./registry-db.js";
import { type McpServerSecret, readMcpServerSecret } from "./secrets.js";
import { McpStdioChildTransport } from "./stdio-transport.js";
import { mcpLoginCommand } from "./login-options.js";

const log = logger.child("mcp:connections");

export const MCP_CLIENT_INFO = { name: "ravi", version: String(packageInfo.version ?? "0.0.0") } as const;
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
/** A legacy verdict on an http row is probed again after this long. */
export const MCP_LEGACY_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MCP_IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;
const STDIO_PROBE_TIMEOUT_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const ERROR_TEXT_MAX = 300;

// ============================================================================
// Errors
// ============================================================================

export type McpConnectionErrorCode =
  | "needs_login"
  | "secret_missing"
  | "url_mismatch"
  | "env_missing"
  | "spawn_failed"
  | "connect_failed"
  | "unsupported_version"
  | "timeout"
  | "rate_limited"
  | "closed";

export class McpConnectionError extends Error {
  readonly code: McpConnectionErrorCode;
  constructor(code: McpConnectionErrorCode, message: string) {
    super(message);
    this.name = "McpConnectionError";
    this.code = code;
  }
}

/** The daemon cannot authorize to this server without the operator: `ravi mcp login`. */
export class McpLoginRequired extends McpConnectionError {
  constructor(server: string) {
    super("needs_login", `MCP server ${server} needs a login: run ${mcpLoginCommand(server)}`);
    this.name = "McpLoginRequired";
  }
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const TOKEN_LIKE_RUN = /[A-Za-z0-9_\-+/=]{24,}/g;

/**
 * An error text that may be shown (status detail, a tool error, a log):
 * known secret values removed, every URL replaced, token-like runs elided,
 * capped. Never the raw message of an error that saw a secret.
 */
export function safeMcpErrorText(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[secret]");
  }
  text = text.replace(URL_PATTERN, "<url>").replace(TOKEN_LIKE_RUN, "…").replace(/\s+/g, " ").trim();
  if (!text) text = "unknown error";
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}…` : text;
}

function httpStatus(error: unknown): unknown {
  return SdkError.isInstance(error) ? (error as SdkError & { status?: unknown }).status : undefined;
}

/** The HTTP 429 of a request the SDK client sent (the server asks Ravi to slow down; nothing ran). */
export function isMcpRateLimited(error: unknown): boolean {
  if (error instanceof McpConnectionError && error.code === "rate_limited") return true;
  return httpStatus(error) === 429;
}

/** Retry-After bounds (ms): the Console names at most an hour. */
export const MCP_MIN_RETRY_AFTER_MS = 1_000;
export const MCP_MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** Used when a 429 names no Retry-After. */
export const MCP_DEFAULT_RETRY_AFTER_MS = 60_000;

/** Seconds or an HTTP date, clamped to 1 s .. 1 h; null when absent or unreadable. */
export function parseMcpRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  let ms: number | null = null;
  if (/^\d{1,7}$/.test(text)) ms = Number.parseInt(text, 10) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null) return null;
  return Math.min(MCP_MAX_RETRY_AFTER_MS, Math.max(MCP_MIN_RETRY_AFTER_MS, ms));
}

const SCOPE_TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/;

/**
 * The scopes a `scope` value names (the attribute of a `WWW-Authenticate`
 * challenge, or the SDK's `requiredScope`): plain scope tokens only, at most
 * eight. Anything else in it is dropped, so the text can be shown.
 */
export function mcpScopeTokens(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const tokens = value.split(/\s+/).filter((token) => SCOPE_TOKEN.test(token));
  return [...new Set(tokens)].slice(0, 8);
}

/** The scopes a `WWW-Authenticate` challenge names in its `scope` attribute. */
export function mcpChallengeScopes(challenge: string): string[] {
  const match = /\bscope\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(challenge);
  return mcpScopeTokens(match ? (match[1] ?? match[2] ?? "") : "");
}

/**
 * A step-up answer (403 `insufficient_scope`): the stored login is valid but
 * lacks a scope this one request needs.
 */
export function isMcpInsufficientScope(error: unknown): boolean {
  return error instanceof InsufficientScopeError;
}

/**
 * The stored login did not authorize: no login, a refused or expired token,
 * a 401, or a step-up (403 insufficient_scope; the daemon never
 * re-authorizes, the operator logs in again).
 */
function isLoginFailure(error: unknown): boolean {
  if (error instanceof McpLoginRequired || UnauthorizedError.isInstance(error)) return true;
  if (error instanceof InsufficientScopeError) return true;
  if (SdkError.isInstance(error) && (error as SdkError).code === SdkErrorCode.ClientHttpAuthentication) return true;
  return httpStatus(error) === 401;
}

/** A plain 403: the server (or something in front of it) refuses, and a login does not change that. */
function isHttpForbidden(error: unknown): boolean {
  if (SdkError.isInstance(error) && (error as SdkError).code === SdkErrorCode.ClientHttpForbidden) return true;
  return httpStatus(error) === 403;
}

/** The server refused the protocol revision (-32022), or the era could not be negotiated. */
export function isMcpVersionRefusal(error: unknown): boolean {
  if (ProtocolError.isInstance(error) && (error as ProtocolError).code === -32022) return true;
  return SdkError.isInstance(error) && (error as SdkError).code === SdkErrorCode.EraNegotiationFailed;
}

/** Methods only the 2026-07-28 era has: a `-32601` for one of them says the server speaks the legacy era now. */
export const MCP_MODERN_ONLY_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "skills/list",
  "skills/get",
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
]);

/**
 * A failure that says the stored verdict is stale (addendum A6): a version
 * refusal (`-32022`, or an era that could not be negotiated), and, on a
 * connection that adopted a stored modern verdict without negotiating, an
 * answer that is not a valid result for that era or a `-32601` on a method
 * only the modern era has. Any other server error (`-32602` not found or a
 * bad cursor, `-32603` the Console unreachable, `-32003`) is the server's
 * answer in the era it speaks, never a reason to probe or to send again.
 *
 * `method` is the label of the use: one method, or several separated by
 * commas when the use sends them in turn (a skill read sends `skills/get`,
 * then `resources/read`). A `-32601` counts when any of them is modern-only.
 */
export function isMcpStaleVerdictSignal(
  error: unknown,
  lease: Pick<McpConnectionLease, "era" | "reusedVerdict">,
  method?: string,
): boolean {
  if (isMcpVersionRefusal(error)) return true;
  if (!lease.reusedVerdict || lease.era !== "modern") return false;
  if (isMcpInvalidResult(error)) return true;
  return (
    method !== undefined &&
    method.split(",").some((name) => MCP_MODERN_ONLY_METHODS.has(name.trim())) &&
    ProtocolError.isInstance(error) &&
    (error as ProtocolError).code === -32601
  );
}

/** The result did not validate (a modern client reading a legacy answer, for one). */
export function isMcpInvalidResult(error: unknown): boolean {
  return SdkError.isInstance(error) && (error as SdkError).code === SdkErrorCode.InvalidResult;
}

export function isMcpTimeout(error: unknown): boolean {
  return SdkError.isInstance(error) && (error as SdkError).code === SdkErrorCode.RequestTimeout;
}

export type McpFailureKind = "needs_login" | "refused" | "timeout" | "unsupported_version" | "error";

/**
 * What a failure means for the row. `needs_login` only for a row that has a
 * login to give (auth bearer or oauth): `ravi mcp login` is its remedy. The
 * same 401 or 403 on an `auth none` row, and a plain 403 on any row, is
 * `refused`: the row is in error and probed again later, since a login
 * cannot fix it.
 */
export function classifyMcpFailure(error: unknown, server: Pick<McpServerRecord, "authKind">): McpFailureKind {
  const hasLogin = server.authKind !== "none";
  if (error instanceof McpConnectionError && error.code === "needs_login") return hasLogin ? "needs_login" : "error";
  if (isLoginFailure(error)) return hasLogin ? "needs_login" : "refused";
  if (isHttpForbidden(error)) return "refused";
  if (error instanceof McpConnectionError) {
    if (error.code === "timeout") return "timeout";
    if (error.code === "unsupported_version") return "unsupported_version";
    return "error";
  }
  if (isMcpTimeout(error)) return "timeout";
  if (isMcpVersionRefusal(error)) return "unsupported_version";
  return "error";
}

/** The status detail of a failure (never a URL or secret: `safeMcpErrorText` runs on the error text). */
export function mcpFailureDetail(
  kind: McpFailureKind,
  error: unknown,
  server: Pick<McpServerRecord, "name" | "authKind">,
  secrets: readonly string[] = [],
): string {
  if (kind === "needs_login") return `run ${mcpLoginCommand(server.name, server.authKind)}`;
  if (kind === "refused") {
    const status = httpStatus(error) === 401 || isLoginFailure(error) ? 401 : 403;
    return `refused (HTTP ${status}): the server does not accept this connection; check the URL or register the server again`;
  }
  return `${kind === "timeout" ? "timed out" : "failed"}: ${safeMcpErrorText(error, secrets)}`;
}

// ============================================================================
// Era verdicts
// ============================================================================

export type McpStoredVerdict =
  | { kind: "modern"; discover: DiscoverResult; decidedAt: number }
  | { kind: "legacy"; decidedAt: number };

/** The stored verdict of a row, or null when there is none or it does not match the row's era. */
export function parseMcpStoredVerdict(server: Pick<McpServerRecord, "discover" | "era">): McpStoredVerdict | null {
  const value = server.discover;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const decidedAt = typeof record.decidedAt === "number" && Number.isFinite(record.decidedAt) ? record.decidedAt : 0;
  if (record.kind === "modern" && server.era === "modern") {
    const discover = record.discover;
    if (!discover || typeof discover !== "object" || Array.isArray(discover)) return null;
    if (!Array.isArray((discover as Record<string, unknown>).supportedVersions)) return null;
    return { kind: "modern", discover: discover as DiscoverResult, decidedAt };
  }
  if (record.kind === "legacy" && server.era === "legacy") return { kind: "legacy", decidedAt };
  return null;
}

export function mcpNegotiationMode(protocol: McpProtocolMode): VersionNegotiationMode {
  if (protocol === "legacy") return "legacy";
  if (protocol === MCP_MODERN_PROTOCOL_VERSION) return { pin: MCP_MODERN_PROTOCOL_VERSION };
  return "auto";
}

/**
 * The `prior` to connect with, or undefined to negotiate. A `legacy` row
 * needs none (it never probes); a pinned row reuses only a modern verdict;
 * an `auto` row reuses a modern verdict, and a legacy one for 24 hours on
 * http (a stdio child is local, so its legacy verdict stands).
 */
export function mcpPriorDiscovery(
  server: Pick<McpServerRecord, "discover" | "era" | "protocol" | "transport">,
  now: number,
): PriorDiscovery | undefined {
  if (server.protocol === "legacy") return undefined;
  const verdict = parseMcpStoredVerdict(server);
  if (!verdict) return undefined;
  if (verdict.kind === "modern") return { kind: "modern", discover: verdict.discover };
  if (server.protocol !== "auto") return undefined;
  if (server.transport === "http" && now - verdict.decidedAt >= MCP_LEGACY_VERDICT_TTL_MS) return undefined;
  return { kind: "legacy" };
}

/** Whether the stored legacy verdict of an http row is due for a new probe. */
export function mcpLegacyVerdictExpired(
  server: Pick<McpServerRecord, "discover" | "era" | "protocol" | "transport">,
  now: number,
): boolean {
  if (server.transport !== "http" || server.protocol !== "auto") return false;
  const verdict = parseMcpStoredVerdict(server);
  return verdict?.kind === "legacy" && now - verdict.decidedAt >= MCP_LEGACY_VERDICT_TTL_MS;
}

// ============================================================================
// Connections
// ============================================================================

/**
 * What a call tells its connection about itself, so a legacy-era
 * `elicitation/create` server request can be tied to it. Opaque here; the
 * gateway reads it back.
 */
export type McpCallAttribution = unknown;

export interface McpElicitationAsk {
  server: string;
  era: McpEra;
  params: ElicitRequest["params"];
  /**
   * The one call this request belongs to: set only when exactly one use of
   * the connection is in flight and that use is a call that bound itself.
   * Absent means the request cannot be attributed and must be declined.
   */
  call?: McpCallAttribution;
}

export interface McpConnectionManagerOptions {
  /** Read a server's secret document (default: the credentials store). */
  readSecret?: (server: string) => Promise<McpServerSecret | null>;
  /**
   * The authorization of a bearer or OAuth row, or null when none is stored
   * (the row then needs `ravi mcp login`). The gateway passes the stored
   * login (`oauth-provider.ts`); without this option no row has one.
   */
  authProvider?: (server: McpServerRecord) => Promise<AuthProvider | OAuthClientProvider | null>;
  /**
   * The answer to a legacy-era `elicitation/create` request the server sends
   * on its own connection (default: decline). The request carries no id of
   * the call it belongs to, so it is attributed only when exactly one use of
   * the connection is in flight and that use is a bound call (`ask.call`).
   */
  onLegacyElicitation?: (ask: McpElicitationAsk) => Promise<ElicitResult>;
  /**
   * The response cache a server's clients share across connections (the
   * SDK keeps `tools/list` there and serves it while the server's `ttlMs`
   * holds). The gateway keeps one per row and registration; without this
   * option each client keeps its own.
   */
  responseCacheStore?: (server: McpServerRecord) => ResponseCacheStore | undefined;
  /** PATH of a stdio child (default: the daemon's PATH). */
  childPath?: string;
  stateDir?: () => string;
  idleMs?: number;
  connectTimeoutMs?: number;
  /** stdio: how long the version probe waits for an answer (default 5 s). */
  stdioProbeTimeoutMs?: number;
  /** stdio: how long a closing child gets before it is signalled. */
  closeGraceMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface McpConnectionLease {
  readonly server: string;
  readonly client: Client;
  readonly era: McpEra;
  /** The verdict this connection reached; persist it when it differs from the row's. */
  readonly verdict: McpStoredVerdict;
  /** Secret values the connection used, for error redaction. */
  readonly secrets: readonly string[];
  /** stdio: the child's pid. */
  readonly pid: number | null;
  /** The connection adopted the stored verdict instead of negotiating. */
  readonly reusedVerdict: boolean;
  /**
   * Tie this use to a call, for the attribution of legacy-era elicitation
   * requests. The binding ends with `release()` or `discard()`.
   */
  bindCall(attribution: McpCallAttribution): void;
  release(): void;
  /** Drop the connection (after a protocol failure); the next use connects again. */
  discard(): Promise<void>;
}

interface Connection {
  server: string;
  signature: string;
  client: Client;
  transport: Transport;
  era: McpEra;
  verdict: McpStoredVerdict;
  reusedVerdict: boolean;
  secrets: string[];
  inFlight: number;
  /** Calls bound to uses in flight (see `McpConnectionLease.bindCall`). */
  boundCalls: Set<{ attribution: McpCallAttribution }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface Opened {
  client: Client;
  transport: Transport;
  era: McpEra;
  verdict: McpStoredVerdict;
  reusedVerdict: boolean;
  /** Where the client's legacy elicitation handler finds the connection it serves. */
  holder: { connection: Connection | null };
}

export interface McpAcquireOptions {
  /**
   * Negotiate even when a verdict is stored (the stored one turned out
   * stale). A legacy answer from a row whose stored verdict was modern is
   * still probed once more.
   */
  ignoreStoredVerdict?: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What a connection depends on: the registration and the secret document. */
function connectionSignature(server: McpServerRecord, secret: McpServerSecret | null): string {
  return sha256(
    JSON.stringify({
      transport: server.transport,
      urlDisplay: server.urlDisplay,
      command: server.command,
      args: server.args,
      envKeys: server.envKeys,
      authKind: server.authKind,
      credentialRev: server.credentialRev,
      protocol: server.protocol,
      // OAuth tokens are left out: a refresh rewrites them under a live
      // connection. A new login or a logout moves credentialRev instead.
      secret: secret
        ? sha256(JSON.stringify({ url: secret.url ?? null, env: secret.env ?? null, bearer: secret.bearer ?? null }))
        : null,
    }),
  );
}

/**
 * The call a legacy-era server request belongs to: only when exactly one use
 * of the connection is in flight and it is a bound call. A refresh probe, a
 * second call, or a connection still opening make the request ambiguous.
 */
function legacyElicitationAttribution(
  connection: Connection | null,
): { attributed: true; attribution: McpCallAttribution } | { attributed: false } {
  if (!connection || connection.closed || connection.inFlight !== 1 || connection.boundCalls.size !== 1) {
    return { attributed: false };
  }
  const [binding] = [...connection.boundCalls];
  return binding ? { attributed: true, attribution: binding.attribution } : { attributed: false };
}

/** How long a captured Retry-After stays readable for the failure it belongs to. */
const RETRY_AFTER_CAPTURE_MS = 30_000;

/** Whether a connection is still opening, and whether a 429 already answered that connect. */
interface ConnectPhase {
  connecting: boolean;
  limited: boolean;
  retryAfter: string | null;
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<Connection>>();
  private readonly options: McpConnectionManagerOptions;
  /** The last HTTP 429 each server answered on an SDK connection, with its Retry-After (ms). */
  private readonly retryAfter = new Map<string, { at: number; ms: number | null }>();
  private generation = 0;
  private stopped = false;
  /** Transports of connects still opening: a stop closes them (a stdio child's group goes too). */
  private readonly opening = new Set<Transport>();

  constructor(options: McpConnectionManagerOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Names of the servers with an open connection. */
  openServers(): string[] {
    return [...this.connections.keys()].sort();
  }

  /**
   * The `Retry-After` of the HTTP 429 a server last answered on an SDK
   * connection (ms, clamped like the raw dispatch's), taken once: the SDK's
   * error does not carry the header, so the transport's fetch keeps it here.
   * Null when the 429 named none, or none was seen in the last 30 seconds.
   */
  takeRetryAfterMs(server: string): number | null {
    const seen = this.retryAfter.get(server);
    this.retryAfter.delete(server);
    if (!seen || this.now() - seen.at > RETRY_AFTER_CAPTURE_MS) return null;
    return seen.ms;
  }

  /**
   * The transport's fetch, wrapped to keep the Retry-After of a 429 (never its
   * body). While the connection is still opening (`phase.connecting`), a 429
   * holds the rest of that connect: the SDK's next attempt (its legacy
   * fallback after a refused `server/discover`) is answered with the same 429
   * without being sent.
   */
  private rateLimitAwareFetch(server: string, phase: ConnectPhase): typeof fetch {
    const base = this.options.fetch ?? fetch;
    const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (phase.connecting && phase.limited) {
        return new Response(null, {
          status: 429,
          headers: phase.retryAfter ? { "retry-after": phase.retryAfter } : {},
        });
      }
      const response = await base(input, init);
      if (response.status === 429) {
        if (phase.connecting) {
          phase.limited = true;
          phase.retryAfter = response.headers.get("retry-after");
        }
        this.retryAfter.set(server, {
          at: this.now(),
          ms: parseMcpRetryAfter(response.headers.get("retry-after"), this.now()),
        });
      }
      return response;
    };
    return wrapped as typeof fetch;
  }

  /**
   * A connection to `server` for one use. Reuses an open connection when the
   * registration and secret are unchanged, else opens a new one. The caller
   * must `release()` the lease.
   */
  async acquire(server: McpServerRecord, options: McpAcquireOptions = {}): Promise<McpConnectionLease> {
    if (this.stopped) throw new McpConnectionError("closed", "The MCP gateway is stopped.");
    const secret = await (this.options.readSecret ?? readMcpServerSecret)(server.name);
    const signature = connectionSignature(server, secret);
    let connection = this.connections.get(server.name);
    if (connection && (connection.closed || connection.signature !== signature || options.ignoreStoredVerdict)) {
      await this.close(server.name);
      connection = undefined;
    }
    if (!connection) {
      const key = `${server.name}\u0000${signature}`;
      let opening = this.pending.get(key);
      if (!opening) {
        const generation = this.generation;
        opening = this.open(server, secret, signature, options)
          .then(async (opened) => {
            if (this.stopped || generation !== this.generation) {
              await this.closeConnection(opened);
              throw new McpConnectionError("closed", "The MCP connection was dropped while it opened.");
            }
            const previous = this.connections.get(server.name);
            if (previous) await this.closeConnection(previous);
            this.connections.set(server.name, opened);
            return opened;
          })
          .finally(() => this.pending.delete(key));
        this.pending.set(key, opening);
      }
      connection = await opening;
    }
    return this.lease(connection);
  }

  private lease(connection: Connection): McpConnectionLease {
    connection.inFlight++;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
    }
    let released = false;
    let binding: { attribution: McpCallAttribution } | null = null;
    const release = () => {
      if (released) return;
      released = true;
      if (binding) connection.boundCalls.delete(binding);
      binding = null;
      connection.inFlight = Math.max(0, connection.inFlight - 1);
      if (connection.inFlight === 0 && !connection.closed) this.scheduleIdle(connection);
    };
    return {
      server: connection.server,
      client: connection.client,
      era: connection.era,
      verdict: connection.verdict,
      secrets: connection.secrets,
      pid: connection.transport instanceof McpStdioChildTransport ? connection.transport.pid : null,
      reusedVerdict: connection.reusedVerdict,
      bindCall: (attribution) => {
        if (released) return;
        if (binding) connection.boundCalls.delete(binding);
        binding = { attribution };
        connection.boundCalls.add(binding);
      },
      release,
      discard: async () => {
        release();
        if (this.connections.get(connection.server) === connection) this.connections.delete(connection.server);
        await this.closeConnection(connection);
      },
    };
  }

  private scheduleIdle(connection: Connection): void {
    const idleMs = this.options.idleMs ?? DEFAULT_MCP_IDLE_MS;
    connection.idleTimer = setTimeout(() => {
      connection.idleTimer = null;
      if (connection.inFlight > 0 || connection.closed) return;
      if (this.connections.get(connection.server) === connection) this.connections.delete(connection.server);
      void this.closeConnection(connection);
    }, idleMs);
    connection.idleTimer.unref?.();
  }

  /** Drop one server's connection (a config change, a removal). */
  async close(server: string): Promise<void> {
    const connection = this.connections.get(server);
    if (!connection) return;
    this.connections.delete(server);
    await this.closeConnection(connection);
  }

  /** Drop every connection; connects still opening are discarded when they finish. */
  async closeAll(): Promise<void> {
    this.generation++;
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((connection) => this.closeConnection(connection)));
  }

  /**
   * Close everything and refuse new connections (daemon stop). A connect
   * still opening is not waited for: its transport is closed now (a stdio
   * child's whole group is stopped), so the connect fails at once and no
   * child outlives the gateway. Every stdio child, opening or live, is
   * stopped on the shutdown path (SIGTERM at once, SIGKILL shortly after),
   * never on the ordinary grace sequence, so the stop fits the gateway's
   * stop bound even for a child that ignores stdin EOF and SIGTERM.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    const opening = [...this.opening];
    this.opening.clear();
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all([
      ...all.map((connection) => this.closeConnection(connection)),
      ...opening.map(async (transport) => {
        try {
          await closeTransport(transport, true);
        } catch {
          // no-cause: a transport that fails to close is already gone.
        }
      }),
    ]);
  }

  private async closeConnection(connection: Connection | Opened): Promise<void> {
    const tracked = connection as Partial<Connection>;
    if (tracked.closed) return;
    if ("closed" in connection) connection.closed = true;
    if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
    // After a stop the child goes on the shutdown path, started before the client's own close
    // (which closes the transport too, on the ordinary grace) so that close is cut short.
    const shutdown = this.stopped
      ? closeTransport(connection.transport, true).catch(() => {
          // no-cause: a transport that fails to close is already gone; the stop is the outcome.
        })
      : null;
    try {
      await connection.client.close();
    } catch {
      // no-cause: a failed close leaves nothing to keep; the transport below is closed as well.
    }
    try {
      await (shutdown ?? connection.transport.close());
    } catch {
      // no-cause: the transport is already closed.
    }
  }

  private async open(
    server: McpServerRecord,
    secret: McpServerSecret | null,
    signature: string,
    options: McpAcquireOptions,
  ): Promise<Connection> {
    const secrets: string[] = [];
    if (secret?.url) secrets.push(secret.url);
    for (const value of Object.values(secret?.env ?? {})) secrets.push(value);
    const prior = options.ignoreStoredVerdict ? undefined : mcpPriorDiscovery(server, this.now());
    const storedModern = parseMcpStoredVerdict(server)?.kind === "modern";
    let opened: Opened;
    try {
      opened = await this.connectOnce(server, secret, prior);
    } catch (error) {
      if (prior?.kind === "modern" && isMcpVersionRefusal(error)) {
        log.info("Stored modern verdict refused; probing again", { server: server.name });
        opened = await this.connectOnce(server, secret, undefined);
      } else if (
        server.transport === "stdio" &&
        server.protocol === "auto" &&
        !prior &&
        SdkError.isInstance(error) &&
        ((error as SdkError).code === SdkErrorCode.EraNegotiationFailed ||
          (error as SdkError).code === SdkErrorCode.RequestTimeout)
      ) {
        // A stdio server that exits on the unrecognized probe, or never answers it, is a legacy server.
        // The SDK reads a silent probe as legacy only on its own stdio transport (it recognizes it by
        // shape), so the gateway's transport gets the same verdict here, on a fresh child.
        opened = await this.connectOnce(server, secret, { kind: "legacy" });
      } else {
        throw error;
      }
    }
    if (opened.era === "legacy" && storedModern && server.protocol === "auto") {
      // A modern server answering the legacy way once may be a blip: probe once more before believing it.
      await this.closeConnection(opened);
      opened = await this.connectOnce(server, secret, undefined);
    }
    const connection: Connection = {
      server: server.name,
      signature,
      client: opened.client,
      transport: opened.transport,
      era: opened.era,
      verdict: opened.verdict,
      reusedVerdict: opened.reusedVerdict,
      secrets,
      inFlight: 0,
      boundCalls: new Set(),
      idleTimer: null,
      closed: false,
    };
    opened.holder.connection = connection;
    opened.client.onclose = () => {
      connection.closed = true;
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      if (this.connections.get(connection.server) === connection) this.connections.delete(connection.server);
    };
    return connection;
  }

  private async connectOnce(
    server: McpServerRecord,
    secret: McpServerSecret | null,
    prior: PriorDiscovery | undefined,
  ): Promise<Opened> {
    const stoppedError = () => new McpConnectionError("closed", "The MCP gateway is stopped.");
    if (this.stopped) throw stoppedError();
    const phase: ConnectPhase = { connecting: true, limited: false, retryAfter: null };
    const transport = await this.buildTransport(server, secret, phase);
    if (this.stopped) {
      // Stopped while the login was read: nothing was started yet, nothing is sent.
      try {
        await transport.close();
      } catch {
        // no-cause: a transport that never started has nothing to close; the stop is the outcome.
      }
      throw stoppedError();
    }
    this.opening.add(transport);
    const responseCacheStore = this.options.responseCacheStore?.(server);
    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: { elicitation: { form: {}, url: {} } },
      ...(responseCacheStore ? { responseCacheStore } : {}),
      versionNegotiation: {
        mode: mcpNegotiationMode(server.protocol),
        probe: {
          timeoutMs:
            server.transport === "stdio"
              ? (this.options.stdioProbeTimeoutMs ?? STDIO_PROBE_TIMEOUT_MS)
              : HTTP_PROBE_TIMEOUT_MS,
        },
      },
      inputRequired: { autoFulfill: false },
    });
    const holder: { connection: Connection | null } = { connection: null };
    client.setRequestHandler("elicitation/create", async (request) => {
      const call = legacyElicitationAttribution(holder.connection);
      const ask: McpElicitationAsk = {
        server: server.name,
        era: "legacy",
        params: request.params,
        ...(call.attributed ? { call: call.attribution } : {}),
      };
      if (!call.attributed) {
        log.info("Legacy MCP elicitation declined: it cannot be tied to one call", {
          server: server.name,
          inFlight: holder.connection?.inFlight ?? 0,
        });
        return { action: "decline" };
      }
      try {
        return this.options.onLegacyElicitation ? await this.options.onLegacyElicitation(ask) : { action: "decline" };
      } catch {
        // no-cause: an answer that fails is a cancel, never content.
        return { action: "cancel" };
      }
    });
    client.onerror = () => {
      // no-cause: transport noise is not logged; its text may hold what the server printed.
    };
    try {
      await client.connect(transport, {
        ...(prior ? { prior } : {}),
        timeout: this.options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
      });
      phase.connecting = false;
      if (phase.limited) {
        // A 429 during the era negotiation (the SDK reads a refused server/discover as a legacy server)
        // is the server's back-off, never an era verdict: the connect fails as rate limited.
        throw new McpConnectionError(
          "rate_limited",
          `MCP server ${server.name} asked Ravi to slow down (HTTP 429) while connecting.`,
        );
      }
    } catch (error) {
      // no-cause: after a stop the transport's error says nothing about the server; otherwise it is rethrown as is.
      phase.connecting = false;
      this.opening.delete(transport);
      try {
        await client.close();
      } catch {
        // no-cause: the connect error below is the outcome.
      }
      try {
        // Awaited in full (a stdio child's group is gone) before the connect's failure settles.
        await closeTransport(transport, this.stopped);
      } catch {
        // no-cause: the connect error below is the outcome.
      }
      // A connect the stop cut short failed because of the stop, not because of the server.
      if (this.stopped) throw stoppedError();
      throw error;
    }
    this.opening.delete(transport);
    const era: McpEra = client.getProtocolEra() === "modern" ? "modern" : "legacy";
    const discover = client.getDiscoverResult();
    const decidedAt =
      prior?.kind === "modern" || prior?.kind === "legacy"
        ? (parseMcpStoredVerdict(server)?.decidedAt ?? this.now())
        : this.now();
    const verdict: McpStoredVerdict =
      era === "modern" && discover
        ? { kind: "modern", discover: JSON.parse(JSON.stringify(discover)) as DiscoverResult, decidedAt }
        : { kind: "legacy", decidedAt };
    return { client, transport, era: verdict.kind, verdict, reusedVerdict: prior !== undefined, holder };
  }

  private async buildTransport(
    server: McpServerRecord,
    secret: McpServerSecret | null,
    phase: ConnectPhase,
  ): Promise<Transport> {
    if (server.transport === "http") {
      if (!secret?.url) {
        throw new McpConnectionError(
          "secret_missing",
          `The full URL of MCP server ${server.name} is missing from the credentials store; register the server again.`,
        );
      }
      let url: URL;
      try {
        url = parseMcpServerUrl(secret.url);
      } catch {
        // no-cause: the parser error is about a URL that may carry a token.
        throw new McpConnectionError("url_mismatch", `The stored URL of MCP server ${server.name} is not valid.`);
      }
      if (mcpDisplayUrl(url) !== server.urlDisplay) {
        throw new McpConnectionError(
          "url_mismatch",
          `The stored URL of MCP server ${server.name} does not match its registration; register the server again.`,
        );
      }
      let authProvider: AuthProvider | OAuthClientProvider | undefined;
      if (server.authKind !== "none") {
        const provider = this.options.authProvider ? await this.options.authProvider(server) : null;
        if (!provider) throw new McpLoginRequired(server.name);
        authProvider = provider;
      }
      return new StreamableHTTPClientTransport(url, {
        ...(authProvider ? { authProvider } : {}),
        onInsufficientScope: "throw",
        redirectPolicy: "same-origin",
        // No reconnect loop: a dropped stream fails the use, and the next use connects again.
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1_000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 1.5,
        },
        fetch: this.rateLimitAwareFetch(server.name, phase),
      });
    }
    if (!server.command) {
      throw new McpConnectionError("spawn_failed", `MCP server ${server.name} has no command.`);
    }
    const env: Record<string, string> = {
      PATH: this.options.childPath ?? process.env.PATH ?? DEFAULT_PATH,
    };
    if (server.envKeys.includes(MCP_DAMAGED_ENV_KEYS)) {
      throw new McpConnectionError(
        "env_missing",
        `The stored env key list of MCP server ${server.name} is damaged; register the server again.`,
      );
    }
    for (const key of server.envKeys) {
      const value = secret?.env?.[key];
      if (typeof value !== "string" || value === "") {
        throw new McpConnectionError(
          "env_missing",
          `The value of ${key} for MCP server ${server.name} is missing from the credentials store.`,
        );
      }
      env[key] = value;
    }
    const cwd = join((this.options.stateDir ?? getRaviStateDir)(), "mcp", "servers", server.name);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return new McpStdioChildTransport({
      command: server.command,
      args: server.args,
      env,
      cwd,
      ...(this.options.closeGraceMs !== undefined ? { closeGraceMs: this.options.closeGraceMs } : {}),
    });
  }
}

/** Close a transport; `shutdown` puts a stdio child on the short kill path of a gateway stop. */
function closeTransport(transport: Transport, shutdown: boolean): Promise<void> {
  return shutdown && transport instanceof McpStdioChildTransport ? transport.terminate() : transport.close();
}

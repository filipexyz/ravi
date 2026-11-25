/**
 * Credentials of registered MCP servers (spec mcp, Credentials And Login).
 *
 * One credential per server, the operator's, kept in the server's secret
 * document in the credentials store (`secrets.ts`): a bearer token for an
 * `auth bearer` row, or the OAuth state for an `auth oauth` row (tokens, the
 * client registration, the authorization server's metadata and the resource
 * the tokens are bound to).
 *
 * - `RaviMcpOAuthProvider` is the SDK `OAuthClientProvider` used by
 *   `ravi mcp login`, in the operator's own CLI process. It keeps everything
 *   in memory; the login writes the result once it has a working token.
 * - `createMcpAuthProvider` is what the daemon's gateway connects with. It
 *   never starts an authorization: a missing login, an expired refresh token
 *   or a refusal throws `McpLoginRequired`, which sets the row's status to
 *   `needs_login`.
 * - A token refresh holds the server's lock file
 *   (`$RAVI_STATE_DIR/mcp/locks/<name>`) and re-reads the secret first, so
 *   two processes that see the same expired token refresh it once.
 *
 * No token, client secret, code or verifier leaves this module in an error
 * text, a log line or a return value meant for display.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  type AuthProvider,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { getRaviStateDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { McpConnectionError, McpLoginRequired, safeMcpErrorText } from "./connections.js";
import { parseMcpServerUrl } from "./names.js";
import { getMcpServer, type McpServerRecord } from "./registry-db.js";
import { type McpOAuthState, type McpServerSecret, readMcpServerSecret, writeMcpServerSecret } from "./secrets.js";

const log = logger.child("mcp:oauth");

/** A token this close to its expiry is refreshed before use. */
export const MCP_TOKEN_REFRESH_SKEW_MS = 60_000;
export const MCP_CREDENTIAL_LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this, or held by a process that no longer exists, is broken. */
export const MCP_CREDENTIAL_LOCK_STALE_MS = 120_000;
/**
 * The longest a token refresh request may take: well under the stale limit,
 * so a refresh ends before another process may break its lock.
 */
export const MCP_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;
const SERVER_NAME = /^[a-z][a-z0-9-]{0,23}$/;
/** The client name sent to an authorization server by dynamic registration. */
export const MCP_OAUTH_CLIENT_NAME = "Ravi";

// ============================================================================
// Lock
// ============================================================================

export interface McpCredentialLockOptions {
  stateDir?: string;
  timeoutMs?: number;
  staleMs?: number;
}

function lockPath(server: string, stateDir?: string): string {
  if (!SERVER_NAME.test(server)) throw new McpConnectionError("connect_failed", "Invalid MCP server name.");
  const directory = join(stateDir ?? getRaviStateDir(), "mcp", "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, server);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // no-cause: EPERM means the process exists under another user; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockSnapshot {
  content: string;
  ino: number;
  dev: number;
  mtimeMs: number;
}

function snapshotLock(path: string): LockSnapshot | null {
  try {
    const before = statSync(path);
    const content = readFileSync(path, "utf8");
    const after = statSync(path);
    // A lock replaced between the two stats is read again on the caller's next round.
    if (before.ino !== after.ino || before.dev !== after.dev) return null;
    return { content, ino: after.ino, dev: after.dev, mtimeMs: after.mtimeMs };
  } catch {
    // no-cause: the lock went away while it was read; the caller simply tries again.
    return null;
  }
}

/** Test seam: runs after a lock was judged stale and before it is taken away. */
let beforeStaleLockRemoval: ((path: string) => void) | null = null;

export function setMcpStaleLockHookForTests(hook: ((path: string) => void) | null): void {
  beforeStaleLockRemoval = hook;
}

/**
 * Remove a lock whose holder is gone or that is older than the stale limit.
 * Returns true when the caller should try to take the lock again (the lock
 * was removed or had gone), false when it is held.
 *
 * Breaking is atomic: the file judged stale is moved aside under a unique
 * name, and only that same file (same inode, same content) is discarded. When
 * two waiters judge the same stale lock and one of them has already replaced
 * it with its own live lock, the other moves that live lock aside, sees it is
 * not the file it judged, and puts it back, so it never takes a live lock away.
 */
export function breakStaleMcpCredentialLock(path: string, staleMs: number): boolean {
  const seen = snapshotLock(path);
  if (!seen) return true;
  const pid = Number.parseInt(seen.content.split(" ")[0] ?? "", 10);
  if (Date.now() - seen.mtimeMs < staleMs && processAlive(pid)) return false;
  beforeStaleLockRemoval?.(path);
  const aside = `${path}.stale-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    // no-cause: another waiter moved or removed it first; try to take the lock again.
    return true;
  }
  let moved: LockSnapshot | null = null;
  try {
    const stat = statSync(aside);
    moved = { content: readFileSync(aside, "utf8"), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
  } catch {
    // no-cause: a file that cannot be compared is put back below, as a live lock would be.
    moved = null;
  }
  if (moved && moved.ino === seen.ino && moved.dev === seen.dev && moved.content === seen.content) {
    try {
      unlinkSync(aside);
    } catch {
      // no-cause: the stale lock is out of the way either way.
    }
    return true;
  }
  // Not the file that was judged stale: someone's live lock. Put it back where it was.
  try {
    linkSync(aside, path);
  } catch {
    // no-cause: a new lock took the path meanwhile; its owner holds it, and the moved lock's owner sees it lost it.
  }
  try {
    unlinkSync(aside);
  } catch {
    // no-cause: nothing else is left to clean up.
  }
  return false;
}

/** A held credential lock, as `withMcpCredentialLock` hands it to its function. */
export interface McpCredentialLockHandle {
  /** Whether this holder still owns the lock (a stale breaker may have taken it away). */
  held(): boolean;
}

/**
 * Run `fn` while holding the credential lock of one server. The lock is a
 * file created exclusively; it is shared by the daemon and the CLI, so a
 * refresh, a login and a logout never interleave.
 */
export async function withMcpCredentialLock<T>(
  server: string,
  fn: (lock: McpCredentialLockHandle) => Promise<T>,
  options: McpCredentialLockOptions = {},
): Promise<T> {
  const path = lockPath(server, options.stateDir);
  const owner = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + (options.timeoutMs ?? MCP_CREDENTIAL_LOCK_TIMEOUT_MS);
  const staleMs = options.staleMs ?? MCP_CREDENTIAL_LOCK_STALE_MS;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, owner);
      break;
    } catch (error) {
      // no-cause: the errno error names a state directory path that stays out of gateway answers; the code alone decides.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new McpConnectionError("connect_failed", `The credential lock of MCP server ${server} is unavailable.`);
      }
      if (breakStaleMcpCredentialLock(path, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new McpConnectionError(
          "timeout",
          `The credentials of MCP server ${server} are locked by another process; try again.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  const held = () => {
    try {
      return readFileSync(path, "utf8") === owner;
    } catch {
      // no-cause: no lock file means this holder no longer owns it.
      return false;
    }
  };
  try {
    return await fn({ held });
  } finally {
    try {
      if (readFileSync(path, "utf8") === owner) unlinkSync(path);
    } catch {
      // no-cause: the lock was broken as stale meanwhile; nothing of ours is left to remove.
    }
  }
}

/**
 * Read, change and write a server's secret document under its credential
 * lock. `mutate` gets the current document (null when none is stored) and
 * returns the next one, or null to leave it as it is.
 */
export async function updateMcpServerSecret(
  server: string,
  mutate: (current: McpServerSecret | null) => McpServerSecret | null | Promise<McpServerSecret | null>,
  options: McpCredentialLockOptions & { scopes?: string[]; rotatedAt?: number | null } = {},
): Promise<McpServerSecret | null> {
  return withMcpCredentialLock(
    server,
    async () => {
      const current = await readMcpServerSecret(server);
      const next = await mutate(current);
      if (!next) return current;
      await writeMcpServerSecret(server, next, {
        ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
        ...(options.rotatedAt !== undefined ? { rotatedAt: options.rotatedAt } : {}),
      });
      return next;
    },
    options,
  );
}

// ============================================================================
// Stored OAuth state
// ============================================================================

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The stored tokens as the SDK types them, or undefined when there is no access token. */
export function storedMcpTokens(
  state: McpOAuthState | undefined,
): (StoredOAuthTokens & { obtained_at?: number }) | undefined {
  const tokens = state?.tokens;
  if (!tokens || !asString(tokens.access_token)) return undefined;
  return tokens as unknown as StoredOAuthTokens & { obtained_at?: number };
}

/** When the stored access token expires (ms), or null when the server gave no lifetime. */
export function mcpTokenExpiresAt(state: McpOAuthState | undefined): number | null {
  const tokens = state?.tokens;
  const obtainedAt = asNumber(tokens?.obtained_at);
  const expiresIn = asNumber(tokens?.expires_in);
  if (obtainedAt === undefined || expiresIn === undefined) return null;
  return obtainedAt + expiresIn * 1000;
}

export function mcpTokenExpiring(state: McpOAuthState | undefined, now: number): boolean {
  const expiresAt = mcpTokenExpiresAt(state);
  return expiresAt !== null && expiresAt - MCP_TOKEN_REFRESH_SKEW_MS <= now;
}

/** The granted scopes, for the credentials inventory. */
export function mcpTokenScopes(state: McpOAuthState | undefined): string[] {
  const scope = asString(state?.tokens?.scope);
  return scope ? scope.split(/\s+/).filter(Boolean) : [];
}

/** Whether a server has a stored login (a bearer token, or an OAuth access token). */
export function mcpSecretHasLogin(server: Pick<McpServerRecord, "authKind">, secret: McpServerSecret | null): boolean {
  if (!secret) return false;
  if (server.authKind === "bearer") return Boolean(secret.bearer);
  if (server.authKind === "oauth") return storedMcpTokens(secret.oauth) !== undefined;
  return false;
}

// ============================================================================
// Revocation (RFC 7009)
// ============================================================================

/** The longest one revocation request may take. */
export const MCP_REVOCATION_TIMEOUT_MS = 5_000;

/**
 * What the authorization server said about a grant Ravi is forgetting:
 * `revoked` (it answered 200 to every token sent), `not_confirmed` (a request
 * failed, timed out or was answered otherwise, or its endpoint broke the
 * login's rules, so nothing was sent), `not_offered` (no tokens, or the
 * server names no revocation endpoint).
 */
export type McpRevocationOutcome = "revoked" | "not_confirmed" | "not_offered";

/** The tokens of a stored OAuth login, refresh token first. */
export function mcpGrantTokens(state: McpOAuthState | undefined): { token: string; hint: string }[] {
  const tokens = state?.tokens;
  const out: { token: string; hint: string }[] = [];
  const refresh = asString(tokens?.refresh_token);
  const access = asString(tokens?.access_token);
  if (refresh) out.push({ token: refresh, hint: "refresh_token" });
  if (access) out.push({ token: access, hint: "access_token" });
  return out;
}

/** The weaker of two outcomes: one unconfirmed request makes the whole unconfirmed. */
export function combineMcpRevocation(a: McpRevocationOutcome, b: McpRevocationOutcome): McpRevocationOutcome {
  if (a === "not_confirmed" || b === "not_confirmed") return "not_confirmed";
  return a === "revoked" || b === "revoked" ? "revoked" : "not_offered";
}

/**
 * Revoke a stored OAuth grant on its authorization server, best effort: the
 * refresh token, then the access token, each POSTed form-encoded with the
 * client id to the `revocation_endpoint` of the stored authorization server
 * metadata. The endpoint must pass the login's own rules (https, plain http
 * only on a loopback host, no userinfo) and share the origin of the
 * authorization server the login used. A short timeout, no redirect
 * followed, nothing read from the answer but its status, and no token in any
 * error or log: a failure is only `not_confirmed`.
 */
export async function revokeMcpOAuthGrant(
  state: McpOAuthState | undefined,
  options: { fetch?: typeof fetch; timeoutMs?: number; only?: ReadonlySet<string> } = {},
): Promise<McpRevocationOutcome> {
  const grant = mcpGrantTokens(state).filter((entry) => !options.only || options.only.has(entry.token));
  if (grant.length === 0) return "not_offered";
  const discovery = state?.discovery ?? {};
  const metadata =
    discovery.authorizationServerMetadata && typeof discovery.authorizationServerMetadata === "object"
      ? (discovery.authorizationServerMetadata as Record<string, unknown>)
      : {};
  const endpointText = asString(metadata.revocation_endpoint);
  if (!endpointText) return "not_offered";
  const clientId = asString((state?.client as Record<string, unknown> | undefined)?.client_id);
  const base = asString(discovery.authorizationServerUrl) ?? asString(metadata.issuer);
  let endpoint: URL;
  let origin: string;
  try {
    endpoint = parseMcpServerUrl(endpointText);
    origin = parseMcpServerUrl(base ?? "").origin;
  } catch {
    // no-cause: the parser error repeats a remote URL; refusing to send is the whole outcome.
    return "not_confirmed";
  }
  if (!clientId || endpoint.username || endpoint.password || endpoint.origin !== origin) return "not_confirmed";
  const run = options.fetch ?? fetch;
  let confirmed = true;
  for (const { token, hint } of grant) {
    try {
      const response = await run(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? MCP_REVOCATION_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {
        // no-cause: the answer's body is never read; its status decides.
      });
      if (response.status !== 200) confirmed = false;
    } catch {
      // no-cause: the request error can quote the endpoint or the form; only "not confirmed" leaves.
      confirmed = false;
    }
  }
  if (!confirmed) log.warn("MCP login revocation not confirmed by the authorization server");
  return confirmed ? "revoked" : "not_confirmed";
}

/** The server's document without any login: what `logout` leaves. */
export function withoutMcpLogin(secret: McpServerSecret): McpServerSecret {
  const next: McpServerSecret = {};
  if (secret.url !== undefined) next.url = secret.url;
  if (secret.env !== undefined) next.env = secret.env;
  return next;
}

// ============================================================================
// Login-time provider (the operator's CLI)
// ============================================================================

export interface RaviMcpOAuthProviderInput {
  server: string;
  /** The loopback redirect URI of this login. */
  redirectUrl: string;
  /** What is already stored (a previous login); its tokens are not reused. */
  stored?: McpOAuthState;
  /** A client id registered by hand with the authorization server. */
  clientId?: string;
  /** A client metadata document URL (setting RAVI_MCP_CLIENT_METADATA_URL). */
  clientMetadataUrl?: string;
  /** Called with the authorization URL the SDK built. */
  onAuthorizationUrl?: (url: URL) => void;
}

/**
 * The SDK's OAuth client provider for one login. State lives in memory until
 * the login finishes; `snapshot()` is what the login stores.
 *
 * A login always runs a full authorization: stored tokens are not offered to
 * the SDK, so it cannot fall back to a refresh. The client registration is
 * reused only when it was made for the same redirect URI and the same kind
 * of client id; otherwise the client registers again.
 */
export class RaviMcpOAuthProvider implements OAuthClientProvider {
  readonly server: string;
  readonly clientMetadataUrl?: string;
  private readonly redirect: string;
  private readonly stateValue = randomBytes(32).toString("base64url");
  private readonly onAuthorizationUrl?: (url: URL) => void;
  private readonly fixedClientId?: string;
  private client: StoredOAuthClientInformation | undefined;
  private clientSource: McpOAuthState["clientSource"];
  private tokenSet: StoredOAuthTokens | undefined;
  private obtainedAt: number | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private resource: string | undefined;
  private authorizationUrlValue: URL | undefined;

  constructor(input: RaviMcpOAuthProviderInput) {
    this.server = input.server;
    this.redirect = input.redirectUrl;
    this.onAuthorizationUrl = input.onAuthorizationUrl;
    if (input.clientMetadataUrl) this.clientMetadataUrl = input.clientMetadataUrl;
    if (input.clientId) {
      this.fixedClientId = input.clientId;
      this.client = { client_id: input.clientId } as StoredOAuthClientInformation;
      this.clientSource = "preregistered";
      return;
    }
    const stored = input.stored;
    const storedClient = stored?.client as StoredOAuthClientInformation | undefined;
    const reusable =
      storedClient &&
      asString((storedClient as { client_id?: unknown }).client_id) &&
      stored?.redirectUrl === input.redirectUrl &&
      ((stored?.clientSource === "dynamic" && !input.clientMetadataUrl) ||
        (stored?.clientSource === "metadata_document" &&
          (storedClient as { client_id?: unknown }).client_id === input.clientMetadataUrl));
    if (reusable) {
      this.client = storedClient;
      this.clientSource = stored?.clientSource;
    }
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: MCP_OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.stateValue;
  }

  /** Whether `value` is this login's state (constant time). */
  matchesState(value: string | null | undefined): boolean {
    if (typeof value !== "string") return false;
    const expected = Buffer.from(this.stateValue);
    const given = Buffer.from(value);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.client;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    const clientId = (clientInformation as { client_id?: unknown }).client_id;
    if (this.fixedClientId && clientId !== this.fixedClientId) {
      throw new McpConnectionError("connect_failed", "The authorization server changed the given client id.");
    }
    this.client = clientInformation;
    if (!this.fixedClientId) {
      this.clientSource =
        this.clientMetadataUrl && clientId === this.clientMetadataUrl ? "metadata_document" : "dynamic";
    }
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.tokenSet;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.tokenSet = tokens;
    this.obtainedAt = Date.now();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrlValue = authorizationUrl;
    this.onAuthorizationUrl?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new McpConnectionError("connect_failed", "No authorization is in progress.");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  saveResourceUrl(resourceUrl: string): void {
    this.resource = resourceUrl;
  }

  resourceUrl(): string | undefined {
    return this.resource;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if ((scope === "all" || scope === "client") && !this.fixedClientId) {
      this.client = undefined;
      this.clientSource = undefined;
    }
    if (scope === "all" || scope === "tokens") {
      this.tokenSet = undefined;
      this.obtainedAt = undefined;
    }
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }

  /** The authorization URL of this login, once the SDK asked for one. */
  get authorizationUrl(): URL | undefined {
    return this.authorizationUrlValue;
  }

  /** How the client id was obtained, once it is known. */
  get registration(): McpOAuthState["clientSource"] {
    return this.clientSource;
  }

  /** What the login stores: everything the daemon needs to use and refresh the tokens. */
  snapshot(): McpOAuthState {
    const state: McpOAuthState = { redirectUrl: this.redirect };
    if (this.tokenSet) {
      state.tokens = {
        ...(this.tokenSet as unknown as Record<string, unknown>),
        obtained_at: this.obtainedAt ?? Date.now(),
      };
    }
    if (this.client) state.client = { ...(this.client as unknown as Record<string, unknown>) };
    if (this.clientSource) state.clientSource = this.clientSource;
    if (this.discovery) {
      // Only what a refresh needs: the resource metadata can be large and is fetched again at the next login.
      const discovery: Record<string, unknown> = { authorizationServerUrl: this.discovery.authorizationServerUrl };
      if (this.discovery.resourceMetadataUrl) discovery.resourceMetadataUrl = this.discovery.resourceMetadataUrl;
      if (this.discovery.authorizationServerMetadata) {
        discovery.authorizationServerMetadata = this.discovery.authorizationServerMetadata;
      }
      state.discovery = discovery;
    }
    if (this.resource) state.resource = this.resource;
    return state;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The fetch a token refresh uses: aborted after `timeoutMs`, so it never outlives its lock. */
function mcpRefreshFetch(base: typeof fetch | undefined, timeoutMs: number): FetchLike {
  const run = (base ?? fetch) as FetchLike;
  return (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return run(url, { ...init, signal });
  };
}

// ============================================================================
// Daemon-side authorization
// ============================================================================

export interface McpAuthProviderOptions {
  readSecret?: (server: string) => Promise<McpServerSecret | null>;
  /** The registry row a refresh checks before it stores (default: the registry). */
  getServer?: (name: string) => McpServerRecord | null;
  /** The longest a token refresh request may take (default 30 s). */
  refreshTimeoutMs?: number;
  /** Where the credential lock lives and how long a refresh waits for it. */
  lock?: McpCredentialLockOptions;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The authorization the gateway connects an http row with, or null when the
 * row has no stored login (it then needs `ravi mcp login`). Rows with auth
 * `none` need none. It never opens a browser or starts an authorization.
 */
export async function createMcpAuthProvider(
  server: McpServerRecord,
  options: McpAuthProviderOptions = {},
): Promise<AuthProvider | null> {
  if (server.authKind === "none") return null;
  const secret = await (options.readSecret ?? readMcpServerSecret)(server.name);
  if (server.authKind === "bearer") {
    const token = secret?.bearer;
    if (!token) return null;
    return {
      token: async () => token,
      onUnauthorized: async () => {
        throw new McpLoginRequired(server.name);
      },
    };
  }
  // oauth, and any stored kind that is not known: only a stored OAuth login is used.
  if (!storedMcpTokens(secret?.oauth)) return null;
  return new McpOAuthSession(server.name, secret?.oauth ?? {}, options);
}

/**
 * The daemon's use of one server's OAuth login. `token()` answers from
 * memory and refreshes first when the token is about to expire; a 401 makes
 * it refresh once. Every refresh goes through the lock and re-reads the
 * stored login, so a token another process already refreshed is taken as it
 * is. Anything the daemon cannot fix alone throws `McpLoginRequired`.
 */
export class McpOAuthSession implements AuthProvider {
  private state: McpOAuthState;
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly server: string,
    state: McpOAuthState,
    private readonly options: McpAuthProviderOptions = {},
  ) {
    this.state = state;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private accessToken(): string | undefined {
    return storedMcpTokens(this.state)?.access_token;
  }

  async token(): Promise<string | undefined> {
    if (mcpTokenExpiring(this.state, this.now())) {
      if (storedMcpTokens(this.state)?.refresh_token) await this.refresh(this.accessToken());
      else throw new McpLoginRequired(this.server);
    }
    return this.accessToken();
  }

  async onUnauthorized(): Promise<void> {
    await this.refresh(this.accessToken());
  }

  /** Refresh unless the token that failed was already replaced. One refresh at a time per session. */
  refresh(failedToken: string | undefined): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshLocked(failedToken).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshLocked(failedToken: string | undefined): Promise<void> {
    const readSecret = this.options.readSecret ?? readMcpServerSecret;
    await withMcpCredentialLock(
      this.server,
      async (lock) => {
        const current = await readSecret(this.server);
        const stored = current?.oauth;
        const tokens = storedMcpTokens(stored);
        if (!current || !stored || !tokens) throw new McpLoginRequired(this.server);
        if (tokens.access_token !== failedToken && !mcpTokenExpiring(stored, this.now())) {
          // Another process (or a new login) already replaced the token.
          this.state = stored;
          return;
        }
        const discovery = stored.discovery ?? {};
        const authorizationServerUrl = asString(discovery.authorizationServerUrl);
        const client = stored.client as OAuthClientInformationMixed | undefined;
        if (!tokens.refresh_token || !authorizationServerUrl || !client?.client_id) {
          throw new McpLoginRequired(this.server);
        }
        let fresh: Awaited<ReturnType<typeof refreshAuthorization>>;
        try {
          fresh = await refreshAuthorization(authorizationServerUrl, {
            metadata: discovery.authorizationServerMetadata as AuthorizationServerMetadata | undefined,
            clientInformation: client,
            refreshToken: tokens.refresh_token,
            ...(stored.resource ? { resource: stored.resource } : {}),
            fetchFn: mcpRefreshFetch(this.options.fetch, this.options.refreshTimeoutMs ?? MCP_TOKEN_REFRESH_TIMEOUT_MS),
          });
        } catch (error) {
          // no-cause: the refresh error can quote the token answer, so only the OAuth code or sanitized text leaves this process.
          if (error instanceof OAuthError && error.code !== OAuthErrorCode.ServerError) {
            // invalid_grant, invalid_client and the like: only a new login fixes it.
            log.warn("MCP token refresh refused; a new login is needed", { server: this.server, code: error.code });
            throw new McpLoginRequired(this.server);
          }
          throw new McpConnectionError(
            "connect_failed",
            `The token refresh of MCP server ${this.server} failed: ${safeMcpErrorText(error, [tokens.refresh_token, tokens.access_token])}`,
          );
        }
        const next: McpOAuthState = {
          ...stored,
          tokens: {
            ...(fresh as unknown as Record<string, unknown>),
            ...(asString(tokens.issuer) ? { issuer: tokens.issuer } : {}),
            obtained_at: this.now(),
          },
        };
        // The refresh took a network round trip. Its result is stored only when nothing moved meanwhile:
        // the row is still registered as an OAuth row, this process still holds the lock (a stale breaker
        // may have taken it), and the stored document is still the one this refresh read. Otherwise a
        // removal, a logout or a new login stands, and the refreshed tokens are dropped.
        const row = (this.options.getServer ?? getMcpServer)(this.server);
        if (!row || row.authKind !== "oauth") {
          throw new McpConnectionError(
            "closed",
            `MCP server ${this.server} was removed or changed during the token refresh; nothing was stored.`,
          );
        }
        const reread = lock.held() ? await readSecret(this.server) : null;
        if (!lock.held() || !reread || stableJson(reread) !== stableJson(current)) {
          throw new McpConnectionError(
            "connect_failed",
            `The login of MCP server ${this.server} changed during the token refresh; the refresh was not stored.`,
          );
        }
        await writeMcpServerSecret(
          this.server,
          { ...current, oauth: next },
          { scopes: mcpTokenScopes(next), rotatedAt: this.now() },
        );
        this.state = next;
        log.info("MCP token refreshed", { server: this.server });
      },
      this.options.lock,
    );
  }
}

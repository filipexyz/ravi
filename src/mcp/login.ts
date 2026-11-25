/**
 * `ravi mcp login` and `ravi mcp logout` (spec mcp, Credentials And Login).
 *
 * The login runs in the operator's own CLI process, the only MCP connection
 * made outside the daemon:
 *
 * - `auth oauth`: the OAuth code flow with PKCE. The SDK discovers the
 *   protected resource and its authorization server on the first 401,
 *   registers the client (dynamic registration, a client metadata document
 *   when RAVI_MCP_CLIENT_METADATA_URL is set, or `--client-id`) and builds the
 *   authorization URL. Ravi prints it on the operator's terminal (and opens
 *   the browser unless `--paste`), receives the redirect on a fixed loopback URI (or the pasted
 *   redirect URL), checks the state, lets the SDK check the issuer and
 *   exchange the code, and connects again with the new token.
 * - `auth bearer`: a token read from stdin, kept only when the server accepts
 *   it.
 *
 * Nothing is stored until a fresh connection with the new credential has
 * listed the server's tools. Then the login is written under the server's
 * credential lock, the row's status goes back to `unknown`, and the
 * credential revision moves, which tells the daemon to reconnect and refresh.
 * `logout` forgets the stored login at once.
 *
 * The authorization URL holds the server's secret address (a Ravi Console
 * bridge URL carries its token in the query and in `resource=`), so it is
 * printed only when stderr is a terminal, never into `--json` output, a log,
 * a trace or an error text.
 *
 * Revocation (RFC 7009): a logout, and a login that replaces a stored OAuth
 * grant, revoke that grant on its authorization server, best effort
 * (`revokeMcpOAuthGrant`); a failed revocation never blocks either, and the
 * result says whether the server confirmed.
 */

import { spawn } from "node:child_process";

import { serve } from "bun";

import {
  type AuthProvider,
  AuthorizationServerMismatchError,
  Client,
  IssuerMismatchError,
  OAuthError,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import {
  checkMcpBearerToken,
  MCP_LOGIN_CALLBACK_PATH,
  MCP_LOGIN_DEFAULT_PORT,
  MCP_LOGIN_TIMEOUT_MS,
  McpLoginError,
  mcpLoginCommand,
  mcpLoginMethod,
  mcpLoginRedirectUrl,
} from "./login-options.js";
import {
  classifyMcpFailure,
  McpConnectionError,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  MCP_CLIENT_INFO,
  mcpNegotiationMode,
  safeMcpErrorText,
} from "./connections.js";
import { mcpDisplayUrl, parseMcpServerUrl } from "./names.js";
import {
  combineMcpRevocation,
  type McpCredentialLockOptions,
  type McpRevocationOutcome,
  mcpGrantTokens,
  mcpTokenExpiresAt,
  mcpTokenScopes,
  RaviMcpOAuthProvider,
  revokeMcpOAuthGrant,
  updateMcpServerSecret,
  withoutMcpLogin,
} from "./oauth-provider.js";
import {
  bumpMcpCredentialRev,
  getMcpServer,
  type McpEra,
  type McpServerRecord,
  recordMcpServerProbe,
} from "./registry-db.js";
import { type McpOAuthState, type McpServerSecret, readMcpServerSecret } from "./secrets.js";

export { checkMcpBearerToken, McpLoginError, type McpLoginErrorCode } from "./login-options.js";

const LIST_TIMEOUT_MS = 30_000;

export interface McpLoginDeps {
  readSecret?: (server: string) => Promise<McpServerSecret | null>;
  fetch?: typeof fetch;
  /** Show a line to the operator (default: stderr). */
  prompt?: (line: string) => void;
  /** Open the authorization URL in a browser (default: the platform opener; failures are ignored). */
  openBrowser?: (url: string) => void;
  /** `--paste`: read the redirect URL the browser ended on. */
  readPastedUrl?: () => Promise<string>;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  lock?: McpCredentialLockOptions;
  now?: () => number;
  /**
   * Print the authorization URL (default: only when stderr is a terminal). The
   * URL holds the server's secret address, so it never goes to a pipe, a file
   * or a captured transcript; without it `--paste` cannot run.
   */
  showAuthorizationUrl?: boolean;
  /** The longest one revocation request may take (default 5 s). */
  revocationTimeoutMs?: number;
}

export interface McpLoginInput {
  server: McpServerRecord;
  /** oauth: a client id registered by hand. */
  clientId?: string;
  /** oauth: the loopback port (default MCP_LOGIN_DEFAULT_PORT). */
  port?: number;
  /** oauth: read the redirect URL instead of listening on the loopback port. */
  paste?: boolean;
  /** bearer: the token, already read from stdin. */
  bearerToken?: string;
  /** oauth: a client metadata document URL (from the setting). */
  clientMetadataUrl?: string;
}

export interface McpLoginResult {
  server: string;
  authKind: "bearer" | "oauth";
  registration: "dynamic" | "metadata_document" | "preregistered" | null;
  era: McpEra;
  toolCount: number;
  scopes: string[];
  expiresAt: number | null;
  /** The OAuth grant this login replaced, revoked on the server or not; null when none was stored. */
  previousGrant: McpRevocationOutcome | null;
}

function defaultPrompt(line: string): void {
  process.stderr.write(`${line}\n`);
}

function defaultOpenBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
  if (!opener) return;
  try {
    // An argument list, never a shell: the URL is not interpreted.
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      // no-cause: no opener on this host; the URL is printed for the operator.
    });
    child.unref();
  } catch {
    // no-cause: the URL is printed; opening a browser is only a convenience.
  }
}

/** The full URL of an http row, checked against its registration. */
async function serverUrl(server: McpServerRecord, deps: McpLoginDeps): Promise<{ url: URL; secret: McpServerSecret }> {
  let secret: McpServerSecret | null;
  try {
    secret = await (deps.readSecret ?? readMcpServerSecret)(server.name);
  } catch {
    // no-cause: the secrets error may name storage details; the fixed text below applies.
    throw new McpLoginError("secret_missing", `The stored URL of MCP server ${server.name} cannot be read.`);
  }
  if (!secret?.url) {
    throw new McpLoginError(
      "secret_missing",
      `The full URL of MCP server ${server.name} is missing from the credentials store; register the server again.`,
    );
  }
  let url: URL;
  try {
    url = parseMcpServerUrl(secret.url);
  } catch {
    // no-cause: the parser error is about a URL that may carry a token.
    throw new McpLoginError("secret_missing", `The stored URL of MCP server ${server.name} is not valid.`);
  }
  if (mcpDisplayUrl(url) !== server.urlDisplay) {
    throw new McpLoginError(
      "secret_missing",
      `The stored URL of MCP server ${server.name} does not match its registration; register the server again.`,
    );
  }
  return { url, secret };
}

function newClient(server: McpServerRecord): Client {
  const client = new Client(MCP_CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: { mode: mcpNegotiationMode(server.protocol) },
    inputRequired: { autoFulfill: false },
  });
  client.onerror = () => {
    // no-cause: transport noise is not printed; its text may hold what the server sent.
  };
  return client;
}

function newTransport(url: URL, authProvider: AuthProvider | RaviMcpOAuthProvider, deps: McpLoginDeps) {
  return new StreamableHTTPClientTransport(url, {
    authProvider,
    onInsufficientScope: "throw",
    redirectPolicy: "same-origin",
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

async function closeQuietly(client: Client | null, transport: Transport | null): Promise<void> {
  try {
    await client?.close();
  } catch {
    // no-cause: closing after a login leaves nothing to report.
  }
  try {
    await transport?.close();
  } catch {
    // no-cause: the transport is already closed.
  }
}

/** Connect with the new credential and list the tools: the proof that it works. */
async function verifyConnection(
  server: McpServerRecord,
  url: URL,
  authProvider: AuthProvider | RaviMcpOAuthProvider,
  deps: McpLoginDeps,
  secrets: string[],
): Promise<{ era: McpEra; toolCount: number }> {
  const client = newClient(server);
  const transport = newTransport(url, authProvider, deps);
  try {
    await client.connect(transport, { timeout: deps.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS, cacheMode: "bypass" });
    return {
      era: client.getProtocolEra() === "modern" ? "modern" : "legacy",
      toolCount: Array.isArray(listed.tools) ? listed.tools.length : 0,
    };
  } catch (error) {
    // no-cause: the transport error can quote the new credential, so only the sanitized text reaches the operator.
    const kind = classifyMcpFailure(error, server);
    if (kind === "needs_login" || kind === "refused") {
      throw new McpLoginError("token_refused", `MCP server ${server.name} refused the new credential.`);
    }
    throw new McpLoginError(
      "login_failed",
      `Connecting to MCP server ${server.name} with the new credential failed: ${safeMcpErrorText(error, secrets)}`,
    );
  } finally {
    await closeQuietly(client, transport);
  }
}

interface CallbackListener {
  wait(): Promise<URLSearchParams>;
  stop(): void;
}

/**
 * The loopback listener of an OAuth login: 127.0.0.1 only, one path, and only
 * a redirect that carries this login's state counts. Anything else is
 * answered and ignored, so a stray request cannot end the login.
 */
function listenForCallback(port: number, provider: RaviMcpOAuthProvider): CallbackListener {
  let resolveParams: (params: URLSearchParams) => void = () => {};
  const received = new Promise<URLSearchParams>((resolve) => {
    resolveParams = resolve;
  });
  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const url = new URL(request.url);
        const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
        if (request.method !== "GET" || url.pathname !== MCP_LOGIN_CALLBACK_PATH) {
          return new Response("Not found.", { status: 404, headers });
        }
        if (!provider.matchesState(url.searchParams.get("state"))) {
          return new Response("This sign-in answer does not belong to the running Ravi login.", {
            status: 400,
            headers,
          });
        }
        resolveParams(url.searchParams);
        return new Response("Ravi received the sign-in answer. You can close this tab.", { status: 200, headers });
      },
    });
  } catch {
    // no-cause: Bun's error names the address only; the fixed text points at --port.
    throw new McpLoginError(
      "port_unavailable",
      `The login port ${port} on 127.0.0.1 is not available; pick another with --port, or use --paste.`,
    );
  }
  return {
    wait: () => received,
    stop: () => server.stop(true),
  };
}

/** The `--paste` answer: the redirect URL, which must be this login's redirect URI. */
function parsePastedRedirect(text: string, redirectUrl: string): URLSearchParams {
  const line = text.trim().split(/\s+/)[0] ?? "";
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    // no-cause: the pasted text may hold the code; it is never repeated.
    throw new McpLoginError("invalid_callback", "The pasted text is not the redirect URL the browser ended on.");
  }
  const expected = new URL(redirectUrl);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new McpLoginError(
      "invalid_callback",
      `The pasted URL is not this login's redirect (${expected.origin}${expected.pathname}).`,
    );
  }
  return url.searchParams;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new McpLoginError("timeout", "The sign-in was not completed in time; run the login again.")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

async function oauthLogin(input: McpLoginInput, deps: McpLoginDeps): Promise<McpLoginResult> {
  const { server } = input;
  const { url, secret } = await serverUrl(server, deps);
  const prompt = deps.prompt ?? defaultPrompt;
  const showUrl = deps.showAuthorizationUrl ?? process.stderr.isTTY === true;
  if (input.paste && !showUrl) {
    throw new McpLoginError(
      "invalid_option",
      "--paste needs a terminal: the authorization URL holds the server's secret address and is shown only on a terminal.",
    );
  }
  const port = input.port ?? MCP_LOGIN_DEFAULT_PORT;
  const redirectUrl = mcpLoginRedirectUrl(port);
  const provider = new RaviMcpOAuthProvider({
    server: server.name,
    redirectUrl,
    ...(secret.oauth ? { stored: secret.oauth } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientMetadataUrl ? { clientMetadataUrl: input.clientMetadataUrl } : {}),
  });
  const listener = input.paste ? null : listenForCallback(port, provider);
  const client = newClient(server);
  const transport = newTransport(url, provider, deps);
  const secrets = [secret.url ?? ""];
  try {
    try {
      await client.connect(transport, { timeout: deps.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS });
      throw new McpLoginError(
        "no_authorization_requested",
        `MCP server ${server.name} accepted the connection without a login; register it with --auth none instead.`,
      );
    } catch (error) {
      if (error instanceof McpLoginError) throw error;
      if (!(UnauthorizedError.isInstance(error) && provider.authorizationUrl)) {
        throw new McpLoginError(
          "login_failed",
          `MCP server ${server.name} did not start an authorization: ${safeMcpErrorText(error, secrets)}`,
        );
      }
    }
    // The URL comes from the authorization server's metadata, which the remote side controls: only an
    // https URL (plain http on a loopback host) is shown or opened, never file:, smb: or a custom handler.
    let authorizationUrl: URL;
    try {
      authorizationUrl = parseMcpServerUrl((provider.authorizationUrl as URL).toString());
    } catch {
      // no-cause: the parser error is about a remote URL; the fixed text below is all that is shown.
      throw new McpLoginError(
        "login_failed",
        `The authorization server of MCP server ${server.name} named an authorization URL that is not https (plain http only on a loopback host); nothing was opened or stored.`,
      );
    }
    prompt(`Sign in to MCP server ${server.name}.`);
    prompt(`Authorization server: ${authorizationUrl.host}`);
    if (showUrl) {
      prompt(
        "Open this URL in a browser. It holds the server's secret address: do not paste it into a chat or a ticket.",
      );
      prompt(authorizationUrl.toString());
    } else {
      prompt(
        "The authorization URL holds the server's secret address, so it is shown only on a terminal; Ravi opens it in the browser.",
      );
    }
    let params: URLSearchParams;
    if (input.paste) {
      prompt("Then paste the full URL the browser ended on (it starts with this login's redirect):");
      prompt(redirectUrl);
      if (!deps.readPastedUrl) {
        throw new McpLoginError("invalid_option", "--paste needs a terminal to read the redirect URL from.");
      }
      params = parsePastedRedirect(
        await withTimeout(deps.readPastedUrl(), deps.timeoutMs ?? MCP_LOGIN_TIMEOUT_MS),
        redirectUrl,
      );
    } else {
      (deps.openBrowser ?? defaultOpenBrowser)(authorizationUrl.toString());
      prompt(`Waiting for the browser on ${redirectUrl} …`);
      params = await withTimeout((listener as CallbackListener).wait(), deps.timeoutMs ?? MCP_LOGIN_TIMEOUT_MS);
    }
    if (!provider.matchesState(params.get("state"))) {
      throw new McpLoginError(
        "state_mismatch",
        "The sign-in answer does not carry this login's state; nothing was stored.",
      );
    }
    const denied = params.get("error");
    if (denied) {
      const code = OAUTH_ERROR_CODE.test(denied) ? denied : "error";
      throw new McpLoginError("authorization_denied", `The authorization server answered ${code}; nothing was stored.`);
    }
    try {
      await transport.finishAuth(params);
    } catch (error) {
      // no-cause: the SDK error can quote the authorization code or token answer, so only the sanitized text or OAuth code is kept.
      if (error instanceof IssuerMismatchError || error instanceof AuthorizationServerMismatchError) {
        throw new McpLoginError(
          "issuer_mismatch",
          "The sign-in answer came from another authorization server than the one this login asked; nothing was stored.",
        );
      }
      const detail =
        error instanceof OAuthError && OAUTH_ERROR_CODE.test(error.code)
          ? error.code
          : safeMcpErrorText(error, secrets);
      throw new McpLoginError("login_failed", `The authorization code could not be exchanged: ${detail}`);
    }
    const state = provider.snapshot();
    const access = typeof state.tokens?.access_token === "string" ? state.tokens.access_token : "";
    const refresh = typeof state.tokens?.refresh_token === "string" ? state.tokens.refresh_token : "";
    const verified = await verifyConnection(server, url, provider, deps, [...secrets, access, refresh]);
    const replaced = await storeLogin(server, secret, { oauth: state }, deps, mcpTokenScopes(state));
    // The grant this login replaced is revoked on its server, best effort, once the new one is stored.
    const fresh = new Set(mcpGrantTokens(state).map((entry) => entry.token));
    const previous = mcpGrantTokens(replaced).filter((entry) => !fresh.has(entry.token));
    const previousGrant =
      previous.length === 0
        ? null
        : await revokeMcpOAuthGrant(replaced, {
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            ...(deps.revocationTimeoutMs !== undefined ? { timeoutMs: deps.revocationTimeoutMs } : {}),
            only: new Set(previous.map((entry) => entry.token)),
          });
    return {
      server: server.name,
      authKind: "oauth",
      registration: state.clientSource ?? null,
      era: verified.era,
      toolCount: verified.toolCount,
      scopes: mcpTokenScopes(state),
      expiresAt: mcpTokenExpiresAt(state),
      previousGrant,
    };
  } finally {
    listener?.stop();
    await closeQuietly(client, transport);
  }
}

async function bearerLogin(input: McpLoginInput, deps: McpLoginDeps): Promise<McpLoginResult> {
  const { server } = input;
  const { url, secret } = await serverUrl(server, deps);
  const token = checkMcpBearerToken(input.bearerToken ?? "");
  const verified = await verifyConnection(server, url, { token: async () => token }, deps, [secret.url ?? "", token]);
  await storeLogin(server, secret, { bearer: token }, deps, []);
  return {
    server: server.name,
    authKind: "bearer",
    registration: null,
    era: verified.era,
    toolCount: verified.toolCount,
    scopes: [],
    expiresAt: null,
    previousGrant: null,
  };
}

/**
 * Write the login under the credential lock, unless the registration changed
 * while the operator signed in. Then clear `needs_login` and move the
 * credential revision (the daemon's cue to reconnect and refresh). Returns
 * the OAuth grant the new login replaced (to revoke), if one was stored.
 */
async function storeLogin(
  server: McpServerRecord,
  before: McpServerSecret,
  login: { bearer?: string; oauth?: McpOAuthState },
  deps: McpLoginDeps,
  scopes: string[],
): Promise<McpOAuthState | undefined> {
  let replaced: McpOAuthState | undefined;
  const changed = () =>
    new McpLoginError(
      "registration_changed",
      `MCP server ${server.name} was changed or removed during the login; nothing was stored. Run the login again.`,
    );
  const now = (deps.now ?? Date.now)();
  await updateMcpServerSecret(
    server.name,
    (current) => {
      const row = getMcpServer(server.name);
      if (!current || current.url !== before.url || !row || row.authKind !== server.authKind) throw changed();
      replaced = current.oauth;
      return { ...withoutMcpLogin(current), ...login };
    },
    { ...deps.lock, scopes, rotatedAt: now },
  );
  markLoginChanged(server.name, { status: "unknown", detail: null });
  return replaced;
}

/** Status first, then the revision: an in-flight daemon refresh of the old revision cannot overwrite it. */
function markLoginChanged(name: string, status: { status: "unknown" | "needs_login"; detail: string | null }): void {
  recordMcpServerProbe(name, { status: status.status, statusDetail: status.detail });
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = getMcpServer(name);
    if (!row) return;
    if (bumpMcpCredentialRev(name, row.credentialRev) !== null) return;
  }
}

/** Connection errors are built without secrets (a held lock, a refused connect); they leave as login errors. */
function asLoginError(error: unknown): unknown {
  if (error instanceof McpConnectionError) return new McpLoginError("login_failed", error.message);
  return error;
}

/** Run a login for one registered http server. */
export async function runMcpLogin(input: McpLoginInput, deps: McpLoginDeps = {}): Promise<McpLoginResult> {
  try {
    return await loginOnce(input, deps);
  } catch (error) {
    throw asLoginError(error);
  }
}

async function loginOnce(input: McpLoginInput, deps: McpLoginDeps): Promise<McpLoginResult> {
  const { server } = input;
  if (server.transport !== "http") {
    throw new McpLoginError("not_http", `MCP server ${server.name} is a stdio server; it has no login.`);
  }
  const method = mcpLoginMethod(server.authKind);
  if (!method) {
    throw new McpLoginError(
      "no_login_needed",
      `MCP server ${server.name} is registered with auth none; it needs no login.`,
    );
  }
  if (method === "bearer") {
    if (input.bearerToken === undefined) {
      throw new McpLoginError(
        "invalid_option",
        `MCP server ${server.name} reads its token from stdin: pass --token-stdin.`,
      );
    }
    if (input.clientId || input.paste || input.port !== undefined) {
      throw new McpLoginError("invalid_option", "--client-id, --port and --paste are for OAuth servers only.");
    }
    return bearerLogin(input, deps);
  }
  if (input.bearerToken !== undefined) {
    throw new McpLoginError(
      "invalid_option",
      `MCP server ${server.name} uses OAuth: sign in through the browser instead of --token-stdin.`,
    );
  }
  return oauthLogin(input, deps);
}

export interface McpLogoutResult {
  server: string;
  /** A stored login was forgotten. */
  removed: boolean;
  /** Whether the authorization server confirmed it revoked the forgotten OAuth grant. */
  revocation: McpRevocationOutcome;
}

/**
 * Forget the stored login of a server (bearer token or OAuth state; the URL
 * and env values stay). A row that needs a login is marked `needs_login`.
 * An OAuth grant is revoked on its authorization server first, best effort
 * (RFC 7009): a revocation that fails or times out does not block the logout.
 * Should the daemon have refreshed the tokens meanwhile, the ones actually
 * forgotten are revoked too.
 */
export async function runMcpLogout(
  server: McpServerRecord,
  deps: Pick<McpLoginDeps, "lock" | "now" | "fetch" | "readSecret" | "revocationTimeoutMs"> = {},
): Promise<McpLogoutResult> {
  const revokeOptions = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.revocationTimeoutMs !== undefined ? { timeoutMs: deps.revocationTimeoutMs } : {}),
  };
  let revocation: McpRevocationOutcome = "not_offered";
  const revoked = new Set<string>();
  let before: McpServerSecret | null = null;
  try {
    before = await (deps.readSecret ?? readMcpServerSecret)(server.name);
  } catch {
    // no-cause: an unreadable document is forgotten below all the same; there is nothing to revoke first.
    before = null;
  }
  if (before?.oauth) {
    revocation = await revokeMcpOAuthGrant(before.oauth, revokeOptions);
    for (const entry of mcpGrantTokens(before.oauth)) revoked.add(entry.token);
  }
  let removed = false;
  let forgotten: McpOAuthState | undefined;
  try {
    await updateMcpServerSecret(
      server.name,
      (current) => {
        if (!current || (current.bearer === undefined && current.oauth === undefined)) return null;
        removed = true;
        forgotten = current.oauth;
        return withoutMcpLogin(current);
      },
      { ...deps.lock, scopes: [], rotatedAt: (deps.now ?? Date.now)() },
    );
  } catch (error) {
    throw asLoginError(error);
  }
  const unrevoked = mcpGrantTokens(forgotten).filter((entry) => !revoked.has(entry.token));
  if (unrevoked.length > 0) {
    revocation = combineMcpRevocation(
      revocation,
      await revokeMcpOAuthGrant(forgotten, { ...revokeOptions, only: new Set(unrevoked.map((entry) => entry.token)) }),
    );
  }
  if (removed && server.authKind !== "none") {
    markLoginChanged(server.name, {
      status: "needs_login",
      detail: `run ${mcpLoginCommand(server.name, server.authKind)}`,
    });
  }
  return { server: server.name, removed, revocation };
}

/**
 * The secrets of a registered MCP server (spec mcp, Secrets And Display Forms).
 *
 * Each server has one entry in the credentials store: provider `mcp`,
 * connection `<server name>`. The entry holds one JSON document with the full
 * server URL (http) and the values of the declared environment keys (stdio);
 * later fields (tokens, client information) join the same document. `ravi.db`
 * never holds any of it: the registry keeps only the display form of the URL
 * and the names of the environment keys. The login (`ravi mcp login`, see
 * `oauth-provider.ts`) adds the bearer token or the OAuth state to the same
 * document; it is rewritten only under the server's credential lock.
 *
 * Errors raised here never repeat a secret value, a URL or a secret reference.
 */

import {
  deleteSecret,
  getCredentialConnection,
  readSecret,
  removeCredentialConnection,
  upsertCredentialConnection,
  writeSecret,
} from "../credentials/index.js";

export const MCP_CREDENTIAL_PROVIDER = "mcp";
/** The file backend's limit on one secret; the document must fit in it. */
export const MCP_SECRET_MAX_BYTES = 64 * 1024;

/**
 * The OAuth state of one server: what the SDK hands the provider during a
 * login, kept so the daemon can refresh without the operator. Plain JSON,
 * read back through `oauth-provider.ts`.
 */
export interface McpOAuthState {
  /** The token response (access and refresh token, expiry, scope, issuer) plus `obtained_at` (ms). */
  tokens?: Record<string, unknown>;
  /** The client registration (`client_id`, issuer stamp, and what dynamic registration returned). */
  client?: Record<string, unknown>;
  /** How the client id was obtained. */
  clientSource?: "dynamic" | "metadata_document" | "preregistered";
  /** The redirect URI the client was registered with. */
  redirectUrl?: string;
  /** The authorization server's URL and metadata, from discovery. */
  discovery?: Record<string, unknown>;
  /** The RFC 8707 resource the tokens are bound to. */
  resource?: string;
}

export interface McpServerSecret {
  /** http: the full server URL, which may carry a token. */
  url?: string;
  /** stdio: the value of each declared environment key. */
  env?: Record<string, string>;
  /** http, auth `bearer`: the token given to `ravi mcp login --token-stdin`. */
  bearer?: string;
  /** http, auth `oauth`: the login's tokens and client registration. */
  oauth?: McpOAuthState;
}

/** Metadata for the credentials inventory (never a value). */
export interface McpSecretMetadata {
  /** Scopes the login granted. */
  scopes?: string[];
  /** When a new login or token was written. */
  rotatedAt?: number | null;
}

export class McpSecretError extends Error {
  readonly code: "secret_too_large" | "secret_unavailable" | "secret_invalid";
  constructor(code: McpSecretError["code"], message: string) {
    super(message);
    this.name = "McpSecretError";
    this.code = code;
  }
}

function encode(secret: McpServerSecret): string {
  const document: Record<string, unknown> = { version: 1 };
  if (secret.url !== undefined) document.url = secret.url;
  if (secret.env !== undefined) {
    document.env = Object.fromEntries(Object.entries(secret.env).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (secret.bearer !== undefined) document.bearer = secret.bearer;
  if (secret.oauth !== undefined) document.oauth = secret.oauth;
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text, "utf8") > MCP_SECRET_MAX_BYTES) {
    throw new McpSecretError("secret_too_large", "The MCP server secrets are larger than 64 KB.");
  }
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decode(text: string): McpServerSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // no-cause: the parser error can quote the stored secret, so it is not chained.
    throw new McpSecretError("secret_invalid", "The stored MCP server secret is not valid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpSecretError("secret_invalid", "The stored MCP server secret is not valid.");
  }
  const document = parsed as Record<string, unknown>;
  const secret: McpServerSecret = {};
  if (typeof document.url === "string") secret.url = document.url;
  if (document.env && typeof document.env === "object" && !Array.isArray(document.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(document.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
    secret.env = env;
  }
  if (typeof document.bearer === "string" && document.bearer) secret.bearer = document.bearer;
  if (isPlainObject(document.oauth)) {
    const raw = document.oauth;
    const oauth: McpOAuthState = {};
    if (isPlainObject(raw.tokens)) oauth.tokens = raw.tokens;
    if (isPlainObject(raw.client)) oauth.client = raw.client;
    if (
      raw.clientSource === "dynamic" ||
      raw.clientSource === "metadata_document" ||
      raw.clientSource === "preregistered"
    ) {
      oauth.clientSource = raw.clientSource;
    }
    if (typeof raw.redirectUrl === "string") oauth.redirectUrl = raw.redirectUrl;
    if (isPlainObject(raw.discovery)) oauth.discovery = raw.discovery;
    if (typeof raw.resource === "string") oauth.resource = raw.resource;
    secret.oauth = oauth;
  }
  return secret;
}

/** Write (or replace) a server's secret document and its credentials-store entry. */
export async function writeMcpServerSecret(
  server: string,
  secret: McpServerSecret,
  metadata: McpSecretMetadata = {},
): Promise<void> {
  const text = encode(secret);
  const secretRef = await writeSecret({
    backend: "file",
    provider: MCP_CREDENTIAL_PROVIDER,
    connection: server,
    secret: text,
  });
  upsertCredentialConnection({
    provider: MCP_CREDENTIAL_PROVIDER,
    connection: server,
    label: `MCP server ${server}`,
    backend: "file",
    secretRef,
    status: "active",
    purpose: "MCP server URL, environment values and login",
    ...(metadata.scopes !== undefined ? { scopes: metadata.scopes } : {}),
    ...(metadata.rotatedAt !== undefined ? { rotatedAt: metadata.rotatedAt } : {}),
  });
}

/** Whether the credentials store holds an entry for the server (never reads the value). */
export function hasMcpServerSecret(server: string): boolean {
  return getCredentialConnection(MCP_CREDENTIAL_PROVIDER, server) !== null;
}

/** Read a server's secret document, or null when none is stored. */
export async function readMcpServerSecret(server: string): Promise<McpServerSecret | null> {
  const connection = getCredentialConnection(MCP_CREDENTIAL_PROVIDER, server);
  if (!connection) return null;
  let text: string;
  try {
    text = await readSecret(connection.secretRef);
  } catch {
    // no-cause: backend errors can name storage paths; only the fixed message leaves.
    throw new McpSecretError("secret_unavailable", `The secret of MCP server "${server}" is unavailable.`);
  }
  return decode(text);
}

/**
 * Delete a server's secret and its credentials-store entry. Returns true when
 * an entry existed. The entry is removed even when the backend value was
 * already gone.
 */
export async function deleteMcpServerSecret(server: string): Promise<boolean> {
  const connection = getCredentialConnection(MCP_CREDENTIAL_PROVIDER, server);
  if (!connection) return false;
  try {
    await deleteSecret(connection.secretRef);
  } catch {
    // no-cause: backend errors can name storage paths; only the fixed message leaves.
    throw new McpSecretError("secret_unavailable", `The secret of MCP server "${server}" could not be deleted.`);
  }
  removeCredentialConnection(MCP_CREDENTIAL_PROVIDER, server);
  return true;
}

/**
 * The options of `ravi mcp login` that the CLI needs before it signs in
 * (spec mcp, Credentials And Login). Kept apart from `login.ts` so the CLI
 * loads the MCP client only when a login actually runs.
 */

import type { McpAuthKind } from "./registry-db.js";

/**
 * The exact command that signs in to a server, as every hint names it.
 * `ravi mcp login` is braked, so the command carries `--execute`; a bearer
 * server takes its token on stdin. Without the auth kind, the plain form.
 */
export function mcpLoginCommand(server: string, authKind?: McpAuthKind | null): string {
  return authKind === "bearer"
    ? `ravi mcp login ${server} --token-stdin --execute < token.txt`
    : `ravi mcp login ${server} --execute`;
}

/** The fixed loopback port of the login redirect (`--port` picks another). */
export const MCP_LOGIN_DEFAULT_PORT = 33418;
export const MCP_LOGIN_CALLBACK_PATH = "/callback";
export const MCP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** The setting (an environment variable, e.g. in ~/.ravi/.env) naming Ravi's client metadata document. */
export const MCP_CLIENT_METADATA_URL_SETTING = "RAVI_MCP_CLIENT_METADATA_URL";

export type McpLoginErrorCode =
  | "not_http"
  | "no_login_needed"
  | "secret_missing"
  | "invalid_option"
  | "port_unavailable"
  | "timeout"
  | "state_mismatch"
  | "invalid_callback"
  | "authorization_denied"
  | "issuer_mismatch"
  | "no_authorization_requested"
  | "token_refused"
  | "registration_changed"
  | "login_failed";

/** A login failure. Its message never carries a token, a code, a verifier or a URL with a secret in it. */
export class McpLoginError extends Error {
  readonly code: McpLoginErrorCode;
  constructor(code: McpLoginErrorCode, message: string) {
    super(message);
    this.name = "McpLoginError";
    this.code = code;
  }
}

/** The loopback redirect URI of a login on `port`. */
export function mcpLoginRedirectUrl(port: number = MCP_LOGIN_DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}${MCP_LOGIN_CALLBACK_PATH}`;
}

/** The client metadata document URL from the setting, or undefined. Throws on an invalid value. */
export function mcpClientMetadataUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[MCP_CLIENT_METADATA_URL_SETTING]?.trim();
  if (!value) return undefined;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // no-cause: the parser error repeats the value; the fixed text below names the setting instead.
    url = null;
  }
  // The SDK's own rule for a client id URL: https with a path that is not the root.
  if (!url || url.protocol !== "https:" || url.pathname === "/" || url.username || url.password) {
    throw new McpLoginError(
      "invalid_option",
      `${MCP_CLIENT_METADATA_URL_SETTING} must be an https URL with a path (a client metadata document).`,
    );
  }
  return value;
}

/** What login, as a dry run and as a result, says about the method. */
export function mcpLoginMethod(authKind: McpAuthKind): "oauth" | "bearer" | null {
  if (authKind === "oauth") return "oauth";
  if (authKind === "bearer") return "bearer";
  return null;
}

const MAX_BEARER_BYTES = 8 * 1024;

/** A bearer token is one line of visible characters. The dry run of `ravi mcp login` checks it too. */
export function checkMcpBearerToken(token: string): string {
  const value = token.trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_BEARER_BYTES || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new McpLoginError("invalid_option", "The token must be one line of at most 8 KB without spaces.");
  }
  return value;
}

/**
 * Names and display forms of registered MCP servers (spec mcp, Names; Secrets
 * And Display Forms).
 *
 * A registered server name has no underscore, so the grant prefix
 * `mcp__<a>__` can never reach a server named `<a>__<b>`. A remote tool is
 * exposed under `mcp__<server>__<tool>` only when that name is safe as it is;
 * any other tool is dropped and reported, never renamed.
 */

import { HOST_MCP_SERVER_NAMES } from "../runtime/host-mcp-server-names.js";

export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MCP_EXPOSED_TOOL_NAME_MAX = 64;
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/** `ravi` plus every in-process host server name. */
export function reservedMcpServerNames(): readonly string[] {
  return ["ravi", ...HOST_MCP_SERVER_NAMES];
}

export type McpServerNameProblem = "invalid_name" | "reserved_name";

export class McpServerNameError extends Error {
  readonly code: McpServerNameProblem;
  constructor(code: McpServerNameProblem, message: string) {
    super(message);
    this.name = "McpServerNameError";
    this.code = code;
  }
}

export function checkMcpServerName(
  name: unknown,
): { ok: true; name: string } | { ok: false; error: McpServerNameError } {
  if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) {
    const shown = typeof name === "string" ? JSON.stringify(name.slice(0, 64)) : "a non-string value";
    return {
      ok: false,
      error: new McpServerNameError(
        "invalid_name",
        `MCP server name ${shown} is not valid: use 1 to 24 characters, a lowercase letter first, then lowercase letters, digits or hyphens (no underscores).`,
      ),
    };
  }
  if (reservedMcpServerNames().includes(name)) {
    return {
      ok: false,
      error: new McpServerNameError("reserved_name", `MCP server name "${name}" is reserved by Ravi.`),
    };
  }
  return { ok: true, name };
}

export function assertMcpServerName(name: unknown): string {
  const result = checkMcpServerName(name);
  if (!result.ok) throw result.error;
  return result.name;
}

export type ExposedToolName = { ok: true; name: string } | { ok: false; reason: string };

/**
 * The name a remote tool is exposed under, or why it is not exposed. The
 * server name is assumed already registered (checked by assertMcpServerName).
 */
export function exposedToolName(server: string, tool: string): ExposedToolName {
  if (typeof tool !== "string" || tool.length === 0) {
    return { ok: false, reason: "the tool has no name" };
  }
  if (tool.length > 64) {
    return { ok: false, reason: `the tool name is ${tool.length} characters long (at most 64)` };
  }
  if (!MCP_TOOL_NAME_PATTERN.test(tool)) {
    return {
      ok: false,
      reason: "the tool name holds characters other than letters, digits, underscore and hyphen",
    };
  }
  const name = `${MCP_TOOL_NAME_PREFIX}${server}__${tool}`;
  if (name.length > MCP_EXPOSED_TOOL_NAME_MAX) {
    return {
      ok: false,
      reason: `the exposed name ${name} is ${name.length} characters long (at most ${MCP_EXPOSED_TOOL_NAME_MAX})`,
    };
  }
  return { ok: true, name };
}

/** A run of characters that may be a token (16 or more from `[A-Za-z0-9_-]`). */
const TOKEN_LIKE_RUN = /[A-Za-z0-9_-]{16,}/;
export const MCP_URL_ELISION = "…";

export class McpServerUrlError extends Error {
  readonly code = "invalid_url";
  constructor(message: string) {
    super(message);
    this.name = "McpServerUrlError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Parse a server URL for registration. https is required; plain http is
 * accepted only on a loopback host. The error text never repeats the URL,
 * which may carry a token.
 */
export function parseMcpServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // no-cause: the parser error repeats the URL, which may carry a token, so it is not chained.
    throw new McpServerUrlError("The MCP server URL is not a valid absolute URL.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new McpServerUrlError("The MCP server URL must use https (plain http only on a loopback host).");
}

/**
 * The form of a server URL that `ravi.db`, listings, JSON output, traces and
 * errors may show: origin plus path, every path segment that holds a run of
 * 16 or more characters from `[A-Za-z0-9_-]` (raw or percent-decoded) replaced
 * by `…`, no user info, no query, no fragment.
 */
export function mcpDisplayUrl(raw: string | URL): string {
  const url = typeof raw === "string" ? parseMcpServerUrl(raw) : raw;
  const path = url.pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // no-cause: a segment that does not percent-decode is checked in its raw form, which is still elided when token-like.
        decoded = segment;
      }
      return TOKEN_LIKE_RUN.test(segment) || TOKEN_LIKE_RUN.test(decoded) ? MCP_URL_ELISION : segment;
    })
    .join("/");
  return `${url.protocol}//${url.host}${path === "/" ? "" : path}`;
}

// ============================================================================
// Secrets on a command line or in a configuration file
// ============================================================================

/** Names of flags and variables that carry a secret value. */
export const MCP_SECRET_NAME_PATTERN =
  /(token|secret|passw(or)?d|passphrase|api[-_]?key|apikey|bearer|credential|private[-_]?key)/i;

/** The URL with only the parts the display form keeps, before elision. */
function plainUrlForm(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * True when the display form of the URL hides or drops something: a
 * token-like path segment, user info, a query or a fragment. Such a URL is a
 * secret and belongs in the credentials store.
 */
export function mcpUrlCarriesSecret(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return true;
  const display = mcpDisplayUrl(url);
  return display.includes(MCP_URL_ELISION) || display !== plainUrlForm(url);
}

/**
 * The index of the first stdio command argument that puts a secret on the
 * command line (a secret-named `--flag=value`, a secret-named flag followed
 * by a value, a secret-named `KEY=value`, or a URL that carries a secret), or
 * null. A heuristic: it catches the common forms, it cannot prove an
 * argument holds no secret.
 */
export function mcpInlineSecretArgIndex(args: readonly string[]): number | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const flagWithValue = /^-{1,2}([A-Za-z0-9_.-]+)=(.*)$/s.exec(arg);
    if (flagWithValue && MCP_SECRET_NAME_PATTERN.test(flagWithValue[1]!) && flagWithValue[2]) return index;
    const flag = /^-{1,2}([A-Za-z0-9_.-]+)$/.exec(arg);
    const next = args[index + 1];
    if (flag && MCP_SECRET_NAME_PATTERN.test(flag[1]!) && next !== undefined && !next.startsWith("-")) return index;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/s.exec(arg);
    if (assignment && MCP_SECRET_NAME_PATTERN.test(assignment[1]!)) return index;
    if (/^https?:\/\//i.test(arg)) {
      try {
        if (mcpUrlCarriesSecret(new URL(arg))) return index;
      } catch {
        // no-cause: an argument that is not a URL is not a URL secret.
      }
    }
  }
  return null;
}

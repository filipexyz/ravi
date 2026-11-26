/**
 * Gateway CORS policy.
 *
 * Closed by default. The gateway never emits `Access-Control-Allow-Origin: *`
 * and never reflects an arbitrary Origin. Allowed origins are:
 *
 * 1. Any `chrome-extension://...` origin (browser-extension clients).
 * 2. Exact origins listed in `RAVI_CORS_ORIGINS` (comma-separated).
 * 3. When `RAVI_CORS_LOCALHOST=1`, only `http://localhost:<port>` and
 *    `http://127.0.0.1:<port>` (dev-only; off by default).
 *
 * Preflight and actual responses share {@link corsHeaders} so SSE
 * `GET /api/v1/_stream/*` gets the same headers as command POSTs.
 *
 * Private Network Access (compatibility): browsers that still use the older
 * PNA preflight send `Access-Control-Request-Private-Network: true` when a
 * public HTTPS page calls 127.0.0.1. Chrome 142+ asks the user for Local
 * Network Access permission instead, which the gateway cannot grant. {@link preflightHeaders} answers
 * `Access-Control-Allow-Private-Network: true` only when the origin is
 * already allowed above; it never widens the allowlist.
 */

export const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";
export const CORS_REQUIRED_HEADERS = [
  "Authorization",
  "Content-Type",
  "x-ravi-sdk-version",
  "x-ravi-registry-hash",
] as const;
export const CORS_MAX_AGE_SECONDS = "600";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/** Exact origins from `RAVI_CORS_ORIGINS`. `*` entries are ignored. */
export function parseCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.RAVI_CORS_ORIGINS ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "*");
}

export function isCorsLocalhostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.RAVI_CORS_LOCALHOST);
}

/**
 * Dev-only loopback origins: `http://localhost[:port]` and `http://127.0.0.1[:port]`.
 * Rejects https, credentials, paths, and lookalike hosts.
 */
export function isDevLocalhostOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!LOCALHOST_HOSTS.has(url.hostname)) return false;
  if (url.username || url.password) return false;
  const expected = url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
  return origin === expected;
}

export function isAllowedOrigin(origin: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin || origin === "*") return false;
  if (origin.startsWith("chrome-extension://")) return true;
  if (parseCorsOrigins(env).includes(origin)) return true;
  return isCorsLocalhostEnabled(env) && isDevLocalhostOrigin(origin);
}

function allowHeaders(requestedHeaders: string | null): string {
  const seen = new Set<string>();
  const headers: string[] = [];
  const add = (header: string) => {
    const trimmed = header.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    headers.push(trimmed);
  };
  for (const header of CORS_REQUIRED_HEADERS) add(header);
  if (requestedHeaders) {
    for (const header of requestedHeaders.split(",")) add(header);
  }
  return headers.join(", ");
}

export function corsHeaders(
  origin: string | null,
  requestedHeaders: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isAllowedOrigin(origin, env) || !origin || origin === "*") return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": allowHeaders(requestedHeaders),
    "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
    "Access-Control-Expose-Headers": "x-request-id",
    Vary: "Origin",
  };
}

export function withCorsHeaders(
  response: Response,
  origin: string | null,
  requestedHeaders: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Response {
  const extra = corsHeaders(origin, requestedHeaders, env);
  if (Object.keys(extra).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) merged.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

/**
 * Headers for an OPTIONS preflight: {@link corsHeaders}, plus
 * `Access-Control-Allow-Private-Network: true` when the browser asked for
 * private network access and the origin is allowed. An origin outside the
 * allowlist gets no CORS header at all, private network or not.
 */
export function preflightHeaders(
  origin: string | null,
  requestedHeaders: string | null,
  requestPrivateNetwork: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers = corsHeaders(origin, requestedHeaders, env);
  if (Object.keys(headers).length === 0) return headers;
  if (requestPrivateNetwork?.trim().toLowerCase() === "true") {
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  return headers;
}

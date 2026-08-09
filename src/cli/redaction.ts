const RCTX_TOKEN_PATTERN = /rctx_[A-Za-z0-9_-]+/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_TOKEN_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const REDACTION_MARKER_PATTERN = /^\[REDACTED(?::(?:path|rctx|token|content(?: length=\d+)?))?\]$/;
const CONTENT_KEY_PATTERN =
  /^(?:body|caption|content|fileName|inputName|instructions|message|output|prompt|query|reason|sourceName|subject|text|title)$/i;
const SECRET_KEY_SEGMENTS = new Set(["password", "passwords", "secret", "secrets", "token", "tokens"]);
const SAFE_NUMERIC_SECRET_SUFFIXES = new Set(["chars", "count", "length"]);
const PATH_KEYS = new Set(["cwd", "exe", "execpath", "outputdir"]);
const SAFE_PUBLIC_PATH_KEYS = new Set(["route"]);
const URL_KEYS = new Set(["endpoint"]);
const COMMAND_KEYS = new Set(["command", "commandline", "shellcommand"]);
const SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "contextkey",
  "credential",
  "credentials",
  "credentialref",
  "credentialsref",
  "password",
  "refreshtoken",
  "secret",
  "secretref",
  "token",
]);

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(normalizeKey(key))) return true;
  const segments = keySegments(key);
  if (segments.some((segment) => SECRET_KEY_SEGMENTS.has(segment))) return true;
  return segments.some((segment, index) => segment === "key" && ["api", "private"].includes(segments[index - 1] ?? ""));
}

function isTypedSecretMetadata(key: string, value: unknown): boolean {
  const segments = keySegments(key);
  const suffix = segments.at(-1);
  if (typeof value === "number" && SAFE_NUMERIC_SECRET_SUFFIXES.has(suffix ?? "")) return true;
  if (typeof value === "boolean" && segments.length > 1) return true;
  const compoundTokenKey =
    !["token", "tokens"].includes(normalizeKey(key)) &&
    segments.some((segment) => segment === "token" || segment === "tokens");
  if (compoundTokenKey && (typeof value === "number" || typeof value === "boolean")) return true;
  return false;
}

function parentNamesSecret(parent: Readonly<Record<string, unknown>> | undefined, value: unknown): boolean {
  return typeof parent?.key === "string" && isSecretKey(parent.key) && !isTypedSecretMetadata(parent.key, value);
}

/** Sanitize values before they can cross CLI, tool, gateway or audit boundaries. */
export function sanitizePublicValue(value: unknown, key?: string, parent?: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === "string" && REDACTION_MARKER_PATTERN.test(value)) return value;
  if (key && isSecretKey(key) && !isTypedSecretMetadata(key, value)) return "[REDACTED]";
  if (key === "value" && parentNamesSecret(parent, value)) return "[REDACTED]";
  const normalizedKey = key ? normalizeKey(key) : undefined;
  if (normalizedKey && (PATH_KEYS.has(normalizedKey) || normalizedKey.endsWith("path")) && typeof value === "string") {
    return "[REDACTED:path]";
  }
  if (normalizedKey && (URL_KEYS.has(normalizedKey) || normalizedKey.endsWith("url")) && typeof value === "string") {
    return sanitizePublicUrl(value);
  }
  if (normalizedKey && COMMAND_KEYS.has(normalizedKey) && typeof value === "string") {
    return `[REDACTED:content length=${value.length}]`;
  }
  if (normalizedKey && SAFE_PUBLIC_PATH_KEYS.has(normalizedKey) && typeof value === "string") {
    return sanitizePublicString(value);
  }
  if (key && CONTENT_KEY_PATTERN.test(key)) {
    if (typeof value === "string") return `[REDACTED:content length=${value.length}]`;
    return "[REDACTED:content]";
  }
  if (typeof value === "string") {
    if (isStandalonePath(value)) return "[REDACTED:path]";
    return sanitizePublicString(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item));
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const sanitized: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(record)) {
      sanitized[nestedKey] = sanitizePublicValue(nestedValue, nestedKey, record);
    }
    return sanitized;
  }
  return value;
}

function sanitizePublicUrl(value: string): string {
  if (isStandalonePath(value)) return "[REDACTED:path]";
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return "[REDACTED:path]";
    if (url.protocol !== "http:" && url.protocol !== "https:") return sanitizePublicString(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return sanitizePublicString(value);
  }
}

function isStandalonePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(value);
}

function sanitizePublicString(value: string): string {
  return value
    .replace(RCTX_TOKEN_PATTERN, "[REDACTED:rctx]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(API_TOKEN_PATTERN, "[REDACTED:token]");
}

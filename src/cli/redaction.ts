const RCTX_TOKEN_PATTERN = /rctx_[A-Za-z0-9_-]+/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_TOKEN_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const CONTENT_KEY_PATTERN = /^(?:body|caption|content|message|output|prompt|text)$/i;
const SECRET_KEY_SEGMENTS = new Set(["password", "passwords", "secret", "secrets", "token", "tokens"]);
const SAFE_NUMERIC_SECRET_SUFFIXES = new Set(["chars", "count", "length"]);
const SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "contextkey",
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
  if (key && isSecretKey(key) && !isTypedSecretMetadata(key, value)) return "[REDACTED]";
  if (key === "value" && parentNamesSecret(parent, value)) return "[REDACTED]";
  if (key && normalizeKey(key).endsWith("path") && typeof value === "string") {
    return "[REDACTED:path]";
  }
  if (key && CONTENT_KEY_PATTERN.test(key)) {
    if (typeof value === "string") return `[REDACTED:content length=${value.length}]`;
    return "[REDACTED:content]";
  }
  if (typeof value === "string") {
    return value
      .replace(RCTX_TOKEN_PATTERN, "[REDACTED:rctx]")
      .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
      .replace(API_TOKEN_PATTERN, "[REDACTED:token]");
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

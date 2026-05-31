const RAW_OUTPUT_KEY_RE = /(raw.*output|tool.*output.*raw|provider.*raw|full.*prompt|env|environment)/i;
const PATH_KEY_RE = /(^|_|\b)(path|cwd|home|workspace|file)(_|$|\b)/i;

export function sanitizeSyncPayload<T>(value: T): T {
  return sanitize(value, []) as T;
}

export function sanitizeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactInlineSecrets(message).slice(0, 240);
}

function sanitize(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, path));
  if (!value || typeof value !== "object") {
    return sanitizePrimitive(value, path.at(-1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (RAW_OUTPUT_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = sanitize(nested, [...path, key]);
  }
  return out;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "token" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "idtoken" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized.endsWith("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized === "password" ||
    normalized === "passwd"
  );
}

function sanitizePrimitive(value: unknown, key: string | undefined): unknown {
  if (typeof value !== "string") return value;
  if (key && PATH_KEY_RE.test(key) && looksLikePrivatePath(value)) return "[REDACTED_PATH]";
  return redactInlineSecrets(value);
}

function looksLikePrivatePath(value: string): boolean {
  return value.startsWith("/Users/") || value.startsWith("/home/") || value.startsWith("~");
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
    .replace(/(accessToken|refreshToken|apiKey|secret|password)["'=:\s]+[A-Za-z0-9._~+/=-]{8,}/gi, "$1=[REDACTED]");
}

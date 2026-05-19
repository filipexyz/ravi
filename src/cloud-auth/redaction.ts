export function redactCloudAuthPayload<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactValue(nested);
  }
  return out;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalized === "token" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "idtoken" ||
    normalized === "provideraccesstoken" ||
    normalized === "authorization" ||
    normalized === "cookie"
  ) {
    return true;
  }
  return normalized.endsWith("secret") || normalized.includes("apikey");
}

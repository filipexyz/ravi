import type { JsonValue, RedactionResult } from "../session-trace/types.js";

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(^|_)(api_key|api_token|token|secret|secret_value|password|passwd|pwd|credential|credentials|credential_value|cookie|set_cookie|authorization|authorization_header|auth|auth_token|auth_header|bearer|bearer_token|private_key|access_token|refresh_token|id_token|session_token|oauth_token|client_secret|context_key)(_|$)/i;

const SECRET_LABEL_SOURCE =
  "api[_. -]*key|api[_. -]*token|access[_. -]*token|refresh[_. -]*token|id[_. -]*token|session[_. -]*token|oauth[_. -]*token|auth(?:orization)?[_. -]*(?:token|header)|bearer[_. -]*token|client[_. -]*secret|private[_. -]*key|context[_. -]*key|credential(?:s|[_. -]*value)?|password|passwd|pwd|secret(?:[_. -]*value)?|token|set[_. -]*cookie|cookie|authorization|auth|bearer";

const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b([A-Za-z][A-Za-z0-9_.-]*(?:${SECRET_LABEL_SOURCE})[A-Za-z0-9_.-]*)\\s*=\\s*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`,
  "gi",
);

const LABELED_SECRET_PATTERN = new RegExp(
  `(["']?(?:${SECRET_LABEL_SOURCE})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}]+)`,
  "gi",
);

const BARE_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{16,}\b/g,
  /\b(?:glpat-|pat_|hf_|npm_|pypi-)[A-Za-z0-9._-]{16,}\b/g,
  /\brctx_[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  const canonical = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return SECRET_KEY_PATTERN.test(canonical);
}

export function redactText(value: string): RedactionResult<string> {
  let redacted = false;
  let next = value.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => {
    redacted = true;
    return `${key}=${REDACTED}`;
  });

  next = next.replace(
    /\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}${REDACTED}`;
    },
  );

  next = next.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (match: string) => {
    redacted = true;
    return `${match.slice(0, match.indexOf(" "))} ${REDACTED}`;
  });

  next = next.replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}${REDACTED}`;
  });

  next = next.replace(LABELED_SECRET_PATTERN, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}${REDACTED}`;
  });

  for (const pattern of BARE_SECRET_PATTERNS) {
    next = next.replace(pattern, () => {
      redacted = true;
      return REDACTED;
    });
  }

  return { value: next, redacted };
}

export function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const mapped = value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol" ? null : toJsonValue(item, seen),
    );
    seen.delete(value);
    return mapped;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      record[key] = toJsonValue(item, seen);
    }
    seen.delete(value);
    return record;
  }
  return String(value);
}

function redactJsonValue(value: JsonValue, keyHint?: string): RedactionResult<JsonValue> {
  if (keyHint && isSecretKey(keyHint)) return { value: REDACTED, redacted: true };
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    let redacted = false;
    const mapped = value.map((item) => {
      const result = redactJsonValue(item, keyHint);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: mapped, redacted };
  }
  if (value !== null && typeof value === "object") {
    let redacted = false;
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const result = redactJsonValue(value[key], key);
      redacted ||= result.redacted;
      record[key] = result.value;
    }
    return { value: record, redacted };
  }
  return { value, redacted: false };
}

export function redactJson(value: unknown): RedactionResult<JsonValue> {
  return redactJsonValue(toJsonValue(value));
}

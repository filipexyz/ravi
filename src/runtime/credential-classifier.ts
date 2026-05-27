import type {
  RuntimeCredentialFailureConfidence,
  RuntimeCredentialFailureKind,
  RuntimeCredentialFailureScope,
  RuntimeCredentialFailureSignal,
  RuntimeCredentialLimitDimension,
  RuntimeCredentialLimitPressure,
} from "./credential-types.js";
import type { RuntimeProviderId } from "./types.js";

export interface RuntimeCredentialClassifierInput {
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  model?: string;
  credentialId?: string;
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  message?: string;
  headers?: Record<string, string | number | undefined>;
  requestId?: string;
  source?: RuntimeCredentialFailureSignal["source"];
}

const REQUEST_LIMIT_HEADERS = ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"];
const REQUEST_REMAINING_HEADERS = ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"];
const TOKEN_LIMIT_HEADERS = [
  "x-ratelimit-limit-tokens",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-output-tokens-limit",
];
const TOKEN_REMAINING_HEADERS = [
  "x-ratelimit-remaining-tokens",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-output-tokens-remaining",
];

export function classifyRuntimeCredentialFailure(
  input: RuntimeCredentialClassifierInput,
): RuntimeCredentialFailureSignal {
  const headers = normalizeHeaders(input.headers);
  const status = input.httpStatus;
  const providerCode = normalizeToken(input.providerCode);
  const providerType = normalizeToken(input.providerType);
  const message = input.message?.trim();
  const text = `${providerCode ?? ""} ${providerType ?? ""} ${message ?? ""}`.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(headers["retry-after"]);
  const resetAt = parseResetAt(headers);
  const limitDimensions = extractLimitDimensions(headers);
  const rawHeaders = redactHeaders(headers);

  const classified = classifyKind({ status, providerCode, providerType, text });
  return {
    kind: classified.kind,
    confidence: classified.confidence,
    runtimeProvider: input.runtimeProvider,
    ...(input.upstreamProvider ? { upstreamProvider: input.upstreamProvider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(status ? { httpStatus: status } : {}),
    ...(input.providerCode ? { providerCode: input.providerCode } : {}),
    ...(input.providerType ? { providerType: input.providerType } : {}),
    ...(message ? { message: redactSecretLikeText(message) } : {}),
    ...(retryAfterMs ? { retryAfterMs } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...((input.requestId ?? headers["x-request-id"] ?? headers["request-id"])
      ? { requestId: String(input.requestId ?? headers["x-request-id"] ?? headers["request-id"]) }
      : {}),
    ...(Object.keys(rawHeaders).length > 0 ? { rawHeaders } : {}),
    scope: classified.scope,
    retryableByCredential: isRetryableByCredential(classified.kind, classified.scope),
    source: input.source ?? (status ? "http" : "heuristic"),
    ...(limitDimensions.length > 0 ? { limitDimensions } : {}),
  };
}

export function evaluateCredentialLimitPressure(
  signal: Pick<RuntimeCredentialFailureSignal, "limitDimensions">,
  thresholdRatio = 0.1,
): RuntimeCredentialLimitPressure {
  const dimensions = signal.limitDimensions ?? [];
  let minRemainingRatio: number | undefined;
  let exhausted = false;

  for (const dimension of dimensions) {
    if (typeof dimension.remaining === "number" && dimension.remaining <= 0) {
      exhausted = true;
    }
    if (
      typeof dimension.remaining === "number" &&
      typeof dimension.limit === "number" &&
      Number.isFinite(dimension.limit) &&
      dimension.limit > 0
    ) {
      const ratio = dimension.remaining / dimension.limit;
      minRemainingRatio = minRemainingRatio === undefined ? ratio : Math.min(minRemainingRatio, ratio);
    }
  }

  return {
    nearLimit: exhausted || (minRemainingRatio !== undefined && minRemainingRatio <= thresholdRatio),
    exhausted,
    ...(minRemainingRatio !== undefined ? { minRemainingRatio } : {}),
    dimensions,
  };
}

function classifyKind(input: { status?: number; providerCode?: string; providerType?: string; text: string }): {
  kind: RuntimeCredentialFailureKind;
  confidence: RuntimeCredentialFailureConfidence;
  scope: RuntimeCredentialFailureScope;
} {
  const text = input.text;
  const code = input.providerCode;
  const type = input.providerType;

  if (input.status === 401 || code === "authentication_error" || type === "authentication_error") {
    return { kind: "auth_invalid", confidence: "high", scope: "credential" };
  }
  if (
    input.status === 402 ||
    code === "billing_error" ||
    type === "billing_error" ||
    text.includes("insufficient credits")
  ) {
    return { kind: "billing_blocked", confidence: "high", scope: "account" };
  }
  if (input.status === 429 || code === "rate_limit_error" || type === "rate_limit_error") {
    if (text.includes("quota") || text.includes("monthly") || text.includes("exceeded your current quota")) {
      return { kind: "quota_exhausted", confidence: "high", scope: "account" };
    }
    return { kind: "rate_limited", confidence: "high", scope: inferLimitScope(text) };
  }
  if (input.status === 403 || code === "permission_error" || type === "permission_error") {
    return { kind: "permission_denied", confidence: "medium", scope: inferPermissionScope(text) };
  }
  if (input.status === 529 || input.status === 503 || text.includes("overloaded")) {
    return { kind: "provider_overloaded", confidence: "high", scope: "provider" };
  }
  if (input.status && input.status >= 500) {
    return { kind: "network_transient", confidence: "medium", scope: "provider" };
  }
  if (text.includes("context length") || text.includes("context_limit") || text.includes("maximum context")) {
    return { kind: "context_limit", confidence: "medium", scope: "request" };
  }
  if (input.status === 400 || text.includes("invalid request")) {
    return { kind: "invalid_request", confidence: "medium", scope: "request" };
  }

  return { kind: "unknown", confidence: "low", scope: "unknown" };
}

function isRetryableByCredential(kind: RuntimeCredentialFailureKind, scope: RuntimeCredentialFailureScope): boolean {
  if (kind === "rate_limited" || kind === "quota_exhausted" || kind === "billing_blocked" || kind === "auth_invalid") {
    return scope !== "request" && scope !== "provider";
  }
  if (kind === "permission_denied") {
    return scope === "credential" || scope === "account" || scope === "project" || scope === "organization";
  }
  return false;
}

function inferLimitScope(text: string): RuntimeCredentialFailureScope {
  if (text.includes("project")) return "project";
  if (text.includes("organization") || text.includes("org")) return "organization";
  if (text.includes("model")) return "model";
  if (text.includes("shared capacity") || text.includes("overloaded")) return "provider";
  if (text.includes("account") || text.includes("billing") || text.includes("credit")) return "account";
  return "unknown";
}

function inferPermissionScope(text: string): RuntimeCredentialFailureScope {
  if (text.includes("model") || text.includes("region") || text.includes("safety")) return "request";
  if (text.includes("project")) return "project";
  if (text.includes("organization") || text.includes("org")) return "organization";
  if (text.includes("account") || text.includes("entitlement")) return "account";
  return "unknown";
}

function normalizeHeaders(headers: RuntimeCredentialClassifierInput["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeader(key) ? "[redacted]" : redactSecretLikeText(value);
  }
  return out;
}

function isSensitiveHeader(key: string): boolean {
  return new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "anthropic-api-key",
    "openai-api-key",
  ]).has(key.toLowerCase());
}

function normalizeToken(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return undefined;
}

function parseResetAt(headers: Record<string, string>): number | undefined {
  for (const key of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
  ]) {
    const parsed = parseHeaderReset(headers[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseHeaderReset(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return Math.round(numeric);
    if (numeric > 1_000_000_000) return Math.round(numeric * 1000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractLimitDimensions(headers: Record<string, string>): RuntimeCredentialLimitDimension[] {
  const dimensions: RuntimeCredentialLimitDimension[] = [];
  const requestDimension = extractDimension("requests", headers, REQUEST_LIMIT_HEADERS, REQUEST_REMAINING_HEADERS);
  if (requestDimension) dimensions.push(requestDimension);
  const tokenDimension = extractDimension("tokens", headers, TOKEN_LIMIT_HEADERS, TOKEN_REMAINING_HEADERS);
  if (tokenDimension) dimensions.push(tokenDimension);
  return dimensions;
}

function extractDimension(
  name: string,
  headers: Record<string, string>,
  limitKeys: string[],
  remainingKeys: string[],
): RuntimeCredentialLimitDimension | null {
  const limit = firstNumber(headers, limitKeys);
  const remaining = firstNumber(headers, remainingKeys);
  if (limit === undefined && remaining === undefined) return null;
  return {
    name,
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(parseResetAt(headers) !== undefined ? { resetAt: parseResetAt(headers) } : {}),
  };
}

function firstNumber(headers: Record<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = Number(headers[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted-secret]")
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]");
}

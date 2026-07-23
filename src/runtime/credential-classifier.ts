import type {
  RuntimeCredentialFailureConfidence,
  RuntimeCredentialFailureKind,
  RuntimeCredentialFailureScope,
  RuntimeCredentialFailureSignal,
  RuntimeCredentialLimitDimension,
  RuntimeCredentialLimitPressure,
} from "./credential-types.js";
import type { RuntimeProviderId } from "./types.js";
import { createHash } from "node:crypto";
import {
  providerContinuityFailureEvidenceSchema,
  type ProviderContinuityFailureEvidence,
} from "./provider-continuity/types.js";

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

/**
 * Host-owned normalization used by provider continuity.
 *
 * Provider adapters remain unaware of chain policy. This classifier consumes
 * the same sanitized envelope regardless of adapter and defaults uncertain
 * evidence to a non-retryable `unknown` result, which the coordinator turns
 * into an explainable HOLD.
 */
export function classifyProviderContinuityFailure(input: {
  runtimeProvider: RuntimeProviderId;
  model: string;
  error?: unknown;
  rawEvent?: Record<string, unknown>;
  observedAt?: number;
}): ProviderContinuityFailureEvidence {
  const raw = input.rawEvent ?? {};
  const errorRecord =
    input.error && typeof input.error === "object" && !Array.isArray(input.error)
      ? (input.error as Record<string, unknown>)
      : undefined;
  const message = firstNonEmptyString(
    typeof input.error === "string" ? input.error : undefined,
    errorRecord?.message,
    raw.message,
    raw.error,
    raw.result,
  );
  const httpStatus = firstFiniteNumber(
    errorRecord?.status,
    errorRecord?.statusCode,
    raw.status,
    raw.statusCode,
    raw.httpStatus,
  );
  const providerCode = firstNonEmptyString(errorRecord?.code, raw.code, raw.error_code);
  const providerType = firstNonEmptyString(errorRecord?.type, raw.type, raw.error_type);
  const headers = normalizeUnknownHeaders(errorRecord?.headers ?? raw.headers);
  const signal = classifyRuntimeCredentialFailure({
    runtimeProvider: input.runtimeProvider,
    model: input.model,
    httpStatus,
    providerCode,
    providerType,
    message,
    headers,
    source: httpStatus ? "http" : "heuristic",
  });
  const text = `${providerCode ?? ""} ${providerType ?? ""} ${message ?? ""}`.toLowerCase();
  const timeout = /\b(timeout|timed out|deadline exceeded|etimedout|socket hang up)\b/i.test(text);
  const cancellation = /\b(cancelled|canceled|aborted|interrupt(?:ed)?)\b/i.test(text);

  const mapped = (() => {
    if (timeout) {
      return {
        kind: "timeout" as const,
        confidence: "high" as const,
        safeToRetry: true,
        safeToSwitch: true,
        credentialRecoveryEligible: false,
        qualifiedForCircuit: true,
        code: "runtime_timeout",
      };
    }
    if (cancellation) {
      return {
        kind: "cancellation" as const,
        confidence: "high" as const,
        safeToRetry: false,
        safeToSwitch: false,
        credentialRecoveryEligible: false,
        qualifiedForCircuit: false,
        code: "runtime_cancelled",
      };
    }
    switch (signal.kind) {
      case "quota_exhausted":
      case "billing_blocked":
        return {
          kind: "quota" as const,
          confidence: signal.confidence,
          safeToRetry: false,
          safeToSwitch: true,
          credentialRecoveryEligible: signal.retryableByCredential,
          qualifiedForCircuit: true,
          code: signal.kind,
        };
      case "rate_limited":
        return {
          kind: "rate_limit" as const,
          confidence: signal.confidence,
          safeToRetry: true,
          safeToSwitch: true,
          credentialRecoveryEligible: signal.retryableByCredential,
          qualifiedForCircuit: true,
          code: signal.kind,
        };
      case "auth_invalid":
      case "permission_denied":
        return {
          kind: "authentication" as const,
          confidence: signal.confidence,
          safeToRetry: false,
          safeToSwitch: true,
          credentialRecoveryEligible: signal.retryableByCredential,
          qualifiedForCircuit: false,
          code: signal.kind,
        };
      case "provider_overloaded":
        return {
          kind: "overload" as const,
          confidence: signal.confidence,
          safeToRetry: true,
          safeToSwitch: true,
          credentialRecoveryEligible: false,
          qualifiedForCircuit: true,
          code: signal.kind,
        };
      case "network_transient":
        return {
          kind: "network" as const,
          confidence: signal.confidence,
          safeToRetry: true,
          safeToSwitch: true,
          credentialRecoveryEligible: false,
          qualifiedForCircuit: true,
          code: signal.kind,
        };
      case "context_limit":
      case "invalid_request":
        return {
          kind: "permanent_request" as const,
          confidence: signal.confidence,
          safeToRetry: false,
          safeToSwitch: false,
          credentialRecoveryEligible: false,
          qualifiedForCircuit: false,
          code: signal.kind,
        };
      default:
        return {
          kind: "unknown" as const,
          confidence: "low" as const,
          safeToRetry: false,
          safeToSwitch: false,
          credentialRecoveryEligible: false,
          qualifiedForCircuit: false,
          code: "unknown_failure",
        };
    }
  })();
  const redactedMessage = redactSecretLikeText(message ?? "Runtime failure evidence unavailable.");
  const observedAt = input.observedAt ?? Date.now();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        runtimeProvider: input.runtimeProvider,
        model: input.model,
        httpStatus: httpStatus ?? null,
        code: mapped.code,
        message: redactedMessage,
      }),
    )
    .digest("hex");
  return providerContinuityFailureEvidenceSchema.parse({
    ...mapped,
    message: redactedMessage,
    retryAfterMs: signal.retryAfterMs ?? null,
    observedAt,
    fingerprint,
  });
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value instanceof Error && value.message.trim()) return value.message.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function normalizeUnknownHeaders(value: unknown): Record<string, string | number | undefined> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string | number | undefined> = {};
  for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header === "string" || typeof header === "number") headers[key] = header;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
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
  if (
    text.includes("context length") ||
    text.includes("context_limit") ||
    text.includes("maximum context") ||
    text.includes("context window") ||
    text.includes("ran out of room") ||
    text.includes("prompt is too long") ||
    text.includes("too many tokens")
  ) {
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
    .replace(
      /\b(?:(?:sk|rk|pk|rctx|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9+/=_-]{6,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/gi,
      "[redacted-secret]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{6,}\b/gi, "Bearer [redacted-token]")
    .replace(
      /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)\s*[:=]\s*["']?)[^&\s"',;]{6,}/gi,
      "$1[redacted-secret]",
    )
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]");
}

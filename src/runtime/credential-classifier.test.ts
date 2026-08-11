import { describe, expect, it } from "bun:test";
import { classifyRuntimeCredentialFailure, evaluateCredentialLimitPressure } from "./credential-classifier.js";

describe("runtime credential classifier", () => {
  it("classifies rate limit pressure without leaking sensitive headers", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      httpStatus: 429,
      message: "Rate limit reached for requests",
      headers: {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "5",
        "retry-after": "2",
        authorization: "Bearer sk-test_secret_that_must_not_leak",
      },
    });

    expect(signal.kind).toBe("rate_limited");
    expect(signal.confidence).toBe("high");
    expect(signal.retryAfterMs).toBe(2000);
    expect(signal.retryableByCredential).toBe(true);
    expect(signal.rawHeaders?.authorization).toBe("[redacted]");

    const pressure = evaluateCredentialLimitPressure(signal);
    expect(pressure.nearLimit).toBe(true);
    expect(pressure.exhausted).toBe(false);
    expect(pressure.minRemainingRatio).toBe(0.05);
  });

  it("redacts provider messages while classifying invalid credentials", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      httpStatus: 401,
      providerType: "authentication_error",
      message: "Invalid API key sk-proj-secret_token_value",
      headers: {
        "x-api-key": "sk-proj-secret_token_value",
      },
    });

    expect(signal.kind).toBe("auth_invalid");
    expect(signal.scope).toBe("credential");
    expect(signal.message).toBe("Invalid API key [redacted-secret]");
    expect(JSON.stringify(signal)).not.toContain("sk-proj-secret_token_value");
  });

  it("keeps provider overload separate from credential retry", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      httpStatus: 503,
      message: "Provider overloaded, try again later",
    });

    expect(signal.kind).toBe("provider_overloaded");
    expect(signal.scope).toBe("provider");
    expect(signal.retryableByCredential).toBe(false);
  });

  it("classifies Codex context window exhaustion as a request context limit", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      message:
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    });

    expect(signal.kind).toBe("context_limit");
    expect(signal.scope).toBe("request");
    expect(signal.retryableByCredential).toBe(false);
  });

  it("classifies official Kimi Code membership errors before generic HTTP status fallback", () => {
    const fixtures = [
      [
        401,
        "The API Key appears to be invalid or may have expired. Please verify your credentials and try again.",
        "auth_invalid",
        "credential",
      ],
      [401, "Invalid Authentication", "auth_invalid", "credential"],
      [
        401,
        "Your current subscription does not have access to k3. Upgrade to a Moderato plan or above.",
        "permission_denied",
        "model",
      ],
      [
        401,
        "Your current plan supports only kimi-k3 up to 256K context. 1M context is available on higher-tier plans.",
        "permission_denied",
        "request",
      ],
      [
        401,
        "Your model id does not exist, recognized as other:k3[1m]. Please set model id as k3.",
        "permission_denied",
        "model",
      ],
      [
        402,
        "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
        "provider_overloaded",
        "provider",
      ],
      [
        403,
        "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
        "quota_exhausted",
        "account",
      ],
      [403, "Access terminated.", "permission_denied", "account"],
      [429, "The engine is currently overloaded, please try again later", "provider_overloaded", "provider"],
      [
        429,
        "We're receiving too many requests at the moment. Please wait a moment and try again.",
        "rate_limited",
        "account",
      ],
      [
        429,
        "You've reached your usage limit for this period. Your quota will be refreshed in the next period.",
        "quota_exhausted",
        "account",
      ],
      [
        429,
        "You've reached kimi monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
        "quota_exhausted",
        "account",
      ],
      [403, "You've reached your weekly usage limit.", "quota_exhausted", "account"],
      [429, "Your 5-hour usage limit has been reached.", "quota_exhausted", "account"],
      [429, "The monthly usage limit has been reached.", "quota_exhausted", "account"],
      [429, "Kimi Code membership quota is exhausted.", "quota_exhausted", "account"],
      [400, "total message size 5943865 exceeds limit 2097152", "context_limit", "request"],
      [400, "Invalid request: Your request exceeded model token limit: 262144", "context_limit", "request"],
      [
        400,
        "thinking is enabled but reasoning_content is missing in assistant tool call message",
        "invalid_request",
        "request",
      ],
    ] as const;

    for (const [httpStatus, message, kind, scope] of fixtures) {
      const signal = classifyRuntimeCredentialFailure({ runtimeProvider: "kimi-code", httpStatus, message });
      expect(signal.kind, message).toBe(kind);
      expect(signal.scope, message).toBe(scope);
      expect(signal.retryableByCredential, message).toBe(false);
    }
  });

  it("fails closed for unrecognized Kimi Code 403 and 429 responses", () => {
    for (const httpStatus of [401, 402, 403, 429]) {
      const signal = classifyRuntimeCredentialFailure({
        runtimeProvider: "kimi-code",
        httpStatus,
        message: "An undocumented membership boundary was reached",
        headers: { "retry-after": "60" },
      });
      expect(signal.kind).toBe("unknown");
      expect(signal.scope).toBe("unknown");
      expect(signal.retryAfterMs).toBe(60_000);
      expect(signal.retryableByCredential).toBe(false);
    }
  });
});

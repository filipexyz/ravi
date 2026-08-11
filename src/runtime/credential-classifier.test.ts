import { describe, expect, it } from "bun:test";
import { classifyRuntimeCredentialFailure, evaluateCredentialLimitPressure } from "./credential-classifier.js";
import { classifyRuntimeCredentialTurnFailure } from "./host-event-loop.js";

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

    const nearMiss = classifyRuntimeCredentialFailure({
      runtimeProvider: "kimi-code",
      httpStatus: 429,
      providerCode: "not_quota_exhausted",
      providerType: "unknown_error",
      message: "Kimi Code request failed",
    });
    expect(nearMiss.kind).toBe("unknown");
    expect(nearMiss.scope).toBe("unknown");
  });

  it("classifies allowlisted Kimi structured-error tokens without a provider message", () => {
    const fixtures = [
      [401, "invalid_api_key", "authentication_error", "auth_invalid", "credential"],
      [403, "quota_exhausted", "membership_error", "quota_exhausted", "account"],
      [429, "usage_limit_exceeded", "rate_limit_error", "quota_exhausted", "account"],
      [429, "rate_limited", "rate_limit_error", "rate_limited", "account"],
    ] as const;

    for (const [httpStatus, providerCode, providerType, kind, scope] of fixtures) {
      const signal = classifyRuntimeCredentialFailure({
        runtimeProvider: "kimi-code",
        httpStatus,
        providerCode,
        providerType,
        message: "Kimi Code provider returned an error",
      });
      expect(signal.kind, providerCode).toBe(kind);
      expect(signal.scope, providerCode).toBe(scope);
      expect(signal.retryableByCredential, providerCode).toBe(false);
    }
  });

  it("passes structured Kimi SSE status and tokens through the host credential boundary", () => {
    const signal = classifyRuntimeCredentialTurnFailure({
      provider: "kimi-code",
      model: "k3",
      error: "Kimi Code provider returned an error",
      rawEvent: {
        status: 429,
        code: "rate_limited",
        type: "rate_limit_error",
        requestId: "req-native-1",
      },
      credential: { credentialId: "credential-1", upstreamProvider: "kimi-code" },
    });

    expect(signal).toMatchObject({
      kind: "rate_limited",
      scope: "account",
      runtimeProvider: "kimi-code",
      providerCode: "rate_limited",
      providerType: "rate_limit_error",
      requestId: "req-native-1",
      retryableByCredential: false,
    });
  });
});

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

  it("classifies the real Kimi 403 billing-cycle usage limit as exhausted quota", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "pi",
      upstreamProvider: "kimi-coding",
      model: "kimi-coding/kimi-k3",
      httpStatus: 403,
      providerType: "permission_error",
      message:
        '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing"},"type":"error"}',
    });

    expect(signal.kind).toBe("quota_exhausted");
    expect(signal.confidence).toBe("high");
    expect(signal.scope).toBe("account");
    expect(signal.retryableByCredential).toBe(true);
  });

  it("keeps non-quota 403 permission errors classified as permission denied", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "pi",
      upstreamProvider: "kimi-coding",
      model: "kimi-coding/kimi-k3",
      httpStatus: 403,
      providerType: "permission_error",
      message: "You do not have permission to access this model in your region.",
    });

    expect(signal.kind).toBe("permission_denied");
    expect(signal.confidence).toBe("medium");
    expect(signal.scope).toBe("request");
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
});

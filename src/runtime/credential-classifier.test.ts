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

  it("classifies model-broker forwarder failures as credential failover only", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      credentialId: "conn_a",
      message: "Could not complete the model-broker request through the local forwarder.",
    });

    expect(signal).toMatchObject({
      kind: "auth_invalid",
      scope: "credential",
      retryableByCredential: true,
    });
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

  it("classifies Claude SDK assistant error codes", () => {
    const rateLimit = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      providerCode: "rate_limit",
      message: "You're out of extra usage · resets later",
      source: "sdk-error",
    });
    const authentication = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      providerCode: "authentication_failed",
      source: "sdk-error",
    });
    const organization = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      providerCode: "oauth_org_not_allowed",
      source: "sdk-error",
    });

    expect(rateLimit).toMatchObject({
      kind: "rate_limited",
      confidence: "high",
      retryableByCredential: true,
    });
    expect(authentication).toMatchObject({
      kind: "auth_invalid",
      scope: "credential",
      retryableByCredential: true,
    });
    expect(organization).toMatchObject({
      kind: "permission_denied",
      scope: "organization",
      retryableByCredential: true,
    });
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

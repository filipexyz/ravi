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

  it("classifies provider login stubs as auth_invalid", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      message: "Not logged in · Please run /login",
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
    const classify = (providerCode: string, message?: string) =>
      classifyRuntimeCredentialFailure({
        runtimeProvider: "claude",
        upstreamProvider: "anthropic",
        providerCode,
        ...(message ? { message } : {}),
        source: "sdk-error",
      });

    expect(
      classify("rate_limit", "Claude provider error (rate_limit): You're out of extra usage · resets later"),
    ).toMatchObject({ kind: "rate_limited", confidence: "high", retryableByCredential: true });
    expect(classify("authentication_failed")).toMatchObject({
      kind: "auth_invalid",
      scope: "credential",
      retryableByCredential: true,
    });
    expect(classify("oauth_org_not_allowed")).toMatchObject({
      kind: "permission_denied",
      scope: "organization",
      retryableByCredential: true,
    });
    expect(classify("account_on_hold")).toMatchObject({
      kind: "billing_blocked",
      scope: "account",
      retryableByCredential: true,
    });
    expect(classify("overloaded")).toMatchObject({
      kind: "provider_overloaded",
      scope: "provider",
      retryableByCredential: false,
    });
  });

  it("classifies Claude result frames by api_error_status and usage text", () => {
    expect(
      classifyRuntimeCredentialFailure({
        runtimeProvider: "claude",
        httpStatus: 429,
        message: "Claude provider error (http_429): You're out of extra usage",
      }),
    ).toMatchObject({ kind: "rate_limited", retryableByCredential: true });
    expect(
      classifyRuntimeCredentialFailure({
        runtimeProvider: "claude",
        message: "You're out of extra usage · resets Aug 24 at 6am",
      }),
    ).toMatchObject({ kind: "rate_limited", retryableByCredential: true });
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

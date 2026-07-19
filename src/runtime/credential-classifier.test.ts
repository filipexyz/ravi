import { describe, expect, it } from "bun:test";
import { classifyRuntimeCredentialFailure, evaluateCredentialLimitPressure } from "./credential-classifier.js";
import { REDACTION_TEXT_CORPUS } from "../test/redaction-corpus.js";

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
    expect(signal.rawHeaders?.authorization).toBe("[REDACTED]");

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
    expect(signal.message).toBe("Invalid API key [REDACTED]");
    expect(JSON.stringify(signal)).not.toContain("sk-proj-secret_token_value");
  });

  it("uses the central sanitizer for the shared adversarial corpus", () => {
    for (const entry of REDACTION_TEXT_CORPUS) {
      const signal = classifyRuntimeCredentialFailure({
        runtimeProvider: "codex",
        upstreamProvider: entry.input,
        model: entry.input,
        credentialId: entry.input,
        providerCode: entry.input,
        providerType: entry.input,
        message: entry.input,
        requestId: entry.input,
      });
      expect(JSON.stringify(signal)).not.toContain(entry.secret);
      for (const value of [
        signal.upstreamProvider,
        signal.model,
        signal.credentialId,
        signal.providerCode,
        signal.providerType,
        signal.message,
        signal.requestId,
      ]) {
        expect(value).toContain("[REDACTED]");
      }
    }
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

  it("classifies Claude weekly subscription limits without an HTTP status", () => {
    const now = Date.UTC(2026, 6, 14, 23, 45);
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      message: "You've hit your weekly limit · resets Jul 15, 2am (UTC)",
      now,
    });

    expect(signal.kind).toBe("quota_exhausted");
    expect(signal.scope).toBe("account");
    expect(signal.confidence).toBe("high");
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 15, 2, 0));
    expect(signal.retryableByCredential).toBe(false);
  });

  it("parses Claude session-limit reset times instead of defaulting to a 24h cooldown", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      message: "You've hit your session limit · resets 12:30am (UTC)",
      now: Date.UTC(2026, 6, 16, 23, 55),
    });

    expect(signal.kind).toBe("quota_exhausted");
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 17, 0, 30));
  });

  it("keeps structured 429 Claude session limits as exhausted quota", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      httpStatus: 429,
      providerType: "error",
      message: "You've hit your session limit · resets 12:30am (UTC)",
      now: Date.UTC(2026, 6, 16, 23, 55),
    });

    expect(signal.kind).toBe("quota_exhausted");
    expect(signal.scope).toBe("account");
    expect(signal.retryableByCredential).toBe(true);
    expect(signal.resetAt).toBe(Date.UTC(2026, 6, 17, 0, 30));
  });

  it("classifies disabled Claude subscription access as an account permission failure", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      message: "Your organization has disabled Claude subscription access.",
    });

    expect(signal.kind).toBe("permission_denied");
    expect(signal.scope).toBe("organization");
    expect(signal.confidence).toBe("high");
    expect(signal.retryableByCredential).toBe(false);
  });

  it("does not authorize credential recovery from text alone", () => {
    for (const message of ["Invalid API key", "token expired", "insufficient credits"]) {
      const signal = classifyRuntimeCredentialFailure({
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        message,
        source: "sdk-error",
      });

      expect(signal.retryableByCredential).toBe(false);
    }
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

import { describe, expect, it } from "bun:test";
import {
  classifyRuntimeCredentialFailure,
  evaluateCredentialLimitPressure,
  isRuntimeProviderCapacityFailure,
} from "./credential-classifier.js";

describe("runtime credential classifier", () => {
  it("requires structural evidence for overload and keeps quota/request failures separate", () => {
    const classify = (input: Partial<Parameters<typeof classifyRuntimeCredentialFailure>[0]>) =>
      classifyRuntimeCredentialFailure({ runtimeProvider: "codex", ...input });
    expect(isRuntimeProviderCapacityFailure(classify({ providerCode: "serverOverloaded" }))).toBe(true);
    expect(isRuntimeProviderCapacityFailure(classify({ providerType: "overloaded_error" }))).toBe(true);
    expect(isRuntimeProviderCapacityFailure(classify({ providerCode: "rate_limit_exceeded" }))).toBe(true);
    expect(isRuntimeProviderCapacityFailure(classify({ httpStatus: 429, providerCode: "insufficient_quota" }))).toBe(
      false,
    );
    expect(isRuntimeProviderCapacityFailure(classify({ httpStatus: 400, message: "document says overloaded" }))).toBe(
      false,
    );
    expect(classify({ message: "The tool output mentions overloaded" }).kind).toBe("unknown");
    expect(classify({ providerCode: "usageLimitExceeded" }).kind).toBe("quota_exhausted");
  });
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

  it("classifies insufficient balance as billing_blocked", () => {
    const signal = classifyRuntimeCredentialFailure({ runtimeProvider: "pi", message: "Insufficient Balance" });
    expect(signal.kind).toBe("billing_blocked");
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

  it.each([{ providerCode: "rate_limit" }, { httpStatus: 429 }, {}])(
    "keeps Claude weekly account quota out of transient capacity retries: %j",
    (envelope) => {
      const signal = classifyRuntimeCredentialFailure({
        runtimeProvider: "claude",
        message: "Claude provider error (rate_limit): You've hit your weekly limit · resets 10am (America/Sao_Paulo)",
        headers: { "retry-after": "3600", "anthropic-ratelimit-requests-reset": "2026-11-13T13:00:00Z" },
        ...envelope,
      });
      expect(signal).toMatchObject({
        kind: "quota_exhausted",
        scope: "account",
        retryableByCredential: true,
        retryAfterMs: 3_600_000,
        resetAt: Date.parse("2026-11-13T13:00:00Z"),
      });
      expect(isRuntimeProviderCapacityFailure(signal)).toBe(false);
    },
  );

  it("does not infer exhausted quota from a generic weekly-limit mention", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      providerCode: "rate_limit",
      message: "Request throttled; see the documentation for weekly limits",
    });
    expect(signal.kind).toBe("rate_limited");
    expect(isRuntimeProviderCapacityFailure(signal)).toBe(true);
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

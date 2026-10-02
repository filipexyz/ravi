import { describe, expect, it } from "bun:test";
import { CHANNEL_TRANSPORT_ERROR_CODES, ChannelTransportError, isRetryableTransportError } from "./errors.js";

describe("ChannelTransportError", () => {
  it("carries status, code, details and cause", () => {
    const cause = new Error("boom");
    const err = new ChannelTransportError("no bridge", {
      status: 503,
      code: CHANNEL_TRANSPORT_ERROR_CODES.legacyBridgeNotConfigured,
      retryable: false,
      details: { instanceId: "abc" },
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChannelTransportError");
    expect(err.message).toBe("no bridge");
    expect(err.status).toBe(503);
    expect(err.code).toBe("LEGACY_BRIDGE_NOT_CONFIGURED");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ instanceId: "abc" });
    expect(err.cause).toBe(cause);
  });

  it("defaults retryable to status >= 500", () => {
    expect(new ChannelTransportError("x", { status: 500, code: "X" }).retryable).toBe(true);
    expect(new ChannelTransportError("x", { status: 503, code: "X" }).retryable).toBe(true);
    expect(new ChannelTransportError("x", { status: 499, code: "X" }).retryable).toBe(false);
    expect(new ChannelTransportError("x", { status: 404, code: "X" }).retryable).toBe(false);
  });

  it("keeps a transport-provided retryAfterMs", () => {
    expect(new ChannelTransportError("x", { status: 429, code: "RATE_LIMITED", retryAfterMs: 1500 }).retryAfterMs).toBe(
      1500,
    );
    expect(new ChannelTransportError("x", { status: 429, code: "RATE_LIMITED" }).retryAfterMs).toBeUndefined();
  });

  it("exposes the stable codes", () => {
    expect(CHANNEL_TRANSPORT_ERROR_CODES).toEqual({
      legacyBridgeNotConfigured: "LEGACY_BRIDGE_NOT_CONFIGURED",
      instanceNotFound: "INSTANCE_NOT_FOUND",
      providerUnsupported: "CHANNEL_PROVIDER_UNSUPPORTED",
      invalidRequest: "INVALID_REQUEST",
    });
  });
});

describe("isRetryableTransportError", () => {
  it("follows the explicit retryable flag of a ChannelTransportError", () => {
    expect(
      isRetryableTransportError(new ChannelTransportError("x", { status: 503, code: "X", retryable: false })),
    ).toBe(false);
    expect(isRetryableTransportError(new ChannelTransportError("x", { status: 429, code: "X", retryable: true }))).toBe(
      true,
    );
  });

  it("retries network TypeErrors", () => {
    expect(isRetryableTransportError(new TypeError("fetch failed"))).toBe(true);
  });

  it("retries other errors with a 5xx status (legacy bridge HTTP errors)", () => {
    const bridgeLike = Object.assign(new Error("server"), { status: 502 });
    const clientError = Object.assign(new Error("bad"), { status: 400 });
    expect(isRetryableTransportError(bridgeLike)).toBe(true);
    expect(isRetryableTransportError(clientError)).toBe(false);
    expect(isRetryableTransportError({ status: "500" })).toBe(false);
  });

  it("does not retry unknown errors", () => {
    expect(isRetryableTransportError(new Error("bug"))).toBe(false);
    expect(isRetryableTransportError("boom")).toBe(false);
    expect(isRetryableTransportError(null)).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
  });
});

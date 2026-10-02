import { describe, expect, it } from "bun:test";
import { ChannelTransportError, isRetryableTransportError } from "../outbound/errors.js";
import { WHATSAPP_RPC_ERROR_CODES } from "./contract.js";
import { WhatsAppRpcError, isWhatsAppRpcError, isWhatsAppRunnerUnavailable } from "./errors.js";

describe("WhatsAppRpcError", () => {
  it("is a ChannelTransportError carrying status, code, method and instance", () => {
    const err = new WhatsAppRpcError("runner down", {
      status: 503,
      code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable,
      details: "no responders",
      method: "messages.sendText",
      instanceId: "uuid-1",
    });
    expect(err).toBeInstanceOf(ChannelTransportError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WhatsAppRpcError");
    expect(err.message).toBe("runner down");
    expect(err).toMatchObject({
      status: 503,
      code: "WHATSAPP_RUNNER_UNAVAILABLE",
      retryable: true,
      details: "no responders",
      method: "messages.sendText",
      instanceId: "uuid-1",
    });
  });

  it("follows the 5xx retry contract unless told otherwise", () => {
    expect(new WhatsAppRpcError("x", { status: 502, code: "TRANSPORT_ERROR" }).retryable).toBe(true);
    expect(new WhatsAppRpcError("x", { status: 429, code: "RATE_LIMITED" }).retryable).toBe(false);
    expect(new WhatsAppRpcError("x", { status: 404, code: "WHATSAPP_NOT_BOUND" }).retryable).toBe(false);
    expect(new WhatsAppRpcError("x", { status: 503, code: "X", retryable: false }).retryable).toBe(false);
    expect(isRetryableTransportError(new WhatsAppRpcError("x", { status: 504, code: "WHATSAPP_RPC_TIMEOUT" }))).toBe(
      true,
    );
  });

  it("keeps a retryAfterMs and the cause", () => {
    const cause = new Error("socket");
    const err = new WhatsAppRpcError("slow", { status: 429, code: "RATE_LIMITED", retryAfterMs: 1500, cause });
    expect(err.retryAfterMs).toBe(1500);
    expect(err.cause).toBe(cause);
    expect(new WhatsAppRpcError("x", { status: 400, code: "INVALID_REQUEST" }).method).toBeUndefined();
  });
});

describe("isWhatsAppRpcError / isWhatsAppRunnerUnavailable", () => {
  it("recognises only WhatsAppRpcError instances", () => {
    expect(isWhatsAppRpcError(new WhatsAppRpcError("x", { status: 500, code: "X" }))).toBe(true);
    expect(isWhatsAppRpcError(new ChannelTransportError("x", { status: 500, code: "X" }))).toBe(false);
    expect(isWhatsAppRpcError({ status: 503, code: "WHATSAPP_RUNNER_UNAVAILABLE" })).toBe(false);
    expect(isWhatsAppRpcError(null)).toBe(false);
  });

  it("matches the runner-unavailable code only", () => {
    expect(
      isWhatsAppRunnerUnavailable(
        new WhatsAppRpcError("x", { status: 503, code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable }),
      ),
    ).toBe(true);
    expect(
      isWhatsAppRunnerUnavailable(
        new WhatsAppRpcError("x", { status: 503, code: WHATSAPP_RPC_ERROR_CODES.notConnected }),
      ),
    ).toBe(false);
    // Duck-typed look-alikes (e.g. an OmniApiError with the same code) are not runner errors.
    expect(isWhatsAppRunnerUnavailable({ status: 503, code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable })).toBe(false);
    expect(isWhatsAppRunnerUnavailable(new Error("x"))).toBe(false);
  });
});

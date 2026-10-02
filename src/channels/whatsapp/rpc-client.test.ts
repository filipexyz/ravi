import { describe, expect, it } from "bun:test";
import {
  WHATSAPP_RPC_PROTOCOL,
  WHATSAPP_RPC_SCHEMA_VERSION,
  WhatsAppRpcRequestSchema,
  whatsappRpcSubject,
  type WhatsAppRpcMethod,
  type WhatsAppRpcParams,
  type WhatsAppRpcRequest,
  type WhatsAppRpcResponse,
} from "./contract.js";
import { WhatsAppRpcError } from "./errors.js";
import {
  WHATSAPP_RPC_INVALID_RESPONSE_CODE,
  mapWhatsAppRpcTransportError,
  requestWhatsAppRpc,
  type WhatsAppRpcConnection,
} from "./rpc-client.js";

const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Reply = WhatsAppRpcResponse | ((request: WhatsAppRpcRequest) => WhatsAppRpcResponse | string) | Error | string;

function natsError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

function fakeConnection(reply: Reply) {
  const calls: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
  const connection: WhatsAppRpcConnection = {
    async request(subject, data, options) {
      const request = WhatsAppRpcRequestSchema.parse(JSON.parse(decoder.decode(data)));
      calls.push({ subject, request, timeout: options.timeout });
      if (reply instanceof Error) throw reply;
      const value = typeof reply === "function" ? reply(request) : reply;
      return { data: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)) };
    },
  };
  return { connection, calls };
}

/** Params a caller built at runtime (e.g. from JSON): the typed API still validates them. */
function untypedParams<M extends WhatsAppRpcMethod>(_method: M, value: unknown): WhatsAppRpcParams<M> {
  return value as WhatsAppRpcParams<M>;
}

async function captureError(promise: Promise<unknown>): Promise<WhatsAppRpcError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WhatsAppRpcError);
    return err as WhatsAppRpcError;
  }
  throw new Error("expected the request to fail");
}

describe("requestWhatsAppRpc", () => {
  it("sends a contract request on the instance subject and returns the data", async () => {
    const { connection, calls } = fakeConnection((request) => ({
      ok: true,
      requestId: request.requestId,
      data: { messageId: "BAE5ABC", status: "sent" },
    }));

    const result = await requestWhatsAppRpc(
      INSTANCE_ID,
      "messages.sendText",
      { to: "5511999999999@s.whatsapp.net", text: "oi", mentions: [{ id: "1@lid", type: "user" }] },
      { connection, timeoutMs: 1_234 },
    );

    expect(result).toEqual({ messageId: "BAE5ABC", status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(whatsappRpcSubject(INSTANCE_ID));
    expect(calls[0]!.timeout).toBe(1_234);
    expect(calls[0]!.request).toMatchObject({
      protocol: WHATSAPP_RPC_PROTOCOL,
      schemaVersion: WHATSAPP_RPC_SCHEMA_VERSION,
      instanceId: INSTANCE_ID,
      method: "messages.sendText",
      params: { to: "5511999999999@s.whatsapp.net", text: "oi", mentions: [{ id: "1@lid", type: "user" }] },
    });
  });

  it("uses the contract default timeout", async () => {
    const { connection, calls } = fakeConnection((request) => ({ ok: true, requestId: request.requestId, data: {} }));
    await requestWhatsAppRpc(INSTANCE_ID, "connection.disconnect", {}, { connection });
    expect(calls[0]!.timeout).toBe(60_000);
  });

  it("rejects invalid params with 400 before sending", async () => {
    const { connection, calls } = fakeConnection(new Error("must not be called"));
    const err = await captureError(
      requestWhatsAppRpc(
        INSTANCE_ID,
        "messages.sendMedia",
        untypedParams("messages.sendMedia", { to: "x@g.us", type: "image" }),
        { connection },
      ),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.message).toContain("filePath");
    expect(err.method).toBe("messages.sendMedia");
    expect(err.instanceId).toBe(INSTANCE_ID);
    expect(calls).toHaveLength(0);
  });

  it("requires an absolute media filePath and has no base64 alternative", async () => {
    const { connection, calls } = fakeConnection(new Error("must not be called"));
    for (const params of [
      { to: "x@g.us", type: "image", filePath: "relative/a.png" },
      { to: "x@g.us", type: "image", base64: "AAAA" },
    ]) {
      const err = await captureError(
        requestWhatsAppRpc(INSTANCE_ID, "messages.sendMedia", untypedParams("messages.sendMedia", params), {
          connection,
        }),
      );
      expect(err.status).toBe(400);
    }
    const sticker = await captureError(
      requestWhatsAppRpc(INSTANCE_ID, "messages.sendSticker", { to: "x@g.us", filePath: "s.webp" }, { connection }),
    );
    expect(sticker.message).toContain("filePath must be an absolute path");
    expect(calls).toHaveLength(0);
  });

  it("rejects an instance id that is not a NATS token", async () => {
    const { connection } = fakeConnection(new Error("must not be called"));
    const err = await captureError(
      requestWhatsAppRpc("bad id.with.dots and spaces", "connection.status", {}, { connection }),
    );
    expect(err.status).toBe(400);
  });

  it("maps no responders to 503 WHATSAPP_RUNNER_UNAVAILABLE with a hint", async () => {
    const { connection } = fakeConnection(natsError("503"));
    const err = await captureError(requestWhatsAppRpc(INSTANCE_ID, "connection.status", {}, { connection }));
    expect(err.status).toBe(503);
    expect(err.code).toBe("WHATSAPP_RUNNER_UNAVAILABLE");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("ravi channels start");
    expect(err.message).not.toContain("native");
  });

  it("maps a request timeout to 504 WHATSAPP_RPC_TIMEOUT", async () => {
    const { connection } = fakeConnection(natsError("TIMEOUT"));
    const err = await captureError(
      requestWhatsAppRpc(INSTANCE_ID, "connection.status", {}, { connection, timeoutMs: 50 }),
    );
    expect(err.status).toBe(504);
    expect(err.code).toBe("WHATSAPP_RPC_TIMEOUT");
    expect(err.message).toContain("50ms");
  });

  it("maps an unreachable NATS server to 503", async () => {
    const { connection } = fakeConnection(natsError("CONNECTION_REFUSED"));
    const err = await captureError(requestWhatsAppRpc(INSTANCE_ID, "connection.status", {}, { connection }));
    expect(err.status).toBe(503);
    expect(err.code).toBe("WHATSAPP_RUNNER_UNAVAILABLE");
  });

  it("maps other transport failures to a retryable 502", async () => {
    const { connection } = fakeConnection(new Error("boom"));
    const err = await captureError(requestWhatsAppRpc(INSTANCE_ID, "connection.status", {}, { connection }));
    expect(err.status).toBe(502);
    expect(err.code).toBe("TRANSPORT_ERROR");
  });

  it("surfaces runner errors with their status, code and message", async () => {
    const { connection } = fakeConnection((request) => ({
      ok: false,
      requestId: request.requestId,
      error: { status: 503, code: "NOT_CONNECTED", message: "WhatsApp socket is not connected" },
    }));
    const err = await captureError(
      requestWhatsAppRpc(INSTANCE_ID, "messages.sendText", { to: "x@g.us", text: "hi" }, { connection }),
    );
    expect(err.status).toBe(503);
    expect(err.code).toBe("NOT_CONNECTED");
    expect(err.message).toBe("WhatsApp socket is not connected");
    expect(err.method).toBe("messages.sendText");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("carries a runner-provided retryAfterMs", async () => {
    const { connection } = fakeConnection((request) => ({
      ok: false,
      requestId: request.requestId,
      error: { status: 429, code: "RATE_LIMITED", message: "slow down", retryAfterMs: 5_000 },
    }));
    const err = await captureError(
      requestWhatsAppRpc(INSTANCE_ID, "messages.sendText", { to: "x@g.us", text: "hi" }, { connection }),
    );
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(false);
    expect(err.retryAfterMs).toBe(5_000);
  });

  it("passes a WhatsAppRpcError through the transport mapper unchanged", () => {
    const original = new WhatsAppRpcError("x", { status: 418, code: "TEAPOT" });
    expect(
      mapWhatsAppRpcTransportError(original, { instanceId: INSTANCE_ID, method: "connection.status", timeoutMs: 1 }),
    ).toBe(original);
  });

  it("rejects malformed responses with 502", async () => {
    for (const reply of [
      "not json",
      JSON.stringify({ ok: "yes" }),
      (request: WhatsAppRpcRequest) => ({ ok: true as const, requestId: `${request.requestId}-other`, data: {} }),
      (request: WhatsAppRpcRequest) => ({ ok: true as const, requestId: request.requestId, data: null }),
    ]) {
      const { connection } = fakeConnection(reply);
      const err = await captureError(requestWhatsAppRpc(INSTANCE_ID, "connection.status", {}, { connection }));
      expect(err.status).toBe(502);
      expect(err.code).toBe(WHATSAPP_RPC_INVALID_RESPONSE_CODE);
    }
  });
});

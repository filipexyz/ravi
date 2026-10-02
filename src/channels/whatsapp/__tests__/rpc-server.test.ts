import { describe, expect, it, mock } from "bun:test";
import { JSONCodec } from "nats";
import {
  WHATSAPP_RPC_PROTOCOL,
  WHATSAPP_RPC_QUEUE,
  WHATSAPP_RPC_SCHEMA_VERSION,
  WhatsAppRpcResponseSchema,
  whatsappRpcSubject,
  type WhatsAppRpcMethod,
} from "../contract.js";
import {
  handleWhatsAppRpcRequest,
  startWhatsAppRpcServer,
  toRpcError,
  type WhatsAppRpcDispatcher,
} from "../rpc-server.js";
import { WhatsAppRuntimeError } from "../runtime-errors.js";
import { createFakeNats } from "./fake-nats.js";

const codec = JSONCodec<unknown>();
const INSTANCE_ID = "0b7d9d58-2d3c-4b8e-9a1f-1234567890ab";

function request(method: string, params: unknown, overrides: Record<string, unknown> = {}) {
  return {
    protocol: WHATSAPP_RPC_PROTOCOL,
    schemaVersion: WHATSAPP_RPC_SCHEMA_VERSION,
    requestId: "req-1",
    instanceId: INSTANCE_ID,
    method,
    params,
    ...overrides,
  };
}

function dispatcher(impl: (method: WhatsAppRpcMethod, params: unknown) => unknown) {
  const call = mock(async (method: WhatsAppRpcMethod, params: unknown) => impl(method, params));
  return { call: call as unknown as WhatsAppRpcDispatcher["call"], calls: call };
}

describe("WhatsApp RPC request handling", () => {
  it("dispatches a valid request and returns exactly the runtime data", async () => {
    const data = { messageId: "3EB0ABC", status: "sent" };
    const runtime = dispatcher(() => data);

    const response = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("messages.sendText", { to: "5511999990000@s.whatsapp.net", text: "oi" }),
      runtime,
    );

    expect(response).toEqual({ ok: true, requestId: "req-1", data });
    expect(WhatsAppRpcResponseSchema.parse(response)).toEqual(response);
    expect(runtime.calls).toHaveBeenCalledWith("messages.sendText", {
      to: "5511999990000@s.whatsapp.net",
      text: "oi",
    });
  });

  it("treats missing params as an empty object for parameterless methods", async () => {
    const status = { state: "connected", isConnected: true, profileName: "Ravi" };
    const runtime = dispatcher(() => status);

    const response = await handleWhatsAppRpcRequest(INSTANCE_ID, request("connection.status", undefined), runtime);

    expect(response).toEqual({ ok: true, requestId: "req-1", data: status });
    expect(runtime.calls).toHaveBeenCalledWith("connection.status", {});
  });

  it("rejects a malformed envelope with 400 INVALID_REQUEST and keeps a string requestId", async () => {
    const runtime = dispatcher(() => ({}));

    const wrongProtocol = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("connection.status", {}, { protocol: "wrong.protocol" }),
      runtime,
    );
    expect(wrongProtocol).toMatchObject({
      ok: false,
      requestId: "req-1",
      error: { status: 400, code: "INVALID_REQUEST" },
    });

    const notAnObject = await handleWhatsAppRpcRequest(INSTANCE_ID, "hello", runtime);
    expect(notAnObject).toMatchObject({ ok: false, requestId: "", error: { status: 400, code: "INVALID_REQUEST" } });
    expect(runtime.calls).not.toHaveBeenCalled();
  });

  it("rejects an unknown method with 400", async () => {
    const runtime = dispatcher(() => ({}));
    const response = await handleWhatsAppRpcRequest(INSTANCE_ID, request("messages.sendPoll", {}), runtime);
    expect(response).toMatchObject({ ok: false, error: { status: 400, code: "INVALID_REQUEST" } });
    expect(runtime.calls).not.toHaveBeenCalled();
  });

  it("rejects params that fail the per-method schema with 400 and names the field", async () => {
    const runtime = dispatcher(() => ({}));

    const response = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("messages.sendMedia", { to: "123@s.whatsapp.net", type: "image" }),
      runtime,
    );
    expect(response).toMatchObject({ ok: false, requestId: "req-1", error: { status: 400, code: "INVALID_REQUEST" } });
    expect(response.ok ? "" : response.error.message).toContain("filePath is required");

    const pairing = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("connection.pairingCode", { phoneNumber: 5511 }),
      runtime,
    );
    expect(pairing.ok ? "" : pairing.error.message).toContain("phoneNumber");
    expect(runtime.calls).not.toHaveBeenCalled();
  });

  it("rejects an instanceId that does not match the subject instance", async () => {
    const runtime = dispatcher(() => ({}));
    const response = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("connection.status", {}, { instanceId: "11111111-2222-3333-4444-555555555555" }),
      runtime,
    );
    expect(response).toMatchObject({ ok: false, requestId: "req-1", error: { status: 400, code: "INVALID_REQUEST" } });
    expect(response.ok ? "" : response.error.message).toContain("does not match");
    expect(runtime.calls).not.toHaveBeenCalled();
  });

  it("maps typed runtime errors to {status, code, message}", async () => {
    const runtime = dispatcher(() => {
      throw new WhatsAppRuntimeError("NOT_CONNECTED", "WhatsApp instance is not connected");
    });
    const response = await handleWhatsAppRpcRequest(
      INSTANCE_ID,
      request("messages.sendText", { to: "1@s.whatsapp.net", text: "x" }),
      runtime,
    );
    expect(response).toEqual({
      ok: false,
      requestId: "req-1",
      error: { message: "WhatsApp instance is not connected", status: 503, code: "NOT_CONNECTED" },
    });
  });

  it("maps untyped failures to 502 TRANSPORT_ERROR", async () => {
    const runtime = dispatcher(() => {
      throw new Error("socket exploded");
    });
    const response = await handleWhatsAppRpcRequest(INSTANCE_ID, request("connection.status", {}), runtime);
    expect(response).toEqual({
      ok: false,
      requestId: "req-1",
      error: { message: "socket exploded", status: 502, code: "TRANSPORT_ERROR" },
    });
  });

  it("classifies error shapes", () => {
    expect(toRpcError(new WhatsAppRuntimeError("RATE_LIMITED", "slow down"))).toEqual({
      message: "slow down",
      status: 429,
      code: "RATE_LIMITED",
    });
    expect(toRpcError(new WhatsAppRuntimeError("RATE_LIMITED", "slow down", { retryAfterMs: 1500.2 }))).toEqual({
      message: "slow down",
      status: 429,
      code: "RATE_LIMITED",
      retryAfterMs: 1501,
    });
    expect(toRpcError(Object.assign(new Error("gone"), { status: 404, code: "NOT_FOUND" }))).toEqual({
      message: "gone",
      status: 404,
      code: "NOT_FOUND",
    });
    // A non-HTTP numeric status (e.g. a Baileys 0) is not trusted.
    expect(toRpcError(Object.assign(new Error("weird"), { status: 0, code: "X" }))).toMatchObject({ status: 502 });
    expect(toRpcError("plain")).toEqual({ message: "plain", status: 502, code: "TRANSPORT_ERROR" });
    expect(toRpcError(undefined)).toMatchObject({ status: 502, code: "TRANSPORT_ERROR" });
  });
});

describe("WhatsApp RPC server", () => {
  it("queue-subscribes the instance subject and answers requests", async () => {
    const nats = createFakeNats();
    const runtime = dispatcher((method) =>
      method === "connection.status" ? { state: "qr", isConnected: false, profileName: null } : {},
    );
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });

    expect(server.subject).toBe(whatsappRpcSubject(INSTANCE_ID));
    expect(nats.subscriptions).toHaveLength(1);
    expect(nats.subscriptions[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${INSTANCE_ID}`);
    expect(nats.subscriptions[0]?.options).toEqual({ queue: WHATSAPP_RPC_QUEUE });

    await expect(nats.request(server.subject, request("connection.status", {}))).resolves.toEqual({
      ok: true,
      requestId: "req-1",
      data: { state: "qr", isConnected: false, profileName: null },
    });

    await server.stop();
    expect(nats.subscriptions[0]?.closed).toBe(true);
  });

  it("answers invalid JSON instead of dropping the request", async () => {
    const nats = createFakeNats();
    const runtime = dispatcher(() => ({}));
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });

    const delivery = nats.deliver(server.subject, new TextEncoder().encode("{not json"));
    await waitFor(() => delivery.replies.length > 0);
    expect(delivery.decoded()[0]).toMatchObject({
      ok: false,
      requestId: "",
      error: { status: 400, code: "INVALID_REQUEST" },
    });
    await server.stop();
  });

  it("handles requests concurrently", async () => {
    const nats = createFakeNats();
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const runtime = dispatcher(async (method) => {
      if (method === "connection.pairingCode") {
        await slow;
        return { code: "ABCD-EFGH" };
      }
      return { state: "connecting", isConnected: false, profileName: null };
    });
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });

    const pairing = nats.deliver(
      server.subject,
      codec.encode(request("connection.pairingCode", { phoneNumber: "5511999990000" }, { requestId: "slow" })),
    );
    const status = await nats.request(server.subject, request("connection.status", {}, { requestId: "fast" }));
    expect(status).toMatchObject({ ok: true, requestId: "fast" });
    expect(pairing.replies).toHaveLength(0);
    expect(server.inFlight()).toBe(1);

    releaseSlow();
    await waitFor(() => pairing.replies.length > 0);
    expect(pairing.decoded()[0]).toEqual({ ok: true, requestId: "slow", data: { code: "ABCD-EFGH" } });
    await server.stop();
  });

  it("stops taking requests, waits for in-flight ones up to the drain budget", async () => {
    const nats = createFakeNats();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = dispatcher(async () => {
      await gate;
      return {};
    });
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });
    const inflight = nats.deliver(server.subject, codec.encode(request("connection.disconnect", {})));
    await waitFor(() => server.inFlight() === 1);

    let stopped = false;
    const stopping = server.stop({ drainTimeoutMs: 1_000 }).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    // New requests after stop are not consumed.
    const late = nats.deliver(server.subject, codec.encode(request("connection.status", {})));

    release();
    await stopping;
    expect(inflight.decoded()[0]).toEqual({ ok: true, requestId: "req-1", data: {} });
    expect(late.replies).toHaveLength(0);
    // Idempotent.
    await server.stop();
  });

  it("gives up waiting for a stuck request after the drain timeout", async () => {
    const nats = createFakeNats();
    const runtime = dispatcher(() => new Promise(() => {}));
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });
    nats.deliver(server.subject, codec.encode(request("connection.status", {})));
    await waitFor(() => server.inFlight() === 1);

    const started = Date.now();
    await server.stop({ drainTimeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("falls back to an error response when the success payload cannot be sent", async () => {
    const nats = createFakeNats();
    const runtime = dispatcher(() => ({ items: [] }));
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });

    const delivery = nats.deliver(server.subject, codec.encode(request("groups.list", {})));
    delivery.failNextRespond(new Error("MAX_PAYLOAD_EXCEEDED"));
    await waitFor(() => delivery.replies.length > 0);
    expect(delivery.decoded()[0]).toMatchObject({
      ok: false,
      requestId: "req-1",
      error: { status: 502, code: "TRANSPORT_ERROR" },
    });
    await server.stop();
  });

  it("does not crash on requests without a reply subject", async () => {
    const nats = createFakeNats();
    const runtime = dispatcher(() => ({}));
    const server = startWhatsAppRpcServer({ instanceId: INSTANCE_ID, connection: nats, dispatcher: runtime });
    const delivery = nats.deliver(server.subject, codec.encode(request("connection.status", {})), { reply: false });
    await waitFor(() => runtime.calls.mock.calls.length > 0);
    expect(delivery.replies).toHaveLength(0);
    // Still serving afterwards.
    await expect(nats.request(server.subject, request("connection.status", {}))).resolves.toMatchObject({ ok: true });
    await server.stop();
  });

  it("refuses a non NATS-safe instance id", () => {
    const nats = createFakeNats();
    expect(() =>
      startWhatsAppRpcServer({ instanceId: "bad id", connection: nats, dispatcher: dispatcher(() => ({})) }),
    ).toThrow();
    expect(nats.subscriptions).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

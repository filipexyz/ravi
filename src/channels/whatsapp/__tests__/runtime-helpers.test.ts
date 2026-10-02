/** Unit coverage for the runtime's pure helpers (cache, events, send, errors). */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { TtlCache } from "../runtime-cache.js";
import { WhatsAppRuntimeError, toWhatsAppRuntimeError } from "../runtime-errors.js";
import {
  DEFAULT_PUBLISHED_EVENT_TYPES,
  buildWhatsAppObservedEvent,
  connectionConnectedPayload,
  connectionDisconnectedPayload,
  connectionQrPayload,
  deterministicEventId,
  messageIdempotencyKey,
  messageReceivedPayload,
  reactionIdempotencyKey,
  toWhatsAppInboundEvent,
} from "../runtime-events.js";
import { WHATSAPP_INBOUND_EVENT_TYPES } from "../events.js";
import {
  buildVCard,
  extractInviteCode,
  isWebp,
  normalizeChatTarget,
  normalizeGroupJid,
  normalizeSendMediaMimeType,
  sanitizeOutboundText,
} from "../runtime-send.js";
import { isTransientConnectionClosedError } from "../runtime.js";

describe("TtlCache", () => {
  it("expires entries lazily against the injected clock and evicts the oldest write", () => {
    let now = 0;
    const cache = new TtlCache<string, number>({ ttlMs: 100, maxEntries: 2, now: () => now });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
    now = 101;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("c")).toBe(false);
  });
});

describe("event builders", () => {
  it("derives stable UUID-shaped ids from the ingress idempotency keys", () => {
    const key = messageIdempotencyKey("inst", "MSG-1", "text");
    expect(key).toBe("whatsapp-baileys:inst:MSG-1:text");
    const id = deterministicEventId(key);
    expect(id).toBe(deterministicEventId(key));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(deterministicEventId(messageIdempotencyKey("inst", "MSG-1", "image")));
  });

  it("reaction keys fall back to messageId:from without an external id", () => {
    expect(
      reactionIdempotencyKey("inst", "reaction.received", { messageId: "M", chatId: "c", from: "f", emoji: "👍" }),
    ).toBe("whatsapp-baileys:inst:M:f:reaction.received:👍");
  });

  it("builds an observed event; receivedAt defaults to the build time and ingestMode is only set when given", () => {
    expect(
      buildWhatsAppObservedEvent({ type: "connection.connected", instanceId: "inst", payload: {}, now: 5, id: "x" }),
    ).toEqual({
      id: "x",
      type: "connection.connected",
      instanceId: "inst",
      timestamp: 5,
      payload: {},
      receivedAt: 5,
    });
    const message = buildWhatsAppObservedEvent({
      type: "message.received",
      instanceId: "inst",
      payload: {},
      now: 9,
      ingestMode: "history-sync",
      receivedAt: 7,
    });
    expect(message).toMatchObject({ ingestMode: "history-sync", receivedAt: 7, timestamp: 9 });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("publishes exactly the inbound contract types by default", () => {
    expect([...DEFAULT_PUBLISHED_EVENT_TYPES]).toEqual([...WHATSAPP_INBOUND_EVENT_TYPES]);
  });

  it("maps a published observed event to a validated WhatsAppInboundEvent", () => {
    const payload = messageReceivedPayload({
      externalId: "E",
      chatId: "C@s.whatsapp.net",
      from: "C",
      content: { type: "text", text: "oi" },
    });
    const observed = buildWhatsAppObservedEvent({
      type: "message.received",
      instanceId: "inst",
      payload,
      now: 5,
      id: "x",
    });
    expect(toWhatsAppInboundEvent(observed)).toEqual({
      schemaVersion: 1,
      id: "x",
      instanceId: "inst",
      timestamp: 5,
      receivedAt: 5,
      type: "message.received",
      ingestMode: "realtime",
      payload: { externalId: "E", chatId: "C@s.whatsapp.net", from: "C", content: { type: "text", text: "oi" } },
    });

    const disconnected = toWhatsAppInboundEvent(
      buildWhatsAppObservedEvent({
        type: "connection.disconnected",
        instanceId: "inst",
        payload: connectionDisconnectedPayload("bye", true),
        now: 6,
        id: "d",
        ingestMode: "realtime",
      }),
    );
    expect(disconnected).toEqual({
      schemaVersion: 1,
      id: "d",
      instanceId: "inst",
      timestamp: 6,
      receivedAt: 6,
      type: "connection.disconnected",
      payload: { reason: "bye", willReconnect: true },
    });
    expect(disconnected).not.toHaveProperty("ingestMode");
  });

  it("returns null for observe-only types and throws on a payload outside the contract", () => {
    for (const type of ["reaction.removed", "presence.typing", "message.sent", "custom.chat.unread-updated"]) {
      expect(
        toWhatsAppInboundEvent(buildWhatsAppObservedEvent({ type, instanceId: "inst", payload: {}, now: 1 })),
      ).toBeNull();
    }
    expect(() =>
      toWhatsAppInboundEvent(
        buildWhatsAppObservedEvent({ type: "connection.qr", instanceId: "inst", payload: { qrCode: "" }, now: 1 }),
      ),
    ).toThrow();
  });

  it("connection payloads carry no instanceId/channelType (the envelope does)", () => {
    expect(connectionQrPayload("2@QR", new Date(10))).toEqual({ qrCode: "2@QR", expiresAt: 10 });
    expect(connectionDisconnectedPayload(undefined, false)).toEqual({ reason: undefined, willReconnect: false });
  });

  it("message payload keeps the ported field order and only adds localPath when present", () => {
    const payload = messageReceivedPayload({
      externalId: "E",
      chatId: "C",
      from: "F",
      content: { type: "image", mediaUrl: "file:///a.jpg", localPath: "/a.jpg" },
    });
    expect(Object.keys(JSON.parse(JSON.stringify(payload)))).toEqual(["externalId", "chatId", "from", "content"]);
    expect(payload.content).toEqual({
      type: "image",
      text: undefined,
      mediaUrl: "file:///a.jpg",
      mimeType: undefined,
      localPath: "/a.jpg",
    });
    expect(
      messageReceivedPayload({ externalId: "E", chatId: "C", from: "F", content: { type: "text" } }).content,
    ).not.toHaveProperty("localPath");
  });

  it("connection.connected only carries isNewLogin when true", () => {
    expect(connectionConnectedPayload({ isNewLogin: false })).not.toHaveProperty("isNewLogin");
    expect(connectionConnectedPayload({ isNewLogin: true })).toHaveProperty("isNewLogin", true);
    expect(connectionConnectedPayload({ profileName: "Ravi" })).not.toHaveProperty("instanceId");
  });
});

describe("send helpers", () => {
  it("sanitizes routing headers and agent directives", () => {
    expect(sanitizeOutboundText("[channel:whatsapp-baileys chat:x@s.whatsapp.net]\nOi\n\n\n\nTchau")).toBe(
      "Oi\n\nTchau",
    );
    expect(sanitizeOutboundText("⚡ REPLY NOW to this")).toBe("");
  });

  it("normalizes chat and group targets", () => {
    expect(normalizeChatTarget("group:120363")).toBe("120363@g.us");
    expect(normalizeChatTarget("lid:217046")).toBe("217046@lid");
    expect(normalizeChatTarget("5511999990000-1600000000")).toBe("5511999990000-1600000000@g.us");
    expect(normalizeChatTarget("x@s.whatsapp.net")).toBe("x@s.whatsapp.net");
    expect(normalizeChatTarget("+55 11 98888-7777")).toBe("5511988887777@s.whatsapp.net");
    expect(normalizeGroupJid("120363")).toBe("120363@g.us");
  });

  it("extracts invite codes from links", () => {
    expect(extractInviteCode("https://chat.whatsapp.com/invite/AbC_1")).toBe("AbC_1");
    expect(extractInviteCode(" XyZ ")).toBe("XyZ");
  });

  it("infers media mime types and upgrades ogg voice notes to opus", () => {
    expect(normalizeSendMediaMimeType({ type: "image", filename: "a.PNG" })).toBe("image/png");
    expect(normalizeSendMediaMimeType({ type: "document" })).toBe("application/octet-stream");
    expect(normalizeSendMediaMimeType({ type: "audio", filename: "v.ogg", voiceNote: true })).toBe(
      "audio/ogg; codecs=opus",
    );
  });

  it("detects webp containers", () => {
    expect(isWebp(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe(true);
    expect(isWebp(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it("builds the plugin's vCard", () => {
    expect(buildVCard({ name: "Ana", phone: "+55 11 98888-7777", email: "a@b.c" })).toContain("FN:Ana");
  });
});

describe("error mapping", () => {
  it("maps zod, rate limit, not-connected and generic failures", () => {
    const zodError = z.object({ a: z.string() }).safeParse({}).error;
    expect(toWhatsAppRuntimeError(zodError)).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(toWhatsAppRuntimeError({ statusCode: 429, message: "slow down" })).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
    expect(toWhatsAppRuntimeError(new Error("Connection Closed"))).toBeInstanceOf(WhatsAppRuntimeError);
    expect(toWhatsAppRuntimeError(new Error("boom"))).toMatchObject({ status: 502, code: "TRANSPORT_ERROR" });
    const passthrough = new WhatsAppRuntimeError("NOT_FOUND", "nope");
    expect(toWhatsAppRuntimeError(passthrough)).toBe(passthrough);
    expect(passthrough.toRpcError()).toEqual({ message: "nope", status: 404, code: "NOT_FOUND" });
  });

  it("recognizes transient 'Connection Closed' errors", () => {
    expect(isTransientConnectionClosedError(new Error("Connection Closed"))).toBe(true);
    expect(isTransientConnectionClosedError("connection closed by peer")).toBe(true);
    expect(isTransientConnectionClosedError(new Error("timed out"))).toBe(false);
    expect(isTransientConnectionClosedError(undefined)).toBe(false);
  });
});

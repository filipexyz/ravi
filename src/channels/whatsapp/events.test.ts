import { describe, expect, it } from "bun:test";
import type {
  InboundConnectionConnectedPayload,
  InboundConnectionDisconnectedPayload,
  InboundConnectionQrPayload,
  InboundMessagePayload,
  InboundReactionPayload,
} from "../inbound/types.js";
import { CHANNEL_INBOUND_STREAM, CHANNEL_INBOUND_SUBJECT_PREFIX } from "./contract.js";
import {
  LEGACY_NATIVE_DURABLES,
  parseWhatsAppInboundSubject,
  WHATSAPP_INBOUND_DURABLES,
  WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION,
  WHATSAPP_INBOUND_EVENT_TYPES,
  WHATSAPP_INBOUND_SUBJECT_ROOT,
  type WhatsAppInboundEvent,
  WhatsAppInboundEventSchema,
  whatsappInboundKindOf,
  whatsappInboundSubject,
} from "./events.js";

const ID = "0b7c3d1e-1111-4222-8333-944455556666";

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `whatsapp-baileys:${ID}:3EB0ABC:message`,
    instanceId: ID,
    timestamp: 1_760_000_000_000,
    receivedAt: 1_759_999_999_900,
    type: "message.received",
    ingestMode: "realtime",
    payload: {
      externalId: "3EB0ABC",
      chatId: "5511999999999@s.whatsapp.net",
      from: "5511999999999@s.whatsapp.net",
      senderName: "Luis",
      content: { type: "text", text: "oi" },
      platformTimestamp: 1_760_000_000,
      rawPayload: { key: { id: "3EB0ABC" } },
    },
    ...overrides,
  };
}

describe("WhatsApp inbound subjects", () => {
  it("builds subjects under the WhatsApp root of CHANNEL_INBOUND", () => {
    expect(WHATSAPP_INBOUND_SUBJECT_ROOT).toBe("ravi.channel.inbound.whatsapp.");
    expect(WHATSAPP_INBOUND_SUBJECT_ROOT.startsWith(CHANNEL_INBOUND_SUBJECT_PREFIX)).toBe(true);
    expect(whatsappInboundSubject("message", ID)).toBe(`ravi.channel.inbound.whatsapp.message.${ID}`);
    expect(whatsappInboundSubject("reaction", ID)).toBe(`ravi.channel.inbound.whatsapp.reaction.${ID}`);
    expect(whatsappInboundSubject("connection", ID)).toBe(`ravi.channel.inbound.whatsapp.connection.${ID}`);
  });

  it("rejects instance ids that are not NATS-safe", () => {
    expect(() => whatsappInboundSubject("message", "a b")).toThrow();
    expect(() => whatsappInboundSubject("message", "a.>")).toThrow();
    expect(() => whatsappInboundSubject("message", "")).toThrow();
  });

  it("parses its own subjects back", () => {
    for (const kind of ["message", "reaction", "connection"] as const) {
      expect(parseWhatsAppInboundSubject(whatsappInboundSubject(kind, ID))).toEqual({ kind, instanceId: ID });
    }
  });

  it("returns null outside the root, for unknown kinds and without an instance id", () => {
    expect(parseWhatsAppInboundSubject(`message.received.whatsapp-baileys.${ID}`)).toBeNull();
    expect(parseWhatsAppInboundSubject(`ravi.channel.inbound.message.received.whatsapp-baileys.${ID}`)).toBeNull();
    expect(parseWhatsAppInboundSubject(`ravi.channel.inbound.whatsapp.presence.${ID}`)).toBeNull();
    expect(parseWhatsAppInboundSubject("ravi.channel.inbound.whatsapp.message.")).toBeNull();
    expect(parseWhatsAppInboundSubject("ravi.channel.inbound.whatsapp.message")).toBeNull();
    expect(parseWhatsAppInboundSubject("ravi.channel.inbound.whatsapp.")).toBeNull();
  });
});

describe("WhatsApp inbound durables", () => {
  it("defines one durable per kind on CHANNEL_INBOUND, filtered to that kind", () => {
    expect(WHATSAPP_INBOUND_DURABLES).toEqual({
      message: {
        stream: "CHANNEL_INBOUND",
        durable: "ravi-whatsapp-messages",
        filterSubject: "ravi.channel.inbound.whatsapp.message.>",
      },
      reaction: {
        stream: "CHANNEL_INBOUND",
        durable: "ravi-whatsapp-reactions",
        filterSubject: "ravi.channel.inbound.whatsapp.reaction.>",
      },
      connection: {
        stream: "CHANNEL_INBOUND",
        durable: "ravi-whatsapp-connection",
        filterSubject: "ravi.channel.inbound.whatsapp.connection.>",
      },
    });
    expect(WHATSAPP_INBOUND_DURABLES.message.stream).toBe(CHANNEL_INBOUND_STREAM);
  });

  it("names the PR #590 durables for cleanup", () => {
    expect(LEGACY_NATIVE_DURABLES).toEqual(["ravi-native-messages", "ravi-native-instances", "ravi-native-reactions"]);
  });

  it("maps every event type to the kind whose durable receives it", () => {
    expect(WHATSAPP_INBOUND_EVENT_TYPES.map((type) => [type, whatsappInboundKindOf(type)])).toEqual([
      ["message.received", "message"],
      ["reaction.received", "reaction"],
      ["connection.qr", "connection"],
      ["connection.connected", "connection"],
      ["connection.disconnected", "connection"],
    ]);
  });
});

describe("WhatsAppInboundEventSchema", () => {
  it("accepts a message and keeps payload fields and extras untouched", () => {
    const raw = messageEvent({
      payload: { ...messageEvent().payload, content: { type: "audio", localPath: "/tmp/a.ogg", extra: 1 } },
    });
    const parsed = WhatsAppInboundEventSchema.parse(raw);

    expect(parsed).toEqual(raw as WhatsAppInboundEvent);
    expect(WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("accepts reactions and every connection event", () => {
    const base = { schemaVersion: 1, id: "e1", instanceId: ID, timestamp: 1 };
    const events = [
      {
        ...base,
        type: "reaction.received",
        payload: { messageId: "3EB0ABC", chatId: "c@s.whatsapp.net", from: "f@s.whatsapp.net", emoji: "👍" },
      },
      { ...base, type: "connection.qr", payload: { qrCode: "2@abc", expiresAt: 2 } },
      { ...base, type: "connection.connected", payload: { profileName: "Ravi", ownerIdentifier: "5511" } },
      { ...base, type: "connection.disconnected", payload: { reason: "closed", willReconnect: true } },
    ];
    for (const event of events) {
      expect(WhatsAppInboundEventSchema.parse(event)).toEqual(event as WhatsAppInboundEvent);
    }
  });

  it("requires ingestMode on messages", () => {
    const { ingestMode: _ingestMode, ...withoutMode } = messageEvent();
    expect(WhatsAppInboundEventSchema.safeParse(withoutMode).success).toBe(false);
    expect(WhatsAppInboundEventSchema.safeParse(messageEvent({ ingestMode: "live" })).success).toBe(false);
    expect(WhatsAppInboundEventSchema.safeParse(messageEvent({ ingestMode: "history-sync" })).success).toBe(true);
  });

  it("rejects other schema versions, unknown types and the old Omni envelope", () => {
    expect(WhatsAppInboundEventSchema.safeParse(messageEvent({ schemaVersion: 2 })).success).toBe(false);
    expect(WhatsAppInboundEventSchema.safeParse(messageEvent({ type: "instance.qr_code" })).success).toBe(false);
    expect(
      WhatsAppInboundEventSchema.safeParse({
        id: "e1",
        type: "message.received",
        payload: messageEvent().payload,
        metadata: { instanceId: ID, channelType: "whatsapp-baileys", source: "ravi.whatsapp.native" },
        timestamp: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects payloads missing required fields", () => {
    expect(
      WhatsAppInboundEventSchema.safeParse(
        messageEvent({ payload: { chatId: "c", from: "f", content: { type: "x" } } }),
      ).success,
    ).toBe(false);
    expect(
      WhatsAppInboundEventSchema.safeParse({
        schemaVersion: 1,
        id: "e1",
        instanceId: ID,
        timestamp: 1,
        type: "connection.disconnected",
        payload: { reason: "closed" },
      }).success,
    ).toBe(false);
  });

  it("produces payloads the neutral inbound contract accepts", () => {
    const event = WhatsAppInboundEventSchema.parse(messageEvent());
    if (event.type !== "message.received") throw new Error("expected a message");
    const message: InboundMessagePayload = event.payload;
    expect(message.externalId).toBe("3EB0ABC");

    type PayloadOf<T extends WhatsAppInboundEvent["type"]> = Extract<WhatsAppInboundEvent, { type: T }>["payload"];
    const checks: [
      InboundReactionPayload,
      InboundConnectionQrPayload,
      InboundConnectionConnectedPayload,
      InboundConnectionDisconnectedPayload,
    ] = [
      {} as PayloadOf<"reaction.received">,
      {} as PayloadOf<"connection.qr">,
      {} as PayloadOf<"connection.connected">,
      {} as PayloadOf<"connection.disconnected">,
    ];
    expect(checks).toHaveLength(4);
  });
});

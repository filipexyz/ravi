import { describe, expect, it } from "bun:test";

import {
  CHAT_TOPIC_PATTERNS,
  INSTANCE_TOPIC_PATTERNS,
  classifyChatEvent,
  defaultStreamChannels,
  extractChatId,
  extractInstanceId,
  isNoiseEventsTopic,
  projectChatEvents,
  projectInstanceEvents,
  projectWhatsAppInbound,
} from "./channels.js";
import type { StreamEvent } from "./types.js";

function urlFor(path: string): URL {
  return new URL(`http://test${path}`);
}

function matchChannel(path: string) {
  const segments = path.split("/").filter(Boolean);
  for (const channel of defaultStreamChannels) {
    const match = channel.match(segments, urlFor(`/${path}`));
    if (match) return { channel, match };
  }
  return null;
}

async function* feed(items: { topic: string; data: Record<string, unknown> }[]) {
  for (const item of items) yield item;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("channel routing", () => {
  it("matches chats/<chatId> with view chat:<chatId> scope", () => {
    const matched = matchChannel("chats/55119@s.whatsapp.net");
    expect(matched).not.toBeNull();
    expect(matched!.channel.name).toBe("chats");
    expect(matched!.match.scope).toEqual({
      permission: "view",
      objectType: "chat",
      objectId: "55119@s.whatsapp.net",
    });
  });

  it("matches instances/<instanceId> with view instance:<id> scope", () => {
    const matched = matchChannel("instances/abc-uuid-123");
    expect(matched).not.toBeNull();
    expect(matched!.channel.name).toBe("instances");
    expect(matched!.match.scope).toEqual({
      permission: "view",
      objectType: "instance",
      objectId: "abc-uuid-123",
    });
  });

  it("rejects chats/ without an id", () => {
    expect(matchChannel("chats")).toBeNull();
  });

  it("rejects nested chats segments", () => {
    expect(matchChannel("chats/a/b")).toBeNull();
  });
});

describe("extractChatId", () => {
  it("reads payload.chatId from omni envelope", () => {
    expect(extractChatId({ payload: { chatId: "abc" } })).toBe("abc");
  });

  it("falls back to top-level chatId", () => {
    expect(extractChatId({ chatId: "flat" })).toBe("flat");
  });

  it("returns undefined when missing", () => {
    expect(extractChatId({ payload: {} })).toBeUndefined();
    expect(extractChatId({})).toBeUndefined();
  });

  it("ignores non-string chatId", () => {
    expect(extractChatId({ chatId: 123 as unknown as string })).toBeUndefined();
  });
});

describe("extractInstanceId", () => {
  it("reads payload.instanceId", () => {
    expect(extractInstanceId("instance.qr_code.whatsapp.uuid-1", { payload: { instanceId: "uuid-1" } })).toBe("uuid-1");
  });

  it("falls back to metadata.instanceId", () => {
    expect(extractInstanceId("instance.connected.whatsapp.x", { metadata: { instanceId: "from-meta" } })).toBe(
      "from-meta",
    );
  });

  it("falls back to subject suffix when no payload/metadata", () => {
    expect(extractInstanceId("instance.qr_code.whatsapp-baileys.uuid-9", {})).toBe("uuid-9");
  });

  it("returns undefined when subject is too short and no payload", () => {
    expect(extractInstanceId("instance.short", {})).toBeUndefined();
  });
});

describe("classifyChatEvent", () => {
  it.each([
    ["message.received.whatsapp.x", "message"],
    ["reaction.received.whatsapp.x", "reaction"],
    ["presence.typing", "presence"],
    ["chat.unread-updated", "unread"],
  ])("topic %s -> %s", (topic, expected) => {
    expect(classifyChatEvent(topic)).toBe(expected);
  });
});

describe("projectChatEvents", () => {
  it("only yields events matching the requested chatId", async () => {
    const events = await collect(
      projectChatEvents(
        "chat-1",
        feed([
          { topic: "message.received.whatsapp.x", data: { payload: { chatId: "chat-1", text: "hi" } } },
          { topic: "message.received.whatsapp.x", data: { payload: { chatId: "chat-2", text: "nope" } } },
          { topic: "reaction.received.whatsapp.x", data: { payload: { chatId: "chat-1", emoji: "👍" } } },
          { topic: "presence.typing", data: { chatId: "chat-1", isTyping: true } },
          { topic: "chat.unread-updated", data: { chatId: "chat-3", unread: 2 } },
        ]),
      ),
    );

    expect(events).toHaveLength(3);
    expect(events.map((e: StreamEvent) => e.event)).toEqual(["message", "reaction", "presence"]);
    for (const event of events) {
      const data = event.data as { chatId: string; type: string };
      expect(data.chatId).toBe("chat-1");
      expect(data.type).toBe("chat.event");
    }
  });

  it("preserves the upstream topic and data for downstream consumers", async () => {
    const [event] = await collect(
      projectChatEvents(
        "chat-1",
        feed([
          {
            topic: "message.received.whatsapp.inst",
            data: { payload: { chatId: "chat-1", content: { text: "hello" } } },
          },
        ]),
      ),
    );
    const data = event.data as { topic: string; data: Record<string, unknown> };
    expect(data.topic).toBe("message.received.whatsapp.inst");
    expect(data.data).toEqual({ payload: { chatId: "chat-1", content: { text: "hello" } } });
  });
});

describe("projectInstanceEvents", () => {
  it("filters by instanceId from payload, metadata, or subject", async () => {
    const events = await collect(
      projectInstanceEvents(
        "inst-1",
        feed([
          { topic: "instance.qr_code.whatsapp.inst-1", data: { payload: { instanceId: "inst-1", qrCode: "abc" } } },
          { topic: "instance.connected.whatsapp.inst-2", data: { payload: { instanceId: "inst-2" } } },
          { topic: "instance.qr_code.whatsapp.inst-1", data: { metadata: { instanceId: "inst-1" } } },
          { topic: "instance.qr_code.whatsapp.inst-1", data: {} },
        ]),
      ),
    );

    expect(events).toHaveLength(3);
    for (const event of events) {
      const data = event.data as { instanceId: string; type: string };
      expect(data.instanceId).toBe("inst-1");
      expect(data.type).toBe("instance.event");
    }
  });

  it("drops events when instanceId cannot be resolved", async () => {
    const events = await collect(
      projectInstanceEvents("inst-1", feed([{ topic: "instance.unknown", data: { something: "else" } }])),
    );
    expect(events).toHaveLength(0);
  });
});

const WA_INSTANCE = "5f1c2d3e-0000-4000-8000-00000000abcd";
const WA_CHAT = "5511999999999@s.whatsapp.net";

function waMessage(overrides: Record<string, unknown> = {}) {
  return {
    topic: `ravi.channel.inbound.whatsapp.message.${WA_INSTANCE}`,
    data: {
      schemaVersion: 1,
      id: "msg-1",
      instanceId: WA_INSTANCE,
      timestamp: 1_700_000_000_000,
      receivedAt: 1_699_999_999_000,
      type: "message.received",
      ingestMode: "realtime",
      payload: {
        externalId: "ABC",
        chatId: WA_CHAT,
        from: "5511999999999@s.whatsapp.net",
        content: { type: "text", text: "oi" },
        rawPayload: { key: { id: "ABC" } },
      },
      ...overrides,
    },
  };
}

function waReaction() {
  return {
    topic: `ravi.channel.inbound.whatsapp.reaction.${WA_INSTANCE}`,
    data: {
      schemaVersion: 1,
      id: "react-1",
      instanceId: WA_INSTANCE,
      timestamp: 1_700_000_000_001,
      type: "reaction.received",
      payload: { messageId: "ABC", chatId: WA_CHAT, from: "5511888888888@s.whatsapp.net", emoji: "👍" },
    },
  };
}

function waConnection(type: string, payload: Record<string, unknown>) {
  return {
    topic: `ravi.channel.inbound.whatsapp.connection.${WA_INSTANCE}`,
    data: {
      schemaVersion: 1,
      id: `conn-${type}`,
      instanceId: WA_INSTANCE,
      timestamp: 1_700_000_000_002,
      type,
      payload,
    },
  };
}

describe("WhatsApp runner inbound projection", () => {
  it("subscribes chat and instance streams to the WhatsApp runner subjects", () => {
    expect(CHAT_TOPIC_PATTERNS).toContain("ravi.channel.inbound.whatsapp.message.>");
    expect(CHAT_TOPIC_PATTERNS).toContain("ravi.channel.inbound.whatsapp.reaction.>");
    expect(CHAT_TOPIC_PATTERNS).toContain("message.received.>");
    expect(INSTANCE_TOPIC_PATTERNS).toContain("ravi.channel.inbound.whatsapp.connection.>");
    expect(INSTANCE_TOPIC_PATTERNS).toContain("instance.>");
  });

  it("projects a message onto the existing envelope and Omni-shaped topic", () => {
    expect(projectWhatsAppInbound(waMessage())).toEqual({
      topic: `message.received.whatsapp-baileys.${WA_INSTANCE}`,
      data: {
        id: "msg-1",
        type: "message.received",
        payload: {
          externalId: "ABC",
          chatId: WA_CHAT,
          from: "5511999999999@s.whatsapp.net",
          content: { type: "text", text: "oi" },
          rawPayload: { key: { id: "ABC" } },
        },
        metadata: {
          instanceId: WA_INSTANCE,
          channelType: "whatsapp-baileys",
          ingestMode: "realtime",
          receivedAt: 1_699_999_999_000,
        },
        timestamp: 1_700_000_000_000,
      },
    });
  });

  it("projects connection events with instanceId/channelType back on the payload", () => {
    expect(projectWhatsAppInbound(waConnection("connection.qr", { qrCode: "qr-data", expiresAt: 5 }))).toEqual({
      topic: `instance.qr_code.whatsapp-baileys.${WA_INSTANCE}`,
      data: {
        id: "conn-connection.qr",
        type: "instance.qr_code",
        payload: { qrCode: "qr-data", expiresAt: 5, instanceId: WA_INSTANCE, channelType: "whatsapp-baileys" },
        metadata: { instanceId: WA_INSTANCE, channelType: "whatsapp-baileys" },
        timestamp: 1_700_000_000_002,
      },
    });
    expect(projectWhatsAppInbound(waConnection("connection.connected", { profileName: "Ravi" }))?.topic).toBe(
      `instance.connected.whatsapp-baileys.${WA_INSTANCE}`,
    );
    expect(
      projectWhatsAppInbound(waConnection("connection.disconnected", { reason: "closed", willReconnect: true }))?.data,
    ).toMatchObject({ type: "instance.disconnected", payload: { reason: "closed", willReconnect: true } });
  });

  it("skips an invalid envelope, an unknown subject and a subject/instance mismatch", () => {
    expect(projectWhatsAppInbound(waMessage({ schemaVersion: 2 }))).toBeNull();
    expect(projectWhatsAppInbound(waMessage({ payload: { chatId: WA_CHAT } }))).toBeNull();
    expect(projectWhatsAppInbound(waMessage({ instanceId: "other-instance" }))).toBeNull();
    expect(projectWhatsAppInbound({ topic: "ravi.channel.inbound.whatsapp.presence.x", data: {} })).toBeNull();
    expect(projectWhatsAppInbound({ topic: "ravi.channel.inbound.whatsapp.message", data: {} })).toBeNull();
  });

  it("passes non-WhatsApp-runner topics through unchanged", () => {
    const item = { topic: "message.received.telegram.inst", data: { payload: { chatId: "c" } } };
    expect(projectWhatsAppInbound(item)).toBe(item);
  });

  it("yields WhatsApp messages and reactions on the chat stream with the existing topic and event names", async () => {
    const events = await collect(
      projectChatEvents(
        WA_CHAT,
        feed([
          waMessage(),
          waReaction(),
          waMessage({
            payload: { externalId: "X", chatId: "other@s.whatsapp.net", from: "f", content: { type: "text" } },
          }),
          waMessage({ schemaVersion: 99 }),
        ]),
      ),
    );

    expect(events.map((event) => event.event)).toEqual(["message", "reaction"]);
    const [message, reaction] = events.map((event) => event.data as { topic: string; data: Record<string, unknown> });
    expect(message?.topic).toBe(`message.received.whatsapp-baileys.${WA_INSTANCE}`);
    expect(reaction?.topic).toBe(`reaction.received.whatsapp-baileys.${WA_INSTANCE}`);
    expect(classifyChatEvent(reaction?.topic ?? "")).toBe("reaction");
    expect(reaction?.data).toMatchObject({ type: "reaction.received", payload: { emoji: "👍", chatId: WA_CHAT } });
  });

  it("yields WhatsApp connection events on the instance stream", async () => {
    const events = await collect(
      projectInstanceEvents(
        WA_INSTANCE,
        feed([
          waConnection("connection.qr", { qrCode: "qr", expiresAt: 1 }),
          waConnection("connection.connected", {}),
          { ...waConnection("connection.connected", {}), topic: "ravi.channel.inbound.whatsapp.connection.other" },
          waConnection("connection.bogus", {}),
        ]),
      ),
    );

    expect(events.map((event) => (event.data as { topic: string }).topic)).toEqual([
      `instance.qr_code.whatsapp-baileys.${WA_INSTANCE}`,
      `instance.connected.whatsapp-baileys.${WA_INSTANCE}`,
    ]);
    for (const event of events) {
      expect((event.data as { instanceId: string }).instanceId).toBe(WA_INSTANCE);
    }
  });

  it("resolves the instance id of a projected event from its payload and from the rewritten subject", () => {
    const projected = projectWhatsAppInbound(waConnection("connection.connected", {}));
    expect(projected).not.toBeNull();
    expect(extractInstanceId(projected?.topic ?? "", projected?.data ?? {})).toBe(WA_INSTANCE);
    expect(extractInstanceId(projected?.topic ?? "", {})).toBe(WA_INSTANCE);
  });
});

describe("events channel noise filter", () => {
  it("hides runner inbound and RPC subjects unless selected", () => {
    for (const topic of [
      `ravi.channel.inbound.whatsapp.message.${WA_INSTANCE}`,
      `_RAVI.channels.whatsapp.rpc.${WA_INSTANCE}`,
    ]) {
      expect(isNoiseEventsTopic(topic)).toBe(true);
      expect(isNoiseEventsTopic(topic, { selected: true })).toBe(false);
    }
  });

  it("keeps the existing suppressions and lets curated topics through", () => {
    for (const topic of [
      "message.received.x.y",
      "reaction.received.x.y",
      "instance.connected.x.y",
      "presence.typing",
    ]) {
      expect(isNoiseEventsTopic(topic, { selected: true })).toBe(true);
    }
    expect(isNoiseEventsTopic("ravi.inbound.reaction")).toBe(false);
    expect(isNoiseEventsTopic(`ravi.whatsapp.qr.${WA_INSTANCE}`)).toBe(false);
  });
});

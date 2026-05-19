import { describe, expect, it } from "bun:test";

import {
  classifyChatEvent,
  defaultStreamChannels,
  extractChatId,
  extractInstanceId,
  projectChatEvents,
  projectInstanceEvents,
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

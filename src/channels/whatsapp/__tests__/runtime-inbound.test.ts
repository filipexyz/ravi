/**
 * WhatsAppRuntime inbound path: Baileys events → `WhatsAppInboundEvent`s (events.ts) on
 * CHANNEL_INBOUND. Ports the plugin-level tests of omni packages/channel-whatsapp
 * (inbound-dedup, history-sync, reaction-echo, delete-echo, message-edit-*,
 * sender-instance, quoted-context, lid-mapping-publish-delta, silent-prekey-error,
 * media-remote-ingest, history-media-download), plus the inbound contract check.
 */

import { describe, expect, it, mock } from "bun:test";
import type { WAMessage } from "baileys";
import {
  WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION,
  WhatsAppInboundEventSchema,
  whatsappInboundSubject,
} from "../events.js";
import { deterministicEventId, messageIdempotencyKey } from "../runtime-events.js";
import { OWNER_JID, OWNER_LID, createHarness, flush } from "./runtime-harness.js";

const DM_PHONE = "555197285829@s.whatsapp.net";
const DM_LID = "217046273028329@lid";
const PLAIN_DM = "5511988887777@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

function upsert(messages: unknown[], type: "notify" | "append" = "notify") {
  return { type, messages };
}

function textMessage(id: string, remoteJid: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    key: { id, remoteJid, fromMe: false, ...(extra.key as Record<string, unknown> | undefined) },
    messageTimestamp: 1_750_000_000,
    pushName: "Ana",
    message: { conversation: text },
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "key")),
  };
}

describe("WhatsApp inbound contract", () => {
  it("message.received: subject, msgID, envelope and payload fields match the inbound contract", async () => {
    const h = createHarness();
    const sock = await h.connect();
    h.clock.now = 1_750_000_123_000;
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "MSG-1", remoteJid: DM_PHONE, remoteJidAlt: DM_LID, fromMe: false },
          messageTimestamp: 1_750_000_100,
          pushName: "Ana",
          message: { conversation: "oi" },
        },
      ]),
    );
    await flush();

    const records = h.publishedOfType("message.received");
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("missing record");
    const expectedId = deterministicEventId(messageIdempotencyKey(h.instanceId, "MSG-1", "text"));

    expect(record.subject).toBe(`ravi.channel.inbound.whatsapp.message.${h.instanceId}`);
    expect(record.subject).toBe(whatsappInboundSubject("message", h.instanceId));
    expect(record.msgID).toBe(expectedId);
    expect(WhatsAppInboundEventSchema.safeParse(record.event).success).toBe(true);

    const envelope = JSON.parse(record.raw) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual([
      "schemaVersion",
      "id",
      "instanceId",
      "timestamp",
      "receivedAt",
      "type",
      "ingestMode",
      "payload",
    ]);
    expect(envelope).toMatchObject({
      schemaVersion: WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION,
      id: expectedId,
      instanceId: h.instanceId,
      type: "message.received",
      ingestMode: "realtime",
      timestamp: 1_750_000_123_000,
    });
    expect(typeof envelope.receivedAt).toBe("number");

    const payload = envelope.payload as Record<string, unknown>;
    // Payload field order unchanged, undefined members dropped by JSON.
    expect(Object.keys(payload)).toEqual([
      "externalId",
      "chatId",
      "from",
      "senderName",
      "chatName",
      "content",
      "rawPayload",
    ]);
    expect(payload.externalId).toBe("MSG-1");
    expect(payload.chatId).toBe(DM_LID);
    expect(payload.from).toBe("217046273028329");
    expect(payload.senderName).toBe("Ana");
    // The sender's pushName is cached first, so a DM resolves its chat name.
    expect(payload.chatName).toBe("Ana");
    expect(payload.content).toEqual({ type: "text", text: "oi" });
    const raw = payload.rawPayload as Record<string, unknown>;
    expect(raw.isFromMe).toBe(false);
    expect((raw.key as Record<string, unknown>).id).toBe("MSG-1");
    expect(raw.senderIsLid).toBe(true);
    expect(raw.resolvedSenderPhone).toBe("555197285829");
  });

  it("group message: chatName, isGroup, mentions and isMentioningInstance in rawPayload", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("groups.upsert", [{ id: GROUP, subject: "Equipe", participants: [] }]);
    sock.emit("contacts.upsert", [{ id: "5511777776666@s.whatsapp.net", notify: "Bia" }]);
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "MSG-G1", remoteJid: GROUP, fromMe: false, participant: "5511777776666@s.whatsapp.net" },
          messageTimestamp: 1_750_000_100,
          pushName: "Bia",
          message: {
            extendedTextMessage: {
              text: "@5511999990000 olha isso",
              contextInfo: { mentionedJid: ["5511999990000@s.whatsapp.net"] },
            },
          },
        },
      ]),
    );
    await flush();

    const payload = h.publishedOfType("message.received")[0]?.event.payload as Record<string, unknown>;
    expect(payload.chatId).toBe(GROUP);
    expect(payload.from).toBe("5511777776666");
    expect(payload.chatName).toBe("Equipe");
    const raw = payload.rawPayload as Record<string, unknown>;
    expect(raw.chatName).toBe("Equipe");
    expect(raw.isGroup).toBe(true);
    expect(raw.mentionedJids).toEqual(["5511999990000@s.whatsapp.net"]);
    expect(raw.mentionedContacts).toEqual([{ jid: "5511999990000@s.whatsapp.net", name: "Ravi Bot" }]);
    expect(raw.isMentioningInstance).toBe(true);
  });

  it("connection.disconnected and reaction.received carry the contract payload keys", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messages.reaction", [
      {
        key: { id: "MSG-1", remoteJid: PLAIN_DM },
        reaction: { key: { id: "R-1", remoteJid: PLAIN_DM, fromMe: false }, text: "👍" },
      },
    ]);
    await flush();
    await h.runtime.disconnect();

    const reaction = h.publishedOfType("reaction.received")[0];
    expect(reaction?.event.payload).toEqual({
      messageId: "MSG-1",
      chatId: PLAIN_DM,
      from: "5511988887777",
      emoji: "👍",
      rawPayload: { externalId: "R-1", isFromMe: false },
    });
    expect(reaction?.subject).toBe(`ravi.channel.inbound.whatsapp.reaction.${h.instanceId}`);
    expect(reaction?.event).not.toHaveProperty("ingestMode");
    const disconnected = h.publishedOfType("connection.disconnected")[0];
    expect(disconnected?.subject).toBe(`ravi.channel.inbound.whatsapp.connection.${h.instanceId}`);
    expect(disconnected?.event.instanceId).toBe(h.instanceId);
    expect(Object.keys(disconnected?.event.payload ?? {})).toEqual(["reason", "willReconnect"]);
  });

  it("only inbound contract types reach CHANNEL_INBOUND; the rest stay observer-only", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("presence.update", { id: PLAIN_DM, presences: { [PLAIN_DM]: { lastKnownPresence: "composing" } } });
    sock.emit("chats.upsert", [{ id: PLAIN_DM, name: "Carla", unreadCount: 3 }]);
    await flush();
    const publishedTypes = new Set(h.published.map((record) => record.event.type));
    expect([...publishedTypes].sort()).toEqual(["connection.connected"]);
    expect(h.observedOfType("custom.chat.unread-updated")[0]?.payload).toEqual({ chatId: PLAIN_DM, unreadCount: 3 });
  });
});

describe("inbound dedup", () => {
  it("drops a redelivered upsert on the same connection", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const message = textMessage("MSG-DUP", PLAIN_DM, "hello");
    sock.emit("messages.upsert", upsert([message]));
    sock.emit("messages.upsert", upsert([message]));
    await flush();
    expect(h.publishedOfType("message.received")).toHaveLength(1);
  });

  it("republishes the same msgID after a reconnect so JetStream collapses it", async () => {
    const h = createHarness();
    const first = await h.connect();
    const message = textMessage("MSG-RECONNECT", PLAIN_DM, "hello");
    first.emit("messages.upsert", upsert([message]));
    await flush();
    first.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: Object.assign(new Error("closed"), { output: { statusCode: 428 } }), date: new Date() },
    });
    await flush(30);
    const second = h.socket();
    expect(second).not.toBe(first);
    second.emit("connection.update", { connection: "open" });
    second.emit("messages.upsert", upsert([message]));
    await flush();

    const records = h.publishedOfType("message.received");
    expect(records).toHaveLength(2);
    expect(records[0]?.msgID).toBe(records[1]?.msgID);
  });

  it("filters our own sends echoed back by Baileys", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const sent = await h.runtime.call("messages.sendText", { to: PLAIN_DM, text: "oi" });
    sock.emit(
      "messages.upsert",
      upsert([
        {
          ...textMessage(sent.messageId, PLAIN_DM, "oi"),
          key: { id: sent.messageId, remoteJid: PLAIN_DM, fromMe: true },
        },
      ]),
    );
    await flush();
    expect(h.publishedOfType("message.received")).toHaveLength(0);
  });

  it("subscribes to DM presence once per chat", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messages.upsert", upsert([textMessage("P-1", PLAIN_DM, "a"), textMessage("P-2", PLAIN_DM, "b")]));
    await flush();
    expect(sock.fake.presenceSubscribe).toHaveBeenCalledTimes(1);
    expect(sock.fake.presenceSubscribe).toHaveBeenCalledWith(PLAIN_DM);
  });
});

describe("offline backlog and history sync", () => {
  const modesOf = (h: ReturnType<typeof createHarness>) =>
    Object.fromEntries(
      h
        .publishedOfType("message.received")
        .map((record) => [(record.event.payload as { externalId: string }).externalId, record.event.ingestMode]),
    );
  /** Seconds-resolution messageTimestamp `ageMs` before the harness clock. */
  const sentAgo = (h: ReturnType<typeof createHarness>, ageMs: number) => Math.floor((h.clock.now - ageMs) / 1000);

  it("offline backlog (`append`) is age-aware: recent → realtime, older than offlineStaleMs → history-sync", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert(
        [
          textMessage("OFF-RECENT", PLAIN_DM, "sent during a 2 min gap", { messageTimestamp: sentAgo(h, 2 * 60_000) }),
          textMessage("OFF-EDGE", PLAIN_DM, "just under 10 min", { messageTimestamp: sentAgo(h, 9 * 60_000) }),
          textMessage("OFF-OLD", PLAIN_DM, "an hour ago", { messageTimestamp: sentAgo(h, 60 * 60_000) }),
          textMessage("OFF-LONG", PLAIN_DM, "protobuf Long", {
            messageTimestamp: { toNumber: () => sentAgo(h, 11 * 60_000) },
          }),
          textMessage("OFF-NOTS", PLAIN_DM, "no timestamp", { messageTimestamp: undefined }),
        ],
        "append",
      ),
    );
    sock.emit("messages.upsert", upsert([textMessage("RT-1", PLAIN_DM, "now")], "notify"));
    await flush();
    expect(modesOf(h)).toEqual({
      "OFF-RECENT": "realtime",
      "OFF-EDGE": "realtime",
      "OFF-OLD": "history-sync",
      "OFF-LONG": "history-sync",
      "OFF-NOTS": "history-sync",
      "RT-1": "realtime",
    });
  });

  it("offlineStaleMs moves the threshold", async () => {
    const h = createHarness({ offlineStaleMs: 60_000 });
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert(
        [
          textMessage("OFF-30S", PLAIN_DM, "a", { messageTimestamp: sentAgo(h, 30_000) }),
          textMessage("OFF-2M", PLAIN_DM, "b", { messageTimestamp: sentAgo(h, 2 * 60_000) }),
        ],
        "append",
      ),
    );
    await flush();
    expect(modesOf(h)).toEqual({ "OFF-30S": "realtime", "OFF-2M": "history-sync" });
  });

  it('offlineIngestMode "history-sync" is the explicit opt-in to never answer offline backlog', async () => {
    const h = createHarness({ offlineIngestMode: "history-sync" });
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert([textMessage("OFF-1", PLAIN_DM, "1 s ago", { messageTimestamp: sentAgo(h, 1_000) })], "append"),
    );
    await flush();
    expect(modesOf(h)).toEqual({ "OFF-1": "history-sync" });
  });

  it("offlineIngestMode can keep offline backlog realtime", async () => {
    const h = createHarness({ offlineIngestMode: "realtime" });
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert([textMessage("OFF-2", PLAIN_DM, "late", { messageTimestamp: sentAgo(h, 24 * 3_600_000) })], "append"),
    );
    await flush();
    expect(h.publishedOfType("message.received")[0]?.event.ingestMode).toBe("realtime");
  });

  it("messaging-history.set publishes history-sync messages and fills chat/contact caches", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messaging-history.set", {
      chats: [{ id: PLAIN_DM, name: "Carla", unreadCount: 2 }],
      contacts: [{ id: DM_LID, phoneNumber: DM_PHONE, notify: "Ana" }],
      messages: [
        textMessage("H-1", PLAIN_DM, "old one"),
        {
          key: { id: "H-2", remoteJid: GROUP, fromMe: false, participant: "5511777776666@s.whatsapp.net" },
          messageTimestamp: 1_740_000_000,
          message: { imageMessage: { mimetype: "image/png", caption: "foto" } },
        },
        { key: { id: "H-NO-TS", remoteJid: PLAIN_DM }, message: { conversation: "skip me" } },
        { key: { id: "H-EMPTY", remoteJid: PLAIN_DM }, messageTimestamp: 1_740_000_000, message: {} },
      ],
      isLatest: true,
      progress: 100,
      syncType: 2,
    });
    await flush();

    const records = h.publishedOfType("message.received");
    expect(records.map((record) => (record.event.payload as { externalId: string }).externalId).sort()).toEqual([
      "H-1",
      "H-2",
    ]);
    for (const record of records) expect(record.event.ingestMode).toBe("history-sync");
    const h1 = records.find((record) => (record.event.payload as { externalId: string }).externalId === "H-1");
    expect(h1?.event.payload).toMatchObject({
      chatId: PLAIN_DM,
      from: "5511988887777",
      senderName: "Ana",
      chatName: "Carla",
      content: { type: "text", text: "old one" },
    });
    const h2 = records.find((record) => (record.event.payload as { externalId: string }).externalId === "H-2");
    expect(h2?.event.payload).toMatchObject({
      from: "5511777776666",
      content: { type: "image", text: "foto", mimeType: "image/png" },
    });

    expect(h.observedOfType("custom.lid-mapping.batch")[0]?.payload).toEqual({
      mappings: [{ lidJid: DM_LID, phoneJid: DM_PHONE }],
    });
    expect(h.observedOfType("sync.completed")[0]?.payload).toMatchObject({ jobType: "history-push", totalFetched: 4 });
    expect(h.runtime.getLidMappingCache().get(DM_PHONE)).toBe(DM_LID);
  });

  it("downloads history media into the runtime media dir when enabled", async () => {
    const tryDownloadMedia = mock(async () => ({
      mediaUrl: "file:///state/media/whatsapp/H-3.jpg",
      mediaLocalPath: "/state/media/whatsapp/H-3.jpg",
      mimeType: "image/jpeg",
      size: 10,
    }));
    const h = createHarness({ historyDownloadMedia: true, library: { tryDownloadMedia } });
    const sock = await h.connect();
    sock.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { id: "H-3", remoteJid: PLAIN_DM, fromMe: false },
          messageTimestamp: 1_740_000_000,
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
      ],
      isLatest: false,
    });
    await flush();
    expect(tryDownloadMedia).toHaveBeenCalledTimes(1);
    const options = (tryDownloadMedia.mock.calls[0] as unknown[])[3] as { baseDir: string };
    expect(options.baseDir).toBe("/tmp/ravi-whatsapp-runtime-test-media");
    const payload = h.publishedOfType("message.received")[0]?.event.payload as Record<string, unknown>;
    expect(payload.content).toEqual({
      type: "image",
      mediaUrl: "file:///state/media/whatsapp/H-3.jpg",
      mimeType: "image/jpeg",
      localPath: "/state/media/whatsapp/H-3.jpg",
    });
    expect((payload.rawPayload as Record<string, unknown>).mediaLocalPath).toBe("/state/media/whatsapp/H-3.jpg");
  });

  it("history media download is off by default", async () => {
    const tryDownloadMedia = mock(async () => null);
    const h = createHarness({ library: { tryDownloadMedia } });
    const sock = await h.connect();
    sock.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { id: "H-4", remoteJid: PLAIN_DM },
          messageTimestamp: 1_740_000_000,
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
      ],
      isLatest: false,
    });
    await flush();
    expect(tryDownloadMedia).not.toHaveBeenCalled();
    expect(h.publishedOfType("message.received")).toHaveLength(1);
  });
});

describe("inbound media", () => {
  it("publishes the file:// mediaUrl plus content.localPath and rawPayload.mediaLocalPath", async () => {
    const h = createHarness();
    await h.connect();
    const raw = {
      key: { id: "IMG-1", remoteJid: PLAIN_DM, fromMe: false },
      message: { imageMessage: { caption: "olha" } },
    } as unknown as WAMessage;
    await h.runtime.handleMessageReceived(
      h.instanceId,
      "IMG-1",
      PLAIN_DM,
      "5511988887777",
      {
        type: "image",
        caption: "olha",
        mediaUrl: "file:///state/media/whatsapp/IMG-1.jpg",
        mediaLocalPath: "/state/media/whatsapp/IMG-1.jpg",
        mimeType: "image/jpeg",
      },
      undefined,
      raw,
      false,
    );
    const payload = h.publishedOfType("message.received")[0]?.event.payload as Record<string, unknown>;
    expect(payload.content).toEqual({
      type: "image",
      text: "olha",
      mediaUrl: "file:///state/media/whatsapp/IMG-1.jpg",
      mimeType: "image/jpeg",
      localPath: "/state/media/whatsapp/IMG-1.jpg",
    });
    expect((payload.rawPayload as Record<string, unknown>).mediaLocalPath).toBe("/state/media/whatsapp/IMG-1.jpg");
    expect(h.runtime.getMediaBaseDir()).toBe("/tmp/ravi-whatsapp-runtime-test-media");
  });
});

describe("reactions", () => {
  it("publishes a reaction reported by both upsert and messages.reaction once", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "R-2", remoteJid: PLAIN_DM, fromMe: false },
          messageTimestamp: 1_750_000_000,
          message: { reactionMessage: { key: { id: "MSG-9", remoteJid: PLAIN_DM, fromMe: true }, text: "❤️" } },
        },
      ]),
    );
    await flush();
    sock.emit("messages.reaction", [
      {
        key: { id: "MSG-9", remoteJid: PLAIN_DM, fromMe: true },
        reaction: { key: { id: "R-2", remoteJid: PLAIN_DM, fromMe: false }, text: "❤️" },
      },
    ]);
    await flush();
    expect(h.publishedOfType("reaction.received")).toHaveLength(1);
  });

  it("skips the echo of our own reaction (#336)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const sent = await h.runtime.call("messages.react", { to: PLAIN_DM, messageId: "MSG-5", emoji: "👍" });
    sock.emit("messages.reaction", [
      {
        key: { id: "MSG-5", remoteJid: PLAIN_DM },
        reaction: { key: { id: sent.messageId, remoteJid: PLAIN_DM, fromMe: true }, text: "👍" },
      },
    ]);
    await flush();
    expect(h.publishedOfType("reaction.received")).toHaveLength(0);
  });

  it("a removed reaction (empty emoji) is observer-only reaction.removed", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messages.reaction", [
      {
        key: { id: "MSG-6", remoteJid: PLAIN_DM },
        reaction: { key: { id: "R-6", remoteJid: PLAIN_DM, fromMe: false }, text: "" },
      },
    ]);
    await flush();
    expect(h.publishedOfType("reaction.received")).toHaveLength(0);
    expect(h.observedOfType("reaction.removed")[0]?.payload).toMatchObject({ messageId: "MSG-6", emoji: "" });
  });
});

describe("edits and deletes", () => {
  it("messages.update edit → message.received edit payload (ported payload shape)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    h.clock.now = 1_750_000_500_000;
    sock.emit("messages.update", [
      {
        key: { id: "MSG-E1", remoteJid: PLAIN_DM, fromMe: false },
        update: { message: { editedMessage: { message: { conversation: "corrigido" } } } },
      },
    ]);
    await flush();
    const record = h.publishedOfType("message.received")[0];
    expect(record?.event.ingestMode).toBe("realtime");
    expect(record?.event.payload).toEqual({
      externalId: "MSG-E1-edit-1750000500000",
      chatId: PLAIN_DM,
      from: PLAIN_DM,
      content: { type: "edit", text: "corrigido" },
      rawPayload: { editedMessageId: "MSG-E1", newText: "corrigido", editedAt: 1_750_000_500_000, isFromMe: false },
    });
  });

  it("own edit synced from the phone is published with isFromMe=true", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messages.update", [
      {
        key: { id: "MSG-E2", remoteJid: PLAIN_DM, fromMe: true },
        update: { message: { editedMessage: { message: { conversation: "eu mesmo" } } } },
      },
    ]);
    await flush();
    const payload = h.publishedOfType("message.received")[0]?.event.payload as
      | { rawPayload: Record<string, unknown> }
      | undefined;
    expect(payload?.rawPayload.isFromMe).toBe(true);
  });

  it("messages.delete → message.received delete payload (ported payload shape)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    h.clock.now = 1_750_000_600_000;
    sock.emit("messages.delete", { keys: [{ id: "MSG-D1", remoteJid: PLAIN_DM, fromMe: false }] });
    await flush();
    expect(h.publishedOfType("message.received")[0]?.event.payload).toEqual({
      externalId: "MSG-D1-delete-1750000600000",
      chatId: PLAIN_DM,
      from: PLAIN_DM,
      content: { type: "delete" },
      rawPayload: { deletedMessageId: "MSG-D1", deletedAt: 1_750_000_600_000, deletedByMe: false, isFromMe: false },
    });
  });

  it("our own delete echo is filtered; a revoke from the phone is published with isFromMe=true", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("messages.delete", { chatId: PLAIN_DM, messageId: "MSG-OLD" });
    const deleteSend = sock.fake.sendMessage.mock.results[0]?.value as Promise<{ key: { id: string } }>;
    const echoId = (await deleteSend).key.id;
    const revoke = (id: string) => ({
      key: { id, remoteJid: PLAIN_DM, fromMe: true },
      messageTimestamp: 1_750_000_000,
      message: { protocolMessage: { type: 0, key: { id: "MSG-OLD", remoteJid: PLAIN_DM, fromMe: true } } },
    });
    sock.emit("messages.upsert", upsert([revoke(echoId)]));
    await flush();
    expect(h.publishedOfType("message.received")).toHaveLength(0);

    sock.emit("messages.upsert", upsert([revoke("PHONE-REVOKE")]));
    await flush();
    const payload = h.publishedOfType("message.received")[0]?.event.payload as { rawPayload: Record<string, unknown> };
    expect(payload.rawPayload).toMatchObject({ deletedMessageId: "MSG-OLD", deletedByMe: true, isFromMe: true });
  });
});

describe("sender instance and quoted context", () => {
  it("marks our own account (phone or LID) as senderInstanceId (#1148)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "SELF-1", remoteJid: GROUP, fromMe: false, participant: OWNER_LID },
          messageTimestamp: 1_750_000_000,
          message: { conversation: "from my other device" },
        },
        {
          key: { id: "SELF-2", remoteJid: PLAIN_DM, fromMe: true },
          messageTimestamp: 1_750_000_000,
          message: { conversation: "typed on the phone" },
        },
        textMessage("OTHER-1", PLAIN_DM, "someone else"),
      ]),
    );
    await flush();
    const byId = Object.fromEntries(
      h.publishedOfType("message.received").map((record) => {
        const payload = record.event.payload as { externalId: string; senderInstanceId?: string };
        return [payload.externalId, payload.senderInstanceId];
      }),
    );
    expect(byId).toEqual({ "SELF-1": h.instanceId, "SELF-2": h.instanceId, "OTHER-1": undefined });
  });

  it("lifts the quoted message with the quoted sender's name into rawPayload (#1090)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("contacts.upsert", [{ id: "5511777776666@s.whatsapp.net", notify: "Bia" }]);
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "Q-1", remoteJid: PLAIN_DM, fromMe: false },
          messageTimestamp: 1_750_000_000,
          message: {
            extendedTextMessage: {
              text: "respondendo",
              contextInfo: {
                stanzaId: "ORIG-1",
                participant: "5511777776666@s.whatsapp.net",
                quotedMessage: { conversation: "pergunta original" },
              },
            },
          },
        },
      ]),
    );
    await flush();
    const payload = h.publishedOfType("message.received")[0]?.event.payload as Record<string, unknown>;
    expect(payload.replyToId).toBe("ORIG-1");
    expect((payload.rawPayload as Record<string, unknown>).quotedMessage).toMatchObject({
      stanzaId: "ORIG-1",
      participant: "5511777776666@s.whatsapp.net",
      type: "text",
      conversation: "pergunta original",
      pushName: "Bia",
    });
  });
});

describe("contacts, names and LID mappings", () => {
  it("announces only new or changed LID mappings and names (#1040)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const contacts = [{ id: DM_LID, phoneNumber: DM_PHONE, notify: "Ana" }];
    sock.emit("contacts.upsert", contacts);
    sock.emit("contacts.upsert", contacts);
    sock.emit("contacts.upsert", [{ id: "5511777776666@s.whatsapp.net", lid: "333444555@lid", notify: "Bia" }]);
    await flush();

    expect(h.observedOfType("custom.lid-mapping.batch").map((event) => event.payload)).toEqual([
      { mappings: [{ lidJid: DM_LID, phoneJid: DM_PHONE }] },
      { mappings: [{ lidJid: "333444555@lid", phoneJid: "5511777776666@s.whatsapp.net" }] },
    ]);
    expect(h.observedOfType("custom.contacts.names").map((event) => event.payload)).toEqual([
      { names: [{ jid: DM_LID, name: "Ana" }] },
      { names: [{ jid: "5511777776666@s.whatsapp.net", name: "Bia" }] },
    ]);
  });

  it("caches inbound pushNames under the sender's LID for @Name mentions", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "PN-1", remoteJid: GROUP, fromMe: false, participant: DM_LID },
          messageTimestamp: 1_750_000_000,
          pushName: "Ana Souza",
          message: { conversation: "oi" },
        },
      ]),
    );
    await flush();
    await h.runtime.call("messages.sendText", { to: GROUP, text: "@Ana tudo certo?" });
    const [, content] = sock.fake.sendMessage.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(content.mentions).toEqual([DM_LID]);
    expect(content.text).toBe("@217046273028329 tudo certo?");
    expect(await h.runtime.getContactInfo(DM_LID)).toEqual({ name: "Ana Souza", phone: undefined });
  });
});

describe("delivery status", () => {
  it("a silent PreKey failure (status 0 on our send) is observed as message.failed, not published", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("messages.update", [{ key: { id: "SENT-X", remoteJid: PLAIN_DM, fromMe: true }, update: { status: 0 } }]);
    sock.emit("messages.update", [{ key: { id: "SENT-Y", remoteJid: PLAIN_DM, fromMe: true }, update: { status: 3 } }]);
    await flush();
    expect(h.observedOfType("message.failed")[0]?.payload).toEqual({
      externalId: "SENT-X",
      chatId: PLAIN_DM,
      error: "Delivery failed: recipient retry receipt not honored",
      errorCode: "WA_DELIVERY_FAILED",
      retryable: false,
    });
    expect(h.observedOfType("message.delivered")[0]?.payload).toMatchObject({ externalId: "SENT-Y" });
    expect(h.published.filter((record) => record.event.type.startsWith("message.")).length).toBe(0);
  });

  it("getMessage serves recently sent bodies for Baileys retries", async () => {
    const h = createHarness();
    await h.connect();
    const sent = await h.runtime.call("messages.sendText", { to: PLAIN_DM, text: "retry me" });
    const body = await h.socketConfigs[0]?.getMessage?.({ id: sent.messageId, remoteJid: PLAIN_DM });
    expect(body).toEqual({ conversation: "retry me" });
    expect(OWNER_JID).toContain("@s.whatsapp.net");
  });
});

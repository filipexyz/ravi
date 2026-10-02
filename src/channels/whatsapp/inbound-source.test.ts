import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringCodec } from "nats";
import type {
  ChannelInboundEvent,
  ChannelInboundEventOf,
  ChannelInboundHandler,
  InboundSourceHooks,
} from "../inbound/types.js";
import { whatsappInboundSubject } from "./events.js";
import {
  createLocalMediaLoader,
  toChannelInboundEvent,
  WHATSAPP_INBOUND_SUBSCRIPTIONS,
  WhatsAppInboundSource,
} from "./inbound-source.js";

const sc = StringCodec();
const INSTANCE = "11111111-2222-4333-8444-555555555555";
const OTHER_INSTANCE = "99999999-2222-4333-8444-555555555555";

function messageEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `whatsapp-baileys:${INSTANCE}:m1:message`,
    type: "message.received",
    instanceId: INSTANCE,
    timestamp: 1_700_000_000_000,
    receivedAt: 1_699_999_999_000,
    ingestMode: "realtime",
    payload: {
      externalId: "m1",
      chatId: "5511999@s.whatsapp.net",
      from: "5511999",
      content: { type: "text", text: "oi" },
    },
    ...overrides,
  };
}

function reactionEnvelope() {
  return {
    schemaVersion: 1,
    id: `whatsapp-baileys:${INSTANCE}:m1:reaction`,
    type: "reaction.received",
    instanceId: INSTANCE,
    timestamp: 1_700_000_000_000,
    payload: { messageId: "m1", chatId: "5511999@s.whatsapp.net", from: "5511999", emoji: "+1" },
  };
}

function qrEnvelope() {
  return {
    schemaVersion: 1,
    id: "evt-qr",
    type: "connection.qr",
    instanceId: INSTANCE,
    timestamp: 1_700_000_000_000,
    payload: { qrCode: "qr-data", expiresAt: 1_700_000_060_000 },
  };
}

function recordingHandler() {
  const calls: Array<{ event: ChannelInboundEvent; hooks: InboundSourceHooks }> = [];
  const handler: ChannelInboundHandler = {
    handle: async (event, hooks) => {
      calls.push({ event, hooks });
    },
  };
  return { handler, calls };
}

const groupClient = { groups: { metadata: mock(async () => ({ ok: false as const, error: "unused" })) } } as never;

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
}

function fakeMsg(subject: string, body: unknown): FakeMsg {
  return { subject, data: sc.encode(JSON.stringify(body)), ack: mock(() => {}), nak: mock(() => {}) };
}

/** Fake JetStream: CHANNEL_INBOUND appears once `ensureStream` ran; each durable yields its queue once, then idles. */
function fakeJetStream(messages: Record<string, FakeMsg[]> = {}) {
  const streams = new Set<string>();
  const consumers = new Set<string>();
  const adds: string[] = [];
  const consumed = new Set<string>();
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const jsm = {
    streams: {
      info: mock(async (stream: string) => {
        if (!streams.has(stream)) throw new Error("stream not found");
        return { config: { name: stream } };
      }),
    },
    consumers: {
      info: mock(async (stream: string, name: string) => {
        if (!consumers.has(`${stream}/${name}`)) throw new Error("consumer not found");
        return {};
      }),
      add: mock(async (stream: string, config: { durable_name: string; filter_subject: string }) => {
        consumers.add(`${stream}/${config.durable_name}`);
        adds.push(`${stream}/${config.durable_name}/${config.filter_subject}`);
        return config;
      }),
      delete: mock(async (_stream: string, durable: string) => {
        if (durable === "ravi-native-reactions") throw new Error("consumer not found");
        return true;
      }),
    },
  };
  const js = {
    consumers: {
      get: mock(async (_stream: string, durable: string) => ({
        consume: async () =>
          (async function* () {
            if (!consumed.has(durable)) {
              consumed.add(durable);
              for (const msg of messages[durable] ?? []) yield msg;
            }
            await released;
          })(),
      })),
    },
  };
  const ensureStream = mock(async () => {
    streams.add("CHANNEL_INBOUND");
  });
  return {
    connection: { jetstream: () => js, jetstreamManager: async () => jsm } as never,
    jsm,
    adds,
    ensureStream,
    release: () => release(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WhatsAppInboundSource subscriptions", () => {
  it("declares the three ravi-whatsapp-* durables on CHANNEL_INBOUND", () => {
    expect(WHATSAPP_INBOUND_SUBSCRIPTIONS.map((s) => [s.stream, s.durable, s.filterSubject])).toEqual([
      ["CHANNEL_INBOUND", "ravi-whatsapp-messages", "ravi.channel.inbound.whatsapp.message.>"],
      ["CHANNEL_INBOUND", "ravi-whatsapp-reactions", "ravi.channel.inbound.whatsapp.reaction.>"],
      ["CHANNEL_INBOUND", "ravi-whatsapp-connection", "ravi.channel.inbound.whatsapp.connection.>"],
    ]);
  });
});

describe("WhatsAppInboundSource.start", () => {
  it("ensures the stream, deletes legacy durables best-effort and hands every kind to the pipeline", async () => {
    const message = fakeMsg(whatsappInboundSubject("message", INSTANCE), messageEnvelope());
    const reaction = fakeMsg(whatsappInboundSubject("reaction", INSTANCE), reactionEnvelope());
    const qr = fakeMsg(whatsappInboundSubject("connection", INSTANCE), qrEnvelope());
    const fake = fakeJetStream({
      "ravi-whatsapp-messages": [message],
      "ravi-whatsapp-reactions": [reaction],
      "ravi-whatsapp-connection": [qr],
    });
    const { handler, calls } = recordingHandler();
    const source = new WhatsAppInboundSource(handler, {
      client: groupClient,
      natsConnection: fake.connection,
      ensureStream: fake.ensureStream,
    });

    expect(source.id).toBe("whatsapp");
    await source.start();
    await flush();
    await source.stop();
    fake.release();

    expect(fake.ensureStream).toHaveBeenCalled();
    expect(fake.jsm.consumers.delete.mock.calls.map(([stream, durable]) => `${stream}/${durable}`)).toEqual([
      "CHANNEL_INBOUND/ravi-native-messages",
      "CHANNEL_INBOUND/ravi-native-instances",
      "CHANNEL_INBOUND/ravi-native-reactions",
    ]);
    expect(fake.adds.sort()).toEqual([
      "CHANNEL_INBOUND/ravi-whatsapp-connection/ravi.channel.inbound.whatsapp.connection.>",
      "CHANNEL_INBOUND/ravi-whatsapp-messages/ravi.channel.inbound.whatsapp.message.>",
      "CHANNEL_INBOUND/ravi-whatsapp-reactions/ravi.channel.inbound.whatsapp.reaction.>",
    ]);
    expect(fake.jsm.streams.info).not.toHaveBeenCalledWith("MESSAGE");
    expect(
      calls.map(({ event }) => [event.type, event.channelType, event.instanceId, event.provenance]).sort(),
    ).toEqual([
      [
        "connection.qr",
        "whatsapp-baileys",
        INSTANCE,
        { transport: "whatsapp", subject: whatsappInboundSubject("connection", INSTANCE) },
      ],
      [
        "message.received",
        "whatsapp-baileys",
        INSTANCE,
        { transport: "whatsapp", subject: whatsappInboundSubject("message", INSTANCE) },
      ],
      [
        "reaction.received",
        "whatsapp-baileys",
        INSTANCE,
        { transport: "whatsapp", subject: whatsappInboundSubject("reaction", INSTANCE) },
      ],
    ]);
    // One hooks object per source, shared by every event.
    expect(new Set(calls.map(({ hooks }) => hooks)).size).toBe(1);
    expect(calls[0]?.hooks.isIgnoredInstance).toBeUndefined();
    expect(calls[0]?.hooks.fetchGroupMetadata).toBeFunction();
    for (const msg of [message, reaction, qr]) expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsAppInboundSource.handleRaw", () => {
  it("maps a valid message envelope to a ChannelInboundEvent", async () => {
    const { handler, calls } = recordingHandler();
    const source = new WhatsAppInboundSource(handler, { client: groupClient });

    await source.handleRaw(whatsappInboundSubject("message", INSTANCE), messageEnvelope());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toEqual({
      id: `whatsapp-baileys:${INSTANCE}:m1:message`,
      type: "message.received",
      channelType: "whatsapp-baileys",
      instanceId: INSTANCE,
      timestamp: 1_700_000_000_000,
      pluginReceivedAt: 1_699_999_999_000,
      ingestMode: "realtime",
      provenance: { transport: "whatsapp", subject: whatsappInboundSubject("message", INSTANCE) },
      payload: messageEnvelope().payload,
    });
  });

  it("drops invalid envelopes", async () => {
    const { handler, calls } = recordingHandler();
    const source = new WhatsAppInboundSource(handler, { client: groupClient });
    const subject = whatsappInboundSubject("message", INSTANCE);

    await source.handleRaw(subject, messageEnvelope({ schemaVersion: 2 }));
    await source.handleRaw(subject, messageEnvelope({ payload: { chatId: "x" } }));
    await source.handleRaw(subject, "not an object");
    // Omni envelope shape on the new subject.
    await source.handleRaw(subject, {
      id: "evt",
      type: "message.received",
      payload: {},
      metadata: { instanceId: INSTANCE, channelType: "whatsapp-baileys" },
      timestamp: 1,
    });

    expect(calls).toHaveLength(0);
  });

  it("drops envelopes whose subject does not match the instance or the kind", async () => {
    const { handler, calls } = recordingHandler();
    const source = new WhatsAppInboundSource(handler, { client: groupClient });

    await source.handleRaw(whatsappInboundSubject("message", OTHER_INSTANCE), messageEnvelope());
    await source.handleRaw(whatsappInboundSubject("reaction", INSTANCE), messageEnvelope());
    await source.handleRaw(`ravi.channel.inbound.message.received.whatsapp-baileys.${INSTANCE}`, messageEnvelope());

    expect(calls).toHaveLength(0);
  });
});

describe("toChannelInboundEvent", () => {
  it("omits pluginReceivedAt when the runner did not stamp receivedAt", () => {
    const { receivedAt: _drop, ...envelope } = qrEnvelope() as ReturnType<typeof qrEnvelope> & { receivedAt?: number };
    const event = toChannelInboundEvent(whatsappInboundSubject("connection", INSTANCE), {
      ...envelope,
      schemaVersion: 1,
      type: "connection.qr",
    });
    expect(event).not.toHaveProperty("pluginReceivedAt");
    expect(event.type).toBe("connection.qr");
  });
});

describe("createLocalMediaLoader", () => {
  let root = "";
  let outside = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ravi-wa-media-root-"));
    outside = await mkdtemp(join(tmpdir(), "ravi-wa-media-outside-"));
    await writeFile(join(root, "a.jpg"), "inside");
    await writeFile(join(outside, "b.jpg"), "outside");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function mediaEvent(content: Record<string, unknown>): ChannelInboundEventOf<"message.received"> {
    return {
      id: "evt",
      type: "message.received",
      channelType: "whatsapp-baileys",
      instanceId: INSTANCE,
      timestamp: 1,
      provenance: { transport: "whatsapp", subject: whatsappInboundSubject("message", INSTANCE) },
      payload: { externalId: "m1", chatId: "c", from: "f", content: { type: "image", ...content } },
    };
  }

  it("reads file:// URLs and absolute localPaths inside the roots", async () => {
    const load = createLocalMediaLoader([root]);
    const byUrl = await load(mediaEvent({ mediaUrl: pathToFileURL(join(root, "a.jpg")).href }), {
      maxBytes: 1_000,
      mimeType: "image/jpeg",
    });
    const byPath = await load(mediaEvent({ localPath: join(root, "a.jpg") }), {
      maxBytes: 1_000,
      mimeType: "image/jpeg",
    });
    expect(byUrl?.toString()).toBe("inside");
    expect(byPath?.toString()).toBe("inside");
  });

  it("returns null outside the roots, over the size limit, for http URLs and for missing files", async () => {
    const load = createLocalMediaLoader([root]);
    expect(
      await load(mediaEvent({ localPath: join(outside, "b.jpg") }), { maxBytes: 1_000, mimeType: "image/jpeg" }),
    ).toBeNull();
    expect(
      await load(mediaEvent({ localPath: join(root, "a.jpg") }), { maxBytes: 2, mimeType: "image/jpeg" }),
    ).toBeNull();
    expect(
      await load(mediaEvent({ mediaUrl: "https://example.test/a.jpg" }), { maxBytes: 1_000, mimeType: "image/jpeg" }),
    ).toBeNull();
    expect(
      await load(mediaEvent({ localPath: join(root, "missing.jpg") }), { maxBytes: 1_000, mimeType: "image/jpeg" }),
    ).toBeNull();
    expect(await load(mediaEvent({}), { maxBytes: 1_000, mimeType: "image/jpeg" })).toBeNull();
  });
});

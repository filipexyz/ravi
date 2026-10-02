import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { StringCodec } from "nats";
import type { ChannelInboundEvent, ChannelInboundHandler, InboundSourceHooks } from "../channels/inbound/types.js";
import { logger } from "../utils/logger.js";
import {
  mapOmniEvent,
  OMNI_SOURCE_SUBSCRIPTIONS,
  OmniLegacyInboundSource,
  type OmniEvent,
  parseOmniSubject,
  resetOmniWhatsAppDropWarningsForTests,
} from "./inbound-source.js";

const sc = StringCodec();
const INSTANCE = "inst-1";
const originalFetch = globalThis.fetch;

function omniEvent(type: string, payload: unknown, metadata: OmniEvent["metadata"] = {}): OmniEvent {
  return { id: `evt-${type}`, type, payload, metadata, timestamp: 1_700_000_000_000 };
}

const messagePayload = { externalId: "m1", chatId: "C1", from: "u1", content: { type: "text", text: "oi" } };

function recordingHandler() {
  const calls: Array<{ event: ChannelInboundEvent; hooks: InboundSourceHooks }> = [];
  const handler: ChannelInboundHandler = {
    handle: async (event, hooks) => {
      calls.push({ event, hooks });
    },
  };
  return { handler, calls };
}

function createSource(ignored: string[] = []) {
  const { handler, calls } = recordingHandler();
  const source = new OmniLegacyInboundSource(handler, {
    apiUrl: "http://omni.local",
    apiKey: "test-key",
    getConfig: () => ({ ignoredOmniInstanceIds: ignored }),
  });
  return { source, calls };
}

/** Captures warn calls of every logger instance (the source's child logger is created at import time). */
function captureWarnings() {
  const proto = Object.getPrototypeOf(logger) as { warn: (message: string, data?: unknown) => void };
  return spyOn(proto, "warn").mockImplementation(() => {});
}

let warnSpy: ReturnType<typeof captureWarnings> | null = null;

beforeEach(() => {
  resetOmniWhatsAppDropWarningsForTests();
  warnSpy = captureWarnings();
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
  globalThis.fetch = originalFetch;
});

describe("Omni source subscriptions", () => {
  it("keeps Omni's streams and ravi's durables unchanged", () => {
    expect(
      OMNI_SOURCE_SUBSCRIPTIONS.map(({ stream, durable, filterSubject }) => [stream, durable, filterSubject]),
    ).toEqual([
      ["MESSAGE", "ravi-messages", "message.received.>"],
      ["INSTANCE", "ravi-instances", "instance.>"],
      ["REACTION", "ravi-reactions", "reaction.received.>"],
    ]);
  });

  it("parses Omni subjects, keeping dots in the instance id", () => {
    expect(parseOmniSubject("message.received.telegram.a.b")).toEqual({ channelType: "telegram", instanceId: "a.b" });
    expect(parseOmniSubject("message.received.telegram")).toBeNull();
  });
});

describe("mapOmniEvent", () => {
  it("maps a Telegram message with metadata timestamps and ingest mode", () => {
    const subject = `message.received.telegram.${INSTANCE}`;
    const event = mapOmniEvent(
      subject,
      omniEvent("message.received", messagePayload, {
        ingestMode: "history-sync",
        pluginReceivedAt: 10,
        receivedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(event).toEqual({
      id: "evt-message.received",
      type: "message.received",
      channelType: "telegram",
      instanceId: INSTANCE,
      timestamp: 1_700_000_000_000,
      ingestMode: "history-sync",
      pluginReceivedAt: 10,
      receivedAt: "2026-01-01T00:00:00Z",
      provenance: { transport: "omni", subject },
      payload: messagePayload,
    });
  });

  it("maps Discord reactions and instance events to connection events", () => {
    expect(
      mapOmniEvent(`reaction.received.discord.${INSTANCE}`, omniEvent("reaction.received", { emoji: "x" }))?.type,
    ).toBe("reaction.received");
    expect(
      mapOmniEvent(`instance.qr_code.discord.${INSTANCE}`, omniEvent("instance.qr_code", { qrCode: "q" })),
    ).toEqual(expect.objectContaining({ type: "connection.qr", channelType: "discord", payload: { qrCode: "q" } }));
    expect(mapOmniEvent(`instance.connected.discord.${INSTANCE}`, omniEvent("instance.connected", {}))?.type).toBe(
      "connection.connected",
    );
    expect(
      mapOmniEvent(`instance.disconnected.discord.${INSTANCE}`, omniEvent("instance.disconnected", {}))?.type,
    ).toBe("connection.disconnected");
  });

  it("returns null for WhatsApp-family types, unknown subjects and mismatched event types", () => {
    for (const channelType of ["whatsapp-baileys", "whatsapp", "twilio-whatsapp", "gupshup"]) {
      expect(
        mapOmniEvent(`message.received.${channelType}.${INSTANCE}`, omniEvent("message.received", messagePayload)),
      ).toBeNull();
    }
    expect(mapOmniEvent(`instance.logged_out.telegram.${INSTANCE}`, omniEvent("instance.logged_out", {}))).toBeNull();
    expect(mapOmniEvent(`message.received.telegram.${INSTANCE}`, omniEvent("message.sent", {}))).toBeNull();
    expect(mapOmniEvent("message.received", omniEvent("message.received", messagePayload))).toBeNull();
  });
});

describe("OmniLegacyInboundSource.handleRaw", () => {
  it("hands Telegram and Discord events to the pipeline with the Omni hooks", async () => {
    const { source, calls } = createSource(["ignored-inst"]);
    expect(source.id).toBe("omni");

    await source.handleRaw(`message.received.telegram.${INSTANCE}`, omniEvent("message.received", messagePayload));
    await source.handleRaw(`instance.qr_code.discord.${INSTANCE}`, omniEvent("instance.qr_code", { qrCode: "q" }));

    expect(calls.map(({ event }) => [event.type, event.channelType, event.provenance.transport])).toEqual([
      ["message.received", "telegram", "omni"],
      ["connection.qr", "discord", "omni"],
    ]);
    const hooks = calls[0]?.hooks;
    expect(calls[1]?.hooks).toBe(hooks);
    expect(hooks?.isIgnoredInstance?.("ignored-inst")).toBe(true);
    expect(hooks?.isIgnoredInstance?.(INSTANCE)).toBe(false);
    expect(hooks?.fetchGroupMetadata).toBeFunction();
  });

  it("reads omni.ignoreInstanceIds live on every check", async () => {
    let ignored: string[] = [];
    const { handler, calls } = recordingHandler();
    const source = new OmniLegacyInboundSource(handler, {
      apiUrl: "http://omni.local",
      apiKey: "test-key",
      getConfig: () => ({ ignoredOmniInstanceIds: ignored }),
    });
    await source.handleRaw(`message.received.telegram.${INSTANCE}`, omniEvent("message.received", messagePayload));
    const isIgnored = calls[0]?.hooks.isIgnoredInstance;

    expect(isIgnored?.(INSTANCE)).toBe(false);
    ignored = [INSTANCE];
    expect(isIgnored?.(INSTANCE)).toBe(true);
  });

  it("drops every WhatsApp-family event, bound or not, warning once per instance", async () => {
    const { source, calls } = createSource();

    for (const channelType of ["whatsapp-baileys", "whatsapp", "twilio-whatsapp", "gupshup"]) {
      await source.handleRaw(
        `message.received.${channelType}.wa-${channelType}`,
        omniEvent("message.received", messagePayload),
      );
    }
    await source.handleRaw("message.received.whatsapp-baileys.wa-whatsapp-baileys", omniEvent("message.received", {}));
    await source.handleRaw(
      "instance.connected.whatsapp-baileys.wa-whatsapp-baileys",
      omniEvent("instance.connected", {}),
    );

    expect(calls).toHaveLength(0);
    const dropWarnings = (warnSpy?.mock.calls ?? []).filter(([message]) =>
      String(message).startsWith("Ignoring Omni event for a WhatsApp channel type"),
    );
    expect(dropWarnings.map(([, data]) => (data as { instanceId: string }).instanceId)).toEqual([
      "wa-whatsapp-baileys",
      "wa-whatsapp",
      "wa-twilio-whatsapp",
      "wa-gupshup",
    ]);
  });

  it("ignores malformed envelopes, unparsable subjects and unhandled event types", async () => {
    const { source, calls } = createSource();

    await source.handleRaw(`message.received.telegram.${INSTANCE}`, "not an object");
    await source.handleRaw(`message.received.telegram.${INSTANCE}`, { id: "x" });
    await source.handleRaw("message.received", omniEvent("message.received", messagePayload));
    await source.handleRaw(`instance.logged_out.telegram.${INSTANCE}`, omniEvent("instance.logged_out", {}));

    expect(calls).toHaveLength(0);
  });

  it("loads media through Omni's cache endpoint for http media URLs", async () => {
    const { source, calls } = createSource();
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/v2/messages/media/download")) {
        return Response.json({ data: { downloadUrl: "/api/v2/media/inst-1/a.png" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    await source.handleRaw(
      `message.received.telegram.${INSTANCE}`,
      omniEvent("message.received", { ...messagePayload, content: { type: "image", mediaUrl: "https://x/a.png" } }),
    );
    const call = calls[0];
    if (call?.event.type !== "message.received") throw new Error("expected a message event");
    const buffer = await call.hooks.loadMedia(call.event, { maxBytes: 1_000, mimeType: "image/png" });

    expect(buffer?.length).toBe(3);
    expect(urls).toEqual([
      "http://omni.local/api/v2/messages/media/download",
      "http://omni.local/api/v2/media/inst-1/a.png",
    ]);
  });
});

describe("OmniLegacyInboundSource.start", () => {
  it("runs the three Omni pull loops without creating Omni's streams", async () => {
    const consumersAdded: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const message = {
      subject: `message.received.discord.${INSTANCE}`,
      data: sc.encode(JSON.stringify(omniEvent("message.received", messagePayload))),
      ack: mock(() => {}),
      nak: mock(() => {}),
    };
    const jsm = {
      streams: { info: mock(async (stream: string) => ({ config: { name: stream } })) },
      consumers: {
        info: mock(async () => {
          throw new Error("consumer not found");
        }),
        add: mock(async (stream: string, config: { durable_name: string }) => {
          consumersAdded.push(`${stream}/${config.durable_name}`);
          return config;
        }),
      },
    };
    let delivered = false;
    const js = {
      consumers: {
        get: mock(async (_stream: string, durable: string) => ({
          consume: async () =>
            (async function* () {
              if (durable === "ravi-messages" && !delivered) {
                delivered = true;
                yield message;
              }
              await released;
            })(),
        })),
      },
    };
    const { handler, calls } = recordingHandler();
    const source = new OmniLegacyInboundSource(handler, {
      apiUrl: "http://omni.local",
      apiKey: "test-key",
      natsConnection: { jetstream: () => js, jetstreamManager: async () => jsm } as never,
      getConfig: () => ({}),
    });

    await source.start();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await source.stop();
    release();

    expect(consumersAdded.sort()).toEqual([
      "INSTANCE/ravi-instances",
      "MESSAGE/ravi-messages",
      "REACTION/ravi-reactions",
    ]);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(calls.map(({ event }) => [event.type, event.channelType])).toEqual([["message.received", "discord"]]);
  });
});

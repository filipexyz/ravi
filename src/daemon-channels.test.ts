import { describe, expect, it, spyOn } from "bun:test";
import { ChannelInboundPipeline } from "./channels/inbound/pipeline.js";
import type { ChannelInboundHandler, ChannelInboundSource } from "./channels/inbound/types.js";
import type { ChannelMessageSender } from "./channels/outbound/sender.js";
import { createWhatsAppClient } from "./channels/whatsapp/client.js";
import { WhatsAppInboundSource } from "./channels/whatsapp/inbound-source.js";
import type { requestWhatsAppRpc } from "./channels/whatsapp/rpc-client.js";
import { createDaemonChannels, type LegacyBridgeHandle, type LegacyBridgeSourceOptions } from "./daemon-channels.js";
import type { RouterConfig } from "./router/types.js";

const WA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "120363400000000002@g.us";

function boundConfig(): Pick<RouterConfig, "instances" | "channels" | "instanceToAccount"> {
  return {
    instances: { "wa-main": { name: "wa-main", instanceId: WA_ID, channel: "whatsapp-baileys" } },
    channels: { "wa-main": { name: "wa-main", provider: "whatsapp", enabled: true } },
    instanceToAccount: { [WA_ID]: "wa-main" },
  } as unknown as Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;
}

/** WhatsApp client over a recording fake RPC transport (no NATS). */
function fakeWhatsAppClient() {
  const calls: Array<[string, string, unknown]> = [];
  const request = async (instanceId: string, method: string, params: unknown) => {
    calls.push([instanceId, method, params]);
    return { id: GROUP, subject: "Group", participants: [] };
  };
  const client = createWhatsAppClient({ getConfig: boundConfig, request: request as typeof requestWhatsAppRpc });
  return { client, calls };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noopSender: ChannelMessageSender = {
  send: async () => ({}),
  sendTyping: async () => {},
  sendReaction: async () => {},
  deleteMessage: async () => {},
  editMessage: async () => {},
  sendMedia: async () => ({}),
  sendSticker: async () => ({}),
  markRead: async () => {},
};

/** A legacy bridge whose source start/stop is controlled by the test. Never imports src/omni. */
function fakeBridge(start: () => Promise<void> = async () => {}, stop: () => Promise<void> = async () => {}) {
  const created: Array<{ handler: ChannelInboundHandler; options?: LegacyBridgeSourceOptions }> = [];
  const source: ChannelInboundSource = { id: "omni", start, stop };
  const bridge: LegacyBridgeHandle = {
    sender: noopSender,
    createInboundSource(handler, options) {
      created.push({ handler, options });
      return source;
    },
    describe: () => ({ apiUrl: "http://omni.local", source: "env" }),
  };
  return { bridge, source, created };
}

describe("createDaemonChannels", () => {
  it("wires only the WhatsApp source and no bridge sender when the legacy bridge is not configured", async () => {
    const { client } = fakeWhatsAppClient();
    let loads = 0;
    const channels = await createDaemonChannels({
      whatsappClient: client,
      loadLegacyBridge: async () => {
        loads++;
        return null;
      },
    });

    expect(loads).toBe(1);
    expect(channels.legacyBridge).toBe(false);
    expect(channels.sources.map((source) => source.id)).toEqual(["whatsapp"]);
    expect(channels.sources[0]).toBeInstanceOf(WhatsAppInboundSource);
    expect(channels.sender.hasBridge).toBe(false);
    expect(channels.pipeline).toBeInstanceOf(ChannelInboundPipeline);
    expect(channels.presenceTargets).toBe(channels.pipeline);
    expect(channels.pipeline["sender"]).toBe(channels.sender);
  });

  it("adds the bridge source and bridge sender, sharing one pipeline and the NATS seam", async () => {
    const { client } = fakeWhatsAppClient();
    const { bridge, source, created } = fakeBridge();
    const natsConnection = {
      jetstream: () => {
        throw new Error("not used");
      },
      jetstreamManager: async () => {
        throw new Error("not used");
      },
    };
    const channels = await createDaemonChannels({
      whatsappClient: client,
      loadLegacyBridge: async () => bridge,
      natsConnection,
      isRuntimeSessionActive: () => true,
    });

    expect(channels.legacyBridge).toBe(true);
    expect(channels.sender.hasBridge).toBe(true);
    expect(channels.sources.map((s) => s.id)).toEqual(["whatsapp", "omni"]);
    expect(channels.sources[1]).toBe(source);
    expect(created).toHaveLength(1);
    expect(created[0]?.handler).toBe(channels.pipeline);
    expect(created[0]?.options?.natsConnection).toBe(natsConnection);
    const whatsapp = channels.sources[0] as WhatsAppInboundSource;
    expect(whatsapp["handler"]).toBe(channels.pipeline);
    expect(whatsapp["options"].natsConnection).toBe(natsConnection);
    expect(channels.pipeline["options"].isRuntimeSessionActive?.("s")).toBe(true);
  });

  it("refreshes group metadata through the WhatsApp runner client", async () => {
    const { client, calls } = fakeWhatsAppClient();
    const channels = await createDaemonChannels({ whatsappClient: client, loadLegacyBridge: async () => null });

    await channels.groupMetadataFetcher({
      accountId: "wa-main",
      instanceId: WA_ID,
      chatId: GROUP,
      fetchTimeoutMs: 1000,
    });

    expect(calls).toEqual([[WA_ID, "groups.metadata", { groupJid: GROUP }]]);
  });

  it("starts every source in parallel: both start() calls happen before either resolves", async () => {
    const { client } = fakeWhatsAppClient();
    const whatsappReady = deferred();
    const omniReady = deferred();
    const started: string[] = [];
    const { bridge } = fakeBridge(() => {
      started.push("omni");
      return omniReady.promise;
    });
    const channels = await createDaemonChannels({ whatsappClient: client, loadLegacyBridge: async () => bridge });
    const [whatsapp] = channels.sources;
    if (!whatsapp) throw new Error("expected the WhatsApp source");
    spyOn(whatsapp, "start").mockImplementation(() => {
      started.push("whatsapp");
      return whatsappReady.promise;
    });

    let settled = false;
    const starting = channels.start().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(started).toEqual(["whatsapp", "omni"]);
    expect(settled).toBe(false);

    omniReady.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    whatsappReady.resolve();
    await starting;
    expect(settled).toBe(true);
  });

  it("does not reject when a source fails to start, and the other source still starts", async () => {
    const { client } = fakeWhatsAppClient();
    let omniStarted = false;
    const { bridge } = fakeBridge(async () => {
      omniStarted = true;
    });
    const channels = await createDaemonChannels({ whatsappClient: client, loadLegacyBridge: async () => bridge });
    const [whatsapp] = channels.sources;
    if (!whatsapp) throw new Error("expected the WhatsApp source");
    spyOn(whatsapp, "start").mockImplementation(async () => {
      throw new Error("nats down");
    });

    await expect(channels.start()).resolves.toBeUndefined();
    expect(omniStarted).toBe(true);
  });

  it("stops the sources before the pipeline, even when a source fails to stop", async () => {
    const { client } = fakeWhatsAppClient();
    const order: string[] = [];
    const { bridge } = fakeBridge(
      async () => {},
      async () => {
        order.push("omni.stop");
        throw new Error("already closed");
      },
    );
    const channels = await createDaemonChannels({ whatsappClient: client, loadLegacyBridge: async () => bridge });
    const [whatsapp] = channels.sources;
    if (!whatsapp) throw new Error("expected the WhatsApp source");
    spyOn(whatsapp, "stop").mockImplementation(async () => {
      order.push("whatsapp.stop");
    });
    spyOn(channels.pipeline, "stop").mockImplementation(async () => {
      order.push("pipeline.stop");
    });

    await channels.stop();

    expect(order).toEqual(["whatsapp.stop", "omni.stop", "pipeline.stop"]);
  });
});

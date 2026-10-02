/**
 * Daemon channel composition.
 *
 * One `ChannelInboundPipeline` is shared by every inbound source (D2):
 * - the WhatsApp runner source (CHANNEL_INBOUND, `ravi.channel.inbound.whatsapp.*`), always;
 * - the legacy Omni bridge source (Telegram/Discord), only when Omni is configured.
 *
 * Outbound goes through the default-deny `ChannelSenderRouter`: canonical WhatsApp instances go to
 * the WhatsApp runner RPC sender, other instance records to the legacy bridge sender (when present).
 *
 * The legacy bridge is loaded with a dynamic `import()` only, so nothing on the WhatsApp path has a
 * static dependency on `src/omni/**` or `src/omni-config.ts` (D14).
 */

import type { NatsConnection } from "nats";
import { ChannelInboundPipeline } from "./channels/inbound/pipeline.js";
import type { ChannelInboundHandler, ChannelInboundSource, ChannelPresenceTargets } from "./channels/inbound/types.js";
import type { GroupMetadataFetcher } from "./channels/group-metadata/types.js";
import { type ChannelSenderRouter, createChannelSenderRouter } from "./channels/outbound/router.js";
import type { ChannelMessageSender } from "./channels/outbound/sender.js";
import { createWhatsAppClient, type WhatsAppClient } from "./channels/whatsapp/client.js";
import { createWhatsAppGroupMetadataFetcher } from "./channels/whatsapp/group-metadata.js";
import { WhatsAppInboundSource } from "./channels/whatsapp/inbound-source.js";
import { createWhatsAppSender } from "./channels/whatsapp/sender.js";
import type { RuntimeAbortProvenance } from "./runtime/session-dispatcher.js";
import { logger } from "./utils/logger.js";

const log = logger.child("daemon:channels");

type InboundNatsConnection = Pick<NatsConnection, "jetstream" | "jetstreamManager">;

export interface LegacyBridgeSourceOptions {
  /** Test seam: NATS connection for the bridge source. Default: the shared daemon connection. */
  natsConnection?: InboundNatsConnection;
}

export interface LegacyBridgeHandle {
  readonly sender: ChannelMessageSender;
  createInboundSource(handler: ChannelInboundHandler, options?: LegacyBridgeSourceOptions): ChannelInboundSource;
  describe(): { apiUrl: string; source: string };
}

export interface DaemonChannelsInput {
  isRuntimeSessionActive?: (sessionName: string) => boolean;
  abortRuntimeSession?: (sessionName: string, provenance: RuntimeAbortProvenance) => boolean;
  /** Default `createWhatsAppClient()`. */
  whatsappClient?: WhatsAppClient;
  /** Default: `(await import("./omni/legacy-bridge.js")).createLegacyOmniBridge()`; null when Omni is not configured. */
  loadLegacyBridge?: () => Promise<LegacyBridgeHandle | null>;
  /** Test seam passed to sources. */
  natsConnection?: InboundNatsConnection;
}

export interface DaemonChannels {
  readonly pipeline: ChannelInboundPipeline;
  readonly sender: ChannelSenderRouter;
  /** The pipeline (active typing targets for the gateway). */
  readonly presenceTargets: ChannelPresenceTargets;
  /** WhatsApp runner group metadata fetcher (gateway outbound mentions). */
  readonly groupMetadataFetcher: GroupMetadataFetcher;
  /** `[whatsapp]` or `[whatsapp, omni]`. */
  readonly sources: readonly ChannelInboundSource[];
  readonly legacyBridge: boolean;
  /**
   * Starts all sources in parallel (`Promise.allSettled`). A rejected source is logged at error
   * level with its id and does not stop the others, so total start time is bounded by one 60s ready
   * fallback, not one per source. Never rejects.
   */
  start(): Promise<void>;
  /** Stops the sources first (in parallel, failures logged), then `pipeline.stop()`. */
  stop(): Promise<void>;
}

async function loadDefaultLegacyBridge(): Promise<LegacyBridgeHandle | null> {
  const { createLegacyOmniBridge } = await import("./omni/legacy-bridge.js");
  return createLegacyOmniBridge();
}

export async function createDaemonChannels(input: DaemonChannelsInput = {}): Promise<DaemonChannels> {
  const whatsappClient = input.whatsappClient ?? createWhatsAppClient();
  const bridge = await (input.loadLegacyBridge ?? loadDefaultLegacyBridge)();
  if (bridge) {
    log.info("Legacy channel bridge configured (Telegram/Discord)", bridge.describe());
  } else {
    log.info("Legacy channel bridge not configured: WhatsApp and native channels only");
  }

  const sender = createChannelSenderRouter({
    whatsapp: createWhatsAppSender(whatsappClient),
    bridge: bridge?.sender ?? null,
  });
  const pipeline = new ChannelInboundPipeline(sender, {
    isRuntimeSessionActive: input.isRuntimeSessionActive,
    abortRuntimeSession: input.abortRuntimeSession,
  });
  const sources: ChannelInboundSource[] = [
    new WhatsAppInboundSource(pipeline, { client: whatsappClient, natsConnection: input.natsConnection }),
  ];
  if (bridge) {
    sources.push(bridge.createInboundSource(pipeline, { natsConnection: input.natsConnection }));
  }

  return {
    pipeline,
    sender,
    presenceTargets: pipeline,
    groupMetadataFetcher: createWhatsAppGroupMetadataFetcher(whatsappClient),
    sources,
    legacyBridge: bridge !== null,
    async start() {
      const results = await Promise.allSettled(sources.map((source) => source.start()));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          log.error("Failed to start inbound source", { source: sources[index]?.id, error: result.reason });
        }
      });
    },
    async stop() {
      const results = await Promise.allSettled(sources.map((source) => source.stop()));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          log.warn("Failed to stop inbound source", { source: sources[index]?.id, error: result.reason });
        }
      });
      await pipeline.stop();
    },
  };
}

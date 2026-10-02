/**
 * Legacy Omni bridge (Telegram/Discord only).
 *
 * The daemon loads this module with a dynamic `import()` from `src/daemon-channels.ts`, so no
 * WhatsApp code path depends on Omni. The bridge contributes one outbound sender (used by the
 * channel sender router for non-WhatsApp instance records) and one inbound source (the Omni
 * JetStream streams, which drop every WhatsApp-family event).
 */

import type { ChannelInboundHandler, ChannelInboundSource } from "../channels/inbound/types.js";
import type { ChannelMessageSender } from "../channels/outbound/sender.js";
import { type OmniConnection, resolveOmniConnection } from "../omni-config.js";
import { OmniLegacyInboundSource, type OmniLegacyInboundSourceOptions } from "./inbound-source.js";
import { OmniSender } from "./sender.js";

export interface LegacyOmniBridgeSourceOptions {
  /** Test seam passed to the Omni source. Default: the shared daemon NATS connection. */
  natsConnection?: OmniLegacyInboundSourceOptions["natsConnection"];
}

export interface LegacyOmniBridge {
  /** `OmniSender` over the Omni REST API. */
  readonly sender: ChannelMessageSender;
  createInboundSource(handler: ChannelInboundHandler, options?: LegacyOmniBridgeSourceOptions): ChannelInboundSource;
  describe(): { apiUrl: string; source: string };
}

/**
 * The legacy bridge over a resolved Omni connection, or null when Omni is not configured
 * (no `OMNI_API_URL`/`OMNI_API_KEY` and no usable `~/.omni/config.json`).
 */
export function createLegacyOmniBridge(
  connection: OmniConnection | null = resolveOmniConnection(),
): LegacyOmniBridge | null {
  if (!connection) return null;
  const { apiUrl, apiKey, source } = connection;
  const sender = new OmniSender(apiUrl, apiKey);
  return {
    sender,
    createInboundSource(handler, options = {}) {
      return new OmniLegacyInboundSource(handler, { apiUrl, apiKey, natsConnection: options.natsConnection });
    },
    describe() {
      return { apiUrl, source };
    },
  };
}

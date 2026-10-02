/**
 * WhatsApp inbound source (daemon side).
 *
 * Reads the `WhatsAppInboundEvent`s the `ravi channels` runner publishes on the
 * `CHANNEL_INBOUND` stream (`ravi.channel.inbound.whatsapp.<kind>.<instanceId>`, durables
 * `ravi-whatsapp-*`), validates them, maps them to `ChannelInboundEvent` and hands them
 * to the shared inbound pipeline with the WhatsApp hooks: media from the runner's local
 * media directory and group metadata over the runner RPC.
 */

import type { JetStreamManager, NatsConnection } from "nats";
import { getNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { runDurablePullLoop, type DurablePullSubscription } from "../inbound/jetstream-source.js";
import type {
  ChannelInboundEvent,
  ChannelInboundHandler,
  ChannelInboundSource,
  InboundMediaLoader,
  InboundSourceHooks,
} from "../inbound/types.js";
import { CHANNEL_INBOUND_STREAM, WHATSAPP_CHANNEL_TYPE } from "./contract.js";
import {
  LEGACY_NATIVE_DURABLES,
  parseWhatsAppInboundSubject,
  WHATSAPP_INBOUND_DURABLES,
  WhatsAppInboundEventSchema,
  whatsappInboundKindOf,
  type WhatsAppInboundEvent,
} from "./events.js";
import { createWhatsAppGroupMetadataFetcher, type WhatsAppGroupMetadataClient } from "./group-metadata.js";
import { ensureChannelInboundStream } from "./inbound-stream.js";
import { readLocalMediaFile, resolveLocalMediaPath } from "./local-media.js";

const log = logger.child("channels:whatsapp:inbound");

/** The three `ravi-whatsapp-*` durables on CHANNEL_INBOUND (message, reaction, connection). */
export const WHATSAPP_INBOUND_SUBSCRIPTIONS: readonly DurablePullSubscription[] =
  Object.values(WHATSAPP_INBOUND_DURABLES);

export interface WhatsAppInboundSourceOptions {
  /** RPC client used to refresh group metadata. A full `WhatsAppClient` fits. */
  client: WhatsAppGroupMetadataClient;
  /** Default: the shared daemon NATS connection (`getNats()`). */
  natsConnection?: Pick<NatsConnection, "jetstream" | "jetstreamManager">;
  /** Default: `ensureChannelInboundStream` (stream + `ravi-whatsapp-*` durables). */
  ensureStream?: (jsm: JetStreamManager) => Promise<void>;
  /** Directories runner media may be read from. Default: `defaultLocalMediaRoots()` (resolved per read). */
  localMediaRoots?: readonly string[];
}

/**
 * Loads WhatsApp media the runner downloaded to disk (`file://` mediaUrl or absolute localPath),
 * confined to `roots`. Anything else (an http URL) is not loadable on this transport. Never throws.
 */
export function createLocalMediaLoader(roots?: readonly string[]): InboundMediaLoader {
  return async (event, request) => {
    const content = event.payload.content;
    const localPath = resolveLocalMediaPath(content);
    if (!localPath) {
      log.warn("Skipping WhatsApp media without a local file", {
        instanceId: event.instanceId,
        externalId: event.payload.externalId,
      });
      return null;
    }
    try {
      return await readLocalMediaFile(localPath, { maxBytes: request.maxBytes, roots });
    } catch (error) {
      log.warn("Failed to load WhatsApp media", { instanceId: event.instanceId, localPath, error });
      return null;
    }
  };
}

/** Maps a validated WhatsApp envelope to the transport-neutral inbound event. */
export function toChannelInboundEvent(subject: string, event: WhatsAppInboundEvent): ChannelInboundEvent {
  const base = {
    id: event.id,
    channelType: WHATSAPP_CHANNEL_TYPE,
    instanceId: event.instanceId,
    timestamp: event.timestamp,
    ...(event.receivedAt !== undefined ? { pluginReceivedAt: event.receivedAt } : {}),
    provenance: { transport: "whatsapp" as const, subject },
  };
  switch (event.type) {
    case "message.received":
      return { ...base, type: event.type, ingestMode: event.ingestMode, payload: event.payload };
    case "reaction.received":
      return { ...base, type: event.type, payload: event.payload };
    case "connection.qr":
      return { ...base, type: event.type, payload: event.payload };
    case "connection.connected":
      return { ...base, type: event.type, payload: event.payload };
    case "connection.disconnected":
      return { ...base, type: event.type, payload: event.payload };
  }
}

export class WhatsAppInboundSource implements ChannelInboundSource {
  readonly id = "whatsapp";
  private running = false;
  private readonly hooks: InboundSourceHooks;

  constructor(
    private readonly handler: ChannelInboundHandler,
    private readonly options: WhatsAppInboundSourceOptions,
  ) {
    this.hooks = {
      loadMedia: createLocalMediaLoader(options.localMediaRoots),
      fetchGroupMetadata: createWhatsAppGroupMetadataFetcher(options.client),
    };
  }

  /**
   * Ensures CHANNEL_INBOUND and its durables, deletes the PR #590 `ravi-native-*` durables
   * (best-effort), then starts the three pull loops in parallel. Resolves when all are ready
   * (or after the 60s ready fallback).
   */
  async start(): Promise<void> {
    if (this.running) return;
    log.info("Starting WhatsApp inbound source...");
    this.running = true;

    const nc = this.options.natsConnection ?? getNats();
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();
    const ensureStream = this.options.ensureStream ?? ensureChannelInboundStream;

    try {
      await ensureStream(jsm);
    } catch (error) {
      // The pull loops retry through ensureStream until the stream exists.
      log.warn("Failed to ensure the channel inbound stream; the pull loops will retry", { error });
    }
    await this.deleteLegacyDurables(jsm);

    await Promise.all(
      WHATSAPP_INBOUND_SUBSCRIPTIONS.map((subscription) =>
        runDurablePullLoop({
          js,
          jsm,
          subscription,
          ensureStream,
          handle: (subject, data) => this.handleRaw(subject, data),
          isRunning: () => this.running,
          log,
        }),
      ),
    );
    log.info("WhatsApp inbound source started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    log.info("Stopping WhatsApp inbound source...");
    this.running = false;
  }

  /** Validate + map + hand to the pipeline. Invalid or mismatched envelopes are logged and dropped. */
  async handleRaw(subject: string, data: unknown): Promise<void> {
    const parsed = WhatsAppInboundEventSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Ignoring invalid WhatsApp inbound event", {
        subject,
        eventId: eventIdOf(data),
        issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return;
    }
    const event = parsed.data;
    const target = parseWhatsAppInboundSubject(subject);
    if (!target || target.instanceId !== event.instanceId || target.kind !== whatsappInboundKindOf(event.type)) {
      log.warn("Ignoring WhatsApp inbound event whose subject does not match its envelope", {
        subject,
        eventId: event.id,
        type: event.type,
        instanceId: event.instanceId,
      });
      return;
    }
    await this.handler.handle(toChannelInboundEvent(subject, event), this.hooks);
  }

  private async deleteLegacyDurables(jsm: JetStreamManager): Promise<void> {
    await Promise.all(
      LEGACY_NATIVE_DURABLES.map(async (durable) => {
        try {
          await jsm.consumers.delete(CHANNEL_INBOUND_STREAM, durable);
          log.info("Deleted legacy inbound durable", { stream: CHANNEL_INBOUND_STREAM, durable });
        } catch (error) {
          log.debug("Legacy inbound durable not deleted (usually absent)", { durable, error });
        }
      }),
    );
  }
}

function eventIdOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

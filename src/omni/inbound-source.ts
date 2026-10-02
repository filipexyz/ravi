/**
 * Legacy-bridge (Omni) inbound source: Telegram and Discord only.
 *
 * Reads Omni's own JetStream streams (MESSAGE / INSTANCE / REACTION, durables
 * `ravi-messages` / `ravi-instances` / `ravi-reactions`, unchanged), maps each Omni
 * envelope to a `ChannelInboundEvent` and hands it to the shared inbound pipeline with
 * the bridge hooks: Omni HTTP media, Omni REST group metadata and the
 * `omni.ignoreInstanceIds` silencing list.
 *
 * WhatsApp is never served through the bridge: every event whose channel type is
 * WhatsApp-family (`whatsapp`, `whatsapp-baileys`, `twilio-whatsapp`, `gupshup`, …) is
 * dropped, bound or not. WhatsApp instances are migrated with `ravi instances connect`.
 */

import type { NatsConnection } from "nats";
import { configStore } from "../config-store.js";
import { getNats } from "../nats.js";
import { isIgnoredOmniInstanceId } from "../router/omni-ignore.js";
import type { RouterConfig } from "../router/types.js";
import { runDurablePullLoop, type DurablePullSubscription } from "../channels/inbound/jetstream-source.js";
import type {
  ChannelIngestMode,
  ChannelInboundEvent,
  ChannelInboundHandler,
  ChannelInboundSource,
  InboundConnectionConnectedPayload,
  InboundConnectionDisconnectedPayload,
  InboundConnectionQrPayload,
  InboundMessagePayload,
  InboundReactionPayload,
  InboundSourceHooks,
} from "../channels/inbound/types.js";
import { isWhatsAppFamilyChannelType } from "../channels/whatsapp/contract.js";
import { logger } from "../utils/logger.js";
import { createOmniGroupMetadataFetcher } from "./group-metadata.js";
import { createOmniMediaLoader } from "./media.js";

const log = logger.child("omni:inbound");

/** Omni event envelope (wraps every event Omni publishes to JetStream). */
export interface OmniEvent {
  id: string;
  type: string;
  payload: unknown;
  metadata: {
    instanceId?: string;
    channelType?: string;
    personId?: string;
    source?: string;
    ingestMode?: "realtime" | "history-sync";
    pluginReceivedAt?: number | string;
    receivedAt?: number | string;
  };
  timestamp: number;
}

/** Omni bridge streams (must match Omni's stream config) and ravi's durable consumers on them. */
export const OMNI_SOURCE_SUBSCRIPTIONS: readonly (DurablePullSubscription & {
  kind: "message" | "instance" | "reaction";
})[] = [
  { kind: "message", stream: "MESSAGE", durable: "ravi-messages", filterSubject: "message.received.>" },
  { kind: "instance", stream: "INSTANCE", durable: "ravi-instances", filterSubject: "instance.>" },
  { kind: "reaction", stream: "REACTION", durable: "ravi-reactions", filterSubject: "reaction.received.>" },
];

/**
 * Parse an Omni subject `{domain}.{action}.{channelType}.{instanceId}`
 * (e.g. `message.received.telegram.abc-123-uuid`). The instance id may contain dots.
 */
export function parseOmniSubject(subject: string): { channelType: string; instanceId: string } | null {
  const parts = subject.split(".");
  // minimum 4 parts: domain.action.channelType.instanceId
  if (parts.length < 4) return null;
  const channelType = parts[2];
  const instanceId = parts.slice(3).join(".");
  if (!channelType || !instanceId) return null;
  return { channelType, instanceId };
}

function subjectEventType(subject: string): string {
  const parts = subject.split(".");
  return `${parts[0]}.${parts[1]}`;
}

function ingestModeOf(event: OmniEvent): ChannelIngestMode | undefined {
  const mode = event.metadata?.ingestMode;
  return mode === "realtime" || mode === "history-sync" ? mode : undefined;
}

/**
 * Map an Omni `(subject, envelope)` to a `ChannelInboundEvent`.
 *
 * Returns null when the subject cannot be parsed, when its channel type is WhatsApp-family
 * (D9), or for an event type the pipeline does not handle. The event kind comes from the
 * subject, as it always did: message/reaction subjects also require the matching
 * `event.type`; `instance.qr_code` → `connection.qr`, `instance.connected` →
 * `connection.connected`, `instance.disconnected` → `connection.disconnected`.
 * Payloads are passed through unvalidated (Omni's published shapes).
 */
export function mapOmniEvent(subject: string, event: OmniEvent): ChannelInboundEvent | null {
  const parsed = parseOmniSubject(subject);
  if (!parsed) return null;
  const { channelType, instanceId } = parsed;
  if (isWhatsAppFamilyChannelType(channelType)) return null;

  const metadata = event.metadata ?? {};
  const ingestMode = ingestModeOf(event);
  const base = {
    id: event.id,
    channelType,
    instanceId,
    timestamp: event.timestamp,
    ...(ingestMode ? { ingestMode } : {}),
    ...(metadata.pluginReceivedAt !== undefined ? { pluginReceivedAt: metadata.pluginReceivedAt } : {}),
    ...(metadata.receivedAt !== undefined ? { receivedAt: metadata.receivedAt } : {}),
    provenance: { transport: "omni" as const, subject },
  };

  switch (subjectEventType(subject)) {
    case "message.received":
      if (event.type !== "message.received") return null;
      return { ...base, type: "message.received", payload: event.payload as InboundMessagePayload };
    case "reaction.received":
      if (event.type !== "reaction.received") return null;
      return { ...base, type: "reaction.received", payload: event.payload as InboundReactionPayload };
    case "instance.qr_code":
      return { ...base, type: "connection.qr", payload: event.payload as InboundConnectionQrPayload };
    case "instance.connected":
      return { ...base, type: "connection.connected", payload: event.payload as InboundConnectionConnectedPayload };
    case "instance.disconnected":
      return {
        ...base,
        type: "connection.disconnected",
        payload: event.payload as InboundConnectionDisconnectedPayload,
      };
    default:
      return null;
  }
}

/** Instances already warned about (one warn per instance and process, debug afterwards). */
const warnedWhatsAppInstances = new Set<string>();

/** Test seam: forget which instances were already warned about. */
export function resetOmniWhatsAppDropWarningsForTests(): void {
  warnedWhatsAppInstances.clear();
}

function noteDroppedWhatsAppEvent(instanceId: string, channelType: string, subject: string): void {
  if (warnedWhatsAppInstances.has(instanceId)) {
    log.debug("Ignoring Omni event for a WhatsApp channel type", { instanceId, channelType, subject });
    return;
  }
  warnedWhatsAppInstances.add(instanceId);
  log.warn("Ignoring Omni event for a WhatsApp channel type; migrate with ravi instances connect", {
    instanceId,
    channelType,
  });
}

function isOmniEvent(data: unknown): data is OmniEvent {
  if (data === null || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return typeof record.type === "string";
}

export interface OmniLegacyInboundSourceOptions {
  apiUrl: string;
  apiKey: string;
  /** Default: the shared daemon NATS connection (`getNats()`). */
  natsConnection?: Pick<NatsConnection, "jetstream" | "jetstreamManager">;
  /** Live config for `omni.ignoreInstanceIds`. Default: `configStore.getConfig()`. */
  getConfig?: () => Pick<RouterConfig, "ignoredOmniInstanceIds">;
}

export class OmniLegacyInboundSource implements ChannelInboundSource {
  readonly id = "omni";
  private running = false;
  private readonly hooks: InboundSourceHooks;

  constructor(
    private readonly handler: ChannelInboundHandler,
    private readonly options: OmniLegacyInboundSourceOptions,
  ) {
    const connection = { apiUrl: options.apiUrl, apiKey: options.apiKey };
    const getConfig = options.getConfig ?? (() => configStore.getConfig());
    this.hooks = {
      loadMedia: createOmniMediaLoader(connection),
      fetchGroupMetadata: createOmniGroupMetadataFetcher(connection),
      isIgnoredInstance: (instanceId) => isIgnoredOmniInstanceId(getConfig().ignoredOmniInstanceIds, instanceId),
    };
  }

  /** Starts the three Omni pull loops in parallel. Omni owns its streams: they are waited for, never created. */
  async start(): Promise<void> {
    if (this.running) return;
    log.info("Starting legacy bridge inbound source...", { apiUrl: this.options.apiUrl });
    this.running = true;

    const nc = this.options.natsConnection ?? getNats();
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();

    await Promise.all(
      OMNI_SOURCE_SUBSCRIPTIONS.map(({ stream, durable, filterSubject }) =>
        runDurablePullLoop({
          js,
          jsm,
          subscription: { stream, durable, filterSubject },
          handle: (subject, data) => this.handleRaw(subject, data),
          isRunning: () => this.running,
          log,
        }),
      ),
    );
    log.info("Legacy bridge inbound source started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    log.info("Stopping legacy bridge inbound source...");
    this.running = false;
  }

  /** Test seam: drop WhatsApp-family events, map, hand to the pipeline. */
  async handleRaw(subject: string, data: unknown): Promise<void> {
    if (!isOmniEvent(data)) {
      log.warn("Ignoring malformed Omni event", { subject });
      return;
    }
    const parsed = parseOmniSubject(subject);
    if (!parsed) {
      log.warn("Could not parse subject", { subject });
      return;
    }
    if (isWhatsAppFamilyChannelType(parsed.channelType)) {
      noteDroppedWhatsAppEvent(parsed.instanceId, parsed.channelType, subject);
      return;
    }
    const event = mapOmniEvent(subject, data);
    if (!event) {
      log.debug("Ignoring unhandled Omni event", { subject, type: data.type, eventId: data.id });
      return;
    }
    await this.handler.handle(event, this.hooks);
  }
}

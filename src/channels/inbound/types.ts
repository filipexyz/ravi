/**
 * Transport-neutral inbound channel contract.
 *
 * Every inbound source (the WhatsApp runner stream, the legacy Omni bridge) maps its
 * wire events to a `ChannelInboundEvent` and hands it to the one shared
 * `ChannelInboundHandler` together with its per-source `InboundSourceHooks`.
 */

import type { MessageTarget } from "../../runtime/message-types.js";
import type { GroupMetadataFetcher } from "../group-metadata/types.js";

/** Which ravi inbound source produced an event. Drives provenance strings (`<transport>.message.received`). */
export type ChannelInboundTransport = "whatsapp" | "omni";
export type ChannelIngestMode = "realtime" | "history-sync";

export interface ChannelInboundProvenance {
  readonly transport: ChannelInboundTransport;
  /** Wire subject (logs, traces, rawProvenance only). The pipeline never parses it. */
  readonly subject: string;
}

export interface InboundMessageContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  /** Absolute path of runner-downloaded media (WhatsApp); `mediaUrl` is then `file://<path>`. */
  localPath?: string;
  isVoiceNote?: boolean;
}

/** Same fields the Omni `message.received` payload had (and the WhatsApp runner publishes). */
export interface InboundMessagePayload {
  externalId: string;
  chatId: string;
  from: string;
  senderName?: string;
  chatName?: string;
  content: InboundMessageContent;
  replyToId?: string;
  platformTimestamp?: number | string;
  senderInstanceId?: string;
  rawPayload?: Record<string, unknown>;
}

export interface InboundReactionPayload {
  messageId: string;
  chatId: string;
  from: string;
  emoji: string;
  rawPayload?: Record<string, unknown>;
}

export interface InboundConnectionQrPayload {
  qrCode: string;
  expiresAt: number;
}

export interface InboundConnectionConnectedPayload {
  profileName?: string;
  profilePicUrl?: string;
  ownerIdentifier?: string;
  isNewLogin?: boolean;
}

export interface InboundConnectionDisconnectedPayload {
  reason?: string;
  willReconnect: boolean;
}

interface ChannelInboundEventBase {
  readonly id: string;
  /** Provider channel type: "whatsapp-baileys" | "telegram" | "discord" | … (session keys strip "-baileys"). */
  readonly channelType: string;
  /** Transport instance id (instances.instance_id). */
  readonly instanceId: string;
  /** Envelope time in ms (was the Omni envelope `timestamp`). Fallback provider timestamp; reaction cut-off. */
  readonly timestamp: number;
  readonly ingestMode?: ChannelIngestMode;
  /** Plugin/runner receive time, read by resolvePluginReceivedAtMs for the consumer-lag warning. */
  readonly pluginReceivedAt?: number | string;
  readonly receivedAt?: number | string;
  readonly provenance: ChannelInboundProvenance;
}

export type ChannelInboundEvent =
  | (ChannelInboundEventBase & { readonly type: "message.received"; readonly payload: InboundMessagePayload })
  | (ChannelInboundEventBase & { readonly type: "reaction.received"; readonly payload: InboundReactionPayload })
  | (ChannelInboundEventBase & { readonly type: "connection.qr"; readonly payload: InboundConnectionQrPayload })
  | (ChannelInboundEventBase & {
      readonly type: "connection.connected";
      readonly payload: InboundConnectionConnectedPayload;
    })
  | (ChannelInboundEventBase & {
      readonly type: "connection.disconnected";
      readonly payload: InboundConnectionDisconnectedPayload;
    });

export type ChannelInboundEventType = ChannelInboundEvent["type"];
export type ChannelInboundEventOf<T extends ChannelInboundEventType> = Extract<ChannelInboundEvent, { type: T }>;

export interface InboundMediaRequest {
  /** MAX_AUDIO_BYTES for audio/voice, undefined (loader default) otherwise. */
  readonly maxBytes?: number;
  readonly mimeType: string;
}

/** Loads the bytes of an inbound media message, or null (missing/too large/unavailable). Never throws. */
export type InboundMediaLoader = (
  event: ChannelInboundEventOf<"message.received">,
  request: InboundMediaRequest,
) => Promise<Buffer | null>;

/** Per-source behaviour the neutral pipeline delegates. Sources pass the same object with every event. */
export interface InboundSourceHooks {
  readonly loadMedia: InboundMediaLoader;
  /** Group metadata refresh for this transport; null = cache only. */
  readonly fetchGroupMetadata: GroupMetadataFetcher | null;
  /** Unknown-instance silencing (Omni `omni.ignoreInstanceIds`). Absent = never ignored. */
  readonly isIgnoredInstance?: (instanceId: string) => boolean;
}

export interface ChannelInboundHandler {
  /** Dispatches by `event.type`. `connection.disconnected` is accepted and ignored (parity). */
  handle(event: ChannelInboundEvent, hooks: InboundSourceHooks): Promise<void>;
}

export interface ChannelInboundSource {
  readonly id: ChannelInboundTransport;
  /** Resolves once its durable consumers are ready (or after the 60s ready fallback). */
  start(): Promise<void>;
  /** Stops pulling. Idempotent. */
  stop(): Promise<void>;
}

/** What the gateway needs from the inbound side to coordinate typing presence. */
export interface ChannelPresenceTargets {
  getActiveTarget(sessionName: string): MessageTarget | undefined;
  renewActiveTarget(sessionName: string): Promise<boolean>;
  clearActiveTarget(sessionName: string): Promise<void>;
}

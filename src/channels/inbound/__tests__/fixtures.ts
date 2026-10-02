/**
 * Test fixtures for the channel inbound pipeline.
 *
 * `inboundEventFromSubject` turns the Omni-shaped `(subject, envelope)` pairs the
 * pipeline tests were written with into the `ChannelInboundEvent` a source hands to the
 * pipeline, so the moved tests keep their original fixtures and assertions.
 */

import { mock } from "bun:test";
import type { ChannelMessageSender } from "../../outbound/sender.js";
import type {
  ChannelInboundEvent,
  ChannelInboundTransport,
  InboundConnectionConnectedPayload,
  InboundConnectionDisconnectedPayload,
  InboundConnectionQrPayload,
  InboundMessagePayload,
  InboundReactionPayload,
  InboundSourceHooks,
} from "../types.js";

/** The Omni-shaped envelope the original consumer tests used. */
export interface SubjectEnvelope {
  id: string;
  type: string;
  payload: unknown;
  metadata?: {
    instanceId?: string;
    channelType?: string;
    source?: string;
    ingestMode?: "realtime" | "history-sync";
    pluginReceivedAt?: number | string;
    receivedAt?: number | string;
  };
  timestamp: number;
}

/**
 * `<domain>.<action>.<channelType>.<instanceId>` (e.g. `message.received.whatsapp-baileys.instance-1`)
 * → `ChannelInboundEvent`. `transport` defaults to `"whatsapp"` for `whatsapp-baileys` subjects, else `"omni"`.
 * `instance.qr_code` / `instance.connected` / `instance.disconnected` map to the `connection.*` types.
 */
export function inboundEventFromSubject(
  subject: string,
  envelope: SubjectEnvelope,
  transport?: ChannelInboundTransport,
): ChannelInboundEvent {
  const parts = subject.split(".");
  if (parts.length < 4)
    throw new Error(`fixture subject must be <domain>.<action>.<channelType>.<instanceId>: ${subject}`);
  const subjectType = `${parts[0]}.${parts[1]}`;
  const channelType = parts[2] as string;
  const instanceId = parts.slice(3).join(".");
  const metadata = envelope.metadata ?? {};
  const base = {
    id: envelope.id,
    channelType,
    instanceId,
    timestamp: envelope.timestamp,
    ...(metadata.ingestMode ? { ingestMode: metadata.ingestMode } : {}),
    ...(metadata.pluginReceivedAt !== undefined ? { pluginReceivedAt: metadata.pluginReceivedAt } : {}),
    ...(metadata.receivedAt !== undefined ? { receivedAt: metadata.receivedAt } : {}),
    provenance: {
      transport: transport ?? (channelType === "whatsapp-baileys" ? "whatsapp" : "omni"),
      subject,
    },
  } as const;

  switch (subjectType) {
    case "message.received":
      return { ...base, type: "message.received", payload: envelope.payload as InboundMessagePayload };
    case "reaction.received":
      return { ...base, type: "reaction.received", payload: envelope.payload as InboundReactionPayload };
    case "instance.qr_code":
      return { ...base, type: "connection.qr", payload: envelope.payload as InboundConnectionQrPayload };
    case "instance.connected":
      return { ...base, type: "connection.connected", payload: envelope.payload as InboundConnectionConnectedPayload };
    case "instance.disconnected":
      return {
        ...base,
        type: "connection.disconnected",
        payload: envelope.payload as InboundConnectionDisconnectedPayload,
      };
    default:
      throw new Error(`fixture subject type not supported: ${subjectType}`);
  }
}

/** Hooks that load no media, have no group metadata fetcher and ignore no instance. */
export function noopHooks(overrides: Partial<InboundSourceHooks> = {}): InboundSourceHooks {
  return {
    loadMedia: async () => null,
    fetchGroupMetadata: null,
    ...overrides,
  };
}

/** A `ChannelMessageSender` whose methods are all `mock()`s. */
export function fakeSender() {
  return {
    send: mock(async () => ({})),
    sendTyping: mock(async () => {}),
    sendReaction: mock(async () => {}),
    deleteMessage: mock(async () => {}),
    editMessage: mock(async () => {}),
    sendMedia: mock(async () => ({})),
    sendSticker: mock(async () => ({})),
    markRead: mock(async () => {}),
  } satisfies ChannelMessageSender;
}

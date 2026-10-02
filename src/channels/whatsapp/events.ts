/**
 * WhatsApp inbound wire contract (runner → daemon).
 *
 * The runner publishes one `WhatsAppInboundEvent` per inbound message, reaction or
 * connection change on the `CHANNEL_INBOUND` stream, under
 * `ravi.channel.inbound.whatsapp.<kind>.<instanceId>`. The daemon reads them through
 * the `ravi-whatsapp-*` durables and maps them to `ChannelInboundEvent`.
 *
 * Payload fields are the ones the runner has always published; only the envelope and
 * the subjects are ravi-owned. Idempotency keys stay
 * `whatsapp-baileys:{instance}:{externalId}:{kind}` (JetStream `msgID` = `id`).
 */

import { z } from "zod";
import { CHANNEL_INBOUND_STREAM, CHANNEL_INBOUND_SUBJECT_PREFIX, InstanceIdSchema } from "./contract.js";

export const WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION = 1 as const;

/** `ravi.channel.inbound.whatsapp.` — still covered by CHANNEL_INBOUND_SUBJECT_FILTER (no stream reconfig). */
export const WHATSAPP_INBOUND_SUBJECT_ROOT = `${CHANNEL_INBOUND_SUBJECT_PREFIX}whatsapp.` as const;

export const WHATSAPP_INBOUND_KINDS = ["message", "reaction", "connection"] as const;
export type WhatsAppInboundKind = (typeof WHATSAPP_INBOUND_KINDS)[number];

function isWhatsAppInboundKind(value: string): value is WhatsAppInboundKind {
  return (WHATSAPP_INBOUND_KINDS as readonly string[]).includes(value);
}

/** `ravi.channel.inbound.whatsapp.<kind>.<instanceId>`; instanceId validated with the contract's InstanceIdSchema. */
export function whatsappInboundSubject(kind: WhatsAppInboundKind, instanceId: string): string {
  return `${WHATSAPP_INBOUND_SUBJECT_ROOT}${kind}.${InstanceIdSchema.parse(instanceId)}`;
}

/** Inverse; null for anything outside the root or with an unknown kind. instanceId = everything after `<kind>.`. */
export function parseWhatsAppInboundSubject(subject: string): { kind: WhatsAppInboundKind; instanceId: string } | null {
  if (!subject.startsWith(WHATSAPP_INBOUND_SUBJECT_ROOT)) return null;
  const rest = subject.slice(WHATSAPP_INBOUND_SUBJECT_ROOT.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const kind = rest.slice(0, dot);
  const instanceId = rest.slice(dot + 1);
  if (!isWhatsAppInboundKind(kind) || !instanceId) return null;
  return { kind, instanceId };
}

export interface WhatsAppInboundDurable {
  stream: typeof CHANNEL_INBOUND_STREAM;
  durable: string;
  filterSubject: string;
}

export const WHATSAPP_INBOUND_DURABLES: Readonly<Record<WhatsAppInboundKind, WhatsAppInboundDurable>> = {
  message: {
    stream: CHANNEL_INBOUND_STREAM,
    durable: "ravi-whatsapp-messages",
    filterSubject: `${WHATSAPP_INBOUND_SUBJECT_ROOT}message.>`,
  },
  reaction: {
    stream: CHANNEL_INBOUND_STREAM,
    durable: "ravi-whatsapp-reactions",
    filterSubject: `${WHATSAPP_INBOUND_SUBJECT_ROOT}reaction.>`,
  },
  connection: {
    stream: CHANNEL_INBOUND_STREAM,
    durable: "ravi-whatsapp-connection",
    filterSubject: `${WHATSAPP_INBOUND_SUBJECT_ROOT}connection.>`,
  },
};

/** Durables PR #590 created; WhatsAppInboundSource.start() deletes them best-effort. */
export const LEGACY_NATIVE_DURABLES = [
  "ravi-native-messages",
  "ravi-native-instances",
  "ravi-native-reactions",
] as const;

export const WHATSAPP_INBOUND_EVENT_TYPES = [
  "message.received",
  "reaction.received",
  "connection.qr",
  "connection.connected",
  "connection.disconnected",
] as const;
export type WhatsAppInboundEventType = (typeof WHATSAPP_INBOUND_EVENT_TYPES)[number];

export function whatsappInboundKindOf(type: WhatsAppInboundEventType): WhatsAppInboundKind {
  switch (type) {
    case "message.received":
      return "message";
    case "reaction.received":
      return "reaction";
    case "connection.qr":
    case "connection.connected":
    case "connection.disconnected":
      return "connection";
  }
}

export const WhatsAppMessageContentSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    mediaUrl: z.string().optional(),
    mimeType: z.string().optional(),
    localPath: z.string().optional(),
    isVoiceNote: z.boolean().optional(),
  })
  .passthrough();

export const WhatsAppMessageReceivedPayloadSchema = z
  .object({
    externalId: z.string().min(1),
    chatId: z.string().min(1),
    from: z.string(),
    senderName: z.string().optional(),
    chatName: z.string().optional(),
    content: WhatsAppMessageContentSchema,
    replyToId: z.string().optional(),
    platformTimestamp: z.union([z.number(), z.string()]).optional(),
    senderInstanceId: z.string().optional(),
    rawPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const WhatsAppReactionPayloadSchema = z
  .object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    from: z.string(),
    emoji: z.string(),
    rawPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const WhatsAppConnectionQrPayloadSchema = z.object({ qrCode: z.string().min(1), expiresAt: z.number() });

export const WhatsAppConnectionConnectedPayloadSchema = z
  .object({
    profileName: z.string().optional(),
    profilePicUrl: z.string().optional(),
    ownerIdentifier: z.string().optional(),
    isNewLogin: z.boolean().optional(),
  })
  .passthrough();

export const WhatsAppConnectionDisconnectedPayloadSchema = z.object({
  reason: z.string().optional(),
  willReconnect: z.boolean(),
});

const base = {
  schemaVersion: z.literal(WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION),
  /** JetStream msgID (deterministic for messages/reactions). */
  id: z.string().min(1),
  instanceId: z.string().min(1),
  /** Publish time, ms. */
  timestamp: z.number(),
  /** When the runner received the event from Baileys (was metadata.pluginReceivedAt ?? receivedAt), ms. */
  receivedAt: z.number().optional(),
};

export const WhatsAppInboundEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("message.received"),
    ingestMode: z.enum(["realtime", "history-sync"]),
    payload: WhatsAppMessageReceivedPayloadSchema,
  }),
  z.object({ ...base, type: z.literal("reaction.received"), payload: WhatsAppReactionPayloadSchema }),
  z.object({ ...base, type: z.literal("connection.qr"), payload: WhatsAppConnectionQrPayloadSchema }),
  z.object({ ...base, type: z.literal("connection.connected"), payload: WhatsAppConnectionConnectedPayloadSchema }),
  z.object({
    ...base,
    type: z.literal("connection.disconnected"),
    payload: WhatsAppConnectionDisconnectedPayloadSchema,
  }),
]);

export type WhatsAppInboundEvent = z.infer<typeof WhatsAppInboundEventSchema>;

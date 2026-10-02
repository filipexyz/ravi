/**
 * Events built by `WhatsAppRuntime`, and the mapping to the WhatsApp inbound wire
 * contract (`events.ts`).
 *
 * The runtime hands every event it builds to its observer as a `WhatsAppObservedEvent`
 * (runner-internal, not a wire contract). Only the types in `WHATSAPP_INBOUND_EVENT_TYPES`
 * are published: `toWhatsAppInboundEvent` turns them into a validated
 * `WhatsAppInboundEvent` for CHANNEL_INBOUND. Observe-only types (presence, receipts,
 * sync progress, `custom.*`, `reaction.removed`) are never published.
 *
 * Payload fields are copied field by field from the emitters of the Baileys plugin
 * this runtime was ported from (omni packages/channel-whatsapp), so the daemon reads
 * the same payloads it always read.
 *
 * Event ids for `message.received` and reactions are derived from the ingress
 * idempotency key (`whatsapp-baileys:{instance}:{externalId}:{kind}`), so a redelivered
 * Baileys upsert republishes the same JetStream `msgID` and collapses in the stream's
 * duplicate window.
 */

import { createHash, randomUUID } from "node:crypto";
import { WHATSAPP_CHANNEL_TYPE, type WhatsAppIngestMode } from "./contract.js";
import {
  WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION,
  WHATSAPP_INBOUND_EVENT_TYPES,
  type WhatsAppInboundEvent,
  WhatsAppInboundEventSchema,
  type WhatsAppInboundEventType,
} from "./events.js";

/** Event types published to CHANNEL_INBOUND by default: exactly the inbound contract types. */
export const DEFAULT_PUBLISHED_EVENT_TYPES: readonly WhatsAppInboundEventType[] = WHATSAPP_INBOUND_EVENT_TYPES;

export function isWhatsAppInboundEventType(type: string): type is WhatsAppInboundEventType {
  return (WHATSAPP_INBOUND_EVENT_TYPES as readonly string[]).includes(type);
}

/** UUID-formatted sha256 of `key` (stable across processes and restarts). */
export function deterministicEventId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Idempotency key of an inbound message (`whatsapp-baileys:{instance}:{externalId}:{contentType}`). */
export function messageIdempotencyKey(instanceId: string, externalId: string, contentType: string): string {
  return `${WHATSAPP_CHANNEL_TYPE}:${instanceId}:${externalId}:${contentType}`;
}

/** Idempotency key of a reaction (`whatsapp-baileys:{instance}:{externalId}:{kind}:{emoji}`). */
export function reactionIdempotencyKey(
  instanceId: string,
  kind: "reaction.received" | "reaction.removed",
  payload: ReactionPayload,
): string {
  const raw = payload.rawPayload?.externalId;
  const externalId = typeof raw === "string" && raw.length > 0 ? raw : `${payload.messageId}:${payload.from}`;
  return `${WHATSAPP_CHANNEL_TYPE}:${instanceId}:${externalId}:${kind}:${payload.emoji}`;
}

// ============================================================================
// Observed events (runner-internal) and the inbound wire mapping
// ============================================================================

/** Every event the runtime builds, published or not. Runner-internal; not a wire contract. */
export interface WhatsAppObservedEvent {
  readonly id: string;
  /** Published types (WHATSAPP_INBOUND_EVENT_TYPES) and observe-only types: presence.typing|online|offline,
   *  custom.chat.unread-updated, custom.whatsapp.*, custom.contacts.names, custom.lid-mapping.batch,
   *  sync.progress|completed, message.sent|failed|delivered|read, reaction.removed. */
  readonly type: string;
  readonly instanceId: string;
  /** Build time, ms. */
  readonly timestamp: number;
  readonly payload: unknown;
  readonly ingestMode?: WhatsAppIngestMode;
  /** When the runner received the event from Baileys, ms (defaults to the build time). */
  readonly receivedAt?: number;
}

export interface BuildWhatsAppObservedEventInput {
  type: string;
  instanceId: string;
  payload: unknown;
  now: number;
  id?: string;
  ingestMode?: WhatsAppIngestMode;
  receivedAt?: number;
}

export function buildWhatsAppObservedEvent(input: BuildWhatsAppObservedEventInput): WhatsAppObservedEvent {
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    instanceId: input.instanceId,
    timestamp: input.now,
    payload: input.payload,
    ...(input.ingestMode ? { ingestMode: input.ingestMode } : {}),
    receivedAt: input.receivedAt ?? input.now,
  };
}

/**
 * The wire event for a published type, or null for an observe-only type.
 *
 * The result is `WhatsAppInboundEventSchema.parse(...)`: message events default
 * `ingestMode` to "realtime"; other types never carry it. A parse failure throws
 * (the runtime logs it as a dropped publish).
 */
export function toWhatsAppInboundEvent(event: WhatsAppObservedEvent): WhatsAppInboundEvent | null {
  if (!isWhatsAppInboundEventType(event.type)) return null;
  return WhatsAppInboundEventSchema.parse({
    schemaVersion: WHATSAPP_INBOUND_EVENT_SCHEMA_VERSION,
    id: event.id,
    instanceId: event.instanceId,
    timestamp: event.timestamp,
    ...(event.receivedAt !== undefined ? { receivedAt: event.receivedAt } : {}),
    type: event.type,
    ...(event.type === "message.received" ? { ingestMode: event.ingestMode ?? "realtime" } : {}),
    payload: event.payload,
  });
}

// ============================================================================
// Payloads (ported field order; undefined members vanish in JSON)
// ============================================================================

export interface MessageReceivedContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  /** Absolute path of the downloaded inbound media (ravi addition; `mediaUrl` is its `file://` URL). */
  localPath?: string;
}

export interface MessageReceivedPayload {
  externalId: string;
  chatId: string;
  /** Bare sender id (`fromJid(jid).id`). */
  from: string;
  senderName?: string;
  chatName?: string;
  content: MessageReceivedContent;
  replyToId?: string;
  senderInstanceId?: string;
  rawPayload?: Record<string, unknown>;
}

export function messageReceivedPayload(input: MessageReceivedPayload): MessageReceivedPayload {
  return {
    externalId: input.externalId,
    chatId: input.chatId,
    from: input.from,
    senderName: input.senderName,
    chatName: input.chatName,
    content: {
      type: input.content.type,
      text: input.content.text,
      mediaUrl: input.content.mediaUrl,
      mimeType: input.content.mimeType,
      ...(input.content.localPath ? { localPath: input.content.localPath } : {}),
    },
    replyToId: input.replyToId,
    senderInstanceId: input.senderInstanceId,
    rawPayload: input.rawPayload,
  };
}

export interface ReactionPayload {
  messageId: string;
  chatId: string;
  from: string;
  emoji: string;
  rawPayload?: Record<string, unknown>;
}

/** `connection.qr` payload (the envelope carries the instance id). */
export function connectionQrPayload(qrCode: string, expiresAt: Date) {
  return { qrCode, expiresAt: expiresAt.getTime() };
}

export interface ConnectionConnectedInfo {
  profileName?: string;
  profilePicUrl?: string;
  ownerIdentifier?: string;
  isNewLogin?: boolean;
}

/** `connection.connected` payload; `isNewLogin` only when true. */
export function connectionConnectedPayload(info: ConnectionConnectedInfo) {
  return {
    profileName: info.profileName,
    profilePicUrl: info.profilePicUrl,
    ownerIdentifier: info.ownerIdentifier,
    ...(info.isNewLogin ? { isNewLogin: true } : {}),
  };
}

/** `connection.disconnected` payload. */
export function connectionDisconnectedPayload(reason: string | undefined, willReconnect: boolean) {
  return { reason, willReconnect };
}

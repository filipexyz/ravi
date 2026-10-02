/**
 * WhatsApp channel contract.
 *
 * WhatsApp is a first-class ravi channel. The `ravi channels` runner owns the Baileys
 * sockets and publishes `WhatsAppInboundEvent` envelopes (events.ts) on the Ravi-owned
 * `CHANNEL_INBOUND` JetStream stream; the daemon reads them with `WhatsAppInboundSource`.
 * Outbound sends and connection/group control go through the RPC defined here: a NATS
 * request on `_RAVI.channels.whatsapp.rpc.<instanceId>` that the runner answers
 * (client side: rpc-client.ts, client.ts, sender.ts).
 *
 * A WhatsApp channel binds a Ravi instance by name (`channels.name`, or
 * `channels.defaults.instance` when they differ). The instance keeps its
 * `instances.instance_id` UUID, which is the transport instance id on every event and
 * request.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import { canonicalChannelId } from "../capabilities.js";

export const WHATSAPP_PROVIDER = "whatsapp" as const;
/** ravi's WhatsApp channel-type id (Baileys implementation); session keys strip `-baileys`. */
export const WHATSAPP_CHANNEL_TYPE = "whatsapp-baileys" as const;
export const WHATSAPP_DRIVER_ID = "ravi.whatsapp" as const;

export const CHANNEL_INBOUND_STREAM = "CHANNEL_INBOUND" as const;
export const CHANNEL_INBOUND_SUBJECT_PREFIX = "ravi.channel.inbound." as const;
export const CHANNEL_INBOUND_SUBJECT_FILTER = "ravi.channel.inbound.>" as const;

export const WHATSAPP_RPC_PROTOCOL = "ravi.channels.whatsapp.rpc" as const;
export const WHATSAPP_RPC_SCHEMA_VERSION = 2 as const;
export const WHATSAPP_RPC_SUBJECT_PREFIX = "_RAVI.channels.whatsapp.rpc." as const;
export const WHATSAPP_RPC_QUEUE = "ravi-whatsapp-rpc" as const;
export const DEFAULT_WHATSAPP_RPC_TIMEOUT_MS = 60_000;

export type WhatsAppIngestMode = "realtime" | "history-sync";

/** NATS-safe transport instance id (one subject token). */
export const InstanceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/, "instance id must be a NATS-safe token");

export function whatsappRpcSubject(instanceId: string): string {
  return `${WHATSAPP_RPC_SUBJECT_PREFIX}${InstanceIdSchema.parse(instanceId)}`;
}

// ============================================================================
// RPC
// ============================================================================

export const WHATSAPP_RPC_METHODS = [
  // Connection lifecycle
  "connection.status",
  "connection.connect",
  "connection.disconnect",
  "connection.logout",
  "connection.pairingCode",
  // Groups
  "groups.list",
  "groups.create",
  "groups.addParticipants",
  "groups.updateParticipants",
  "groups.getInvite",
  "groups.revokeInvite",
  "groups.join",
  "groups.leave",
  "groups.rename",
  "groups.setDescription",
  "groups.setSettings",
  "groups.metadata",
  // Messages
  "messages.sendText",
  "messages.react",
  "messages.delete",
  "messages.edit",
  "messages.sendMedia",
  "messages.sendSticker",
  "messages.markRead",
  // Presence
  "presence.set",
] as const;

export const WhatsAppRpcMethodSchema = z.enum(WHATSAPP_RPC_METHODS);
export type WhatsAppRpcMethod = z.infer<typeof WhatsAppRpcMethodSchema>;

const JidLikeSchema = z.string().trim().min(1).max(512);
const MentionSchema = z.object({ id: z.string().min(1), type: z.literal("user") });
/** Media is read by the runner from disk (same host), so the path must be absolute. */
const AbsoluteFilePathSchema = z
  .string({ error: "filePath is required" })
  .trim()
  .min(1, "filePath is required")
  .refine((value) => isAbsolute(value), "filePath must be an absolute path");

/** Params per method. `instanceId` is implied by the subject and never trusted from params. */
export const WhatsAppRpcParamsSchemas = {
  "connection.status": z.object({}).passthrough(),
  "connection.connect": z
    .object({
      forceNewQr: z.boolean().optional(),
      whatsapp: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  "connection.disconnect": z.object({}).passthrough(),
  "connection.logout": z.object({}).passthrough(),
  "connection.pairingCode": z.object({ phoneNumber: z.string().trim().min(8).max(32) }),
  "groups.list": z
    .object({ limit: z.coerce.number().int().positive().max(5000).optional(), search: z.string().optional() })
    .passthrough(),
  "groups.create": z.object({
    subject: z.string().trim().min(1).max(512),
    participants: z.array(JidLikeSchema).max(1024),
  }),
  "groups.addParticipants": z.object({
    groupJid: JidLikeSchema,
    participants: z.array(JidLikeSchema).min(1).max(1024),
  }),
  "groups.updateParticipants": z.object({
    groupJid: JidLikeSchema,
    action: z.enum(["remove", "promote", "demote"]),
    participants: z.array(JidLikeSchema).min(1).max(1024),
  }),
  "groups.getInvite": z.object({ groupJid: JidLikeSchema }),
  "groups.revokeInvite": z.object({ groupJid: JidLikeSchema }),
  "groups.join": z.object({ code: z.string().trim().min(1).max(512) }),
  "groups.leave": z.object({ groupJid: JidLikeSchema }),
  "groups.rename": z.object({ groupJid: JidLikeSchema, subject: z.string().trim().min(1).max(512) }),
  "groups.setDescription": z.object({ groupJid: JidLikeSchema, description: z.string().max(4096) }),
  "groups.setSettings": z.object({ groupJid: JidLikeSchema, setting: z.string().trim().min(1).max(64) }),
  "groups.metadata": z.object({ groupJid: JidLikeSchema, maxAgeMs: z.number().int().nonnegative().optional() }),
  "messages.sendText": z
    .object({
      to: JidLikeSchema,
      text: z.string(),
      threadId: z.string().optional(),
      mentions: z.array(MentionSchema).optional(),
      replyTo: z.string().optional(),
    })
    .passthrough(),
  "presence.set": z
    .object({
      to: JidLikeSchema,
      state: z.enum(["typing", "recording", "paused", "available", "unavailable"]),
      /** Auto-pause after this many ms (typing/recording). 0 keeps the state until paused. */
      durationMs: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  "messages.react": z
    .object({
      to: JidLikeSchema,
      messageId: z.string().min(1),
      emoji: z.string(),
      fromMe: z.boolean().optional(),
      participant: z.string().optional(),
    })
    .passthrough(),
  "messages.delete": z.object({ chatId: JidLikeSchema, messageId: z.string().min(1) }).passthrough(),
  "messages.edit": z
    .object({ chatId: JidLikeSchema, messageId: z.string().min(1), text: z.string().min(1) })
    .passthrough(),
  "messages.sendMedia": z
    .object({
      to: JidLikeSchema,
      type: z.enum(["image", "video", "audio", "document"]),
      filePath: AbsoluteFilePathSchema,
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      caption: z.string().optional(),
      voiceNote: z.boolean().optional(),
    })
    .passthrough(),
  "messages.sendSticker": z.object({ to: JidLikeSchema, filePath: AbsoluteFilePathSchema }).passthrough(),
  "messages.markRead": z
    .object({ chatId: JidLikeSchema, messageIds: z.array(z.string().min(1)).min(1).max(500) })
    .passthrough(),
} satisfies Record<WhatsAppRpcMethod, z.ZodType>;

export type WhatsAppRpcParams<M extends WhatsAppRpcMethod> = z.infer<(typeof WhatsAppRpcParamsSchemas)[M]>;

export const WhatsAppRpcRequestSchema = z.object({
  protocol: z.literal(WHATSAPP_RPC_PROTOCOL),
  schemaVersion: z.literal(WHATSAPP_RPC_SCHEMA_VERSION),
  requestId: z.string().min(1).max(128),
  instanceId: InstanceIdSchema,
  method: WhatsAppRpcMethodSchema,
  params: z.unknown(),
});

export type WhatsAppRpcRequest = z.infer<typeof WhatsAppRpcRequestSchema>;

export const WhatsAppRpcErrorBodySchema = z.object({
  message: z.string(),
  /** HTTP-like status; status is ravi's retry contract: 5xx = retryable. */
  status: z.number().int(),
  code: z.string(),
  /** Optional minimum wait before a retry (e.g. RATE_LIMITED backoff). */
  retryAfterMs: z.number().int().nonnegative().optional(),
});

export type WhatsAppRpcErrorBody = z.infer<typeof WhatsAppRpcErrorBodySchema>;

export const WhatsAppRpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: z.string(), data: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: z.string(), error: WhatsAppRpcErrorBodySchema }),
]);

export type WhatsAppRpcResponse = z.infer<typeof WhatsAppRpcResponseSchema>;

export type WhatsAppConnectionState = "connected" | "connecting" | "qr" | "disconnected" | "logged_out" | "error";

export interface WhatsAppRpcGroupRecord {
  id: string;
  externalId: string;
  subject: string;
  name: string;
  owner?: string;
  creation?: number;
  participants: Array<{ id: string; admin: string | null }>;
  memberCount: number;
  isCommunity: boolean;
}

export interface WhatsAppRpcGroupInviteRecord {
  groupJid: string;
  code: string;
  inviteLink: string;
}

export interface WhatsAppRpcGroupMetadataParticipant {
  /** Participant JID as WhatsApp reports it (may be `@lid`). */
  platformUserId: string;
  phoneJid?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
  role: "owner" | "admin" | "member";
}

export interface WhatsAppRpcGroupMetadata {
  groupJid: string;
  subject: string | null;
  description?: string | null;
  owner?: string | null;
  participants: WhatsAppRpcGroupMetadataParticipant[];
  fetchedAt: number;
}

export interface WhatsAppRpcSendResult {
  messageId: string;
  status: "sent";
}

/** `data` returned per method. */
export interface WhatsAppRpcResults {
  "connection.status": { state: WhatsAppConnectionState; isConnected: boolean; profileName: string | null };
  "connection.connect": { status: string; message: string };
  "connection.disconnect": Record<string, never>;
  /**
   * `unlinked`: WhatsApp was asked to unlink the device (the runtime was connected and the
   * request went out). False: only the stored creds were wiped, and the device stays listed on
   * the phone. Absent from runners that predate the field: treat it as false.
   */
  "connection.logout": { unlinked?: boolean };
  "connection.pairingCode": { code: string };
  /**
   * `participantsTruncated`: the full list would not fit in one NATS message (~1 MB), so
   * every record's `participants` is empty (`memberCount` stays exact); use
   * `groups.metadata` for the members of one group.
   */
  "groups.list": { items: WhatsAppRpcGroupRecord[]; participantsTruncated?: boolean };
  "groups.create": WhatsAppRpcGroupRecord;
  "groups.addParticipants": { groupJid: string; results: Array<{ jid: string; status: string }> };
  "groups.updateParticipants": { groupJid: string; results: Array<{ jid: string; status: string }> };
  "groups.getInvite": WhatsAppRpcGroupInviteRecord;
  "groups.revokeInvite": WhatsAppRpcGroupInviteRecord;
  "groups.join": { groupJid: string; joined: boolean };
  "groups.leave": { groupJid: string; left: boolean };
  "groups.rename": { groupJid: string; subject: string };
  "groups.setDescription": { groupJid: string; description: string };
  "groups.setSettings": { groupJid: string; setting: string };
  "groups.metadata": WhatsAppRpcGroupMetadata;
  "messages.sendText": WhatsAppRpcSendResult;
  "presence.set": Record<string, never>;
  "messages.react": { messageId: string; success: boolean };
  "messages.delete": Record<string, never>;
  "messages.edit": Record<string, never>;
  "messages.sendMedia": WhatsAppRpcSendResult;
  "messages.sendSticker": WhatsAppRpcSendResult;
  "messages.markRead": Record<string, never>;
}

export type WhatsAppRpcResult<M extends WhatsAppRpcMethod> = WhatsAppRpcResults[M];

/** Stable error codes shared by the runner and its clients. */
export const WHATSAPP_RPC_ERROR_CODES = {
  invalidRequest: "INVALID_REQUEST",
  notConnected: "NOT_CONNECTED",
  notFound: "NOT_FOUND",
  pairingRequired: "PAIRING_REQUIRED",
  rateLimited: "RATE_LIMITED",
  transportError: "TRANSPORT_ERROR",
  runnerUnavailable: "WHATSAPP_RUNNER_UNAVAILABLE",
  timeout: "WHATSAPP_RPC_TIMEOUT",
  /** Client-side, 404: the instance ref is not bound to an enabled WhatsApp channel. */
  notBound: "WHATSAPP_NOT_BOUND",
} as const;

// ============================================================================
// Ownership (channel ↔ instance binding)
// ============================================================================

export interface WhatsAppBinding {
  /** Ravi account / instance name. */
  readonly accountName: string;
  /** Transport instance id (the instance UUID). */
  readonly instanceId: string;
  readonly channel: ChannelConfig;
  readonly instance: InstanceConfig;
}

export type OwnershipConfig = Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;

function boundInstanceName(channel: ChannelConfig): string {
  const override = channel.defaults?.instance;
  return typeof override === "string" && override.trim() ? override.trim() : channel.name;
}

/** Every enabled WhatsApp channel that is bound to a non-deleted instance with a transport id. */
export function listWhatsAppBindings(config: OwnershipConfig): WhatsAppBinding[] {
  const bindings: WhatsAppBinding[] = [];
  for (const channel of Object.values(config.channels ?? {})) {
    if (channel.enabled === false || channel.deletedAt) continue;
    if (canonicalChannelId(channel.provider) !== WHATSAPP_PROVIDER) continue;
    const accountName = boundInstanceName(channel);
    const instance = config.instances?.[accountName];
    const instanceId = instance?.instanceId?.trim();
    if (!instance || !instanceId || instance.deletedAt) continue;
    bindings.push({ accountName, instanceId, channel, instance });
  }
  return bindings;
}

/** Resolve a WhatsApp binding from an instance UUID or account name. */
export function resolveWhatsAppBinding(
  config: OwnershipConfig,
  ref: string | undefined | null,
): WhatsAppBinding | null {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  const accountName = config.instanceToAccount?.[trimmed] ?? trimmed;
  return (
    listWhatsAppBindings(config).find(
      (binding) => binding.instanceId === trimmed || binding.accountName === accountName,
    ) ?? null
  );
}

export function isWhatsAppBound(config: OwnershipConfig, ref: string | undefined | null): boolean {
  return resolveWhatsAppBinding(config, ref) !== null;
}

/**
 * Natively served WhatsApp channel type: `canonicalChannelId(t) === "whatsapp"`, i.e. exactly
 * `whatsapp`, `whatsapp-baileys` and `whatsapp baileys`.
 */
export function isWhatsAppChannelType(channelType: string | null | undefined): boolean {
  if (typeof channelType !== "string" || !channelType.trim()) return false;
  return canonicalChannelId(channelType) === WHATSAPP_PROVIDER;
}

/**
 * Any WhatsApp-family channel type: canonical WhatsApp, any type mentioning `whatsapp`
 * (`twilio-whatsapp`, `whatsapp-cloud`, …) or `gupshup`. Used only to DROP or REJECT:
 * a family type that is not canonical is unsupported in every direction.
 */
export function isWhatsAppFamilyChannelType(channelType: string | null | undefined): boolean {
  if (typeof channelType !== "string") return false;
  return (
    isWhatsAppChannelType(channelType) ||
    /whatsapp/i.test(channelType) ||
    channelType.trim().toLowerCase() === "gupshup"
  );
}

/** Instance record whose `channel` satisfies isWhatsAppChannelType. */
export function isWhatsAppInstanceConfig(instance: Pick<InstanceConfig, "channel"> | null | undefined): boolean {
  return isWhatsAppChannelType(instance?.channel);
}

/**
 * The non-deleted channel with canonical provider whatsapp whose bound instance name is
 * `accountName`, including disabled ones (listWhatsAppBindings skips them). Used by
 * `instances enable/disable` and by provisioning.
 */
export function findWhatsAppChannelForInstance(
  config: Pick<RouterConfig, "channels">,
  accountName: string,
): ChannelConfig | null {
  const name = accountName.trim();
  if (!name) return null;
  for (const channel of Object.values(config.channels ?? {})) {
    if (channel.deletedAt) continue;
    if (canonicalChannelId(channel.provider) !== WHATSAPP_PROVIDER) continue;
    if (boundInstanceName(channel) === name) return channel;
  }
  return null;
}

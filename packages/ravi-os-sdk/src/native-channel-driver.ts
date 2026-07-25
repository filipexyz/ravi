import { z } from "zod";
import {
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  type ChannelIngressRequest,
  type ChannelIngressResult,
  type ChannelOutputSink,
  type ExternalChannelIdentity,
} from "./channel-backend.js";
import type {
  ChannelInterruptRequest,
  ChannelInterruptResult,
  ChannelRuntimeEventSink,
  ChannelRuntimeReadbackRequest,
  ChannelRuntimeReadbackResult,
} from "./channel-runtime-events.js";
import type { RemoteInstallationCredential } from "./remote-login-provider.js";

export const NATIVE_CHANNEL_DRIVER_PROTOCOL = "ravi.channel.native-driver" as const;
export const NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION = 1 as const;

export const NativeChannelDriverCapabilitySchema = z.enum([
  "inbound",
  "text_delivery",
  "chat_actions",
  "presence",
]);

export const NativeChannelDriverCapabilitiesSchema = z
  .array(NativeChannelDriverCapabilitySchema)
  .min(1)
  .max(4);

export const NativeChannelDriverHostCapabilitySchema = z.enum(["installation_credentials"]);

export const NativeChannelDriverHostCapabilitiesSchema = z
  .array(NativeChannelDriverHostCapabilitySchema)
  .min(1)
  .max(1);

export const NativeChannelDriverModuleSpecifierSchema = z
  .string()
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*|file:\/\/\/[^\u0000-\u001f\u007f]+)$/,
    "must be an installed package name or an absolute file URL",
  );

export const NativeChannelDriverModuleConfigSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  provider: ChannelBackendWireKindSchema,
  moduleSpecifier: NativeChannelDriverModuleSpecifierSchema,
});

export const NativeChannelDriverDescriptorSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  driverId: ChannelBackendWireKindSchema,
  provider: ChannelBackendWireKindSchema,
  capabilities: NativeChannelDriverCapabilitiesSchema,
  requiredHostCapabilities: NativeChannelDriverHostCapabilitiesSchema.optional(),
});

export const NativeChannelRuntimeDescriptorSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  driverId: ChannelBackendWireKindSchema,
  provider: ChannelBackendWireKindSchema,
  runtimeId: ChannelBackendOpaqueIdSchema,
  channelInstanceId: ChannelBackendOpaqueIdSchema,
  capabilities: NativeChannelDriverCapabilitiesSchema,
});

export const NativeChannelRuntimeHealthSchema = z.object({
  status: z.enum([
    "disabled",
    "starting",
    "connected",
    "degraded",
    "reconnecting",
    "disconnected",
    "failed",
  ]),
  reason: ChannelBackendWireKindSchema.optional(),
  connectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lastPongAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reconnectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type NativeChannelDriverCapability = z.infer<typeof NativeChannelDriverCapabilitySchema>;
export type NativeChannelDriverHostCapability = z.infer<typeof NativeChannelDriverHostCapabilitySchema>;
export type NativeChannelDriverModuleConfig = z.infer<typeof NativeChannelDriverModuleConfigSchema>;
export type NativeChannelDriverDescriptor = z.infer<typeof NativeChannelDriverDescriptorSchema>;
export type NativeChannelRuntimeDescriptor = z.infer<typeof NativeChannelRuntimeDescriptorSchema>;
export type NativeChannelRuntimeHealth = z.infer<typeof NativeChannelRuntimeHealthSchema>;

export interface NativeChannelDriverChannelConfig {
  readonly name: string;
  readonly provider: string;
  readonly credentialConnection?: string;
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export interface NativeChannelTarget {
  readonly channel: string;
  readonly accountId: string;
  readonly instanceId?: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly sourceMessageId?: string;
  readonly statusAnchorMessageId?: string;
  readonly statusAnchorKind?: "last_outbound_message" | "chat_thread_transient" | "draft_outbound_message" | "none";
  readonly suppressPresence?: boolean;
  readonly canonicalChatId?: string;
  readonly actorType?: "contact" | "agent" | "system" | "unknown" | (string & {});
  readonly contactId?: string;
  readonly actorAgentId?: string;
  readonly automationId?: string;
  readonly platformIdentityId?: string;
  readonly rawSenderId?: string;
  readonly normalizedSenderId?: string;
  readonly identityConfidence?: number;
  readonly identityProvenance?: Readonly<Record<string, unknown>>;
}

export type NativeChannelChatAction =
  | {
      readonly type: "chat_action";
      readonly actionId: "message.delete";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
    }
  | {
      readonly type: "chat_action";
      readonly actionId: "message.edit";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
      readonly text: string;
    }
  | {
      readonly type: "chat_action";
      readonly actionId: "message.react";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
      readonly emoji: string;
      readonly operation?: "add" | "remove";
    };

export interface NativeChannelTextDeliveryRequest {
  readonly sessionName: string;
  readonly emitId?: string;
  readonly idempotencyKey: string;
  readonly target: NativeChannelTarget;
  readonly text: string;
}

export interface NativeChannelTextDeliveryResult {
  readonly provider: string;
  readonly messageId?: string;
  readonly platformMessageId?: string;
  readonly providerTimestamp?: number;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface NativeChannelTextDelivery {
  readonly channelId: string;
  supports(target: NativeChannelTarget): boolean;
  deliverText(request: NativeChannelTextDeliveryRequest): Promise<NativeChannelTextDeliveryResult>;
}

export interface NativeChannelChatActionDeliveryRequest {
  readonly sessionName: string;
  readonly emitId?: string;
  readonly idempotencyKey: string;
  readonly target: NativeChannelTarget;
  readonly action: NativeChannelChatAction;
}

export interface NativeChannelChatActionDeliveryResult {
  readonly provider: string;
  readonly messageId?: string;
  readonly platformMessageId?: string;
  readonly providerTimestamp?: number;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface NativeChannelChatActionDelivery {
  readonly channelId: string;
  supports(target: NativeChannelTarget): boolean;
  executeChatAction(
    request: NativeChannelChatActionDeliveryRequest,
  ): Promise<NativeChannelChatActionDeliveryResult>;
}

export interface NativeChannelPresenceDeliveryRequest {
  readonly sessionName: string;
  readonly target: NativeChannelTarget;
  readonly active: boolean;
  readonly reason?: string;
}

export interface NativeChannelPresenceDeliveryResult {
  readonly provider: string;
  readonly status: "active" | "inactive" | "skipped";
  readonly reason?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface NativeChannelPresenceDelivery {
  readonly channelId: string;
  supports(target: NativeChannelTarget): boolean;
  sendPresence(request: NativeChannelPresenceDeliveryRequest): Promise<NativeChannelPresenceDeliveryResult>;
}

export interface NativeChannelDriverHost {
  readInstallationCredential(): Promise<RemoteInstallationCredential | null>;
  ingress(request: ChannelIngressRequest): Promise<ChannelIngressResult>;
  interrupt(request: ChannelInterruptRequest): Promise<ChannelInterruptResult>;
  readback(request: ChannelRuntimeReadbackRequest): Promise<ChannelRuntimeReadbackResult>;
  registerOutputSink(
    target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">,
    sink: ChannelOutputSink,
  ): () => void;
  registerRuntimeEventSink(
    target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">,
    sink: ChannelRuntimeEventSink,
  ): () => void;
}

export interface NativeChannelDriverContext {
  readonly channel: NativeChannelDriverChannelConfig;
  readonly host: NativeChannelDriverHost;
}

export interface NativeChannelDriverRuntime {
  readonly descriptor: NativeChannelRuntimeDescriptor;
  readonly delivery?: NativeChannelTextDelivery;
  readonly actions?: NativeChannelChatActionDelivery;
  readonly presence?: NativeChannelPresenceDelivery;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): NativeChannelRuntimeHealth;
}

export interface NativeChannelDriver {
  readonly descriptor: NativeChannelDriverDescriptor;
  createRuntime(context: NativeChannelDriverContext): NativeChannelDriverRuntime | Promise<NativeChannelDriverRuntime>;
}

export interface NativeChannelDriverModule {
  readonly nativeChannelDriver: NativeChannelDriver;
}

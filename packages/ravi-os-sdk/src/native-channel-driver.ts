import { z } from "zod";
import {
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  ChannelSafeErrorSchema,
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
export const MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES = 512;
export const MAX_NATIVE_INBOUND_ACTION_RESPONSE_BYTES = 4_096;

const nativeChannelTextEncoder = new TextEncoder();

function boundedNativeChannelString(maxBytes: number, label: string) {
  return z
    .string()
    .refine(
      (value) => nativeChannelTextEncoder.encode(value).byteLength >= 1,
      `${label} must not be empty`,
    )
    .refine(
      (value) => nativeChannelTextEncoder.encode(value).byteLength <= maxBytes,
      `${label} exceeds ${maxBytes} UTF-8 bytes`,
    );
}

export const NativeChannelDriverCapabilitySchema = z.enum([
  "inbound",
  "inbound_actions",
  "text_delivery",
  "chat_actions",
  "presence",
]);

export const NativeChannelDriverCapabilitiesSchema = z
  .array(NativeChannelDriverCapabilitySchema)
  .min(1)
  .max(NativeChannelDriverCapabilitySchema.options.length)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length);

export const NativeInboundChannelActionNamesSchema = z
  .array(ChannelBackendWireKindSchema)
  .max(32)
  .refine((actions) => new Set(actions).size === actions.length);

export const NativeChannelDriverHostCapabilitySchema = z.enum(["installation_credentials"]);

export const NativeChannelDriverHostCapabilitiesSchema = z
  .array(NativeChannelDriverHostCapabilitySchema)
  .min(1)
  .max(1)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length);

export const NativeChannelDriverModuleSpecifierSchema = z
  .string()
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*|file:\/\/\/[^\u0000-\u001f\u007f]+)$/,
    "must be an installed package name or an absolute file URL",
  );

export const NativeChannelDriverModuleConfigSchema = z
  .object({
    protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
    schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
    provider: ChannelBackendWireKindSchema,
    moduleSpecifier: NativeChannelDriverModuleSpecifierSchema,
    inboundActions: NativeInboundChannelActionNamesSchema.optional(),
  })
  .strict();

export const NativeChannelDriverDescriptorSchema = z
  .object({
    protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
    schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
    driverId: ChannelBackendWireKindSchema,
    provider: ChannelBackendWireKindSchema,
    capabilities: NativeChannelDriverCapabilitiesSchema,
    inboundActions: NativeInboundChannelActionNamesSchema.optional(),
    requiredHostCapabilities: NativeChannelDriverHostCapabilitiesSchema.optional(),
  })
  .superRefine(validateInboundActionDeclaration);

export const NativeChannelRuntimeDescriptorSchema = z
  .object({
    protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
    schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
    driverId: ChannelBackendWireKindSchema,
    provider: ChannelBackendWireKindSchema,
    runtimeId: ChannelBackendOpaqueIdSchema,
    channelInstanceId: ChannelBackendOpaqueIdSchema,
    capabilities: NativeChannelDriverCapabilitiesSchema,
    inboundActions: NativeInboundChannelActionNamesSchema.optional(),
  })
  .superRefine(validateInboundActionDeclaration);

function validateInboundActionDeclaration(
  value: {
    capabilities: readonly string[];
    inboundActions?: readonly string[];
  },
  context: z.RefinementCtx,
): void {
  const declared = value.capabilities.includes("inbound_actions");
  if (
    declared !==
    (value.inboundActions !== undefined && value.inboundActions.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["inboundActions"],
      message: "inbound_actions capability requires a non-empty action declaration",
    });
  }
}

export const NativeInboundChannelIdentitySchema = z
  .object({
    channelKind: ChannelBackendWireKindSchema,
    accountId: boundedNativeChannelString(
      MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES,
      "native inbound action account identity",
    ),
    conversationId: boundedNativeChannelString(
      MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES,
      "native inbound action conversation identity",
    ),
    senderId: boundedNativeChannelString(
      MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES,
      "native inbound action sender identity",
    ),
    messageId: boundedNativeChannelString(
      MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES,
      "native inbound action message identity",
    ),
  })
  .strict();

export const NativeInboundChannelActionRequestSchema = z
  .object({
    protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
    schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    action: ChannelBackendWireKindSchema,
    hasArguments: z.boolean(),
    identity: NativeInboundChannelIdentitySchema,
    requestedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const NativeInboundChannelActionResultSchema = z
  .object({
    protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
    schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    disposition: z.enum(["handled", "pass"]),
    text: boundedNativeChannelString(
      MAX_NATIVE_INBOUND_ACTION_RESPONSE_BYTES,
      "native inbound action response",
    ).optional(),
    error: ChannelSafeErrorSchema.optional(),
    completedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const responseFields = Number(value.text !== undefined) + Number(value.error !== undefined);
    if (
      (value.disposition === "handled" && responseFields !== 1) ||
      (value.disposition === "pass" && responseFields !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "handled actions require exactly one response; pass actions carry none",
      });
    }
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
export type NativeInboundChannelActionNames = z.infer<typeof NativeInboundChannelActionNamesSchema>;
export type NativeInboundChannelIdentity = z.infer<typeof NativeInboundChannelIdentitySchema>;
export type NativeInboundChannelActionRequest = z.infer<typeof NativeInboundChannelActionRequestSchema>;
export type NativeInboundChannelActionResult = z.infer<typeof NativeInboundChannelActionResultSchema>;

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
  readonly inboundActions?: NativeInboundChannelActionHandler;
  readonly delivery?: NativeChannelTextDelivery;
  readonly actions?: NativeChannelChatActionDelivery;
  readonly presence?: NativeChannelPresenceDelivery;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): NativeChannelRuntimeHealth;
}

export interface NativeInboundChannelActionHandler {
  supports(action: string): boolean;
  handle(
    request: NativeInboundChannelActionRequest,
  ): NativeInboundChannelActionResult | Promise<NativeInboundChannelActionResult>;
}

export interface NativeChannelDriver {
  readonly descriptor: NativeChannelDriverDescriptor;
  createRuntime(context: NativeChannelDriverContext): NativeChannelDriverRuntime | Promise<NativeChannelDriverRuntime>;
}

export interface NativeChannelDriverModule {
  readonly nativeChannelDriver: NativeChannelDriver;
}

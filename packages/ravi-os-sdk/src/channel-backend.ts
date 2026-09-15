import { z } from "zod";

export const CHANNEL_BACKEND_PROTOCOL = "ravi.channel.backend" as const;
export const CHANNEL_BACKEND_SCHEMA_VERSION = 1 as const;
export const CHANNEL_BACKEND_MAX_CONTENT_BLOCKS = 256;
export const CHANNEL_BACKEND_MAX_TEXT_BYTES = 1_048_576;

const textEncoder = new TextEncoder();

function boundedUtf8String(maxBytes: number, label: string, minBytes = 1) {
  return z
    .string()
    .refine((value) => textEncoder.encode(value).byteLength >= minBytes, `${label} must not be empty`)
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, `${label} exceeds ${maxBytes} UTF-8 bytes`);
}

export const ChannelBackendOpaqueIdSchema = boundedUtf8String(128, "identifier").regex(
  /^[A-Za-z0-9][A-Za-z0-9._~-]*$/,
  "must be an opaque URL-safe identifier",
);

export const ChannelBackendWireKindSchema = boundedUtf8String(96, "kind").regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  "must be a lowercase namespaced kind",
);

export const ChannelSafeErrorSchema = z.object({
  code: z.enum([
    "INVALID_REQUEST",
    "IDEMPOTENCY_CONFLICT",
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "LOCAL_PERMISSION_DENIED",
    "NOT_FOUND",
    "RATE_LIMITED",
    "OVERLOADED",
    "UNAVAILABLE",
    "INTERNAL",
  ]),
  category: z.enum([
    "validation",
    "authentication",
    "authorization",
    "capacity",
    "availability",
    "internal",
  ]),
  retryable: z.boolean(),
  correlationId: ChannelBackendOpaqueIdSchema.optional(),
  retryAfterMs: z.number().int().positive().max(86_400_000).optional(),
});

export const ChannelTextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: boundedUtf8String(CHANNEL_BACKEND_MAX_TEXT_BYTES, "channel text block"),
});

export const ChannelArtifactContentBlockSchema = z.object({
  type: z.literal("artifact"),
  artifactId: ChannelBackendOpaqueIdSchema,
  name: boundedUtf8String(256, "channel artifact name").optional(),
  mediaType: boundedUtf8String(128, "channel artifact media type")
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/,
      "must be a media type",
    )
    .optional(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const ChannelContentBlockSchema = z.discriminatedUnion("type", [
  ChannelTextContentBlockSchema,
  ChannelArtifactContentBlockSchema,
]);

export const ChannelContentSchema = z
  .array(ChannelContentBlockSchema)
  .min(1)
  .max(CHANNEL_BACKEND_MAX_CONTENT_BLOCKS);

export const ExternalChannelIdentitySchema = z.object({
  channelKind: ChannelBackendWireKindSchema,
  connectionId: ChannelBackendOpaqueIdSchema,
  conversationId: ChannelBackendOpaqueIdSchema,
  senderId: ChannelBackendOpaqueIdSchema,
  messageId: ChannelBackendOpaqueIdSchema,
});

export const LocalChannelMessageBindingSchema = z.object({
  channelInstanceId: ChannelBackendOpaqueIdSchema,
  agentId: ChannelBackendOpaqueIdSchema,
  chatId: ChannelBackendOpaqueIdSchema,
  messageId: ChannelBackendOpaqueIdSchema,
  sessionId: ChannelBackendOpaqueIdSchema,
  turnId: ChannelBackendOpaqueIdSchema,
});

export const ChannelIngressRequestSchema = z.object({
  protocol: z.literal(CHANNEL_BACKEND_PROTOCOL),
  schemaVersion: z.literal(CHANNEL_BACKEND_SCHEMA_VERSION),
  requestId: ChannelBackendOpaqueIdSchema,
  idempotencyKey: ChannelBackendOpaqueIdSchema,
  localActorId: ChannelBackendOpaqueIdSchema,
  channelInstanceId: ChannelBackendOpaqueIdSchema,
  agentId: ChannelBackendOpaqueIdSchema,
  external: ExternalChannelIdentitySchema,
  content: ChannelContentSchema,
  receivedAt: z.string().datetime({ offset: true }),
});

export const ChannelIngressResultSchema = z
  .object({
    protocol: z.literal(CHANNEL_BACKEND_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    disposition: z.enum(["accepted", "duplicate", "rejected"]),
    binding: LocalChannelMessageBindingSchema.optional(),
    error: ChannelSafeErrorSchema.optional(),
    acceptedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (value.disposition === "rejected") {
      if (value.error === undefined || value.binding !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["disposition"],
          message: "rejected ingress requires an error and no binding",
        });
      }
      return;
    }
    if (value.binding === undefined || value.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "accepted ingress requires a binding and no error",
      });
    }
  });

export const ExternalChannelTargetSchema = z.object({
  channelKind: ChannelBackendWireKindSchema,
  connectionId: ChannelBackendOpaqueIdSchema,
  conversationId: ChannelBackendOpaqueIdSchema,
});

export const ChannelOutputEnvelopeSchema = z
  .object({
    protocol: z.literal(CHANNEL_BACKEND_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_SCHEMA_VERSION),
    outputId: ChannelBackendOpaqueIdSchema,
    correlationId: ChannelBackendOpaqueIdSchema,
    causationId: ChannelBackendOpaqueIdSchema.optional(),
    binding: LocalChannelMessageBindingSchema,
    target: ExternalChannelTargetSchema,
    kind: z.enum(["assistant_message", "safe_error"]),
    content: ChannelContentSchema.optional(),
    error: ChannelSafeErrorSchema.optional(),
    emittedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (value.kind === "assistant_message" && (value.content === undefined || value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "assistant output requires content and no error",
      });
    }
    if (value.kind === "safe_error" && (value.error === undefined || value.content !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "error output requires a safe error and no content",
      });
    }
  });

export type ChannelSafeError = z.infer<typeof ChannelSafeErrorSchema>;
export type ChannelTextContentBlock = z.infer<typeof ChannelTextContentBlockSchema>;
export type ChannelArtifactContentBlock = z.infer<typeof ChannelArtifactContentBlockSchema>;
export type ChannelContent = z.infer<typeof ChannelContentSchema>;
export type ExternalChannelIdentity = z.infer<typeof ExternalChannelIdentitySchema>;
export type ExternalChannelTarget = z.infer<typeof ExternalChannelTargetSchema>;
export type LocalChannelMessageBinding = z.infer<typeof LocalChannelMessageBindingSchema>;
export type ChannelIngressRequest = z.infer<typeof ChannelIngressRequestSchema>;
export type ChannelIngressResult = z.infer<typeof ChannelIngressResultSchema>;
export type ChannelOutputEnvelope = z.infer<typeof ChannelOutputEnvelopeSchema>;

export interface ChannelBackendCommandClient {
  readonly channels: {
    readonly backend: {
      ingress(agentId: string, request: ChannelIngressRequest): Promise<unknown>;
    };
  };
}

export class RaviChannelBackendClient {
  constructor(private readonly client: ChannelBackendCommandClient) {}

  async ingress(input: ChannelIngressRequest): Promise<ChannelIngressResult> {
    const request = ChannelIngressRequestSchema.parse(input);
    const result = await this.client.channels.backend.ingress(request.agentId, request);
    return ChannelIngressResultSchema.parse(result);
  }
}

export function createChannelBackendClient(client: ChannelBackendCommandClient): RaviChannelBackendClient {
  return new RaviChannelBackendClient(client);
}

export interface ChannelOutputSink {
  emit(envelope: ChannelOutputEnvelope): Promise<void>;
}

export class ChannelOutputSinkRegistry {
  private readonly sinks = new Map<string, ChannelOutputSink>();

  register(
    target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">,
    sink: ChannelOutputSink,
  ): () => void {
    const channelKind = ChannelBackendWireKindSchema.parse(target.channelKind);
    const connectionId = ChannelBackendOpaqueIdSchema.parse(target.connectionId);
    const key = sinkKey(channelKind, connectionId);
    if (this.sinks.has(key)) {
      throw new Error(`Channel output sink is already registered for ${channelKind}/${connectionId}`);
    }
    this.sinks.set(key, sink);
    return () => {
      if (this.sinks.get(key) === sink) this.sinks.delete(key);
    };
  }

  async emit(input: ChannelOutputEnvelope): Promise<void> {
    const envelope = ChannelOutputEnvelopeSchema.parse(input);
    const sink = this.sinks.get(sinkKey(envelope.target.channelKind, envelope.target.connectionId));
    if (!sink) {
      throw new Error(
        `Channel output sink is unavailable for ${envelope.target.channelKind}/${envelope.target.connectionId}`,
      );
    }
    await sink.emit(envelope);
  }
}

function sinkKey(channelKind: string, connectionId: string): string {
  return `${channelKind}\u0000${connectionId}`;
}

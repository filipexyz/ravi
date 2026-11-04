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

/** Internal durable Slack adapter contract; this capability grants no authority. */
export const CHANNEL_OUTPUT_HANDOFF_CAPABILITY = "ravi.channel.output.durable-slack.v1" as const;
export const CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION = 1 as const;

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z
  .object({
    channelInstanceId: opaqueId,
    agentId: opaqueId,
    chatId: opaqueId,
    messageId: opaqueId,
    sessionId: opaqueId,
    turnId: opaqueId,
  })
  .strict();
const target = z
  .object({
    channelKind: z.string().min(1).max(96).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    connectionId: opaqueId,
    conversationId: opaqueId,
  })
  .strict();

/**
 * Only a restriction travels across the runner boundary. Receivers must support
 * this exact capability before calling a sink, and compare a pinned fingerprint
 * before saving. No owner callback, retry permission or downgrade is encoded.
 */
export const ChannelOutputEmissionContextSchema = z
  .object({
    capability: z.literal(CHANNEL_OUTPUT_HANDOFF_CAPABILITY),
    expectedRequestFingerprint: fingerprint.optional(),
  })
  .strict();

/**
 * Sanitized correlation for one frozen output. The hash covers the full envelope
 * (including content, error, correlation and emittedAt); explicit binding and
 * target prevent a matching output id alone from authorizing another target.
 */
export const ChannelOutputHandoffIdentitySchema = z
  .object({
    outputId: opaqueId,
    outputFingerprint: fingerprint,
    binding,
    target,
  })
  .strict();

/** Closed SQLite codes only; arbitrary error messages never authorize a retry. */
export const ChannelOutputHandoffTransientCodeSchema = z.enum([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB",
]);

const evidenceBase = {
  capability: z.literal(CHANNEL_OUTPUT_HANDOFF_CAPABILITY),
  schemaVersion: z.literal(CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION),
  identity: ChannelOutputHandoffIdentitySchema,
};
const preparedIdentity = {
  idempotencyKey: opaqueId,
  requestFingerprint: fingerprint,
};

/**
 * Positive save evidence from the known adapter, never a Slack delivery ACK.
 * Pending/deferred ownership belongs to the existing outbox reconciler;
 * published and suppressed are terminal for host handoff, including coalescing.
 * A generic resolved Promise<void> or legacy ok:true cannot populate this type.
 */
export const ChannelOutputHandoffConfirmationSchema = z
  .object({
    ...evidenceBase,
    ...preparedIdentity,
    durableSaveConfirmed: z.literal(true),
    disposition: z.enum(["pending", "deferred", "published", "suppressed"]),
  })
  .strict();

/**
 * Completed pre-save absence is the only retry candidate. It requires a real
 * prepared job and a readback made after the synchronous save returned/threw.
 * Not-started has no job fingerprint and is never automatically replayed.
 * Unknown includes timeouts and unreadable state; absence during an in-flight
 * call is not evidence of rollback. Conflict is permanently non-retryable.
 */
export const ChannelOutputHandoffEvidenceSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      ...evidenceBase,
      disposition: z.literal("not_started"),
      operationFinished: z.literal(true),
      code: z.enum(["SINK_UNAVAILABLE", "UNSUPPORTED_CAPABILITY"]),
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      ...preparedIdentity,
      disposition: z.literal("finished_pre_save_missing"),
      operationFinished: z.literal(true),
      code: ChannelOutputHandoffTransientCodeSchema,
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      idempotencyKey: opaqueId.optional(),
      requestFingerprint: fingerprint.optional(),
      disposition: z.literal("conflict"),
      operationFinished: z.literal(true),
      code: z.enum(["REQUEST_FINGERPRINT_CONFLICT", "OUTPUT_IDENTITY_CONFLICT", "INVALID_OUTPUT"]),
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      idempotencyKey: opaqueId.optional(),
      requestFingerprint: fingerprint.optional(),
      disposition: z.literal("unknown"),
      operationFinished: z.boolean(),
      code: z.enum([
        "OUTCOME_UNKNOWN",
        "UNCLASSIFIED",
        "OUTBOX_SAVE_FAILED",
        "OUTBOX_READBACK_FAILED",
        "INVALID_CONFIRMATION",
        "TRANSPORT_FAILED",
      ]),
    })
    .strict(),
]);

export type ChannelOutputEmissionContext = z.infer<typeof ChannelOutputEmissionContextSchema>;
export type ChannelOutputHandoffIdentity = z.infer<typeof ChannelOutputHandoffIdentitySchema>;
export type ChannelOutputHandoffTransientCode = z.infer<typeof ChannelOutputHandoffTransientCodeSchema>;
export type ChannelOutputHandoffConfirmation = z.infer<typeof ChannelOutputHandoffConfirmationSchema>;
export type ChannelOutputHandoffEvidence = z.infer<typeof ChannelOutputHandoffEvidenceSchema>;

/**
 * Typed, sanitized evidence only. Construction clones, validates and freezes the
 * fields so later code cannot replace the caller's first prepared fingerprint.
 * Transport must parse the same schema rather than reconstructing from messages.
 */
export class ChannelOutputHandoffError extends Error {
  readonly evidence: ChannelOutputHandoffEvidence;

  constructor(evidence: ChannelOutputHandoffEvidence) {
    const parsed = ChannelOutputHandoffEvidenceSchema.parse(evidence);
    super(`Channel output handoff ${parsed.disposition}: ${parsed.code}`);
    this.name = "ChannelOutputHandoffError";
    this.evidence = freezeHandoffValue(parsed);
  }
}

/** The optional contract is a restriction, never an authorization grant. */
export interface ChannelOutputSink {
  readonly handoffCapability?: typeof CHANNEL_OUTPUT_HANDOFF_CAPABILITY;
  emit(
    envelope: ChannelOutputEnvelope,
    context?: ChannelOutputEmissionContext,
  ): Promise<void> | Promise<ChannelOutputHandoffConfirmation | undefined>;
}

export interface ChannelOutputSinkEmission {
  readonly emitted: boolean;
  readonly confirmation?: ChannelOutputHandoffConfirmation;
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

  async emit(
    input: ChannelOutputEnvelope,
    context?: ChannelOutputEmissionContext,
  ): Promise<ChannelOutputHandoffConfirmation | undefined> {
    const envelope = freezeHandoffValue(ChannelOutputEnvelopeSchema.parse(input));
    const result = await this.tryEmitWithHandoff(envelope, context);
    if (!result.emitted) {
      throw new ChannelOutputHandoffError({
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
        identity: await createOutputHandoffIdentity(envelope),
        disposition: "not_started",
        operationFinished: true,
        code: "SINK_UNAVAILABLE",
      });
    }
    return result.confirmation;
  }

  /** True reports invocation only, never save or delivery. Context is preserved. */
  async tryEmit(input: ChannelOutputEnvelope, context?: ChannelOutputEmissionContext): Promise<boolean> {
    return (await this.tryEmitWithHandoff(input, context)).emitted;
  }

  /** Refuses unsupported restricted invocations before entering the sink. */
  async tryEmitWithHandoff(
    input: ChannelOutputEnvelope,
    context?: ChannelOutputEmissionContext,
  ): Promise<ChannelOutputSinkEmission> {
    const envelope = freezeHandoffValue(ChannelOutputEnvelopeSchema.parse(input));
    const restriction =
      context === undefined ? undefined : Object.freeze(ChannelOutputEmissionContextSchema.parse(context));
    const sink = this.sinks.get(sinkKey(envelope.target.channelKind, envelope.target.connectionId));
    if (!sink) return { emitted: false };
    const known = sink.handoffCapability === CHANNEL_OUTPUT_HANDOFF_CAPABILITY;
    if (restriction && !known) {
      throw new ChannelOutputHandoffError({
        capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
        schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
        identity: await createOutputHandoffIdentity(envelope),
        disposition: "not_started",
        operationFinished: true,
        code: "UNSUPPORTED_CAPABILITY",
      });
    }
    let result: Awaited<ReturnType<ChannelOutputSink["emit"]>>;
    try {
      result = restriction === undefined ? await sink.emit(envelope) : await sink.emit(envelope, restriction);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ChannelOutputHandoffError") throw error;
      const identity = await createOutputHandoffIdentity(envelope);
      const parsed = ChannelOutputHandoffEvidenceSchema.safeParse("evidence" in error ? error.evidence : undefined);
      if (!known || !parsed.success ||
        canonicalOutputJson(parsed.data.identity) !== canonicalOutputJson(identity) ||
        ("idempotencyKey" in parsed.data && parsed.data.idempotencyKey !== undefined &&
          parsed.data.idempotencyKey !== envelope.outputId)) {
        throw unknownOutputHandoff(identity, "UNCLASSIFIED");
      }
      const evidence = parsed.data;
      if (restriction?.expectedRequestFingerprint !== undefined &&
        "requestFingerprint" in evidence && evidence.requestFingerprint !== undefined &&
        evidence.requestFingerprint !== restriction.expectedRequestFingerprint) {
        // A changed fingerprint forbids replay but cannot certify an ongoing operation finished.
        if (evidence.disposition === "unknown" && evidence.operationFinished === false) {
          throw new ChannelOutputHandoffError(evidence);
        }
        throw new ChannelOutputHandoffError({
          capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
          schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
          identity,
          disposition: "conflict",
          operationFinished: true,
          code: "REQUEST_FINGERPRINT_CONFLICT",
          ...("idempotencyKey" in evidence ? { idempotencyKey: evidence.idempotencyKey } : {}),
          requestFingerprint: evidence.requestFingerprint,
        });
      }
      throw new ChannelOutputHandoffError(evidence);
    }
    if (result === undefined) return { emitted: true };
    const identity = await createOutputHandoffIdentity(envelope);
    const confirmation = ChannelOutputHandoffConfirmationSchema.safeParse(result);
    if (!known || !confirmation.success ||
      canonicalOutputJson(confirmation.data.identity) !== canonicalOutputJson(identity) ||
      confirmation.data.idempotencyKey !== envelope.outputId ||
      (restriction?.expectedRequestFingerprint !== undefined &&
        confirmation.data.requestFingerprint !== restriction.expectedRequestFingerprint)) {
      throw unknownOutputHandoff(identity, "INVALID_CONFIRMATION");
    }
    return { emitted: true, confirmation: confirmation.data };
  }
}

/** Uses WebCrypto so this SDK mirror does not import runtime or Node-only code. */
async function createOutputHandoffIdentity(envelope: ChannelOutputEnvelope): Promise<ChannelOutputHandoffIdentity> {
  const bytes = new TextEncoder().encode(canonicalOutputJson(envelope));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const outputFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return freezeHandoffValue(ChannelOutputHandoffIdentitySchema.parse({
    outputId: envelope.outputId,
    outputFingerprint,
    binding: envelope.binding,
    target: envelope.target,
  }));
}

function unknownOutputHandoff(
  identity: ChannelOutputHandoffIdentity,
  code: "UNCLASSIFIED" | "INVALID_CONFIRMATION",
): ChannelOutputHandoffError {
  return new ChannelOutputHandoffError({
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
    identity,
    disposition: "unknown",
    operationFinished: true,
    code,
  });
}

/** Field order does not affect the full output-envelope identity. */
function canonicalOutputJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOutputJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalOutputJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Freeze only parsed clones, never the caller's mutable input. */
function freezeHandoffValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeHandoffValue(child);
    Object.freeze(value);
  }
  return value;
}

function sinkKey(channelKind: string, connectionId: string): string {
  return `${channelKind}\u0000${connectionId}`;
}

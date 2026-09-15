import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { publishSessionPrompt, type PublishSessionPromptOptions } from "../omni/session-stream.js";
import {
  dbAcceptChannelBackendIngress,
  dbClaimChannelBackendIngressPublication,
  dbGetAgent,
  dbGetChatMessage,
  dbListPendingChannelBackendIngressReceipts,
  dbMarkChannelBackendIngressPublished,
  dbReleaseChannelBackendIngressPublication,
  type ChannelBackendIngressReceiptRecord,
} from "../router/router-db.js";
import { getAgentCwd } from "../router/resolver.js";
import { attachChatToSession, getOrCreateSession, getSession, updateSessionName } from "../router/sessions.js";
import type { ChannelBackendPromptMetadata, MessageContext, MessageTarget } from "../runtime/message-types.js";
import { logger } from "../utils/logger.js";

export const CHANNEL_BACKEND_PROTOCOL = "ravi.channel.backend" as const;
export const CHANNEL_BACKEND_SCHEMA_VERSION = 1 as const;
export const CHANNEL_BACKEND_MAX_CONTENT_BLOCKS = 256;
export const CHANNEL_BACKEND_MAX_TEXT_BYTES = 1_048_576;
export const CHANNEL_BACKEND_PUBLICATION_RETRY_INTERVAL_MS = 5_000;

const log = logger.child("channels:backend");
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
  category: z.enum(["validation", "authentication", "authorization", "capacity", "availability", "internal"]),
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
    .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/, "must be a media type")
    .optional(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const ChannelContentBlockSchema = z.discriminatedUnion("type", [
  ChannelTextContentBlockSchema,
  ChannelArtifactContentBlockSchema,
]);

export const ChannelContentSchema = z.array(ChannelContentBlockSchema).min(1).max(CHANNEL_BACKEND_MAX_CONTENT_BLOCKS);

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

export const ResolvedChannelIngressRequestSchema = z
  .object({
    request: ChannelIngressRequestSchema,
    canonical: z
      .object({
        chatId: ChannelBackendOpaqueIdSchema,
        messageId: ChannelBackendOpaqueIdSchema,
      })
      .strict(),
    session: z
      .object({
        key: boundedUtf8String(512, "resolved Session key"),
        name: ChannelBackendOpaqueIdSchema,
      })
      .strict(),
    prompt: z
      .object({
        prompt: boundedUtf8String(CHANNEL_BACKEND_MAX_TEXT_BYTES, "resolved Channel prompt"),
        source: z.record(z.string(), z.unknown()),
        context: z.record(z.string(), z.unknown()),
        deliveryBarrier: z.enum(["after_tool", "after_response"]).optional(),
        deliveryBarrierSource: boundedUtf8String(64, "delivery barrier source").optional(),
      })
      .passthrough(),
  })
  .strict();

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
export type ChannelContent = z.infer<typeof ChannelContentSchema>;
export type ExternalChannelIdentity = z.infer<typeof ExternalChannelIdentitySchema>;
export type ExternalChannelTarget = z.infer<typeof ExternalChannelTargetSchema>;
export type LocalChannelMessageBinding = z.infer<typeof LocalChannelMessageBindingSchema>;
export type ChannelIngressRequest = z.infer<typeof ChannelIngressRequestSchema>;
export type ResolvedChannelIngressRequest = z.infer<typeof ResolvedChannelIngressRequestSchema>;
export type ChannelIngressResult = z.infer<typeof ChannelIngressResultSchema>;
export type ChannelOutputEnvelope = z.infer<typeof ChannelOutputEnvelopeSchema>;

export interface ChannelOutputSink {
  emit(envelope: ChannelOutputEnvelope): Promise<void>;
}

export class ChannelOutputSinkRegistry {
  private readonly sinks = new Map<string, ChannelOutputSink>();

  register(target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">, sink: ChannelOutputSink): () => void {
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

  async tryEmit(input: ChannelOutputEnvelope): Promise<boolean> {
    const envelope = ChannelOutputEnvelopeSchema.parse(input);
    const sink = this.sinks.get(sinkKey(envelope.target.channelKind, envelope.target.connectionId));
    if (!sink) return false;
    await sink.emit(envelope);
    return true;
  }
}

export const channelOutputSinks = new ChannelOutputSinkRegistry();

export type ChannelBackendPromptPublisher = (
  sessionName: string,
  payload: Record<string, unknown>,
  options?: PublishSessionPromptOptions,
) => Promise<void>;

let channelBackendPromptPublisher: ChannelBackendPromptPublisher = publishSessionPrompt;

export function setChannelBackendPromptPublisherForTests(publisher?: ChannelBackendPromptPublisher): void {
  channelBackendPromptPublisher = publisher ?? publishSessionPrompt;
}

export async function acceptChannelIngress(input: ChannelIngressRequest): Promise<ChannelIngressResult> {
  const request = ChannelIngressRequestSchema.parse(input);
  return acceptParsedChannelIngress(request);
}

export async function acceptResolvedChannelIngress(
  input: ResolvedChannelIngressRequest,
  options: {
    publishPrompt?: ChannelBackendPromptPublisher;
  } = {},
): Promise<ChannelIngressResult> {
  const resolved = ResolvedChannelIngressRequestSchema.parse(input);
  return acceptParsedChannelIngress(resolved.request, resolved, options.publishPrompt);
}

async function acceptParsedChannelIngress(
  request: ChannelIngressRequest,
  resolved?: ResolvedChannelIngressRequest,
  promptPublisher: ChannelBackendPromptPublisher = channelBackendPromptPublisher,
): Promise<ChannelIngressResult> {
  if (!dbGetAgent(request.agentId)) {
    return rejectedIngress(request, {
      code: "NOT_FOUND",
      category: "validation",
      retryable: false,
      correlationId: request.requestId,
    });
  }

  const derivedIdentity = deriveLocalIdentity(request);
  const identity =
    resolved === undefined
      ? derivedIdentity
      : {
          ...derivedIdentity,
          sessionKey: resolved.session.key,
          sessionName: resolved.session.name,
        };
  let acceptance: ReturnType<typeof dbAcceptChannelBackendIngress>;
  try {
    acceptance = dbAcceptChannelBackendIngress({
      channelInstanceId: request.channelInstanceId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: requestFingerprint(request, resolved),
      requestId: request.requestId,
      localActorId: request.localActorId,
      agentId: request.agentId,
      clientMessageId: identity.clientMessageId,
      sessionKey: identity.sessionKey,
      sessionName: identity.sessionName,
      turnId: identity.turnId,
      external: request.external,
      content: { blocks: request.content },
      receivedAt: Date.parse(request.receivedAt),
      ...(resolved === undefined
        ? {}
        : {
            canonical: resolved.canonical,
            prompt: resolved.prompt,
          }),
    });
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      return rejectedIngress(request, {
        code: "IDEMPOTENCY_CONFLICT",
        category: "validation",
        retryable: false,
        correlationId: request.requestId,
      });
    }
    log.error("Channel ingress persistence failed", {
      requestId: request.requestId,
      channelInstanceId: request.channelInstanceId,
      errorKind: errorKind(error),
    });
    return rejectedIngress(request, {
      code: "INTERNAL",
      category: "internal",
      retryable: false,
      correlationId: request.requestId,
    });
  }

  if (acceptance.status === "conflict") {
    return rejectedIngress(request, {
      code: "IDEMPOTENCY_CONFLICT",
      category: "validation",
      retryable: false,
      correlationId: request.requestId,
    });
  }

  try {
    if (resolved === undefined) {
      ensureChannelBackendSession(acceptance.receipt);
    } else {
      assertResolvedChannelBackendSession(acceptance.receipt, resolved);
    }
  } catch (error) {
    log.error("Channel ingress session binding failed", {
      requestId: request.requestId,
      receiptId: acceptance.receipt.id,
      errorKind: errorKind(error),
    });
    return rejectedIngress(request, {
      code: "INTERNAL",
      category: "internal",
      retryable: false,
      correlationId: request.requestId,
    });
  }

  let receipt = acceptance.receipt;
  try {
    receipt = (await publishAcceptedChannelIngressReceipt(receipt, promptPublisher)).receipt;
  } catch (error) {
    log.warn("Channel ingress prompt publication failed", {
      requestId: request.requestId,
      receiptId: receipt.id,
      errorKind: errorKind(error),
    });
    return rejectedIngress(request, {
      code: "UNAVAILABLE",
      category: "availability",
      retryable: true,
      correlationId: request.requestId,
    });
  }

  return ChannelIngressResultSchema.parse({
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: request.requestId,
    disposition: acceptance.status,
    binding: bindingFromReceipt(receipt),
    acceptedAt: new Date(receipt.acceptedAt).toISOString(),
  });
}

export interface ResumePendingChannelIngressPublicationsResult {
  scanned: number;
  published: number;
  busy: number;
  failed: number;
}

export async function resumePendingChannelIngressPublications(
  options: { limit?: number; now?: number; publishPrompt?: ChannelBackendPromptPublisher } = {},
): Promise<ResumePendingChannelIngressPublicationsResult> {
  const pending = dbListPendingChannelBackendIngressReceipts({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const result: ResumePendingChannelIngressPublicationsResult = {
    scanned: pending.length,
    published: 0,
    busy: 0,
    failed: 0,
  };
  const publisher = options.publishPrompt ?? channelBackendPromptPublisher;
  for (const receipt of pending) {
    try {
      assertPersistedChannelBackendSession(receipt);
      const publication = await publishAcceptedChannelIngressReceipt(receipt, publisher);
      if (publication.status === "busy") {
        result.busy += 1;
      } else {
        result.published += 1;
      }
    } catch (error) {
      result.failed += 1;
      log.warn("Pending Channel ingress publication retry failed", {
        receiptId: receipt.id,
        errorKind: errorKind(error),
      });
    }
  }
  return result;
}

type ChannelBackendPublicationRetryTimer = ReturnType<typeof setInterval>;

export function startChannelBackendPublicationReconciler(
  options: {
    intervalMs?: number;
    limit?: number;
    publishPrompt?: ChannelBackendPromptPublisher;
    setInterval?: (callback: () => void, intervalMs: number) => ChannelBackendPublicationRetryTimer;
    clearInterval?: (timer: ChannelBackendPublicationRetryTimer) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? CHANNEL_BACKEND_PUBLICATION_RETRY_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("Channel backend publication retry interval must be at least 1000 milliseconds");
  }
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelInterval = options.clearInterval ?? clearInterval;
  let retrying = false;
  const retry = () => {
    if (retrying) return;
    retrying = true;
    void resumePendingChannelIngressPublications({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.publishPrompt === undefined ? {} : { publishPrompt: options.publishPrompt }),
    })
      .catch((error) => {
        log.warn("Channel ingress publication reconciliation failed", {
          errorKind: errorKind(error),
        });
      })
      .finally(() => {
        retrying = false;
      });
  };
  retry();
  const timer = scheduleInterval(retry, intervalMs);
  timer.unref?.();
  return () => cancelInterval(timer);
}

async function publishAcceptedChannelIngressReceipt(
  receipt: ChannelBackendIngressReceiptRecord,
  promptPublisher: ChannelBackendPromptPublisher,
): Promise<{
  status: "published" | "busy";
  receipt: ChannelBackendIngressReceiptRecord;
}> {
  const claimId = randomUUID();
  const claim = dbClaimChannelBackendIngressPublication({
    receiptId: receipt.id,
    claimId,
  });
  if (claim.status === "published") {
    return { status: "published", receipt: claim.receipt };
  }
  if (claim.status === "busy") {
    return { status: "busy", receipt: claim.receipt };
  }
  try {
    await promptPublisher(claim.receipt.sessionName, promptPayloadFromReceipt(claim.receipt), {
      messageId: claim.receipt.id,
    });
    return {
      status: "published",
      receipt: dbMarkChannelBackendIngressPublished({
        receiptId: claim.receipt.id,
        claimId,
      }),
    };
  } catch (error) {
    try {
      dbReleaseChannelBackendIngressPublication({
        receiptId: claim.receipt.id,
        claimId,
      });
    } catch (releaseError) {
      log.error("Channel ingress publication claim release failed", {
        receiptId: claim.receipt.id,
        errorKind: errorKind(releaseError),
      });
    }
    throw error;
  }
}

function promptPayloadFromReceipt(receipt: ChannelBackendIngressReceiptRecord): Record<string, unknown> {
  if (receipt.prompt) {
    return {
      ...receipt.prompt,
      _channelBackend: backendPromptMetadata(receipt),
    };
  }
  const message = dbGetChatMessage(receipt.messageId);
  if (!message) {
    throw new Error(`Channel backend ingress Message is unavailable: ${receipt.messageId}`);
  }
  const content = ChannelContentSchema.parse(message.content?.blocks);
  return buildPromptPayload(receipt, content);
}

function deriveLocalIdentity(request: ChannelIngressRequest): {
  clientMessageId: string;
  sessionKey: string;
  sessionName: string;
  turnId: string;
} {
  const conversationHash = hashParts([
    request.channelInstanceId,
    request.agentId,
    request.external.connectionId,
    request.external.conversationId,
  ]);
  const messageHash = hashParts([
    request.channelInstanceId,
    request.localActorId,
    request.agentId,
    request.idempotencyKey,
  ]);
  return {
    clientMessageId: `channel_message_${messageHash}`,
    sessionKey: `agent:${request.agentId}:channel-backend:${conversationHash}`,
    sessionName: `channel-${conversationHash}`,
    turnId: `turn_${messageHash}`,
  };
}

function requestFingerprint(request: ChannelIngressRequest, resolved?: ResolvedChannelIngressRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        channelInstanceId: request.channelInstanceId,
        localActorId: request.localActorId,
        agentId: request.agentId,
        external: request.external,
        content: request.content,
        ...(resolved === undefined
          ? {}
          : {
              canonical: resolved.canonical,
              session: resolved.session,
            }),
      }),
    )
    .digest("hex");
}

function hashParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\x1f")).digest("hex").slice(0, 24);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function ensureChannelBackendSession(receipt: ChannelBackendIngressReceiptRecord): void {
  const agent = dbGetAgent(receipt.agentId);
  if (!agent) throw new Error(`Agent not found: ${receipt.agentId}`);
  const session = getOrCreateSession(receipt.sessionKey, receipt.agentId, getAgentCwd(agent), {
    name: receipt.sessionName,
    channel: receipt.external.channelKind,
    accountId: receipt.external.connectionId,
    chatType: "dm",
    lastChannel: receipt.external.channelKind,
    lastAccountId: receipt.external.connectionId,
    lastTo: receipt.external.conversationId,
  });
  if (!session.name) {
    updateSessionName(receipt.sessionKey, receipt.sessionName);
  } else if (session.name !== receipt.sessionName) {
    throw new Error(`Session ${receipt.sessionKey} already uses name ${session.name}; expected ${receipt.sessionName}`);
  }
  attachChatToSession({
    sessionKey: receipt.sessionKey,
    chatId: receipt.chatId,
    role: "primary",
    attachedByType: "system",
    attachedReason: "channel_backend",
    setOutputTarget: true,
  });
}

function assertResolvedChannelBackendSession(
  receipt: ChannelBackendIngressReceiptRecord,
  resolved: ResolvedChannelIngressRequest,
): void {
  if (
    receipt.chatId !== resolved.canonical.chatId ||
    receipt.messageId !== resolved.canonical.messageId ||
    receipt.sessionKey !== resolved.session.key ||
    receipt.sessionName !== resolved.session.name
  ) {
    throw new Error("Resolved Channel ingress binding mismatch");
  }
  const session = getSession(receipt.sessionKey);
  if (session === null || session.agentId !== receipt.agentId || session.name !== receipt.sessionName) {
    throw new Error("Resolved Channel ingress Session mismatch");
  }
}

function assertPersistedChannelBackendSession(receipt: ChannelBackendIngressReceiptRecord): void {
  const session = getSession(receipt.sessionKey);
  if (session === null || session.agentId !== receipt.agentId || session.name !== receipt.sessionName) {
    throw new Error("Persisted Channel ingress Session mismatch");
  }
}

function buildPromptPayload(
  receipt: ChannelBackendIngressReceiptRecord,
  content: ChannelContent,
): Record<string, unknown> {
  const metadata = backendPromptMetadata(receipt);
  const source: MessageTarget = {
    channel: receipt.external.channelKind,
    accountId: receipt.external.connectionId,
    instanceId: receipt.channelInstanceId,
    chatId: receipt.external.conversationId,
    canonicalChatId: receipt.chatId,
    sourceMessageId: receipt.external.messageId,
    rawSenderId: receipt.external.senderId,
    normalizedSenderId: receipt.external.senderId,
    actorType: "unknown",
  };
  const context: MessageContext = {
    channelId: receipt.external.channelKind,
    channelName: receipt.external.channelKind,
    accountId: receipt.external.connectionId,
    instanceId: receipt.channelInstanceId,
    chatId: receipt.external.conversationId,
    messageId: receipt.external.messageId,
    senderId: receipt.external.senderId,
    senderName: receipt.external.senderId,
    isGroup: false,
    timestamp: receipt.acceptedAt,
    canonicalChatId: receipt.chatId,
    rawSenderId: receipt.external.senderId,
    normalizedSenderId: receipt.external.senderId,
    actorType: "unknown",
  };
  return {
    prompt: formatPrompt(content),
    source,
    context,
    deliveryBarrier: "after_tool",
    deliveryBarrierSource: "default",
    _agentId: receipt.agentId,
    _channelBackend: metadata,
  };
}

function backendPromptMetadata(receipt: ChannelBackendIngressReceiptRecord): ChannelBackendPromptMetadata {
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    ingressRequestId: receipt.initialRequestId,
    correlationId: receipt.initialRequestId,
    binding: bindingFromReceipt(receipt),
    target: {
      channelKind: receipt.external.channelKind,
      connectionId: receipt.external.connectionId,
      conversationId: receipt.external.conversationId,
    },
  };
}

function bindingFromReceipt(receipt: ChannelBackendIngressReceiptRecord): LocalChannelMessageBinding {
  return {
    channelInstanceId: receipt.channelInstanceId,
    agentId: receipt.agentId,
    chatId: receipt.chatId,
    messageId: receipt.messageId,
    sessionId: receipt.sessionName,
    turnId: receipt.turnId,
  };
}

function formatPrompt(content: ChannelContent): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      const details = [
        block.name,
        block.mediaType,
        block.sizeBytes === undefined ? undefined : `${block.sizeBytes} bytes`,
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(", ");
      return details ? `[Artifact ${block.artifactId}: ${details}]` : `[Artifact ${block.artifactId}]`;
    })
    .join("\n");
}

function rejectedIngress(request: ChannelIngressRequest, error: ChannelSafeError): ChannelIngressResult {
  return ChannelIngressResultSchema.parse({
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: request.requestId,
    disposition: "rejected",
    error,
    acceptedAt: new Date().toISOString(),
  });
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Error && /already used with different|idempotency/i.test(error.message);
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sinkKey(channelKind: string, connectionId: string): string {
  return `${channelKind}\u0000${connectionId}`;
}

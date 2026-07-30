import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { nats } from "../nats.js";
import {
  dbClaimChannelBackendRuntimeInterrupt,
  dbGetChatMessage,
  dbGetChannelBackendIngressReceiptByTurnId,
  dbGetChannelBackendRuntimeInterrupt,
  dbGetChannelBackendRuntimeState,
  dbMarkChannelBackendRuntimeInterruptPublished,
  dbRecordChannelBackendRuntimeEvent,
  dbRecordChannelBackendRuntimeInterrupt,
  dbReleaseChannelBackendRuntimeInterrupt,
  type ChannelBackendIngressReceiptRecord,
  type ChannelBackendRuntimeState,
  type ChannelBackendRuntimeStateRecord,
} from "../router/router-db.js";
import type { ChannelBackendPromptMetadata } from "../runtime/message-types.js";
import type { RuntimeEvent } from "../runtime/types.js";
import type { ChannelBackendEgressRequester } from "./backend-egress.js";
import {
  CHANNEL_BACKEND_MAX_CONTENT_BLOCKS,
  CHANNEL_BACKEND_MAX_TEXT_BYTES,
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  ChannelContentSchema,
  ChannelOutputEnvelopeSchema,
  ChannelSafeErrorSchema,
  ExternalChannelTargetSchema,
  LocalChannelMessageBindingSchema,
  channelOutputSinks,
  type ChannelContent,
  type ChannelSafeError,
  type ExternalChannelTarget,
  type LocalChannelMessageBinding,
} from "./backend.js";

export const CHANNEL_RUNTIME_EVENTS_PROTOCOL = "ravi.channel.runtime-events" as const;
export const CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION = 1 as const;
export const MAX_CHANNEL_TOOL_PRESENTATION_TITLE_BYTES = 256;
export const MAX_CHANNEL_TOOL_PRESENTATION_SUMMARY_BYTES = 1_024;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_NAME_BYTES = 96;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_LABEL_BYTES = 256;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_VALUE_BYTES = 512;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETERS = 8;

const textEncoder = new TextEncoder();
let channelRuntimeGenerationId = newRuntimeGenerationId();

function boundedUtf8String(maxBytes: number, label: string, minBytes = 1) {
  return z
    .string()
    .refine((value) => textEncoder.encode(value).byteLength >= minBytes, `${label} must not be empty`)
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, `${label} exceeds ${maxBytes} UTF-8 bytes`);
}

export const ChannelRuntimeCorrelationSchema = z.object({
  correlationId: ChannelBackendOpaqueIdSchema,
  causationId: ChannelBackendOpaqueIdSchema.optional(),
  ingressRequestId: ChannelBackendOpaqueIdSchema,
  binding: LocalChannelMessageBindingSchema,
});

export const ChannelTurnStateSchema = z.enum([
  "accepted",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
]);

export const ChannelTurnStateChangedPayloadSchema = z
  .object({
    state: ChannelTurnStateSchema,
    error: ChannelSafeErrorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.state === "failed" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "failed turn state requires a safe error",
      });
    }
    if (value.state !== "failed" && value.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "only failed turn state may carry a safe error",
      });
    }
  });

export const ChannelAssistantDeltaPayloadSchema = z.object({
  blockIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deltaSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: boundedUtf8String(CHANNEL_BACKEND_MAX_TEXT_BYTES, "assistant delta"),
  phase: z.enum(["commentary", "final_answer", "unknown"]).optional(),
});

export const ChannelAssistantMessagePayloadSchema = z.object({
  phase: z.enum(["commentary", "final_answer", "unknown"]),
  content: ChannelContentSchema,
});

export const ChannelTerminalOutputPayloadSchema = z
  .object({
    state: z.enum(["completed", "failed", "interrupted"]),
    assistantMessageId: ChannelBackendOpaqueIdSchema.optional(),
    content: ChannelContentSchema.optional(),
    error: ChannelSafeErrorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.state === "completed" &&
      (value.assistantMessageId === undefined || value.content === undefined || value.error !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "completed terminal output requires message, content, and no error",
      });
    }
    if (value.state === "failed" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "failed terminal output requires a safe error",
      });
    }
  });

export const ChannelToolPresentationParameterSchema = z
  .object({
    name: boundedUtf8String(
      MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_NAME_BYTES,
      "tool presentation parameter name",
    ).regex(/^[A-Za-z][A-Za-z0-9._-]*$/, "tool presentation parameter name must be portable"),
    label: boundedUtf8String(
      MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_LABEL_BYTES,
      "tool presentation parameter label",
    ).optional(),
    value: boundedUtf8String(
      MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_VALUE_BYTES,
      "tool presentation parameter value",
    ).optional(),
    redacted: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.value === undefined && value.redacted !== true) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "tool presentation parameter requires a value or explicit redaction",
      });
    }
    if (value.value !== undefined && value.redacted === true) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "tool presentation parameter cannot contain a value when redacted",
      });
    }
  });

export const ChannelToolPresentationSchema = z.object({
  title: boundedUtf8String(MAX_CHANNEL_TOOL_PRESENTATION_TITLE_BYTES, "tool presentation title"),
  summary: boundedUtf8String(MAX_CHANNEL_TOOL_PRESENTATION_SUMMARY_BYTES, "tool presentation summary").optional(),
  category: ChannelBackendWireKindSchema.optional(),
  operation: z.enum(["read", "mutate", "execute", "ask"]).optional(),
  risk: z.enum(["low", "medium", "high", "destructive"]).optional(),
  parameters: z.array(ChannelToolPresentationParameterSchema).max(MAX_CHANNEL_TOOL_PRESENTATION_PARAMETERS).optional(),
});

export const ChannelToolSummaryPayloadSchema = z.object({
  toolCallId: ChannelBackendOpaqueIdSchema,
  toolName: ChannelBackendWireKindSchema,
  phase: z.enum(["requested", "running", "completed", "failed", "denied"]),
  presentation: ChannelToolPresentationSchema.optional(),
  durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  error: ChannelSafeErrorSchema.optional(),
});

export const ChannelApprovalRequestedPayloadSchema = z.object({
  approvalId: ChannelBackendOpaqueIdSchema,
  action: ChannelBackendWireKindSchema,
  risk: z.enum(["low", "medium", "high"]).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export const ChannelApprovalResolvedPayloadSchema = z.object({
  approvalId: ChannelBackendOpaqueIdSchema,
  decision: z.enum(["approved", "denied", "cancelled", "expired"]),
});

const ChannelRuntimeEventBaseSchema = z.object({
  protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
  schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
  eventId: ChannelBackendOpaqueIdSchema,
  kind: ChannelBackendWireKindSchema,
  occurredAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  correlation: ChannelRuntimeCorrelationSchema,
  payload: z.unknown(),
});

function defineChannelRuntimeEvent<const Kind extends string, Payload extends z.ZodType>(kind: Kind, payload: Payload) {
  ChannelBackendWireKindSchema.parse(kind);
  return ChannelRuntimeEventBaseSchema.extend({
    kind: z.literal(kind),
    payload,
  });
}

export const ChannelTurnStateChangedEventSchema = defineChannelRuntimeEvent(
  "turn.state_changed",
  ChannelTurnStateChangedPayloadSchema,
);
export const ChannelAssistantDeltaEventSchema = defineChannelRuntimeEvent(
  "turn.assistant_delta",
  ChannelAssistantDeltaPayloadSchema,
);
export const ChannelAssistantMessageEventSchema = defineChannelRuntimeEvent(
  "turn.assistant_message",
  ChannelAssistantMessagePayloadSchema,
);
export const ChannelTerminalOutputEventSchema = defineChannelRuntimeEvent(
  "turn.terminal_output",
  ChannelTerminalOutputPayloadSchema,
);
export const ChannelToolSummaryEventSchema = defineChannelRuntimeEvent(
  "turn.tool_summary",
  ChannelToolSummaryPayloadSchema,
);
export const ChannelApprovalRequestedEventSchema = defineChannelRuntimeEvent(
  "turn.approval_requested",
  ChannelApprovalRequestedPayloadSchema,
);
export const ChannelApprovalResolvedEventSchema = defineChannelRuntimeEvent(
  "turn.approval_resolved",
  ChannelApprovalResolvedPayloadSchema,
);

export const KnownChannelRuntimeEventSchema = z.union([
  ChannelTurnStateChangedEventSchema,
  ChannelAssistantDeltaEventSchema,
  ChannelAssistantMessageEventSchema,
  ChannelTerminalOutputEventSchema,
  ChannelToolSummaryEventSchema,
  ChannelApprovalRequestedEventSchema,
  ChannelApprovalResolvedEventSchema,
]);

export const ChannelInterruptRequestSchema = z.object({
  protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
  schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
  requestId: ChannelBackendOpaqueIdSchema,
  idempotencyKey: ChannelBackendOpaqueIdSchema,
  binding: LocalChannelMessageBindingSchema,
  requestedAt: z.string().datetime({ offset: true }),
});

export const ChannelInterruptResultSchema = z
  .object({
    protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    disposition: z.enum(["requested", "duplicate", "rejected"]),
    error: ChannelSafeErrorSchema.optional(),
    acceptedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if ((value.disposition === "rejected") !== (value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "only rejected interrupt results carry a safe error",
      });
    }
  });

export const ChannelRuntimeReadbackRequestSchema = z.object({
  protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
  schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
  requestId: ChannelBackendOpaqueIdSchema,
  binding: LocalChannelMessageBindingSchema,
});

export const ChannelRuntimeReadbackResultSchema = z
  .object({
    protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    binding: LocalChannelMessageBindingSchema,
    state: ChannelTurnStateSchema,
    lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    assistantMessageId: ChannelBackendOpaqueIdSchema.optional(),
    runtimeGenerationId: ChannelBackendOpaqueIdSchema.optional(),
    lastEventRuntimeGenerationId: ChannelBackendOpaqueIdSchema.optional(),
    terminalEvent: ChannelTerminalOutputEventSchema.optional(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (!value.terminalEvent) return;
    if (
      value.terminalEvent.payload.state !== value.state ||
      value.terminalEvent.sequence !== value.lastSequence ||
      value.terminalEvent.correlation.binding.turnId !== value.binding.turnId
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalEvent"],
        message: "terminal readback event must match the readback state, sequence, and binding",
      });
    }
  });

export type ChannelRuntimeCorrelation = z.infer<typeof ChannelRuntimeCorrelationSchema>;
export type KnownChannelRuntimeEvent = z.infer<typeof KnownChannelRuntimeEventSchema>;
export type ChannelToolPresentationParameter = z.infer<typeof ChannelToolPresentationParameterSchema>;
export type ChannelToolPresentation = z.infer<typeof ChannelToolPresentationSchema>;
export type ChannelInterruptRequest = z.infer<typeof ChannelInterruptRequestSchema>;
export type ChannelInterruptResult = z.infer<typeof ChannelInterruptResultSchema>;
export type ChannelRuntimeReadbackRequest = z.infer<typeof ChannelRuntimeReadbackRequestSchema>;
export type ChannelRuntimeReadbackResult = z.infer<typeof ChannelRuntimeReadbackResultSchema>;

export interface ChannelRuntimeEventSink {
  emit(event: KnownChannelRuntimeEvent, target: ExternalChannelTarget): Promise<void>;
}

export class ChannelRuntimeEventSinkRegistry {
  private readonly sinks = new Map<string, ChannelRuntimeEventSink>();

  register(
    target: Pick<ExternalChannelTarget, "channelKind" | "connectionId">,
    sink: ChannelRuntimeEventSink,
  ): () => void {
    const channelKind = ChannelBackendWireKindSchema.parse(target.channelKind);
    const connectionId = ChannelBackendOpaqueIdSchema.parse(target.connectionId);
    const key = sinkKey(channelKind, connectionId);
    if (this.sinks.has(key)) {
      throw new Error(`Channel runtime event sink is already registered for ${channelKind}/${connectionId}`);
    }
    this.sinks.set(key, sink);
    return () => {
      if (this.sinks.get(key) === sink) this.sinks.delete(key);
    };
  }

  async emit(target: ExternalChannelTarget, input: KnownChannelRuntimeEvent): Promise<void> {
    const parsedTarget = ExternalChannelTargetSchema.parse(target);
    const event = KnownChannelRuntimeEventSchema.parse(input);
    const sink = this.sinks.get(sinkKey(parsedTarget.channelKind, parsedTarget.connectionId));
    if (!sink) {
      throw new Error(
        `Channel runtime event sink is unavailable for ${parsedTarget.channelKind}/${parsedTarget.connectionId}`,
      );
    }
    await sink.emit(event, parsedTarget);
  }

  async tryEmit(target: ExternalChannelTarget, input: KnownChannelRuntimeEvent): Promise<boolean> {
    const parsedTarget = ExternalChannelTargetSchema.parse(target);
    const event = KnownChannelRuntimeEventSchema.parse(input);
    const sink = this.sinks.get(sinkKey(parsedTarget.channelKind, parsedTarget.connectionId));
    if (!sink) return false;
    await sink.emit(event, parsedTarget);
    return true;
  }
}

export const channelRuntimeEventSinks = new ChannelRuntimeEventSinkRegistry();
let channelBackendEgressRequester: ChannelBackendEgressRequester | undefined;

export function setChannelBackendEgressRequesterForRuntime(requester?: ChannelBackendEgressRequester): void {
  channelBackendEgressRequester = requester;
}

export type ChannelRuntimeAbortPublisher = (
  topic: "ravi.session.abort",
  payload: Record<string, unknown>,
) => Promise<void>;

let channelRuntimeAbortPublisher: ChannelRuntimeAbortPublisher = async (topic, payload) => {
  await nats.emit(topic, payload);
};

export function setChannelRuntimeAbortPublisherForTests(publisher?: ChannelRuntimeAbortPublisher): void {
  channelRuntimeAbortPublisher =
    publisher ??
    (async (topic, payload) => {
      await nats.emit(topic, payload);
    });
}

export function setChannelRuntimeGenerationIdForTests(generationId?: string): void {
  channelRuntimeGenerationId = generationId
    ? ChannelBackendOpaqueIdSchema.parse(generationId)
    : newRuntimeGenerationId();
}

export async function projectChannelRuntimeEvent(input: {
  metadata: ChannelBackendPromptMetadata;
  event: RuntimeEvent;
  responseText?: string;
  toolPresentation?: ChannelToolPresentation;
  toolDurationMs?: number;
  occurredAt?: number;
  sinks?: ChannelRuntimeEventSinkRegistry;
}): Promise<KnownChannelRuntimeEvent[]> {
  const metadata = parseChannelBackendMetadata(input.metadata);
  const occurredAt = input.occurredAt ?? Date.now();
  const sinks = input.sinks ?? channelRuntimeEventSinks;
  const projected: KnownChannelRuntimeEvent[] = [];
  let dispatchError: unknown;
  const append = async (eventInput: RecordAndEmitInput) => {
    const recorded = await recordAndEmit(eventInput);
    projected.push(recorded.event);
    dispatchError ??= recorded.dispatchError;
  };
  const current = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
  if (!current || current.state === "accepted") {
    await append({
      metadata,
      kind: "turn.state_changed",
      state: "running",
      payload: { state: "running" },
      occurredAt,
      sinks,
    });
  }

  const event = input.event;
  if (event.type === "text.delta" && event.text) {
    const phase = channelAssistantPhase(event.metadata);
    const chunks = splitChannelText(event.text);
    for (const text of chunks) {
      await append({
        metadata,
        kind: "turn.assistant_delta",
        assistantDelta: true,
        payload: (_sequence: number, _assistantMessageId: string | undefined, deltaSequence: number) => ({
          blockIndex: 0,
          deltaSequence,
          text,
          phase,
        }),
        occurredAt,
        sinks,
      });
    }
  } else if (event.type === "assistant.message" && event.text.trim()) {
    await append({
      metadata,
      kind: "turn.assistant_message",
      payload: {
        phase: channelAssistantPhase(event.metadata),
        content: channelTextContent(event.text.trim()),
      },
      occurredAt,
      sinks,
    });
  } else if (event.type === "tool.started") {
    const toolName = normalizeWireKind(event.toolUse.name, "tool");
    await append({
      metadata,
      kind: "turn.tool_summary",
      payload: {
        toolCallId: opaqueOrDerived(event.toolUse.id, "tool", metadata.binding.turnId, event.toolUse.name),
        toolName,
        phase: "running",
        presentation: input.toolPresentation ?? { title: toolName },
      },
      occurredAt,
      sinks,
    });
  } else if (event.type === "tool.completed") {
    const toolName = normalizeWireKind(event.toolName ?? "tool", "tool");
    await append({
      metadata,
      kind: "turn.tool_summary",
      payload: {
        toolCallId: opaqueOrDerived(event.toolUseId, "tool", metadata.binding.turnId, toolName),
        toolName,
        phase: event.isError ? "failed" : "completed",
        presentation: input.toolPresentation ?? { title: toolName },
        ...(input.toolDurationMs === undefined ? {} : { durationMs: input.toolDurationMs }),
        ...(event.isError ? { error: safeRuntimeError(metadata.correlationId, false) } : {}),
      },
      occurredAt,
      sinks,
    });
  } else if (event.type === "approval.requested") {
    const action = normalizeWireKind(
      event.approval.toolName ?? event.approval.method ?? event.approval.kind,
      "approval",
    );
    await append({
      metadata,
      kind: "turn.approval_requested",
      state: "waiting_approval",
      payload: {
        approvalId: semanticEventId("approval", metadata.binding.turnId, action),
        action,
      },
      occurredAt,
      sinks,
    });
  } else if (event.type === "approval.resolved") {
    const action = normalizeWireKind(
      event.approval.toolName ?? event.approval.method ?? event.approval.kind,
      "approval",
    );
    await append({
      metadata,
      kind: "turn.approval_resolved",
      state: "running",
      payload: {
        approvalId: semanticEventId("approval", metadata.binding.turnId, action),
        decision:
          event.approval.approved === true ? "approved" : event.approval.approved === false ? "denied" : "cancelled",
      },
      occurredAt,
      sinks,
    });
  } else if (event.type === "turn.complete") {
    const responseText = input.responseText?.trim();
    if (responseText) {
      const content = channelTextContent(responseText);
      await append({
        metadata,
        kind: "turn.terminal_output",
        state: "completed",
        assistantText: responseText,
        payload: (_sequence: number, assistantMessageId?: string) => ({
          state: "completed",
          assistantMessageId,
          content,
        }),
        assistantContent: content,
        occurredAt,
        sinks,
      });
    } else {
      await append({
        metadata,
        kind: "turn.state_changed",
        state: "completed",
        payload: { state: "completed" },
        occurredAt,
        sinks,
      });
    }
  } else if (event.type === "turn.interrupted") {
    await append({
      metadata,
      kind: "turn.terminal_output",
      state: "interrupted",
      payload: { state: "interrupted" },
      occurredAt,
      sinks,
    });
  } else if (event.type === "turn.failed") {
    const error = safeRuntimeError(metadata.correlationId, event.recoverable ?? false);
    await append({
      metadata,
      kind: "turn.terminal_output",
      state: "failed",
      safeError: error,
      payload: { state: "failed", error },
      occurredAt,
      sinks,
    });
  }
  if (dispatchError) throw dispatchError;
  return projected;
}

export async function requestChannelRuntimeInterrupt(input: ChannelInterruptRequest): Promise<ChannelInterruptResult> {
  const request = ChannelInterruptRequestSchema.parse(input);
  const receipt = receiptForBinding(request.binding);
  if (!receipt) {
    return rejectedInterrupt(request.requestId, "NOT_FOUND", "validation");
  }
  const prior = dbGetChannelBackendRuntimeInterrupt(receipt.turnId, request.idempotencyKey);
  if (prior?.state === "published" || prior?.state === "publishing") {
    return ChannelInterruptResultSchema.parse({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: "duplicate",
      acceptedAt: new Date(prior.requestedAt).toISOString(),
    });
  }
  const runtime = dbGetChannelBackendRuntimeState(receipt.turnId);
  if (runtime && isTerminalState(runtime.state)) {
    return rejectedInterrupt(request.requestId, "INVALID_REQUEST", "validation");
  }
  const recorded = dbRecordChannelBackendRuntimeInterrupt({
    turnId: receipt.turnId,
    idempotencyKey: request.idempotencyKey,
    requestId: request.requestId,
    requestedAt: Date.parse(request.requestedAt),
  });
  const claimId = randomUUID();
  const claim = dbClaimChannelBackendRuntimeInterrupt({
    turnId: receipt.turnId,
    idempotencyKey: request.idempotencyKey,
    claimId,
  });
  if (claim.status !== "acquired") {
    return ChannelInterruptResultSchema.parse({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: "duplicate",
      acceptedAt: new Date(claim.record.requestedAt).toISOString(),
    });
  }
  try {
    await channelRuntimeAbortPublisher("ravi.session.abort", {
      sessionKey: receipt.sessionKey,
      sessionName: receipt.sessionName,
      source: "channel_backend",
      action: "channels.backend.runtime.interrupt",
      reason: "channel_runtime_interrupt",
      correlationId: request.requestId,
    });
    const published = dbMarkChannelBackendRuntimeInterruptPublished({
      turnId: receipt.turnId,
      idempotencyKey: request.idempotencyKey,
      claimId,
    });
    return ChannelInterruptResultSchema.parse({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: recorded.created ? "requested" : "duplicate",
      acceptedAt: new Date(published.requestedAt).toISOString(),
    });
  } catch {
    try {
      dbReleaseChannelBackendRuntimeInterrupt({
        turnId: receipt.turnId,
        idempotencyKey: request.idempotencyKey,
        claimId,
      });
    } catch {
      // The safe result below intentionally carries no persistence or transport details.
    }
    return rejectedInterrupt(request.requestId, "UNAVAILABLE", "availability", true);
  }
}

export function readChannelRuntime(input: ChannelRuntimeReadbackRequest): ChannelRuntimeReadbackResult {
  const request = ChannelRuntimeReadbackRequestSchema.parse(input);
  const receipt = receiptForBinding(request.binding);
  if (!receipt) {
    throw new Error("Channel runtime binding was not found");
  }
  const runtime = dbGetChannelBackendRuntimeState(receipt.turnId);
  const terminalEvent = runtime ? terminalEventFromReadback(request.binding, receipt, runtime) : undefined;
  return ChannelRuntimeReadbackResultSchema.parse({
    protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
    schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
    requestId: request.requestId,
    binding: request.binding,
    state: runtime?.state ?? "accepted",
    lastSequence: runtime?.lastSequence ?? 0,
    ...(runtime?.assistantMessageId ? { assistantMessageId: runtime.assistantMessageId } : {}),
    runtimeGenerationId: channelRuntimeGenerationId,
    ...(runtime?.runtimeGenerationId ? { lastEventRuntimeGenerationId: runtime.runtimeGenerationId } : {}),
    ...(terminalEvent ? { terminalEvent } : {}),
    observedAt: new Date().toISOString(),
  });
}

type EventPayloadFactory = (sequence: number, assistantMessageId: string | undefined, deltaSequence: number) => unknown;

interface RecordAndEmitInput {
  metadata: ChannelBackendPromptMetadata;
  kind: KnownChannelRuntimeEvent["kind"];
  state?: ChannelBackendRuntimeState;
  assistantDelta?: boolean;
  assistantText?: string;
  assistantContent?: ChannelContent;
  safeError?: ChannelSafeError;
  payload: unknown | EventPayloadFactory;
  occurredAt: number;
  sinks: ChannelRuntimeEventSinkRegistry;
}

async function recordAndEmit(
  input: RecordAndEmitInput,
): Promise<{ event: KnownChannelRuntimeEvent; dispatchError?: unknown }> {
  const persisted = dbRecordChannelBackendRuntimeEvent({
    turnId: input.metadata.binding.turnId,
    state: input.state,
    assistantDelta: input.assistantDelta,
    assistantText: input.assistantText,
    runtimeGenerationId: channelRuntimeGenerationId,
    terminalError: input.safeError,
    occurredAt: input.occurredAt,
  });
  const payload =
    typeof input.payload === "function"
      ? input.payload(
          persisted.runtime.lastSequence,
          persisted.runtime.assistantMessageId,
          persisted.runtime.lastDeltaSequence,
        )
      : input.payload;
  const event = KnownChannelRuntimeEventSchema.parse({
    protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
    schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
    eventId: semanticEventId(input.kind, input.metadata.binding.turnId, String(persisted.runtime.lastSequence)),
    kind: input.kind,
    occurredAt: new Date(input.occurredAt).toISOString(),
    sequence: persisted.runtime.lastSequence,
    correlation: {
      correlationId: input.metadata.correlationId,
      causationId: input.metadata.ingressRequestId,
      ingressRequestId: input.metadata.ingressRequestId,
      binding: input.metadata.binding,
    },
    payload,
  });
  let dispatchError: unknown;
  try {
    const deliveredLocally = await input.sinks.tryEmit(input.metadata.target, event);
    if (!deliveredLocally) {
      if (!channelBackendEgressRequester) {
        throw new Error(
          `Channel runtime event sink is unavailable for ${input.metadata.target.channelKind}/${input.metadata.target.connectionId}`,
        );
      }
      await channelBackendEgressRequester.emitRuntimeEvent(input.metadata.target, event);
    }
  } catch (error) {
    dispatchError = error;
  }

  if (
    input.kind === "turn.terminal_output" &&
    ((input.state === "completed" && input.assistantText) || (input.state === "failed" && input.safeError))
  ) {
    try {
      const output = ChannelOutputEnvelopeSchema.parse({
        protocol: CHANNEL_BACKEND_PROTOCOL,
        schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
        outputId: semanticEventId("output", input.metadata.binding.turnId, "terminal"),
        correlationId: input.metadata.correlationId,
        causationId: input.metadata.ingressRequestId,
        binding: input.metadata.binding,
        target: input.metadata.target,
        ...(input.state === "completed" && input.assistantText
          ? {
              kind: "assistant_message",
              content: input.assistantContent ?? channelTextContent(input.assistantText),
            }
          : {
              kind: "safe_error",
              error: input.safeError,
            }),
        emittedAt: new Date(input.occurredAt).toISOString(),
      });
      const deliveredLocally = await channelOutputSinks.tryEmit(output);
      if (!deliveredLocally) {
        if (!channelBackendEgressRequester) {
          throw new Error(
            `Channel output sink is unavailable for ${output.target.channelKind}/${output.target.connectionId}`,
          );
        }
        await channelBackendEgressRequester.emitOutput(output);
      }
    } catch (error) {
      dispatchError ??= error;
    }
  }
  return {
    event,
    ...(dispatchError !== undefined ? { dispatchError } : {}),
  };
}

function parseChannelBackendMetadata(input: ChannelBackendPromptMetadata): ChannelBackendPromptMetadata {
  if (input.protocol !== CHANNEL_BACKEND_PROTOCOL || input.schemaVersion !== CHANNEL_BACKEND_SCHEMA_VERSION) {
    throw new Error("Unsupported channel backend metadata profile");
  }
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    ingressRequestId: ChannelBackendOpaqueIdSchema.parse(input.ingressRequestId),
    correlationId: ChannelBackendOpaqueIdSchema.parse(input.correlationId),
    binding: LocalChannelMessageBindingSchema.parse(input.binding),
    target: {
      channelKind: ChannelBackendWireKindSchema.parse(input.target.channelKind),
      connectionId: ChannelBackendOpaqueIdSchema.parse(input.target.connectionId),
      conversationId: ChannelBackendOpaqueIdSchema.parse(input.target.conversationId),
    },
  };
}

function receiptForBinding(binding: LocalChannelMessageBinding): ChannelBackendIngressReceiptRecord | null {
  const parsed = LocalChannelMessageBindingSchema.parse(binding);
  const receipt = dbGetChannelBackendIngressReceiptByTurnId(parsed.turnId);
  if (
    !receipt ||
    receipt.channelInstanceId !== parsed.channelInstanceId ||
    receipt.agentId !== parsed.agentId ||
    receipt.chatId !== parsed.chatId ||
    receipt.messageId !== parsed.messageId ||
    receipt.sessionName !== parsed.sessionId
  ) {
    return null;
  }
  return receipt;
}

function rejectedInterrupt(
  requestId: string,
  code: ChannelSafeError["code"],
  category: ChannelSafeError["category"],
  retryable = false,
): ChannelInterruptResult {
  return ChannelInterruptResultSchema.parse({
    protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
    schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
    requestId,
    disposition: "rejected",
    error: {
      code,
      category,
      retryable,
      correlationId: requestId,
    },
    acceptedAt: new Date().toISOString(),
  });
}

function safeRuntimeError(correlationId: string, retryable: boolean): ChannelSafeError {
  return ChannelSafeErrorSchema.parse({
    code: "INTERNAL",
    category: "internal",
    retryable,
    correlationId,
  });
}

function channelAssistantPhase(metadata: RuntimeEvent["metadata"]): "commentary" | "final_answer" | "unknown" {
  const phase = metadata?.item?.phase;
  return phase === "commentary" || phase === "final_answer" ? phase : "unknown";
}

function isTerminalState(state: ChannelBackendRuntimeState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function normalizeWireKind(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[._-]{2,}/g, ".")
    .replace(/[._-]+$/, "")
    .slice(0, 96);
  return ChannelBackendWireKindSchema.safeParse(normalized).success ? normalized : fallback;
}

function opaqueOrDerived(value: string | undefined, namespace: string, ...parts: string[]): string {
  const parsed = ChannelBackendOpaqueIdSchema.safeParse(value);
  return parsed.success ? parsed.data : semanticEventId(namespace, ...parts);
}

function channelTextContent(text: string): ChannelContent {
  return ChannelContentSchema.parse(splitChannelText(text).map((chunk) => ({ type: "text" as const, text: chunk })));
}

function splitChannelText(text: string): string[] {
  if (textEncoder.encode(text).byteLength <= CHANNEL_BACKEND_MAX_TEXT_BYTES) {
    return [text];
  }
  const chunks: string[] = [];
  let currentParts: string[] = [];
  let currentBytes = 0;
  for (const symbol of text) {
    const symbolBytes = textEncoder.encode(symbol).byteLength;
    if (currentBytes > 0 && currentBytes + symbolBytes > CHANNEL_BACKEND_MAX_TEXT_BYTES) {
      chunks.push(currentParts.join(""));
      if (chunks.length >= CHANNEL_BACKEND_MAX_CONTENT_BLOCKS) {
        throw new Error("Channel runtime text exceeds the absolute content limit");
      }
      currentParts = [];
      currentBytes = 0;
    }
    currentParts.push(symbol);
    currentBytes += symbolBytes;
  }
  if (currentParts.length > 0) {
    chunks.push(currentParts.join(""));
  }
  return chunks;
}

function semanticEventId(namespace: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update([namespace, ...parts].join("\u001f"))
    .digest("hex")
    .slice(0, 32);
  return `${normalizeWireKind(namespace, "event").replace(/[.]/g, "_")}_${digest}`;
}

function sinkKey(channelKind: string, connectionId: string): string {
  return `${channelKind}\u0000${connectionId}`;
}

function newRuntimeGenerationId(): string {
  return `runtime_${randomUUID().replace(/-/g, "")}`;
}

function terminalEventFromReadback(
  binding: LocalChannelMessageBinding,
  receipt: ChannelBackendIngressReceiptRecord,
  runtime: ChannelBackendRuntimeStateRecord,
): z.infer<typeof ChannelTerminalOutputEventSchema> | undefined {
  if (!isTerminalState(runtime.state)) return undefined;

  let payload: z.infer<typeof ChannelTerminalOutputPayloadSchema>;
  if (runtime.state === "completed") {
    if (!runtime.assistantMessageId) return undefined;
    const message = dbGetChatMessage(runtime.assistantMessageId);
    const parsedContent = ChannelContentSchema.safeParse(message?.content?.blocks);
    if (!parsedContent.success) return undefined;
    payload = {
      state: "completed",
      assistantMessageId: runtime.assistantMessageId,
      content: parsedContent.data,
    };
  } else if (runtime.state === "failed") {
    const parsedError = ChannelSafeErrorSchema.safeParse(runtime.terminalError);
    if (!parsedError.success) return undefined;
    payload = {
      state: "failed",
      error: parsedError.data,
    };
  } else {
    payload = { state: "interrupted" };
  }

  return ChannelTerminalOutputEventSchema.parse({
    protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
    schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
    eventId: semanticEventId("turn.terminal_output", binding.turnId, String(runtime.lastSequence)),
    kind: "turn.terminal_output",
    occurredAt: new Date(runtime.updatedAt).toISOString(),
    sequence: runtime.lastSequence,
    correlation: {
      correlationId: receipt.initialRequestId,
      causationId: receipt.initialRequestId,
      ingressRequestId: receipt.initialRequestId,
      binding,
    },
    payload,
  });
}

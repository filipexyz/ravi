import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { nats } from "../nats.js";
import type { SlackAutomaticTerminalManifest } from "./slack/automatic-terminal-manifest.js";
import { discardSlackAutomaticPendingReply } from "./slack/automatic-pending-reply.js";
import {
  recordTerminalProjectionWithRecovery,
  type TerminalProjectionRecoveryOptions,
} from "./terminal-projection-recovery.js";
import { handoffTerminalOutputWithRecovery, type TerminalOutputHandoffState } from "./terminal-output-handoff.js";
import type { ChannelOutputEmissionContext } from "./output-handoff.js";

import {
  ChannelBackendRuntimeOwnershipLostError,
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
import { classifyRuntimeCredentialFailure } from "../runtime/credential-classifier.js";
import { generatedMediaAllocations, type GeneratedMediaCleanupResult } from "../runtime/generated-media-allocation.js";
import type { ChannelBackendPromptMetadata } from "../runtime/message-types.js";
import {
  PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
  PROVIDER_CAPACITY_UNSAFE_MESSAGE,
} from "../runtime/provider-capacity-retry.js";
import { isRuntimeCredentialResolutionFailure } from "../runtime/public-failure.js";
import type { RuntimeEvent } from "../runtime/types.js";
import { logger } from "../utils/logger.js";
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
  type ChannelOutputEnvelope,
  type ChannelSafeError,
  type ExternalChannelTarget,
  type LocalChannelMessageBinding,
} from "./backend.js";

/** Host-only recovery hooks; never serialized or accepted from a channel request. */
export interface ChannelTerminalRecoveryOptions extends Omit<TerminalProjectionRecoveryOptions, "onCommitted"> {
  onOutputState?: (state: TerminalOutputHandoffState) => void;
}

export const CHANNEL_RUNTIME_EVENTS_PROTOCOL = "ravi.channel.runtime-events" as const;
export const CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION = 1 as const;
export const MAX_CHANNEL_TOOL_PRESENTATION_TITLE_BYTES = 256;
export const MAX_CHANNEL_TOOL_PRESENTATION_SUMMARY_BYTES = 1_024;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_NAME_BYTES = 96;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_LABEL_BYTES = 256;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETER_VALUE_BYTES = 512;
export const MAX_CHANNEL_TOOL_PRESENTATION_PARAMETERS = 8;

const textEncoder = new TextEncoder();
const log = logger.child("channels:runtime-events");
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
  emit(event: KnownChannelRuntimeEvent, target?: ExternalChannelTarget): Promise<void>;
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

/**
 * Projects provider events onto the accepted channel binding, rechecking the
 * optional owner fence after awaits and within each synchronous DB attempt.
 * Terminal preparation has no persistence effects; afterRecordEvent runs only
 * after the runtime state and any assistant row/manifest commit together.
 * Sink failures propagate after projection and do not roll back committed state.
 */
export async function projectChannelRuntimeEvent(input: {
  metadata: ChannelBackendPromptMetadata;
  event: RuntimeEvent;
  responseText?: string;
  toolPresentation?: ChannelToolPresentation;
  toolDurationMs?: number;
  occurredAt?: number;
  sinks?: ChannelRuntimeEventSinkRegistry;
  /** Internal pure owner guard, rechecked after prior awaits and before each DB write. */
  beforeRecordEvent?: (state: ChannelBackendRuntimeState | undefined) => boolean;
  /** Internal synchronous preparation; no persistence, publication, or local cleanup. */
  prepareTerminalManifest?: (terminal: {
    state: ChannelBackendRuntimeState;
    output?: ChannelOutputEnvelope;
  }) => SlackAutomaticTerminalManifest;
  /** The whole DB unit committed; no notification or output await has occurred. */
  afterRecordEvent?: (state: ChannelBackendRuntimeState | undefined, manifest?: SlackAutomaticTerminalManifest) => void;
  /** Internal, owned inline recovery. Never accepted from a serialized channel request. */
  terminalRecovery?: ChannelTerminalRecoveryOptions;
}): Promise<KnownChannelRuntimeEvent[]> {
  const metadata = parseChannelBackendMetadata(input.metadata);
  const occurredAt = input.occurredAt ?? Date.now();
  const sinks = input.sinks ?? channelRuntimeEventSinks;
  const projected: KnownChannelRuntimeEvent[] = [];
  const precedingNotifications: KnownChannelRuntimeEvent[] = [];
  const event = input.event;
  let dispatchError: unknown;
  /** Records only while authorized and retains the first post-commit dispatch error. */
  const append = async (eventInput: RecordAndEmitInput) => {
    if (input.beforeRecordEvent?.(eventInput.state) === false) return;
    const recorded = await recordAndEmit({
      ...eventInput,
      precedingNotifications,
      /** Re-evaluates the pure owner fence per DB attempt; an installed fence must return true. */
      mayWrite: () => (input.beforeRecordEvent ? input.beforeRecordEvent(eventInput.state) === true : true),
      afterRecordEvent: input.afterRecordEvent,
      prepareTerminalManifest: input.prepareTerminalManifest,
      terminalRecovery: input.terminalRecovery,
    });
    if (!recorded) return;
    projected.push(recorded.event);
    dispatchError ??= recorded.dispatchError;
  };
  const current = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
  if (!current || current.state === "accepted") {
    const bootstrap: RecordAndEmitInput = {
      metadata,
      kind: "turn.state_changed",
      state: "running",
      payload: { state: "running" },
      occurredAt,
      sinks,
    };
    if (event.type === "turn.failed") {
      if (input.beforeRecordEvent?.("running") === false) return projected;
      // Keep the terminal recorder's baseline after this commit, without yielding
      // to a running notification that can retire the captured owner first.
      const recorded = recordFailedTurnBootstrap({
        ...bootstrap,
        mayWrite: () => (input.beforeRecordEvent ? input.beforeRecordEvent("running") === true : true),
        afterRecordEvent: input.afterRecordEvent,
      });
      if (!recorded) return projected;
      projected.push(recorded);
      precedingNotifications.push(recorded);
    } else {
      await append(bootstrap);
    }
  }

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
    const error = safeRuntimeError(metadata.correlationId, event.recoverable ?? false, event.error);
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
  /** Already committed bootstrap events, emitted inside the terminal's disposal scope. */
  precedingNotifications?: readonly KnownChannelRuntimeEvent[];
  mayWrite?: () => boolean;
  prepareTerminalManifest?: (terminal: {
    state: ChannelBackendRuntimeState;
    output?: ChannelOutputEnvelope;
  }) => SlackAutomaticTerminalManifest;
  afterRecordEvent?: (state: ChannelBackendRuntimeState | undefined, manifest?: SlackAutomaticTerminalManifest) => void;
  terminalRecovery?: ChannelTerminalRecoveryOptions;
}

/** Preserve the recorded sequence and payload instead of rereading the later terminal row. */
function recordedRuntimeEvent(
  input: RecordAndEmitInput,
  persisted: ReturnType<typeof dbRecordChannelBackendRuntimeEvent>,
): KnownChannelRuntimeEvent {
  const payload =
    typeof input.payload === "function"
      ? input.payload(
          persisted.runtime.lastSequence,
          persisted.runtime.assistantMessageId,
          persisted.runtime.lastDeltaSequence,
        )
      : input.payload;
  return KnownChannelRuntimeEventSchema.parse({
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
}

/**
 * Persist the failure's bootstrap without a promise boundary or external sink.
 * Its synchronous post-commit callback retains normal refusal semantics; this
 * nonterminal step never prepares a manifest or acquires media disposal rights.
 */
function recordFailedTurnBootstrap(input: RecordAndEmitInput): KnownChannelRuntimeEvent | undefined {
  if (input.mayWrite && input.mayWrite() !== true) return;
  let persisted: ReturnType<typeof dbRecordChannelBackendRuntimeEvent>;
  try {
    persisted = dbRecordChannelBackendRuntimeEvent({
      turnId: input.metadata.binding.turnId,
      state: "running",
      runtimeGenerationId: channelRuntimeGenerationId,
      occurredAt: input.occurredAt,
      mayWrite: input.mayWrite,
    });
  } catch (error) {
    if (error instanceof ChannelBackendRuntimeOwnershipLostError) return;
    throw error;
  }
  input.afterRecordEvent?.("running", persisted.slackTerminalManifest);
  return recordedRuntimeEvent(input, persisted);
}

/**
 * Validates a terminal output envelope without emitting it. Only completed text
 * or a failed turn's safe error produces an envelope; its semantic ID, binding
 * and destination remain those of the accepted request.
 */
function prepareTerminalOutput(input: RecordAndEmitInput): ChannelOutputEnvelope | undefined {
  if (
    input.kind !== "turn.terminal_output" ||
    !((input.state === "completed" && input.assistantText) || (input.state === "failed" && input.safeError))
  )
    return undefined;
  return ChannelOutputEnvelopeSchema.parse({
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
}

/**
 * Prepares output before atomically recording runtime state and its manifest.
 * Owned recovery retains one terminal for bounded persistence recovery. Commit
 * confirmation synchronously detaches private handles before readiness callbacks;
 * disposal is awaited outside the transaction even if recovery/callback/schema
 * or sinks throw. Independent sinks preserve the first dispatchError, which does
 * not undo commit or establish remote delivery. Text retries require a typed,
 * completed pre-save absence; durable outbox work and media are not resent here.
 */
async function recordAndEmit(
  input: RecordAndEmitInput,
): Promise<{ event: KnownChannelRuntimeEvent; dispatchError?: unknown } | undefined> {
  if (input.mayWrite && input.mayWrite() !== true) return;
  const output = prepareTerminalOutput(input);
  const preparedManifest =
    input.state && isTerminalState(input.state)
      ? input.prepareTerminalManifest?.({ state: input.state, output })
      : undefined;
  let persisted: ReturnType<typeof dbRecordChannelBackendRuntimeEvent>;
  const discardedAllocations: Array<() => Promise<GeneratedMediaCleanupResult>> = [];
  /**
   * Confirmed commit/readback settles only this reply before readiness callbacks.
   * The recovery helper latches this synchronous callback once, outside DB catches.
   * Preserve a callback's original error even if private-handle settlement also fails.
   */
  const afterCommit = (recorded: ReturnType<typeof dbRecordChannelBackendRuntimeEvent>) => {
    let settlementFailed = false;
    let settlementError: unknown;
    try {
      if (input.state === "completed" || input.state === "failed" || input.state === "interrupted") {
        // Only this accepted transition can transfer disposal authority. Capture
        // it before callbacks can throw or erase descriptors, without filesystem I/O.
        const reply = discardSlackAutomaticPendingReply(input.metadata.binding);
        if (reply && isDeepStrictEqual(reply.origin.binding, input.metadata.binding)) {
          for (const allocation of reply.ownedMediaAllocations) {
            if (input.state === "completed") {
              generatedMediaAllocations.retain(allocation, reply);
            } else {
              const dispose = generatedMediaAllocations.prepareDiscard(allocation, reply);
              if (dispose) discardedAllocations.push(dispose);
            }
          }
          if (input.state !== "completed") {
            reply.ownedMediaAllocations.clear();
            reply.media = [];
            reply.mediaKeys.clear();
          }
        }
      }
    } catch (error) {
      settlementFailed = true;
      settlementError = error;
    }
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      input.afterRecordEvent?.(input.state, recorded.slackTerminalManifest);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
    if (callbackFailed) throw callbackError;
    if (settlementFailed) throw settlementError;
  };
  const recordInput = {
    turnId: input.metadata.binding.turnId,
    state: input.state,
    assistantDelta: input.assistantDelta,
    assistantText: input.assistantText,
    runtimeGenerationId: channelRuntimeGenerationId,
    terminalError: input.safeError,
    occurredAt: input.occurredAt,
    mayWrite: input.mayWrite,
    slackTerminalManifest: preparedManifest,
  };
  try {
    if (input.terminalRecovery && input.state && isTerminalState(input.state)) {
      persisted = await recordTerminalProjectionWithRecovery(recordInput, {
        ...input.terminalRecovery,
        onCommitted: afterCommit,
      });
    } else {
      try {
        persisted = dbRecordChannelBackendRuntimeEvent(recordInput);
      } catch (error) {
        if (error instanceof ChannelBackendRuntimeOwnershipLostError) return;
        throw error;
      }
      afterCommit(persisted);
    }
    const event = recordedRuntimeEvent(input, persisted);
    let dispatchError: unknown;
    for (const notification of [...(input.precedingNotifications ?? []), event]) {
      try {
        const deliveredLocally = await input.sinks.tryEmit(input.metadata.target, notification);
        if (!deliveredLocally) {
          if (!channelBackendEgressRequester) {
            throw new Error(
              `Channel runtime event sink is unavailable for ${input.metadata.target.channelKind}/${input.metadata.target.connectionId}`,
            );
          }
          await channelBackendEgressRequester.emitRuntimeEvent(input.metadata.target, notification);
        }
      } catch (error) {
        dispatchError ??= error;
      }
    }

    if (output) {
      // Pin this routing handle along with the immutable output. A replacement
      // requester cannot silently reinterpret a prepared retry in the same call.
      const requester = channelBackendEgressRequester;
      const emitOutput = async (envelope: ChannelOutputEnvelope, context?: ChannelOutputEmissionContext) => {
        const local = await channelOutputSinks.tryEmitWithHandoff(envelope, context);
        if (local.emitted) return local.confirmation;
        if (!requester) {
          throw new Error(
            `Channel output sink is unavailable for ${envelope.target.channelKind}/${envelope.target.connectionId}`,
          );
        }
        const confirmation = await requester.emitOutput(envelope, context);
        return confirmation === undefined ? undefined : confirmation;
      };
      try {
        if (input.terminalRecovery && output.target.channelKind === "slack") {
          await handoffTerminalOutputWithRecovery(output, emitOutput, {
            mayEmit: () => input.terminalRecovery!.mayRecover() && (!input.mayWrite || input.mayWrite() === true),
            onState: input.terminalRecovery.onOutputState,
          });
        } else {
          await emitOutput(output);
        }
      } catch (error) {
        // Notification failure retains precedence but never selects text retry
        // policy: the missing handoff was settled by its own typed stage above.
        dispatchError ??= error;
      }
    }
    return {
      event,
      ...(dispatchError !== undefined ? { dispatchError } : {}),
    };
  } finally {
    // Never execute removals inside the transaction or its synchronous callback.
    // Await every owned intention even if callback/payload/schema or sinks failed.
    for (const dispose of discardedAllocations) {
      try {
        const result = await dispose();
        if (result.status === "failed" || result.status === "rejected") {
          reportAutomaticMediaDisposalFailure(input.metadata.binding.turnId, result);
        }
      } catch (error) {
        reportAutomaticMediaDisposalFailure(input.metadata.binding.turnId, { error });
      }
    }
  }
}

/** Records disposal failure without replacing the accepted terminal's result or original exception. */
function reportAutomaticMediaDisposalFailure(turnId: string, details: Record<string, unknown>): void {
  try {
    log.warn("Discarded automatic media allocation could not be released", { turnId, ...details });
    // no-cause: Logging already failed while reporting disposal; propagation would replace the accepted terminal or primary error.
  } catch {
    // A broken logging sink must not turn cleanup into a new terminal failure.
  }
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

// The provider's own failure text never leaves the host: it can name
// credentials, accounts or internal diagnostics. Only its class reaches the
// channel, so a billing or rate-limit failure is not reported as INTERNAL.
function safeRuntimeError(correlationId: string, retryable: boolean, errorText?: string): ChannelSafeError {
  return ChannelSafeErrorSchema.parse({
    ...(errorText === undefined
      ? { code: "INTERNAL", category: "internal", retryable }
      : classifyChannelRuntimeFailure(errorText, retryable)),
    correlationId,
  });
}

type ChannelRuntimeFailureClass = Pick<ChannelSafeError, "code" | "category" | "retryable">;

export function classifyChannelRuntimeFailure(errorText: string, recoverable: boolean): ChannelRuntimeFailureClass {
  const text = errorText.trim();
  if (text === PROVIDER_CAPACITY_UNSAFE_MESSAGE) {
    return { code: "OVERLOADED", category: "capacity", retryable: false };
  }
  if (text === PROVIDER_CAPACITY_EXHAUSTED_MESSAGE) {
    return { code: "OVERLOADED", category: "capacity", retryable: true };
  }
  if (isRuntimeCredentialResolutionFailure(text)) {
    return { code: "UNAVAILABLE", category: "availability", retryable: false };
  }
  const httpStatus = providerFailureStatus(text);
  const providerCode = /provider error \(([a-z0-9_]+)\)/i.exec(text)?.[1];
  if (httpStatus === undefined && providerCode === undefined && !PROVIDER_FAILURE_TEXT.test(text)) {
    return { code: "INTERNAL", category: "internal", retryable: recoverable };
  }
  // Only the failure class is used; the projection does not know the provider.
  const { kind } = classifyRuntimeCredentialFailure({
    runtimeProvider: "claude",
    message: text,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode ? { providerCode } : {}),
  });
  switch (kind) {
    case "rate_limited":
      return { code: "RATE_LIMITED", category: "capacity", retryable: true };
    case "provider_overloaded":
      return { code: "OVERLOADED", category: "capacity", retryable: true };
    case "network_transient":
      return { code: "UNAVAILABLE", category: "availability", retryable: true };
    case "billing_blocked":
    case "quota_exhausted":
    case "auth_invalid":
    case "permission_denied":
      // The operator's provider account has to change; retrying will not help.
      return { code: "UNAVAILABLE", category: "availability", retryable: false };
    default:
      return { code: "INTERNAL", category: "internal", retryable: recoverable };
  }
}

// Provider failures the classifier recognizes from text alone, with no status.
const PROVIDER_FAILURE_TEXT = /\b(?:insufficient (?:balance|credits)|out of extra usage|overloaded)\b/i;

// Provider SDKs put the HTTP status in the message: OpenAI-compatible clients
// (pi) as "402 Insufficient Balance", claude-provider as "(http_402)".
function providerFailureStatus(text: string): number | undefined {
  const match =
    /^(?:Error:\s*)?([45]\d\d)\s/.exec(text) ??
    /\bhttp_([45]\d\d)\b/i.exec(text) ??
    /\b(?:HTTP|status(?: code)?)[\s:=]+([45]\d\d)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
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

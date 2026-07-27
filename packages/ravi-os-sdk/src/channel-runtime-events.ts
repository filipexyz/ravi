import { z } from "zod";
import {
  CHANNEL_BACKEND_MAX_TEXT_BYTES,
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  ChannelContentSchema,
  ChannelSafeErrorSchema,
  LocalChannelMessageBindingSchema,
} from "./channel-backend.js";

export const CHANNEL_RUNTIME_EVENTS_PROTOCOL = "ravi.channel.runtime-events" as const;
export const CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION = 1 as const;

const textEncoder = new TextEncoder();

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

export const ChannelToolSummaryPayloadSchema = z.object({
  toolCallId: ChannelBackendOpaqueIdSchema,
  toolName: ChannelBackendWireKindSchema,
  phase: z.enum(["requested", "running", "completed", "failed", "denied"]),
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

export const ChannelRuntimeReadbackResultSchema = z.object({
  protocol: z.literal(CHANNEL_RUNTIME_EVENTS_PROTOCOL),
  schemaVersion: z.literal(CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION),
  requestId: ChannelBackendOpaqueIdSchema,
  binding: LocalChannelMessageBindingSchema,
  state: ChannelTurnStateSchema,
  lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  assistantMessageId: ChannelBackendOpaqueIdSchema.optional(),
  observedAt: z.string().datetime({ offset: true }),
});

export type ChannelRuntimeCorrelation = z.infer<typeof ChannelRuntimeCorrelationSchema>;
export type ChannelTurnState = z.infer<typeof ChannelTurnStateSchema>;
export type KnownChannelRuntimeEvent = z.infer<typeof KnownChannelRuntimeEventSchema>;
export type ChannelInterruptRequest = z.infer<typeof ChannelInterruptRequestSchema>;
export type ChannelInterruptResult = z.infer<typeof ChannelInterruptResultSchema>;
export type ChannelRuntimeReadbackRequest = z.infer<typeof ChannelRuntimeReadbackRequestSchema>;
export type ChannelRuntimeReadbackResult = z.infer<typeof ChannelRuntimeReadbackResultSchema>;

export interface ChannelRuntimeCommandClient {
  readonly channels: {
    readonly backend: {
      readonly runtime: {
        interrupt(agentId: string, request: ChannelInterruptRequest): Promise<unknown>;
        readback(agentId: string, request: ChannelRuntimeReadbackRequest): Promise<unknown>;
      };
    };
  };
}

export class RaviChannelRuntimeClient {
  constructor(private readonly client: ChannelRuntimeCommandClient) {}

  async interrupt(input: ChannelInterruptRequest): Promise<ChannelInterruptResult> {
    const request = ChannelInterruptRequestSchema.parse(input);
    const result = await this.client.channels.backend.runtime.interrupt(request.binding.agentId, request);
    return ChannelInterruptResultSchema.parse(result);
  }

  async readback(input: ChannelRuntimeReadbackRequest): Promise<ChannelRuntimeReadbackResult> {
    const request = ChannelRuntimeReadbackRequestSchema.parse(input);
    const result = await this.client.channels.backend.runtime.readback(request.binding.agentId, request);
    return ChannelRuntimeReadbackResultSchema.parse(result);
  }
}

export function createChannelRuntimeClient(client: ChannelRuntimeCommandClient): RaviChannelRuntimeClient {
  return new RaviChannelRuntimeClient(client);
}

export interface ChannelRuntimeEventSink {
  emit(event: KnownChannelRuntimeEvent): Promise<void>;
}

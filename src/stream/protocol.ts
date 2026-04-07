import { z } from "zod";

export const STREAM_PROTOCOL_VERSION = 1 as const;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const CursorSchema = z.string().min(1);

const StreamMessageBaseSchema = z.object({
  v: z.literal(STREAM_PROTOCOL_VERSION),
  id: z.string().min(1),
  ts: IsoTimestampSchema,
});

const StreamOutputBaseSchema = StreamMessageBaseSchema.extend({
  source: z.string().min(1),
});

export const StreamHelloBodySchema = z
  .object({
    scope: z.string().min(1),
    topicPatterns: z.array(z.string().min(1)).default([]),
    capabilities: z.array(z.string().min(1)).default([]),
    protocolVersion: z.literal(STREAM_PROTOCOL_VERSION).default(STREAM_PROTOCOL_VERSION),
  })
  .strict();

export const StreamHelloMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("hello"),
  body: StreamHelloBodySchema,
}).strict();

export const StreamSnapshotMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("snapshot"),
  cursor: CursorSchema.optional(),
  body: z
    .object({
      scope: z.string().min(1),
      entities: z.record(z.string(), z.unknown()).default({}),
      filters: z
        .object({
          topicPatterns: z.array(z.string().min(1)).default([]),
        })
        .strict()
        .optional(),
      runtime: z
        .object({
          pid: z.number().int().positive(),
          startedAt: IsoTimestampSchema,
        })
        .strict(),
      capabilities: z.array(z.string().min(1)).default([]),
    })
    .strict(),
}).strict();

export const StreamEventMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("event"),
  topic: z.string().min(1),
  cursor: CursorSchema.optional(),
  body: z.record(z.string(), z.unknown()),
}).strict();

export const StreamAckMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("ack"),
  body: z
    .object({
      commandId: z.string().min(1),
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .strict(),
}).strict();

export const StreamErrorMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("error"),
  body: z
    .object({
      commandId: z.string().min(1).optional(),
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean().default(false),
      details: z.unknown().optional(),
    })
    .strict(),
}).strict();

export const StreamHeartbeatMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("heartbeat"),
  body: z
    .object({
      uptimeMs: z.number().int().nonnegative(),
      cursor: CursorSchema.optional(),
    })
    .strict(),
}).strict();

export const StreamMetricMessageSchema = StreamOutputBaseSchema.extend({
  type: z.literal("metric"),
  body: z
    .object({
      name: z.string().min(1),
      value: z.number(),
      unit: z.string().min(1).optional(),
    })
    .strict(),
}).strict();

export const StreamOutputMessageSchema = z.discriminatedUnion("type", [
  StreamHelloMessageSchema,
  StreamSnapshotMessageSchema,
  StreamEventMessageSchema,
  StreamAckMessageSchema,
  StreamErrorMessageSchema,
  StreamHeartbeatMessageSchema,
  StreamMetricMessageSchema,
]);

export const StreamInputHelloMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("hello"),
  body: z
    .object({
      scope: z.string().min(1).optional(),
      topicPatterns: z.array(z.string().min(1)).default([]),
    })
    .strict()
    .default({ topicPatterns: [] }),
}).strict();

export const StreamCommandMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("command"),
  body: z
    .object({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
      expectAck: z.boolean().default(true),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
}).strict();

export const StreamInputMessageSchema = z.discriminatedUnion("type", [
  StreamInputHelloMessageSchema,
  StreamCommandMessageSchema,
]);

export type StreamHelloBody = z.infer<typeof StreamHelloBodySchema>;
export type StreamHelloMessage = z.infer<typeof StreamHelloMessageSchema>;
export type StreamSnapshotMessage = z.infer<typeof StreamSnapshotMessageSchema>;
export type StreamEventMessage = z.infer<typeof StreamEventMessageSchema>;
export type StreamAckMessage = z.infer<typeof StreamAckMessageSchema>;
export type StreamErrorMessage = z.infer<typeof StreamErrorMessageSchema>;
export type StreamHeartbeatMessage = z.infer<typeof StreamHeartbeatMessageSchema>;
export type StreamMetricMessage = z.infer<typeof StreamMetricMessageSchema>;
export type StreamOutputMessage = z.infer<typeof StreamOutputMessageSchema>;
export type StreamInputHelloMessage = z.infer<typeof StreamInputHelloMessageSchema>;
export type StreamCommandMessage = z.infer<typeof StreamCommandMessageSchema>;
export type StreamInputMessage = z.infer<typeof StreamInputMessageSchema>;

export function makeStreamMessageId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function makeStreamTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function formatStreamLine(message: StreamOutputMessage | StreamInputMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseStreamOutputLine(line: string): StreamOutputMessage {
  return StreamOutputMessageSchema.parse(JSON.parse(line));
}

export function parseStreamInputLine(line: string): StreamInputMessage {
  return StreamInputMessageSchema.parse(JSON.parse(line));
}

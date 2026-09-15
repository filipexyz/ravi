import { JSONCodec } from "nats";
import { z } from "zod";
import {
  ChannelOutputEnvelopeSchema,
  ExternalChannelTargetSchema,
  channelOutputSinks,
  type ChannelOutputEnvelope,
  type ExternalChannelTarget,
} from "./backend.js";
import {
  KnownChannelRuntimeEventSchema,
  channelRuntimeEventSinks,
  type KnownChannelRuntimeEvent,
} from "./runtime-events.js";

export const CHANNEL_BACKEND_EGRESS_PROTOCOL = "ravi.channel.backend-egress" as const;
export const CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION = 1 as const;
export const CHANNEL_BACKEND_EGRESS_SUBJECT = "_RAVI.channels.backend-egress";
export const CHANNEL_BACKEND_EGRESS_QUEUE = "ravi-channel-backend-egress";
export const DEFAULT_CHANNEL_BACKEND_EGRESS_TIMEOUT_MS = 10_000;

const ChannelBackendEgressRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
    kind: z.literal("runtime_event"),
    target: ExternalChannelTargetSchema,
    event: KnownChannelRuntimeEventSchema,
  }),
  z.object({
    protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
    kind: z.literal("output"),
    envelope: ChannelOutputEnvelopeSchema,
  }),
]);

const ChannelBackendEgressResponseSchema = z.union([
  z.object({
    protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
    ok: z.literal(true),
  }),
  z.object({
    protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
    schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
    ok: z.literal(false),
    reason: z.enum(["invalid_request", "sink_unavailable", "sink_failed"]),
  }),
]);

export type ChannelBackendEgressRequest = z.infer<typeof ChannelBackendEgressRequestSchema>;
export type ChannelBackendEgressResponse = z.infer<typeof ChannelBackendEgressResponseSchema>;

export interface ChannelBackendEgressRequester {
  emitRuntimeEvent(target: ExternalChannelTarget, event: KnownChannelRuntimeEvent): Promise<void>;
  emitOutput(envelope: ChannelOutputEnvelope): Promise<void>;
}

export interface ChannelBackendEgressMessage {
  readonly data: Uint8Array;
  respond(data: Uint8Array): boolean;
}

export interface ChannelBackendEgressSubscription extends AsyncIterable<ChannelBackendEgressMessage> {
  unsubscribe(): void;
}

export interface ChannelBackendEgressResponderConnection {
  subscribe(subject: string, options?: { queue?: string }): ChannelBackendEgressSubscription;
}

export interface ChannelBackendEgressRequestConnection {
  request(subject: string, data: Uint8Array, options: { timeout: number }): Promise<{ readonly data: Uint8Array }>;
}

export interface ChannelBackendEgressResponder {
  stop(): Promise<void>;
}

const codec = JSONCodec<unknown>();

export function createChannelBackendEgressRequester(
  options: { timeoutMs?: number; connect?: () => Promise<ChannelBackendEgressRequestConnection> } = {},
): ChannelBackendEgressRequester {
  const request = async (input: ChannelBackendEgressRequest): Promise<void> => {
    const connection = await (options.connect ?? defaultRequestConnection)();
    const response = await connection.request(CHANNEL_BACKEND_EGRESS_SUBJECT, codec.encode(input), {
      timeout: options.timeoutMs ?? DEFAULT_CHANNEL_BACKEND_EGRESS_TIMEOUT_MS,
    });
    const parsed = ChannelBackendEgressResponseSchema.parse(codec.decode(response.data));
    if (!parsed.ok) {
      throw new Error(`Channel backend egress unavailable: ${parsed.reason}`);
    }
  };

  return {
    emitRuntimeEvent(target, event) {
      return request(
        ChannelBackendEgressRequestSchema.parse({
          protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
          schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
          kind: "runtime_event",
          target,
          event,
        }),
      );
    },
    emitOutput(envelope) {
      return request(
        ChannelBackendEgressRequestSchema.parse({
          protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
          schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
          kind: "output",
          envelope,
        }),
      );
    },
  };
}

export function startChannelBackendEgressResponder(options: {
  connection: ChannelBackendEgressResponderConnection;
  runtimeEventSinks?: typeof channelRuntimeEventSinks;
  outputSinks?: typeof channelOutputSinks;
}): ChannelBackendEgressResponder {
  const runtimeEventSinks = options.runtimeEventSinks ?? channelRuntimeEventSinks;
  const outputSinks = options.outputSinks ?? channelOutputSinks;
  const subscription = options.connection.subscribe(CHANNEL_BACKEND_EGRESS_SUBJECT, {
    queue: CHANNEL_BACKEND_EGRESS_QUEUE,
  });
  let stopped = false;

  const loop = (async () => {
    for await (const message of subscription) {
      if (stopped) break;
      let response: ChannelBackendEgressResponse;
      try {
        const request = ChannelBackendEgressRequestSchema.parse(codec.decode(message.data));
        if (request.kind === "runtime_event") {
          await runtimeEventSinks.emit(request.target, request.event);
        } else {
          await outputSinks.emit(request.envelope);
        }
        response = successResponse();
      } catch (error) {
        response = failureResponse(error);
      }
      message.respond(codec.encode(response));
    }
  })();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      await loop.catch(() => {});
    },
  };
}

function successResponse(): ChannelBackendEgressResponse {
  return {
    protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
    ok: true,
  };
}

function failureResponse(error: unknown): ChannelBackendEgressResponse {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason =
    error instanceof z.ZodError
      ? "invalid_request"
      : message.includes("unavailable")
        ? "sink_unavailable"
        : "sink_failed";
  return {
    protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
    ok: false,
    reason,
  };
}

async function defaultRequestConnection(): Promise<ChannelBackendEgressRequestConnection> {
  const { ensureConnected } = await import("../nats.js");
  return await ensureConnected();
}

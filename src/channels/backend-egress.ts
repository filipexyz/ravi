import { JSONCodec } from "nats";
import { z } from "zod";
import {
  ChannelOutputEnvelopeSchema,
  ExternalChannelTargetSchema,
  channelOutputSinks,
  matchingChannelOutputHandoffEvidence,
  type ChannelOutputEnvelope,
  type ExternalChannelTarget,
} from "./backend.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
  ChannelOutputEmissionContextSchema,
  ChannelOutputHandoffConfirmationSchema,
  ChannelOutputHandoffEvidenceSchema,
  ChannelOutputHandoffError,
  channelOutputHandoffConfirmationMatches,
  createChannelOutputHandoffIdentity,
  type ChannelOutputEmissionContext,
  type ChannelOutputHandoffConfirmation,
} from "./output-handoff.js";
import {
  KnownChannelRuntimeEventSchema,
  channelRuntimeEventSinks,
  type KnownChannelRuntimeEvent,
} from "./runtime-events.js";

export const CHANNEL_BACKEND_EGRESS_PROTOCOL = "ravi.channel.backend-egress" as const;
// A v1 receiver must reject before dispatch instead of stripping restrictions.
export const CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION = 2 as const;
export const CHANNEL_BACKEND_EGRESS_SUBJECT = "_RAVI.channels.backend-egress";
export const CHANNEL_BACKEND_EGRESS_QUEUE = "ravi-channel-backend-egress";
export const DEFAULT_CHANNEL_BACKEND_EGRESS_TIMEOUT_MS = 10_000;

export const ChannelBackendEgressRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
      schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
      kind: z.literal("runtime_event"),
      target: ExternalChannelTargetSchema,
      event: KnownChannelRuntimeEventSchema,
    })
    .strict(),
  z
    .object({
      protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
      schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
      kind: z.literal("output"),
      envelope: ChannelOutputEnvelopeSchema,
      context: ChannelOutputEmissionContextSchema.optional(),
    })
    .strict(),
]);

export const ChannelBackendEgressResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
      schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
      ok: z.literal(true),
      confirmation: ChannelOutputHandoffConfirmationSchema.optional(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(CHANNEL_BACKEND_EGRESS_PROTOCOL),
      schemaVersion: z.literal(CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION),
      ok: z.literal(false),
      reason: z.enum(["invalid_request", "sink_unavailable", "sink_failed"]),
      evidence: ChannelOutputHandoffEvidenceSchema.optional(),
    })
    .strict(),
]);

export type ChannelBackendEgressRequest = z.infer<typeof ChannelBackendEgressRequestSchema>;
export type ChannelBackendEgressResponse = z.infer<typeof ChannelBackendEgressResponseSchema>;

export interface ChannelBackendEgressRequester {
  emitRuntimeEvent(target: ExternalChannelTarget, event: KnownChannelRuntimeEvent): Promise<void>;
  emitOutput(
    envelope: ChannelOutputEnvelope,
    context?: ChannelOutputEmissionContext,
  ): Promise<void> | Promise<ChannelOutputHandoffConfirmation | undefined>;
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
  // One request only: unsupported versions, malformed replies and timeouts
  // never fall back to an unrestricted or older wire contract.
  const request = async (input: ChannelBackendEgressRequest): Promise<ChannelBackendEgressResponse> => {
    const connection = await (options.connect ?? defaultRequestConnection)();
    const response = await connection.request(CHANNEL_BACKEND_EGRESS_SUBJECT, codec.encode(input), {
      timeout: options.timeoutMs ?? DEFAULT_CHANNEL_BACKEND_EGRESS_TIMEOUT_MS,
    });
    return ChannelBackendEgressResponseSchema.parse(codec.decode(response.data));
  };

  return {
    async emitRuntimeEvent(target, event) {
      const response = await request(
        ChannelBackendEgressRequestSchema.parse({
          protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
          schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
          kind: "runtime_event",
          target,
          event,
        }),
      );
      if (!response.ok) throw new Error(`Channel backend egress rejected: ${response.reason}`);
    },
    async emitOutput(envelope, context) {
      const input = ChannelBackendEgressRequestSchema.parse({
        protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
        schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
        kind: "output",
        envelope,
        ...(context === undefined ? {} : { context }),
      });
      if (input.kind !== "output") throw new Error("Expected channel output request");
      let response: ChannelBackendEgressResponse;
      try {
        response = await request(input);
      } catch {
        // The remote call may still be saving. No absence or completion is inferred.
        throw unknownOutputHandoff(input.envelope, "TRANSPORT_FAILED", false);
      }
      if (!response.ok) {
        if (response.evidence) {
          const evidence = matchingChannelOutputHandoffEvidence(
            new ChannelOutputHandoffError(response.evidence),
            input.envelope,
            input.context,
          );
          if (evidence) throw new ChannelOutputHandoffError(evidence);
        }
        throw unknownOutputHandoff(input.envelope, "UNCLASSIFIED", false);
      }
      // Generic success acknowledges only a resolved invocation, not durability.
      if (response.confirmation === undefined) return;
      if (
        !channelOutputHandoffConfirmationMatches(
          response.confirmation,
          input.envelope,
          input.context?.expectedRequestFingerprint,
        )
      ) {
        throw unknownOutputHandoff(input.envelope, "INVALID_CONFIRMATION", true);
      }
      return response.confirmation;
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
      let request: ChannelBackendEgressRequest | undefined;
      try {
        request = ChannelBackendEgressRequestSchema.parse(codec.decode(message.data));
        if (request.kind === "runtime_event") {
          const emitted = await runtimeEventSinks.tryEmit(request.target, request.event);
          response = emitted ? successResponse() : failureResponse(undefined, request, "sink_unavailable");
        } else {
          const confirmation = await outputSinks.emit(request.envelope, request.context);
          if (
            confirmation !== undefined &&
            !channelOutputHandoffConfirmationMatches(
              confirmation,
              request.envelope,
              request.context?.expectedRequestFingerprint,
            )
          ) {
            throw unknownOutputHandoff(request.envelope, "INVALID_CONFIRMATION", true);
          }
          response = successResponse(confirmation === undefined ? undefined : confirmation);
        }
      } catch (error) {
        response = failureResponse(error, request);
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

function successResponse(confirmation?: ChannelOutputHandoffConfirmation): ChannelBackendEgressResponse {
  return {
    protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
    ok: true,
    ...(confirmation ? { confirmation: ChannelOutputHandoffConfirmationSchema.parse(confirmation) } : {}),
  };
}

function failureResponse(
  error: unknown,
  request?: ChannelBackendEgressRequest,
  explicitReason?: "sink_unavailable",
): ChannelBackendEgressResponse {
  const evidence =
    request?.kind === "output"
      ? matchingChannelOutputHandoffEvidence(error, request.envelope, request.context)
      : undefined;
  const reason =
    explicitReason ??
    (request === undefined
      ? "invalid_request"
      : evidence?.disposition === "not_started" && evidence.code === "SINK_UNAVAILABLE"
        ? "sink_unavailable"
        : "sink_failed");
  return {
    protocol: CHANNEL_BACKEND_EGRESS_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_EGRESS_SCHEMA_VERSION,
    ok: false,
    reason,
    ...(evidence ? { evidence: ChannelOutputHandoffEvidenceSchema.parse(evidence) } : {}),
  };
}

/** Sanitized uncertainty never authorizes another output emission. */
function unknownOutputHandoff(
  envelope: ChannelOutputEnvelope,
  code: "TRANSPORT_FAILED" | "UNCLASSIFIED" | "INVALID_CONFIRMATION",
  operationFinished: boolean,
): ChannelOutputHandoffError {
  return new ChannelOutputHandoffError({
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
    identity: createChannelOutputHandoffIdentity(envelope),
    disposition: "unknown",
    code,
    operationFinished,
  });
}

async function defaultRequestConnection(): Promise<ChannelBackendEgressRequestConnection> {
  const { ensureConnected } = await import("../nats.js");
  return await ensureConnected();
}

import { JSONCodec } from "nats";
import { z } from "zod";
import { ChannelBackendOpaqueIdSchema } from "../backend.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeLocalAgentActionRequestSchema,
  NativeLocalAgentActionResultSchema,
  type NativeLocalAgentActionRequest,
  type NativeLocalAgentActionResult,
} from "./driver.js";
import { NativeLocalAgentActionRegistry, nativeLocalAgentActions } from "./agent-actions.js";

export const NATIVE_LOCAL_AGENT_ACTION_BRIDGE_PROTOCOL = "ravi.channel.native-local-action-bridge" as const;
export const NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SCHEMA_VERSION = 1 as const;
export const NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SUBJECT = "_RAVI.channels.native-local-action" as const;
export const NATIVE_LOCAL_AGENT_ACTION_BRIDGE_QUEUE = "ravi-native-local-agent-actions" as const;
export const NATIVE_LOCAL_AGENT_ACTION_BRIDGE_TIMEOUT_MS = 10_000;

const NativeLocalAgentActionBridgeRequestSchema = z
  .object({
    protocol: z.literal(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_PROTOCOL),
    schemaVersion: z.literal(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SCHEMA_VERSION),
    channelInstanceId: ChannelBackendOpaqueIdSchema,
    request: NativeLocalAgentActionRequestSchema,
  })
  .strict();

const NativeLocalAgentActionBridgeResponseSchema = z
  .object({
    protocol: z.literal(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_PROTOCOL),
    schemaVersion: z.literal(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    result: NativeLocalAgentActionResultSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requestId !== value.result.requestId) {
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "bridge response correlation must match the action result",
      });
    }
  });

export interface NativeLocalAgentActionBridgeRequest {
  readonly channelInstanceId: string;
  readonly request: NativeLocalAgentActionRequest;
}

export type NativeLocalAgentActionBridgeRequester = (
  input: NativeLocalAgentActionBridgeRequest,
) => Promise<NativeLocalAgentActionResult | null>;

export interface NativeLocalAgentActionBridgeMessage {
  readonly data: Uint8Array;
  respond(data: Uint8Array): boolean;
}

export interface NativeLocalAgentActionBridgeSubscription extends AsyncIterable<NativeLocalAgentActionBridgeMessage> {
  unsubscribe(): void;
}

export interface NativeLocalAgentActionBridgeResponderConnection {
  subscribe(subject: string, options?: { readonly queue?: string }): NativeLocalAgentActionBridgeSubscription;
}

export interface NativeLocalAgentActionBridgeRequestConnection {
  request(
    subject: string,
    data: Uint8Array,
    options: { readonly timeout: number },
  ): Promise<{ readonly data: Uint8Array }>;
}

export interface NativeLocalAgentActionBridgeResponder {
  stop(): Promise<void>;
}

const codec = JSONCodec<unknown>();

export function startNativeLocalAgentActionBridgeResponder(options: {
  readonly connection: NativeLocalAgentActionBridgeResponderConnection;
  readonly registry?: NativeLocalAgentActionRegistry;
}): NativeLocalAgentActionBridgeResponder {
  const registry = options.registry ?? nativeLocalAgentActions;
  const subscription = options.connection.subscribe(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SUBJECT, {
    queue: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_QUEUE,
  });
  let stopped = false;
  const loop = (async () => {
    for await (const message of subscription) {
      if (stopped) break;
      const request = decodeBridgeRequest(message.data);
      if (request === undefined) continue;
      const response = await dispatchNativeLocalAgentActionBridgeRequest(request, registry);
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

export async function requestNativeLocalAgentAction(
  input: NativeLocalAgentActionBridgeRequest,
  options: {
    readonly connection?: NativeLocalAgentActionBridgeRequestConnection;
    readonly connect?: () => Promise<NativeLocalAgentActionBridgeRequestConnection>;
    readonly timeoutMs?: number;
  } = {},
): Promise<NativeLocalAgentActionResult | null> {
  const request = NativeLocalAgentActionBridgeRequestSchema.parse({
    protocol: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_PROTOCOL,
    schemaVersion: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SCHEMA_VERSION,
    channelInstanceId: input.channelInstanceId,
    request: input.request,
  });
  const timeout = options.timeoutMs ?? NATIVE_LOCAL_AGENT_ACTION_BRIDGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new RangeError("Native local Agent action bridge timeout is outside supported bounds.");
  }
  try {
    const connection = options.connection ?? (await (options.connect ?? defaultRequestConnection)());
    const message = await connection.request(NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SUBJECT, codec.encode(request), {
      timeout,
    });
    const response = NativeLocalAgentActionBridgeResponseSchema.parse(codec.decode(message.data));
    if (response.requestId !== request.request.requestId || response.result.requestId !== request.request.requestId) {
      return null;
    }
    return response.result;
  } catch {
    return null;
  }
}

async function dispatchNativeLocalAgentActionBridgeRequest(
  input: z.infer<typeof NativeLocalAgentActionBridgeRequestSchema>,
  registry: NativeLocalAgentActionRegistry,
): Promise<z.infer<typeof NativeLocalAgentActionBridgeResponseSchema>> {
  const request = NativeLocalAgentActionBridgeRequestSchema.parse(input);
  let result: NativeLocalAgentActionResult;
  try {
    result =
      (await registry.invokeRequest(request.request, {
        channelInstanceId: request.channelInstanceId,
      })) ?? unavailableResult(request.request.requestId);
  } catch {
    result = internalErrorResult(request.request.requestId);
  }
  return NativeLocalAgentActionBridgeResponseSchema.parse({
    protocol: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_PROTOCOL,
    schemaVersion: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SCHEMA_VERSION,
    requestId: request.request.requestId,
    result,
  });
}

function decodeBridgeRequest(data: Uint8Array): z.infer<typeof NativeLocalAgentActionBridgeRequestSchema> | undefined {
  try {
    return NativeLocalAgentActionBridgeRequestSchema.parse(codec.decode(data));
  } catch {
    return undefined;
  }
}

function unavailableResult(requestId: string): NativeLocalAgentActionResult {
  return NativeLocalAgentActionResultSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    requestId,
    disposition: "rejected",
    error: {
      code: "UNAVAILABLE",
      category: "availability",
      retryable: true,
      correlationId: requestId,
    },
    completedAt: new Date().toISOString(),
  });
}

function internalErrorResult(requestId: string): NativeLocalAgentActionResult {
  return NativeLocalAgentActionResultSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    requestId,
    disposition: "rejected",
    error: {
      code: "INTERNAL",
      category: "internal",
      retryable: false,
      correlationId: requestId,
    },
    completedAt: new Date().toISOString(),
  });
}

async function defaultRequestConnection(): Promise<NativeLocalAgentActionBridgeRequestConnection> {
  const { ensureConnected } = await import("../../nats.js");
  return await ensureConnected();
}

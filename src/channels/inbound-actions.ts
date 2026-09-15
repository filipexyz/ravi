import { JSONCodec } from "nats";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeInboundChannelActionRequestSchema,
  NativeInboundChannelActionResultSchema,
  parseNativeChannelDriverModuleConfigs,
  type NativeInboundChannelActionHandler,
  type NativeInboundChannelActionRequest,
  type NativeInboundChannelActionResult,
} from "./native/driver.js";

export const NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT = "_RAVI.channels.inbound-action" as const;
export const NATIVE_INBOUND_CHANNEL_ACTION_TIMEOUT_MS = 1_000;

const codec = JSONCodec<unknown>();

export interface NativeInboundChannelActionMessage {
  readonly data: Uint8Array;
  readonly reply?: string;
  respond(data: Uint8Array): boolean;
}

export interface NativeInboundChannelActionSubscription extends AsyncIterable<NativeInboundChannelActionMessage> {
  unsubscribe(): void;
}

export interface NativeInboundChannelActionResponderConnection {
  subscribe(subject: string): NativeInboundChannelActionSubscription;
}

export interface NativeInboundChannelActionRequestConnection {
  request(subject: string, data: Uint8Array, options: { timeout: number }): Promise<{ data: Uint8Array }>;
}

export interface NativeInboundChannelActionResponder {
  stop(): Promise<void>;
}

export function configuredNativeInboundActionNames(value: string | undefined): readonly string[] {
  return [
    ...new Set(
      parseNativeChannelDriverModuleConfigs(value).flatMap((configuration) => configuration.inboundActions ?? []),
    ),
  ].sort();
}

export async function dispatchNativeInboundChannelAction(
  handlers: readonly NativeInboundChannelActionHandler[],
  input: NativeInboundChannelActionRequest,
): Promise<NativeInboundChannelActionResult | null> {
  const request = NativeInboundChannelActionRequestSchema.parse(input);
  const supported: NativeInboundChannelActionHandler[] = [];
  for (const handler of handlers) {
    try {
      if (handler.supports(request.action)) supported.push(handler);
    } catch {}
  }
  if (supported.length === 0) return null;
  if (supported.length > 1) return internalActionError(request.requestId);
  try {
    const result = NativeInboundChannelActionResultSchema.parse(await supported[0]!.handle(request));
    return result.requestId === request.requestId ? result : internalActionError(request.requestId);
  } catch {
    return internalActionError(request.requestId);
  }
}

export function startNativeInboundChannelActionResponder(options: {
  connection: NativeInboundChannelActionResponderConnection;
  handlers: readonly NativeInboundChannelActionHandler[];
}): NativeInboundChannelActionResponder {
  const subscription = options.connection.subscribe(NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT);
  let stopped = false;
  const task = respond(subscription, options.handlers, () => stopped);
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      await task;
    },
  };
}

export async function requestNativeInboundChannelAction(
  input: NativeInboundChannelActionRequest,
  options: {
    connection: NativeInboundChannelActionRequestConnection;
    timeoutMs?: number;
  },
): Promise<NativeInboundChannelActionResult | null> {
  const request = NativeInboundChannelActionRequestSchema.parse(input);
  const timeout = options.timeoutMs ?? NATIVE_INBOUND_CHANNEL_ACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) {
    throw new RangeError("Native inbound action timeout is outside supported bounds.");
  }
  try {
    const message = await options.connection.request(NATIVE_INBOUND_CHANNEL_ACTION_SUBJECT, codec.encode(request), {
      timeout,
    });
    const result = NativeInboundChannelActionResultSchema.parse(codec.decode(message.data));
    return result.requestId === request.requestId ? result : null;
  } catch {
    return null;
  }
}

async function respond(
  subscription: NativeInboundChannelActionSubscription,
  handlers: readonly NativeInboundChannelActionHandler[],
  isStopped: () => boolean,
): Promise<void> {
  for await (const message of subscription) {
    if (isStopped()) return;
    let decoded: unknown;
    try {
      decoded = codec.decode(message.data);
    } catch {
      continue;
    }
    const parsed = NativeInboundChannelActionRequestSchema.safeParse(decoded);
    if (!parsed.success) continue;
    const result = await dispatchNativeInboundChannelAction(handlers, parsed.data);
    if (result === null || !message.reply) continue;
    message.respond(codec.encode(result));
  }
}

function internalActionError(requestId: string): NativeInboundChannelActionResult {
  return NativeInboundChannelActionResultSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    requestId,
    disposition: "handled",
    error: {
      code: "INTERNAL",
      category: "internal",
      retryable: false,
      correlationId: requestId,
    },
    completedAt: new Date().toISOString(),
  });
}

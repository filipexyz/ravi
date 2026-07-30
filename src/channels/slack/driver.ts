import type { ChannelConfig } from "../../router/router-db.js";
import type { ChannelOutputEnvelope } from "../backend.js";
import { publishChannelOutboundJobDurably } from "../outbound-publish-outbox.js";
import { buildChannelTextOutboundJob, type ChannelOutboundJob } from "../outbound-stream.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeChannelDriverContractError,
  NativeChannelDriverDescriptorSchema,
  NativeChannelRuntimeDescriptorSchema,
  type NativeChannelDriver,
  type NativeChannelRuntimeHealth,
} from "../native/driver.js";
import {
  createSlackNativeRuntimeFromEnv,
  decodeSlackBackendConversationId,
  type SlackNativeRuntime,
  type SlackSocketModeStatus,
} from "./socket-mode.js";

export interface SlackNativeChannelDriverOptions {
  readonly createRuntime?: (
    env: NodeJS.ProcessEnv,
    options: { channel: ChannelConfig },
  ) => Promise<SlackNativeRuntime | null>;
  readonly publishOutbound?: (job: ChannelOutboundJob) => Promise<void>;
  readonly now?: () => number;
}

export function createSlackNativeChannelDriver(
  env: NodeJS.ProcessEnv = process.env,
  options: SlackNativeChannelDriverOptions = {},
): NativeChannelDriver {
  const descriptor = NativeChannelDriverDescriptorSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    driverId: "ravi.slack",
    provider: "slack",
    capabilities: ["inbound", "text_delivery", "chat_actions", "presence"],
  });

  return {
    descriptor,
    async createRuntime(context) {
      const channel: ChannelConfig = {
        name: context.channel.name,
        provider: context.channel.provider,
        ...(context.channel.credentialConnection ? { credentialConnection: context.channel.credentialConnection } : {}),
        ...(context.channel.defaults ? { defaults: { ...context.channel.defaults } } : {}),
        createdAt: 0,
        updatedAt: 0,
      };
      const native = await (options.createRuntime ?? createSlackNativeRuntimeFromEnv)(env, { channel });
      if (!native) {
        throw new NativeChannelDriverContractError("missing_credentials");
      }
      const runtimeDescriptor = NativeChannelRuntimeDescriptorSchema.parse({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: descriptor.driverId,
        provider: descriptor.provider,
        runtimeId: channel.name,
        channelInstanceId: channel.name,
        capabilities: [...descriptor.capabilities],
      });
      const publishOutbound =
        options.publishOutbound ??
        (async (job: ChannelOutboundJob) => {
          await publishChannelOutboundJobDurably(job);
        });
      const unregisterOutputSink = context.host.registerOutputSink(
        {
          channelKind: descriptor.provider,
          connectionId: native.accountId,
        },
        {
          async emit(envelope) {
            const target = decodeSlackBackendConversationId(envelope.target.conversationId);
            await publishOutbound(
              buildChannelTextOutboundJob({
                requestId: `channel-output:${envelope.outputId}`,
                sessionName: envelope.binding.sessionId,
                emitId: envelope.outputId,
                idempotencyKey: envelope.outputId,
                target: {
                  channel: descriptor.provider,
                  accountId: native.accountId,
                  instanceId: native.instanceId,
                  chatId: target.channelId,
                  ...(target.threadTs ? { threadId: target.threadTs } : {}),
                },
                text: renderSlackBackendOutput(envelope),
                responsePhase: "final_answer",
                ...(options.now ? { now: options.now() } : {}),
              }),
            );
          },
        },
      );
      const unregisterRuntimeEventSink = context.host.registerRuntimeEventSink(
        {
          channelKind: descriptor.provider,
          connectionId: native.accountId,
        },
        {
          async emit(event, externalTarget) {
            if (event.kind !== "turn.assistant_message" || event.payload.phase !== "commentary") return;
            const target = decodeSlackBackendConversationId(externalTarget.conversationId);
            await publishOutbound(
              buildChannelTextOutboundJob({
                requestId: `channel-runtime:${event.eventId}`,
                sessionName: event.correlation.binding.sessionId,
                emitId: event.eventId,
                idempotencyKey: event.eventId,
                target: {
                  channel: descriptor.provider,
                  accountId: native.accountId,
                  instanceId: native.instanceId,
                  chatId: target.channelId,
                  ...(target.threadTs ? { threadId: target.threadTs } : {}),
                },
                text: renderSlackContent(event.payload.content),
                responsePhase: "commentary",
                ...(options.now ? { now: options.now() } : {}),
              }),
            );
          },
        },
      );
      let disposed = false;
      const disposeBackendSinks = () => {
        if (disposed) return;
        disposed = true;
        unregisterRuntimeEventSink();
        unregisterOutputSink();
      };
      return {
        descriptor: runtimeDescriptor,
        delivery: native.delivery,
        actions: native.actions,
        presence: native.presence,
        start: () => native.socketMode.start(),
        async stop() {
          disposeBackendSinks();
          await native.socketMode.stop();
        },
        health: () => slackNativeRuntimeHealth(native.socketMode.status()),
      };
    },
  };
}

function renderSlackBackendOutput(envelope: ChannelOutputEnvelope): string {
  if (envelope.kind === "safe_error") {
    return `Unable to complete the request (${envelope.error?.code ?? "INTERNAL"}).`;
  }
  return renderSlackContent(envelope.content ?? []);
}

function renderSlackContent(content: NonNullable<ChannelOutputEnvelope["content"]>): string {
  return content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.name
          ? `[Attachment: ${block.name}]`
          : `[Attachment: ${block.artifactId}]`,
    )
    .join("\n");
}

export function slackNativeRuntimeHealth(status: SlackSocketModeStatus): NativeChannelRuntimeHealth {
  return {
    status:
      status.state === "stopped"
        ? "disconnected"
        : status.state === "connecting"
          ? "starting"
          : status.state === "reconnecting"
            ? "reconnecting"
            : "connected",
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.connectedAt !== undefined ? { connectedAt: status.connectedAt } : {}),
    ...(status.lastPongAt !== undefined ? { lastPongAt: status.lastPongAt } : {}),
    reconnectCount: status.reconnectCount,
  };
}

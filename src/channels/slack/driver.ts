import { dbGetChannelBackendRuntimeState, type ChannelConfig } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import type { ChannelOutputEnvelope, ChannelSafeError } from "../backend.js";
import {
  ChannelOutboundPublishHandoffError,
  channelOutboundPublishRequestFingerprint,
  publishChannelOutboundJobDurably,
  type ChannelOutboundPublishResult,
} from "../outbound-publish-outbox.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
  ChannelOutputEmissionContextSchema,
  ChannelOutputHandoffConfirmationSchema,
  ChannelOutputHandoffError,
  createChannelOutputHandoffIdentity,
} from "../output-handoff.js";
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
import { createChannelBackendAutomaticOutputOrigin } from "./automatic-output-origin.js";

export interface SlackNativeChannelDriverOptions {
  readonly createRuntime?: (
    env: NodeJS.ProcessEnv,
    options: { channel: ChannelConfig },
  ) => Promise<SlackNativeRuntime | null>;
  readonly publishOutbound?: (job: ChannelOutboundJob) => Promise<ChannelOutboundPublishResult | undefined>;
  readonly resolveCanonicalMessageId?: (envelope: ChannelOutputEnvelope) => string | undefined;
  readonly now?: () => number;
}

const log = logger.child("channels:slack:driver");

/**
 * Builds the Slack driver contract without starting a connection. Runtime
 * creation resolves credentials and installs host sinks; outbound jobs use
 * the durable publisher unless the caller supplies a replacement.
 */
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
    /**
     * Resolves a native runtime for the configured channel and registers its
     * terminal-output and commentary sinks. A missing runtime is a credentials
     * contract error. The returned start/stop methods own the socket lifecycle;
     * stop unregisters both sinks before awaiting socket shutdown.
     */
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
        options.publishOutbound ?? ((job: ChannelOutboundJob) => publishChannelOutboundJobDurably(job));
      const resolveCanonicalMessageId = options.resolveCanonicalMessageId ?? resolveRuntimeCanonicalMessageId;
      const publishOutboundObserved = async (
        job: ChannelOutboundJob,
      ): Promise<ChannelOutboundPublishResult | undefined> => {
        const result = await publishOutbound(job);
        if (!result) return undefined;
        if (result.ok) return result;
        log.warn("Slack outbound publish deferred; durable retry remains pending", {
          jobId: result.record.jobId,
          attemptCount: result.record.attemptCount,
          nextAttemptAt: result.nextAttemptAt,
          error: result.error,
        });
        return result;
      };
      const unregisterOutputSink = context.host.registerOutputSink(
        {
          channelKind: descriptor.provider,
          connectionId: native.accountId,
        },
        {
          handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
          /**
           * Publishes final text or a safe error with binding-derived automatic
           * provenance and a stable output-id key. Assistant output requires
           * a canonical message id or fails before publication. Resolution is
           * a publication handoff, not a Slack delivery receipt. The concrete
           * request is fingerprinted once and any restriction is checked before
           * save. Only a validated outbox result supplies durable confirmation;
           * an override returning void remains unclassified.
           */
          async emit(envelope, emissionContext) {
            const identity = createChannelOutputHandoffIdentity(envelope);
            const restriction =
              emissionContext === undefined ? undefined : ChannelOutputEmissionContextSchema.parse(emissionContext);
            const target = decodeSlackBackendConversationId(envelope.target.conversationId);
            const canonicalMessageId =
              envelope.kind === "assistant_message" ? resolveCanonicalMessageId(envelope) : undefined;
            if (envelope.kind === "assistant_message" && !canonicalMessageId) {
              throw new NativeChannelDriverContractError("runtime_surface_mismatch");
            }
            const job = buildChannelTextOutboundJob({
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
                canonicalChatId: envelope.binding.chatId,
              },
              text: renderSlackBackendOutput(envelope),
              format: "markdown",
              responsePhase: envelope.kind === "assistant_message" ? "final_answer" : "safe_error",
              automatic: createChannelBackendAutomaticOutputOrigin(envelope.binding),
              ...(canonicalMessageId ? { canonicalMessageId } : {}),
              ...(options.now ? { now: options.now() } : {}),
            });
            const requestFingerprint = channelOutboundPublishRequestFingerprint(job);
            const prepared = {
              capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
              schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
              identity,
              idempotencyKey: job.request.idempotencyKey,
              requestFingerprint,
            };
            if (
              restriction?.expectedRequestFingerprint !== undefined &&
              restriction.expectedRequestFingerprint !== requestFingerprint
            ) {
              throw new ChannelOutputHandoffError({
                ...prepared,
                disposition: "conflict",
                operationFinished: true,
                code: "REQUEST_FINGERPRINT_CONFLICT",
              });
            }
            let result: ChannelOutboundPublishResult | undefined;
            try {
              result = await publishOutboundObserved(job);
            } catch (error) {
              if (
                error instanceof ChannelOutboundPublishHandoffError &&
                error.evidence.idempotencyKey === prepared.idempotencyKey &&
                error.evidence.requestFingerprint === requestFingerprint
              ) {
                // Only the outbox knows whether its synchronous save finished
                // with verified absence. Generic exceptions cannot assert that.
                throw new ChannelOutputHandoffError({
                  ...prepared,
                  ...error.evidence,
                });
              }
              throw error;
            }
            if (result === undefined) return;
            const record = result.record;
            const validDisposition =
              result.disposition === "published"
                ? result.ok === true && record.status === "published"
                : result.disposition === "suppressed"
                  ? result.ok === true && record.status === "suppressed"
                  : result.disposition === "deferred" && result.ok === false && record.status === "pending";
            if (
              !validDisposition ||
              record.idempotencyKey !== prepared.idempotencyKey ||
              record.requestFingerprint !== requestFingerprint ||
              record.sessionName !== job.request.origin.sessionName ||
              record.channelId !== job.request.channelId ||
              (record.status !== "suppressed" &&
                channelOutboundPublishRequestFingerprint(record.job) !== requestFingerprint)
            ) {
              throw new ChannelOutputHandoffError({
                ...prepared,
                disposition: "unknown",
                operationFinished: true,
                code: "INVALID_CONFIRMATION",
              });
            }
            return ChannelOutputHandoffConfirmationSchema.parse({
              ...prepared,
              durableSaveConfirmed: true,
              disposition: record.supersededBy ? "suppressed" : result.disposition,
            });
          },
        },
      );
      const unregisterRuntimeEventSink = context.host.registerRuntimeEventSink(
        {
          channelKind: descriptor.provider,
          connectionId: native.accountId,
        },
        {
          /**
           * Projects commentary only, using the event id for publication
           * identity and the binding for automatic-output policy. Commentary
           * requires an external target; other runtime events are ignored.
           * Publication completion does not establish provider delivery.
           */
          async emit(event, externalTarget) {
            if (event.kind !== "turn.assistant_message" || event.payload.phase !== "commentary") return;
            if (!externalTarget) {
              throw new NativeChannelDriverContractError("runtime_surface_mismatch");
            }
            const target = decodeSlackBackendConversationId(externalTarget.conversationId);
            await publishOutboundObserved(
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
                  canonicalChatId: event.correlation.binding.chatId,
                },
                text: renderSlackContent(event.payload.content),
                format: "markdown",
                responsePhase: "commentary",
                automatic: createChannelBackendAutomaticOutputOrigin(event.correlation.binding),
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

function resolveRuntimeCanonicalMessageId(envelope: ChannelOutputEnvelope): string | undefined {
  return dbGetChannelBackendRuntimeState(envelope.binding.turnId)?.assistantMessageId;
}

export function renderSlackBackendOutput(envelope: ChannelOutputEnvelope): string {
  if (envelope.kind === "safe_error") {
    return renderSlackSafeError(envelope.error);
  }
  return renderSlackContent(envelope.content ?? []);
}

const SLACK_SAFE_ERROR_MESSAGES: Partial<Record<ChannelSafeError["code"], string>> = {
  RATE_LIMITED: "The agent's model provider is rate limiting requests right now. Please try again in a few minutes.",
  OVERLOADED: "The agent's model provider is overloaded right now. Please try again shortly.",
  PERMISSION_DENIED: "The agent is not allowed to do that.",
  LOCAL_PERMISSION_DENIED: "The agent is not allowed to do that.",
  NOT_FOUND: "The agent could not find what this request refers to.",
  INVALID_REQUEST: "The agent could not process this request.",
};

const SLACK_UNAVAILABLE_RETRYABLE_MESSAGE = "The agent is temporarily unavailable. Please try again later.";
const SLACK_UNAVAILABLE_MESSAGE =
  "The agent is unavailable because of a problem with its model provider account. Please contact the operator.";
const SLACK_INTERNAL_ERROR_MESSAGE = "The agent could not complete this request because of an internal error.";

export function renderSlackSafeError(error: ChannelSafeError | undefined): string {
  if (error?.code === "UNAVAILABLE") {
    return error.retryable ? SLACK_UNAVAILABLE_RETRYABLE_MESSAGE : SLACK_UNAVAILABLE_MESSAGE;
  }
  const message = (error && SLACK_SAFE_ERROR_MESSAGES[error.code]) ?? SLACK_INTERNAL_ERROR_MESSAGE;
  const retryHint = error?.code === "INTERNAL" && error.retryable ? " Please try again." : "";
  return `${message}${retryHint}`;
}

/** The reply as Markdown; Slack delivery renders it as Block Kit. */
export function renderSlackContent(content: NonNullable<ChannelOutputEnvelope["content"]>): string {
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

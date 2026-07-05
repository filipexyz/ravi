import { StringCodec } from "nats";
import { nats, getNats } from "../nats.js";
import { getAgentPlatformIdentity } from "../contacts.js";
import { getSessionByName } from "../router/index.js";
import { dbGetSessionChatBinding, dbSaveMessageMeta, dbUpsertChatMessage } from "../router/router-db.js";
import { recordDeliveryTrace } from "../session-trace/channel-trace.js";
import { logger } from "../utils/logger.js";
import type { NativeTextDelivery, NativeTextDeliveryResult } from "./native/types.js";
import {
  CHANNEL_OUTBOUND_CONSUMER,
  CHANNEL_OUTBOUND_STREAM,
  ensureChannelOutboundInfrastructure,
  type ChannelOutboundJob,
} from "./outbound-stream.js";
import { subjectForChannelPresence } from "./presence-consumer.js";

const log = logger.child("channels:outbound-consumer");
const sc = StringCodec();
const CONSUMER_RETRY_DELAY_MS = 2_000;

export type ChannelOutboundJobDisposition = "ack" | "nak";

export interface ChannelOutboundProcessingResult {
  disposition: ChannelOutboundJobDisposition;
  status: "delivered" | "failed" | "dropped";
  retryable: boolean;
  error?: string;
}

export interface ChannelOutboundConsumerOptions {
  deliveries: NativeTextDelivery[];
  emitEvent?: typeof nats.emit;
  isRunning?: () => boolean;
  persistDelivery?: boolean;
}

export class ChannelOutboundConsumer {
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: ChannelOutboundConsumerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise?.catch((error) => {
      log.debug("Channel outbound consumer stopped after loop error", { error });
    });
    this.loopPromise = null;
  }

  isConsuming(): boolean {
    return this.running;
  }

  private shouldContinue(): boolean {
    return this.running && (this.options.isRunning?.() ?? true);
  }

  private async runLoop(): Promise<void> {
    const js = getNats().jetstream();

    while (this.shouldContinue()) {
      try {
        await ensureChannelOutboundInfrastructure();
        const consumer = await js.consumers.get(CHANNEL_OUTBOUND_STREAM, CHANNEL_OUTBOUND_CONSUMER);
        const messages = await consumer.consume({
          expires: 2_000,
          abort_on_missing_resource: true,
        });

        for await (const msg of messages) {
          if (!this.shouldContinue()) {
            msg.nak();
            break;
          }

          let job: ChannelOutboundJob;
          try {
            job = JSON.parse(sc.decode(msg.data)) as ChannelOutboundJob;
          } catch (error) {
            log.error("Failed to parse channel outbound job", { subject: msg.subject, error });
            msg.ack();
            continue;
          }

          const result = await processChannelOutboundJob(job, this.options);
          if (result.disposition === "ack") msg.ack();
          else msg.nak();
        }
      } catch (error) {
        if (!this.shouldContinue()) break;
        log.warn("Channel outbound consume loop failed; retrying", { error });
        await delay(CONSUMER_RETRY_DELAY_MS);
      }
    }
  }
}

export async function processChannelOutboundJob(
  job: ChannelOutboundJob,
  options: ChannelOutboundConsumerOptions,
): Promise<ChannelOutboundProcessingResult> {
  const t0 = Date.now();
  const emitEvent = options.emitEvent ?? nats.emit;
  const sessionName = job.request.origin.sessionName;
  const emitId = job.request.origin.emitId;
  const target = job.request.target;
  const text = job.request.content.text;
  const adapter = options.deliveries.find((candidate) => candidate.supports(target));

  if (!adapter) {
    const error = `No native delivery adapter registered for channel: ${job.request.channelId}`;
    await emitDelivery(emitEvent, job, {
      status: "failed",
      reason: "missing_adapter",
      error,
      target,
      emitId,
      textLen: text.length,
      durationMs: Date.now() - t0,
    });
    return { disposition: "ack", status: "failed", retryable: false, error };
  }

  if (job.request.content.type !== "text") {
    const error = `Unsupported outbound content type: ${job.request.content.type}`;
    await emitDelivery(emitEvent, job, {
      status: "failed",
      reason: "unsupported_content",
      error,
      target,
      emitId,
      textLen: text.length,
      durationMs: Date.now() - t0,
    });
    return { disposition: "ack", status: "failed", retryable: false, error };
  }

  try {
    const delivered = await adapter.deliverText({
      sessionName,
      emitId,
      target,
      text,
    });
    if (options.persistDelivery !== false) {
      persistDeliveredMessage(job, delivered, text);
    }
    await emitImmediatePresenceRenewal(emitEvent, job, delivered);
    await emitDelivery(emitEvent, job, {
      status: "delivered",
      provider: delivered.provider,
      emitId,
      messageId: delivered.messageId ?? delivered.platformMessageId,
      platformMessageId: delivered.platformMessageId,
      target,
      deliveredAt: Date.now(),
      durationMs: Date.now() - t0,
      textLen: text.length,
    });
    return { disposition: "ack", status: "delivered", retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitDelivery(emitEvent, job, {
      status: "failed",
      reason: "send_error",
      error: message,
      target,
      emitId,
      textLen: text.length,
      durationMs: Date.now() - t0,
    });
    return { disposition: "nak", status: "failed", retryable: true, error: message };
  }
}

async function emitImmediatePresenceRenewal(
  emitEvent: typeof nats.emit,
  job: ChannelOutboundJob,
  delivered: NativeTextDeliveryResult,
): Promise<void> {
  const statusAnchorMessageId = delivered.platformMessageId ?? delivered.messageId;
  if (!statusAnchorMessageId) return;

  const target = {
    ...job.request.target,
    statusAnchorKind: "last_outbound_message" as const,
    statusAnchorMessageId,
  };

  await emitEvent(subjectForChannelPresence(job.request.channelId), {
    channelId: job.request.channelId,
    sessionName: job.request.origin.sessionName,
    target,
    active: true,
    reason: "native-delivery-renew",
    timestamp: Date.now(),
  });
}

function persistDeliveredMessage(job: ChannelOutboundJob, delivered: NativeTextDeliveryResult, text: string): void {
  const messageId = delivered.messageId ?? delivered.platformMessageId;
  if (!messageId) return;

  const target = job.request.target;
  const sessionName = job.request.origin.sessionName;
  const instanceId = target.instanceId ?? job.request.instanceId ?? target.accountId;

  try {
    const session = getSessionByName(sessionName);
    const agentId = session?.agentId;
    const binding = session?.sessionKey ? dbGetSessionChatBinding(session.sessionKey) : null;
    const canonicalChatId = target.canonicalChatId ?? binding?.chatId;
    const agentIdentity = agentId
      ? getAgentPlatformIdentity({
          agentId,
          channel: target.channel,
          instanceId,
        })
      : null;

    dbSaveMessageMeta(messageId, target.chatId, {
      canonicalChatId,
      actorType: "agent",
      agentId,
      platformIdentityId: agentIdentity?.id,
      rawSenderId: agentIdentity?.platformUserId,
      normalizedSenderId: agentIdentity?.normalizedPlatformUserId,
      identityConfidence: agentIdentity?.confidence,
      identityProvenance: {
        source: "ravi.channels.runner",
        sessionName,
        agentId: agentId ?? null,
        accountId: target.accountId,
        instanceId,
        channel: target.channel,
        providerMessageId: messageId,
      },
    });

    if (canonicalChatId && agentId) {
      dbUpsertChatMessage({
        chatId: canonicalChatId,
        channel: target.channel,
        instanceId,
        providerMessageId: messageId,
        rawChatId: target.chatId,
        rawSenderId: agentIdentity?.platformUserId,
        normalizedSenderId: agentIdentity?.normalizedPlatformUserId,
        actorType: "agent",
        agentId,
        platformIdentityId: agentIdentity?.id,
        messageType: "text",
        content: { type: "text", text },
        rawProvenance: {
          source: "ravi.channels.runner",
          sessionName,
          agentId,
          accountId: target.accountId,
          instanceId,
          channel: target.channel,
          providerMessageId: messageId,
          jobId: job.jobId,
        },
        providerTimestamp: Date.now(),
      });
    }
  } catch (error) {
    log.warn("Failed to persist native outbound message metadata", {
      sessionName,
      messageId,
      channel: target.channel,
      error,
    });
  }
}

async function emitDelivery(
  emitEvent: typeof nats.emit,
  job: ChannelOutboundJob,
  delivery: Record<string, unknown>,
): Promise<void> {
  const sessionName = job.request.origin.sessionName;
  const payload = {
    jobId: job.jobId,
    channelRunnerPid: process.pid,
    timestamp: Date.now(),
    ...delivery,
  };

  try {
    recordDeliveryTrace({
      sessionName,
      delivery: payload,
    });
  } catch (error) {
    log.debug("Failed to record native channel delivery trace", { sessionName, error });
  }

  await emitEvent(`ravi.session.${sessionName}.delivery`, payload);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

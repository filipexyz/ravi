import { createHash, randomUUID } from "node:crypto";
import { StringCodec } from "nats";
import { flushNats as flushNatsConnection, nats, getNats } from "../nats.js";
import { getAgentPlatformIdentity } from "../contacts.js";
import { getSessionByName } from "../router/index.js";
import {
  dbGetSessionChatBinding,
  dbSaveMessageMeta,
  dbUpsertChatMessage,
  type UpsertChatMessageResult,
} from "../router/router-db.js";
import { recordDeliveryTrace } from "../session-trace/channel-trace.js";
import { logger } from "../utils/logger.js";
import type { NativeTextDelivery, NativeTextDeliveryResult } from "./native/types.js";
import {
  type ChannelOutboundReceipt,
  type ChannelOutboundReceiptErrorPhase,
  type ChannelOutboundReceiptStore,
  sqliteChannelOutboundReceiptStore,
} from "./outbound-receipts.js";
import {
  CHANNEL_OUTBOUND_CONSUMER,
  CHANNEL_OUTBOUND_STREAM,
  ensureChannelOutboundInfrastructure,
  type ChannelOutboundJob,
} from "./outbound-stream.js";

const log = logger.child("channels:outbound-consumer");
const sc = StringCodec();
const CONSUMER_RETRY_DELAY_MS = 2_000;

export type ChannelOutboundJobDisposition = "ack" | "nak";

export interface ChannelOutboundProcessingResult {
  disposition: ChannelOutboundJobDisposition;
  status: "delivered" | "failed" | "dropped";
  retryable: boolean;
  error?: string;
  phase?: ChannelOutboundReceiptErrorPhase | "send";
}

export interface PersistedOutboundMessage {
  canonicalMessageId?: string;
  platformMessageId?: string;
  providerTimestamp?: number;
}

export type PersistDeliveredMessage = (
  job: ChannelOutboundJob,
  delivered: NativeTextDeliveryResult,
  text: string,
) => PersistedOutboundMessage;

export interface ChannelOutboundConsumerOptions {
  deliveries: NativeTextDelivery[];
  emitEvent?: typeof nats.emit;
  flushNats?: typeof flushNatsConnection;
  isRunning?: () => boolean;
  persistDelivery?: boolean;
  receiptStore?: ChannelOutboundReceiptStore;
  persistDeliveredMessage?: PersistDeliveredMessage;
  recordDeliveryTrace?: typeof recordDeliveryTrace;
  claimLeaseMs?: number;
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
  const flushTelemetry = options.flushNats ?? flushNatsConnection;
  const recordTrace = options.recordDeliveryTrace ?? recordDeliveryTrace;
  const sessionName = job.request.origin.sessionName;
  const emitId = job.request.origin.emitId;
  const target = job.request.target;
  const text = job.request.content.text;

  if (job.request.content.type !== "text") {
    const error = `Unsupported outbound content type: ${job.request.content.type}`;
    await emitDelivery(emitEvent, recordTrace, job, {
      status: "failed",
      reason: "unsupported_content",
      error,
      target,
      emitId,
      idempotencyKey: job.request.idempotencyKey,
      textLen: text.length,
      durationMs: Date.now() - t0,
    });
    return { disposition: "ack", status: "failed", retryable: false, error };
  }

  const adapter = options.deliveries.find((candidate) => candidate.supports(target));
  if (options.persistDelivery === false) {
    if (!adapter) return emitMissingAdapter(emitEvent, recordTrace, job, t0);
    return processWithoutReceiptLedger(job, adapter, emitEvent, recordTrace, t0);
  }

  const receiptStore = options.receiptStore ?? sqliteChannelOutboundReceiptStore;
  const persistMessage = options.persistDeliveredMessage ?? persistDeliveredMessage;
  const requestFingerprint = channelOutboundRequestFingerprint(job);
  let receipt: ChannelOutboundReceipt | null;

  try {
    receipt = receiptStore.get(job.request.idempotencyKey);
  } catch (error) {
    const message = errorMessage(error);
    log.warn("Failed to read native outbound receipt; provider send deferred", {
      jobId: job.jobId,
      phase: "receipt_read",
      error: message,
    });
    return {
      disposition: "nak",
      status: "failed",
      retryable: true,
      error: message,
      phase: "receipt_read",
    };
  }

  if (receipt && receipt.requestFingerprint !== requestFingerprint) {
    return emitFingerprintConflict(emitEvent, recordTrace, job, receipt, t0);
  }

  if (receipt?.state === "complete") {
    return { disposition: "ack", status: "delivered", retryable: false };
  }

  let claimOwner: string | undefined;
  if (!receipt || receipt.state === "claimed") {
    if (!adapter) {
      if (!receipt) return emitMissingAdapter(emitEvent, recordTrace, job, t0);
      return {
        disposition: "nak",
        status: "failed",
        retryable: true,
        error: `No native delivery adapter registered for claimed channel: ${job.request.channelId}`,
        phase: "receipt_claim",
      };
    }

    claimOwner = `${process.pid}:${randomUUID()}`;
    let claim;
    try {
      claim = receiptStore.claim({
        idempotencyKey: job.request.idempotencyKey,
        requestFingerprint,
        owner: claimOwner,
        jobId: job.jobId,
        requestId: job.request.requestId,
        sessionName,
        provider: adapter.channelId,
        ...(options.claimLeaseMs !== undefined ? { leaseMs: options.claimLeaseMs } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      log.warn("Failed to claim native outbound delivery; provider send deferred", {
        jobId: job.jobId,
        phase: "receipt_claim",
        error: message,
      });
      return {
        disposition: "nak",
        status: "failed",
        retryable: true,
        error: message,
        phase: "receipt_claim",
      };
    }

    receipt = claim.receipt;
    if (claim.status === "conflict") {
      return emitFingerprintConflict(emitEvent, recordTrace, job, receipt, t0);
    }
    if (claim.status === "busy") {
      return {
        disposition: "nak",
        status: "failed",
        retryable: true,
        error: "Outbound delivery is already claimed by another runner",
        phase: "receipt_claim",
      };
    }
    if (claim.status === "existing") {
      claimOwner = undefined;
      if (receipt.state === "complete") {
        return { disposition: "ack", status: "delivered", retryable: false };
      }
    }
  }

  if (receipt.state === "claimed") {
    if (!adapter || !claimOwner) {
      return {
        disposition: "nak",
        status: "failed",
        retryable: true,
        error: "Outbound delivery claim is not owned by this runner",
        phase: "receipt_claim",
      };
    }

    let delivered: NativeTextDeliveryResult;
    try {
      delivered = await adapter.deliverText({
        sessionName,
        emitId,
        idempotencyKey: job.request.idempotencyKey,
        target,
        text,
      });
    } catch (error) {
      const message = errorMessage(error);
      try {
        receiptStore.releaseClaim({
          idempotencyKey: job.request.idempotencyKey,
          requestFingerprint,
          owner: claimOwner,
          error: message,
        });
      } catch (releaseError) {
        log.warn("Failed to release native outbound claim after send error", {
          jobId: job.jobId,
          error: errorMessage(releaseError),
        });
      }
      try {
        await emitDelivery(emitEvent, recordTrace, job, {
          status: "failed",
          reason: "send_error",
          error: message,
          target,
          emitId,
          idempotencyKey: job.request.idempotencyKey,
          textLen: text.length,
          durationMs: Date.now() - t0,
        });
      } catch (telemetryError) {
        log.warn("Failed to emit native channel send failure", {
          jobId: job.jobId,
          error: errorMessage(telemetryError),
        });
      }
      return { disposition: "nak", status: "failed", retryable: true, error: message, phase: "send" };
    }

    try {
      const sentAt = Date.now();
      receipt = receiptStore.recordSent({
        idempotencyKey: job.request.idempotencyKey,
        requestFingerprint,
        owner: claimOwner,
        provider: delivered.provider,
        ...(delivered.messageId ? { deliveryMessageId: delivered.messageId } : {}),
        ...(delivered.platformMessageId ? { platformMessageId: delivered.platformMessageId } : {}),
        ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
        sentAt,
      });
    } catch (error) {
      return postSendPhaseFailure(job, receipt, receiptStore, "receipt_write", error);
    }
  }

  if (receipt.persistedAt === undefined) {
    try {
      const persisted = persistMessage(job, deliveryResultFromReceipt(receipt), text);
      receipt = receiptStore.markPersisted(job.request.idempotencyKey, persisted);
    } catch (error) {
      return postSendPhaseFailure(job, receipt, receiptStore, "canonical_persist", error);
    }
  }

  const payload = deliveredPayload(job, receipt, t0);
  if (receipt.traceRecordedAt === undefined) {
    try {
      recordTrace({ sessionName, delivery: payload, timestamp: payload.timestamp as number });
      receipt = receiptStore.markTraceRecorded(job.request.idempotencyKey);
    } catch (error) {
      return postSendPhaseFailure(job, receipt, receiptStore, "trace_record", error);
    }
  }

  try {
    await emitEvent(`ravi.session.${sessionName}.delivery`, payload);
    await flushTelemetry();
  } catch (error) {
    return postSendPhaseFailure(job, receipt, receiptStore, "telemetry_emit", error);
  }

  try {
    receiptStore.markComplete(job.request.idempotencyKey);
  } catch (error) {
    return postSendPhaseFailure(job, receipt, receiptStore, "receipt_complete", error);
  }

  return { disposition: "ack", status: "delivered", retryable: false };
}

async function processWithoutReceiptLedger(
  job: ChannelOutboundJob,
  adapter: NativeTextDelivery,
  emitEvent: typeof nats.emit,
  recordTrace: typeof recordDeliveryTrace,
  t0: number,
): Promise<ChannelOutboundProcessingResult> {
  const sessionName = job.request.origin.sessionName;
  const emitId = job.request.origin.emitId;
  const target = job.request.target;
  const text = job.request.content.text;
  let delivered: NativeTextDeliveryResult;

  try {
    delivered = await adapter.deliverText({
      sessionName,
      emitId,
      idempotencyKey: job.request.idempotencyKey,
      target,
      text,
    });
  } catch (error) {
    const message = errorMessage(error);
    await emitDelivery(emitEvent, recordTrace, job, {
      status: "failed",
      reason: "send_error",
      error: message,
      target,
      emitId,
      idempotencyKey: job.request.idempotencyKey,
      textLen: text.length,
      durationMs: Date.now() - t0,
    });
    return { disposition: "nak", status: "failed", retryable: true, error: message, phase: "send" };
  }

  try {
    await emitDelivery(emitEvent, recordTrace, job, {
      status: "delivered",
      provider: delivered.provider,
      emitId,
      messageId: delivered.messageId ?? delivered.platformMessageId,
      providerMessageId: delivered.platformMessageId,
      platformMessageId: delivered.platformMessageId,
      providerTimestamp: delivered.providerTimestamp,
      idempotencyKey: job.request.idempotencyKey,
      target,
      deliveredAt: Date.now(),
      durationMs: Date.now() - t0,
      textLen: text.length,
    });
    return { disposition: "ack", status: "delivered", retryable: false };
  } catch (error) {
    return {
      disposition: "nak",
      status: "delivered",
      retryable: true,
      error: errorMessage(error),
      phase: "telemetry_emit",
    };
  }
}

export interface PersistDeliveredMessageDependencies {
  resolveContext(input: { job: ChannelOutboundJob; instanceId: string }): {
    agentId?: string;
    canonicalChatId?: string;
    agentIdentity?: {
      id: string;
      platformUserId: string;
      normalizedPlatformUserId: string;
      confidence: number;
    } | null;
  };
  saveMessageMeta: typeof dbSaveMessageMeta;
  upsertChatMessage(input: Parameters<typeof dbUpsertChatMessage>[0]): UpsertChatMessageResult;
}

const DEFAULT_PERSISTENCE_DEPENDENCIES: PersistDeliveredMessageDependencies = {
  resolveContext: ({ job, instanceId }) => {
    const session = getSessionByName(job.request.origin.sessionName);
    const agentId = session?.agentId;
    const binding = session?.sessionKey ? dbGetSessionChatBinding(session.sessionKey) : null;
    const canonicalChatId = job.request.target.canonicalChatId ?? binding?.chatId;
    const agentIdentity = agentId
      ? getAgentPlatformIdentity({
          agentId,
          channel: job.request.target.channel,
          instanceId,
        })
      : null;
    return {
      ...(agentId ? { agentId } : {}),
      ...(canonicalChatId ? { canonicalChatId } : {}),
      agentIdentity,
    };
  },
  saveMessageMeta: dbSaveMessageMeta,
  upsertChatMessage: dbUpsertChatMessage,
};

export function persistDeliveredMessage(
  job: ChannelOutboundJob,
  delivered: NativeTextDeliveryResult,
  text: string,
  dependencies: PersistDeliveredMessageDependencies = DEFAULT_PERSISTENCE_DEPENDENCIES,
): PersistedOutboundMessage {
  const platformMessageId = delivered.platformMessageId?.trim();
  if (!platformMessageId) {
    return {
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }

  const target = job.request.target;
  const sessionName = job.request.origin.sessionName;
  const instanceId = target.instanceId ?? job.request.instanceId ?? target.accountId;
  const { agentId, canonicalChatId, agentIdentity } = dependencies.resolveContext({ job, instanceId });

  dependencies.saveMessageMeta(platformMessageId, target.chatId, {
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
      providerMessageId: platformMessageId,
      deliveryMessageId: delivered.messageId ?? null,
      idempotencyKey: job.request.idempotencyKey,
    },
  });

  if (!canonicalChatId || !agentId) {
    return {
      platformMessageId,
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }

  const stored = dependencies.upsertChatMessage({
    chatId: canonicalChatId,
    channel: target.channel,
    instanceId,
    providerMessageId: platformMessageId,
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
      providerMessageId: platformMessageId,
      deliveryMessageId: delivered.messageId ?? null,
      providerTimestamp: delivered.providerTimestamp ?? null,
      idempotencyKey: job.request.idempotencyKey,
      jobId: job.jobId,
    },
    providerTimestamp: delivered.providerTimestamp,
  });

  return {
    canonicalMessageId: stored.canonicalMessageId,
    platformMessageId: stored.providerMessageId,
    ...(stored.providerTimestamp !== undefined ? { providerTimestamp: stored.providerTimestamp } : {}),
  };
}

export function channelOutboundRequestFingerprint(job: ChannelOutboundJob): string {
  const canonicalRequest = JSON.stringify(job.request, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
  if (!canonicalRequest) throw new Error("Outbound request cannot be fingerprinted");
  return createHash("sha256").update(canonicalRequest).digest("hex");
}

async function emitFingerprintConflict(
  emitEvent: typeof nats.emit,
  recordTrace: typeof recordDeliveryTrace,
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt,
  t0: number,
): Promise<ChannelOutboundProcessingResult> {
  const error = `Idempotency key already belongs to a different outbound request: ${job.request.idempotencyKey}`;
  await emitDelivery(emitEvent, recordTrace, job, {
    status: "failed",
    reason: "idempotency_conflict",
    error,
    target: job.request.target,
    emitId: job.request.origin.emitId,
    idempotencyKey: job.request.idempotencyKey,
    conflictingJobId: receipt.jobId,
    textLen: job.request.content.text.length,
    durationMs: Date.now() - t0,
  });
  return {
    disposition: "ack",
    status: "failed",
    retryable: false,
    error,
    phase: "receipt_claim",
  };
}

async function emitMissingAdapter(
  emitEvent: typeof nats.emit,
  recordTrace: typeof recordDeliveryTrace,
  job: ChannelOutboundJob,
  t0: number,
): Promise<ChannelOutboundProcessingResult> {
  const error = `No native delivery adapter registered for channel: ${job.request.channelId}`;
  await emitDelivery(emitEvent, recordTrace, job, {
    status: "failed",
    reason: "missing_adapter",
    error,
    target: job.request.target,
    emitId: job.request.origin.emitId,
    idempotencyKey: job.request.idempotencyKey,
    textLen: job.request.content.text.length,
    durationMs: Date.now() - t0,
  });
  return { disposition: "ack", status: "failed", retryable: false, error };
}

function deliveryResultFromReceipt(receipt: ChannelOutboundReceipt): NativeTextDeliveryResult {
  return {
    provider: receipt.provider,
    ...(receipt.deliveryMessageId ? { messageId: receipt.deliveryMessageId } : {}),
    ...(receipt.platformMessageId ? { platformMessageId: receipt.platformMessageId } : {}),
    ...(receipt.providerTimestamp !== undefined ? { providerTimestamp: receipt.providerTimestamp } : {}),
  };
}

function deliveredPayload(
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt,
  startedAt: number,
): Record<string, unknown> {
  return {
    jobId: job.jobId,
    channelRunnerPid: process.pid,
    timestamp: Date.now(),
    status: "delivered",
    provider: receipt.provider,
    emitId: job.request.origin.emitId,
    messageId: receipt.deliveryMessageId ?? receipt.platformMessageId,
    providerMessageId: receipt.platformMessageId,
    platformMessageId: receipt.platformMessageId,
    canonicalMessageId: receipt.canonicalMessageId,
    providerTimestamp: receipt.providerTimestamp,
    idempotencyKey: receipt.idempotencyKey,
    target: job.request.target,
    deliveredAt: receipt.sentAt,
    durationMs: Date.now() - startedAt,
    textLen: job.request.content.text.length,
  };
}

function postSendPhaseFailure(
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt | null,
  receiptStore: ChannelOutboundReceiptStore,
  phase: ChannelOutboundReceiptErrorPhase,
  error: unknown,
): ChannelOutboundProcessingResult {
  const message = errorMessage(error);
  if (receipt) {
    try {
      receiptStore.recordError(job.request.idempotencyKey, phase, message);
    } catch (recordError) {
      log.warn("Failed to record outbound receipt phase error", {
        jobId: job.jobId,
        phase,
        error: errorMessage(recordError),
      });
    }
  }
  log.warn("Native outbound post-send phase failed; delivery will resume", {
    jobId: job.jobId,
    phase,
    error: message,
  });
  return { disposition: "nak", status: "delivered", retryable: true, error: message, phase };
}

async function emitDelivery(
  emitEvent: typeof nats.emit,
  recordTrace: typeof recordDeliveryTrace,
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
    recordTrace({
      sessionName,
      delivery: payload,
      timestamp: payload.timestamp,
    });
  } catch (error) {
    log.debug("Failed to record native channel delivery trace", { sessionName, error });
  }

  await emitEvent(`ravi.session.${sessionName}.delivery`, payload);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

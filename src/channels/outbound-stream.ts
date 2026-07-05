import { AckPolicy, DeliverPolicy, RetentionPolicy, StringCodec, type JetStreamManager } from "nats";
import { ensureConnected, getNats } from "../nats.js";
import type { MessageTarget, ResponseMessage } from "../runtime/message-types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("channels:outbound-stream");
const sc = StringCodec();

export const CHANNEL_OUTBOUND_STREAM = "CHANNEL_OUTBOUND";
export const CHANNEL_OUTBOUND_SUBJECT_FILTER = "ravi.channel.outbound.*";
export const CHANNEL_OUTBOUND_CONSUMER = "ravi-channel-outbound";

const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_BYTES = 256 * 1024 * 1024;
const PUBLISH_ACK_TIMEOUT_MS = 10_000;
const PUBLISH_RETRY_ATTEMPTS = 3;
const PUBLISH_RETRY_DELAY_MS = 250;

let channelOutboundInfrastructureInFlight: Promise<void> | null = null;

export type ChannelOutboundJobStatus =
  | "queued"
  | "claimed"
  | "rendering"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "cancelled"
  | "dead_lettered";

export interface ChannelOutboundRequest {
  requestId: string;
  channelId: string;
  instanceId?: string;
  accountId: string;
  targetChatId: string;
  targetThreadId?: string;
  origin: {
    sessionName: string;
    emitId: string;
    responseVersion?: number;
    runtimePid?: number;
  };
  content: {
    type: "text";
    text: string;
  };
  idempotencyKey: string;
  policyHints?: Record<string, unknown>;
  target: MessageTarget;
  metadata?: ResponseMessage["metadata"];
}

export interface ChannelOutboundJob {
  jobId: string;
  status: ChannelOutboundJobStatus;
  request: ChannelOutboundRequest;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  terminalError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type BuildChannelOutboundJobResult =
  | { ok: true; job: ChannelOutboundJob }
  | { ok: false; reason: "missing_target" | "missing_emit_id" | "empty_response" | "silent_response" };

export async function ensureChannelOutboundStream(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());

  try {
    await jsm.streams.info(CHANNEL_OUTBOUND_STREAM);
    log.debug("CHANNEL_OUTBOUND stream already exists");
    return;
  } catch {
    // Stream does not exist yet.
  }

  try {
    await jsm.streams.add({
      name: CHANNEL_OUTBOUND_STREAM,
      description: "Durable channel outbound delivery jobs",
      subjects: [CHANNEL_OUTBOUND_SUBJECT_FILTER],
      retention: RetentionPolicy.Workqueue,
      storage: "file" as never,
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      num_replicas: 1,
    });
  } catch (err) {
    await ensureStreamExistsAfterRace(jsm, err);
    return;
  }

  log.info("Created CHANNEL_OUTBOUND JetStream stream", {
    subjects: [CHANNEL_OUTBOUND_SUBJECT_FILTER],
    retention: "workqueue",
    storage: "file",
    max_age_days: 7,
    max_bytes: MAX_BYTES,
  });
}

export async function ensureChannelOutboundConsumer(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());

  try {
    await jsm.consumers.info(CHANNEL_OUTBOUND_STREAM, CHANNEL_OUTBOUND_CONSUMER);
    log.debug("Channel outbound consumer already exists", { consumerName: CHANNEL_OUTBOUND_CONSUMER });
    return;
  } catch {
    // Consumer does not exist yet.
  }

  try {
    await jsm.consumers.add(CHANNEL_OUTBOUND_STREAM, {
      durable_name: CHANNEL_OUTBOUND_CONSUMER,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      ack_wait: 300_000_000_000,
    });
  } catch (err) {
    await ensureConsumerExistsAfterRace(jsm, err);
    return;
  }

  log.info("Created CHANNEL_OUTBOUND JetStream consumer", {
    stream: CHANNEL_OUTBOUND_STREAM,
    consumerName: CHANNEL_OUTBOUND_CONSUMER,
    ack_wait_s: 300,
  });
}

export async function ensureChannelOutboundInfrastructure(existingJsm?: JetStreamManager): Promise<void> {
  if (channelOutboundInfrastructureInFlight) return channelOutboundInfrastructureInFlight;

  channelOutboundInfrastructureInFlight = ensureChannelOutboundInfrastructureOnce(existingJsm).finally(() => {
    channelOutboundInfrastructureInFlight = null;
  });
  return channelOutboundInfrastructureInFlight;
}

async function ensureChannelOutboundInfrastructureOnce(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());
  await ensureChannelOutboundStream(jsm);
  await ensureChannelOutboundConsumer(jsm);
}

export async function publishChannelOutboundJob(job: ChannelOutboundJob): Promise<void> {
  const nc = await ensureConnected();
  await ensureChannelOutboundInfrastructure();
  const js = nc.jetstream();
  const subject = subjectForChannel(job.request.channelId);
  const payload = sc.encode(JSON.stringify(job));
  let lastError: unknown;

  for (let attempt = 1; attempt <= PUBLISH_RETRY_ATTEMPTS; attempt++) {
    try {
      await js.publish(subject, payload, {
        msgID: job.request.idempotencyKey,
        timeout: PUBLISH_ACK_TIMEOUT_MS,
        expect: {
          streamName: CHANNEL_OUTBOUND_STREAM,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isPublishAckTimeout(error) || attempt === PUBLISH_RETRY_ATTEMPTS) break;
      log.warn("CHANNEL_OUTBOUND publish ack timed out; retrying with idempotent msgID", {
        jobId: job.jobId,
        channelId: job.request.channelId,
        attempt,
        maxAttempts: PUBLISH_RETRY_ATTEMPTS,
        error: formatErrorMessage(error),
      });
      await delay(PUBLISH_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

export function buildChannelOutboundJobFromResponse(
  sessionName: string,
  response: ResponseMessage,
  options: { now?: number } = {},
): BuildChannelOutboundJobResult {
  const target = response.target;
  if (!target) return { ok: false, reason: "missing_target" };

  const emitId = response._emitId;
  if (!emitId) return { ok: false, reason: "missing_emit_id" };

  const text = response.error ? `Error: ${response.error}` : response.response;
  if (!text) return { ok: false, reason: "empty_response" };
  if (text.trim() === "@@SILENT@@") return { ok: false, reason: "silent_response" };

  const now = options.now ?? Date.now();
  const requestId = `runtime:${sessionName}:${emitId}`;
  const channelId = target.channel || "unknown";
  const idempotencyKey = `${requestId}:${channelId}:${target.accountId}:${target.chatId}:${target.threadId ?? "root"}`;

  return {
    ok: true,
    job: {
      jobId: requestId,
      status: "queued",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      request: {
        requestId,
        channelId,
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        accountId: target.accountId,
        targetChatId: target.chatId,
        ...(target.threadId ? { targetThreadId: target.threadId } : {}),
        origin: {
          sessionName,
          emitId,
          responseVersion:
            typeof (response as { _v?: unknown })._v === "number" ? (response as { _v: number })._v : undefined,
          runtimePid:
            typeof (response as { _pid?: unknown })._pid === "number" ? (response as { _pid: number })._pid : undefined,
        },
        content: {
          type: "text",
          text,
        },
        idempotencyKey,
        target,
        ...(response.metadata && typeof response.metadata === "object" ? { metadata: response.metadata } : {}),
      },
    },
  };
}

export function subjectForChannel(channelId: string): string {
  return `ravi.channel.outbound.${toNatsToken(channelId)}`;
}

function toNatsToken(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || "unknown";
}

function isPublishAckTimeout(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; name?: unknown } | undefined;
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const name = typeof value?.name === "string" ? value.name.toUpperCase() : "";
  const message = typeof value?.message === "string" ? value.message.toUpperCase() : String(error).toUpperCase();
  return code === "TIMEOUT" || name === "TIMEOUT" || message === "TIMEOUT" || message.includes("TIMEOUT");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStreamExistsAfterRace(jsm: JetStreamManager, originalError: unknown): Promise<void> {
  try {
    await jsm.streams.info(CHANNEL_OUTBOUND_STREAM);
    log.debug("CHANNEL_OUTBOUND stream created concurrently");
  } catch {
    throw originalError;
  }
}

async function ensureConsumerExistsAfterRace(jsm: JetStreamManager, originalError: unknown): Promise<void> {
  try {
    await jsm.consumers.info(CHANNEL_OUTBOUND_STREAM, CHANNEL_OUTBOUND_CONSUMER);
    log.debug("CHANNEL_OUTBOUND consumer created concurrently", { consumerName: CHANNEL_OUTBOUND_CONSUMER });
  } catch {
    throw originalError;
  }
}

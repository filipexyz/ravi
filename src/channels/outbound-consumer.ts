import { createHash, randomUUID } from "node:crypto";
import { StringCodec } from "nats";
import { flushNats as flushNatsConnection, nats, getNats } from "../nats.js";
import { getAgentPlatformIdentity } from "../contacts.js";
import { getSessionByName } from "../router/index.js";
import {
  dbGetChatMessage,
  dbGetSessionDefaultChatId,
  dbMarkChatMessageDeleted,
  dbMarkChatMessageEdited,
  dbSaveMessageMeta,
  dbUpsertChatMessage,
  type ChatMessageRecord,
  type UpsertChatMessageResult,
} from "../router/router-db.js";
import { recordDeliveryTrace } from "../session-trace/channel-trace.js";
import { type GuardedSession, guardedSessionForChat, guardTextForGuardedSession } from "../knowledge/egress/guard.js";
import { logger } from "../utils/logger.js";
import { errorDiagnostic } from "../utils/error-diagnostic.js";
import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import { markSlackThreadRootDelivered } from "./slack/thread-lifecycle-store.js";
import { getChannelOutboundPublishJob, markChannelOutboundPublishJobSuppressed } from "./outbound-publish-outbox.js";
import {
  resolveSlackAutomaticOutputContext,
  SlackAutomaticOutputOriginError,
} from "./slack/automatic-output-origin.js";
import { reserveSlackAutomaticOutput } from "./slack/automatic-output-circuit.js";
import {
  assertSlackAutomaticTerminalPart,
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
  type SlackAutomaticTerminalManifest,
} from "./slack/automatic-terminal-manifest.js";
import type {
  NativeChatActionDelivery,
  NativeChatActionDeliveryResult,
  NativeTextDelivery,
  NativeTextDeliveryResult,
} from "./native/types.js";
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
const SLACK_AUTOMATIC_EGRESS_CONFLICT = "slack_bot_reply_egress_content_conflict";
export const CHANNEL_OUTBOUND_MISSING_ADAPTER_RETRY_BASE_MS = 30_000;
export const CHANNEL_OUTBOUND_MISSING_ADAPTER_RETRY_MAX_MS = 5 * 60_000;

export type ChannelOutboundJobDisposition = "ack" | "nak";
export type ChannelOutboundProcessingPhase = ChannelOutboundReceiptErrorPhase | "adapter_lookup" | "send" | "policy";

export interface ChannelOutboundProcessingResult {
  disposition: ChannelOutboundJobDisposition;
  status: "delivered" | "failed" | "dropped";
  retryable: boolean;
  error?: string;
  phase?: ChannelOutboundProcessingPhase;
  nakDelayMs?: number;
}

export interface PersistedOutboundMessage {
  canonicalMessageId?: string;
  platformMessageId?: string;
  providerTimestamp?: number;
}

type NativeOutboundDelivery = NativeTextDelivery | NativeChatActionDelivery;
type NativeOutboundDeliveryResult = NativeTextDeliveryResult | NativeChatActionDeliveryResult;

export type PersistDeliveredMessage = (
  job: ChannelOutboundJob,
  delivered: NativeTextDeliveryResult,
  text: string,
) => PersistedOutboundMessage;

export type PersistDeliveredChatAction = (
  job: ChannelOutboundJob,
  delivered: NativeChatActionDeliveryResult,
) => PersistedOutboundMessage;

export interface ChannelOutboundConsumerOptions {
  deliveries: NativeTextDelivery[];
  actionDeliveries?: NativeChatActionDelivery[];
  emitEvent?: typeof nats.emit;
  flushNats?: typeof flushNatsConnection;
  isRunning?: () => boolean;
  deliveryAttempt?: number;
  persistDelivery?: boolean;
  receiptStore?: ChannelOutboundReceiptStore;
  persistDeliveredMessage?: PersistDeliveredMessage;
  persistDeliveredChatAction?: PersistDeliveredChatAction;
  recordDeliveryTrace?: typeof recordDeliveryTrace;
  claimLeaseMs?: number;
  now?: () => number;
  /** Knowledge guard row for `(target.channel, target.chatId)`; defaults to the read-only knowledge.db lookup. */
  knowledgeGuard?: (channel: string, chatId: string) => GuardedSession | null;
  /** Rewrites a guarded text; defaults to the live allow list and mirror. */
  guardKnowledgeText?: (text: string, guarded: GuardedSession) => string;
}

export interface ChannelOutboundConsumerRuntimeStatus {
  lastMessageAt?: number;
  lastError?: {
    phase: "consume_loop";
    message: string;
    at: number;
  };
}

export interface AckableChannelOutboundMessage {
  ack(): void;
  nak(delayMs?: number): void;
}

export class ChannelOutboundConsumer {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastMessageAt: number | undefined;
  private lastError: ChannelOutboundConsumerRuntimeStatus["lastError"] | undefined;

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

  status(): ChannelOutboundConsumerRuntimeStatus {
    return {
      ...(this.lastMessageAt !== undefined ? { lastMessageAt: this.lastMessageAt } : {}),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    };
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
        this.lastError = undefined;

        for await (const msg of messages) {
          if (!this.shouldContinue()) {
            msg.nak(CONSUMER_RETRY_DELAY_MS);
            break;
          }
          this.lastMessageAt = Date.now();

          let job: ChannelOutboundJob;
          try {
            job = JSON.parse(sc.decode(msg.data)) as ChannelOutboundJob;
          } catch (error) {
            log.error("Failed to parse channel outbound job", { subject: msg.subject, error });
            msg.ack();
            continue;
          }

          const result = await processChannelOutboundJob(job, {
            ...this.options,
            deliveryAttempt: msg.info.deliveryCount,
          });
          acknowledgeChannelOutboundMessage(msg, result);
        }
      } catch (error) {
        if (!this.shouldContinue()) break;
        this.lastError = {
          phase: "consume_loop",
          message: errorMessage(error),
          at: Date.now(),
        };
        log.warn("Channel outbound consume loop failed; retrying", { error });
        await delay(CONSUMER_RETRY_DELAY_MS);
      }
    }
  }
}

function acknowledgeCompletedReceipt(receipt: ChannelOutboundReceipt): ChannelOutboundProcessingResult {
  // A complete receipt with a send-phase error never reached Slack. Post-send
  // terminal errors (canonical persist) stay "delivered" because the provider
  // already accepted the mutation.
  if (receipt.lastErrorPhase === "send" && receipt.lastErrorMessage) {
    return {
      disposition: "ack",
      status: "failed",
      retryable: false,
      error: receipt.lastErrorMessage,
      phase: "send",
    };
  }
  return { disposition: "ack", status: "delivered", retryable: false };
}

function logNativeOutboundSendFailure(
  job: ChannelOutboundJob,
  failure: ReturnType<typeof classifyNativeOutboundFailure>,
  message: string,
): void {
  const content = job.request.content;
  log.warn("Native outbound send failed", {
    jobId: job.jobId,
    channelId: job.request.channelId,
    chatId: job.request.target.chatId,
    canonicalChatId: job.request.target.canonicalChatId,
    retryable: failure.retryable,
    ...(failure.reasonCode ? { reasonCode: failure.reasonCode } : {}),
    ...(content.type === "chat_action"
      ? {
          actionId: content.actionId,
          ...("providerMessageId" in content ? { providerMessageId: content.providerMessageId } : {}),
          ...("emoji" in content ? { emoji: content.emoji } : {}),
        }
      : { contentType: content.type }),
    error: message,
  });
}

/**
 * Applies the Knowledge egress guard to the text of a job bound for a guarded
 * chat (`text` content, `chat_action` text and a thread card's note). Other
 * jobs are returned as is.
 */
export function guardChannelOutboundJob(
  job: ChannelOutboundJob,
  options: Pick<ChannelOutboundConsumerOptions, "knowledgeGuard" | "guardKnowledgeText"> = {},
): ChannelOutboundJob {
  const content = job.request.content as { type?: unknown; text?: unknown };
  if ((content.type !== "text" && content.type !== "chat_action") || typeof content.text !== "string") return job;
  let guarded: GuardedSession | null = null;
  try {
    guarded = (options.knowledgeGuard ?? guardedSessionForChat)(job.request.target.channel, job.request.target.chatId);
  } catch (error) {
    log.warn("Knowledge guard lookup failed", { jobId: job.jobId, error: errorMessage(error) });
  }
  if (!guarded) return job;
  const guardText = options.guardKnowledgeText ?? ((value, row) => guardTextForGuardedSession(value, row).text);
  const text = guardText(content.text, guarded);
  // A thread root card also shows its note (latest progress or result).
  const threadCard = (content as { threadCard?: { note?: unknown } }).threadCard;
  const note = typeof threadCard?.note === "string" ? guardText(threadCard.note, guarded) : undefined;
  if (text === content.text && note === threadCard?.note) return job;
  return {
    ...job,
    request: {
      ...job.request,
      content: {
        ...job.request.content,
        text,
        ...(threadCard && note !== undefined ? { threadCard: { ...threadCard, note } } : {}),
      } as ChannelOutboundJob["request"]["content"],
    },
  };
}

export function acknowledgeChannelOutboundMessage(
  msg: AckableChannelOutboundMessage,
  result: ChannelOutboundProcessingResult,
): void {
  if (result.disposition === "ack") {
    msg.ack();
    return;
  }
  msg.nak(result.retryable ? (result.nakDelayMs ?? missingAdapterRetryDelayMs(undefined)) : result.nakDelayMs);
}

/**
 * Processes a publication wrapper, using a validated automatic text part's
 * canonical key/fingerprint for its send receipt and provider token. Automatic
 * origins still use the ledger when `persistDelivery` is false; ordinary jobs
 * may explicitly bypass it. On the ledger path only an acquired owner sends;
 * busy leases defer, while sent/persisted receipts resume missing bookkeeping.
 *
 * The last-hop guard runs before delivery. Changed frozen bytes close the part
 * as an integrity failure; an observed send resumes with its original text.
 * Provider acceptance before receipt persistence remains ambiguous and cannot
 * be rolled back or treated as an exactly-once guarantee.
 *
 * `disposition` controls queue ACK/NAK, independently of delivery `status` and
 * `retryable`: a delivered result may need bookkeeping retried, and a terminal
 * integrity failure may NAK with a delay solely to retry its telemetry.
 */
export async function processChannelOutboundJob(
  inputJob: ChannelOutboundJob,
  options: ChannelOutboundConsumerOptions,
): Promise<ChannelOutboundProcessingResult> {
  const t0 = (options.now ?? Date.now)();
  let automatic: PreparedSlackAutomaticText;
  try {
    automatic = prepareSlackAutomaticText(inputJob);
  } catch (error) {
    return outboundProcessingFailure(error, { disposition: "nak", status: "failed", retryable: true, phase: "policy" });
  }
  // Always apply the last-hop guard. Frozen automatic parts additionally
  // require unchanged bytes before sending under their canonical identity.
  let job = guardChannelOutboundJob(inputJob, options);
  const emitEvent = options.emitEvent ?? nats.emit;
  const flushTelemetry = options.flushNats ?? flushNatsConnection;
  const recordTrace = options.recordDeliveryTrace ?? recordDeliveryTrace;
  const sessionName = job.request.origin.sessionName;
  const emitId = job.request.origin.emitId;
  const target = job.request.target;
  const deliveryAttempt = options.deliveryAttempt;

  if (job.request.content.type !== "text" && job.request.content.type !== "chat_action") {
    const contentType = (job.request.content as { type?: unknown }).type;
    const error = `Unsupported outbound content type: ${String(contentType)}`;
    await emitDelivery(emitEvent, recordTrace, job, {
      status: "failed",
      reason: "unsupported_content",
      error,
      target,
      emitId,
      idempotencyKey: job.request.idempotencyKey,
      ...outboundContentTelemetry(job),
      durationMs: Date.now() - t0,
    });
    return { disposition: "ack", status: "failed", retryable: false, error };
  }

  const adapter = findNativeOutboundAdapter(job, options);
  if (options.persistDelivery === false && !job.request.origin.automatic) {
    if (!adapter) return emitMissingAdapter(emitEvent, recordTrace, job, t0, deliveryAttempt);
    return processWithoutReceiptLedger(job, adapter, emitEvent, recordTrace, t0, deliveryAttempt);
  }

  const receiptStore = options.receiptStore ?? sqliteChannelOutboundReceiptStore;
  const persistMessage = options.persistDeliveredMessage ?? persistDeliveredMessage;
  const persistChatAction = options.persistDeliveredChatAction ?? persistDeliveredChatAction;
  const publicationRequestFingerprint = channelOutboundRequestFingerprint(inputJob);
  const receiptKey = automatic.kind === "terminal" ? automatic.partId : job.request.idempotencyKey;
  const requestFingerprint = automatic.kind === "terminal" ? automatic.partFingerprint : publicationRequestFingerprint;
  let receipt: ChannelOutboundReceipt | null;

  try {
    // A missing/invalid-manifest wrapper can have been suppressed before its
    // canonical part existed. Its immutable terminal disposition wins forever.
    if (receiptKey !== job.request.idempotencyKey) {
      const publicationReceipt = receiptStore.get(job.request.idempotencyKey);
      if (publicationReceipt) {
        if (publicationReceipt.requestFingerprint !== publicationRequestFingerprint) {
          return emitFingerprintConflict(emitEvent, recordTrace, job, publicationReceipt, t0);
        }
        if (publicationReceipt.state === "suppressed") {
          return acknowledgeSuppressedReceipt(
            job,
            publicationReceipt,
            emitEvent,
            flushTelemetry,
            recordTrace,
            t0,
            publicationRequestFingerprint,
          );
        }
        if (publicationReceipt.state === "complete") return acknowledgeCompletedReceipt(publicationReceipt);
      }
    }
    receipt = receiptStore.get(receiptKey);
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
    return acknowledgeCompletedReceipt(receipt);
  }
  if (receipt?.state === "suppressed") {
    return acknowledgeSuppressedReceipt(
      job,
      receipt,
      emitEvent,
      flushTelemetry,
      recordTrace,
      t0,
      publicationRequestFingerprint,
    );
  }

  let claimOwner: string | undefined;
  if (!receipt || receipt.state === "claimed") {
    if (!adapter) {
      if (!receipt) return emitMissingAdapter(emitEvent, recordTrace, job, t0, deliveryAttempt);
      const delayMs = missingAdapterRetryDelayMs(deliveryAttempt);
      warnMissingAdapter(job.request.channelId, { jobId: job.jobId, deliveryAttempt, retryDelayMs: delayMs });
      try {
        receiptStore.recordError(
          receiptKey,
          "adapter_lookup",
          `No native delivery adapter registered for claimed channel: ${job.request.channelId}`,
        );
      } catch (error) {
        log.warn("Failed to record missing adapter against native outbound receipt", {
          jobId: job.jobId,
          error: errorMessage(error),
        });
      }
      return {
        disposition: "nak",
        status: "failed",
        retryable: true,
        error: `No native delivery adapter registered for claimed channel: ${job.request.channelId}`,
        phase: "adapter_lookup",
        nakDelayMs: delayMs,
      };
    }

    claimOwner = `${process.pid}:${randomUUID()}`;
    let claim;
    try {
      claim = receiptStore.claim({
        idempotencyKey: receiptKey,
        requestFingerprint,
        owner: claimOwner,
        jobId: job.jobId,
        requestId: job.request.requestId,
        sessionName,
        provider: adapter.channelId,
        now: (options.now ?? Date.now)(),
        ...(automatic.kind === "terminal" ? { retainIdentity: true } : {}),
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
        return acknowledgeCompletedReceipt(receipt);
      }
      if (receipt.state === "suppressed") {
        return acknowledgeSuppressedReceipt(
          job,
          receipt,
          emitEvent,
          flushTelemetry,
          recordTrace,
          t0,
          publicationRequestFingerprint,
        );
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

    try {
      const reason =
        automatic.kind === "terminal" &&
        job.request.content.type === "text" &&
        inputJob.request.content.type === "text" &&
        job.request.content.text !== inputJob.request.content.text
          ? SLACK_AUTOMATIC_EGRESS_CONFLICT
          : automaticSlackSuppressionReason(automatic, (options.now ?? Date.now)());
      if (reason) {
        receipt = receiptStore.markSuppressed({
          idempotencyKey: receiptKey,
          requestFingerprint,
          owner: claimOwner,
          reason,
          suppressedAt: (options.now ?? Date.now)(),
        });
        return acknowledgeSuppressedReceipt(
          job,
          receipt,
          emitEvent,
          flushTelemetry,
          recordTrace,
          t0,
          publicationRequestFingerprint,
        );
      }
    } catch (error) {
      return outboundProcessingFailure(error, {
        disposition: "nak",
        status: "failed",
        retryable: true,
        phase: "policy",
      });
    }

    let delivered: NativeOutboundDeliveryResult;
    try {
      delivered = await executeNativeOutbound(job, adapter, automatic.kind === "terminal" ? automatic : undefined);
    } catch (error) {
      const message = errorMessage(error);
      const failure = classifyNativeOutboundFailure(job, message);
      logNativeOutboundSendFailure(job, failure, message);
      try {
        receiptStore.releaseClaim({
          idempotencyKey: receiptKey,
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
        await emitDelivery(
          emitEvent,
          traceRecorderForAttempt(recordTrace, deliveryAttempt),
          job,
          outboundFailureTelemetry(error, {
            status: "failed",
            reason: "send_error",
            retryable: failure.retryable,
            ...(failure.reasonCode ? { unavailableReasonCode: failure.reasonCode } : {}),
            target,
            emitId,
            idempotencyKey: receiptKey,
            ...(receiptKey !== job.request.idempotencyKey
              ? { publicationIdempotencyKey: job.request.idempotencyKey }
              : {}),
            ...outboundContentTelemetry(job),
            durationMs: Date.now() - t0,
          }),
        );
      } catch (telemetryError) {
        log.warn("Failed to emit native channel send failure", {
          jobId: job.jobId,
          error: errorMessage(telemetryError),
        });
      }
      return outboundProcessingFailure(error, {
        disposition: failure.retryable ? "nak" : "ack",
        status: "failed",
        retryable: failure.retryable,
        phase: "send",
      });
    }

    try {
      const sentAt = Date.now();
      receipt = receiptStore.recordSent({
        idempotencyKey: receiptKey,
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

  // A persisted send receipt resumes bookkeeping, never another provider
  // send. Record the frozen bytes actually sent, even if today's guard would
  // reject a new send. Ordinary non-frozen output keeps its existing behavior.
  if (automatic.kind === "terminal") job = inputJob;

  if (receipt.persistedAt === undefined) {
    try {
      const delivered = deliveryResultFromReceipt(receipt);
      const persisted =
        job.request.content.type === "text"
          ? persistMessage(job, delivered, job.request.content.text)
          : persistChatAction(job, delivered);
      receipt = receiptStore.markPersisted(receiptKey, persisted);
    } catch (error) {
      if (error instanceof CanonicalOutboundMessageContractError) {
        return finalizePermanentCanonicalPersistenceError({
          job,
          receipt,
          receiptStore,
          error,
          emitEvent,
          flushTelemetry,
          recordTrace,
          startedAt: t0,
        });
      }
      return postSendPhaseFailure(job, receipt, receiptStore, "canonical_persist", error);
    }
  }

  const payload = deliveredPayload(job, receipt, t0);
  if (receipt.traceRecordedAt === undefined) {
    try {
      recordTrace({ sessionName, delivery: payload, timestamp: payload.timestamp as number });
      receipt = receiptStore.markTraceRecorded(receiptKey);
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
    receiptStore.markComplete(receiptKey);
  } catch (error) {
    return postSendPhaseFailure(job, receipt, receiptStore, "receipt_complete", error);
  }

  return { disposition: "ack", status: "delivered", retryable: false };
}

type PreparedSlackAutomaticText =
  | { kind: "unrelated" }
  | { kind: "suppressed"; reason: string }
  | { kind: "terminal"; manifest: SlackAutomaticTerminalManifest; partId: string; partFingerprint: string };

/**
 * Classifies a job as unrelated, suppressed, or an exact frozen terminal text
 * part by checking durable origin, session/chat/destination, manifest and bytes.
 * A terminal fingerprint combines the manifest fingerprint and canonical part
 * ID; publication/emit IDs only correlate wrappers and do not define the part.
 * Expected origin and membership failures become suppression classifications;
 * unexpected origin-resolution or manifest-read errors propagate for retry.
 * This preparation neither reserves admission nor writes a send receipt.
 */
function prepareSlackAutomaticText(job: ChannelOutboundJob): PreparedSlackAutomaticText {
  const suppressed = (reason: string): PreparedSlackAutomaticText => ({ kind: "suppressed", reason });
  let context;
  try {
    context = resolveSlackAutomaticOutputContext(job);
  } catch (error) {
    if (error instanceof SlackAutomaticOutputOriginError) return suppressed("slack_bot_reply_origin_invalid");
    throw error;
  }
  if (!context || job.request.content.type !== "text") return { kind: "unrelated" };
  if (
    job.request.origin.sessionName !== job.request.origin.automatic?.binding.sessionId ||
    (job.request.target.canonicalChatId !== undefined &&
      job.request.target.canonicalChatId !== context.target.canonicalChatId)
  )
    return suppressed("slack_bot_reply_origin_invalid");
  if (job.request.origin.responsePhase === "commentary") return suppressed("slack_bot_reply_commentary");
  const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
  if (job.request.origin.automaticTerminalResponseId && job.request.origin.automaticTerminalResponseId !== responseId) {
    return suppressed("slack_bot_reply_identity_conflict");
  }
  const manifest = getSlackAutomaticTerminalManifest(responseId);
  if (!manifest) return suppressed("slack_bot_reply_manifest_missing");
  if (manifest.kind === "cancelled") return suppressed("slack_bot_reply_cancelled");
  if (
    manifest.scope !== context.scope ||
    manifest.sourceId !== context.sourceId ||
    manifest.sourceReceivedAt !== context.sourceReceivedAt ||
    manifest.turnId !== context.turnId ||
    manifest.kind !== job.request.origin.responsePhase ||
    manifest.target.canonicalChatId !== context.target.canonicalChatId
  )
    return suppressed("slack_bot_reply_identity_conflict");
  let partId: string;
  try {
    partId = assertSlackAutomaticTerminalPart(manifest, { type: "text", text: job.request.content.text });
  } catch (error) {
    reportErrorDiagnostic(log, "Automatic terminal text identity rejected", error, {
      operation: "outbound_terminal_part_identity",
    });
    return suppressed("slack_bot_reply_identity_conflict");
  }
  // Wrapper emit IDs are correlation only. Every representation of this exact
  // text part shares the provider token, send lease and durable receipt.
  const partFingerprint = createHash("sha256")
    .update(JSON.stringify([manifest.requestFingerprint, partId]))
    .digest("hex");
  return { kind: "terminal", manifest, partId, partFingerprint };
}

/**
 * Reserves durable admission for a terminal response, shared by all its parts;
 * this is not a read-only policy check. Returns a reason closing this candidate,
 * or null for admitted/unrelated output, preserving any prepared suppression.
 */
function automaticSlackSuppressionReason(automatic: PreparedSlackAutomaticText, now: number): string | null {
  if (automatic.kind === "unrelated") return null;
  if (automatic.kind === "suppressed") return automatic.reason;
  const manifest = automatic.manifest;
  const decision = reserveSlackAutomaticOutput({
    idempotencyKey: manifest.responseId,
    requestFingerprint: manifest.requestFingerprint,
    scope: manifest.scope,
    sourceId: manifest.sourceId,
    sourceReceivedAt: manifest.sourceReceivedAt,
    now,
  });
  return decision.status === "suppressed" ? (decision.reason ?? "slack_bot_reply_cooldown") : null;
}

/**
 * Finalizes a terminal receipt readback without reopening its send. An egress
 * integrity conflict stays failed/nonretryable and never creates a policy
 * outbox tombstone; telemetry failure NAKs with a delay to retry reporting only.
 * Other reasons close an existing active publication after fingerprint checks,
 * then emit/flush a dropped policy disposition before ACK. Those retries may
 * repeat publication bookkeeping and telemetry, but cannot send the part.
 */
async function acknowledgeSuppressedReceipt(
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt,
  emitEvent: typeof nats.emit,
  flushTelemetry: typeof flushNatsConnection,
  recordTrace: typeof recordDeliveryTrace,
  startedAt: number,
  publicationRequestFingerprint: string,
): Promise<ChannelOutboundProcessingResult> {
  try {
    if (receipt.suppressionReason === SLACK_AUTOMATIC_EGRESS_CONFLICT) {
      // The physical tombstone closes an unsent identity. This is an integrity
      // failure, not policy suppression: leave the publication outbox alone.
      await emitDelivery(emitEvent, recordTrace, job, {
        status: "failed",
        reason: SLACK_AUTOMATIC_EGRESS_CONFLICT,
        error: SLACK_AUTOMATIC_EGRESS_CONFLICT,
        retryable: false,
        target: job.request.target,
        emitId: job.request.origin.emitId,
        idempotencyKey: receipt.idempotencyKey,
        ...(receipt.idempotencyKey !== job.request.idempotencyKey
          ? { publicationIdempotencyKey: job.request.idempotencyKey }
          : {}),
        ...outboundContentTelemetry(job),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      await flushTelemetry();
      return {
        disposition: "ack",
        status: "failed",
        retryable: false,
        phase: "policy",
        error: SLACK_AUTOMATIC_EGRESS_CONFLICT,
      };
    }
    // Publication and platform delivery are separate. A published workqueue
    // item can later end in policy suppression; it must never be retried as
    // pending output after the circuit recovers.
    const publication = getChannelOutboundPublishJob(job.request.idempotencyKey);
    if (publication && publication.status !== "suppressed") {
      if (channelOutboundRequestFingerprint(publication.job) !== publicationRequestFingerprint) {
        throw new Error("Suppressed output conflicts with its publication fingerprint");
      }
      markChannelOutboundPublishJobSuppressed(
        job.request.idempotencyKey,
        receipt.suppressionReason ?? "outbound_policy",
        receipt.completedAt,
      );
    }
    await emitDelivery(emitEvent, recordTrace, job, {
      status: "dropped",
      reason: receipt.suppressionReason ?? "outbound_policy",
      policyDisposition: "suppressed",
      retryable: false,
      target: job.request.target,
      emitId: job.request.origin.emitId,
      idempotencyKey: receipt.idempotencyKey,
      ...(receipt.idempotencyKey !== job.request.idempotencyKey
        ? { publicationIdempotencyKey: job.request.idempotencyKey }
        : {}),
      ...outboundContentTelemetry(job),
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    await flushTelemetry();
    return { disposition: "ack", status: "dropped", retryable: false };
  } catch (error) {
    // The durable terminal receipt prevents a send even when telemetry needs
    // another attempt after a crash or connection failure. NAK retries only
    // that bookkeeping; an integrity failure is still non-retryable delivery.
    const integrityFailure = receipt.suppressionReason === SLACK_AUTOMATIC_EGRESS_CONFLICT;
    return outboundProcessingFailure(error, {
      disposition: "nak",
      status: "failed",
      retryable: !integrityFailure,
      ...(integrityFailure ? { nakDelayMs: CONSUMER_RETRY_DELAY_MS } : {}),
      phase: "telemetry_emit",
    });
  }
}

async function processWithoutReceiptLedger(
  job: ChannelOutboundJob,
  adapter: NativeOutboundDelivery,
  emitEvent: typeof nats.emit,
  recordTrace: typeof recordDeliveryTrace,
  t0: number,
  deliveryAttempt?: number,
): Promise<ChannelOutboundProcessingResult> {
  const emitId = job.request.origin.emitId;
  const target = job.request.target;
  let delivered: NativeOutboundDeliveryResult;

  try {
    delivered = await executeNativeOutbound(job, adapter);
  } catch (error) {
    const message = errorMessage(error);
    const failure = classifyNativeOutboundFailure(job, message);
    logNativeOutboundSendFailure(job, failure, message);
    await emitDelivery(emitEvent, traceRecorderForAttempt(recordTrace, deliveryAttempt), job, {
      status: "failed",
      reason: "send_error",
      error: message,
      retryable: failure.retryable,
      ...(failure.reasonCode ? { unavailableReasonCode: failure.reasonCode } : {}),
      target,
      emitId,
      idempotencyKey: job.request.idempotencyKey,
      ...outboundContentTelemetry(job),
      durationMs: Date.now() - t0,
    });
    return {
      disposition: failure.retryable ? "nak" : "ack",
      status: "failed",
      retryable: failure.retryable,
      error: message,
      phase: "send",
    };
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
      responsePhase: job.request.origin.responsePhase,
      idempotencyKey: job.request.idempotencyKey,
      target,
      deliveredAt: Date.now(),
      durationMs: Date.now() - t0,
      ...outboundContentTelemetry(job),
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

function findNativeOutboundAdapter(
  job: ChannelOutboundJob,
  options: ChannelOutboundConsumerOptions,
): NativeOutboundDelivery | undefined {
  const target = job.request.target;
  return job.request.content.type === "text"
    ? options.deliveries.find((candidate) => candidate.supports(target))
    : options.actionDeliveries?.find((candidate) => candidate.supports(target));
}

/**
 * Calls the native adapter; the caller owns claim acquisition and receipt
 * persistence. An automatic argument must come from validated preparation:
 * its canonical part supplies the token and frozen target, and only that text
 * path receives `_trustedFrozenTarget`. Missing adapter capabilities throw.
 */
async function executeNativeOutbound(
  job: ChannelOutboundJob,
  adapter: NativeOutboundDelivery,
  automatic?: Extract<PreparedSlackAutomaticText, { kind: "terminal" }>,
): Promise<NativeOutboundDeliveryResult> {
  const baseRequest = {
    sessionName: job.request.origin.sessionName,
    emitId: job.request.origin.emitId,
    idempotencyKey: automatic?.partId ?? job.request.idempotencyKey,
    target: automatic?.manifest.target ?? job.request.target,
  };
  if (job.request.content.type === "text") {
    if (!("deliverText" in adapter)) {
      throw new Error(`Native text adapter is unavailable for channel: ${job.request.channelId}`);
    }
    return adapter.deliverText({
      ...baseRequest,
      ...(automatic ? { _trustedFrozenTarget: true as const } : {}),
      text: job.request.content.text,
      ...(job.request.content.format ? { format: job.request.content.format } : {}),
    });
  }
  if (!("executeChatAction" in adapter)) {
    throw new Error(`Native chat action adapter is unavailable for channel: ${job.request.channelId}`);
  }
  return adapter.executeChatAction({
    ...baseRequest,
    action: job.request.content,
  });
}

function classifyNativeOutboundFailure(
  job: ChannelOutboundJob,
  message: string,
): {
  retryable: boolean;
  reasonCode?: "missing_connection" | "missing_scope" | "permission_denied" | "invalid_target";
} {
  if (job.request.channelId.toLowerCase() !== "slack") {
    return { retryable: true };
  }
  const normalized = message.toLowerCase();
  if (/missing_scope/.test(normalized)) return { retryable: false, reasonCode: "missing_scope" };
  if (/not_authed|invalid_auth|account_inactive|token_revoked/.test(normalized)) {
    return { retryable: false, reasonCode: "missing_connection" };
  }
  if (
    /not_allowed_token_type|restricted_action|no_permission|cant_update_message|cant_delete_message|edit_not_allowed/.test(
      normalized,
    )
  ) {
    return { retryable: false, reasonCode: "permission_denied" };
  }
  if (/channel_not_found|message_not_found|invalid_ts|invalid_name|is_archived/.test(normalized)) {
    return { retryable: false, reasonCode: "invalid_target" };
  }
  return { retryable: true };
}

export interface PersistDeliveredMessageDependencies {
  resolveContext(input: { job: ChannelOutboundJob; instanceId: string }): {
    agentId?: string;
    canonicalChatId?: string;
    originSessionKey?: string;
    agentIdentity?: {
      id: string;
      platformUserId: string;
      normalizedPlatformUserId: string;
      confidence: number;
    } | null;
  };
  getChatMessage(id: string): ChatMessageRecord | null;
  saveMessageMeta: typeof dbSaveMessageMeta;
  upsertChatMessage(input: Parameters<typeof dbUpsertChatMessage>[0]): UpsertChatMessageResult;
}

class CanonicalOutboundMessageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalOutboundMessageContractError";
  }
}

const DEFAULT_PERSISTENCE_DEPENDENCIES: PersistDeliveredMessageDependencies = {
  resolveContext: ({ job, instanceId }) => {
    const session = getSessionByName(job.request.origin.sessionName);
    const agentId = session?.agentId;
    const attachedChatId = session?.sessionKey ? dbGetSessionDefaultChatId(session.sessionKey) : null;
    const canonicalChatId = job.request.target.canonicalChatId ?? attachedChatId;
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
      ...(session?.sessionKey ? { originSessionKey: session.sessionKey } : {}),
      agentIdentity,
    };
  },
  getChatMessage: dbGetChatMessage,
  saveMessageMeta: dbSaveMessageMeta,
  upsertChatMessage: dbUpsertChatMessage,
};

export function persistDeliveredMessage(
  job: ChannelOutboundJob,
  delivered: NativeTextDeliveryResult,
  text: string,
  dependencies: PersistDeliveredMessageDependencies = DEFAULT_PERSISTENCE_DEPENDENCIES,
): PersistedOutboundMessage {
  const canonicalMessageId = job.request.origin.canonicalMessageId?.trim();
  const platformMessageId = delivered.platformMessageId?.trim();
  if (!platformMessageId && !canonicalMessageId) {
    return {
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }
  const target = job.request.target;
  const sessionName = job.request.origin.sessionName;
  const instanceId = target.instanceId ?? job.request.instanceId ?? target.accountId;
  const { agentId, canonicalChatId, originSessionKey, agentIdentity } = dependencies.resolveContext({
    job,
    instanceId,
  });
  const existingCanonicalMessage = canonicalMessageId
    ? requireMatchingCanonicalMessage({
        canonicalMessageId,
        targetChannel: target.channel,
        instanceId,
        canonicalChatId,
        agentId,
        originSessionKey,
        getChatMessage: dependencies.getChatMessage,
      })
    : null;
  if (!platformMessageId) {
    return {
      ...(existingCanonicalMessage ? { canonicalMessageId: existingCanonicalMessage.id } : {}),
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }

  const persistedCanonicalChatId = existingCanonicalMessage?.chatId ?? canonicalChatId;
  const persistedAgentId = existingCanonicalMessage?.agentId ?? agentId;
  const persistedOriginSessionKey = existingCanonicalMessage?.originSessionKey ?? originSessionKey;

  dependencies.saveMessageMeta(platformMessageId, target.chatId, {
    canonicalChatId: persistedCanonicalChatId,
    actorType: "agent",
    agentId: persistedAgentId,
    platformIdentityId: agentIdentity?.id,
    rawSenderId: agentIdentity?.platformUserId,
    normalizedSenderId: agentIdentity?.normalizedPlatformUserId,
    identityConfidence: agentIdentity?.confidence,
    identityProvenance: {
      source: "ravi.channels.runner",
      sessionName,
      originSessionKey: persistedOriginSessionKey ?? null,
      agentId: persistedAgentId ?? null,
      canonicalMessageId: existingCanonicalMessage?.id ?? null,
      accountId: target.accountId,
      instanceId,
      channel: target.channel,
      providerMessageId: platformMessageId,
      deliveryMessageId: delivered.messageId ?? null,
      idempotencyKey: job.request.idempotencyKey,
      responsePhase: job.request.origin.responsePhase ?? null,
    },
  });

  if (existingCanonicalMessage) {
    return {
      canonicalMessageId: existingCanonicalMessage.id,
      platformMessageId,
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }

  if (job.request.origin.responsePhase === "commentary") {
    return {
      platformMessageId,
      ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
    };
  }

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
    originSessionKey,
    platformIdentityId: agentIdentity?.id,
    messageType: "text",
    content: { type: "text", text },
    rawProvenance: {
      source: "ravi.channels.runner",
      sessionName,
      originSessionKey: originSessionKey ?? null,
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

function requireMatchingCanonicalMessage(input: {
  canonicalMessageId: string;
  targetChannel: string;
  instanceId: string;
  canonicalChatId?: string;
  agentId?: string;
  originSessionKey?: string;
  getChatMessage(id: string): ChatMessageRecord | null;
}): ChatMessageRecord {
  const message = input.getChatMessage(input.canonicalMessageId);
  if (!message) {
    throw new CanonicalOutboundMessageContractError(
      `Canonical outbound message not found: ${input.canonicalMessageId}`,
    );
  }
  const targetChannel =
    input.targetChannel
      .trim()
      .toLowerCase()
      .replace(/-baileys$/, "") || "unknown";
  const mismatch =
    message.actorType !== "agent" ||
    !message.agentId ||
    message.channel !== targetChannel ||
    message.instanceId !== input.instanceId ||
    (input.canonicalChatId !== undefined && message.chatId !== input.canonicalChatId) ||
    (input.agentId !== undefined && message.agentId !== input.agentId) ||
    (input.originSessionKey !== undefined && message.originSessionKey !== input.originSessionKey);
  if (mismatch) {
    throw new CanonicalOutboundMessageContractError(
      `Canonical outbound message does not match delivery context: ${input.canonicalMessageId}`,
    );
  }
  return message;
}

export function persistDeliveredChatAction(
  job: ChannelOutboundJob,
  delivered: NativeChatActionDeliveryResult,
): PersistedOutboundMessage {
  const content = job.request.content;
  if (content.type !== "chat_action") {
    throw new Error(`Cannot persist non-action outbound content: ${content.type}`);
  }

  if (content.actionId === "thread.create") {
    const providerThreadId = delivered.platformMessageId?.trim();
    if (!providerThreadId) {
      throw new Error("Slack thread.create delivery did not return a root message timestamp");
    }
    const persisted = persistDeliveredMessage(job, delivered, content.text);
    markSlackThreadRootDelivered({
      requestId: job.request.requestId,
      providerThreadId,
      canonicalRootMessageId: persisted.canonicalMessageId,
    });
    return persisted;
  }

  if (content.actionId === "message.react") {
    const raw = delivered.raw;
    const error = raw && typeof raw.error === "string" ? raw.error : undefined;
    if (raw && raw.ok === false && error !== "already_reacted") {
      throw new Error(`Slack reaction was not accepted: ${error ?? "unknown"}`);
    }
  }

  const canonicalMessageId = content.canonicalMessageId?.trim();
  if (canonicalMessageId && content.actionId === "message.edit") {
    const edited = dbMarkChatMessageEdited(canonicalMessageId, content.text);
    if (!edited) throw new Error(`Canonical chat message not found after Slack edit: ${canonicalMessageId}`);
  } else if (canonicalMessageId && content.actionId === "message.delete") {
    const deleted = dbMarkChatMessageDeleted(canonicalMessageId);
    if (!deleted) throw new Error(`Canonical chat message not found after Slack delete: ${canonicalMessageId}`);
  }

  return {
    ...(canonicalMessageId ? { canonicalMessageId } : {}),
    ...(delivered.platformMessageId ? { platformMessageId: delivered.platformMessageId } : {}),
    ...(delivered.providerTimestamp !== undefined ? { providerTimestamp: delivered.providerTimestamp } : {}),
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
    ...outboundContentTelemetry(job),
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
  deliveryAttempt?: number,
): Promise<ChannelOutboundProcessingResult> {
  const error = `No native delivery adapter registered for channel: ${job.request.channelId}`;
  const retryDelayMs = missingAdapterRetryDelayMs(deliveryAttempt);
  warnMissingAdapter(job.request.channelId, { jobId: job.jobId, deliveryAttempt, retryDelayMs });
  await emitDelivery(emitEvent, traceRecorderForAttempt(recordTrace, deliveryAttempt), job, {
    status: "failed",
    reason: "missing_adapter",
    error,
    retryable: true,
    retryDelayMs,
    ...(deliveryAttempt !== undefined ? { deliveryAttempt } : {}),
    target: job.request.target,
    emitId: job.request.origin.emitId,
    idempotencyKey: job.request.idempotencyKey,
    ...outboundContentTelemetry(job),
    durationMs: Date.now() - t0,
  });
  return {
    disposition: "nak",
    status: "failed",
    retryable: true,
    error,
    phase: "adapter_lookup",
    nakDelayMs: retryDelayMs,
  };
}

const MISSING_ADAPTER_WARN_INTERVAL_MS = 60_000;
const missingAdapterWarnedAt = new Map<string, number>();

/**
 * A reply with no adapter is NAKed and retried until the stream's max age, so
 * say so in the log, once a minute per channel. The usual cause is an adapter
 * that failed to start; `ravi channels status` shows its reason.
 */
export function warnMissingAdapter(
  channelId: string,
  fields: { jobId: string; deliveryAttempt?: number; retryDelayMs: number },
  now = Date.now(),
): boolean {
  const last = missingAdapterWarnedAt.get(channelId);
  if (last !== undefined && now - last < MISSING_ADAPTER_WARN_INTERVAL_MS) return false;
  missingAdapterWarnedAt.set(channelId, now);
  log.warn("Native outbound has no adapter for its channel; the reply stays queued and is retried", {
    channelId,
    jobId: fields.jobId,
    ...(fields.deliveryAttempt !== undefined ? { deliveryAttempt: fields.deliveryAttempt } : {}),
    retryDelayMs: fields.retryDelayMs,
    hint: "run `ravi channels status` for the adapter's failure reason",
  });
  return true;
}

export function resetMissingAdapterWarningsForTests(): void {
  missingAdapterWarnedAt.clear();
}

export function missingAdapterRetryDelayMs(deliveryAttempt: number | undefined): number {
  const attempt =
    typeof deliveryAttempt === "number" && Number.isSafeInteger(deliveryAttempt) && deliveryAttempt > 0
      ? deliveryAttempt
      : 1;
  const exponent = Math.min(attempt - 1, 4);
  return Math.min(
    CHANNEL_OUTBOUND_MISSING_ADAPTER_RETRY_BASE_MS * 2 ** exponent,
    CHANNEL_OUTBOUND_MISSING_ADAPTER_RETRY_MAX_MS,
  );
}

function traceRecorderForAttempt(
  recordTrace: typeof recordDeliveryTrace,
  deliveryAttempt: number | undefined,
): typeof recordDeliveryTrace {
  // JetStream redeliveries still emit live delivery telemetry, but persisting
  // the same failure on every retry can turn a provider outage into an
  // unbounded SQLite write amplifier. The first failure plus the eventual
  // terminal delivery are sufficient for the durable trace.
  if (deliveryAttempt === undefined || deliveryAttempt <= 1) return recordTrace;
  return () => null;
}

function deliveryResultFromReceipt(receipt: ChannelOutboundReceipt): NativeOutboundDeliveryResult {
  return {
    provider: receipt.provider,
    ...(receipt.deliveryMessageId ? { messageId: receipt.deliveryMessageId } : {}),
    ...(receipt.platformMessageId ? { platformMessageId: receipt.platformMessageId } : {}),
    ...(receipt.providerTimestamp !== undefined ? { providerTimestamp: receipt.providerTimestamp } : {}),
  };
}

/**
 * Projects an observed send receipt into telemetry without emitting it.
 * `idempotencyKey` identifies the receipt's send unit, which may render as multiple
 * physical posts; a distinct wrapper key is retained as `publicationIdempotencyKey`.
 * The receipt supplies the delivery result and provider timestamp; chat-action
 * metadata may override providerMessageId/canonicalMessageId with the action's
 * target. Publication success alone is not sufficient input for this helper.
 */
function deliveredPayload(
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt,
  startedAt: number,
): Record<string, unknown> {
  return {
    jobId: job.jobId,
    requestId: job.request.requestId,
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
    responsePhase: job.request.origin.responsePhase,
    idempotencyKey: receipt.idempotencyKey,
    ...(receipt.idempotencyKey !== job.request.idempotencyKey
      ? { publicationIdempotencyKey: job.request.idempotencyKey }
      : {}),
    target: job.request.target,
    deliveredAt: receipt.sentAt,
    durationMs: Date.now() - startedAt,
    ...outboundContentTelemetry(job),
  };
}

function outboundContentTelemetry(job: ChannelOutboundJob): Record<string, unknown> {
  const content = job.request.content;
  if (content.type === "text") {
    return { contentType: "text", textLen: content.text.length };
  }
  if (content.type === "chat_action") {
    return {
      contentType: "chat_action",
      actionId: content.actionId,
      ...("providerMessageId" in content ? { providerMessageId: content.providerMessageId } : {}),
      ...("canonicalMessageId" in content ? { canonicalMessageId: content.canonicalMessageId } : {}),
    };
  }
  return { contentType: String((content as { type?: unknown }).type ?? "unknown") };
}

/**
 * Reports an observed provider send with a failed follow-up phase, recording
 * the phase against the receipt when possible. Canonical-persistence contract
 * errors ACK; other errors NAK while retaining delivery status. A `receipt_write`
 * failure may leave only a claim, so this result does not guarantee a durable
 * send receipt or restrict every later attempt to bookkeeping.
 */
function postSendPhaseFailure(
  job: ChannelOutboundJob,
  receipt: ChannelOutboundReceipt | null,
  receiptStore: ChannelOutboundReceiptStore,
  phase: ChannelOutboundReceiptErrorPhase,
  error: unknown,
): ChannelOutboundProcessingResult {
  const message = errorMessage(error);
  const retryable = !(phase === "canonical_persist" && error instanceof CanonicalOutboundMessageContractError);
  if (receipt) {
    try {
      receiptStore.recordError(receipt.idempotencyKey, phase, message);
    } catch (recordError) {
      log.warn("Failed to record outbound receipt phase error", {
        jobId: job.jobId,
        phase,
        error: errorMessage(recordError),
      });
    }
  }
  log.warn(
    retryable
      ? "Native outbound post-send phase failed; delivery will resume"
      : "Native outbound canonical persistence rejected; provider delivery will not be retried",
    {
      jobId: job.jobId,
      phase,
      error: message,
    },
  );
  return {
    disposition: retryable ? "nak" : "ack",
    status: "delivered",
    retryable,
    error: message,
    phase,
  };
}

/**
 * Closes a permanent canonical-persistence rejection after a durable send.
 * The provider effect remains delivered: emit/flush the rejection before
 * terminalizing its receipt. Reporting or completion failure NAKs so a later
 * attempt can finish bookkeeping from that receipt without another send.
 */
async function finalizePermanentCanonicalPersistenceError(input: {
  job: ChannelOutboundJob;
  receipt: ChannelOutboundReceipt;
  receiptStore: ChannelOutboundReceiptStore;
  error: CanonicalOutboundMessageContractError;
  emitEvent: typeof nats.emit;
  flushTelemetry: typeof flushNatsConnection;
  recordTrace: typeof recordDeliveryTrace;
  startedAt: number;
}): Promise<ChannelOutboundProcessingResult> {
  const { job, receipt, receiptStore, error, emitEvent, flushTelemetry, recordTrace, startedAt } = input;
  const message = errorMessage(error);
  try {
    receiptStore.recordError(receipt.idempotencyKey, "canonical_persist", message);
  } catch (recordError) {
    log.warn("Failed to record permanent canonical persistence error", {
      jobId: job.jobId,
      error: errorMessage(recordError),
    });
  }

  try {
    await emitDelivery(emitEvent, recordTrace, job, {
      ...deliveredPayload(job, receipt, startedAt),
      reason: "canonical_persist_rejected",
      phase: "canonical_persist",
      canonicalPersistence: "rejected",
      retryable: false,
      error: message,
    });
    await flushTelemetry();
  } catch (telemetryError) {
    return retryPermanentCanonicalBookkeeping(job, "telemetry_emit", telemetryError);
  }

  try {
    receiptStore.markTerminalError(receipt.idempotencyKey, "canonical_persist", message);
  } catch (terminalError) {
    return retryPermanentCanonicalBookkeeping(job, "receipt_complete", terminalError);
  }

  log.warn("Native outbound canonical persistence rejected after provider delivery", {
    jobId: job.jobId,
    phase: "canonical_persist",
    error: message,
  });
  return {
    disposition: "ack",
    status: "delivered",
    retryable: false,
    error: message,
    phase: "canonical_persist",
  };
}

function retryPermanentCanonicalBookkeeping(
  job: ChannelOutboundJob,
  phase: "telemetry_emit" | "receipt_complete",
  error: unknown,
): ChannelOutboundProcessingResult {
  const message = errorMessage(error);
  log.warn("Permanent canonical rejection bookkeeping failed; provider delivery will not be retried", {
    jobId: job.jobId,
    phase,
    error: message,
  });
  return {
    disposition: "nak",
    status: "delivered",
    retryable: true,
    error: message,
    phase,
  };
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

/** Preserve delivery decisions while projecting the caught cause at the result boundary. */
function outboundProcessingFailure(
  error: unknown,
  result: Omit<ChannelOutboundProcessingResult, "error"> & { phase: ChannelOutboundProcessingPhase },
): ChannelOutboundProcessingResult {
  return { ...result, error: errorDiagnostic(error, { operation: `channel_outbound_${result.phase}` }).cause };
}

/** Delivery telemetry contains only a bounded diagnostic, never the caught provider payload. */
function outboundFailureTelemetry(error: unknown, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, error: errorDiagnostic(error, { operation: "channel_outbound_send" }).cause };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

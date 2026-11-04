import { createHash, randomUUID } from "node:crypto";
import type { MessageTarget, ResponseMediaAttachment, ResponseMessage } from "../../runtime/message-types.js";
import {
  sqliteChannelOutboundReceiptStore,
  type ChannelOutboundReceipt,
  type ChannelOutboundReceiptStore,
} from "../outbound-receipts.js";
import { reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import {
  assertSlackAutomaticOutputTarget,
  resolveSlackAutomaticOutputContextFromBinding,
  type SlackAutomaticOutputOriginDependencies,
} from "./automatic-output-origin.js";
import {
  assertSlackAutomaticTerminalPart,
  getSlackAutomaticTerminalManifest,
  readSlackAutomaticTerminalMediaBytes,
  slackAutomaticTerminalResponseId,
} from "./automatic-terminal-manifest.js";

export interface SlackAutomaticMediaInput {
  sessionName: string;
  response: Pick<ResponseMessage, "_automaticOutputOrigin" | "_automaticTerminalResponseId">;
  target: MessageTarget;
  /** Delivery copy, possibly with a Knowledge-redacted caption. */
  media: ResponseMediaAttachment;
  /** The descriptor frozen by the host, before caption redaction. */
  originalMedia: ResponseMediaAttachment;
  /** Ordinal in the complete frozen media set, independent of content. */
  mediaIndex: number;
}

export type SlackAutomaticMediaResult =
  | { handled: false }
  | {
      handled: true;
      status: "delivered" | "suppressed" | "pending" | "unknown" | "failed";
      retryable: boolean;
      reason?: string;
      idempotencyKey?: string;
      newlySent?: boolean;
    };

export interface SlackAutomaticMediaDependencies {
  send(input: {
    target: MessageTarget;
    media: ResponseMediaAttachment;
    fileBytes: Buffer;
  }): Promise<{ fileId: string; messageId?: string }>;
  emitDelivery(data: Record<string, unknown>): Promise<void>;
  flushTelemetry?(): Promise<void>;
  now?(): number;
  receiptStore?: ChannelOutboundReceiptStore;
  originDependencies?: SlackAutomaticOutputOriginDependencies;
}

/**
 * The terminal response owns the admission; its exact media members own send
 * receipts. An expired/failed upload claim is ambiguous and is never retried:
 * Slack's file upload API has no proven idempotency key for this operation.
 */
export async function deliverSlackAutomaticMedia(
  input: SlackAutomaticMediaInput,
  dependencies: SlackAutomaticMediaDependencies,
): Promise<SlackAutomaticMediaResult> {
  const origin = input.response._automaticOutputOrigin;
  if (origin === undefined && input.response._automaticTerminalResponseId === undefined) return { handled: false };
  const now = dependencies.now ?? Date.now;
  const store = dependencies.receiptStore ?? sqliteChannelOutboundReceiptStore;
  const emit = async (data: Record<string, unknown>): Promise<boolean> => {
    try {
      await dependencies.emitDelivery({ target: input.target, ...data });
      await dependencies.flushTelemetry?.();
      return true;
    } catch {
      return false;
    }
  };
  const failed = async (
    reason: string,
    retryable = false,
    idempotencyKey?: string,
  ): Promise<SlackAutomaticMediaResult> => {
    await emit({ status: "failed", reason, retryable, ...(idempotencyKey ? { idempotencyKey } : {}) });
    return { handled: true, status: "failed", reason, retryable, ...(idempotencyKey ? { idempotencyKey } : {}) };
  };

  let context;
  let manifest;
  let idempotencyKey: string;
  try {
    if (!origin || origin.kind !== "channel_backend") return failed("slack_bot_reply_origin_invalid");
    context = resolveSlackAutomaticOutputContextFromBinding(origin.binding, dependencies.originDependencies);
    if (!context) return { handled: false }; // Native human responses retain their existing media flow.
    assertSlackAutomaticOutputTarget(context, input.target, dependencies.originDependencies);
    const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
    if (input.response._automaticTerminalResponseId !== responseId) return failed("slack_bot_reply_identity_conflict");
    manifest = getSlackAutomaticTerminalManifest(responseId);
    if (!manifest) return failed("slack_bot_reply_manifest_missing");
    if (
      manifest.turnId !== context.turnId ||
      manifest.sourceId !== context.sourceId ||
      manifest.sourceReceivedAt !== context.sourceReceivedAt ||
      manifest.scope !== context.scope ||
      manifest.kind === "cancelled"
    )
      return failed("slack_bot_reply_identity_conflict");
    idempotencyKey = assertSlackAutomaticTerminalPart(manifest, {
      type: "media",
      index: input.mediaIndex,
      media: input.originalMedia,
    });
    // Caption filtering is the only permitted transformation after freezing.
    assertSlackAutomaticTerminalPart(manifest, {
      type: "media",
      index: input.mediaIndex,
      media: { ...input.media, caption: input.originalMedia.caption },
    });
  } catch {
    return failed("slack_bot_reply_origin_or_manifest_invalid");
  }
  // The manifest itself durably closes unavailable members. Reappearing files
  // cannot revive them; this is a failed part, not a policy-suppressed upload.
  if (manifest.mediaAvailabilityErrors[input.mediaIndex] !== null) {
    return failed("slack_bot_reply_media_unavailable", false, idempotencyKey);
  }

  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify([manifest.requestFingerprint, idempotencyKey]))
    .digest("hex");
  const unknown = async (reason: string): Promise<SlackAutomaticMediaResult> => {
    // Keep the claim, including its owner, so even a late retry after restart
    // cannot treat this as an unsent fresh file. A still-running owner may
    // finish and record its observed send; competing workers never upload.
    const telemetryOk = await emit({ status: "unknown", reason, retryable: false, idempotencyKey });
    return {
      handled: true,
      status: "unknown",
      reason: telemetryOk ? reason : "slack_media_unknown_telemetry_failed",
      retryable: false,
      idempotencyKey,
    };
  };
  const pendingOrUnknown = async (receipt: ChannelOutboundReceipt): Promise<SlackAutomaticMediaResult> => {
    if (
      receipt.lastErrorPhase === "send" ||
      receipt.lastErrorPhase === "receipt_write" ||
      receipt.claimExpiresAt === undefined ||
      receipt.claimExpiresAt <= now()
    ) {
      return unknown("slack_media_delivery_unknown");
    }
    await emit({ status: "queued", reason: "slack_media_claim_busy", retryable: true, idempotencyKey });
    return { handled: true, status: "pending", reason: "slack_media_claim_busy", retryable: true, idempotencyKey };
  };
  const suppressed = async (receipt: ChannelOutboundReceipt): Promise<SlackAutomaticMediaResult> => {
    const reason = receipt.suppressionReason ?? "slack_bot_reply_cooldown";
    const ok = await emit({
      status: "dropped",
      reason,
      policyDisposition: "suppressed",
      retryable: false,
      idempotencyKey,
    });
    return { handled: true, status: ok ? "suppressed" : "failed", reason, retryable: !ok, idempotencyKey };
  };

  let receipt: ChannelOutboundReceipt | null;
  try {
    receipt = store.get(idempotencyKey);
  } catch {
    return failed("slack_media_receipt_read", true, idempotencyKey);
  }
  if (receipt && receipt.requestFingerprint !== requestFingerprint)
    return failed("slack_bot_reply_identity_conflict", false, idempotencyKey);
  if (receipt?.state === "complete")
    return { handled: true, status: "delivered", newlySent: false, retryable: false, idempotencyKey };
  if (receipt?.state === "suppressed") return suppressed(receipt);
  if (receipt?.state === "claimed") return pendingOrUnknown(receipt);

  let newlySent = false;
  if (!receipt) {
    let claim;
    let decision;
    const owner = `slack-media:${process.pid}:${randomUUID()}`;
    try {
      decision = reserveSlackAutomaticOutput({
        idempotencyKey: manifest.responseId,
        requestFingerprint: manifest.requestFingerprint,
        scope: manifest.scope,
        sourceId: manifest.sourceId,
        sourceReceivedAt: manifest.sourceReceivedAt,
        now: now(),
      });
      claim = store.claim({
        idempotencyKey,
        requestFingerprint,
        owner,
        jobId: idempotencyKey,
        requestId: manifest.responseId,
        sessionName: input.sessionName,
        provider: "slack",
        now: now(),
        allowExpiredTakeover: false,
      });
    } catch {
      return failed("slack_media_receipt_claim", true, idempotencyKey);
    }
    receipt = claim.receipt;
    if (claim.status === "conflict") return failed("slack_bot_reply_identity_conflict", false, idempotencyKey);
    if (claim.status === "busy") return pendingOrUnknown(receipt);
    if (claim.status === "existing") {
      if (receipt.state === "suppressed") return suppressed(receipt);
      if (receipt.state === "complete")
        return { handled: true, status: "delivered", newlySent: false, retryable: false, idempotencyKey };
    } else {
      if (decision.status === "suppressed") {
        try {
          return suppressed(
            store.markSuppressed({
              idempotencyKey,
              requestFingerprint,
              owner,
              reason: decision.reason ?? "slack_bot_reply_cooldown",
              suppressedAt: now(),
            }),
          );
        } catch {
          return failed("slack_media_suppression_persist", true, idempotencyKey);
        }
      }
      let fileBytes: Buffer;
      try {
        fileBytes = readSlackAutomaticTerminalMediaBytes(manifest, {
          index: input.mediaIndex,
          media: input.originalMedia,
        });
      } catch {
        try {
          store.markSuppressed({
            idempotencyKey,
            requestFingerprint,
            owner,
            reason: "slack_bot_reply_media_content_conflict",
            suppressedAt: now(),
          });
        } catch {
          return failed("slack_media_content_conflict_persist", true, idempotencyKey);
        }
        return failed("slack_bot_reply_media_content_conflict", false, idempotencyKey);
      }
      let delivered;
      try {
        delivered = await dependencies.send({ target: context.target, media: input.media, fileBytes });
      } catch {
        try {
          store.recordError(
            idempotencyKey,
            "send",
            "Slack file upload outcome is unknown; automatic retry refused",
            now(),
          );
        } catch {}
        return unknown("slack_media_delivery_unknown");
      }
      try {
        receipt = store.recordSent({
          idempotencyKey,
          requestFingerprint,
          owner,
          provider: "slack",
          deliveryMessageId: delivered.fileId,
          ...(delivered.messageId ? { platformMessageId: delivered.messageId } : {}),
          sentAt: now(),
        });
        newlySent = true;
      } catch {
        try {
          store.recordError(
            idempotencyKey,
            "receipt_write",
            "Slack accepted upload but its receipt could not be saved; retry refused",
            now(),
          );
        } catch {}
        return unknown("slack_media_delivery_unknown");
      }
    }
  }

  // The provider receipt is durable before any externally visible telemetry.
  // Restart/redelivery resumes only these bookkeeping phases, never upload.
  try {
    if (receipt.persistedAt === undefined) receipt = store.markPersisted(idempotencyKey, { persistedAt: now() });
    await dependencies.emitDelivery({
      status: "delivered",
      target: context.target,
      provider: "slack",
      transport: "slack-native",
      fileId: receipt.deliveryMessageId,
      ...(receipt.platformMessageId ? { messageId: receipt.platformMessageId } : {}),
      deliveredAt: receipt.sentAt,
      idempotencyKey,
    });
    await dependencies.flushTelemetry?.();
    store.markTraceRecorded(idempotencyKey, now());
    store.markComplete(idempotencyKey, now());
  } catch {
    try {
      store.recordError(
        idempotencyKey,
        "telemetry_emit",
        "Slack media bookkeeping incomplete; provider resend forbidden",
        now(),
      );
    } catch {}
    return { handled: true, status: "failed", reason: "slack_media_bookkeeping", retryable: true, idempotencyKey };
  }
  return { handled: true, status: "delivered", newlySent, retryable: false, idempotencyKey };
}

import { actorCanGrantRequestedPermission } from "./grantor.js";
import { slackApprovalDecisionFromActionId } from "./slack-blocks.js";
import {
  getApprovalRequest,
  getApprovalRequestByMessageId,
  isApprovalRequestOpen,
  type ApprovalDecisionValue,
  type ApprovalRequestRecord,
} from "./store.js";
import { isApprovalReactionEmoji } from "../utils/reaction-emoji.js";

export type ApprovalInboundIgnoreReason =
  | "unrelated_event"
  | "unknown_request"
  | "not_open"
  | "wrong_message"
  | "wrong_account"
  | "wrong_chat"
  | "wrong_channel"
  | "unauthorized_grantor"
  | "missing_actor";

export type ApprovalInboundEvaluation =
  | { readonly kind: "ignore"; readonly reason: ApprovalInboundIgnoreReason }
  | {
      readonly kind: "decide";
      readonly request: ApprovalRequestRecord;
      readonly decision: ApprovalDecisionValue;
      readonly actorId: string;
      readonly reason?: string;
    };

export interface ApprovalInboundEvent {
  readonly topic: string;
  readonly data: Record<string, unknown>;
}

const SLACK_CHANNEL = "slack";

export function evaluateApprovalInboundEvent(event: ApprovalInboundEvent, now: number): ApprovalInboundEvaluation {
  const candidate = parseApprovalCandidate(event);
  if (!candidate) return { kind: "ignore", reason: "unrelated_event" };

  const request =
    (candidate.requestId ? getApprovalRequest(candidate.requestId) : null) ??
    (candidate.messageId ? getApprovalRequestByMessageId(candidate.messageId) : null);
  if (!request) return { kind: "ignore", reason: "unknown_request" };
  if (!isApprovalRequestOpen(request, now)) return { kind: "ignore", reason: "not_open" };

  if (candidate.channel && candidate.channel !== request.channel) {
    return { kind: "ignore", reason: "wrong_channel" };
  }
  if (usesReactionOrReply(request.channel) && event.topic === "ravi.inbound.interaction") {
    return { kind: "ignore", reason: "wrong_channel" };
  }
  if (request.channel === SLACK_CHANNEL && event.topic !== "ravi.inbound.interaction") {
    return { kind: "ignore", reason: "wrong_channel" };
  }
  if (candidate.messageId && request.messageId && candidate.messageId !== request.messageId) {
    return { kind: "ignore", reason: "wrong_message" };
  }
  if (candidate.accountId && candidate.accountId !== request.accountId) {
    return { kind: "ignore", reason: "wrong_account" };
  }
  if (candidate.chatId && candidate.chatId !== request.chatId) {
    return { kind: "ignore", reason: "wrong_chat" };
  }
  if (candidate.requestId && candidate.requestId !== request.id) {
    return { kind: "ignore", reason: "unknown_request" };
  }

  const grantor = actorCanGrantRequestedPermission({
    channel: request.channel,
    accountId: request.accountId,
    instanceId: request.instanceId ?? candidate.instanceId ?? request.accountId,
    senderId: candidate.actorId,
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
  });
  if (!candidate.actorId) return { kind: "ignore", reason: "missing_actor" };
  if (!grantor.allowed) return { kind: "ignore", reason: "unauthorized_grantor" };

  return {
    kind: "decide",
    request,
    decision: candidate.decision,
    actorId: candidate.actorId,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  };
}

interface ApprovalCandidate {
  readonly requestId?: string;
  readonly messageId?: string;
  readonly accountId?: string;
  readonly chatId?: string;
  readonly instanceId?: string;
  readonly actorId?: string;
  readonly channel?: string;
  readonly decision: ApprovalDecisionValue;
  readonly reason?: string;
}

function parseApprovalCandidate(event: ApprovalInboundEvent): ApprovalCandidate | null {
  if (event.topic === "ravi.inbound.interaction") {
    const actionId = stringField(event.data, "actionId");
    const decision = slackApprovalDecisionFromActionId(actionId);
    if (!decision) return null;
    return {
      requestId: stringField(event.data, "value"),
      messageId: stringField(event.data, "messageTs"),
      accountId: stringField(event.data, "accountId"),
      chatId: stringField(event.data, "channelId"),
      instanceId: stringField(event.data, "instanceId"),
      actorId: stringField(event.data, "userId"),
      channel: SLACK_CHANNEL,
      decision,
    };
  }

  if (event.topic === "ravi.inbound.reaction") {
    const messageId = stringField(event.data, "targetMessageId");
    if (!messageId) return null;
    return {
      messageId,
      actorId: stringField(event.data, "senderId"),
      decision: isApprovalReactionEmoji(stringField(event.data, "emoji")) ? "approved" : "rejected",
    };
  }

  if (event.topic === "ravi.inbound.reply") {
    const messageId = stringField(event.data, "targetMessageId");
    if (!messageId) return null;
    const text = stringField(event.data, "text");
    return {
      messageId,
      actorId: stringField(event.data, "senderId"),
      decision: "rejected",
      ...(text ? { reason: text } : {}),
    };
  }

  return null;
}

function usesReactionOrReply(channel: string): boolean {
  return channel !== SLACK_CHANNEL;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

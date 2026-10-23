import { actorCanGrantRequestedPermission } from "./grantor.js";
import { grantAllowsIntent, readPermissionGrantMetadata, resolveClickScope } from "./grant-metadata.js";
import {
  parseSlackGrantActionValue,
  slackApprovalDecisionFromActionId,
  slackPermissionGrantClickFromActionId,
  type SlackPermissionGrantClick,
} from "./slack-blocks.js";
import {
  getApprovalCardScope,
  getApprovalRequest,
  getApprovalRequestByMessageId,
  isApprovalRequestOpen,
  listApprovalDeliveries,
  type ApprovalDecisionValue,
  type ApprovalRequestRecord,
} from "./store.js";
import type { PermissionGrantIntent, PermissionGrantScopeValue } from "../permissions/apply-grant.js";
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
  | "missing_actor"
  | "grant_not_allowed"
  | "scope_not_allowed";

export interface ApprovalGrantDecision {
  readonly intent: PermissionGrantIntent;
  /** Validated against the scopes stored on the request; null for an agent-only grant. */
  readonly scope: PermissionGrantScopeValue | null;
}

export type ApprovalInboundEvaluation =
  | { readonly kind: "ignore"; readonly reason: ApprovalInboundIgnoreReason }
  | {
      readonly kind: "decide";
      readonly request: ApprovalRequestRecord;
      readonly decision: ApprovalDecisionValue;
      readonly actorId: string;
      readonly reason?: string;
      /** Handle to answer the click privately (Slack `response_url`), when there is one. */
      readonly responseUrlId?: string;
      /** Set when the click picked a grant, not the legacy one-shot approval. */
      readonly grant?: ApprovalGrantDecision;
    }
  | {
      /** A scope selection. Not a decision: the caller persists it and re-renders the card. */
      readonly kind: "scope";
      readonly request: ApprovalRequestRecord;
      readonly actorId: string;
      readonly scope: PermissionGrantScopeValue;
      readonly responseUrlId?: string;
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
  if (candidate.accountId && candidate.accountId !== request.accountId) {
    return { kind: "ignore", reason: "wrong_account" };
  }
  const deliveries = event.topic === "ravi.inbound.interaction" ? listApprovalDeliveries(request.id) : [];
  if (deliveries.length > 0) {
    // Private cards: each one belongs to one person. A click counts only from
    // the person the card was sent to, in the chat it was sent to. Ephemeral
    // cards are correlated by person rather than message ts, because only that
    // person can see or click them.
    if (!candidate.actorId) return { kind: "ignore", reason: "missing_actor" };
    const actorId = candidate.actorId.toUpperCase();
    const delivery = deliveries.find((entry) => entry.userId.toUpperCase() === actorId);
    if (!delivery) return { kind: "ignore", reason: "unauthorized_grantor" };
    if (candidate.chatId && candidate.chatId !== delivery.chatId) {
      return { kind: "ignore", reason: "wrong_chat" };
    }
    if (delivery.kind === "dm" && candidate.messageId && candidate.messageId !== delivery.messageId) {
      return { kind: "ignore", reason: "wrong_message" };
    }
  } else {
    if (candidate.messageId && request.messageId && candidate.messageId !== request.messageId) {
      return { kind: "ignore", reason: "wrong_message" };
    }
    if (candidate.chatId && candidate.chatId !== request.chatId) {
      return { kind: "ignore", reason: "wrong_chat" };
    }
  }
  if (candidate.requestId && candidate.requestId !== request.id) {
    return { kind: "ignore", reason: "unknown_request" };
  }
  if (!candidate.actorId) return { kind: "ignore", reason: "missing_actor" };

  if (candidate.grantClick) {
    return evaluateGrantClick(request, candidate);
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
  if (!grantor.allowed) return { kind: "ignore", reason: "unauthorized_grantor" };

  return {
    kind: "decide",
    request,
    decision: candidate.decision,
    actorId: candidate.actorId,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    ...(candidate.responseUrlId ? { responseUrlId: candidate.responseUrlId } : {}),
  };
}

/**
 * Grant card clicks. The intent comes from the action id and the scope from the
 * click value; both are untrusted. The scope must be one the request recorded,
 * `full access` must come from a recipient that is an admin of this instance,
 * and every intent still passes the server-side grantor gate.
 */
function evaluateGrantClick(request: ApprovalRequestRecord, candidate: ApprovalCandidate): ApprovalInboundEvaluation {
  const click = candidate.grantClick as SlackPermissionGrantClick;
  const grant = readPermissionGrantMetadata(request);
  if (!grant) return { kind: "ignore", reason: "grant_not_allowed" };

  const actorId = candidate.actorId as string;
  const grantor = (permission = request.permission, objectType = request.objectType, objectId = request.objectId) =>
    actorCanGrantRequestedPermission({
      channel: request.channel,
      accountId: request.accountId,
      instanceId: request.instanceId ?? candidate.instanceId ?? request.accountId,
      senderId: actorId,
      permission,
      objectType,
      objectId,
    }).allowed;

  if (click === "scope") {
    const resolved = resolveClickScope(grant, candidate.scopeValue);
    if (!resolved) return { kind: "ignore", reason: "scope_not_allowed" };
    if (!grantor()) return { kind: "ignore", reason: "unauthorized_grantor" };
    return {
      kind: "scope",
      request,
      actorId,
      scope: resolved.scopeValue,
      ...(candidate.responseUrlId ? { responseUrlId: candidate.responseUrlId } : {}),
    };
  }

  if (click === "ignore") {
    if (!grantor()) return { kind: "ignore", reason: "unauthorized_grantor" };
    return {
      kind: "decide",
      request,
      decision: "rejected",
      actorId,
      reason: "ignored",
      ...(candidate.responseUrlId ? { responseUrlId: candidate.responseUrlId } : {}),
    };
  }

  if (!grantAllowsIntent(grant, click)) {
    return { kind: "ignore", reason: "grant_not_allowed" };
  }

  if (click === "full-access") {
    const isAdminRecipient = grant.adminUserIds.some((id) => id.toUpperCase() === actorId.toUpperCase());
    if (!isAdminRecipient) return { kind: "ignore", reason: "unauthorized_grantor" };
    if (!grantor("admin", "system", "*")) return { kind: "ignore", reason: "unauthorized_grantor" };
  } else if (!grantor()) {
    return { kind: "ignore", reason: "unauthorized_grantor" };
  }

  const scopeValue = candidate.scopeValue ?? getApprovalCardScope(request.id, actorId) ?? undefined;
  const resolved = grant.scopes.length > 0 ? resolveClickScope(grant, scopeValue ?? undefined) : null;
  if (grant.scopes.length > 0 && !resolved) {
    return { kind: "ignore", reason: "scope_not_allowed" };
  }

  return {
    kind: "decide",
    request,
    decision: "approved",
    actorId,
    ...(candidate.responseUrlId ? { responseUrlId: candidate.responseUrlId } : {}),
    grant: { intent: click, scope: resolved?.scopeValue ?? null },
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
  readonly responseUrlId?: string;
  readonly grantClick?: SlackPermissionGrantClick;
  readonly scopeValue?: string;
}

function parseApprovalCandidate(event: ApprovalInboundEvent): ApprovalCandidate | null {
  if (event.topic === "ravi.inbound.interaction") {
    const actionId = stringField(event.data, "actionId");
    const grantClick = slackPermissionGrantClickFromActionId(actionId);
    if (grantClick) {
      const value = stringField(event.data, "value");
      const selectedOption = stringField(event.data, "selectedOption");
      const parsed = parseSlackGrantActionValue(selectedOption ?? value);
      return {
        requestId: parsed.requestId,
        messageId: stringField(event.data, "messageTs"),
        accountId: stringField(event.data, "accountId"),
        chatId: stringField(event.data, "channelId"),
        instanceId: stringField(event.data, "instanceId"),
        actorId: stringField(event.data, "userId"),
        channel: SLACK_CHANNEL,
        decision: grantClick === "ignore" ? "rejected" : "approved",
        grantClick,
        ...(parsed.scope ? { scopeValue: parsed.scope } : {}),
        responseUrlId: stringField(event.data, "responseUrlId"),
      };
    }

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
      responseUrlId: stringField(event.data, "responseUrlId"),
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

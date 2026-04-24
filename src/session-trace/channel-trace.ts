import type { MessageTarget, ResponseMessage } from "../runtime/message-types.js";
import { getSessionByName } from "../router/index.js";
import { dbFindChat, dbGetMessageMeta, dbGetSessionChatBinding, type ChatType } from "../router/router-db.js";
import { recordSessionEvent } from "./session-trace-db.js";
import type { SessionEventRecord } from "./types.js";

export interface NormalizedSessionTraceSource {
  channel: string | null;
  accountId: string | null;
  instanceId: string | null;
  chatId: string | null;
  threadId: string | null;
  messageId: string | null;
  canonicalChatId: string | null;
  actorType: string | null;
  contactId: string | null;
  actorAgentId: string | null;
  platformIdentityId: string | null;
  rawSenderId: string | null;
  normalizedSenderId: string | null;
  identityConfidence: number | null;
  identityProvenance: unknown;
}

export interface RecordChannelMessageReceivedTraceInput {
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  timestamp?: number;
  source: NormalizedSessionTraceSource;
  payloadJson?: unknown;
  preview?: string | null;
}

export interface RecordRouteResolvedTraceInput {
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  timestamp?: number;
  source: NormalizedSessionTraceSource;
  payloadJson?: unknown;
}

export interface RecordPromptPublishedTraceInput {
  sessionName: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

export interface RecordResponseEmittedTraceInput {
  sessionName: string;
  response: ResponseMessage;
  timestamp?: number;
}

export interface RecordDeliveryTraceInput {
  sessionName: string;
  response?: ResponseMessage | null;
  delivery: Record<string, unknown>;
  timestamp?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function normalizeSourceChannel(value: unknown): string | null {
  return cleanText(value)?.replace(/-baileys$/, "") ?? null;
}

function previewText(value: unknown, maxLength = 500): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sourceFromTarget(value: unknown): NormalizedSessionTraceSource {
  if (!isRecord(value)) return emptySource();

  return {
    channel: normalizeSourceChannel(value.channel),
    accountId: cleanText(value.accountId),
    instanceId: cleanText(value.instanceId),
    chatId: cleanText(value.chatId),
    threadId: cleanText(value.threadId),
    messageId: cleanText(value.sourceMessageId),
    canonicalChatId: cleanText(value.canonicalChatId),
    actorType: cleanText(value.actorType),
    contactId: cleanText(value.contactId),
    actorAgentId: cleanText(value.actorAgentId),
    platformIdentityId: cleanText(value.platformIdentityId),
    rawSenderId: cleanText(value.rawSenderId),
    normalizedSenderId: cleanText(value.normalizedSenderId),
    identityConfidence: cleanNumber(value.identityConfidence),
    identityProvenance: cleanRecord(value.identityProvenance),
  };
}

function sourceFromContext(value: unknown): NormalizedSessionTraceSource {
  if (!isRecord(value)) return emptySource();

  return {
    channel: normalizeSourceChannel(value.channelId),
    accountId: cleanText(value.accountId),
    instanceId: cleanText(value.instanceId),
    chatId: cleanText(value.chatId),
    threadId: cleanText(value.threadId),
    messageId: cleanText(value.messageId),
    canonicalChatId: cleanText(value.canonicalChatId),
    actorType: cleanText(value.actorType),
    contactId: cleanText(value.contactId),
    actorAgentId: cleanText(value.actorAgentId),
    platformIdentityId: cleanText(value.platformIdentityId),
    rawSenderId: cleanText(value.rawSenderId),
    normalizedSenderId: cleanText(value.normalizedSenderId),
    identityConfidence: cleanNumber(value.identityConfidence),
    identityProvenance: cleanRecord(value.identityProvenance),
  };
}

function emptySource(): NormalizedSessionTraceSource {
  return {
    channel: null,
    accountId: null,
    instanceId: null,
    chatId: null,
    threadId: null,
    messageId: null,
    canonicalChatId: null,
    actorType: null,
    contactId: null,
    actorAgentId: null,
    platformIdentityId: null,
    rawSenderId: null,
    normalizedSenderId: null,
    identityConfidence: null,
    identityProvenance: null,
  };
}

function mergeSourceMetadata(
  source: NormalizedSessionTraceSource,
  context: NormalizedSessionTraceSource,
): NormalizedSessionTraceSource {
  return {
    channel: source.channel ?? context.channel,
    accountId: source.accountId ?? context.accountId,
    instanceId: source.instanceId ?? context.instanceId,
    chatId: source.chatId ?? context.chatId,
    threadId: source.threadId ?? context.threadId,
    messageId: source.messageId ?? context.messageId,
    canonicalChatId: source.canonicalChatId ?? context.canonicalChatId,
    actorType: source.actorType ?? context.actorType,
    contactId: source.contactId ?? context.contactId,
    actorAgentId: source.actorAgentId ?? context.actorAgentId,
    platformIdentityId: source.platformIdentityId ?? context.platformIdentityId,
    rawSenderId: source.rawSenderId ?? context.rawSenderId,
    normalizedSenderId: source.normalizedSenderId ?? context.normalizedSenderId,
    identityConfidence: source.identityConfidence ?? context.identityConfidence,
    identityProvenance: source.identityProvenance ?? context.identityProvenance,
  };
}

function withOutboundAgentActor(
  source: NormalizedSessionTraceSource,
  agentId: string | null | undefined,
): NormalizedSessionTraceSource {
  return {
    ...source,
    actorType: agentId ? "agent" : source.actorType,
    contactId: null,
    actorAgentId: agentId ?? source.actorAgentId,
    platformIdentityId: null,
    rawSenderId: null,
    normalizedSenderId: null,
    identityConfidence: null,
    identityProvenance: agentId ? { source: "ravi.outbound", agentId } : source.identityProvenance,
  };
}

export function normalizeSessionTraceSource(input: {
  source?: unknown;
  target?: unknown;
  context?: unknown;
}): NormalizedSessionTraceSource {
  const source = sourceFromTarget(input.target ?? input.source);
  const context = sourceFromContext(input.context);

  return mergeSourceMetadata(source, context);
}

function inferSourceChatType(source: NormalizedSessionTraceSource): ChatType | undefined {
  if (source.threadId) return "thread";
  if (source.chatId?.endsWith("@g.us") || source.chatId?.startsWith("group:")) return "group";
  return undefined;
}

function findCanonicalChatIdFromSource(source: NormalizedSessionTraceSource): string | null {
  if (!source.channel || !source.chatId) return null;
  const platformChatId = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
  const instanceCandidates = Array.from(
    new Set([source.instanceId, source.accountId, ""].filter((id): id is string => Boolean(id))),
  );
  for (const instanceId of instanceCandidates) {
    const chat = dbFindChat({
      channel: source.channel,
      instanceId,
      platformChatId,
      chatType: inferSourceChatType(source),
    });
    if (chat) return chat.id;
  }
  return null;
}

function resolveCanonicalTraceSource(
  sessionKey: string,
  source: NormalizedSessionTraceSource,
): NormalizedSessionTraceSource {
  const messageMeta = source.messageId ? dbGetMessageMeta(source.messageId) : null;
  const chatIdFromSource = findCanonicalChatIdFromSource(source);
  const binding = dbGetSessionChatBinding(sessionKey);
  // Legacy fallback removal condition: remove binding/raw lookup once all prompt/response/delivery sources
  // carry canonicalChatId plus per-message actor metadata at emit time.
  const canonicalChatId =
    source.canonicalChatId ?? messageMeta?.canonicalChatId ?? chatIdFromSource ?? binding?.chatId ?? null;
  const sourceIsAgentActor = source.actorType === "agent";

  return {
    ...source,
    canonicalChatId,
    actorType: source.actorType ?? messageMeta?.actorType ?? null,
    contactId: sourceIsAgentActor ? null : (source.contactId ?? messageMeta?.contactId ?? null),
    actorAgentId: source.actorAgentId ?? messageMeta?.agentId ?? null,
    platformIdentityId: sourceIsAgentActor
      ? source.platformIdentityId
      : (source.platformIdentityId ?? messageMeta?.platformIdentityId ?? null),
    rawSenderId: sourceIsAgentActor ? source.rawSenderId : (source.rawSenderId ?? messageMeta?.rawSenderId ?? null),
    normalizedSenderId: sourceIsAgentActor
      ? source.normalizedSenderId
      : (source.normalizedSenderId ?? messageMeta?.normalizedSenderId ?? null),
    identityConfidence: sourceIsAgentActor
      ? source.identityConfidence
      : (source.identityConfidence ?? messageMeta?.identityConfidence ?? null),
    identityProvenance: source.identityProvenance ?? messageMeta?.identityProvenance ?? null,
  };
}

function eventSourceFields(sessionKey: string, source: NormalizedSessionTraceSource) {
  const resolved = resolveCanonicalTraceSource(sessionKey, source);
  return {
    sourceChannel: resolved.channel,
    sourceAccountId: resolved.accountId,
    sourceChatId: resolved.chatId,
    sourceThreadId: resolved.threadId,
    canonicalChatId: resolved.canonicalChatId,
    actorType: resolved.actorType,
    contactId: resolved.contactId,
    actorAgentId: resolved.actorAgentId,
    platformIdentityId: resolved.platformIdentityId,
    rawSenderId: resolved.rawSenderId,
    normalizedSenderId: resolved.normalizedSenderId,
    identityConfidence: resolved.identityConfidence,
    identityProvenance: resolved.identityProvenance,
    messageId: resolved.messageId,
  };
}

function recordSourceEvent(input: {
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  eventType: string;
  eventGroup: "channel" | "routing";
  status: string;
  timestamp?: number;
  source: NormalizedSessionTraceSource;
  payloadJson?: unknown;
  preview?: string | null;
}): SessionEventRecord {
  const sourceFields = eventSourceFields(input.sessionKey, input.source);
  return recordSessionEvent({
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    agentId: input.agentId,
    eventType: input.eventType,
    eventGroup: input.eventGroup,
    status: input.status,
    timestamp: input.timestamp,
    ...sourceFields,
    payloadJson: input.payloadJson,
    preview: input.preview,
  });
}

export function recordChannelMessageReceivedTrace(input: RecordChannelMessageReceivedTraceInput): SessionEventRecord {
  return recordSourceEvent({
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    agentId: input.agentId,
    eventType: "channel.message.received",
    eventGroup: "channel",
    status: "received",
    timestamp: input.timestamp,
    source: input.source,
    payloadJson: input.payloadJson,
    preview: input.preview,
  });
}

export function recordRouteResolvedTrace(input: RecordRouteResolvedTraceInput): SessionEventRecord {
  return recordSourceEvent({
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    agentId: input.agentId,
    eventType: "route.resolved",
    eventGroup: "routing",
    status: "resolved",
    timestamp: input.timestamp,
    source: input.source,
    payloadJson: input.payloadJson,
  });
}

export function recordPromptPublishedTrace(input: RecordPromptPublishedTraceInput): SessionEventRecord | null {
  const session = getSessionByName(input.sessionName);
  if (!session) return null;

  const payload = input.payload;
  const source = normalizeSessionTraceSource({
    source: payload.source,
    context: payload.context,
  });
  const sourceFields = eventSourceFields(session.sessionKey, source);
  const prompt = cleanText(payload.prompt);

  return recordSessionEvent({
    sessionKey: session.sessionKey,
    sessionName: input.sessionName,
    agentId: cleanText(payload._agentId) ?? session.agentId,
    eventType: "prompt.published",
    eventGroup: "prompt",
    status: "published",
    timestamp: input.timestamp,
    ...sourceFields,
    payloadJson: {
      deliveryBarrier: payload.deliveryBarrier,
      taskBarrierTaskId: payload.taskBarrierTaskId,
      source: payload.source,
      context: payload.context,
      promptChars: prompt?.length ?? 0,
    },
    preview: previewText(prompt),
  });
}

export function recordResponseEmittedTrace(input: RecordResponseEmittedTraceInput): SessionEventRecord | null {
  const session = getSessionByName(input.sessionName);
  if (!session) return null;

  const source = withOutboundAgentActor(
    normalizeSessionTraceSource({ target: input.response.target }),
    session.agentId,
  );
  const sourceFields = eventSourceFields(session.sessionKey, source);
  const responseText = input.response.error ? `Error: ${input.response.error}` : input.response.response;

  return recordSessionEvent({
    sessionKey: session.sessionKey,
    sessionName: input.sessionName,
    agentId: session.agentId,
    eventType: "response.emitted",
    eventGroup: "response",
    status: "emitted",
    timestamp: input.timestamp,
    ...sourceFields,
    payloadJson: {
      emitId: input.response._emitId,
      target: input.response.target,
      textLen: responseText?.length ?? 0,
      hasError: Boolean(input.response.error),
    },
    preview: previewText(responseText),
    error: input.response.error,
  });
}

export function recordDeliveryTrace(input: RecordDeliveryTraceInput): SessionEventRecord | null {
  const session = getSessionByName(input.sessionName);
  if (!session) return null;

  const status = cleanText(input.delivery.status) ?? "unknown";
  const knownStatus = status === "delivered" || status === "failed" || status === "dropped";
  const eventType = knownStatus ? `delivery.${status}` : "delivery.observed";
  const target = input.delivery.target ?? input.response?.target;
  const source = withOutboundAgentActor(normalizeSessionTraceSource({ target }), session.agentId);
  const sourceFields = eventSourceFields(session.sessionKey, source);
  const outboundMessageId = cleanText(input.delivery.messageId);
  const durationMs = cleanNumber(input.delivery.durationMs);
  const reason = cleanText(input.delivery.reason);
  const error = cleanText(input.delivery.error);

  return recordSessionEvent({
    sessionKey: session.sessionKey,
    sessionName: input.sessionName,
    agentId: session.agentId,
    eventType,
    eventGroup: "delivery",
    status,
    timestamp: input.timestamp,
    ...sourceFields,
    durationMs,
    error,
    payloadJson: {
      status,
      reason,
      emitId: input.delivery.emitId ?? input.response?._emitId,
      deliveryMessageId: outboundMessageId,
      target,
      textLen: input.delivery.textLen,
      deliveredAt: input.delivery.deliveredAt,
      instanceId: input.delivery.instanceId,
      channelChatId: input.delivery.chatId,
    },
    preview: reason ?? outboundMessageId,
  });
}

export function withSourceMessageId<T extends MessageTarget>(target: T, sourceMessageId: string | undefined): T {
  if (!sourceMessageId) return target;
  return { ...target, sourceMessageId };
}

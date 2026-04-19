import type { MessageTarget, ResponseMessage } from "../runtime/message-types.js";
import { getSessionByName } from "../router/index.js";
import { recordSessionEvent } from "./session-trace-db.js";
import type { SessionEventRecord } from "./types.js";

export interface NormalizedSessionTraceSource {
  channel: string | null;
  accountId: string | null;
  chatId: string | null;
  threadId: string | null;
  messageId: string | null;
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
    chatId: cleanText(value.chatId),
    threadId: cleanText(value.threadId),
    messageId: cleanText(value.sourceMessageId),
  };
}

function sourceFromContext(value: unknown): NormalizedSessionTraceSource {
  if (!isRecord(value)) return emptySource();

  return {
    channel: normalizeSourceChannel(value.channelId),
    accountId: cleanText(value.accountId),
    chatId: cleanText(value.chatId),
    threadId: cleanText(value.threadId),
    messageId: cleanText(value.messageId),
  };
}

function emptySource(): NormalizedSessionTraceSource {
  return {
    channel: null,
    accountId: null,
    chatId: null,
    threadId: null,
    messageId: null,
  };
}

export function normalizeSessionTraceSource(input: {
  source?: unknown;
  target?: unknown;
  context?: unknown;
}): NormalizedSessionTraceSource {
  const source = sourceFromTarget(input.target ?? input.source);
  const context = sourceFromContext(input.context);

  return {
    channel: source.channel ?? context.channel,
    accountId: source.accountId ?? context.accountId,
    chatId: source.chatId ?? context.chatId,
    threadId: source.threadId ?? context.threadId,
    messageId: source.messageId ?? context.messageId,
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
  return recordSessionEvent({
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    agentId: input.agentId,
    eventType: input.eventType,
    eventGroup: input.eventGroup,
    status: input.status,
    timestamp: input.timestamp,
    sourceChannel: input.source.channel,
    sourceAccountId: input.source.accountId,
    sourceChatId: input.source.chatId,
    sourceThreadId: input.source.threadId,
    messageId: input.source.messageId,
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
  const prompt = cleanText(payload.prompt);

  return recordSessionEvent({
    sessionKey: session.sessionKey,
    sessionName: input.sessionName,
    agentId: cleanText(payload._agentId) ?? session.agentId,
    eventType: "prompt.published",
    eventGroup: "prompt",
    status: "published",
    timestamp: input.timestamp,
    sourceChannel: source.channel,
    sourceAccountId: source.accountId,
    sourceChatId: source.chatId,
    sourceThreadId: source.threadId,
    messageId: source.messageId,
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

  const source = normalizeSessionTraceSource({ target: input.response.target });
  const responseText = input.response.error ? `Error: ${input.response.error}` : input.response.response;

  return recordSessionEvent({
    sessionKey: session.sessionKey,
    sessionName: input.sessionName,
    agentId: session.agentId,
    eventType: "response.emitted",
    eventGroup: "response",
    status: "emitted",
    timestamp: input.timestamp,
    sourceChannel: source.channel,
    sourceAccountId: source.accountId,
    sourceChatId: source.chatId,
    sourceThreadId: source.threadId,
    messageId: source.messageId,
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
  const source = normalizeSessionTraceSource({ target });
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
    sourceChannel: source.channel,
    sourceAccountId: source.accountId,
    sourceChatId: source.chatId,
    sourceThreadId: source.threadId,
    messageId: source.messageId,
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

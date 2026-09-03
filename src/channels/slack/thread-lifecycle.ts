import { randomUUID } from "node:crypto";
import { nats } from "../../nats.js";
import { publishSessionPrompt, type PublishSessionPromptOptions } from "../../omni/session-stream.js";
import { publishChannelSessionPrompt } from "../session-prompt.js";
import {
  attachChatToSession,
  ensureUniqueName,
  generateThreadForkSessionName,
  getOrCreateSession,
  getSession,
  updateSessionContext,
  updateSessionModelOverride,
  updateSessionName,
  updateSessionSource,
  updateSessionThreadId,
} from "../../router/index.js";
import { dbFindChat, dbGetChat, dbGetSessionDefaultChatId, dbUpsertChat } from "../../router/router-db.js";
import type { SessionEntry } from "../../router/types.js";
import type {
  ChannelTurnAction,
  MessageContext,
  MessageTarget,
  RuntimeTurnOriginPrincipal,
} from "../../runtime/message-types.js";
import { logger } from "../../utils/logger.js";
import {
  claimSlackThreadCreation,
  claimSlackThreadParentReturn,
  closeSlackThreadLifecycle,
  completeSlackThreadCreation,
  completeSlackThreadParentReturn,
  findSlackThreadLifecycleByChildSession,
  getSlackThreadLifecycle,
  listPendingSlackThreadCreations,
  listPendingSlackThreadParentReturns,
  registerInboundSlackThread,
  releaseSlackThreadCreationClaim,
  releaseSlackThreadParentReturnClaim,
  type CloseSlackThreadLifecycleResult,
  type SlackThreadLifecycleRecord,
} from "./thread-lifecycle-store.js";

const log = logger.child("channels:slack:thread-lifecycle");
const SLACK_THREAD_CREATED_TOPIC = "ravi.inbound.thread.created";
const SLACK_THREAD_CLOSED_TOPIC = "ravi.session.thread.closed";

type PromptPublisher = (
  sessionName: string,
  payload: Record<string, unknown>,
  options?: PublishSessionPromptOptions,
) => Promise<void>;
type EventPublisher = (topic: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface SlackThreadLifecycleDependencies {
  publishPrompt: PromptPublisher;
  publishEvent: EventPublisher;
}

const DEFAULT_DEPENDENCIES: SlackThreadLifecycleDependencies = {
  publishPrompt: publishSessionPrompt,
  publishEvent: nats.emit,
};

export interface FinalizeSlackThreadCreationResult {
  status: "opened" | "ignored";
  requestId: string;
  childSessionKey?: string;
  childSessionName?: string;
  providerThreadId?: string;
}

export interface CloseSlackThreadResult extends CloseSlackThreadLifecycleResult {
  parentReturnDelivered: boolean;
}

export async function handleSlackThreadCreationDelivery(
  data: Record<string, unknown>,
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<FinalizeSlackThreadCreationResult> {
  if (data.status !== "delivered" || data.actionId !== "thread.create") {
    return {
      status: "ignored",
      requestId: stringField(data, "requestId") ?? stringField(data, "jobId") ?? "",
    };
  }
  const requestId = stringField(data, "requestId") ?? stringField(data, "jobId");
  if (!requestId) {
    throw new Error("Slack thread create delivery is missing requestId");
  }
  return finalizeSlackThreadCreation(requestId, dependencies);
}

export async function finalizeSlackThreadCreation(
  requestId: string,
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<FinalizeSlackThreadCreationResult> {
  const claimId = randomUUID();
  const record = claimSlackThreadCreation({ requestId, claimId });
  if (!record) return { status: "ignored", requestId };

  try {
    const materialized = materializeSlackThreadChild(record);
    await publishChannelSessionPrompt(
      {
        sessionName: materialized.childSessionName,
        action: "session.bootstrap",
        principal: resolveChannelLifecyclePrincipal(
          "session.bootstrap",
          record.initiatorSessionKey ?? record.parentSessionKey,
          materialized.agentId,
        ),
        payload: buildSlackThreadInitialPrompt(record, materialized),
        options: {
          messageId: `slack-thread-start:${record.requestId}`,
        },
      },
      dependencies.publishPrompt,
    );
    const completed = completeSlackThreadCreation({
      requestId: record.requestId,
      claimId,
      childSessionKey: materialized.childSessionKey,
      childSessionName: materialized.childSessionName,
      threadCanonicalChatId: materialized.threadCanonicalChatId,
    });
    await dependencies
      .publishEvent(SLACK_THREAD_CREATED_TOPIC, buildSlackThreadCreatedEvent(completed, materialized.agentId))
      .catch((error) => {
        log.warn("Failed to publish programmatic Slack thread created event", {
          requestId,
          error: errorMessage(error),
        });
      });
    return {
      status: "opened",
      requestId,
      childSessionKey: materialized.childSessionKey,
      childSessionName: materialized.childSessionName,
      providerThreadId: record.providerThreadId,
    };
  } catch (error) {
    releaseSlackThreadCreationClaim({
      requestId,
      claimId,
      failureReason: errorMessage(error),
    });
    throw error;
  }
}

export async function reconcileSlackThreadLifecycle(
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ creations: number; parentReturns: number; failures: number }> {
  let creations = 0;
  let parentReturns = 0;
  let failures = 0;

  for (const record of listPendingSlackThreadCreations()) {
    try {
      const result = await finalizeSlackThreadCreation(record.requestId, dependencies);
      if (result.status === "opened") creations++;
    } catch (error) {
      failures++;
      log.warn("Failed to reconcile Slack thread creation", {
        requestId: record.requestId,
        error: errorMessage(error),
      });
    }
  }

  for (const record of listPendingSlackThreadParentReturns()) {
    try {
      const delivered = await deliverSlackThreadParentReturn(record.requestId, dependencies);
      if (delivered) parentReturns++;
    } catch (error) {
      failures++;
      log.warn("Failed to reconcile Slack thread parent return", {
        requestId: record.requestId,
        error: errorMessage(error),
      });
    }
  }

  return { creations, parentReturns, failures };
}

export function registerSlackThreadInboundLifecycle(input: {
  childSession: SessionEntry;
  accountId: string;
  instanceId: string;
  platformChatId: string;
  threadCanonicalChatId: string;
  providerThreadId: string;
  seenAt?: number;
}): SlackThreadLifecycleRecord {
  const parentSessionKey = slackThreadParentSessionKey(input.childSession.sessionKey);
  if (!parentSessionKey || parentSessionKey === input.childSession.sessionKey) {
    throw new Error(`Session is not a Slack thread child: ${input.childSession.sessionKey}`);
  }
  const parent = getSession(parentSessionKey);
  if (!parent) throw new Error(`Slack thread parent session not found: ${parentSessionKey}`);
  const childSessionName = input.childSession.name ?? input.childSession.sessionKey;
  const parentSessionName = parent.name ?? parent.sessionKey;
  const rootChat = dbFindChat({
    channel: "slack",
    instanceId: input.instanceId,
    platformChatId: input.platformChatId,
  });
  return registerInboundSlackThread({
    parentSessionKey,
    parentSessionName,
    childSessionKey: input.childSession.sessionKey,
    childSessionName,
    accountId: input.accountId,
    instanceId: input.instanceId,
    platformChatId: input.platformChatId,
    rootCanonicalChatId: rootChat?.id,
    threadCanonicalChatId: input.threadCanonicalChatId,
    providerThreadId: input.providerThreadId,
    seenAt: input.seenAt,
  });
}

export function ensureSlackThreadLifecycleForSession(session: SessionEntry): SlackThreadLifecycleRecord {
  const existing = findSlackThreadLifecycleByChildSession(session.sessionKey);
  if (existing) return existing;

  const chatId = dbGetSessionDefaultChatId(session.sessionKey);
  const chat = chatId ? dbGetChat(chatId) : null;
  if (!chat || chat.channel.toLowerCase() !== "slack" || chat.chatType !== "thread") {
    throw new Error(`Session is not attached to a Slack thread: ${session.name ?? session.sessionKey}`);
  }
  const threadIdentity = splitSlackThreadPlatformChatId(chat.platformChatId);
  if (!threadIdentity) {
    throw new Error(`Slack thread chat has invalid platform id: ${chat.platformChatId}`);
  }
  const parentSessionKey = slackThreadParentSessionKey(session.sessionKey);
  const parent = getSession(parentSessionKey);
  if (!parent || parent.sessionKey === session.sessionKey) {
    throw new Error(`Slack thread parent session not found: ${parentSessionKey}`);
  }
  const rootChat = dbFindChat({
    channel: "slack",
    instanceId: chat.instanceId,
    platformChatId: threadIdentity.platformChatId,
  });
  return registerInboundSlackThread({
    parentSessionKey: parent.sessionKey,
    parentSessionName: parent.name ?? parent.sessionKey,
    childSessionKey: session.sessionKey,
    childSessionName: session.name ?? session.sessionKey,
    accountId: session.lastAccountId ?? chat.instanceId,
    instanceId: chat.instanceId,
    platformChatId: threadIdentity.platformChatId,
    rootCanonicalChatId: rootChat?.id,
    threadCanonicalChatId: chat.id,
    providerThreadId: threadIdentity.providerThreadId,
  });
}

export async function closeSlackThread(
  session: SessionEntry,
  returnResult?: string,
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<CloseSlackThreadResult> {
  const existing = ensureSlackThreadLifecycleForSession(session);
  if (existing.parentReturnRequested && existing.parentNotifiedAt === undefined) {
    const delivered = await deliverSlackThreadParentReturn(existing.requestId, dependencies);
    const refreshed = getSlackThreadLifecycle(existing.requestId);
    if (!delivered && refreshed?.parentNotifiedAt === undefined) {
      throw new Error(`Previous Slack thread parent return is still pending: ${existing.requestId}`);
    }
  }
  const closed = closeSlackThreadLifecycle({
    childSessionKey: session.sessionKey,
    returnResult,
  });

  if (closed.changed) {
    await dependencies
      .publishEvent(SLACK_THREAD_CLOSED_TOPIC, buildSlackThreadClosedEvent(closed.record))
      .catch((error) => {
        log.warn("Failed to publish Slack thread closed event", {
          requestId: closed.record.requestId,
          error: errorMessage(error),
        });
      });
  }

  let parentReturnDelivered = false;
  if (closed.record.parentReturnRequested) {
    try {
      parentReturnDelivered = await deliverSlackThreadParentReturn(closed.record.requestId, dependencies);
    } catch (error) {
      log.warn("Slack thread closed with parent return pending reconciliation", {
        requestId: closed.record.requestId,
        error: errorMessage(error),
      });
    }
  }
  return { ...closed, parentReturnDelivered };
}

export async function deliverSlackThreadParentReturn(
  requestId: string,
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<boolean> {
  const claimId = randomUUID();
  const record = claimSlackThreadParentReturn({ requestId, claimId });
  if (!record) return false;

  try {
    const parent = getSession(record.parentSessionKey);
    if (!parent) throw new Error(`Slack thread parent session not found: ${record.parentSessionKey}`);
    if (!record.closeResult || !record.parentEventId || !record.providerThreadId) {
      throw new Error(`Slack thread parent return is incomplete: ${record.requestId}`);
    }
    const rootChat =
      (record.rootCanonicalChatId ? dbGetChat(record.rootCanonicalChatId) : null) ??
      dbFindChat({
        channel: "slack",
        instanceId: record.instanceId,
        platformChatId: record.platformChatId,
      });
    const source: MessageTarget = {
      channel: "slack",
      accountId: record.accountId,
      instanceId: record.instanceId,
      chatId: record.platformChatId,
      ...(rootChat ? { canonicalChatId: rootChat.id } : {}),
      sourceMessageId: record.providerThreadId,
      actorType: "system",
      suppressPresence: true,
    };
    await publishChannelSessionPrompt(
      {
        sessionName: parent.name ?? parent.sessionKey,
        action: "session.return",
        principal: resolveChannelLifecyclePrincipal("session.return", record.childSessionKey),
        payload: {
          prompt: [
            `[System] Inform: Slack thread ${record.providerThreadId} concluída.`,
            `Resultado: ${record.closeResult}`,
          ].join("\n"),
          source,
          deliveryBarrier: "after_tool",
          deliveryBarrierSource: "default",
          _slackThreadLifecycle: {
            eventId: record.parentEventId,
            eventType: "thread.closed",
            requestId: record.requestId,
            parentSessionKey: record.parentSessionKey,
            childSessionKey: record.childSessionKey,
            childSessionName: record.childSessionName,
            providerThreadId: record.providerThreadId,
            result: record.closeResult,
            closeSequence: record.closeSequence,
          },
        },
        options: { messageId: record.parentEventId },
      },
      dependencies.publishPrompt,
    );
    completeSlackThreadParentReturn({ requestId, claimId });
    return true;
  } catch (error) {
    releaseSlackThreadParentReturnClaim({
      requestId,
      claimId,
      failureReason: errorMessage(error),
    });
    throw error;
  }
}

export function slackThreadParentSessionKey(sessionKey: string): string {
  const index = sessionKey.indexOf(":thread:");
  return index === -1 ? sessionKey : sessionKey.slice(0, index);
}

export function splitSlackThreadPlatformChatId(
  platformChatId: string,
): { platformChatId: string; providerThreadId: string } | null {
  const separator = platformChatId.indexOf("#");
  if (separator <= 0) return null;
  const root = platformChatId.slice(0, separator).trim();
  const thread = platformChatId.slice(separator + 1).trim();
  return root && thread ? { platformChatId: root, providerThreadId: thread } : null;
}

function materializeSlackThreadChild(record: SlackThreadLifecycleRecord): {
  childSessionKey: string;
  childSessionName: string;
  threadCanonicalChatId: string;
  agentId: string;
} {
  if (!record.providerThreadId || !record.initialPrompt) {
    throw new Error(`Slack thread creation is not ready: ${record.requestId}`);
  }
  const parent = getSession(record.parentSessionKey);
  if (!parent) throw new Error(`Slack thread parent session not found: ${record.parentSessionKey}`);
  const childSessionKey = `${parent.sessionKey}:thread:${record.providerThreadId}`;
  const existingChild = getSession(childSessionKey);
  const childSessionName =
    existingChild?.name ??
    ensureUniqueName(generateThreadForkSessionName(parent.name ?? parent.sessionKey, record.providerThreadId));
  const isGroup = !record.platformChatId.startsWith("D");
  const child = getOrCreateSession(childSessionKey, parent.agentId, parent.agentCwd, {
    name: childSessionName,
    chatType: parent.chatType,
    channel: "slack",
    ...(parent.accountId ? { accountId: parent.accountId } : {}),
    ...(isGroup ? { groupId: record.platformChatId } : {}),
    lastChannel: "slack",
    lastAccountId: record.accountId,
    lastTo: record.platformChatId,
    lastThreadId: record.providerThreadId,
    ...(record.modelOverride ? { modelOverride: record.modelOverride } : {}),
  });
  if (!child.name) updateSessionName(child.sessionKey, childSessionName);
  if (record.modelOverride) updateSessionModelOverride(child.sessionKey, record.modelOverride);
  updateSessionSource(child.sessionKey, {
    channel: "slack",
    accountId: record.accountId,
    chatId: record.platformChatId,
  });
  updateSessionThreadId(child.sessionKey, record.providerThreadId);

  const threadChat = dbUpsertChat({
    channel: "slack",
    instanceId: record.instanceId,
    platformChatId: `${record.platformChatId}#${record.providerThreadId}`,
    chatType: "thread",
    title: record.platformChatId,
    rawProvenance: {
      source: "ravi.chat_action",
      requestId: record.requestId,
      channelId: record.platformChatId,
      threadTs: record.providerThreadId,
      parentSessionKey: record.parentSessionKey,
    },
  });
  attachChatToSession({
    sessionKey: child.sessionKey,
    chatId: threadChat.id,
    role: "primary",
    attachedByType: "agent",
    attachedById: record.initiatorSessionKey ?? record.parentSessionKey,
    attachedReason: "slack-thread-create-action",
    setOutputTarget: true,
  });
  const context = buildSlackThreadMessageContext(record, threadChat.id, child.agentId);
  updateSessionContext(child.sessionKey, context);
  return {
    childSessionKey: child.sessionKey,
    childSessionName: child.name ?? childSessionName,
    threadCanonicalChatId: threadChat.id,
    agentId: child.agentId,
  };
}

function buildSlackThreadInitialPrompt(
  record: SlackThreadLifecycleRecord,
  materialized: {
    childSessionKey: string;
    childSessionName: string;
    threadCanonicalChatId: string;
    agentId: string;
  },
): Record<string, unknown> {
  const providerThreadId = record.providerThreadId!;
  const source: MessageTarget = {
    channel: "slack",
    accountId: record.accountId,
    instanceId: record.instanceId,
    chatId: record.platformChatId,
    canonicalChatId: materialized.threadCanonicalChatId,
    threadId: providerThreadId,
    sourceMessageId: providerThreadId,
    actorType: "agent",
    actorAgentId: materialized.agentId,
  };
  return {
    prompt: `[System] Execute: [from: ${record.parentSessionName}] ${record.initialPrompt}`,
    source,
    context: buildSlackThreadMessageContext(record, materialized.threadCanonicalChatId, materialized.agentId),
    deliveryBarrier: "after_tool",
    deliveryBarrierSource: "default",
    _slackThreadLifecycle: {
      eventType: "thread.created",
      source: "ravi.chat_action",
      requestId: record.requestId,
      parentSessionKey: record.parentSessionKey,
      parentSessionName: record.parentSessionName,
      childSessionKey: materialized.childSessionKey,
      childSessionName: materialized.childSessionName,
      providerThreadId,
      modelOverride: record.modelOverride ?? null,
    },
  };
}

function buildSlackThreadMessageContext(
  record: SlackThreadLifecycleRecord,
  canonicalChatId: string,
  agentId: string,
): MessageContext {
  const providerThreadId = record.providerThreadId!;
  const isGroup = !record.platformChatId.startsWith("D");
  return {
    channelId: "slack",
    channelName: "Slack",
    accountId: record.accountId,
    instanceId: record.instanceId,
    chatId: record.platformChatId,
    canonicalChatId,
    messageId: providerThreadId,
    senderId: record.parentSessionKey,
    senderName: record.parentSessionName,
    actorType: "agent",
    actorAgentId: agentId,
    isGroup,
    groupId: isGroup ? record.platformChatId : undefined,
    groupName: isGroup ? record.platformChatId : undefined,
    timestamp: record.updatedAt,
  };
}

function buildSlackThreadCreatedEvent(record: SlackThreadLifecycleRecord, agentId: string): Record<string, unknown> {
  return {
    provider: "slack",
    source: "ravi.chat_action",
    eventType: "thread.created",
    requestId: record.requestId,
    accountId: record.accountId,
    instanceId: record.instanceId,
    channelId: record.platformChatId,
    messageTs: record.providerThreadId,
    sourceMessageTs: record.providerThreadId,
    threadTs: record.providerThreadId,
    canonicalChatId: record.threadCanonicalChatId,
    sessionKey: record.childSessionKey,
    sessionName: record.childSessionName,
    agentId,
    parentSessionKey: record.parentSessionKey,
    parentSessionName: record.parentSessionName,
    modelOverride: record.modelOverride ?? null,
    createdAt: record.promptPublishedAt ?? Date.now(),
  };
}

function buildSlackThreadClosedEvent(record: SlackThreadLifecycleRecord): Record<string, unknown> {
  return {
    provider: "slack",
    source: "ravi.session_action",
    eventType: "thread.closed",
    requestId: record.requestId,
    eventId: record.parentEventId ?? `slack-thread-close:${record.requestId}:${record.closeSequence}`,
    accountId: record.accountId,
    instanceId: record.instanceId,
    channelId: record.platformChatId,
    threadTs: record.providerThreadId,
    parentSessionKey: record.parentSessionKey,
    parentSessionName: record.parentSessionName,
    childSessionKey: record.childSessionKey,
    childSessionName: record.childSessionName,
    result: record.closeResult ?? null,
    notifyParent: record.parentReturnRequested,
    closeSequence: record.closeSequence,
    closedAt: record.closedAt,
  };
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveChannelLifecyclePrincipal(
  action: ChannelTurnAction,
  sessionKey?: string,
  fallbackAgentId?: string,
): RuntimeTurnOriginPrincipal {
  const agentId = (sessionKey ? getSession(sessionKey)?.agentId : undefined) ?? fallbackAgentId;
  return agentId ? { type: "agent", id: agentId } : { type: "automation", id: `channels:${action}` };
}

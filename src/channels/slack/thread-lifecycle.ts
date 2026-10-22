import { randomUUID } from "node:crypto";
import { nats } from "../../nats.js";
import { publishSessionPrompt, type PublishSessionPromptOptions } from "../../omni/session-stream.js";
import { publishChannelSessionPrompt } from "../session-prompt.js";
import { publishChannelOutboundJobDurably } from "../outbound-publish-outbox.js";
import { buildChannelChatActionJob, type ChannelOutboundJob } from "../outbound-stream.js";
import {
  attachChatToSession,
  ensureUniqueName,
  generateThreadForkSessionName,
  getAgent,
  getOrCreateSession,
  getSession,
  loadRouterConfig,
  updateSessionContext,
  updateSessionEffortOverride,
  updateSessionModelOverride,
  updateSessionName,
  updateSessionRuntimeProviderOverride,
  updateSessionSource,
  updateSessionThinkingLevel,
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
import { buildSessionRelayTurnOrigin, type SessionRelayOriginContext } from "../../runtime/turn-origin.js";
import { resolveEffectiveSessionRuntime } from "../../runtime/runtime-selection.js";
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
  listSlackThreadLifecyclesByParent,
  registerInboundSlackThread,
  releaseSlackThreadCreationClaim,
  releaseSlackThreadParentReturnClaim,
  reopenSlackThreadLifecycle,
  type CloseSlackThreadLifecycleResult,
  type SlackThreadLifecycleRecord,
} from "./thread-lifecycle-store.js";
import type { SlackThreadCardState } from "./thread-card.js";

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
  /** Publishes the root card update; without it the card is left as is. */
  publishOutbound?: (job: ChannelOutboundJob) => Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: SlackThreadLifecycleDependencies = {
  publishPrompt: publishSessionPrompt,
  publishEvent: nats.emit,
  publishOutbound: publishChannelOutboundJobDurably,
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
    await updateSlackThreadCard(closed.record, { status: "closed", note: closed.record.closeResult }, dependencies);
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
    await publishChannelSessionPrompt(
      {
        sessionName: parent.name ?? parent.sessionKey,
        action: "session.return",
        principal: resolveChannelLifecyclePrincipal("session.return", record.childSessionKey),
        payload: {
          prompt: buildSlackThreadParentNotice(record, "concluída.", "Resultado", record.closeResult),
          source: buildSlackThreadParentSource(record, record.providerThreadId),
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

const SLACK_THREAD_TITLE_MAX_LENGTH = 80;
const SLACK_ID_PATTERN = /^[A-Z0-9]+$/;
const SLACK_TS_PATTERN = /^\d+\.\d+$/;

export interface SlackThreadRuntimeSummary {
  /** Values the child session resolves to right now (creation intent until it starts). */
  provider: string;
  providerSource: string;
  model: string | null;
  modelSource: string | null;
  effort: string;
  effortSource: string;
  thinking: string | null;
  thinkingSource: string | null;
  /** What the creation call asked for, before agent/global resolution. */
  requested: {
    provider: string | null;
    model: string | null;
    effort: string | null;
    thinking: string | null;
  };
}

export interface SlackThreadSummary {
  requestId: string;
  title: string | null;
  status: SlackThreadLifecycleRecord["status"];
  source: SlackThreadLifecycleRecord["source"];
  childSessionKey: string | null;
  childSessionName: string | null;
  slackThreadTs: string | null;
  link: string | null;
  runtime: SlackThreadRuntimeSummary;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  parentReturn: { requested: boolean; pending: boolean };
}

export interface SlackThreadReportResult {
  record: SlackThreadLifecycleRecord;
  messageId: string;
}

export interface SlackThreadSendResult {
  record: SlackThreadLifecycleRecord;
  reopened: boolean;
  messageId: string;
}

/** First non-empty line of the initial message, used to name a programmatic thread to its parent. */
export function slackThreadTitle(record: Pick<SlackThreadLifecycleRecord, "initialPrompt">): string | undefined {
  const line = record.initialPrompt
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > SLACK_THREAD_TITLE_MAX_LENGTH
    ? `${line.slice(0, SLACK_THREAD_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}

/**
 * Slack app link to the thread, when the workspace id is known from inbound
 * provenance. `slack://` opens the thread in the Slack app; an
 * `https://app.slack.com` link always opens the browser.
 */
export function slackThreadLink(record: SlackThreadLifecycleRecord): string | undefined {
  const channelId = record.platformChatId;
  const threadTs = record.providerThreadId;
  if (!threadTs || !SLACK_ID_PATTERN.test(channelId) || !SLACK_TS_PATTERN.test(threadTs)) return undefined;
  const chats = [
    record.rootCanonicalChatId ? dbGetChat(record.rootCanonicalChatId) : null,
    record.threadCanonicalChatId ? dbGetChat(record.threadCanonicalChatId) : null,
  ];
  const teamId = chats
    .map((chat) => chat?.rawProvenance?.teamId)
    .find((value): value is string => typeof value === "string" && SLACK_ID_PATTERN.test(value));
  return teamId ? `slack://channel?team=${teamId}&id=${channelId}&thread_ts=${threadTs}` : undefined;
}

export function summarizeSlackThread(record: SlackThreadLifecycleRecord): SlackThreadSummary {
  return {
    requestId: record.requestId,
    title: slackThreadTitle(record) ?? null,
    status: record.status,
    source: record.source,
    childSessionKey: record.childSessionKey ?? null,
    childSessionName: record.childSessionName ?? null,
    slackThreadTs: record.providerThreadId ?? null,
    link: slackThreadLink(record) ?? null,
    runtime: summarizeSlackThreadRuntime(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    closedAt: record.closedAt ?? null,
    parentReturn: {
      requested: record.parentReturnRequested,
      pending: record.parentReturnRequested && record.parentNotifiedAt === undefined,
    },
  };
}

/** What this thread is running: resolved from the child session once it exists. */
export function summarizeSlackThreadRuntime(record: SlackThreadLifecycleRecord): SlackThreadRuntimeSummary {
  const requested = {
    provider: record.providerOverride ?? null,
    model: record.modelOverride ?? null,
    effort: record.effortOverride ?? null,
    thinking: record.thinkingLevel ?? null,
  };
  const child = record.childSessionKey ? getSession(record.childSessionKey) : null;
  if (!child) {
    return {
      provider: requested.provider ?? "inherited",
      providerSource: requested.provider ? "thread_creation" : "unstarted",
      model: requested.model,
      modelSource: requested.model ? "thread_creation" : null,
      effort: requested.effort ?? "inherited",
      effortSource: requested.effort ? "thread_creation" : "unstarted",
      thinking: requested.thinking,
      thinkingSource: requested.thinking ? "thread_creation" : null,
      requested,
    };
  }
  const agent = getAgent(child.agentId) ?? loadRouterConfig().agents[child.agentId] ?? null;
  const resolved = resolveEffectiveSessionRuntime({ session: child, agent });
  return {
    provider: resolved.provider.value,
    providerSource: resolved.provider.source,
    model: resolved.model.value,
    modelSource: resolved.model.source,
    effort: resolved.effort.value,
    effortSource: resolved.effort.source,
    thinking: resolved.thinking.value ?? null,
    thinkingSource: resolved.thinking.source ?? null,
    requested,
  };
}

/** Compact label for a thread's requested runtime shape; undefined when nothing was pinned. */
export function slackThreadRuntimeLabel(input: {
  providerOverride?: string;
  modelOverride?: string;
  effortOverride?: string;
  thinkingLevel?: string;
}): string | undefined {
  const parts = [input.providerOverride, input.modelOverride, input.effortOverride, input.thinkingLevel]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Threads owned by the channel-root session of `session` (itself, or the parent of a thread child). */
export function listSlackThreadsForSession(
  session: SessionEntry,
  options: { includeClosed?: boolean } = {},
): { parentSessionKey: string; parentSessionName: string; threads: SlackThreadSummary[] } {
  const parentSessionKey = slackThreadParentSessionKey(session.sessionKey);
  const parent = parentSessionKey === session.sessionKey ? session : getSession(parentSessionKey);
  return {
    parentSessionKey,
    parentSessionName: parent?.name ?? parentSessionKey,
    threads: listSlackThreadLifecyclesByParent(parentSessionKey, { includeClosed: options.includeClosed }).map(
      summarizeSlackThread,
    ),
  };
}

/** Find one of a parent's threads by request id, thread session name or key, or Slack thread ts. */
export function findSlackThreadForParent(parentSessionKey: string, ref: string): SlackThreadLifecycleRecord | null {
  const normalized = ref.trim();
  if (!normalized) return null;
  const direct = getSlackThreadLifecycle(normalized);
  if (direct) return direct.parentSessionKey === parentSessionKey ? direct : null;
  return (
    listSlackThreadLifecyclesByParent(parentSessionKey, { includeClosed: true, limit: 500 }).find(
      (record) =>
        record.childSessionName === normalized ||
        record.childSessionKey === normalized ||
        record.providerThreadId === normalized,
    ) ?? null
  );
}

/** A thread child tells its parent session about progress without closing the thread. */
export async function reportSlackThreadProgress(
  session: SessionEntry,
  message: string,
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<SlackThreadReportResult> {
  const text = message.trim();
  if (!text) throw new Error("Report message is required");
  const record = ensureSlackThreadLifecycleForSession(session);
  if (!record.providerThreadId) throw new Error(`Slack thread has not started yet: ${record.requestId}`);
  const parent = getSession(record.parentSessionKey);
  if (!parent) throw new Error(`Slack thread parent session not found: ${record.parentSessionKey}`);
  const messageId = `slack-thread-report:${record.requestId}:${randomUUID()}`;
  await publishChannelSessionPrompt(
    {
      sessionName: parent.name ?? parent.sessionKey,
      action: "session.return",
      principal: resolveChannelLifecyclePrincipal("session.return", session.sessionKey),
      payload: {
        prompt: buildSlackThreadParentNotice(record, "reporta progresso.", "Progresso", text),
        source: buildSlackThreadParentSource(record, record.providerThreadId),
        deliveryBarrier: "after_tool",
        deliveryBarrierSource: "default",
        _slackThreadLifecycle: {
          eventId: messageId,
          eventType: "thread.report",
          requestId: record.requestId,
          parentSessionKey: record.parentSessionKey,
          childSessionKey: session.sessionKey,
          childSessionName: session.name ?? session.sessionKey,
          providerThreadId: record.providerThreadId,
        },
      },
      options: { messageId },
    },
    dependencies.publishPrompt,
  );
  await updateSlackThreadCard(record, { status: "open", note: text }, dependencies);
  return { record, messageId };
}

/**
 * The channel-root session sends new instructions to one of its threads. The
 * thread answers inside the Slack thread; a closed thread reopens.
 */
export async function sendSlackThreadMessage(
  input: {
    parentSession: SessionEntry;
    ref: string;
    message: string;
    /** Who is sending, for turn provenance; defaults to the parent session itself. */
    origin?: SessionRelayOriginContext;
  },
  dependencies: SlackThreadLifecycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<SlackThreadSendResult> {
  const text = input.message.trim();
  if (!text) throw new Error("Thread message is required");
  const parent = input.parentSession;
  if (slackThreadParentSessionKey(parent.sessionKey) !== parent.sessionKey) {
    throw new Error("Only the channel session that owns these threads can send to them; this session is a thread");
  }
  const found = findSlackThreadForParent(parent.sessionKey, input.ref);
  if (!found) throw new Error(`Slack thread not found for this session: ${input.ref}`);
  if (
    (found.status !== "open" && found.status !== "closed") ||
    !found.childSessionKey ||
    !found.providerThreadId ||
    !found.threadCanonicalChatId
  ) {
    throw new Error(`Slack thread has not started yet: ${found.requestId}`);
  }
  const child = getSession(found.childSessionKey);
  if (!child) throw new Error(`Slack thread session not found: ${found.childSessionKey}`);
  const reopened = found.status === "closed";
  const record = reopened ? reopenSlackThreadLifecycle(found.requestId) : found;
  const parentName = parent.name ?? parent.sessionKey;
  const messageId = `slack-thread-send:${record.requestId}:${randomUUID()}`;
  await dependencies.publishPrompt(
    child.name ?? child.sessionKey,
    {
      prompt: `[System] Execute: [from: ${parentName}] ${text}`,
      source: buildSlackThreadChildSource(record, found.threadCanonicalChatId, child.agentId),
      context: buildSlackThreadMessageContext(record, found.threadCanonicalChatId, child.agentId),
      deliveryBarrier: "after_tool",
      deliveryBarrierSource: "default",
      _slackThreadLifecycle: {
        eventId: messageId,
        eventType: "thread.message",
        requestId: record.requestId,
        parentSessionKey: parent.sessionKey,
        childSessionKey: child.sessionKey,
        childSessionName: child.name ?? child.sessionKey,
        providerThreadId: found.providerThreadId,
        reopened,
      },
      _turnOrigin: buildSessionRelayTurnOrigin(
        "execute",
        input.origin ?? { agentId: parent.agentId, sessionKey: parent.sessionKey, sessionName: parent.name },
      ),
    },
    { messageId },
  );
  if (reopened) await updateSlackThreadCard(record, { status: "reopened" }, dependencies);
  return { record, reopened, messageId };
}

/**
 * Re-render the root card of a thread Ravi opened (see thread-card.ts). A
 * thread a person started has their own message as root, which Ravi cannot
 * edit. Best effort: the lifecycle change already happened.
 */
async function updateSlackThreadCard(
  record: SlackThreadLifecycleRecord,
  state: Omit<SlackThreadCardState, "updatedAt" | "requestedBy">,
  dependencies: SlackThreadLifecycleDependencies,
): Promise<void> {
  const publish = dependencies.publishOutbound;
  if (!publish || record.source !== "action" || !record.initialPrompt || !record.providerThreadId) return;
  const job = buildChannelChatActionJob({
    sessionName: record.parentSessionName,
    requestId: `slack-thread-card:${record.requestId}:${randomUUID()}`,
    target: {
      channel: "slack",
      accountId: record.accountId,
      instanceId: record.instanceId,
      chatId: record.platformChatId,
      ...(record.rootCanonicalChatId ? { canonicalChatId: record.rootCanonicalChatId } : {}),
    },
    content: {
      type: "chat_action",
      actionId: "message.edit",
      providerMessageId: record.providerThreadId,
      text: record.initialPrompt,
      threadCard: {
        status: state.status,
        ...(state.note?.trim() ? { note: state.note.trim() } : {}),
        updatedAt: Date.now(),
        ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
        ...(slackThreadRuntimeLabel(record) ? { runtime: slackThreadRuntimeLabel(record) } : {}),
      },
    },
  });
  try {
    await publish(job);
  } catch (error) {
    log.warn("Failed to update Slack thread card", { requestId: record.requestId, error: errorMessage(error) });
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
    ...(record.providerOverride ? { runtimeProviderOverride: record.providerOverride } : {}),
    ...(record.effortOverride ? { effortOverride: record.effortOverride as SessionEntry["effortOverride"] } : {}),
    ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel as SessionEntry["thinkingLevel"] } : {}),
  });
  if (!child.name) updateSessionName(child.sessionKey, childSessionName);
  // Creation-time intent is applied once: a later materialization (reconcile after
  // a restart) must not stamp over values the operator changed on the child since.
  if (record.modelOverride && !child.modelOverride) updateSessionModelOverride(child.sessionKey, record.modelOverride);
  if (record.providerOverride && !child.runtimeProviderOverride)
    updateSessionRuntimeProviderOverride(
      child.sessionKey,
      record.providerOverride as SessionEntry["runtimeProviderOverride"],
    );
  if (record.effortOverride && !child.effortOverride)
    updateSessionEffortOverride(child.sessionKey, record.effortOverride as SessionEntry["effortOverride"]);
  if (record.thinkingLevel && !child.thinkingLevel) updateSessionThinkingLevel(child.sessionKey, record.thinkingLevel);
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
  return {
    prompt: `[System] Execute: [from: ${record.parentSessionName}] ${record.initialPrompt}`,
    source: buildSlackThreadChildSource(record, materialized.threadCanonicalChatId, materialized.agentId),
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
      providerOverride: record.providerOverride ?? null,
      effortOverride: record.effortOverride ?? null,
      thinkingLevel: record.thinkingLevel ?? null,
    },
  };
}

function buildSlackThreadChildSource(
  record: SlackThreadLifecycleRecord,
  threadCanonicalChatId: string,
  agentId: string,
): MessageTarget {
  const providerThreadId = record.providerThreadId!;
  return {
    channel: "slack",
    accountId: record.accountId,
    instanceId: record.instanceId,
    chatId: record.platformChatId,
    canonicalChatId: threadCanonicalChatId,
    threadId: providerThreadId,
    sourceMessageId: providerThreadId,
    actorType: "agent",
    actorAgentId: agentId,
  };
}

/** Parent turns from a thread reply at the channel root, never inside the thread. */
function buildSlackThreadParentSource(record: SlackThreadLifecycleRecord, providerThreadId: string): MessageTarget {
  const rootChat =
    (record.rootCanonicalChatId ? dbGetChat(record.rootCanonicalChatId) : null) ??
    dbFindChat({
      channel: "slack",
      instanceId: record.instanceId,
      platformChatId: record.platformChatId,
    });
  return {
    channel: "slack",
    accountId: record.accountId,
    instanceId: record.instanceId,
    chatId: record.platformChatId,
    ...(rootChat ? { canonicalChatId: rootChat.id } : {}),
    sourceMessageId: providerThreadId,
    actorType: "system",
    suppressPresence: true,
  };
}

function slackThreadLabel(record: SlackThreadLifecycleRecord): string {
  const name = record.childSessionName ?? record.providerThreadId ?? record.requestId;
  const title = slackThreadTitle(record);
  return title ? `"${title}" (${name})` : name;
}

function buildSlackThreadParentNotice(
  record: SlackThreadLifecycleRecord,
  headline: string,
  label: string,
  body: string,
): string {
  const link = slackThreadLink(record);
  return [
    `[System] Inform: Slack thread ${slackThreadLabel(record)} ${headline}`,
    ...(link ? [`Link: ${link}`] : []),
    `${label}: ${body}`,
  ].join("\n");
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
    providerOverride: record.providerOverride ?? null,
    effortOverride: record.effortOverride ?? null,
    thinkingLevel: record.thinkingLevel ?? null,
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

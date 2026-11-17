/**
 * Thread = run (contract F3): a Slack thread or a WhatsApp group bound to a
 * cloud run started with `ravi cloud runs start --bind-thread`.
 *
 * - The conversation key the Console stores is built here from the turn's
 *   chat: `slack:<instanceId>:<channelId>:<threadTs>` or
 *   `whatsapp:<instanceId>:<groupId>`.
 * - Slack: inside a thread, the run card is posted as a reply in it (a
 *   person's root message cannot be edited); outside one, the run card is
 *   posted first and becomes the thread root, so its ts is the key. The card
 *   is re-rendered in place on each `cloud_agents.run.thread` event, through
 *   the channel runner's `message.edit` with `threadCard` (Knowledge guard
 *   included).
 * - WhatsApp: the card is one message, posted once in the group where the
 *   person just wrote; replies to it and `@run` messages go to the run.
 * - The binding is the local row in `cloud_thread_runs`; it ends with the run.
 */

import { publishChannelOutboundJobDurably } from "../channels/outbound-publish-outbox.js";
import { buildChannelChatActionJob } from "../channels/outbound-stream.js";
import { logger } from "../utils/logger.js";
import {
  buildCloudRunSlackCard,
  buildCloudRunWhatsAppCard,
  type CloudRunCardInput,
  cloudRunCardBrief,
  cloudRunCardState,
} from "./chat-copy.js";
import { type CloudThreadRun, dbBindCloudThreadRun } from "./chat-db.js";
import {
  type CloudChatDeliveryReply,
  type CloudChatTarget,
  deliverToChat as defaultDeliverToChat,
  normalizeChatChannel,
} from "./chat-target.js";

const log = logger.child("cloud-agents:thread-binding");

/** The chat a turn came from (`ToolContext.source`). */
export interface CloudChatSource {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  threadId?: string;
  canonicalChatId?: string;
}

export type CloudThreadPlan =
  | {
      channel: "slack";
      accountId: string;
      instanceId: string;
      chatId: string;
      /** The thread the turn is in; null when the run card will open one. */
      threadTs: string | null;
      /** Known before the card is posted only inside a thread. */
      threadKey: string | null;
    }
  | { channel: "whatsapp"; accountId: string; instanceId: string; chatId: string; threadKey: string };

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLACK_CHANNEL_PATTERN = /^[A-Z0-9]{2,40}$/;
const SLACK_TS_PATTERN = /^\d{9,12}\.\d{1,9}$/;
const WHATSAPP_GROUP_PATTERN = /^\d{5,40}(?:-\d{1,20})?@g\.us$/;

export function slackThreadKey(instanceId: string, channelId: string, threadTs: string): string {
  return `slack:${instanceId}:${channelId}:${threadTs}`;
}

export function whatsappThreadKey(instanceId: string, groupId: string): string {
  return `whatsapp:${instanceId}:${groupId}`;
}

/** Where a run started from this chat binds, or why it cannot (a DM, another channel, no chat). */
export function planCloudThread(source: CloudChatSource | null | undefined): CloudThreadPlan | { error: string } {
  if (!source) return { error: "--bind-thread works inside an agent turn from a Slack thread or a WhatsApp group." };
  const channel = normalizeChatChannel(source.channel);
  const instanceId = (source.instanceId ?? source.accountId ?? "").trim();
  if (!INSTANCE_PATTERN.test(instanceId)) return { error: "This chat has no instance id to bind a run to." };
  if (channel === "slack") {
    const chatId = source.chatId.trim();
    const threadTs = source.threadId?.trim() || null;
    if (!SLACK_CHANNEL_PATTERN.test(chatId) || (threadTs !== null && !SLACK_TS_PATTERN.test(threadTs))) {
      return { error: "This Slack chat cannot be bound to a run." };
    }
    return {
      channel: "slack",
      accountId: source.accountId,
      instanceId,
      chatId,
      threadTs,
      threadKey: threadTs ? slackThreadKey(instanceId, chatId, threadTs) : null,
    };
  }
  if (channel === "whatsapp") {
    const chatId = source.chatId.trim();
    if (!WHATSAPP_GROUP_PATTERN.test(chatId)) {
      return { error: "--bind-thread works in a WhatsApp group, not in a private chat." };
    }
    return {
      channel: "whatsapp",
      accountId: source.accountId,
      instanceId,
      chatId,
      threadKey: whatsappThreadKey(instanceId, chatId),
    };
  }
  return { error: `--bind-thread works in Slack threads and WhatsApp groups, not on ${channel || "this channel"}.` };
}

export interface CloudThreadDeps {
  deliverToChat?: (
    target: CloudChatTarget,
    message: { text: string; blocks?: readonly Record<string, unknown>[] },
  ) => Promise<CloudChatDeliveryReply>;
  /** Queues a Slack `message.edit` chat action (the channel runner renders the card). */
  publishCardEdit?: (job: ReturnType<typeof buildChannelChatActionJob>) => Promise<void>;
  now?: () => number;
}

function chatTarget(plan: CloudThreadPlan, threadTs?: string | null): CloudChatTarget {
  return {
    channel: plan.channel,
    accountId: plan.accountId,
    instanceId: plan.instanceId,
    chatId: plan.chatId,
    ...(threadTs ? { threadId: threadTs } : {}),
  };
}

/** Posts the Slack run card; a workspace that rejects the `card` block gets the classic blocks. */
async function postSlackCard(
  target: CloudChatTarget,
  card: CloudRunCardInput,
  deliver: NonNullable<CloudThreadDeps["deliverToChat"]>,
): Promise<string | null> {
  const message = buildCloudRunSlackCard(card);
  try {
    return (await deliver(target, { text: message.text, blocks: message.blocks })).messageId;
  } catch (error) {
    if (!/invalid_blocks/.test(error instanceof Error ? error.message : String(error))) throw error;
    return (await deliver(target, { text: message.text, blocks: message.fallbackBlocks })).messageId;
  }
}

/**
 * Slack outside a thread: the run card is posted before the run starts and
 * becomes the thread root; its ts makes the key. Throws when Slack refuses.
 */
export async function openCloudThreadRoot(
  plan: Extract<CloudThreadPlan, { channel: "slack" }>,
  card: CloudRunCardInput,
  deps: CloudThreadDeps = {},
): Promise<{ threadKey: string; cardMessageId: string }> {
  const ts = await postSlackCard(chatTarget(plan), card, deps.deliverToChat ?? defaultDeliverToChat);
  if (!ts || !SLACK_TS_PATTERN.test(ts)) throw new Error("Slack did not return the run card's timestamp.");
  return { threadKey: slackThreadKey(plan.instanceId, plan.chatId, ts), cardMessageId: ts };
}

export interface BindCloudThreadInput {
  plan: CloudThreadPlan;
  threadKey: string;
  /** The card already posted as the thread root, if any. */
  cardMessageId: string | null;
  runId: string;
  status: string;
  agentName: string;
  prompt: string;
  sessionName: string | null;
  actorUserId: string | null;
  actorContactId: string | null;
  personName: string | null;
}

/**
 * After the run started: posts the run card where it is not yet (a reply in
 * the Slack thread, a message in the WhatsApp group) or updates the root card
 * with the run's status, then records the binding. A card that cannot be
 * posted leaves the binding without a card (replies still reach the run).
 */
export async function bindCloudThread(
  input: BindCloudThreadInput,
  deps: CloudThreadDeps = {},
): Promise<CloudThreadRun> {
  const deliver = deps.deliverToChat ?? defaultDeliverToChat;
  const card: CloudRunCardInput = {
    runId: input.runId,
    agentName: input.agentName,
    prompt: input.prompt,
    status: input.status,
    personName: input.personName,
    updatedAt: (deps.now ?? Date.now)(),
  };
  let cardMessageId = input.cardMessageId;
  try {
    if (input.plan.channel === "slack") {
      if (cardMessageId) {
        await queueCardEdit(
          {
            accountId: input.plan.accountId,
            instanceId: input.plan.instanceId,
            chatId: input.plan.chatId,
            cardMessageId,
            sessionName: input.sessionName,
          },
          card,
          deps,
        );
      } else {
        cardMessageId = await postSlackCard(chatTarget(input.plan, input.plan.threadTs), card, deliver);
      }
    } else {
      cardMessageId = (await deliver(chatTarget(input.plan), { text: buildCloudRunWhatsAppCard(card) })).messageId;
    }
  } catch (error) {
    log.warn("Could not post the cloud run card", {
      runId: input.runId,
      channel: input.plan.channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return dbBindCloudThreadRun({
    threadKey: input.threadKey,
    runId: input.runId,
    channel: input.plan.channel,
    accountId: input.plan.accountId,
    instanceId: input.plan.instanceId,
    chatId: input.plan.chatId,
    threadTs: input.plan.channel === "slack" ? (input.plan.threadTs ?? cardMessageId) : null,
    sessionName: input.sessionName,
    agentName: input.agentName,
    promptSummary: input.prompt.slice(0, 600),
    actorUserId: input.actorUserId,
    actorContactId: input.actorContactId,
    actorName: input.personName,
    cardMessageId,
    status: input.status,
  });
}

async function queueCardEdit(
  target: {
    accountId: string;
    instanceId: string;
    chatId: string;
    cardMessageId: string;
    sessionName: string | null;
  },
  card: CloudRunCardInput,
  deps: CloudThreadDeps,
): Promise<void> {
  const job = buildChannelChatActionJob({
    sessionName: target.sessionName || "cloud-agents",
    requestId: `cloud-run-card:${card.runId}:${card.status}:${card.updatedAt ?? Date.now()}`,
    target: { channel: "slack", accountId: target.accountId, instanceId: target.instanceId, chatId: target.chatId },
    content: {
      type: "chat_action",
      actionId: "message.edit",
      providerMessageId: target.cardMessageId,
      text: cloudRunCardBrief(card),
      threadCard: cloudRunCardState(card),
    },
  });
  if (deps.publishCardEdit) {
    await deps.publishCardEdit(job);
    return;
  }
  const published = await publishChannelOutboundJobDurably(job);
  // A failed publish stays in the outbox and is retried by the channel runner's sweep.
  if (!published.ok) {
    log.warn("Cloud run card update queued for retry", { runId: card.runId, nextAttemptAt: published.nextAttemptAt });
  }
}

/** Re-renders a run card posted as a Slack thread root before its run started (a start that failed). */
export async function editCloudThreadRoot(
  plan: Extract<CloudThreadPlan, { channel: "slack" }>,
  cardMessageId: string,
  card: CloudRunCardInput,
  deps: CloudThreadDeps = {},
): Promise<void> {
  await queueCardEdit(
    {
      accountId: plan.accountId,
      instanceId: plan.instanceId,
      chatId: plan.chatId,
      cardMessageId,
      sessionName: null,
    },
    card,
    deps,
  );
}

/** Re-renders a bound Slack thread's run card with the run's new status (WhatsApp cards are not re-posted). */
export async function updateCloudRunCard(
  thread: CloudThreadRun,
  update: { status: string; summary: string | null },
  deps: CloudThreadDeps = {},
): Promise<boolean> {
  if (thread.channel !== "slack" || !thread.cardMessageId) return false;
  await queueCardEdit(
    {
      accountId: thread.accountId,
      instanceId: thread.instanceId,
      chatId: thread.chatId,
      cardMessageId: thread.cardMessageId,
      sessionName: thread.sessionName,
    },
    {
      runId: thread.runId,
      agentName: thread.agentName,
      prompt: thread.promptSummary,
      status: update.status,
      personName: thread.actorName,
      summary: update.summary,
      updatedAt: (deps.now ?? Date.now)(),
    },
    deps,
  );
  return true;
}

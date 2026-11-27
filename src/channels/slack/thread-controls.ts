/**
 * Fechar and Parar on the card of a Ravi thread.
 *
 * A click is a `block_actions` interaction the runner publishes on
 * `ravi.inbound.interaction`. Here it becomes the same engine command that
 * `/ravi close <thread>` or `/ravi stop <thread>` is (src/chat-commands/engine.ts),
 * so the authority, the freshness window, the operations and the audit are the
 * ones a typed command gets, never a second copy:
 *
 * - The person is the Slack user id of the interaction payload, resolved to a
 *   contact. Nothing typed is read, and the card's `value` carries nothing.
 * - The thread is the card's own message: the root Slack keeps as the thread's
 *   `thread_ts`. It is looked up among the threads of the session the chat
 *   resolves to, never anywhere else, so a card cannot name another chat's
 *   thread.
 * - The answer is ephemeral, through the click's `response_url`, and says `replace_original: false`:
 *   left unsaid, Slack replaces the message the button is on. Closing already refreshes the card to
 *   "closed" (thread-lifecycle); the answer must not overwrite it.
 *
 * Spec: channels/slack/commands.
 */

import { type ChatCommandOutcome, runChatCommand } from "../../chat-commands/engine.js";
import { nats as runtimeNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { createEnvelopeDedupe } from "./envelope-dedupe.js";
import {
  slackChatCommandDeps,
  slackCommandChannel,
  type SlackCommandDeps,
  type SlackCommandSource,
} from "./slash-command-handler.js";
import { SLACK_THREAD_CLOSE_ACTION_ID, SLACK_THREAD_STOP_ACTION_ID } from "./thread-card.js";

const log = logger.child("channels:slack:thread-controls");

export const SLACK_THREAD_CONTROLS_TOPIC = "ravi.inbound.interaction";
export const SLACK_THREAD_CONTROLS_QUEUE_GROUP = "ravi-slack-thread-controls";
/** A click has no typed command; the answers that name one say the default. */
export const SLACK_CLICK_COMMAND_NAME = "/ravi";
/** Slack timestamps are digits, a dot and digits; anything else is not the root of a thread. */
export const SLACK_TS_PATTERN = /^[0-9]{6,12}\.[0-9]{1,9}$/;

export interface SlackThreadControlClick {
  readonly action: "close" | "stop";
  readonly accountId: string;
  readonly instanceId: string;
  readonly routeAccountId: string;
  readonly channelId: string;
  readonly userId: string;
  /** The ts of the clicked card: the root of its thread. */
  readonly messageTs: string;
  readonly receivedAt: number;
  readonly envelopeId?: string;
  readonly responseUrlId?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The click on a thread card's Fechar or Parar, or null for any other interaction. */
export function parseSlackThreadControlClick(data: unknown): SlackThreadControlClick | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.provider !== "slack" || record.source !== "slack.socket_mode") return null;
  if (record.interactionType !== "block_actions") return null;
  const actionId = text(record.actionId);
  const action =
    actionId === SLACK_THREAD_CLOSE_ACTION_ID ? "close" : actionId === SLACK_THREAD_STOP_ACTION_ID ? "stop" : null;
  if (!action) return null;

  const accountId = text(record.accountId);
  const instanceId = text(record.instanceId);
  const channelId = text(record.channelId);
  const userId = text(record.userId);
  const messageTs = text(record.messageTs);
  if (!accountId || !instanceId || !channelId || !userId || !SLACK_TS_PATTERN.test(messageTs)) return null;
  // A click with no arrival time cannot be held to the freshness window, so it does not run.
  if (typeof record.receivedAt !== "number" || !Number.isFinite(record.receivedAt)) return null;

  const envelopeId = text(record.envelopeId);
  const responseUrlId = text(record.responseUrlId);
  return {
    action,
    accountId,
    instanceId,
    routeAccountId: text(record.routeAccountId) || accountId,
    channelId,
    userId,
    messageTs,
    receivedAt: record.receivedAt,
    ...(envelopeId ? { envelopeId } : {}),
    ...(responseUrlId ? { responseUrlId } : {}),
  };
}

/** One click, start to answer. Returns what happened, or null for an interaction that is not ours. */
export async function handleSlackThreadControlClick(
  data: unknown,
  deps: SlackCommandDeps = {},
): Promise<ChatCommandOutcome | null> {
  const click = parseSlackThreadControlClick(data);
  if (!click) return null;
  const source: SlackCommandSource = {
    accountId: click.accountId,
    instanceId: click.instanceId,
    routeAccountId: click.routeAccountId,
    channelId: click.channelId,
    userId: click.userId,
    text: `${click.action} ${click.messageTs}`,
    receivedAt: click.receivedAt,
    command: SLACK_CLICK_COMMAND_NAME,
    surface: "button",
    ...(click.envelopeId ? { envelopeId: click.envelopeId } : {}),
    ...(click.responseUrlId ? { responseUrlId: click.responseUrlId } : {}),
  };
  return runChatCommand(slackCommandChannel(source, deps), slackChatCommandDeps(deps));
}

// ---------------------------------------------------------------------------
// Daemon consumer

let consumerStop: (() => void) | null = null;
let activeClick: Promise<unknown> | null = null;
/** True the first time an envelope id is seen; Slack may deliver the same click again. */
const firstDelivery = createEnvelopeDedupe();

/** Daemon: answers the buttons on thread cards (`ravi.inbound.interaction`, its own queue group). */
export async function startSlackThreadControls(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
  deps: SlackCommandDeps = {},
): Promise<void> {
  if (consumerStop) return;
  const stream = natsClient.subscribe(SLACK_THREAD_CONTROLS_TOPIC, { queue: SLACK_THREAD_CONTROLS_QUEUE_GROUP });
  let stopped = false;
  consumerStop = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          const click = parseSlackThreadControlClick(event.data);
          if (!click || !firstDelivery(click.envelopeId)) continue;
          activeClick = handleSlackThreadControlClick(event.data, deps);
          await activeClick;
        } catch (error) {
          log.warn("Failed to answer a thread card click", { error: error instanceof Error ? error.message : error });
        } finally {
          activeClick = null;
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack thread controls consumer stopped", { error });
    }
  })();
}

export async function stopSlackThreadControls(): Promise<void> {
  consumerStop?.();
  consumerStop = null;
  // The click being answered finishes first: it may still have its reply and its audit event to send,
  // and shutdown closes NATS and the database right after this returns.
  await activeClick?.catch((error) =>
    log.debug("In-flight thread card click ended with an error", {
      error: error instanceof Error ? error.message : error,
    }),
  );
}

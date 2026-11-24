/**
 * Message shortcuts on a Slack thread: status, close and stop from the "..." menu of any message in it.
 *
 * A message shortcut is a `message_action` interaction the runner publishes on
 * `ravi.inbound.interaction`, with the `callback_id` the Slack app declares for
 * it. Here it becomes the same engine command that `/ravi status <thread>`,
 * `/ravi close <thread>` or `/ravi stop <thread>` is (src/chat-commands/engine.ts),
 * so the authority, the freshness window, the operations and the audit are the
 * ones a typed command gets, never a second copy:
 *
 * - The person is the Slack user id of the interaction payload, resolved to a
 *   contact. Nothing typed is read. The thread is the root of the thread the
 *   message belongs to (`thread_ts`, or the message's own `ts` when it starts
 *   one), looked up among the threads of the session the chat resolves to.
 * - `status` answers at once.
 * - `close` and `stop` change things, so the shortcut only asks first: a private
 *   card with Confirm and Cancel. Confirm runs the command and the card becomes
 *   its answer. The card carries the thread and the time it was asked, and a
 *   confirmation asked more than ten minutes ago does not run.
 * - Every answer is private to the person, in the thread: an ephemeral card where
 *   they are, or their DM with the app. A shortcut's own response handle posts at
 *   channel level, where someone looking at a thread does not see it, so it is
 *   only the fallback when the card could not be sent.
 *
 * Spec: channels/slack/commands.
 */

import { CHAT_COMMAND_MAX_AGE_MS, type ChatCommandOutcome, runChatCommand } from "../../chat-commands/engine.js";
import { nats as runtimeNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { createEnvelopeDedupe } from "./envelope-dedupe.js";
import { respondToSlackInteraction } from "./interactions.js";
import { deliverSlackPrivateCard, type SlackPrivateCard } from "./private-card.js";
import {
  slackChatCommandDeps,
  slackCommandChannel,
  type SlackCommandDeps,
  type SlackCommandSource,
} from "./slash-command-handler.js";
import { SLACK_CLICK_COMMAND_NAME, SLACK_TS_PATTERN } from "./thread-controls.js";

const log = logger.child("channels:slack:thread-shortcuts");

export const SLACK_THREAD_SHORTCUTS_TOPIC = "ravi.inbound.interaction";
export const SLACK_THREAD_SHORTCUTS_QUEUE_GROUP = "ravi-slack-thread-shortcuts";

/** The `callback_id` of each message shortcut: what the operator types when creating them in the Slack app. */
export const SLACK_THREAD_STATUS_SHORTCUT_ID = "ravi_status_thread";
export const SLACK_THREAD_CLOSE_SHORTCUT_ID = "ravi_close_thread";
export const SLACK_THREAD_STOP_SHORTCUT_ID = "ravi_stop_thread";

/** The buttons of the confirmation card. */
export const SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID = "ravi_confirm_close_thread";
export const SLACK_THREAD_CONFIRM_STOP_ACTION_ID = "ravi_confirm_stop_thread";
export const SLACK_THREAD_CANCEL_ACTION_ID = "ravi_cancel_thread_action";

/** A confirmation asked longer ago than this does not run: a card left on screen is not an order for later. */
export const SLACK_THREAD_CONFIRM_MAX_AGE_MS = 10 * 60_000;
/** How far apart the clock that stamped the card and the clock that stamped the tap may be. */
const CLOCK_SKEW_MS = 60_000;

interface ShortcutBase {
  readonly accountId: string;
  readonly instanceId: string;
  readonly routeAccountId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly receivedAt: number;
  readonly envelopeId?: string;
  readonly responseUrlId?: string;
}

export type SlackThreadShortcutEvent =
  /** The person picked a shortcut on a message. `threadTs` is the root of the thread the message is in. */
  | (ShortcutBase & {
      readonly kind: "shortcut";
      readonly action: "status" | "close" | "stop";
      readonly threadTs: string;
    })
  /** The person confirmed on the card a shortcut sent, `askedAt` being when the card was built. */
  | (ShortcutBase & {
      readonly kind: "confirm";
      readonly action: "close" | "stop";
      readonly threadTs: string;
      readonly askedAt: number;
    })
  | (ShortcutBase & { readonly kind: "cancel" });

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBase(record: Record<string, unknown>): ShortcutBase | null {
  if (record.provider !== "slack" || record.source !== "slack.socket_mode") return null;
  const accountId = text(record.accountId);
  const instanceId = text(record.instanceId);
  const channelId = text(record.channelId);
  const userId = text(record.userId);
  if (!accountId || !instanceId || !channelId || !userId) return null;
  // A tap with no arrival time cannot be held to the freshness window, so it does not run.
  if (typeof record.receivedAt !== "number" || !Number.isFinite(record.receivedAt)) return null;
  const envelopeId = text(record.envelopeId);
  const responseUrlId = text(record.responseUrlId);
  return {
    accountId,
    instanceId,
    routeAccountId: text(record.routeAccountId) || accountId,
    channelId,
    userId,
    receivedAt: record.receivedAt,
    ...(envelopeId ? { envelopeId } : {}),
    ...(responseUrlId ? { responseUrlId } : {}),
  };
}

/** The shortcut, confirmation or cancellation an interaction is, or null for any other interaction. */
export function parseSlackThreadShortcutEvent(data: unknown): SlackThreadShortcutEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  if (record.interactionType === "message_action") {
    const callbackId = text(record.callbackId);
    const action =
      callbackId === SLACK_THREAD_STATUS_SHORTCUT_ID
        ? "status"
        : callbackId === SLACK_THREAD_CLOSE_SHORTCUT_ID
          ? "close"
          : callbackId === SLACK_THREAD_STOP_SHORTCUT_ID
            ? "stop"
            : null;
    if (!action) return null;
    const base = readBase(record);
    // The thread a message belongs to: its root, or the message itself when it starts one.
    const threadTs = text(record.threadTs) || text(record.messageTs);
    if (!base || !SLACK_TS_PATTERN.test(threadTs)) return null;
    return { kind: "shortcut", action, threadTs, ...base };
  }

  if (record.interactionType === "block_actions") {
    const actionId = text(record.actionId);
    if (actionId === SLACK_THREAD_CANCEL_ACTION_ID) {
      const base = readBase(record);
      return base ? { kind: "cancel", ...base } : null;
    }
    const action =
      actionId === SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID
        ? "close"
        : actionId === SLACK_THREAD_CONFIRM_STOP_ACTION_ID
          ? "stop"
          : null;
    if (!action) return null;
    const base = readBase(record);
    const [threadTs = "", asked = ""] = text(record.value).split("|");
    const askedSeconds = /^[0-9]{9,11}$/.test(asked) ? Number(asked) : Number.NaN;
    if (!base || !SLACK_TS_PATTERN.test(threadTs) || !Number.isSafeInteger(askedSeconds)) return null;
    return { kind: "confirm", action, threadTs, askedAt: askedSeconds * 1000, ...base };
  }

  return null;
}

/** The private card a `close` or `stop` shortcut sends first: Confirm and Cancel, and nothing has changed yet. */
export function buildSlackThreadConfirmCard(
  action: "close" | "stop",
  threadTs: string,
  askedAt: number,
): SlackPrivateCard {
  const closing = action === "close";
  const title = closing ? "Fechar esta thread?" : "Parar o turno em andamento?";
  const detail = closing
    ? "A thread deixa de receber instruções e o resultado fica registrado."
    : "O turno que está rodando nesta thread é interrompido. A fila segue.";
  return {
    text: title,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${detail}` } },
      {
        type: "actions",
        block_id: "ravi_thread_confirm",
        elements: [
          {
            type: "button",
            action_id: closing ? SLACK_THREAD_CONFIRM_CLOSE_ACTION_ID : SLACK_THREAD_CONFIRM_STOP_ACTION_ID,
            text: { type: "plain_text", text: closing ? "Fechar" : "Parar", emoji: true },
            ...(closing ? {} : { style: "danger" }),
            // The thread and when it was asked: a hint the click checks, never an authority.
            value: `${threadTs}|${Math.floor(askedAt / 1000)}`,
          },
          {
            type: "button",
            action_id: SLACK_THREAD_CANCEL_ACTION_ID,
            text: { type: "plain_text", text: "Cancelar", emoji: true },
            value: "cancel",
          },
        ],
      },
    ],
  };
}

export type SlackThreadShortcutResult =
  /** The engine ran the command; this is what it came to. */
  | { readonly kind: "ran"; readonly outcome: ChatCommandOutcome }
  | { readonly kind: "card_sent" }
  | { readonly kind: "card_not_sent" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "expired" }
  /** A shortcut that arrived too long after it was picked: nothing is shown for it. */
  | { readonly kind: "stale" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One shortcut, confirmation or cancellation, start to answer. Null for an interaction that is not ours. */
export async function handleSlackThreadShortcut(
  data: unknown,
  deps: SlackCommandDeps = {},
): Promise<SlackThreadShortcutResult | null> {
  const event = parseSlackThreadShortcutEvent(data);
  if (!event) return null;
  const now = (deps.now ?? Date.now)();

  const sourceFor = (commandText: string, extra: Partial<SlackCommandSource> = {}): SlackCommandSource => ({
    accountId: event.accountId,
    instanceId: event.instanceId,
    routeAccountId: event.routeAccountId,
    channelId: event.channelId,
    userId: event.userId,
    text: commandText,
    receivedAt: event.receivedAt,
    command: SLACK_CLICK_COMMAND_NAME,
    surface: "shortcut",
    ...(event.envelopeId ? { envelopeId: event.envelopeId } : {}),
    ...(event.responseUrlId ? { responseUrlId: event.responseUrlId } : {}),
    ...extra,
  });
  const replaceCard = async (note: string): Promise<void> => {
    if (!event.responseUrlId) return;
    try {
      await (deps.respond ?? respondToSlackInteraction)({
        responseUrlId: event.responseUrlId,
        payload: { response_type: "ephemeral", replace_original: true, text: note },
      });
    } catch (error) {
      log.warn("Could not answer a thread confirmation", { error: errorText(error) });
    }
  };

  switch (event.kind) {
    case "shortcut": {
      if (event.action === "status") {
        const outcome = await runChatCommand(
          slackCommandChannel(sourceFor(`status ${event.threadTs}`, { privateThreadTs: event.threadTs }), deps),
          slackChatCommandDeps(deps),
        );
        return { kind: "ran", outcome };
      }
      // A shortcut that arrived long after it was picked asks nothing: the person is not waiting for it.
      if (Math.abs(now - event.receivedAt) > CHAT_COMMAND_MAX_AGE_MS) return { kind: "stale" };
      try {
        await (deps.deliverPrivate ?? deliverSlackPrivateCard)(
          {
            accountId: event.accountId,
            chatId: event.channelId,
            userId: event.userId,
            threadTs: event.threadTs,
          },
          buildSlackThreadConfirmCard(event.action, event.threadTs, now),
        );
        return { kind: "card_sent" };
      } catch (error) {
        log.warn("The thread confirmation card was not delivered", { error: errorText(error) });
        return { kind: "card_not_sent" };
      }
    }

    case "confirm": {
      const age = event.receivedAt - event.askedAt;
      if (age > SLACK_THREAD_CONFIRM_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
        await replaceCard("Essa confirmação expirou. Use o atalho de novo.");
        return { kind: "expired" };
      }
      const outcome = await runChatCommand(
        slackCommandChannel(sourceFor(`${event.action} ${event.threadTs}`, { replaceOriginal: true }), deps),
        slackChatCommandDeps(deps),
      );
      return { kind: "ran", outcome };
    }

    case "cancel":
      await replaceCard("Cancelado.");
      return { kind: "cancelled" };
  }
}

// ---------------------------------------------------------------------------
// Daemon consumer

let consumerStop: (() => void) | null = null;
let activeShortcut: Promise<unknown> | null = null;
/** True the first time an envelope id is seen; Slack may deliver the same tap again. */
const firstDelivery = createEnvelopeDedupe();

/** Daemon: answers the message shortcuts and their confirmation cards (`ravi.inbound.interaction`, its own queue group). */
export async function startSlackThreadShortcuts(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
  deps: SlackCommandDeps = {},
): Promise<void> {
  if (consumerStop) return;
  const stream = natsClient.subscribe(SLACK_THREAD_SHORTCUTS_TOPIC, { queue: SLACK_THREAD_SHORTCUTS_QUEUE_GROUP });
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
          const parsed = parseSlackThreadShortcutEvent(event.data);
          if (!parsed || !firstDelivery(parsed.envelopeId)) continue;
          activeShortcut = handleSlackThreadShortcut(event.data, deps);
          await activeShortcut;
        } catch (error) {
          log.warn("Failed to answer a thread shortcut", { error: errorText(error) });
        } finally {
          activeShortcut = null;
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack thread shortcuts consumer stopped", { error });
    }
  })();
}

export async function stopSlackThreadShortcuts(): Promise<void> {
  consumerStop?.();
  consumerStop = null;
  // The tap being answered finishes first: it may still have its card and its audit event to send,
  // and shutdown closes NATS and the database right after this returns.
  await activeShortcut?.catch((error) =>
    log.debug("In-flight thread shortcut ended with an error", { error: errorText(error) }),
  );
}

/**
 * A card only one person sees, sent where they are.
 *
 * The daemon has no Slack client of its own: it asks the gateway
 * (`ravi.outbound.deliver` with `privateTo`), the path approval and grant cards
 * already use. The gateway sends an ephemeral message in the chat, in a thread
 * when `threadId` is given, or the person's DM with the app when Slack refuses
 * that. Nobody else sees it.
 *
 * Spec: channels/slack/commands.
 */

import { requestReply as runtimeRequestReply } from "../../utils/request-reply.js";

const PRIVATE_CARD_TIMEOUT_MS = 20_000;

export interface SlackPrivateCard {
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface SlackPrivateCardTarget {
  /** The Slack account (the channel's name in the config) the gateway sends through. */
  readonly accountId: string;
  readonly chatId: string;
  readonly userId: string;
  /** The thread the card belongs in: the ts of its root. */
  readonly threadTs?: string;
}

export type DeliverSlackPrivateCard = (target: SlackPrivateCardTarget, card: SlackPrivateCard) => Promise<void>;

interface DeliveryReply {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly messageId?: unknown;
  readonly deliveries?: ReadonlyArray<{ readonly messageId?: unknown }>;
}

/** Sends one private card. Throws when the gateway did not confirm it: the caller says what that costs. */
export async function deliverSlackPrivateCard(
  target: SlackPrivateCardTarget,
  card: SlackPrivateCard,
  requestReply: typeof runtimeRequestReply = runtimeRequestReply,
): Promise<void> {
  const reply = await requestReply<DeliveryReply>(
    "ravi.outbound.deliver",
    {
      channel: "slack",
      accountId: target.accountId,
      to: target.chatId,
      text: card.text,
      blocks: card.blocks,
      privateTo: [target.userId],
      ...(target.threadTs ? { threadId: target.threadTs } : {}),
    },
    PRIVATE_CARD_TIMEOUT_MS,
  );
  const confirmed =
    typeof reply.messageId === "string" ||
    (reply.deliveries ?? []).some((delivery) => typeof delivery.messageId === "string");
  if (!confirmed) {
    const reason = typeof reply.error === "string" && reply.error ? `: ${reply.error}` : "";
    throw new Error(`Slack did not confirm the private card${reason}`);
  }
}

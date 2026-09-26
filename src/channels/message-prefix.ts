/**
 * Leading control prefixes on inbound channel text.
 *
 * - `>>body` delivers `body` when the current turn ends instead of steering it.
 * - `!!body` records `body` as a user message without running a turn for it.
 *
 * The prefix must be the first non-whitespace text and must not be followed by
 * a third `>` or `!` (`>>>` is a Slack block quote, `!!!` is emphasis).
 * Whitespace right after the prefix is dropped. When no text is left, the
 * message is not prefixed and reaches the agent unchanged.
 */
export type ChannelMessagePrefixKind = "end_of_turn" | "skip_turn";

export interface ChannelMessagePrefix {
  kind: ChannelMessagePrefixKind;
  body: string;
}

export interface ChannelMessagePrefixDelivery {
  deliveryBarrier?: "after_response";
  deliveryBarrierSource?: "explicit";
  _skipTurn?: true;
}

const CHANNEL_MESSAGE_PREFIX = /^\s*(>>(?!>)|!!(?!!))\s*/;

export function parseChannelMessagePrefix(text: string | null | undefined): ChannelMessagePrefix | null {
  if (!text) return null;
  const match = CHANNEL_MESSAGE_PREFIX.exec(text);
  if (!match) return null;
  const body = text.slice(match[0].length);
  if (!body) return null;
  return { kind: match[1] === ">>" ? "end_of_turn" : "skip_turn", body };
}

export function channelMessagePrefixDelivery(prefix: ChannelMessagePrefix | null): ChannelMessagePrefixDelivery {
  switch (prefix?.kind) {
    case "end_of_turn":
      return { deliveryBarrier: "after_response", deliveryBarrierSource: "explicit" };
    case "skip_turn":
      return { _skipTurn: true };
    default:
      return {};
  }
}

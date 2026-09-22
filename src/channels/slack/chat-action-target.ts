import { dbGetChat, dbGetChatMessage } from "../../router/router-db.js";
import type { MessageTarget } from "../../runtime/message-types.js";

const SLACK_PLATFORM_CHANNEL_RE = /^[CDG][A-Z0-9]+$/i;
const SLACK_TS_RE = /^\d+\.\d+$/;
const SLACK_NAME_RE = /^[0-9A-Za-z_+-]+$/;

const SLACK_REACTION_NAME_BY_EMOJI: Record<string, string> = {
  "👍": "+1",
  "👎": "-1",
  "❤️": "heart",
  "❤": "heart",
  "♥️": "heart",
  "♥": "heart",
  "😂": "joy",
  "😊": "blush",
  "✅": "white_check_mark",
  "✔️": "heavy_check_mark",
  "✔": "heavy_check_mark",
  "🎉": "tada",
  "🔥": "fire",
  "👀": "eyes",
  "🙏": "pray",
  "🚀": "rocket",
  "💯": "100",
  "✨": "sparkles",
  "👏": "clap",
  "😅": "sweat_smile",
  "🤔": "thinking_face",
  "⚠️": "warning",
  "⚠": "warning",
};

const SLACK_REACTION_ALIASES: Record<string, string> = {
  "+1": "+1",
  "-1": "-1",
  thumbsup: "+1",
  thumbs_up: "+1",
  thumbsdown: "-1",
  thumbs_down: "-1",
};

export function isSlackPlatformChannelId(value: string): boolean {
  return SLACK_PLATFORM_CHANNEL_RE.test(value);
}

export function isSlackMessageTs(value: string): boolean {
  return SLACK_TS_RE.test(value);
}

/**
 * Map CLI/gateway emoji values onto Slack `reactions.add` names.
 *
 * Slack rejects unicode (`👍`) and some aliases (`thumbsup`) as `invalid_name`.
 * That error is terminal in the outbound consumer, so an unmapped name becomes
 * a silent ACK-without-reaction.
 */
export function normalizeSlackReactionName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Slack reaction emoji is required");

  const withoutColons = trimmed.replace(/^:+|:+$/g, "").trim();
  if (!withoutColons) throw new Error("Slack reaction emoji is required");

  const withoutModifiers = stripSlackEmojiModifiers(withoutColons);
  const mapped =
    SLACK_REACTION_NAME_BY_EMOJI[withoutModifiers] ??
    SLACK_REACTION_NAME_BY_EMOJI[withoutColons] ??
    SLACK_REACTION_ALIASES[withoutModifiers.toLowerCase()] ??
    SLACK_REACTION_ALIASES[withoutColons.toLowerCase()];
  if (mapped) return mapped;
  if (SLACK_NAME_RE.test(withoutModifiers)) return withoutModifiers;

  throw new Error(`Slack chat action failed: invalid_name (${withoutColons})`);
}

/**
 * Resolve the Slack Web API `channel` for a chat action.
 *
 * Session/CLI jobs may carry a backend conversation id (`D123~ts`), a thread
 * platform id (`C123#ts`), or a canonical `chat_*` id. `reactions.add` only
 * accepts the platform `C`/`D`/`G` id.
 */
export function resolveSlackApiChannelId(target: Pick<MessageTarget, "chatId" | "canonicalChatId">): string {
  const resolved = resolveSlackChannelCandidate(target.chatId) ?? resolveSlackChannelCandidate(target.canonicalChatId);
  if (resolved) return resolved;
  throw new Error(
    `Slack chat action failed: channel_not_found (chatId=${target.chatId ?? ""} canonicalChatId=${target.canonicalChatId ?? ""})`,
  );
}

/**
 * Resolve the Slack message timestamp for edit/delete/react.
 *
 * Agents sometimes pass a canonical `cm_*` id; the Web API needs the Slack `ts`.
 */
export function resolveSlackApiTimestamp(providerMessageId: string): string {
  const raw = providerMessageId.trim();
  if (!raw) throw new Error("Slack chat action failed: invalid_ts (empty providerMessageId)");
  if (isSlackMessageTs(raw)) return raw;

  const fromLedger = lookupSlackChatMessage(raw)?.providerMessageId?.trim();
  if (fromLedger && isSlackMessageTs(fromLedger)) return fromLedger;

  throw new Error(`Slack chat action failed: invalid_ts (${raw})`);
}

function resolveSlackChannelCandidate(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (raw.includes("~")) {
    const separator = raw.indexOf("~");
    const channelId = raw.slice(0, separator);
    const threadTs = raw.slice(separator + 1);
    if (isSlackPlatformChannelId(channelId) && threadTs && !threadTs.includes("~")) {
      return channelId;
    }
  }

  if (raw.includes("#")) {
    const channelId = raw.slice(0, raw.indexOf("#"));
    if (isSlackPlatformChannelId(channelId)) return channelId;
  }

  if (isSlackPlatformChannelId(raw)) return raw;

  const chat = lookupSlackChat(raw);
  if (chat?.channel.toLowerCase() === "slack") {
    return resolveSlackChannelCandidate(chat.platformChatId);
  }
  return undefined;
}

function lookupSlackChat(id: string) {
  try {
    return dbGetChat(id);
  } catch {
    return null;
  }
}

function lookupSlackChatMessage(id: string) {
  try {
    return dbGetChatMessage(id);
  } catch {
    return null;
  }
}

function stripSlackEmojiModifiers(value: string): string {
  return value.replace(/\uFE0F/g, "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
}

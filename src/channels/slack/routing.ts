import type {
  SlackBotMessageAliasesByChat,
  SlackEventPayload,
  SlackRootReplyMode,
  SlackRoutingPolicy,
  SlackSocketEnvelope,
  SlackSubscriptionScope,
  SlackThreadContext,
  SlackThreadReplyMode,
} from "./types.js";

export const DEFAULT_SLACK_ROUTING_POLICY: SlackRoutingPolicy = {
  subscriptionScope: "thread",
  threadReplyMode: "same_thread",
  rootReplyMode: "channel_root",
  botMessageAliasesByChat: {},
};

export interface SlackMessageEventIgnoreOptions {
  readonly selfBotId?: string;
  readonly selfUserId?: string;
  readonly botMessageAliasesByChat?: SlackBotMessageAliasesByChat;
}

export function normalizeSlackRoutingPolicy(input: Partial<SlackRoutingPolicy> = {}): SlackRoutingPolicy {
  return {
    subscriptionScope: isSlackSubscriptionScope(input.subscriptionScope)
      ? input.subscriptionScope
      : DEFAULT_SLACK_ROUTING_POLICY.subscriptionScope,
    threadReplyMode: isSlackThreadReplyMode(input.threadReplyMode)
      ? input.threadReplyMode
      : DEFAULT_SLACK_ROUTING_POLICY.threadReplyMode,
    rootReplyMode: isSlackRootReplyMode(input.rootReplyMode)
      ? input.rootReplyMode
      : DEFAULT_SLACK_ROUTING_POLICY.rootReplyMode,
    botMessageAliasesByChat: normalizeSlackBotMessageAliasesByChat(input.botMessageAliasesByChat),
  };
}

export function slackRoutingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SlackRoutingPolicy {
  return normalizeSlackRoutingPolicy({
    subscriptionScope: env.RAVI_SLACK_SUBSCRIPTION_SCOPE as SlackSubscriptionScope | undefined,
    threadReplyMode: env.RAVI_SLACK_THREAD_REPLY_MODE as SlackThreadReplyMode | undefined,
    rootReplyMode: env.RAVI_SLACK_ROOT_REPLY_MODE as SlackRootReplyMode | undefined,
  });
}

export function slackRoutingPolicyFromChannelDefaults(
  defaults: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SlackRoutingPolicy {
  const environmentPolicy = slackRoutingPolicyFromEnv(env);
  return normalizeSlackRoutingPolicy({
    subscriptionScope: isSlackSubscriptionScope(defaults?.subscriptionScope)
      ? defaults.subscriptionScope
      : environmentPolicy.subscriptionScope,
    threadReplyMode: isSlackThreadReplyMode(defaults?.threadReplyMode)
      ? defaults.threadReplyMode
      : environmentPolicy.threadReplyMode,
    rootReplyMode: isSlackRootReplyMode(defaults?.rootReplyMode)
      ? defaults.rootReplyMode
      : environmentPolicy.rootReplyMode,
    botMessageAliasesByChat: defaults?.botMessageAliasesByChat as SlackBotMessageAliasesByChat | undefined,
  });
}

export function resolveSlackThreadContext(
  event: Pick<SlackEventPayload, "ts" | "thread_ts">,
  policy: SlackRoutingPolicy,
): SlackThreadContext {
  const ts = cleanSlackId(event.ts);
  const threadTs = cleanSlackId(event.thread_ts);
  const isThreadReply = Boolean(threadTs && ts && threadTs !== ts);

  if (isThreadReply) {
    const outboundThreadTs = policy.threadReplyMode === "channel_root" ? undefined : threadTs;
    return {
      inboundThreadTs: threadTs,
      routeThreadTs: policy.subscriptionScope === "chat" ? undefined : threadTs,
      ...(outboundThreadTs ? { outboundThreadTs } : {}),
    };
  }

  if (ts && policy.rootReplyMode === "new_thread") {
    return {
      routeThreadTs: policy.subscriptionScope === "chat" ? undefined : ts,
      outboundThreadTs: ts,
    };
  }

  return {};
}

export function slackPeerKindForChannelType(channelType: string | undefined): "dm" | "group" {
  return channelType === "im" ? "dm" : "group";
}

export function shouldIgnoreSlackMessageEvent(
  event: SlackEventPayload,
  options: SlackMessageEventIgnoreOptions = {},
): boolean {
  if (!isSlackMessageEventStructurallyEligible(event)) return true;

  const userId = cleanSlackId(event.user);
  const botId = cleanSlackId(event.bot_id);
  const isBotMessage = Boolean(botId || event.subtype === "bot_message");
  if (!isBotMessage) return !userId;

  if (!botId && !userId) return true;
  const selfBotId = cleanSlackId(options.selfBotId);
  const selfUserId = cleanSlackId(options.selfUserId);
  if (!selfBotId && !selfUserId) return true;
  if ((selfBotId && botId === selfBotId) || (selfUserId && userId === selfUserId)) return true;

  const text = typeof event.text === "string" ? event.text : "";
  return !(
    (selfUserId && text.includes(`<@${selfUserId}>`)) ||
    isSlackMessageAddressedByAlias({
      channelId: cleanSlackId(event.channel),
      text,
      aliasesByChat: options.botMessageAliasesByChat,
    })
  );
}

export function isSlackMessageEventStructurallyEligible(event: SlackEventPayload): boolean {
  return (
    event.type === "message" &&
    event.hidden !== true &&
    Boolean(cleanSlackId(event.channel)) &&
    Boolean(cleanSlackId(event.ts)) &&
    isSupportedSlackMessageSubtype(event.subtype)
  );
}

export function slackSenderIdForEvent(event: SlackEventPayload): string | undefined {
  return cleanSlackId(event.user) ?? cleanSlackId(event.bot_id);
}

export function slackTsToMs(ts: string | undefined, fallback = Date.now()): number {
  const cleaned = cleanSlackId(ts);
  if (!cleaned) return fallback;
  const seconds = Number(cleaned);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.trunc(seconds * 1000);
}

export function cleanSlackId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function envelopeEvent(envelope: SlackSocketEnvelope): SlackEventPayload | undefined {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const maybeEvent = (payload as { event?: unknown }).event;
  return maybeEvent && typeof maybeEvent === "object" ? (maybeEvent as SlackEventPayload) : undefined;
}

function isSlackSubscriptionScope(value: unknown): value is SlackSubscriptionScope {
  return value === "chat" || value === "thread" || value === "chat_and_thread";
}

function isSlackThreadReplyMode(value: unknown): value is SlackThreadReplyMode {
  return value === "same_thread" || value === "channel_root" || value === "policy_default";
}

function isSlackRootReplyMode(value: unknown): value is SlackRootReplyMode {
  return value === "channel_root" || value === "new_thread" || value === "policy_default";
}

function isSupportedSlackMessageSubtype(value: string | undefined): boolean {
  return !value || value === "thread_broadcast" || value === "file_share" || value === "bot_message";
}

function isSlackMessageAddressedByAlias(input: {
  channelId: string | undefined;
  text: string;
  aliasesByChat: SlackBotMessageAliasesByChat | undefined;
}): boolean {
  if (!input.channelId) return false;
  const aliases = input.aliasesByChat?.[input.channelId] ?? [];
  return aliases.some((alias) => slackTextStartsWithAlias(input.text, alias));
}

function slackTextStartsWithAlias(text: string, alias: string): boolean {
  const cleanedAlias = cleanSlackId(alias);
  if (!cleanedAlias) return false;
  const pattern = new RegExp(`^${escapeRegExp(cleanedAlias)}(?:$|[\\s\\p{P}])`, "iu");
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSlackBotMessageAliasesByChat(input: unknown): SlackBotMessageAliasesByChat {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const entries: Array<[string, string[]]> = [];
  for (const [rawChatId, rawAliases] of Object.entries(input)) {
    const chatId = cleanSlackId(rawChatId);
    if (!chatId || !Array.isArray(rawAliases)) continue;
    const aliases = Array.from(
      new Map(
        rawAliases
          .map((alias) => (typeof alias === "string" ? alias.trim() : ""))
          .filter(Boolean)
          .map((alias) => [alias.toLowerCase(), alias]),
      ).values(),
    );
    if (aliases.length > 0) entries.push([chatId, aliases]);
  }
  return Object.fromEntries(entries);
}

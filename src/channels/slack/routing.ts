import type {
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
};

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
  };
}

export function slackRoutingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SlackRoutingPolicy {
  return normalizeSlackRoutingPolicy({
    subscriptionScope: env.RAVI_SLACK_SUBSCRIPTION_SCOPE as SlackSubscriptionScope | undefined,
    threadReplyMode: env.RAVI_SLACK_THREAD_REPLY_MODE as SlackThreadReplyMode | undefined,
    rootReplyMode: env.RAVI_SLACK_ROOT_REPLY_MODE as SlackRootReplyMode | undefined,
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

export function slackPeerKindForChannelType(channelType: string | undefined): "dm" | "channel" {
  return channelType === "im" ? "dm" : "channel";
}

export function shouldIgnoreSlackMessageEvent(event: SlackEventPayload): boolean {
  if (event.type !== "message") return true;
  if (event.hidden === true) return true;
  if (!cleanSlackId(event.channel)) return true;
  if (!cleanSlackId(event.ts)) return true;
  if (event.bot_id) return true;
  if (event.subtype && event.subtype !== "thread_broadcast") return true;
  return !cleanSlackId(event.user);
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

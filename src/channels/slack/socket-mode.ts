import { configStore } from "../../config-store.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { commitMatchedRoute, matchRoute } from "../../router/index.js";
import {
  dbBindSessionToChat,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertChatParticipant,
} from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import type { MessageContext, MessageTarget } from "../../runtime/message-types.js";
import { logger } from "../../utils/logger.js";
import type { NativeTextDelivery, NativeTextDeliveryRequest, NativeTextDeliveryResult } from "../native/types.js";
import { SlackWebApiClient } from "./client.js";
import {
  cleanSlackId,
  envelopeEvent,
  resolveSlackThreadContext,
  shouldIgnoreSlackMessageEvent,
  slackPeerKindForChannelType,
  slackRoutingPolicyFromEnv,
  slackTsToMs,
} from "./routing.js";
import type { SlackNormalizedMessage, SlackRoutingPolicy, SlackSocketEnvelope } from "./types.js";

const log = logger.child("channels:slack");

type PublishPrompt = typeof publishSessionPrompt;
type WebSocketFactory = (url: string) => WebSocket;

export interface SlackSocketModeServiceOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly accountId: string;
  readonly routeAccountId?: string;
  readonly instanceId?: string;
  readonly routingPolicy?: Partial<SlackRoutingPolicy>;
  readonly webClient?: SlackWebApiClient;
  readonly getRouterConfig?: () => RouterConfig;
  readonly publishPrompt?: PublishPrompt;
  readonly openWebSocket?: WebSocketFactory;
  readonly reconnectDelayMs?: number;
}

export interface SlackNativeRuntime {
  readonly delivery: NativeTextDelivery;
  readonly socketMode: SlackSocketModeService;
}

class RecentIdCache {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize = 1_000) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) this.ids.delete(oldest);
    }
  }
}

export class SlackTextDelivery implements NativeTextDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly webClient: SlackWebApiClient,
    private readonly routingPolicy: SlackRoutingPolicy,
  ) {}

  supports(target: MessageTarget): boolean {
    return target.channel.toLowerCase() === this.channelId;
  }

  async deliverText(request: NativeTextDeliveryRequest): Promise<NativeTextDeliveryResult> {
    const threadTs = this.routingPolicy.threadReplyMode === "channel_root" ? undefined : request.target.threadId;
    const result = await this.webClient.postMessage({
      channel: request.target.chatId,
      text: request.text,
      ...(threadTs ? { threadTs } : {}),
    });
    return {
      provider: "slack",
      messageId: result.messageId,
      platformMessageId: result.ts,
      raw: result.raw,
    };
  }
}

export class SlackSocketModeService {
  private readonly webClient: SlackWebApiClient;
  private readonly getRouterConfig: () => RouterConfig;
  private readonly publishPrompt: PublishPrompt;
  private readonly openWebSocket: WebSocketFactory;
  private readonly routingPolicy: SlackRoutingPolicy;
  private readonly reconnectDelayMs: number;
  private readonly seenEnvelopeIds = new RecentIdCache();
  private running = false;
  private socket: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: SlackSocketModeServiceOptions) {
    this.routingPolicy = slackRoutingPolicyFromEnv({
      ...process.env,
      ...(options.routingPolicy?.subscriptionScope
        ? { RAVI_SLACK_SUBSCRIPTION_SCOPE: options.routingPolicy.subscriptionScope }
        : {}),
      ...(options.routingPolicy?.threadReplyMode
        ? { RAVI_SLACK_THREAD_REPLY_MODE: options.routingPolicy.threadReplyMode }
        : {}),
      ...(options.routingPolicy?.rootReplyMode
        ? { RAVI_SLACK_ROOT_REPLY_MODE: options.routingPolicy.rootReplyMode }
        : {}),
    });
    this.webClient =
      options.webClient ??
      new SlackWebApiClient({
        appToken: options.appToken,
        botToken: options.botToken,
      });
    this.getRouterConfig = options.getRouterConfig ?? (() => configStore.getConfig());
    this.publishPrompt = options.publishPrompt ?? publishSessionPrompt;
    this.openWebSocket = options.openWebSocket ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.socket?.close();
    this.socket = null;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
  }

  async handleEnvelope(
    envelope: SlackSocketEnvelope,
    ack: (envelopeId: string) => Promise<void> | void = async () => {},
  ): Promise<"duplicate" | "ignored" | "processed"> {
    const envelopeId = cleanSlackId(envelope.envelope_id);
    if (envelopeId) {
      await ack(envelopeId);
      if (this.seenEnvelopeIds.has(envelopeId)) {
        log.debug("Duplicate Slack Socket Mode envelope ignored", { envelopeId });
        return "duplicate";
      }
      this.seenEnvelopeIds.add(envelopeId);
    }

    const normalized = this.normalizeEnvelope(envelope);
    if (!normalized) return "ignored";

    await this.routeMessage(normalized);
    return "processed";
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const url = await this.webClient.openSocketConnection();
        await this.runSocket(url);
      } catch (error) {
        if (!this.running) return;
        log.warn("Slack Socket Mode loop failed; reconnecting", { error });
        await delay(this.reconnectDelayMs);
      }
    }
  }

  private runSocket(url: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.openWebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        log.info("Slack Socket Mode connected", { accountId: this.options.accountId });
      };
      socket.onmessage = (event) => {
        this.handleSocketMessage(event.data, socket).catch((error) => {
          log.error("Failed to handle Slack Socket Mode message", { error });
        });
      };
      socket.onerror = (event) => {
        log.warn("Slack Socket Mode socket error", { event });
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        log.info("Slack Socket Mode disconnected", { accountId: this.options.accountId });
        resolve();
      };
    });
  }

  private async handleSocketMessage(raw: unknown, socket: WebSocket): Promise<void> {
    const text = typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString("utf-8") : String(raw);
    const envelope = JSON.parse(text) as SlackSocketEnvelope;
    await this.handleEnvelope(envelope, async (envelopeId) => {
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    });
  }

  private normalizeEnvelope(envelope: SlackSocketEnvelope): SlackNormalizedMessage | null {
    const event = envelopeEvent(envelope);
    if (!event || shouldIgnoreSlackMessageEvent(event)) return null;

    const channelId = cleanSlackId(event.channel);
    const userId = cleanSlackId(event.user);
    const ts = cleanSlackId(event.ts);
    if (!channelId || !userId || !ts) return null;

    const payload = envelope.payload as { team_id?: string; event_id?: string; event_time?: number } | undefined;
    const teamId = cleanSlackId(event.team) ?? cleanSlackId(payload?.team_id) ?? this.options.accountId;
    const thread = resolveSlackThreadContext(event, this.routingPolicy);
    const eventTimeMs = payload?.event_time ? payload.event_time * 1000 : slackTsToMs(ts);

    return {
      teamId,
      channelId,
      channelType: cleanSlackId(event.channel_type) ?? "channel",
      userId,
      text: typeof event.text === "string" ? event.text : "",
      ts,
      thread,
      eventId: cleanSlackId(payload?.event_id),
      envelopeId: cleanSlackId(envelope.envelope_id),
      eventTimeMs,
      rawEnvelope: envelope,
    };
  }

  private async routeMessage(message: SlackNormalizedMessage): Promise<void> {
    const routerConfig = this.getRouterConfig();
    const peerKind = slackPeerKindForChannelType(message.channelType);
    const routeThreadId = message.thread.routeThreadTs;
    const matched = matchRoute(routerConfig, {
      phone: message.channelId,
      channel: "slack",
      accountId: this.options.routeAccountId,
      peerKind,
      threadId: routeThreadId,
    });
    if (!matched) {
      log.info("Slack inbound skipped: no route matched", {
        accountId: this.options.accountId,
        channelId: message.channelId,
        threadId: routeThreadId,
      });
      return;
    }

    const resolved = commitMatchedRoute(matched, {
      phone: message.channelId,
      peerKind,
      threadId: routeThreadId,
    });
    const sessionName = resolved.sessionName ?? resolved.sessionKey;
    const canonicalChat = dbUpsertChat({
      channel: "slack",
      instanceId: this.options.instanceId ?? this.options.accountId,
      platformChatId: routeThreadId ? `${message.channelId}#${routeThreadId}` : message.channelId,
      chatType: routeThreadId ? "thread" : peerKind,
      title: message.channelId,
      rawProvenance: {
        source: "slack.socket_mode",
        teamId: message.teamId,
        channelId: message.channelId,
        threadTs: routeThreadId ?? null,
        envelopeId: message.envelopeId ?? null,
        eventId: message.eventId ?? null,
      },
      seenAt: message.eventTimeMs,
    });

    dbBindSessionToChat({
      sessionKey: resolved.sessionKey,
      chatId: canonicalChat.id,
      agentId: resolved.agent.id,
      routeId: null,
      bindingReason: "slack_socket_mode",
      seenAt: message.eventTimeMs,
    });
    dbUpsertChatMessage({
      chatId: canonicalChat.id,
      channel: "slack",
      instanceId: this.options.instanceId ?? this.options.accountId,
      providerMessageId: message.ts,
      rawChatId: message.channelId,
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
      actorType: "unknown",
      messageType: "text",
      content: {
        type: "text",
        text: message.text,
        threadTs: message.thread.inboundThreadTs ?? null,
        outboundThreadTs: message.thread.outboundThreadTs ?? null,
      },
      rawProvenance: {
        source: "slack.socket_mode",
        teamId: message.teamId,
        eventId: message.eventId ?? null,
        envelopeId: message.envelopeId ?? null,
      },
      providerTimestamp: message.eventTimeMs,
      ingestedAt: Date.now(),
    });
    dbUpsertChatParticipant({
      chatId: canonicalChat.id,
      rawPlatformUserId: message.userId,
      normalizedPlatformUserId: message.userId,
      role: "member",
      status: "active",
      source: "inbound_message",
      metadata: {
        slackTeamId: message.teamId,
        slackChannelType: message.channelType,
      },
      seenAt: message.eventTimeMs,
    });

    if (this.routingPolicy.subscriptionScope === "chat_and_thread" && routeThreadId) {
      const rootChat = dbUpsertChat({
        channel: "slack",
        instanceId: this.options.instanceId ?? this.options.accountId,
        platformChatId: message.channelId,
        chatType: peerKind,
        title: message.channelId,
        rawProvenance: {
          source: "slack.socket_mode",
          teamId: message.teamId,
          channelId: message.channelId,
        },
        seenAt: message.eventTimeMs,
      });
      dbBindSessionToChat({
        sessionKey: resolved.sessionKey,
        chatId: rootChat.id,
        agentId: resolved.agent.id,
        routeId: null,
        bindingReason: "slack_socket_mode:chat_and_thread",
        seenAt: message.eventTimeMs,
      });
    }

    const source: MessageTarget = {
      channel: "slack",
      accountId: this.options.accountId,
      instanceId: this.options.instanceId ?? this.options.accountId,
      chatId: message.channelId,
      canonicalChatId: canonicalChat.id,
      ...(message.thread.outboundThreadTs ? { threadId: message.thread.outboundThreadTs } : {}),
      sourceMessageId: message.ts,
      actorType: "unknown",
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
      suppressPresence: true,
    };
    const context: MessageContext = {
      channelId: "slack",
      channelName: "Slack",
      accountId: this.options.accountId,
      instanceId: this.options.instanceId ?? this.options.accountId,
      chatId: message.channelId,
      messageId: message.ts,
      senderId: message.userId,
      senderName: `<@${message.userId}>`,
      isGroup: peerKind !== "dm",
      groupId: peerKind !== "dm" ? message.channelId : undefined,
      groupName: peerKind !== "dm" ? message.channelId : undefined,
      timestamp: message.eventTimeMs,
      canonicalChatId: canonicalChat.id,
      actorType: "unknown",
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
    };

    await this.publishPrompt(sessionName, {
      prompt: formatSlackPrompt(message),
      source,
      context,
    });
  }
}

export function createSlackNativeRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): SlackNativeRuntime | null {
  if (env.RAVI_SLACK_SOCKET_MODE !== "1" && env.RAVI_SLACK_SOCKET_MODE !== "true") return null;
  const appToken = env.SLACK_APP_TOKEN?.trim();
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!appToken || !botToken) {
    log.warn("Slack native runtime disabled: SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required");
    return null;
  }

  const accountId = env.RAVI_SLACK_ACCOUNT?.trim() || "slack";
  const routeAccountId = env.RAVI_SLACK_ROUTE_ACCOUNT?.trim() || undefined;
  const instanceId = env.RAVI_SLACK_INSTANCE?.trim() || accountId;
  const routingPolicy = slackRoutingPolicyFromEnv(env);
  const webClient = new SlackWebApiClient({ appToken, botToken });
  const socketMode = new SlackSocketModeService({
    appToken,
    botToken,
    accountId,
    routeAccountId,
    instanceId,
    routingPolicy,
    webClient,
  });
  const delivery = new SlackTextDelivery(webClient, routingPolicy);
  return { delivery, socketMode };
}

function formatSlackPrompt(message: SlackNormalizedMessage): string {
  const parts = [
    `Slack ${message.channelId}`,
    message.thread.inboundThreadTs ? `thread:${message.thread.inboundThreadTs}` : undefined,
    `mid:${message.ts}`,
    new Date(message.eventTimeMs).toISOString(),
  ].filter(Boolean);
  return `[${parts.join(" ")}]\n<@${message.userId}>: ${message.text}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { configStore } from "../../config-store.js";
import { resolvePlatformIdentity } from "../../contacts.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { attachChatToSession, commitMatchedRoute, listSessionSubscriptions, matchRoute } from "../../router/index.js";
import {
  dbBindSessionToChat,
  dbListChatParticipants,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertChatParticipant,
} from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import type { MessageActorMetadata, MessageContext, MessageTarget } from "../../runtime/message-types.js";
import { transcribeAudio } from "../../transcribe/openai.js";
import { logger } from "../../utils/logger.js";
import { MAX_AUDIO_BYTES, MAX_MEDIA_BYTES, saveToAgentAttachments } from "../../utils/media.js";
import type {
  NativePresenceDelivery,
  NativePresenceDeliveryRequest,
  NativePresenceDeliveryResult,
  NativeTextDelivery,
  NativeTextDeliveryRequest,
  NativeTextDeliveryResult,
} from "../native/types.js";
import { SlackWebApiClient } from "./client.js";
import { resolveSlackCredentialConfigFromEnv } from "./credentials.js";
import {
  cleanSlackId,
  envelopeEvent,
  resolveSlackThreadContext,
  shouldIgnoreSlackMessageEvent,
  slackPeerKindForChannelType,
  slackRoutingPolicyFromEnv,
  slackTsToMs,
} from "./routing.js";
import type { SlackNormalizedFile, SlackNormalizedMessage, SlackRoutingPolicy, SlackSocketEnvelope } from "./types.js";

const log = logger.child("channels:slack");

type PublishPrompt = typeof publishSessionPrompt;
type WebSocketFactory = (url: string) => WebSocket;

interface ProcessedSlackFile extends SlackNormalizedFile {
  readonly localPath?: string;
  readonly transcript?: string;
  readonly transcriptionProvider?: string;
  readonly transcriptionModel?: string;
  readonly downloadError?: string;
  readonly transcriptionError?: string;
}

interface SlackActorIdentity extends MessageActorMetadata {
  readonly actorType: "contact" | "agent" | "unknown";
}

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
  readonly presence: NativePresenceDelivery;
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

export class SlackAssistantThreadPresence implements NativePresenceDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly webClient: Pick<SlackWebApiClient, "setAssistantThreadStatus">,
    private readonly options: { statusText?: string; loadingMessages?: readonly string[] } = {},
  ) {}

  supports(target: MessageTarget): boolean {
    return target.channel.toLowerCase() === this.channelId;
  }

  async sendPresence(request: NativePresenceDeliveryRequest): Promise<NativePresenceDeliveryResult> {
    const threadTs = request.target.threadId ?? request.target.statusAnchorMessageId ?? request.target.sourceMessageId;
    if (!threadTs) {
      return {
        provider: "slack",
        status: "skipped",
        reason: "missing_thread_ts",
      };
    }

    const status = request.active ? (this.options.statusText ?? "is working...") : "";
    const raw = await this.webClient.setAssistantThreadStatus({
      channelId: request.target.chatId,
      threadTs,
      status,
      ...(request.active && this.options.loadingMessages?.length
        ? { loadingMessages: this.options.loadingMessages }
        : {}),
    });
    return {
      provider: "slack",
      status: request.active ? "active" : "inactive",
      raw: {
        method: "assistant.threads.setStatus",
        channelId: request.target.chatId,
        threadTs,
        statusSet: status.length > 0,
        response: raw,
      },
    };
  }
}

export class SlackReactionPresence implements NativePresenceDelivery {
  readonly channelId = "slack";
  private readonly activeReactions = new Set<string>();

  constructor(
    private readonly webClient: SlackWebApiClient,
    private readonly options: { reactionName?: string } = {},
  ) {}

  supports(target: MessageTarget): boolean {
    return target.channel.toLowerCase() === this.channelId;
  }

  async sendPresence(request: NativePresenceDeliveryRequest): Promise<NativePresenceDeliveryResult> {
    const timestamp = request.target.statusAnchorMessageId ?? request.target.sourceMessageId;
    if (!timestamp) {
      return {
        provider: "slack",
        status: "skipped",
        reason: "missing_source_message",
      };
    }

    const reactionName = this.options.reactionName ?? "hourglass_flowing_sand";
    const key = `${request.target.chatId}:${timestamp}:${reactionName}`;
    if (request.active) {
      if (this.activeReactions.has(key)) {
        return {
          provider: "slack",
          status: "active",
          reason: "already_active",
        };
      }
      const raw = await this.webClient.addReaction({
        channel: request.target.chatId,
        timestamp,
        name: reactionName,
      });
      this.activeReactions.add(key);
      return {
        provider: "slack",
        status: "active",
        raw,
      };
    }

    const hadLocalState = this.activeReactions.has(key);
    const raw = await this.webClient.removeReaction({
      channel: request.target.chatId,
      timestamp,
      name: reactionName,
    });
    this.activeReactions.delete(key);
    return {
      provider: "slack",
      status: "inactive",
      reason: hadLocalState ? undefined : "cleared_without_local_state",
      raw,
    };
  }
}

type SlackReactionPresenceMode = "always" | "off";

export class SlackPresenceStack implements NativePresenceDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly primary: NativePresenceDelivery,
    private readonly reaction: NativePresenceDelivery | null,
    private readonly options: { reactionMode?: SlackReactionPresenceMode } = {},
  ) {}

  supports(target: MessageTarget): boolean {
    return this.primary.supports(target) || this.reaction?.supports(target) === true;
  }

  async sendPresence(request: NativePresenceDeliveryRequest): Promise<NativePresenceDeliveryResult> {
    const reactionMode = this.options.reactionMode ?? "off";
    let primaryResult: NativePresenceDeliveryResult | null = null;
    let primaryError: unknown;
    try {
      primaryResult = await this.primary.sendPresence(request);
    } catch (error) {
      primaryError = error;
      if (!this.reaction || reactionMode === "off") throw error;
    }

    const shouldUseReaction = Boolean(this.reaction) && reactionMode === "always";

    let reactionResult: NativePresenceDeliveryResult | null = null;
    let reactionError: unknown;
    if (shouldUseReaction && this.reaction) {
      try {
        reactionResult = await this.reaction.sendPresence(request);
      } catch (error) {
        reactionError = error;
        if (!primaryResult) throw error;
      }
    }

    if (primaryResult && reactionResult) {
      const fallbackTookOver = primaryResult.status === "skipped";
      return {
        provider: "slack",
        status: fallbackTookOver ? reactionResult.status : primaryResult.status,
        reason: fallbackTookOver ? "fallback_after_primary_skipped" : primaryResult.reason,
        raw: {
          primary: publicPresenceResult(primaryResult),
          reaction: publicPresenceResult(reactionResult),
        },
      };
    }

    if (primaryResult) {
      if (reactionError) {
        return {
          provider: "slack",
          status: primaryResult.status,
          reason: primaryResult.reason,
          raw: {
            primary: publicPresenceResult(primaryResult),
            reactionError: publicError(reactionError),
          },
        };
      }
      return primaryResult;
    }

    if (reactionResult) {
      return {
        provider: "slack",
        status: reactionResult.status,
        reason: primaryError ? "fallback_after_primary_error" : reactionResult.reason,
        raw: {
          primaryError: primaryError ? publicError(primaryError) : undefined,
          reaction: publicPresenceResult(reactionResult),
        },
      };
    }

    return {
      provider: "slack",
      status: "skipped",
      reason: "no_presence_delivery",
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
    const text = typeof event.text === "string" ? event.text : "";
    const files = normalizeSlackFiles(event.files);
    if (!text.trim() && files.length === 0) return null;

    return {
      teamId,
      channelId,
      channelType: cleanSlackId(event.channel_type) ?? "channel",
      userId,
      text,
      files,
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
    const isGroup = peerKind !== "dm";
    const routeThreadId = message.thread.routeThreadTs;
    const matched = matchRoute(routerConfig, {
      phone: message.channelId,
      channel: "slack",
      accountId: this.options.routeAccountId,
      isGroup,
      groupId: isGroup ? message.channelId : undefined,
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
      isGroup,
      groupId: isGroup ? message.channelId : undefined,
      peerKind,
      threadId: routeThreadId,
    });
    const sessionName = resolved.sessionName ?? resolved.sessionKey;
    const instanceId = this.options.instanceId ?? this.options.accountId;
    const canonicalChat = dbUpsertChat({
      channel: "slack",
      instanceId,
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
    syncSlackSessionSubscription(resolved.sessionKey, canonicalChat.id);
    const actorIdentity = resolveSlackActorIdentity({
      chatId: canonicalChat.id,
      instanceId,
      platformUserId: message.userId,
    });
    const processedFiles = await this.processFiles(message, resolved.agent.cwd);
    dbUpsertChatMessage({
      chatId: canonicalChat.id,
      channel: "slack",
      instanceId,
      providerMessageId: message.ts,
      rawChatId: message.channelId,
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
      actorType: actorIdentity.actorType,
      contactId: actorIdentity.contactId,
      agentId: actorIdentity.actorAgentId,
      platformIdentityId: actorIdentity.platformIdentityId,
      messageType: inferSlackMessageType(message),
      content: buildSlackMessageContent(message, processedFiles),
      rawProvenance: {
        source: "slack.socket_mode",
        teamId: message.teamId,
        eventId: message.eventId ?? null,
        envelopeId: message.envelopeId ?? null,
        fileIds: message.files.map((file) => file.id),
      },
      providerTimestamp: message.eventTimeMs,
      ingestedAt: Date.now(),
    });
    dbUpsertChatParticipant({
      chatId: canonicalChat.id,
      platformIdentityId: actorIdentity.platformIdentityId,
      contactId: actorIdentity.contactId,
      agentId: actorIdentity.actorAgentId,
      rawPlatformUserId: message.userId,
      normalizedPlatformUserId: message.userId,
      role: "member",
      status: "active",
      source: actorIdentity.actorType === "unknown" ? "inbound_message" : "slack_socket_mode:identity_resolved",
      metadata: {
        slackTeamId: message.teamId,
        slackChannelType: message.channelType,
        actorType: actorIdentity.actorType,
        identityProvenance: actorIdentity.identityProvenance ?? null,
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
      syncSlackSessionSubscription(resolved.sessionKey, rootChat.id, { forceInput: true });
    }

    const source: MessageTarget = {
      channel: "slack",
      accountId: this.options.accountId,
      instanceId,
      chatId: message.channelId,
      canonicalChatId: canonicalChat.id,
      ...(message.thread.outboundThreadTs ? { threadId: message.thread.outboundThreadTs } : {}),
      sourceMessageId: message.ts,
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
      ...actorIdentity,
    };
    const context: MessageContext = {
      channelId: "slack",
      channelName: "Slack",
      accountId: this.options.accountId,
      instanceId,
      chatId: message.channelId,
      messageId: message.ts,
      senderId: message.userId,
      senderName: `<@${message.userId}>`,
      isGroup: peerKind !== "dm",
      groupId: peerKind !== "dm" ? message.channelId : undefined,
      groupName: peerKind !== "dm" ? message.channelId : undefined,
      timestamp: message.eventTimeMs,
      canonicalChatId: canonicalChat.id,
      rawSenderId: message.userId,
      normalizedSenderId: message.userId,
      ...actorIdentity,
    };

    await this.publishPrompt(sessionName, {
      prompt: formatSlackPrompt(message, processedFiles),
      source,
      context,
      deliveryBarrier: "after_tool",
      deliveryBarrierSource: "default",
    });
  }

  private async processFiles(
    message: SlackNormalizedMessage,
    agentCwd: string,
  ): Promise<readonly ProcessedSlackFile[]> {
    if (message.files.length === 0) return [];

    const processed: ProcessedSlackFile[] = [];
    for (let index = 0; index < message.files.length; index++) {
      const file = message.files[index];
      if (!file) continue;
      processed.push(await this.processFile(message, file, index, agentCwd));
    }
    return processed;
  }

  private async processFile(
    message: SlackNormalizedMessage,
    file: SlackNormalizedFile,
    index: number,
    agentCwd: string,
  ): Promise<ProcessedSlackFile> {
    const downloadUrl = file.privateDownloadUrl ?? file.privateUrl;
    if (!downloadUrl) return file;

    const isAudio = isSlackAudioFile(file);
    const maxBytes = isAudio ? MAX_AUDIO_BYTES : MAX_MEDIA_BYTES;
    try {
      const download = await this.webClient.downloadFile({ url: downloadUrl, maxBytes });
      const mimeType = file.mimeType ?? download.contentType ?? "application/octet-stream";
      const messageId = `${message.ts}-${file.id || index}`;
      const localPath = await saveToAgentAttachments(download.buffer, agentCwd, messageId, mimeType);
      if (!isAudio) return { ...file, mimeType, localPath };

      try {
        const transcription = await transcribeAudio(download.buffer, mimeType);
        return {
          ...file,
          mimeType,
          localPath,
          transcript: transcription.text,
          transcriptionProvider: transcription.provider,
          transcriptionModel: transcription.model,
        };
      } catch (error) {
        log.warn("Slack audio transcription failed", {
          fileId: file.id,
          mimeType,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ...file,
          mimeType,
          localPath,
          transcriptionError: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      log.warn("Slack file download failed", {
        fileId: file.id,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...file,
        downloadError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function resolveSlackActorIdentity(input: {
  chatId: string;
  instanceId: string;
  platformUserId: string;
}): SlackActorIdentity {
  const participant = dbListChatParticipants(input.chatId).find(
    (candidate) => candidate.normalizedPlatformUserId === input.platformUserId,
  );
  if (participant?.agentId) {
    return {
      actorType: "agent",
      actorAgentId: participant.agentId,
      platformIdentityId: participant.platformIdentityId,
      rawSenderId: input.platformUserId,
      normalizedSenderId: input.platformUserId,
      identityConfidence: 1,
      identityProvenance: { source: "chat_participants", chatId: input.chatId },
    };
  }
  if (participant?.contactId) {
    return {
      actorType: "contact",
      contactId: participant.contactId,
      platformIdentityId: participant.platformIdentityId,
      rawSenderId: input.platformUserId,
      normalizedSenderId: input.platformUserId,
      identityConfidence: 1,
      identityProvenance: { source: "chat_participants", chatId: input.chatId },
    };
  }

  const identity =
    resolvePlatformIdentity({ channel: "slack", instanceId: input.instanceId, platformUserId: input.platformUserId }) ??
    resolvePlatformIdentity({ channel: "slack", instanceId: "", platformUserId: input.platformUserId });
  if (identity?.ownerType === "agent" && identity.ownerId) {
    return {
      actorType: "agent",
      actorAgentId: identity.ownerId,
      platformIdentityId: identity.id,
      rawSenderId: input.platformUserId,
      normalizedSenderId: identity.normalizedPlatformUserId,
      identityConfidence: identity.confidence,
      identityProvenance: {
        source: "platform_identities",
        channel: identity.channel,
        instanceId: identity.instanceId,
      },
    };
  }
  if (identity?.ownerType === "contact" && identity.ownerId) {
    return {
      actorType: "contact",
      contactId: identity.ownerId,
      platformIdentityId: identity.id,
      rawSenderId: input.platformUserId,
      normalizedSenderId: identity.normalizedPlatformUserId,
      identityConfidence: identity.confidence,
      identityProvenance: {
        source: "platform_identities",
        channel: identity.channel,
        instanceId: identity.instanceId,
      },
    };
  }

  return {
    actorType: "unknown",
    rawSenderId: input.platformUserId,
    normalizedSenderId: input.platformUserId,
    identityConfidence: 0,
    identityProvenance: { source: "slack_socket_mode", reason: "missing_contact" },
  };
}

function syncSlackSessionSubscription(
  sessionKey: string,
  chatId: string,
  options: { forceInput?: boolean } = {},
): void {
  try {
    const existingSubscriptions = listSessionSubscriptions(sessionKey);
    const existingSubscription = existingSubscriptions.find((subscription) => subscription.chatId === chatId);
    const hasPrimary = existingSubscriptions.some((subscription) => subscription.role === "primary");
    const hasOutputTarget = existingSubscriptions.some((subscription) => subscription.outputAttachedAt !== undefined);
    const role = existingSubscription?.role ?? (options.forceInput || hasPrimary ? "input" : "primary");
    const setOutputTarget =
      existingSubscription?.outputAttachedAt !== undefined ||
      (!existingSubscription && role === "primary") ||
      (!hasOutputTarget && role === "primary");
    const shouldEnableSpeech = setOutputTarget || (!existingSubscription && role === "primary");

    attachChatToSession({
      sessionKey,
      chatId,
      role,
      attachedByType: "system",
      attachedReason: "slack-socket-mode",
      speechMode: existingSubscription
        ? shouldEnableSpeech
          ? "speak"
          : undefined
        : role === "primary"
          ? "speak"
          : "muted",
      speechReason: existingSubscription
        ? shouldEnableSpeech
          ? "primary-slack-socket-mode"
          : undefined
        : role === "primary"
          ? "primary-slack-socket-mode"
          : "listen-only-slack-socket-mode",
      setOutputTarget,
    });
  } catch (error) {
    log.warn("Failed to record Slack session_chat_subscription", {
      sessionKey,
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createSlackNativeRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlackNativeRuntime | null> {
  if (env.RAVI_SLACK_SOCKET_MODE !== "1" && env.RAVI_SLACK_SOCKET_MODE !== "true") return null;
  const credentials = await resolveSlackCredentialConfigFromEnv(env);
  if (!credentials) {
    log.warn("Slack native runtime disabled: configure RAVI_SLACK_CONNECTION or opt into env credentials");
    return null;
  }

  const routingPolicy = slackRoutingPolicyFromEnv(env);
  const webClient = new SlackWebApiClient({
    appToken: credentials.appToken,
    botToken: credentials.botToken,
  });
  const socketMode = new SlackSocketModeService({
    appToken: credentials.appToken,
    botToken: credentials.botToken,
    accountId: credentials.accountId,
    routeAccountId: credentials.routeAccountId,
    instanceId: credentials.instanceId,
    routingPolicy,
    webClient,
  });
  const delivery = new SlackTextDelivery(webClient, routingPolicy);
  const reactionPresence = new SlackReactionPresence(webClient, {
    reactionName: env.RAVI_SLACK_WORKING_REACTION?.trim() || "hourglass_flowing_sand",
  });
  const reactionMode = slackReactionPresenceModeFromEnv(env.RAVI_SLACK_REACTION_PRESENCE);
  const assistantPresenceEnabled = slackAssistantPresenceEnabledFromEnv(env.RAVI_SLACK_ASSISTANT_STATUS);
  const presence = assistantPresenceEnabled
    ? new SlackPresenceStack(
        new SlackAssistantThreadPresence(webClient, {
          statusText: env.RAVI_SLACK_ASSISTANT_STATUS_TEXT?.trim() || "is working...",
        }),
        reactionMode === "off" ? null : reactionPresence,
        { reactionMode },
      )
    : reactionPresence;
  log.info("Slack native runtime configured", {
    accountId: credentials.accountId,
    instanceId: credentials.instanceId,
    source: credentials.source,
    assistantPresenceEnabled,
    reactionPresenceMode: reactionMode,
  });
  return { delivery, presence, socketMode };
}

function slackAssistantPresenceEnabledFromEnv(value: string | undefined): boolean {
  if (!value) return true;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

function slackReactionPresenceModeFromEnv(value: string | undefined): SlackReactionPresenceMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "off";
  if (["always", "true", "1", "on", "yes"].includes(normalized)) return "always";
  if (["off", "false", "0", "none", "no"].includes(normalized)) return "off";
  return "off";
}

function publicPresenceResult(result: NativePresenceDeliveryResult): Record<string, unknown> {
  return {
    provider: result.provider,
    status: result.status,
    reason: result.reason,
    raw: result.raw,
  };
}

function publicError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : {
        message: String(error),
      };
}

function formatSlackPrompt(message: SlackNormalizedMessage, files: readonly ProcessedSlackFile[] = []): string {
  const parts = [
    `Slack ${message.channelId}`,
    message.thread.inboundThreadTs ? `thread:${message.thread.inboundThreadTs}` : undefined,
    `mid:${message.ts}`,
    new Date(message.eventTimeMs).toISOString(),
  ].filter(Boolean);
  return `[${parts.join(" ")}]\n<@${message.userId}>: ${formatSlackMessageBody(message, files)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSlackFiles(value: unknown): SlackNormalizedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((file, index) => normalizeSlackFile(file, index))
    .filter((file): file is SlackNormalizedFile => Boolean(file));
}

function normalizeSlackFile(value: unknown, index: number): SlackNormalizedFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = firstString(record.id) ?? `file-${index}`;
  return {
    id,
    ...(firstString(record.name) ? { name: firstString(record.name) } : {}),
    ...(firstString(record.title) ? { title: firstString(record.title) } : {}),
    ...(firstString(record.mimetype) ? { mimeType: firstString(record.mimetype) } : {}),
    ...(firstString(record.filetype) ? { fileType: firstString(record.filetype) } : {}),
    ...(firstNumber(record.size) !== undefined ? { sizeBytes: firstNumber(record.size) } : {}),
    ...(firstString(record.media_display_type) ? { mediaDisplayType: firstString(record.media_display_type) } : {}),
    ...(firstString(record.url_private) ? { privateUrl: firstString(record.url_private) } : {}),
    ...(firstString(record.url_private_download)
      ? { privateDownloadUrl: firstString(record.url_private_download) }
      : {}),
  };
}

function firstString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferSlackMessageType(message: SlackNormalizedMessage): string {
  if (message.files.some(isSlackAudioFile)) return "audio";
  if (message.files.length > 0) return "media";
  return "text";
}

function buildSlackMessageContent(
  message: SlackNormalizedMessage,
  files: readonly ProcessedSlackFile[],
): Record<string, unknown> {
  const type = inferSlackMessageType(message);
  return {
    type,
    text: message.text,
    threadTs: message.thread.inboundThreadTs ?? null,
    outboundThreadTs: message.thread.outboundThreadTs ?? null,
    ...(files.length > 0 ? { files: files.map(publicSlackFileMetadata) } : {}),
  };
}

function publicSlackFileMetadata(file: ProcessedSlackFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name ?? null,
    title: file.title ?? null,
    mimeType: file.mimeType ?? null,
    fileType: file.fileType ?? null,
    sizeBytes: file.sizeBytes ?? null,
    mediaDisplayType: file.mediaDisplayType ?? null,
    localPath: file.localPath ?? null,
    transcript: file.transcript ?? null,
    transcriptionProvider: file.transcriptionProvider ?? null,
    transcriptionModel: file.transcriptionModel ?? null,
  };
}

function formatSlackMessageBody(message: SlackNormalizedMessage, files: readonly ProcessedSlackFile[]): string {
  const parts: string[] = [];
  const text = message.text.trim();
  if (text) parts.push(text);
  for (const file of files) {
    parts.push(formatSlackFileForPrompt(file));
  }
  return parts.length > 0 ? parts.join("\n\n") : "[message]";
}

function formatSlackFileForPrompt(file: ProcessedSlackFile): string {
  const kind = isSlackAudioFile(file) ? "Audio" : "Attachment";
  const details = [fileDisplayName(file), file.mimeType, formatBytes(file.sizeBytes)].filter(Boolean).join(", ");
  const lines = [`[${kind}${details ? `: ${details}` : ""}]`];
  if (isSlackAudioFile(file)) {
    if (file.transcript?.trim()) {
      lines.push("Transcript:", file.transcript.trim());
    } else {
      lines.push("Transcript: unavailable");
    }
  }
  if (file.localPath) lines.push(`file: ${file.localPath}`);
  return lines.join("\n");
}

function fileDisplayName(file: SlackNormalizedFile): string | undefined {
  return file.title ?? file.name ?? (file.id ? `file ${file.id}` : undefined);
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isSlackAudioFile(file: Pick<SlackNormalizedFile, "mimeType" | "fileType" | "mediaDisplayType">): boolean {
  const mimeType = file.mimeType?.toLowerCase();
  const fileType = file.fileType?.toLowerCase();
  const mediaDisplayType = file.mediaDisplayType?.toLowerCase();
  return Boolean(
    mimeType?.startsWith("audio/") ||
      mediaDisplayType === "audio" ||
      fileType === "m4a" ||
      fileType === "mp3" ||
      fileType === "ogg" ||
      fileType === "wav" ||
      fileType === "webm",
  );
}

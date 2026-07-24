import { createHash } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { configStore } from "../../config-store.js";
import { resolvePlatformIdentity, type PlatformIdentity } from "../../contacts.js";
import { publish } from "../../nats.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import {
  attachChatToSession,
  commitMatchedRoute,
  findSessionByAttachedChat,
  getSession,
  listSessionSubscriptions,
  matchRoute,
  subscriptionAllowsCrossInstance,
} from "../../router/index.js";
import {
  dbBindSessionToChat,
  dbListChatParticipants,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertChatParticipant,
  type ChannelConfig,
} from "../../router/router-db.js";
import type { MatchedRoute, ResolvedRoute, RouterConfig } from "../../router/types.js";
import type { MessageActorMetadata, MessageContext, MessageTarget } from "../../runtime/message-types.js";
import { transcribeAudio } from "../../transcribe/openai.js";
import { logger } from "../../utils/logger.js";
import { MAX_AUDIO_BYTES, MAX_MEDIA_BYTES, saveToAgentAttachments } from "../../utils/media.js";
import type {
  NativeChatActionDelivery,
  NativeChatActionDeliveryRequest,
  NativeChatActionDeliveryResult,
  NativePresenceDelivery,
  NativePresenceDeliveryRequest,
  NativePresenceDeliveryResult,
  NativeTextDelivery,
  NativeTextDeliveryRequest,
  NativeTextDeliveryResult,
} from "../native/types.js";
import { SlackWebApiClient } from "./client.js";
import { resolveSlackCredentialConfigFromEnv, type SlackCredentialResolver } from "./credentials.js";
import {
  buildSlackInstanceProvenance,
  resolveScopedSlackIdentity,
  resolveSlackInstanceAliases,
  SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
  SLACK_IDENTITY_NOT_FOUND_REASON,
  type SlackInstanceAliasResolution,
  type SlackScopedIdentityResolution,
} from "./instance-alias.js";
import { storeSlackInteractionResponseUrl } from "./interactions.js";
import {
  cleanSlackId,
  envelopeEvent,
  isSlackMessageEventStructurallyEligible,
  normalizeSlackRoutingPolicy,
  resolveSlackThreadContext,
  shouldIgnoreSlackMessageEvent,
  slackPeerKindForChannelType,
  slackRoutingPolicyFromChannelDefaults,
  slackRoutingPolicyFromEnv,
  slackSenderIdForEvent,
  slackTsToMs,
} from "./routing.js";
import type {
  SlackEventPayload,
  SlackNormalizedFile,
  SlackNormalizedMessage,
  SlackRoutingPolicy,
  SlackSocketEnvelope,
} from "./types.js";

const log = logger.child("channels:slack");
const SLACK_THREAD_CREATED_TOPIC = "ravi.inbound.thread.created";
const DEFAULT_SLACK_AUTH_TEST_FAILURE_RETRY_MS = 5_000;
const DEFAULT_SLACK_AUTH_TEST_TIMEOUT_MS = 5_000;
const DEFAULT_SLACK_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_SLACK_PONG_TIMEOUT_MS = 5_000;
const DEFAULT_SLACK_HELLO_TIMEOUT_MS = 10_000;
const SLACK_FILE_INFO_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;

type PublishPrompt = typeof publishSessionPrompt;
type PublishInteraction = (topic: string, payload: Record<string, unknown>) => Promise<void>;
type WebSocketFactory = (url: string) => NodeWebSocket;
type SocketTimer = ReturnType<typeof setTimeout>;

export type SlackSocketModeState = "stopped" | "connecting" | "connected" | "reconnecting";

export type SlackSocketModeReason =
  | "stopped"
  | "opening_socket"
  | "awaiting_hello"
  | "open_failed"
  | "hello_timeout"
  | "heartbeat_timeout"
  | "socket_error"
  | "socket_closed"
  | "slack_disconnect";

export interface SlackSocketModeStatus {
  readonly state: SlackSocketModeState;
  readonly connectedAt?: number;
  readonly lastPongAt?: number;
  readonly reconnectCount: number;
  readonly reason?: SlackSocketModeReason;
}

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

interface SlackLocalBotIdentity {
  readonly botId: string;
  readonly userId: string;
  readonly teamId: string;
}

interface SlackBotIdentityResolutionOutcome {
  readonly platformUserId: string;
  readonly resolution: SlackScopedIdentityResolution<PlatformIdentity>;
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
  readonly publishInteraction?: PublishInteraction;
  readonly openWebSocket?: WebSocketFactory;
  readonly reconnectDelayMs?: number;
  /** Interval between successful heartbeat round-trips. */
  readonly heartbeatIntervalMs?: number;
  /** Maximum time to wait for a pong after each ping. */
  readonly pongTimeoutMs?: number;
  /** Maximum time an open transport may wait for Slack's hello envelope. */
  readonly helloTimeoutMs?: number;
  /** Timer injection for deterministic Socket Mode lifecycle tests. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  /** Negative-cache backoff for failed auth.test calls. Successful identities remain cached. */
  readonly authTestFailureRetryMs?: number;
  /** Maximum time bot intake waits for Slack auth.test before failing closed. */
  readonly authTestTimeoutMs?: number;
  /** Clock injection for bounded auth.test retry tests. */
  readonly now?: () => number;
  readonly transcribeAudio?: typeof transcribeAudio;
}

export interface SlackNativeRuntime {
  readonly id: string;
  readonly accountId: string;
  readonly instanceId: string;
  readonly connection: string;
  readonly delivery: NativeTextDelivery;
  readonly actions: NativeChatActionDelivery;
  readonly presence: NativePresenceDelivery;
  readonly socketMode: SlackSocketModeService;
}

export interface SlackTargetScope {
  readonly accountId: string;
  readonly routeAccountId?: string;
  readonly instanceId?: string;
  readonly connection?: string;
  readonly instanceAliases?: readonly string[];
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

function supportsSlackTarget(target: MessageTarget, scope?: SlackTargetScope): boolean {
  if (target.channel.toLowerCase() !== "slack") return false;
  if (!scope) return true;

  const targetIds = normalizeSlackTargetIds([target.accountId, target.instanceId]);
  const scopeIds = normalizeSlackTargetIds([
    scope.accountId,
    scope.routeAccountId,
    scope.instanceId,
    scope.connection,
    ...(scope.instanceAliases ?? []),
  ]);
  if (targetIds.length === 0 || scopeIds.length === 0) return false;
  return targetIds.every((id) => scopeIds.includes(id));
}

function normalizeSlackTargetIds(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value))),
  );
}

export class SlackTextDelivery implements NativeTextDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly webClient: SlackWebApiClient,
    private readonly routingPolicy: SlackRoutingPolicy,
    private readonly scope?: SlackTargetScope,
  ) {}

  supports(target: MessageTarget): boolean {
    return supportsSlackTarget(target, this.scope);
  }

  async deliverText(request: NativeTextDeliveryRequest): Promise<NativeTextDeliveryResult> {
    const threadTs = this.routingPolicy.threadReplyMode === "channel_root" ? undefined : request.target.threadId;
    const result = await this.webClient.postMessage({
      channel: request.target.chatId,
      text: request.text,
      clientMsgId: slackClientMessageId(request.idempotencyKey),
      ...(threadTs ? { threadTs } : {}),
    });
    return {
      provider: "slack",
      messageId: result.messageId,
      platformMessageId: result.ts,
      providerTimestamp: slackTsToMs(result.ts),
      raw: result.raw,
    };
  }
}

export class SlackChatActionDelivery implements NativeChatActionDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly webClient: SlackWebApiClient,
    private readonly scope?: SlackTargetScope,
  ) {}

  supports(target: MessageTarget): boolean {
    return supportsSlackTarget(target, this.scope);
  }

  async executeChatAction(request: NativeChatActionDeliveryRequest): Promise<NativeChatActionDeliveryResult> {
    const { action, target } = request;
    if (action.actionId === "message.edit") {
      const result = await this.webClient.updateMessage({
        channel: target.chatId,
        ts: action.providerMessageId,
        text: action.text,
      });
      return {
        provider: "slack",
        messageId: result.messageId,
        platformMessageId: result.ts,
        providerTimestamp: slackTsToMs(result.ts),
        raw: result.raw,
      };
    }

    if (action.actionId === "message.delete") {
      const raw = await this.webClient.deleteMessage({
        channel: target.chatId,
        ts: action.providerMessageId,
      });
      return {
        provider: "slack",
        messageId: action.providerMessageId,
        platformMessageId: action.providerMessageId,
        providerTimestamp: slackTsToMs(action.providerMessageId),
        raw,
      };
    }

    const name = normalizeSlackReactionName(action.emoji);
    const raw =
      action.operation === "remove"
        ? await this.webClient.removeReaction({
            channel: target.chatId,
            timestamp: action.providerMessageId,
            name,
          })
        : await this.webClient.addReaction({
            channel: target.chatId,
            timestamp: action.providerMessageId,
            name,
          });
    return {
      provider: "slack",
      messageId: action.providerMessageId,
      platformMessageId: action.providerMessageId,
      providerTimestamp: slackTsToMs(action.providerMessageId),
      raw,
    };
  }
}

function normalizeSlackReactionName(value: string): string {
  const normalized = value.trim().replace(/^:+|:+$/g, "");
  if (!normalized) throw new Error("Slack reaction emoji is required");
  return normalized;
}

/** Stable UUID token for Slack's client_msg_id duplicate-suppression support. */
export function slackClientMessageId(idempotencyKey: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1").update(namespace).update(`ravi:${idempotencyKey}`, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SlackAssistantThreadPresence implements NativePresenceDelivery {
  readonly channelId = "slack";

  constructor(
    private readonly webClient: Pick<SlackWebApiClient, "setAssistantThreadStatus">,
    private readonly options: { statusText?: string; loadingMessages?: readonly string[] } = {},
    private readonly scope?: SlackTargetScope,
  ) {}

  supports(target: MessageTarget): boolean {
    return supportsSlackTarget(target, this.scope);
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
    private readonly scope?: SlackTargetScope,
  ) {}

  supports(target: MessageTarget): boolean {
    return supportsSlackTarget(target, this.scope);
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
  private readonly publishInteraction: PublishInteraction;
  private readonly openWebSocket: WebSocketFactory;
  private readonly routingPolicy: SlackRoutingPolicy;
  private readonly reconnectDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly authTestFailureRetryMs: number;
  private readonly authTestTimeoutMs: number;
  private readonly now: () => number;
  private readonly seenEnvelopeIds = new RecentIdCache();
  private localBotIdentity: SlackLocalBotIdentity | null = null;
  private localBotIdentityInFlight: Promise<SlackLocalBotIdentity | null> | null = null;
  private nextLocalBotIdentityAttemptAt = 0;
  private running = false;
  private socket: NodeWebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private socketGeneration = 0;
  private settleCurrentSocket: (() => void) | null = null;
  private interruptConnectionOpen: (() => void) | null = null;
  private interruptReconnectDelay: (() => void) | null = null;
  private lifecycleState: SlackSocketModeState = "stopped";
  private lifecycleReason: SlackSocketModeReason | undefined = "stopped";
  private connectedAt: number | undefined;
  private lastPongAt: number | undefined;
  private reconnectCount = 0;

  constructor(private readonly options: SlackSocketModeServiceOptions) {
    this.routingPolicy = normalizeSlackRoutingPolicy({
      ...slackRoutingPolicyFromEnv(),
      ...(options.routingPolicy ?? {}),
    });
    this.webClient =
      options.webClient ??
      new SlackWebApiClient({
        appToken: options.appToken,
        botToken: options.botToken,
      });
    this.getRouterConfig = options.getRouterConfig ?? (() => configStore.getConfig());
    this.publishPrompt = options.publishPrompt ?? publishSessionPrompt;
    this.publishInteraction = options.publishInteraction ?? publish;
    this.openWebSocket = options.openWebSocket ?? ((url) => new NodeWebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.heartbeatIntervalMs = positiveDuration(options.heartbeatIntervalMs, DEFAULT_SLACK_HEARTBEAT_INTERVAL_MS);
    this.pongTimeoutMs = positiveDuration(options.pongTimeoutMs, DEFAULT_SLACK_PONG_TIMEOUT_MS);
    this.helloTimeoutMs = positiveDuration(options.helloTimeoutMs, DEFAULT_SLACK_HELLO_TIMEOUT_MS);
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.authTestFailureRetryMs = Math.max(
      0,
      Number.isFinite(options.authTestFailureRetryMs)
        ? (options.authTestFailureRetryMs ?? DEFAULT_SLACK_AUTH_TEST_FAILURE_RETRY_MS)
        : DEFAULT_SLACK_AUTH_TEST_FAILURE_RETRY_MS,
    );
    this.authTestTimeoutMs = Math.max(
      1,
      Number.isFinite(options.authTestTimeoutMs)
        ? (options.authTestTimeoutMs ?? DEFAULT_SLACK_AUTH_TEST_TIMEOUT_MS)
        : DEFAULT_SLACK_AUTH_TEST_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connectedAt = undefined;
    this.reconnectCount = 0;
    this.setLifecycle("connecting", "opening_socket");
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.interruptConnectionOpen?.();
    this.interruptConnectionOpen = null;
    this.interruptReconnectDelay?.();
    this.interruptReconnectDelay = null;
    this.settleCurrentSocket?.();
    this.settleCurrentSocket = null;
    this.terminateSocket(this.socket);
    this.socket = null;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    this.connectedAt = undefined;
    this.setLifecycle("stopped", "stopped");
  }

  status(): SlackSocketModeStatus {
    return {
      state: this.lifecycleState,
      ...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastPongAt !== undefined ? { lastPongAt: this.lastPongAt } : {}),
      reconnectCount: this.reconnectCount,
      ...(this.lifecycleReason ? { reason: this.lifecycleReason } : {}),
    };
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

    const interaction = this.normalizeInteractionEnvelope(envelope);
    if (interaction) {
      await this.publishInteraction("ravi.inbound.interaction", interaction);
      return "processed";
    }

    const workObjectEvent = this.normalizeWorkObjectEventEnvelope(envelope);
    if (workObjectEvent) {
      await this.publishInteraction("ravi.inbound.interaction", workObjectEvent);
      return "processed";
    }

    const normalized = await this.normalizeEnvelope(envelope);
    if (!normalized) return "ignored";

    await this.routeMessage(normalized);
    return "processed";
  }

  private async runLoop(): Promise<void> {
    let attemptedConnection = false;
    while (this.running) {
      if (attemptedConnection) {
        this.reconnectCount += 1;
        this.setLifecycle("reconnecting", "opening_socket");
      }
      try {
        const url = await this.openSocketConnectionUntilStopped();
        if (!url || !this.running) return;
        const ended = await this.runSocket(url);
        attemptedConnection = true;
        if (!this.running) return;
        if (ended !== "slack_disconnect") {
          await this.waitForReconnectDelay();
        }
      } catch (error) {
        if (!this.running) return;
        attemptedConnection = true;
        this.connectedAt = undefined;
        this.setLifecycle("reconnecting", "open_failed");
        log.warn("Slack Socket Mode loop failed; reconnecting", { error });
        await this.waitForReconnectDelay();
      }
    }
  }

  private runSocket(
    url: string,
  ): Promise<Exclude<SlackSocketModeReason, "stopped" | "opening_socket" | "open_failed">> {
    return new Promise((resolve) => {
      const socket = this.openWebSocket(url);
      const generation = ++this.socketGeneration;
      this.socket = socket;
      let settled = false;
      let helloTimer: SocketTimer | null = null;
      let heartbeatTimer: SocketTimer | null = null;
      let pongTimer: SocketTimer | null = null;

      const isCurrent = () => this.running && this.socket === socket && this.socketGeneration === generation;
      const clearTimer = (timer: SocketTimer | null) => {
        if (timer) this.cancelTimeout(timer);
      };
      const clearSocketTimers = () => {
        clearTimer(helloTimer);
        clearTimer(heartbeatTimer);
        clearTimer(pongTimer);
        helloTimer = null;
        heartbeatTimer = null;
        pongTimer = null;
      };
      const finish = (
        reason: Exclude<SlackSocketModeReason, "stopped" | "opening_socket" | "open_failed">,
        force: boolean,
      ) => {
        if (settled) return;
        settled = true;
        clearSocketTimers();
        if (this.settleCurrentSocket === settleForStop) this.settleCurrentSocket = null;
        if (this.socket === socket) this.socket = null;
        if (this.running) {
          this.connectedAt = undefined;
          this.setLifecycle("reconnecting", reason);
        }
        if (force) this.terminateSocket(socket);
        log.info("Slack Socket Mode disconnected", { accountId: this.options.accountId, reason });
        resolve(reason);
      };
      const settleForStop = () => {
        if (settled) return;
        settled = true;
        clearSocketTimers();
        if (this.socket === socket) this.socket = null;
        this.terminateSocket(socket);
        resolve("socket_closed");
      };
      const armPongDeadline = () => {
        clearTimer(pongTimer);
        pongTimer = this.timeout(() => {
          if (!isCurrent()) return;
          log.warn("Slack Socket Mode heartbeat timed out", { accountId: this.options.accountId });
          finish("heartbeat_timeout", true);
        }, this.pongTimeoutMs);
      };
      const sendPing = () => {
        if (!isCurrent() || socket.readyState !== NodeWebSocket.OPEN) return;
        try {
          socket.ping();
          armPongDeadline();
        } catch (error) {
          log.warn("Slack Socket Mode heartbeat failed", { accountId: this.options.accountId, error });
          finish("socket_error", true);
        }
      };

      this.settleCurrentSocket = settleForStop;

      socket.on("open", () => {
        if (!isCurrent()) return;
        this.setLifecycle(this.reconnectCount > 0 ? "reconnecting" : "connecting", "awaiting_hello");
        helloTimer = this.timeout(() => {
          if (!isCurrent()) return;
          log.warn("Slack Socket Mode hello timed out", { accountId: this.options.accountId });
          finish("hello_timeout", true);
        }, this.helloTimeoutMs);
        sendPing();
      });
      socket.on("pong", () => {
        if (!isCurrent()) return;
        this.lastPongAt = this.now();
        clearTimer(pongTimer);
        pongTimer = null;
        clearTimer(heartbeatTimer);
        heartbeatTimer = this.timeout(sendPing, this.heartbeatIntervalMs);
      });
      socket.on("message", (data) => {
        this.handleSocketMessage(data, socket)
          .then((control) => {
            if (!isCurrent()) return;
            if (control === "hello") {
              clearTimer(helloTimer);
              helloTimer = null;
              this.connectedAt = this.now();
              this.setLifecycle("connected");
              log.info("Slack Socket Mode connected", { accountId: this.options.accountId });
            } else if (control === "disconnect") {
              finish("slack_disconnect", true);
            }
          })
          .catch((error) => {
            log.error("Failed to handle Slack Socket Mode message", { error });
          });
      });
      socket.on("error", (event) => {
        if (!isCurrent()) return;
        log.warn("Slack Socket Mode socket error", { event });
        finish("socket_error", true);
      });
      socket.on("close", () => finish("socket_closed", false));
    });
  }

  private async handleSocketMessage(raw: unknown, socket: NodeWebSocket): Promise<"hello" | "disconnect" | null> {
    const text = typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString("utf-8") : String(raw);
    const envelope = JSON.parse(text) as SlackSocketEnvelope;
    if (envelope.type === "hello") return "hello";
    if (envelope.type === "disconnect") return "disconnect";
    await this.handleEnvelope(envelope, async (envelopeId) => {
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    });
    return null;
  }

  private setLifecycle(state: SlackSocketModeState, reason?: SlackSocketModeReason): void {
    this.lifecycleState = state;
    this.lifecycleReason = reason;
  }

  private async openSocketConnectionUntilStopped(): Promise<string | null> {
    let resolveStop: ((value: null) => void) | undefined;
    const stopped = new Promise<null>((resolve) => {
      resolveStop = resolve;
    });
    const interrupt = () => resolveStop?.(null);
    this.interruptConnectionOpen = interrupt;
    try {
      return await Promise.race([this.webClient.openSocketConnection(), stopped]);
    } finally {
      if (this.interruptConnectionOpen === interrupt) this.interruptConnectionOpen = null;
    }
  }

  private timeout(callback: () => void, ms: number): SocketTimer {
    const timer = this.scheduleTimeout(callback, ms);
    timer.unref?.();
    return timer;
  }

  private waitForReconnectDelay(): Promise<void> {
    if (!this.running || this.reconnectDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        this.cancelTimeout(timer);
        if (this.interruptReconnectDelay === complete) this.interruptReconnectDelay = null;
        resolve();
      };
      const timer = this.timeout(complete, this.reconnectDelayMs);
      this.interruptReconnectDelay = complete;
    });
  }

  private terminateSocket(socket: NodeWebSocket | null): void {
    if (!socket) return;
    try {
      socket.terminate();
    } catch (error) {
      log.debug("Slack Socket Mode terminate failed", { accountId: this.options.accountId, error });
    }
  }

  private async normalizeEnvelope(envelope: SlackSocketEnvelope): Promise<SlackNormalizedMessage | null> {
    const event = envelopeEvent(envelope);
    if (!event || !isSlackMessageEventStructurallyEligible(event)) return null;

    const payload = envelope.payload as
      | {
          team_id?: string;
          event_id?: string;
          event_time?: number;
          authorizations?: unknown;
        }
      | undefined;
    const isBotMessage = isSlackBotMessageCandidate(event);
    const sourceTeamId = cleanSlackId(event.source_team);
    const userTeamId = cleanSlackId(event.user_team);
    const eventTeamId = cleanSlackId(event.team);
    const payloadTeamId = cleanSlackId(payload?.team_id);
    const authorizationsPresent = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, "authorizations"));
    const authorizationsValid = Array.isArray(payload?.authorizations);
    const authorizedTeamIds = slackAuthorizationTeamIds(payload?.authorizations);
    let teamId = eventTeamId ?? payloadTeamId ?? this.options.accountId;
    let originTeamId: string | undefined;
    let localBotIdentity: SlackLocalBotIdentity | null = null;
    if (isBotMessage) {
      const legacyInstallationTeamIds = uniqueCleanSlackIds([payloadTeamId, eventTeamId]);
      originTeamId =
        sourceTeamId ?? (legacyInstallationTeamIds.length === 1 ? legacyInstallationTeamIds[0] : undefined);
      if (!originTeamId) return null;
      if (authorizationsPresent) {
        if (!authorizationsValid || authorizedTeamIds.length === 0) return null;
      } else if (legacyInstallationTeamIds.length !== 1) {
        return null;
      }
      localBotIdentity = await this.resolveLocalBotIdentity();
      if (
        !localBotIdentity ||
        !hasSlackBotInstallationProof({
          localTeamId: localBotIdentity.teamId,
          authorizationsPresent,
          authorizedTeamIds,
          legacyInstallationTeamIds,
        })
      ) {
        return null;
      }
      teamId = eventTeamId ?? payloadTeamId ?? originTeamId;
    } else {
      const originCandidates = uniqueCleanSlackIds([payloadTeamId, eventTeamId]);
      originTeamId = sourceTeamId ?? (originCandidates.length === 1 ? originCandidates[0] : undefined);
    }
    if (
      shouldIgnoreSlackMessageEvent(event, {
        selfBotId: localBotIdentity?.botId,
        selfUserId: localBotIdentity?.userId,
        botMessageAliasesByChat: this.routingPolicy.botMessageAliasesByChat,
      })
    ) {
      return null;
    }

    const channelId = cleanSlackId(event.channel);
    const slackUserId = cleanSlackId(event.user);
    const userId = slackSenderIdForEvent(event);
    const ts = cleanSlackId(event.ts);
    if (!channelId || !userId || !ts) return null;

    const thread = resolveSlackThreadContext(event, this.routingPolicy);
    const eventTimeMs = payload?.event_time ? payload.event_time * 1000 : slackTsToMs(ts);
    const text = typeof event.text === "string" ? event.text : "";
    const files = normalizeSlackFiles(event.files);
    if (!text.trim() && files.length === 0) return null;

    return {
      teamId,
      originTeamId,
      sourceTeamId,
      userTeamId,
      eventTeamId,
      payloadTeamId,
      authorizedTeamIds,
      localTeamId: localBotIdentity?.teamId,
      channelId,
      channelType: cleanSlackId(event.channel_type) ?? "channel",
      userId,
      slackUserId,
      botId: cleanSlackId(event.bot_id),
      senderKind: isBotMessage ? "bot" : "user",
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

  private async resolveLocalBotIdentity(): Promise<SlackLocalBotIdentity | null> {
    if (this.localBotIdentity) return this.localBotIdentity;
    if (this.localBotIdentityInFlight) return this.localBotIdentityInFlight;

    const attemptedAt = this.now();
    if (attemptedAt < this.nextLocalBotIdentityAttemptAt) return null;

    const authTest = (this.webClient as Partial<Pick<SlackWebApiClient, "authTest">>).authTest;
    if (typeof authTest !== "function") {
      this.nextLocalBotIdentityAttemptAt = attemptedAt + this.authTestFailureRetryMs;
      return null;
    }

    const request = withAbortableTimeout(
      (signal) => authTest.call(this.webClient, { signal }),
      this.authTestTimeoutMs,
      "Slack auth.test timed out",
    )
      .then((response) => {
        if (response.ok !== true) {
          throw new Error("Slack auth.test did not return ok=true");
        }
        const botId = cleanSlackId(response.bot_id);
        const userId = cleanSlackId(response.user_id);
        const teamId = cleanSlackId(response.team_id);
        if (!botId || !userId || !teamId) {
          throw new Error("Slack auth.test returned an incomplete bot_id/user_id/team_id identity");
        }
        const identity: SlackLocalBotIdentity = { botId, userId, teamId };
        this.localBotIdentity = identity;
        this.nextLocalBotIdentityAttemptAt = 0;
        return identity;
      })
      .catch((error) => {
        this.nextLocalBotIdentityAttemptAt = this.now() + this.authTestFailureRetryMs;
        log.warn("Slack bot message ignored because local bot identity could not be resolved", {
          accountId: this.options.accountId,
          retryAt: this.nextLocalBotIdentityAttemptAt,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    this.localBotIdentityInFlight = request;
    try {
      return await request;
    } finally {
      if (this.localBotIdentityInFlight === request) this.localBotIdentityInFlight = null;
    }
  }

  private normalizeInteractionEnvelope(envelope: SlackSocketEnvelope): Record<string, unknown> | null {
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const interactionType = stringField(record, "type");
    if (!isSlackBlockKitInteractionType(interactionType)) return null;

    const team = recordField(record, "team");
    const user = recordField(record, "user");
    const channel = recordField(record, "channel");
    const container = recordField(record, "container");
    const message = recordField(record, "message");
    const view = recordField(record, "view");
    const firstAction = firstRecord(record.actions);
    const actions = Array.isArray(record.actions) ? record.actions.map(summarizeSlackInteractionAction) : [];
    const teamId = stringField(team, "id") ?? stringField(record, "team_id");
    const channelId = stringField(channel, "id") ?? stringField(container, "channel_id");
    const userId = stringField(user, "id");
    const messageTs = stringField(message, "ts") ?? stringField(container, "message_ts");
    const responseUrl = slackInteractionResponseUrl(record);
    const responseUrlId = responseUrl
      ? storeSlackInteractionResponseUrl({
          accountId: this.options.accountId,
          envelopeId: cleanSlackId(envelope.envelope_id),
          teamId,
          channelId,
          userId,
          messageTs,
          responseUrl,
        })
      : undefined;

    return compactInteractionPayload({
      provider: "slack",
      source: "slack.socket_mode",
      accountId: this.options.accountId,
      instanceId: this.options.instanceId ?? this.options.accountId,
      envelopeId: cleanSlackId(envelope.envelope_id),
      interactionType,
      teamId,
      userId,
      channelId,
      messageTs,
      threadTs: stringField(message, "thread_ts") ?? stringField(container, "thread_ts"),
      triggerId: stringField(record, "trigger_id"),
      containerType: stringField(container, "type"),
      viewId: stringField(view, "id"),
      viewCallbackId: stringField(view, "callback_id"),
      actionId: stringField(firstAction, "action_id"),
      blockId: stringField(firstAction, "block_id"),
      actionType: stringField(firstAction, "type"),
      value: stringField(firstAction, "value"),
      selectedOption: selectedOptionValue(firstAction),
      actions,
      stateValues: view ? recordField(recordField(view, "state"), "values") : undefined,
      responseUrlId,
      responseUrlPresent:
        typeof record.response_url === "string" ||
        (Array.isArray(record.response_urls) && record.response_urls.length > 0),
      receivedAt: Date.now(),
    });
  }

  private normalizeWorkObjectEventEnvelope(envelope: SlackSocketEnvelope): Record<string, unknown> | null {
    const event = envelopeEvent(envelope) ?? directSlackWorkObjectEvent(envelope.payload);
    const eventType = stringField(event, "type");
    if (eventType !== "link_shared" && eventType !== "entity_details_requested") return null;

    const payload = envelope.payload as { team_id?: string; event_id?: string; event_time?: number } | undefined;
    const team = recordField(event, "team");
    const teamId =
      cleanSlackId(event?.team) ?? stringField(team, "id") ?? cleanSlackId(payload?.team_id) ?? this.options.accountId;
    const common = {
      provider: "slack",
      source: "slack.socket_mode",
      accountId: this.options.accountId,
      instanceId: this.options.instanceId ?? this.options.accountId,
      envelopeId: cleanSlackId(envelope.envelope_id),
      eventId: cleanSlackId(payload?.event_id),
      interactionType: eventType,
      teamId,
      userId: stringField(event, "user"),
      channelId: stringField(event, "channel"),
      messageTs: stringField(event, "message_ts"),
      threadTs: stringField(event, "thread_ts"),
      triggerId: stringField(event, "trigger_id"),
      eventTs: stringField(event, "event_ts"),
      receivedAt: Date.now(),
    };

    if (eventType === "link_shared") {
      const links = Array.isArray(event?.links) ? event.links.map(summarizeSlackLinkSharedLink) : [];
      return compactInteractionPayload({
        ...common,
        links,
        linkCount: links.length,
      });
    }

    const externalRef = recordField(event, "external_ref");
    const link = recordField(event, "link");
    return compactInteractionPayload({
      ...common,
      userLocale: stringField(event, "user_locale"),
      entityUrl: stringField(event, "entity_url"),
      appUnfurlUrl: stringField(event, "app_unfurl_url"),
      externalRef,
      link,
    });
  }

  private async routeMessage(message: SlackNormalizedMessage): Promise<void> {
    const routerConfig = this.getRouterConfig();
    const peerKind = slackPeerKindForChannelType(message.channelType);
    const isGroup = peerKind !== "dm";
    const routeThreadId = message.thread.routeThreadTs;
    const routeAccountId = this.options.routeAccountId ?? this.options.accountId;
    const receivedInstanceId = this.options.instanceId ?? this.options.accountId;
    const instanceAliases = resolveSlackInstanceAliases(routerConfig, receivedInstanceId);
    const instanceId = instanceAliases.canonical;
    const canonicalChat = dbUpsertChat({
      channel: "slack",
      instanceId,
      platformChatId: routeThreadId ? `${message.channelId}#${routeThreadId}` : message.channelId,
      chatType: routeThreadId ? "thread" : peerKind,
      title: message.channelId,
      rawProvenance: {
        source: "slack.socket_mode",
        ...slackTeamProvenance(message),
        channelId: message.channelId,
        threadTs: routeThreadId ?? null,
        envelopeId: message.envelopeId ?? null,
        eventId: message.eventId ?? null,
        senderKind: message.senderKind,
        userId: message.slackUserId ?? null,
        botId: message.botId ?? null,
      },
      seenAt: message.eventTimeMs,
    });
    let matched = matchRoute(routerConfig, {
      phone: message.channelId,
      channel: "slack",
      accountId: routeAccountId,
      isGroup,
      groupId: isGroup ? message.channelId : undefined,
      peerKind,
      threadId: routeThreadId,
    });

    const existingSubscription = findSessionByAttachedChat(canonicalChat.id);
    if (existingSubscription && (!matched || existingSubscription.sessionKey !== matched.sessionKey)) {
      const ownerSession = getSession(existingSubscription.sessionKey);
      const ownerAgent = ownerSession ? routerConfig.agents[ownerSession.agentId] : undefined;
      const sameInstance = subscriptionAllowsCrossInstance(canonicalChat.id, existingSubscription.sessionKey);
      if (!sameInstance) {
        log.warn("Slack subscription override would jump instances - ignoring subscription, using route resolution", {
          chatId: canonicalChat.id,
          subscriptionSessionKey: existingSubscription.sessionKey,
          routeSessionKey: matched?.sessionKey,
        });
      } else if (ownerSession && ownerAgent) {
        log.info("Slack inbound rerouted by session subscription", {
          chatId: canonicalChat.id,
          fromSessionKey: matched?.sessionKey,
          toSessionKey: existingSubscription.sessionKey,
        });
        matched = {
          agentId: ownerSession.agentId,
          agent: ownerAgent,
          sessionKey: existingSubscription.sessionKey,
          dmScope: matched?.dmScope ?? ownerAgent.dmScope ?? routerConfig.defaultDmScope,
          route: matched?.route,
        } satisfies MatchedRoute;
      } else {
        log.warn("Slack subscription points to a missing session or agent - falling back to route resolution", {
          chatId: canonicalChat.id,
          subscriptionSessionKey: existingSubscription.sessionKey,
          hasSession: !!ownerSession,
          hasAgent: !!ownerAgent,
        });
      }
    }
    if (!matched) {
      log.info("Slack inbound skipped: no route matched", {
        accountId: routeAccountId,
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
      instanceAliases,
      platformUserId: message.slackUserId ?? message.userId,
      alternatePlatformUserIds: message.botId ? [message.botId] : [],
      senderKind: message.senderKind,
    });
    const processedFiles = await this.processFiles(message, resolved.agent.cwd);
    dbUpsertChatMessage({
      chatId: canonicalChat.id,
      channel: "slack",
      instanceId,
      providerMessageId: message.ts,
      rawChatId: message.channelId,
      rawSenderId: actorIdentity.rawSenderId ?? message.userId,
      normalizedSenderId: actorIdentity.normalizedSenderId ?? message.userId,
      actorType: actorIdentity.actorType,
      contactId: actorIdentity.contactId,
      agentId: actorIdentity.actorAgentId,
      platformIdentityId: actorIdentity.platformIdentityId,
      messageType: inferSlackMessageType(message),
      content: buildSlackMessageContent(message, processedFiles),
      rawProvenance: {
        source: "slack.socket_mode",
        ...slackTeamProvenance(message),
        eventId: message.eventId ?? null,
        envelopeId: message.envelopeId ?? null,
        senderKind: message.senderKind,
        userId: message.slackUserId ?? null,
        botId: message.botId ?? null,
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
      rawPlatformUserId: actorIdentity.rawSenderId ?? message.userId,
      normalizedPlatformUserId: actorIdentity.normalizedSenderId ?? message.userId,
      role: "member",
      status: "active",
      source: actorIdentity.actorType === "unknown" ? "inbound_message" : "slack_socket_mode:identity_resolved",
      metadata: {
        slackTeamId: message.teamId,
        slackOriginTeamId: message.originTeamId ?? null,
        slackSourceTeamId: message.sourceTeamId ?? null,
        slackUserTeamId: message.userTeamId ?? null,
        slackEventTeamId: message.eventTeamId ?? null,
        slackPayloadTeamId: message.payloadTeamId ?? null,
        slackAuthorizedTeamIds: message.authorizedTeamIds,
        slackLocalTeamId: message.localTeamId ?? null,
        slackChannelType: message.channelType,
        slackSenderKind: message.senderKind,
        slackUserId: message.slackUserId ?? null,
        slackBotId: message.botId ?? null,
        actorType: actorIdentity.actorType,
        identityProvenance: actorIdentity.identityProvenance ?? null,
      },
      seenAt: message.eventTimeMs,
    });
    if (routeThreadId && resolved.createdSession) {
      await this.publishSlackThreadCreatedEvent({
        message,
        resolved,
        canonicalChatId: canonicalChat.id,
        instanceId,
        peerKind,
        threadTs: routeThreadId,
      }).catch((error) => {
        log.warn("Failed to publish Slack thread created event", {
          channelId: message.channelId,
          threadTs: routeThreadId,
          sessionKey: resolved.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (this.routingPolicy.subscriptionScope === "chat_and_thread" && routeThreadId) {
      const rootChat = dbUpsertChat({
        channel: "slack",
        instanceId,
        platformChatId: message.channelId,
        chatType: peerKind,
        title: message.channelId,
        rawProvenance: {
          source: "slack.socket_mode",
          ...slackTeamProvenance(message),
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

  private async publishSlackThreadCreatedEvent(input: {
    message: SlackNormalizedMessage;
    resolved: ResolvedRoute;
    canonicalChatId: string;
    instanceId: string;
    peerKind: "dm" | "group";
    threadTs: string;
  }): Promise<void> {
    await this.publishInteraction(
      SLACK_THREAD_CREATED_TOPIC,
      compactInteractionPayload({
        provider: "slack",
        source: "slack.socket_mode",
        eventType: "thread.created",
        accountId: this.options.accountId,
        routeAccountId: this.options.routeAccountId ?? this.options.accountId,
        instanceId: input.instanceId,
        teamId: input.message.teamId,
        originTeamId: input.message.originTeamId,
        sourceTeamId: input.message.sourceTeamId,
        userTeamId: input.message.userTeamId,
        eventTeamId: input.message.eventTeamId,
        payloadTeamId: input.message.payloadTeamId,
        authorizedTeamIds: input.message.authorizedTeamIds,
        localTeamId: input.message.localTeamId,
        channelId: input.message.channelId,
        channelType: input.message.channelType,
        peerKind: input.peerKind,
        userId: input.message.userId,
        messageTs: input.message.ts,
        sourceMessageTs: input.message.ts,
        threadTs: input.threadTs,
        canonicalChatId: input.canonicalChatId,
        sessionKey: input.resolved.sessionKey,
        sessionName: input.resolved.sessionName,
        agentId: input.resolved.agent.id,
        routePattern: input.resolved.route?.pattern,
        routeSession: input.resolved.route?.session,
        envelopeId: input.message.envelopeId,
        eventId: input.message.eventId,
        eventTimeMs: input.message.eventTimeMs,
        createdAt: Date.now(),
      }),
    );
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
    const hydrated = await this.hydrateFileMetadata(file);
    const resolvedFile = hydrated.file;
    const downloadUrl = slackFileDownloadUrl(resolvedFile);
    if (!downloadUrl) {
      const downloadError = hydrated.error ?? "Slack file metadata did not include a private download URL";
      log.warn("Slack file metadata unavailable", {
        fileId: resolvedFile.id,
        fileAccess: resolvedFile.fileAccess,
        error: downloadError,
      });
      return { ...resolvedFile, downloadError };
    }

    const isAudio = isSlackAudioFile(resolvedFile);
    const maxBytes = isAudio ? MAX_AUDIO_BYTES : MAX_MEDIA_BYTES;
    try {
      const download = await this.webClient.downloadFile({ url: downloadUrl, maxBytes });
      const mimeType = resolvedFile.mimeType ?? download.contentType ?? "application/octet-stream";
      const messageId = `${message.ts}-${resolvedFile.id || index}`;
      const localPath = await saveToAgentAttachments(download.buffer, agentCwd, messageId, mimeType);
      if (!isAudio) return { ...resolvedFile, mimeType, localPath };

      try {
        const transcription = await (this.options.transcribeAudio ?? transcribeAudio)(download.buffer, mimeType);
        return {
          ...resolvedFile,
          mimeType,
          localPath,
          transcript: transcription.text,
          transcriptionProvider: transcription.provider,
          transcriptionModel: transcription.model,
        };
      } catch (error) {
        log.warn("Slack audio transcription failed", {
          fileId: resolvedFile.id,
          mimeType,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ...resolvedFile,
          mimeType,
          localPath,
          transcriptionError: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      log.warn("Slack file download failed", {
        fileId: resolvedFile.id,
        mimeType: resolvedFile.mimeType,
        sizeBytes: resolvedFile.sizeBytes,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...resolvedFile,
        downloadError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async hydrateFileMetadata(
    file: SlackNormalizedFile,
  ): Promise<{ readonly file: SlackNormalizedFile; readonly error?: string }> {
    if (slackFileDownloadUrl(file)) return { file };
    if (!file.id || file.id.startsWith("file-")) {
      return { file, error: "Slack file metadata is missing a stable file ID" };
    }

    const filesInfo = (this.webClient as Partial<SlackWebApiClient>).filesInfo;
    if (typeof filesInfo !== "function") {
      return { file, error: "Slack Web API client cannot hydrate file metadata" };
    }

    let hydrated = file;
    let lastError = "Slack files.info returned no private download URL";
    for (const [attempt, delayMs] of SLACK_FILE_INFO_RETRY_DELAYS_MS.entries()) {
      if (delayMs > 0) await delay(delayMs);
      try {
        const response = await filesInfo.call(this.webClient, { file: file.id });
        const resolved = normalizeSlackFile(response.file, 0);
        if (resolved) hydrated = { ...hydrated, ...resolved, id: file.id };
        if (slackFileDownloadUrl(hydrated)) {
          log.info("Slack file metadata hydrated", {
            fileId: file.id,
            fileAccess: file.fileAccess,
            attempts: attempt + 1,
          });
          return { file: hydrated };
        }
        lastError = "Slack files.info returned no private download URL";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return { file: hydrated, error: lastError };
  }
}

function isSlackBotMessageCandidate(event: SlackEventPayload): boolean {
  return Boolean(cleanSlackId(event.bot_id) || event.subtype === "bot_message");
}

function slackAuthorizationTeamIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueCleanSlackIds(
    value.map((authorization) => {
      if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return undefined;
      return (authorization as Record<string, unknown>).team_id;
    }),
  );
}

function hasSlackBotInstallationProof(input: {
  localTeamId: string;
  authorizationsPresent: boolean;
  authorizedTeamIds: readonly string[];
  legacyInstallationTeamIds: readonly string[];
}): boolean {
  if (input.authorizationsPresent) return input.authorizedTeamIds.includes(input.localTeamId);
  return input.legacyInstallationTeamIds.length === 1 && input.legacyInstallationTeamIds[0] === input.localTeamId;
}

function slackTeamProvenance(message: SlackNormalizedMessage): Record<string, unknown> {
  return {
    teamId: message.teamId,
    originTeamId: message.originTeamId ?? null,
    sourceTeamId: message.sourceTeamId ?? null,
    userTeamId: message.userTeamId ?? null,
    eventTeamId: message.eventTeamId ?? null,
    payloadTeamId: message.payloadTeamId ?? null,
    authorizedTeamIds: message.authorizedTeamIds,
    localTeamId: message.localTeamId ?? null,
  };
}

function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveSlackActorIdentity(input: {
  chatId: string;
  instanceAliases: SlackInstanceAliasResolution;
  platformUserId: string;
  alternatePlatformUserIds?: readonly string[];
  senderKind?: "user" | "bot";
}): SlackActorIdentity {
  if (input.senderKind === "bot") {
    return resolveSlackBotActorIdentity({
      instanceAliases: input.instanceAliases,
      platformUserIds: uniqueCleanSlackIds([input.platformUserId, ...(input.alternatePlatformUserIds ?? [])]),
    });
  }

  const scoped = resolveScopedSlackIdentity(
    input.instanceAliases,
    (instanceId) => resolvePlatformIdentity({ channel: "slack", instanceId, platformUserId: input.platformUserId }),
    (identity) => (identity.ownerType && identity.ownerId ? `${identity.ownerType}:${identity.ownerId}` : null),
  );

  // An explicit configured slug/UUID alias collision must fail closed even when a
  // participant was cached from an earlier, non-conflicting resolution. Evaluating
  // ambiguity before the participant fast path prevents a stale cache from masking
  // a later owner conflict across equivalent instance aliases.
  if (scoped.reason === SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON) {
    return {
      actorType: "unknown",
      rawSenderId: input.platformUserId,
      normalizedSenderId: input.platformUserId,
      identityConfidence: 0,
      identityProvenance: buildSlackInstanceProvenance(input.instanceAliases, {
        reason: SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
        matchedInstance: null,
      }),
    };
  }

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

  const identity = scoped.identity;
  if (identity?.ownerType === "agent" && identity.ownerId) {
    return {
      actorType: "agent",
      actorAgentId: identity.ownerId,
      platformIdentityId: identity.id,
      rawSenderId: input.platformUserId,
      normalizedSenderId: identity.normalizedPlatformUserId,
      identityConfidence: identity.confidence,
      identityProvenance: buildSlackInstanceProvenance(input.instanceAliases, {
        reason: scoped.reason,
        matchedInstance: scoped.matchedInstance,
      }),
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
      identityProvenance: buildSlackInstanceProvenance(input.instanceAliases, {
        reason: scoped.reason,
        matchedInstance: scoped.matchedInstance,
      }),
    };
  }

  return {
    actorType: "unknown",
    rawSenderId: input.platformUserId,
    normalizedSenderId: input.platformUserId,
    identityConfidence: 0,
    identityProvenance: buildSlackInstanceProvenance(input.instanceAliases, {
      reason: SLACK_IDENTITY_NOT_FOUND_REASON,
      matchedInstance: null,
    }),
  };
}

function resolveSlackBotActorIdentity(input: {
  instanceAliases: SlackInstanceAliasResolution;
  platformUserIds: readonly string[];
}): SlackActorIdentity {
  const platformUserIds = uniqueCleanSlackIds(input.platformUserIds);
  const primaryPlatformUserId = platformUserIds[0] ?? "unknown";
  const outcomes: SlackBotIdentityResolutionOutcome[] = platformUserIds.map((platformUserId) => ({
    platformUserId,
    resolution: resolveScopedSlackIdentity(
      input.instanceAliases,
      (instanceId) => resolvePlatformIdentity({ channel: "slack", instanceId, platformUserId }),
      (identity) => (identity.ownerType && identity.ownerId ? `${identity.ownerType}:${identity.ownerId}` : null),
    ),
  }));

  if (outcomes.some((outcome) => outcome.resolution.reason === SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON)) {
    return unknownSlackBotActor({
      instanceAliases: input.instanceAliases,
      primaryPlatformUserId,
      outcomes,
      botIdentityReason: "ambiguous_instance_alias",
      aliasReason: SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
    });
  }

  const resolved = outcomes.filter(
    (outcome): outcome is SlackBotIdentityResolutionOutcome & { resolution: { identity: PlatformIdentity } } =>
      Boolean(outcome.resolution.identity),
  );
  const agentOwnerIds = new Set(
    resolved
      .map((outcome) =>
        outcome.resolution.identity.ownerType === "agent" ? outcome.resolution.identity.ownerId : null,
      )
      .filter((ownerId): ownerId is string => Boolean(ownerId)),
  );
  const allResolvedIdsBelongToOneAgent =
    resolved.length > 0 &&
    agentOwnerIds.size === 1 &&
    resolved.every(
      (outcome) =>
        outcome.resolution.identity.ownerType === "agent" &&
        outcome.resolution.identity.ownerId === Array.from(agentOwnerIds)[0],
    );

  if (!allResolvedIdsBelongToOneAgent) {
    const hasAgent = resolved.some((outcome) => outcome.resolution.identity.ownerType === "agent");
    const hasNonAgent = resolved.some((outcome) => outcome.resolution.identity.ownerType !== "agent");
    return unknownSlackBotActor({
      instanceAliases: input.instanceAliases,
      primaryPlatformUserId,
      outcomes,
      botIdentityReason:
        resolved.length === 0
          ? "identity_not_found"
          : hasAgent && hasNonAgent
            ? "conflicting_platform_owners"
            : hasAgent
              ? "conflicting_agents"
              : "contact_identity_not_agent",
      aliasReason: SLACK_IDENTITY_NOT_FOUND_REASON,
    });
  }

  const matched = resolved[0]!;
  const identity = matched.resolution.identity;
  return {
    actorType: "agent",
    actorAgentId: identity.ownerId!,
    platformIdentityId: identity.id,
    rawSenderId: primaryPlatformUserId,
    normalizedSenderId: identity.normalizedPlatformUserId,
    identityConfidence: identity.confidence,
    identityProvenance: {
      ...buildSlackInstanceProvenance(input.instanceAliases, {
        reason: matched.resolution.reason,
        matchedInstance: matched.resolution.matchedInstance,
      }),
      senderKind: "bot",
      matchedPlatformUserId: matched.platformUserId,
      candidatePlatformUserIds: platformUserIds,
      botIdentityReason: "resolved_agent",
      platformIdentityCandidates: botIdentityCandidateProvenance(outcomes),
    },
  };
}

function unknownSlackBotActor(input: {
  instanceAliases: SlackInstanceAliasResolution;
  primaryPlatformUserId: string;
  outcomes: readonly SlackBotIdentityResolutionOutcome[];
  botIdentityReason: string;
  aliasReason: typeof SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON | typeof SLACK_IDENTITY_NOT_FOUND_REASON;
}): SlackActorIdentity {
  return {
    actorType: "unknown",
    rawSenderId: input.primaryPlatformUserId,
    normalizedSenderId: input.primaryPlatformUserId,
    identityConfidence: 0,
    identityProvenance: {
      ...buildSlackInstanceProvenance(input.instanceAliases, {
        reason: input.aliasReason,
        matchedInstance: null,
      }),
      senderKind: "bot",
      candidatePlatformUserIds: input.outcomes.map((outcome) => outcome.platformUserId),
      botIdentityReason: input.botIdentityReason,
      platformIdentityCandidates: botIdentityCandidateProvenance(input.outcomes),
    },
  };
}

function botIdentityCandidateProvenance(
  outcomes: readonly SlackBotIdentityResolutionOutcome[],
): Array<Record<string, unknown>> {
  return outcomes.map((outcome) => ({
    platformUserId: outcome.platformUserId,
    matchedInstance: outcome.resolution.matchedInstance,
    reason: outcome.resolution.reason,
    ownerType: outcome.resolution.identity?.ownerType ?? null,
  }));
}

function uniqueCleanSlackIds(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.map(cleanSlackId).filter((value): value is string => Boolean(value))));
}

function isSlackBlockKitInteractionType(value: string | undefined): boolean {
  return (
    value === "block_actions" ||
    value === "view_submission" ||
    value === "view_closed" ||
    value === "block_suggestion" ||
    value === "shortcut" ||
    value === "message_action"
  );
}

function summarizeSlackInteractionAction(value: unknown): Record<string, unknown> {
  const action = asRecord(value);
  if (!action) return { type: "unknown" };
  return compactInteractionPayload({
    actionId: stringField(action, "action_id"),
    blockId: stringField(action, "block_id"),
    type: stringField(action, "type"),
    value: stringField(action, "value"),
    selectedOption: selectedOptionValue(action),
    selectedUser: stringField(action, "selected_user"),
    selectedChannel: stringField(action, "selected_channel"),
    selectedConversation: stringField(action, "selected_conversation"),
    actionTs: stringField(action, "action_ts"),
  });
}

function summarizeSlackLinkSharedLink(value: unknown): Record<string, unknown> {
  const link = asRecord(value);
  if (!link) return {};
  return compactInteractionPayload({
    url: stringField(link, "url"),
    domain: stringField(link, "domain"),
  });
}

function directSlackWorkObjectEvent(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const type = stringField(record, "type");
  return type === "link_shared" || type === "entity_details_requested" ? record : undefined;
}

function selectedOptionValue(action: Record<string, unknown> | undefined): unknown {
  if (!action) return undefined;
  const selectedOption = recordField(action, "selected_option");
  const selectedValue = stringField(selectedOption, "value");
  if (selectedValue) return selectedValue;
  const selectedOptions = Array.isArray(action.selected_options) ? action.selected_options : undefined;
  if (!selectedOptions) return undefined;
  return selectedOptions.map((option) => stringField(asRecord(option), "value")).filter(Boolean);
}

function slackInteractionResponseUrl(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, "response_url");
  if (direct) return direct;
  const responseUrls = Array.isArray(record.response_urls) ? record.response_urls : [];
  for (const item of responseUrls) {
    const responseUrl = stringField(item, "response_url");
    if (responseUrl) return responseUrl;
  }
  return undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return asRecord(value[0]);
}

function recordField(record: unknown, key: string): Record<string, unknown> | undefined {
  const value = asRecord(record)?.[key];
  return asRecord(value);
}

function stringField(record: unknown, key: string): string | undefined {
  const value = asRecord(record)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function compactInteractionPayload(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") output[key] = value;
  }
  return output;
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
  options: {
    channel?: ChannelConfig;
    channels?: Record<string, ChannelConfig>;
    resolveSecret?: SlackCredentialResolver;
    onRuntimeDisabled?: (channel: ChannelConfig, reason: "missing_credentials") => void;
  } = {},
): Promise<SlackNativeRuntime | null> {
  const routerConfig = configStore.getConfig();
  const channels = options.channels ?? routerConfig.channels ?? {};
  const credentials = await resolveSlackCredentialConfigFromEnv(env, {
    channels,
    channel: options.channel,
    resolveSecret: options.resolveSecret,
  });
  if (!credentials) {
    log.warn("Slack native runtime disabled: configure a Slack channel with brokered credentials");
    if (options.channel) options.onRuntimeDisabled?.(options.channel, "missing_credentials");
    return null;
  }

  const instanceAliases = resolveSlackInstanceAliases(routerConfig, credentials.instanceId);
  const scope: SlackTargetScope = {
    accountId: credentials.accountId,
    routeAccountId: credentials.routeAccountId,
    instanceId: credentials.instanceId,
    connection: credentials.connection,
    instanceAliases: instanceAliases.scopedAliases,
  };
  const routingPolicy = slackRoutingPolicyFromChannelDefaults(options.channel?.defaults, env);
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
  const delivery = new SlackTextDelivery(webClient, routingPolicy, scope);
  const actions = new SlackChatActionDelivery(webClient, scope);
  const reactionPresence = new SlackReactionPresence(
    webClient,
    {
      reactionName: env.RAVI_SLACK_WORKING_REACTION?.trim() || "hourglass_flowing_sand",
    },
    scope,
  );
  const reactionMode = slackReactionPresenceModeFromEnv(env.RAVI_SLACK_REACTION_PRESENCE);
  const assistantPresenceEnabled = slackAssistantPresenceEnabledFromEnv(env.RAVI_SLACK_ASSISTANT_STATUS);
  const presence = assistantPresenceEnabled
    ? new SlackPresenceStack(
        new SlackAssistantThreadPresence(
          webClient,
          {
            statusText: env.RAVI_SLACK_ASSISTANT_STATUS_TEXT?.trim() || "is working...",
          },
          scope,
        ),
        reactionMode === "off" ? null : reactionPresence,
        { reactionMode },
      )
    : reactionPresence;
  log.info("Slack native runtime configured", {
    accountId: credentials.accountId,
    instanceId: credentials.instanceId,
    connection: credentials.connection,
    source: credentials.source,
    assistantPresenceEnabled,
    reactionPresenceMode: reactionMode,
  });
  return {
    id: credentials.accountId,
    accountId: credentials.accountId,
    instanceId: credentials.instanceId,
    connection: credentials.connection,
    delivery,
    actions,
    presence,
    socketMode,
  };
}

export async function createSlackNativeRuntimesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    channels?: Record<string, ChannelConfig>;
    resolveSecret?: SlackCredentialResolver;
    onRuntimeDisabled?: (channel: ChannelConfig, reason: "missing_credentials") => void;
    onRuntimeError?: (channel: ChannelConfig, error: unknown) => void;
  } = {},
): Promise<SlackNativeRuntime[]> {
  const channels = options.channels ?? configStore.getConfig().channels ?? {};
  const configuredChannels = enabledSlackChannels(channels);
  const runtimes: SlackNativeRuntime[] = [];
  for (const channel of configuredChannels) {
    try {
      const runtime = await createSlackNativeRuntimeFromEnv(env, {
        channels,
        channel,
        resolveSecret: options.resolveSecret,
        onRuntimeDisabled: options.onRuntimeDisabled,
      });
      if (runtime) runtimes.push(runtime);
    } catch (error) {
      options.onRuntimeError?.(channel, error);
    }
  }
  return runtimes;
}

function enabledSlackChannels(channels: Record<string, ChannelConfig> | undefined): ChannelConfig[] {
  if (!channels) return [];
  return Object.values(channels)
    .filter((channel) => channel.enabled !== false && channel.provider === "slack")
    .sort((a, b) => a.name.localeCompare(b.name));
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

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
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
    ...(firstString(record.mode) ? { mode: firstString(record.mode) } : {}),
    ...(firstString(record.file_access) ? { fileAccess: firstString(record.file_access) } : {}),
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
    mode: file.mode ?? null,
    fileAccess: file.fileAccess ?? null,
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
    downloadError: file.downloadError ?? null,
    transcriptionError: file.transcriptionError ?? null,
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

function slackFileDownloadUrl(file: SlackNormalizedFile): string | undefined {
  return file.privateDownloadUrl ?? file.privateUrl;
}

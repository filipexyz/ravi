/**
 * WhatsAppRuntime: ravi's WhatsApp (Baileys) channel runtime for exactly one instance,
 * running inside the `ravi channels` runner. It was ported from the Baileys plugin in
 * omni packages/channel-whatsapp; comments name the ported function where it helps.
 *
 * - It owns one Baileys socket (lifecycle, reconnect/backoff, QR, pairing code,
 *   passkey, logout) and the per-instance caches the plugin kept per account.
 * - It implements the handler host (`WhatsAppHandlerHost`), so the handlers in
 *   `lib/handlers/*` drive it.
 * - Inbound messages, reactions and connection changes are published as
 *   `WhatsAppInboundEvent` (events.ts) on the CHANNEL_INBOUND JetStream stream
 *   (`publishWhatsAppInboundEvent`); the daemon reads them with `WhatsAppInboundSource`.
 * - Outbound and control methods return the `WhatsAppRpcResults` shapes and throw
 *   `WhatsAppRuntimeError {status, code}`; `call(method, params)` is the typed
 *   dispatcher the RPC server uses.
 *
 * Baileys is never imported here at runtime: the Baileys-backed modules live behind
 * `runtime-library.ts` and are loaded through the injected `loadLibrary`.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type {
  AnyMessageContent,
  BaileysEventMap,
  ConnectionState,
  GroupMetadata,
  PasskeyConnectionUpdate,
  PasskeyCredentialResponse,
  PasskeyPublicKeyCredentialRequestOptions,
  WAMessage,
  WAMessageKey,
  WASocket,
  proto,
} from "baileys";
import type { JetStreamClient } from "nats";
import { z } from "zod";
import { getRaviStateDir } from "../../utils/paths.js";
import type { NativeChannelRuntimeHealth } from "../native/driver.js";
import {
  WHATSAPP_RPC_ERROR_CODES,
  type WhatsAppConnectionState,
  type WhatsAppIngestMode,
  type WhatsAppRpcGroupInviteRecord,
  type WhatsAppRpcMethod,
  type WhatsAppRpcParams,
  WhatsAppRpcParamsSchemas,
  type WhatsAppRpcResult,
} from "./contract.js";
import type { WhatsAppInboundEvent, WhatsAppInboundEventType } from "./events.js";
import { ensureChannelInboundStream, publishWhatsAppInboundEvent } from "./inbound-stream.js";
import { createWhatsAppAuthStorage } from "./lib/auth-store.js";
import {
  type DedupeCache,
  type Logger,
  type OutgoingMessage,
  type PluginStorage,
  createInboundDedupeCache,
  createLogger,
  markdownToWhatsApp,
} from "./lib/foundation.js";
import {
  type WhatsAppOutboundTimingConfig,
  getWhatsAppOutboundTimingConfig,
  getWhatsAppRateLimitConfig,
} from "./lib/env.js";
import type { StorageAuthStateHandle } from "./lib/auth.js";
import type { ReconnectConfig } from "./lib/handlers/connection.js";
import type { ExtractedContent } from "./lib/handlers/messages.js";
import { fromJid, isGroupJid, isLidJid, isUserJid } from "./lib/jid.js";
import { buildMessageContent } from "./lib/senders/builders.js";
import { sendReaction as sendReactionMessage } from "./lib/senders/reaction.js";
import type { SocketConfig } from "./lib/socket.js";
import type { InboundSubStageTimings, WhatsAppHandlerHost } from "./lib/types.js";
import { DecryptFailureTracker } from "./lib/utils/decrypt-failure-tracker.js";
import { type MentionResolution, resolveMentions } from "./lib/utils/mention-resolver.js";
import { getDocumentMessage, getMessageContextInfo } from "./lib/utils/message.js";
import { type RateLimitManager, createRateLimitManager, isRateLimitError } from "./lib/utils/rate-limit.js";
import { TtlCache } from "./runtime-cache.js";
import {
  WhatsAppRuntimeError,
  errorMessage,
  invalidRequest,
  notConnected,
  toWhatsAppRuntimeError,
} from "./runtime-errors.js";
import {
  DEFAULT_PUBLISHED_EVENT_TYPES,
  type MessageReceivedContent,
  type ReactionPayload,
  type WhatsAppObservedEvent,
  buildWhatsAppObservedEvent,
  connectionConnectedPayload,
  connectionDisconnectedPayload,
  connectionQrPayload,
  deterministicEventId,
  messageIdempotencyKey,
  messageReceivedPayload,
  reactionIdempotencyKey,
  toWhatsAppInboundEvent,
} from "./runtime-events.js";
import { boundGroupListResult, filterGroupRecords, toGroupMetadataResult, toGroupRecord } from "./runtime-groups.js";
import type { WhatsAppLibrary } from "./runtime-library.js";
import {
  buildVCard,
  convertStickerToWebp,
  extractInviteCode,
  inviteLink,
  isWebp,
  normalizeChatTarget,
  normalizeGroupJid,
  normalizeSendMediaMimeType,
  sanitizeOutboundText,
} from "./runtime-send.js";

// ============================================================================
// Public types
// ============================================================================

/** Per-instance socket options (ported `WhatsAppConnectionOptions`), validated at the RPC boundary. */
export const WhatsAppConnectionOptionsSchema = z.object({
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).optional(),
  browser: z.tuple([z.string(), z.string(), z.string()]).optional(),
  mobile: z.boolean().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  defaultQueryTimeoutMs: z.number().int().positive().optional(),
  keepAliveIntervalMs: z.number().int().positive().optional(),
  syncFullHistory: z.boolean().optional(),
  historyIdentity: z.enum(["desktop", "web"]).optional(),
  supportGroupHistory: z.boolean().optional(),
  generateHighQualityLinkPreview: z.boolean().optional(),
  markOnlineOnConnect: z.boolean().optional(),
  /** LID-first identity resolution (default true; false = legacy phone-first, omni DEC-8). */
  lidFirstEnabled: z.boolean().optional(),
});

export type WhatsAppConnectionOptions = z.infer<typeof WhatsAppConnectionOptionsSchema>;

/**
 * Persistent auth store: `PluginStorage` plus the paired-creds probe and the
 * manual-disconnect marker (default: SQLite `<RAVI_STATE_DIR>/whatsapp/auth.db`, auth-store.ts).
 */
export interface WhatsAppAuthStorage extends PluginStorage {
  hasRegisteredCreds(instanceId: string): boolean;
  /** True when the last lifecycle command was `connection.disconnect` (survives runner restarts). */
  isManuallyDisconnected(instanceId: string): boolean;
  setManuallyDisconnected(instanceId: string, disconnected: boolean): void;
}

/**
 * Runtime lifecycle state.
 *
 * - `idle`: constructed, `start()` not called yet.
 * - `pairing_required`: started without paired creds; waits for `connect()`.
 * - `connecting` / `qr` / `connected` / `reconnecting`: socket lifecycle.
 * - `disconnected`: no socket; `stateReason` says why (user, replaced, retries exhausted...).
 * - `logged_out`: WhatsApp unlinked the device or `logout()` ran; creds were cleared.
 * - `failed`: the Baileys library could not be loaded.
 * - `stopped`: `stop()` ran.
 */
export type WhatsAppRuntimeState =
  | "idle"
  | "pairing_required"
  | "connecting"
  | "qr"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "logged_out"
  | "failed"
  | "stopped";

export interface WhatsAppRuntimeSnapshot {
  instanceId: string;
  accountName: string;
  state: WhatsAppRuntimeState;
  /** Lowercase namespaced reason (`pairing_required`, `connection_replaced`, ...). */
  reason?: string;
  since: number;
  lastError?: string;
  connectedAt?: number;
  reconnectCount: number;
  profileName?: string;
  ownerJid?: string;
  qr?: { code: string; expiresAt: number };
}

export type WhatsAppPasskeyState =
  | { state: "request"; publicKey: PasskeyPublicKeyCredentialRequestOptions; requestedAt: string }
  | { state: "confirmation"; code: string; requiresUserConfirmation: boolean; requestedAt: string }
  | { state: "confirming"; requestedAt: string }
  | { state: "error"; phase: "request" | "continuation"; message: string; requestedAt: string };

export type ReadReceiptMode = "on" | "off" | "exclude-self";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WhatsAppRuntimeTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface WhatsAppSupervisorOptions {
  /** Re-arm a connect after the socket gave up (what the old API instance monitor did). Default true. */
  enabled?: boolean;
  /** First delay; doubles per attempt (default 1000). */
  baseDelayMs?: number;
  /** Delay cap (default 300000, the old monitor `backoffMaxMs`). */
  maxDelayMs?: number;
}

export interface WhatsAppRuntimeOptions {
  /** Transport instance id (the ravi instance UUID). */
  instanceId: string;
  /** Ravi account / instance name, for logs and snapshots. */
  accountName?: string;
  /** JetStream client used to publish CHANNEL_INBOUND events (or a lazy getter). */
  jetstream: JetStreamClient | (() => JetStreamClient);
  /** Creates/verifies the CHANNEL_INBOUND stream. Default: `ensureChannelInboundStream()`. */
  ensureInboundStream?: () => Promise<void>;
  /** Auth state store. Default: SQLite store over `<RAVI_STATE_DIR>/whatsapp/auth.db` (lib/auth-store.ts). */
  authStorage?: WhatsAppAuthStorage;
  /** Clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Loads the Baileys-backed library. Default: dynamic import of `runtime-library.ts`. */
  loadLibrary?: () => Promise<WhatsAppLibrary>;
  /** Inbound media root. Default `<RAVI_STATE_DIR>/media/whatsapp`. */
  mediaBaseDir?: string;
  logger?: Logger;
  /** Socket options (instance defaults); `connection.connect` may override them. */
  socketOptions?: WhatsAppConnectionOptions;
  /** Reconnect policy of the connection handler (default 5 retries, 1s..30s). */
  reconnect?: Partial<ReconnectConfig>;
  supervisor?: WhatsAppSupervisorOptions;
  /** Outbound humanization. Default: `getWhatsAppOutboundTimingConfig(env)`. */
  outboundTiming?: WhatsAppOutboundTimingConfig;
  /** Environment for WHATSAPP_* tuning. Default `process.env`. */
  env?: Record<string, string | undefined>;
  timers?: WhatsAppRuntimeTimers;
  sleep?: (ms: number) => Promise<void>;
  /** Observer for every event the runtime builds (published or not). */
  onEvent?: (event: WhatsAppObservedEvent) => void;
  /** Observer for state transitions. */
  onStateChange?: (snapshot: WhatsAppRuntimeSnapshot) => void;
  /** Event types published to CHANNEL_INBOUND. Default: every `WHATSAPP_INBOUND_EVENT_TYPES` type. */
  publishedEventTypes?: readonly WhatsAppInboundEventType[];
  /**
   * Forces the ingestMode of every message Baileys delivered as offline backlog (`append`).
   * Unset (default): age-aware, see `offlineStaleMs`. "history-sync" restores the old
   * behaviour (no agent reply to anything that arrived during a socket gap).
   */
  offlineIngestMode?: WhatsAppIngestMode;
  /**
   * Offline backlog older than this (by `messageTimestamp`) is published `history-sync`;
   * younger backlog is `realtime`, so the agent answers messages that arrived during a
   * short socket gap. Default 10 minutes. Ignored when `offlineIngestMode` is set.
   */
  offlineStaleMs?: number;
  /** Download media of history-sync messages. Default false (they never reach agents). */
  historyDownloadMedia?: boolean;
  readReceiptMode?: ReadReceiptMode;
  /** Connect on `start()` when paired creds exist. Default true. */
  autoConnect?: boolean;
  /** How long `stop()` (and a reconnect) waits for pending auth-state writes. Default 10 s. */
  authFlushTimeoutMs?: number;
  /** Sticker converter (default: sharp → 512px webp). */
  convertSticker?: (input: Buffer) => Promise<Buffer>;
}

// ============================================================================
// Internal types and constants
// ============================================================================

interface SyncContact {
  platformUserId: string;
  name?: string;
  phone?: string;
  profilePicUrl?: string;
  isGroup: boolean;
  isBusiness?: boolean;
  metadata?: Record<string, unknown>;
}

interface KnownMessageKey {
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
}

interface QuotableMessage {
  key: WAMessageKey;
  message?: proto.IMessage | null;
}

interface HistoryContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  localPath?: string;
  mimeType?: string;
  caption?: string;
}

type GroupSetting = "announcement" | "not_announcement" | "locked" | "unlocked";
const GROUP_SETTINGS: readonly GroupSetting[] = ["announcement", "not_announcement", "locked", "unlocked"];

type RpcHandlers = { [M in WhatsAppRpcMethod]: (params: WhatsAppRpcParams<M>) => Promise<WhatsAppRpcResult<M>> };

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const SENT_ID_TTL_MS = 5 * 60 * 1000;
const MESSAGE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_ID_TTL_MS = 10 * 60 * 1000;
const REACTION_EVENT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_PRESENCE_DURATION_MS = 5_000;
const PAIRING_SOCKET_WAIT_MS = 30_000;
/** Default `offlineStaleMs`: offline backlog older than this is history, younger is answered. */
export const DEFAULT_OFFLINE_STALE_MS = 10 * 60 * 1000;
const DEFAULT_AUTH_FLUSH_TIMEOUT_MS = 10_000;
const HISTORY_BATCH_SIZE = 50;
const DEFAULT_PREWARM_BATCH_SIZE = 500;

const DEFAULT_TIMERS: WhatsAppRuntimeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const loadDefaultLibrary = async (): Promise<WhatsAppLibrary> =>
  (await import("./runtime-library.js")).loadWhatsAppLibrary();

/** Ported `isTransientConnectionClosedError` (prewarm noise during reconnects). */
export function isTransientConnectionClosedError(error: unknown): boolean {
  if (!error) return false;
  const message =
    typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  return /\bConnection Closed\b/i.test(message);
}

function bareId(jid: string | undefined | null): string | undefined {
  return jid?.replace(/:.*$/, "").replace(/@.*$/, "") || undefined;
}

function disconnectReasonKind(reason: string): string {
  if (reason.startsWith("QR code expired")) return "qr_expired";
  if (reason.startsWith("Max reconnection attempts")) return "max_reconnect_attempts";
  if (reason.startsWith("Connection closed")) return "connection_closed";
  if (reason.startsWith("Logged out")) return "logged_out";
  return "disconnected";
}

/**
 * `WAMessage.messageTimestamp` (seconds; number, numeric string, bigint or protobuf Long)
 * in milliseconds, or null when absent or unusable.
 */
export function messageTimestampMs(value: unknown): number | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "bigint") seconds = Number(value);
  else if (typeof value === "string" && value.trim() !== "") seconds = Number(value);
  else if (value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    seconds = (value as { toNumber: () => number }).toNumber();
  } else return null;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ============================================================================
// Runtime
// ============================================================================

export class WhatsAppRuntime implements WhatsAppHandlerHost {
  readonly instanceId: string;
  readonly accountName: string;

  private readonly options: WhatsAppRuntimeOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timers: WhatsAppRuntimeTimers;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly loadLibraryFn: () => Promise<WhatsAppLibrary>;
  private readonly ensureInboundStreamFn: () => Promise<void>;
  private readonly mediaBaseDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly outboundTiming: WhatsAppOutboundTimingConfig;
  private readonly reconnectConfig: ReconnectConfig;
  private readonly supervisor: Required<WhatsAppSupervisorOptions>;
  private readonly publishedTypes: ReadonlySet<string>;
  private readonly offlineIngestMode: WhatsAppIngestMode | undefined;
  private readonly offlineStaleMs: number;
  private readonly authFlushTimeoutMs: number;
  private readonly historyDownloadMedia: boolean;
  private readonly readReceiptMode: ReadReceiptMode;
  private readonly autoConnect: boolean;
  private readonly convertSticker: (input: Buffer) => Promise<Buffer>;

  private authStorageInstance: WhatsAppAuthStorage | null;
  private jetstreamClient: JetStreamClient | null = null;
  private socketOptions: WhatsAppConnectionOptions;

  // ── lifecycle ──────────────────────────────────────────────────────
  private sock: WASocket | null = null;
  private state: WhatsAppRuntimeState = "idle";
  private stateReason: string | undefined;
  private stateSince: number;
  private lastError: string | undefined;
  private connectedAt: number | undefined;
  private reconnectCount = 0;
  private profile: { name?: string; picUrl?: string; ownerJid?: string } = {};
  private activeQr: { code: string; expiresAt: number } | null = null;
  private generation = 0;
  private started = false;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private libraryPromise: Promise<WhatsAppLibrary> | null = null;
  /** Write queue of the current socket's auth state (flushed on stop/reconnect, discarded before a clear). */
  private authWrites: Pick<StorageAuthStateHandle, "flush" | "discard"> | null = null;
  private loadedLibrary: WhatsAppLibrary | null = null;
  private streamReady: Promise<void> | null = null;
  private lidFirstEnabled: boolean;
  private pendingLoggedOut = false;
  private manualDisconnect = false;
  private replaced = false;
  private supervisorTimer: TimerHandle | null = null;
  private supervisorAttempts = 0;
  private passkeyState: WhatsAppPasskeyState | null = null;
  private readonly stateWaiters = new Set<() => void>();
  private publishFailures = 0;

  // ── caches (the ported plugin's per-account caches, one instance) ──
  private readonly groupMetadataCache = new Map<string, { metadata: GroupMetadata; cachedAt: number }>();
  private readonly groupsCache = new Map<string, { subject: string; desc?: string }>();
  private readonly contactsCache = new Map<string, SyncContact>();
  private readonly chatNamesCache = new Map<string, string>();
  private readonly chatUnreadCache = new Map<string, number>();
  private readonly lidMappingCache = new Map<string, string>();
  private readonly publishedLidMappings = new Map<string, string>();
  private readonly publishedContactNames = new Map<string, string>();
  private readonly sentIds: TtlCache<string, true>;
  private readonly recentSent: TtlCache<string, proto.IMessage>;
  private readonly ownMessages: TtlCache<string, KnownMessageKey>;
  private readonly messageKeys: TtlCache<string, KnownMessageKey>;
  private readonly quotable: TtlCache<string, QuotableMessage>;
  private readonly offlineIds: TtlCache<string, true>;
  private readonly recentReactionEvents: TtlCache<string, true>;
  private readonly presenceTimers = new Map<string, TimerHandle>();
  private decryptTracker: DecryptFailureTracker | null = null;
  private dedupeCache: DedupeCache | null = null;
  private rateLimiter: RateLimitManager | null = null;
  private lastActionTime = 0;
  private historyPushFetchCount = 0;

  private readonly rpcHandlers: RpcHandlers;

  constructor(options: WhatsAppRuntimeOptions) {
    this.instanceId = options.instanceId;
    this.accountName = options.accountName ?? options.instanceId;
    this.options = options;
    this.log = options.logger ?? createLogger("whatsapp:runtime");
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.sleep = options.sleep ?? defaultSleep;
    this.loadLibraryFn = options.loadLibrary ?? loadDefaultLibrary;
    this.ensureInboundStreamFn = options.ensureInboundStream ?? (() => ensureChannelInboundStream());
    this.env = options.env ?? process.env;
    this.mediaBaseDir = options.mediaBaseDir ?? join(getRaviStateDir(this.env), "media", "whatsapp");
    this.outboundTiming = options.outboundTiming ?? getWhatsAppOutboundTimingConfig(this.env);
    this.reconnectConfig = { maxRetries: 5, baseDelay: 1000, maxDelay: 30_000, ...options.reconnect };
    this.supervisor = {
      enabled: options.supervisor?.enabled ?? true,
      baseDelayMs: options.supervisor?.baseDelayMs ?? 1000,
      maxDelayMs: options.supervisor?.maxDelayMs ?? 300_000,
    };
    this.publishedTypes = new Set(options.publishedEventTypes ?? DEFAULT_PUBLISHED_EVENT_TYPES);
    this.offlineIngestMode = options.offlineIngestMode;
    this.offlineStaleMs =
      options.offlineStaleMs !== undefined && Number.isFinite(options.offlineStaleMs) && options.offlineStaleMs >= 0
        ? options.offlineStaleMs
        : DEFAULT_OFFLINE_STALE_MS;
    this.authFlushTimeoutMs = options.authFlushTimeoutMs ?? DEFAULT_AUTH_FLUSH_TIMEOUT_MS;
    this.historyDownloadMedia = options.historyDownloadMedia ?? false;
    this.readReceiptMode = options.readReceiptMode ?? "on";
    this.autoConnect = options.autoConnect ?? true;
    this.convertSticker = options.convertSticker ?? convertStickerToWebp;
    this.authStorageInstance = options.authStorage ?? null;
    this.socketOptions = { ...options.socketOptions };
    this.lidFirstEnabled = this.socketOptions.lidFirstEnabled ?? true;
    this.stateSince = this.now();

    const cache = <V>(ttlMs: number, maxEntries: number) =>
      new TtlCache<string, V>({ ttlMs, maxEntries, now: this.now });
    this.sentIds = cache<true>(SENT_ID_TTL_MS, 10_000);
    this.recentSent = cache<proto.IMessage>(SENT_ID_TTL_MS, 2_000);
    this.ownMessages = cache<KnownMessageKey>(MESSAGE_KEY_TTL_MS, 5_000);
    this.messageKeys = cache<KnownMessageKey>(MESSAGE_KEY_TTL_MS, 10_000);
    this.quotable = cache<QuotableMessage>(MESSAGE_KEY_TTL_MS, 1_000);
    this.offlineIds = cache<true>(OFFLINE_ID_TTL_MS, 20_000);
    this.recentReactionEvents = cache<true>(REACTION_EVENT_TTL_MS, 5_000);

    this.rpcHandlers = {
      "connection.status": async () => this.getStatus(),
      "connection.connect": (params) => this.connect(params),
      "connection.disconnect": async () => {
        await this.disconnect();
        return {};
      },
      "connection.logout": () => this.logout(),
      "connection.pairingCode": async (params) => ({ code: await this.requestPairingCode(params.phoneNumber) }),
      "groups.list": (params) => this.listGroups(params),
      "groups.create": (params) => this.createGroup(params.subject, params.participants),
      "groups.addParticipants": (params) => this.updateGroupParticipants(params.groupJid, params.participants, "add"),
      "groups.updateParticipants": (params) =>
        this.updateGroupParticipants(params.groupJid, params.participants, params.action),
      "groups.getInvite": (params) => this.getGroupInvite(params.groupJid),
      "groups.revokeInvite": (params) => this.revokeGroupInvite(params.groupJid),
      "groups.join": (params) => this.joinGroup(params.code),
      "groups.leave": (params) => this.leaveGroup(params.groupJid),
      "groups.rename": (params) => this.renameGroup(params.groupJid, params.subject),
      "groups.setDescription": (params) => this.setGroupDescription(params.groupJid, params.description),
      "groups.setSettings": (params) => this.setGroupSettings(params.groupJid, params.setting),
      "groups.metadata": (params) => this.getGroupMetadata(params.groupJid, params.maxAgeMs),
      "messages.sendText": (params) => this.sendText(params),
      "presence.set": async (params) => {
        await this.sendPresence(params.to, params.state, params.durationMs);
        return {};
      },
      "messages.react": (params) => this.sendReaction(params),
      "messages.delete": async (params) => {
        await this.deleteMessage(params.chatId, params.messageId);
        return {};
      },
      "messages.edit": async (params) => {
        await this.editMessage(params.chatId, params.messageId, params.text);
        return {};
      },
      "messages.sendMedia": (params) => this.sendMedia(params),
      "messages.sendSticker": (params) => this.sendSticker(params),
      "messages.markRead": async (params) => {
        await this.markRead(params.chatId, params.messageIds);
        return {};
      },
    };
  }

  // ==========================================================================
  // RPC dispatcher
  // ==========================================================================

  /**
   * Validate `params` with the contract schema for `method` and run it.
   * Always rejects with `WhatsAppRuntimeError`.
   */
  async call<M extends WhatsAppRpcMethod>(method: M, params: unknown): Promise<WhatsAppRpcResult<M>> {
    const schema = WhatsAppRpcParamsSchemas[method];
    if (!schema) throw invalidRequest(`Unknown WhatsApp RPC method: ${String(method)}`);
    const parsed = schema.safeParse(params ?? {});
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues.map((issue) => issue.message).join("; ") || "invalid params");
    }
    const handler = this.rpcHandlers[method] as (input: WhatsAppRpcParams<M>) => Promise<WhatsAppRpcResult<M>>;
    try {
      return await handler(parsed.data as WhatsAppRpcParams<M>);
    } catch (error) {
      const mapped = toWhatsAppRuntimeError(error);
      this.log.debug("WhatsApp RPC failed", {
        instanceId: this.instanceId,
        method,
        status: mapped.status,
        code: mapped.code,
        error: mapped.message,
      });
      throw mapped;
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the runtime without touching the network: kick off the CHANNEL_INBOUND
   * stream check, then connect in the background when paired creds exist, or wait
   * for `connect()` (health `starting` + `pairing_required`).
   *
   * A persisted manual-disconnect marker (`connection.disconnect`, cleared by
   * `connection.connect`) keeps the instance down across runner restarts:
   * health `disconnected` / `manual_disconnect`, no socket.
   */
  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    this.streamReady = this.ensureStream();
    if (this.readManualDisconnectMarker()) {
      this.manualDisconnect = true;
      this.setState("disconnected", "manual_disconnect", "Disconnected by connection.disconnect");
      return;
    }
    if (this.autoConnect && this.hasCreds()) {
      this.setState("connecting", "start");
      this.spawnConnection("start");
    } else {
      this.setState("pairing_required", "pairing_required");
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.connecting = null;
    this.clearSupervisor();
    this.clearPresenceTimers();
    const lib = this.loadedLibrary;
    if (lib) {
      lib.resetConnectionState(this.instanceId);
      await this.dropSocket(lib, false);
    } else {
      this.sock = null;
    }
    await this.flushAuthWrites("stop");
    this.dedupeCache?.dispose();
    this.dedupeCache = null;
    this.activeQr = null;
    this.setState("stopped", "stopped");
  }

  /**
   * `connection.connect`: reconnect with stored creds, or open a socket that emits QR
   * codes. `forceNewQr` drops the socket and the stored auth first.
   */
  async connect(
    params: { forceNewQr?: boolean; whatsapp?: Record<string, unknown> } = {},
  ): Promise<WhatsAppRpcResult<"connection.connect">> {
    this.assertNotStopped();
    if (params.whatsapp) this.applySocketOptions(params.whatsapp);
    this.started = true;
    this.manualDisconnect = false;
    this.writeManualDisconnectMarker(false);
    this.replaced = false;
    this.clearSupervisor();
    if (!this.streamReady) this.streamReady = this.ensureStream();

    if (params.forceNewQr === true) {
      const lib = await this.library();
      this.generation++;
      this.passkeyState = null;
      await this.dropSocket(lib, false);
      lib.resetConnectionState(this.instanceId);
      await this.clearStoredAuth(lib);
      this.pendingLoggedOut = false;
      this.activeQr = null;
      this.log.info("Cleared auth state for fresh QR", { instanceId: this.instanceId });
      this.setState("connecting", "force_new_qr");
      this.spawnConnection("force_new_qr");
      return { status: "connecting", message: "Connection initiated (fresh QR)" };
    }

    if (this.sock && this.state === "connected") {
      return { status: "connected", message: "Instance already connected" };
    }

    if (this.sock || this.connecting) {
      if (this.state === "qr" && this.activeQr) {
        await this.emit(
          this.observed("connection.qr", connectionQrPayload(this.activeQr.code, new Date(this.activeQr.expiresAt))),
        );
        return { status: "qr", message: "QR code pending; it was republished" };
      }
      return { status: "connecting", message: "Connection already in progress" };
    }

    this.setState("connecting", "connect_requested");
    this.spawnConnection("connect_rpc");
    return { status: "connecting", message: "Connection initiated" };
  }

  /**
   * `connection.disconnect`: close the socket, keep the session. Persisted: the instance
   * stays down across runner restarts until `connection.connect`. Bumping the generation
   * also cancels a connection still waiting for Baileys to load; releasing `connecting`
   * lets a later `connection.connect` start a fresh attempt instead of waiting on it.
   */
  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.writeManualDisconnectMarker(true);
    this.generation++;
    this.connecting = null;
    this.clearSupervisor();
    this.clearPresenceTimers();
    const lib = this.loadedLibrary;
    // Reset tracking even when no socket is live: a reconnect loop drops the socket between attempts (omni#1169).
    lib?.resetConnectionState(this.instanceId);
    this.setState("disconnected", "manual_disconnect", "User requested disconnect");
    const hadSocket = this.sock !== null;
    if (lib) await this.dropSocket(lib, false);
    else this.sock = null;
    this.clearInstanceCaches();
    if (hadSocket) {
      await this.emit(
        this.observed("connection.disconnected", connectionDisconnectedPayload("User requested disconnect", false)),
      );
    }
  }

  /**
   * `connection.logout`: unlink the device on WhatsApp's side (only when connected), close the
   * socket and clear the stored auth state. (The ported plugin only closed the socket and cleared auth.)
   * `unlinked` says whether WhatsApp accepted the unlink; when false the device stays listed on the
   * phone (WhatsApp > Linked devices) until it is removed there.
   */
  async logout(): Promise<WhatsAppRpcResult<"connection.logout">> {
    this.manualDisconnect = true;
    this.generation++;
    this.connecting = null;
    this.clearSupervisor();
    this.clearPresenceTimers();
    const lib = await this.library();
    lib.resetConnectionState(this.instanceId);
    const hadSocket = this.sock !== null;
    const unlinked = await this.dropSocket(lib, this.state === "connected");
    this.clearInstanceCaches();
    await this.clearStoredAuth(lib);
    this.profile = {};
    this.setState("logged_out", "logged_out", "Logged out");
    this.log.info("Instance logged out and auth cleared", { instanceId: this.instanceId, unlinked });
    if (hadSocket) {
      await this.emit(this.observed("connection.disconnected", connectionDisconnectedPayload("Logged out", false)));
    }
    return { unlinked };
  }

  /**
   * `connection.pairingCode`: pair by phone number instead of QR. Opens a socket when
   * none is live and waits until it is ready (first QR) before asking WhatsApp.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.assertNotStopped();
    const normalized = phoneNumber.replace(/[^\d]/g, "");
    if (!normalized || normalized.length < 10) {
      throw invalidRequest(`Invalid phone number: ${phoneNumber}`);
    }
    if (this.state === "connected") {
      throw invalidRequest("Instance is already connected; logout before pairing again");
    }
    if (!this.sock && !this.connecting) {
      this.manualDisconnect = false;
      this.writeManualDisconnectMarker(false);
      this.replaced = false;
      this.started = true;
      this.setState("connecting", "pairing_code");
      this.spawnConnection("pairing_code");
    }
    const ready = await this.waitForState(() => this.sock !== null && this.state === "qr", PAIRING_SOCKET_WAIT_MS);
    const sock = this.sock;
    if (!ready || !sock) {
      throw notConnected("WhatsApp socket is not ready for pairing yet; retry in a few seconds");
    }
    try {
      const code = await sock.requestPairingCode(normalized);
      this.log.info("Pairing code requested", {
        instanceId: this.instanceId,
        phoneNumber: `${normalized.slice(0, 4)}****`,
      });
      return code;
    } catch (error) {
      throw new WhatsAppRuntimeError(
        WHATSAPP_RPC_ERROR_CODES.transportError,
        `Failed to request pairing code: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  getPasskeyState(): WhatsAppPasskeyState | null {
    return this.passkeyState;
  }

  async submitPasskeyResponse(credential: PasskeyCredentialResponse): Promise<void> {
    const sock = this.sock;
    if (!sock) throw notConnected(`Instance ${this.instanceId} is not connected.`);
    const current = this.passkeyState;
    if (current?.state !== "request") throw invalidRequest("No passkey authentication is pending.");
    this.passkeyState = { state: "confirming", requestedAt: current.requestedAt };
    try {
      await sock.sendPasskeyResponse(credential);
    } catch (error) {
      this.passkeyState = current;
      throw error;
    }
  }

  async confirmPasskey(): Promise<void> {
    const sock = this.sock;
    if (!sock) throw notConnected(`Instance ${this.instanceId} is not connected.`);
    const current = this.passkeyState;
    if (current?.state !== "confirmation") throw invalidRequest("No passkey confirmation is pending.");
    this.passkeyState = { state: "confirming", requestedAt: current.requestedAt };
    try {
      await sock.sendPasskeyConfirmation();
    } catch (error) {
      this.passkeyState = current;
      throw error;
    }
  }

  // ==========================================================================
  // State / health
  // ==========================================================================

  getState(): WhatsAppRuntimeState {
    return this.state;
  }

  snapshot(): WhatsAppRuntimeSnapshot {
    return {
      instanceId: this.instanceId,
      accountName: this.accountName,
      state: this.state,
      ...(this.stateReason ? { reason: this.stateReason } : {}),
      since: this.stateSince,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
      reconnectCount: this.reconnectCount,
      ...(this.profile.name ? { profileName: this.profile.name } : {}),
      ...(this.profile.ownerJid ? { ownerJid: this.profile.ownerJid } : {}),
      ...(this.activeQr ? { qr: { ...this.activeQr } } : {}),
    };
  }

  /** `connection.status` (`WhatsAppRpcResults["connection.status"]`). */
  getStatus(): WhatsAppRpcResult<"connection.status"> {
    return {
      state: this.rpcConnectionState(),
      isConnected: this.state === "connected" && this.sock !== null,
      profileName: this.profile.name ?? null,
    };
  }

  /** Channel driver ABI health. */
  health(): NativeChannelRuntimeHealth {
    const extras = {
      ...(this.connectedAt !== undefined && this.state === "connected" ? { connectedAt: this.connectedAt } : {}),
      ...(this.reconnectCount > 0 ? { reconnectCount: this.reconnectCount } : {}),
    };
    switch (this.state) {
      case "connected":
        return { status: "connected", ...extras };
      case "reconnecting":
        return { status: "reconnecting", ...extras };
      case "idle":
      case "connecting":
        return { status: "starting", ...extras };
      case "pairing_required":
        return { status: "starting", reason: "pairing_required", ...extras };
      case "qr":
        return { status: "starting", reason: "qr_pending", ...extras };
      case "logged_out":
        return { status: "disconnected", reason: "logged_out", ...extras };
      case "failed":
        return { status: "failed", reason: this.stateReason ?? "startup_failed", ...extras };
      case "stopped":
        return { status: "disconnected", reason: "stopped", ...extras };
      default:
        return { status: "disconnected", ...(this.stateReason ? { reason: this.stateReason } : {}), ...extras };
    }
  }

  private rpcConnectionState(): WhatsAppConnectionState {
    switch (this.state) {
      case "connected":
        return this.sock ? "connected" : "disconnected";
      case "connecting":
      case "reconnecting":
        return "connecting";
      case "qr":
        return "qr";
      case "logged_out":
        return "logged_out";
      case "failed":
        return "error";
      default:
        return "disconnected";
    }
  }

  private setState(state: WhatsAppRuntimeState, reason?: string, detail?: string): void {
    this.state = state;
    this.stateReason = reason;
    this.stateSince = this.now();
    if (detail !== undefined && state !== "connected") this.lastError = detail;
    if (state === "connected") this.lastError = undefined;
    for (const waiter of [...this.stateWaiters]) waiter();
    try {
      this.options.onStateChange?.(this.snapshot());
    } catch (error) {
      this.log.warn("WhatsApp state observer failed", { instanceId: this.instanceId, error: errorMessage(error) });
    }
  }

  private waitForState(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        this.stateWaiters.delete(check);
        this.timers.clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        if (predicate()) finish(true);
        else if (this.stopped || this.state === "disconnected" || this.state === "logged_out") finish(false);
      };
      const timer = this.timers.setTimeout(() => finish(predicate()), timeoutMs);
      this.stateWaiters.add(check);
    });
  }

  // ==========================================================================
  // Socket creation (ported createConnection)
  // ==========================================================================

  private spawnConnection(trigger: string): void {
    // `connecting` is cleared BEFORE the failure handler runs, so the supervisor can re-arm.
    const settle = () => {
      if (this.connecting === pending) this.connecting = null;
    };
    const pending: Promise<void> = this.createConnection().then(settle, (error: unknown) => {
      // A superseded attempt (disconnect/logout/stop/forceNewQr released or replaced the
      // slot) must not overwrite the newer state or arm the supervisor.
      const current = this.connecting === pending;
      settle();
      if (!current) {
        this.log.debug("Superseded WhatsApp connection attempt failed", {
          instanceId: this.instanceId,
          trigger,
          error: errorMessage(error),
        });
        return;
      }
      this.onConnectionFailure(trigger, error);
    });
    this.connecting = pending;
  }

  private onConnectionFailure(trigger: string, error: unknown): void {
    const message = errorMessage(error);
    this.log.error("WhatsApp connection failed", { instanceId: this.instanceId, trigger, error: message });
    if (this.stopped) return;
    if (!this.loadedLibrary) {
      this.setState("failed", "missing_dependency", message);
      return;
    }
    this.setState("disconnected", "connect_failed", message);
    this.scheduleSupervisorReconnect("connect_failed");
  }

  private async createConnection(): Promise<void> {
    // Captured before the first await: a disconnect()/stop() issued while Baileys is
    // still loading bumps the generation, and no socket may be opened afterwards.
    const requestedGeneration = this.generation;
    const lib = await this.library();
    if (requestedGeneration !== this.generation || this.stopped) return;
    const generation = ++this.generation;

    // Cancel pending reconnect timers and close any live socket (no duplicate sockets).
    lib.cancelPendingReconnect(this.instanceId);
    if (this.sock) {
      this.log.info("Closing existing socket before reconnect", { instanceId: this.instanceId });
      await this.dropSocket(lib, false);
    }

    // The previous socket's queued key writes must land before the store is re-read.
    await this.flushAuthWrites("reconnect");
    if (generation !== this.generation || this.stopped) return;

    const storage = this.authStorage();
    const authState = await lib.createStorageAuthState(storage, this.instanceId);
    const { state, saveCreds } = authState;
    if (generation !== this.generation || this.stopped) {
      await authState.flush({ timeoutMs: this.authFlushTimeoutMs });
      return;
    }
    this.authWrites = authState;

    // Paired creds → seed the handler's authenticated set so a drop auto-reconnects
    // instead of falling into the QR path (critical after restarts).
    if (state.creds?.me?.id) lib.seedAuthenticated(this.instanceId);

    this.lidFirstEnabled = this.socketOptions.lidFirstEnabled ?? true;
    this.decryptTracker ??= new DecryptFailureTracker();
    const tracker = this.decryptTracker;
    const { lidFirstEnabled: _lidFirst, ...socketOptions } = this.socketOptions;

    const config: SocketConfig = {
      auth: state,
      ...socketOptions,
      cachedGroupMetadata: async (jid: string) => this.getCachedGroupMetadata(jid),
      shouldIgnoreJid: tracker.shouldIgnore,
      getMessage: async (key: WAMessageKey) => (key.id ? this.recentSent.get(key.id) : undefined),
    };
    const sock = await lib.createSocket(config);
    if (generation !== this.generation || this.stopped) {
      sock.ev.removeAllListeners("connection.update");
      await lib.closeSocket(sock, false).catch(() => {});
      return;
    }

    sock.ev.on("creds.update", async (update) => {
      Object.assign(state.creds, update);
      if (state.creds.me?.id && !state.creds.registered) state.creds.registered = true;
      try {
        await saveCreds();
      } catch (error) {
        this.log.error("Failed to persist WhatsApp creds", { instanceId: this.instanceId, error: errorMessage(error) });
      }
    });

    // Runtime observers run BEFORE the ported handlers (registration order):
    // close status codes and offline (`append`) batches are recorded first.
    sock.ev.on("connection.update", (update) => this.observeConnectionUpdate(lib, sock, update));
    sock.ev.on("messages.upsert", (upsert) => this.observeUpsert(upsert));

    lib.setupConnectionHandlers(
      sock,
      this,
      this.instanceId,
      () => this.createConnection(),
      () => this.resetQrCycle(lib, sock, generation),
      this.reconnectConfig,
    );

    this.dedupeCache?.dispose();
    this.dedupeCache = createInboundDedupeCache();
    lib.setupMessageHandlers(sock, this, this.instanceId, tracker, this.dedupeCache);
    lib.setupAllEventHandlers(sock, this, this.instanceId);
    this.sock = sock;
  }

  private observeConnectionUpdate(lib: WhatsAppLibrary, sock: WASocket, update: Partial<ConnectionState>): void {
    if (update.connection !== "close") return;
    const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
    const statusCode = error?.output?.statusCode;
    if (statusCode === lib.disconnectReason.loggedOut) {
      // The handler follows with handleDisconnected("Logged out from WhatsApp"): clear creds there.
      this.pendingLoggedOut = true;
      return;
    }
    if (statusCode === lib.disconnectReason.connectionReplaced && sock === this.sock) {
      // The handler returns silently on 440 (no reconnect). Drop the dead socket once the
      // current emit finished, so it does not linger as "connected".
      queueMicrotask(() => {
        this.handleConnectionReplaced(lib, sock).catch((error: unknown) => {
          this.log.error("Failed to handle replaced WhatsApp connection", {
            instanceId: this.instanceId,
            error: errorMessage(error),
          });
        });
      });
    }
  }

  private async handleConnectionReplaced(lib: WhatsAppLibrary, sock: WASocket): Promise<void> {
    if (sock !== this.sock) return;
    this.replaced = true;
    await this.dropSocket(lib, false);
    this.groupMetadataCache.clear();
    const reason = "Connection replaced by another session";
    this.log.warn("WhatsApp connection replaced by another session; not reconnecting", {
      instanceId: this.instanceId,
    });
    this.setState("disconnected", "connection_replaced", reason);
    await this.emit(this.observed("connection.disconnected", connectionDisconnectedPayload(reason, false)));
  }

  /**
   * After MAX_QR_ATTEMPTS: drop the socket, clear auth, start a fresh QR cycle.
   * Never rejects: it runs inside a Baileys event listener, where a rejection would be
   * unhandled and kill the runner. A failure is reported as health instead
   * (`disconnected` / `qr_reset_failed`); `connection.connect` starts over.
   */
  private async resetQrCycle(lib: WhatsAppLibrary, sock: WASocket, generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped || sock !== this.sock) return;
    try {
      await this.dropSocket(lib, false);
      await this.clearStoredAuth(lib);
      if (generation !== this.generation || this.stopped) return;
      await this.createConnection();
    } catch (error) {
      const message = errorMessage(error);
      this.log.error("WhatsApp QR cycle reset failed", { instanceId: this.instanceId, error: message });
      if (this.stopped) return;
      this.generation++;
      if (this.sock) await this.dropSocket(lib, false);
      lib.resetConnectionState(this.instanceId);
      this.activeQr = null;
      const reason = `QR cycle reset failed: ${message}`;
      this.setState("disconnected", "qr_reset_failed", reason);
      await this.emit(this.observed("connection.disconnected", connectionDisconnectedPayload(reason, false))).catch(
        () => {},
      );
    }
  }

  /** Clear the stored auth state, dropping queued key writes of the current socket first. */
  private async clearStoredAuth(lib: WhatsAppLibrary): Promise<void> {
    const writes = this.authWrites;
    this.authWrites = null;
    if (writes) await writes.discard();
    await lib.clearAuthState(this.authStorage(), this.instanceId);
  }

  /** Wait (bounded) for queued auth-state writes; log when some could not be persisted. */
  private async flushAuthWrites(trigger: string): Promise<void> {
    const writes = this.authWrites;
    if (!writes) return;
    let flushed = false;
    try {
      flushed = await writes.flush({ timeoutMs: this.authFlushTimeoutMs });
    } catch (error) {
      this.log.error("WhatsApp auth-state flush failed", {
        instanceId: this.instanceId,
        trigger,
        error: errorMessage(error),
      });
    }
    if (!flushed) {
      this.log.warn("WhatsApp auth-state writes still pending after flush timeout", {
        instanceId: this.instanceId,
        trigger,
        timeoutMs: this.authFlushTimeoutMs,
      });
    }
    if (this.authWrites === writes) this.authWrites = null;
  }

  private observeUpsert(upsert: BaileysEventMap["messages.upsert"]): void {
    if (upsert.type !== "append") return;
    for (const msg of upsert.messages) {
      const id = msg.key?.id;
      if (!id) continue;
      if (msg.key.fromMe && this.sentIds.has(id)) continue;
      this.offlineIds.set(id, true);
    }
  }

  /**
   * Close the live socket (if any). With `logout`, first ask WhatsApp to unlink the device;
   * returns whether that unlink was sent without error (false when there is no socket).
   */
  private async dropSocket(lib: WhatsAppLibrary, logout: boolean): Promise<boolean> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return false;
    // Remove listeners BEFORE closing so the close event cannot trigger a reconnect.
    sock.ev.removeAllListeners("connection.update");
    let unlinked = false;
    if (logout) {
      try {
        await sock.logout();
        unlinked = true;
      } catch (error) {
        this.log.warn("WhatsApp logout failed; the device may still be linked", {
          instanceId: this.instanceId,
          error: errorMessage(error),
        });
      }
    }
    try {
      await lib.closeSocket(sock, false);
    } catch (error) {
      this.log.debug("Socket close failed", { instanceId: this.instanceId, error: errorMessage(error) });
    }
    return unlinked;
  }

  private library(): Promise<WhatsAppLibrary> {
    if (!this.libraryPromise) {
      this.libraryPromise = this.loadLibraryFn().then(
        (lib) => {
          this.loadedLibrary = lib;
          return lib;
        },
        (error: unknown) => {
          this.libraryPromise = null;
          throw new WhatsAppRuntimeError(
            WHATSAPP_RPC_ERROR_CODES.transportError,
            `WhatsApp library unavailable: ${errorMessage(error)}`,
            { cause: error },
          );
        },
      );
    }
    return this.libraryPromise;
  }

  private authStorage(): WhatsAppAuthStorage {
    this.authStorageInstance ??= createWhatsAppAuthStorage();
    return this.authStorageInstance;
  }

  private hasCreds(): boolean {
    try {
      return this.authStorage().hasRegisteredCreds(this.instanceId);
    } catch (error) {
      this.log.warn("Could not read WhatsApp auth state", { instanceId: this.instanceId, error: errorMessage(error) });
      return false;
    }
  }

  private readManualDisconnectMarker(): boolean {
    try {
      return this.authStorage().isManuallyDisconnected(this.instanceId);
    } catch (error) {
      this.log.warn("Could not read the WhatsApp manual-disconnect marker", {
        instanceId: this.instanceId,
        error: errorMessage(error),
      });
      return false;
    }
  }

  private writeManualDisconnectMarker(disconnected: boolean): void {
    try {
      this.authStorage().setManuallyDisconnected(this.instanceId, disconnected);
    } catch (error) {
      this.log.warn("Could not persist the WhatsApp manual-disconnect marker", {
        instanceId: this.instanceId,
        disconnected,
        error: errorMessage(error),
      });
    }
  }

  private applySocketOptions(raw: Record<string, unknown>): void {
    const parsed = WhatsAppConnectionOptionsSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidRequest(`Invalid whatsapp options: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    this.socketOptions = { ...this.socketOptions, ...parsed.data };
  }

  private assertNotStopped(): void {
    if (this.stopped) throw notConnected(`WhatsApp runtime for ${this.accountName} is stopped`);
  }

  // ── supervisor (reconnect monitor, one instance) ───────────────────

  private scheduleSupervisorReconnect(trigger: string): void {
    if (!this.supervisor.enabled || this.stopped || this.manualDisconnect || this.replaced) return;
    if (this.state === "logged_out" || this.supervisorTimer || this.sock || this.connecting) return;
    if (!this.hasCreds()) return;
    this.supervisorAttempts++;
    const delay = Math.min(
      this.supervisor.baseDelayMs * 2 ** (this.supervisorAttempts - 1),
      this.supervisor.maxDelayMs,
    );
    this.log.info("Scheduled WhatsApp reconnect", {
      instanceId: this.instanceId,
      trigger,
      attempt: this.supervisorAttempts,
      delayMs: delay,
    });
    this.supervisorTimer = this.timers.setTimeout(() => {
      this.supervisorTimer = null;
      if (this.stopped || this.manualDisconnect || this.replaced || this.sock || this.connecting) return;
      this.reconnectCount++;
      this.setState("reconnecting", "supervisor");
      this.spawnConnection("supervisor");
    }, delay);
  }

  private clearSupervisor(): void {
    if (this.supervisorTimer) this.timers.clearTimeout(this.supervisorTimer);
    this.supervisorTimer = null;
  }

  private clearPresenceTimers(): void {
    for (const timer of this.presenceTimers.values()) this.timers.clearTimeout(timer);
    this.presenceTimers.clear();
  }

  /** Ported `clearInstanceCaches` (sent ids and LID maps survive: echoes may still arrive). */
  private clearInstanceCaches(): void {
    this.passkeyState = null;
    this.groupMetadataCache.clear();
    this.groupsCache.clear();
    this.contactsCache.clear();
    this.chatNamesCache.clear();
    this.chatUnreadCache.clear();
    this.publishedContactNames.clear();
    this.publishedLidMappings.clear();
    this.rateLimiter = null;
    this.lastActionTime = 0;
    this.historyPushFetchCount = 0;
    this.dedupeCache?.dispose();
    this.dedupeCache = null;
    this.activeQr = null;
  }

  // ==========================================================================
  // Event publishing
  // ==========================================================================

  private async ensureStream(): Promise<void> {
    try {
      await this.ensureInboundStreamFn();
    } catch (error) {
      this.log.warn("CHANNEL_INBOUND stream check failed; publishes will retry it", {
        instanceId: this.instanceId,
        error: errorMessage(error),
      });
    }
  }

  private jetstream(): JetStreamClient {
    if (!this.jetstreamClient) {
      const source = this.options.jetstream;
      this.jetstreamClient = typeof source === "function" ? source() : source;
    }
    return this.jetstreamClient;
  }

  private observed(
    type: string,
    payload: unknown,
    extra: { id?: string; ingestMode?: WhatsAppIngestMode; receivedAt?: number } = {},
  ): WhatsAppObservedEvent {
    return buildWhatsAppObservedEvent({ type, instanceId: this.instanceId, payload, now: this.now(), ...extra });
  }

  /**
   * Hand the event to the observer and, for published types, publish its
   * `WhatsAppInboundEvent` (events.ts) on CHANNEL_INBOUND.
   */
  private async emit(observed: WhatsAppObservedEvent): Promise<void> {
    try {
      this.options.onEvent?.(observed);
    } catch (error) {
      this.log.warn("WhatsApp event observer failed", { instanceId: this.instanceId, error: errorMessage(error) });
    }
    if (!this.publishedTypes.has(observed.type)) return;
    let event: WhatsAppInboundEvent | null;
    try {
      event = toWhatsAppInboundEvent(observed);
    } catch (error) {
      this.publishFailures++;
      this.log.error("Dropped WhatsApp inbound event: it does not match the inbound contract", {
        instanceId: this.instanceId,
        type: observed.type,
        eventId: observed.id,
        failures: this.publishFailures,
        error: errorMessage(error),
      });
      return;
    }
    if (!event) return;
    if (this.streamReady) await this.streamReady;
    try {
      await publishWhatsAppInboundEvent(this.jetstream(), event);
    } catch (firstError) {
      this.log.warn("CHANNEL_INBOUND publish failed; ensuring stream and retrying", {
        instanceId: this.instanceId,
        type: event.type,
        error: errorMessage(firstError),
      });
      try {
        await this.ensureInboundStreamFn();
        await publishWhatsAppInboundEvent(this.jetstream(), event);
      } catch (error) {
        this.publishFailures++;
        this.log.error("Dropped WhatsApp inbound event: CHANNEL_INBOUND publish failed", {
          instanceId: this.instanceId,
          type: event.type,
          eventId: event.id,
          failures: this.publishFailures,
          error: errorMessage(error),
        });
      }
    }
  }

  private emitObserved(type: string, payload: unknown): void {
    this.emit(this.observed(type, payload)).catch((error: unknown) => {
      this.log.error("WhatsApp event emit failed", { instanceId: this.instanceId, type, error: errorMessage(error) });
    });
  }

  // ==========================================================================
  // WhatsAppConnectionHost
  // ==========================================================================

  async handleQrCode(_instanceId: string, qrCode: string, expiresAt: Date): Promise<void> {
    this.activeQr = { code: qrCode, expiresAt: expiresAt.getTime() };
    this.setState("qr", "qr_pending");
    await this.emit(this.observed("connection.qr", connectionQrPayload(qrCode, expiresAt)));
  }

  async handleConnected(_instanceId: string, sock: WASocket, isNewLogin = false): Promise<void> {
    this.passkeyState = null;
    this.activeQr = null;
    this.pendingLoggedOut = false;
    this.replaced = false;
    this.supervisorAttempts = 0;
    this.clearSupervisor();

    const user = sock.user;
    const ownerIdentifier = user?.id;
    const profileName = user?.name || undefined;
    this.profile = { name: profileName, ownerJid: ownerIdentifier };
    this.connectedAt = this.now();
    this.setState("connected");

    let profilePicUrl: string | undefined;
    if (ownerIdentifier) {
      try {
        profilePicUrl = (await sock.profilePictureUrl(ownerIdentifier, "image")) || undefined;
      } catch {
        // Profile picture might not be set.
      }
    }
    this.profile.picUrl = profilePicUrl;

    await this.emit(
      this.observed(
        "connection.connected",
        connectionConnectedPayload({ profileName, profilePicUrl, ownerIdentifier, isNewLogin }),
      ),
    );
    this.log.info("WhatsApp instance connected", { instanceId: this.instanceId, profileName, isNewLogin });

    // Background: populate cachedGroupMetadata so the first group send does not block the buffer.
    this.prefetchGroupMetadata(sock).catch((error) => {
      this.log.warn("Failed to prefetch group metadata", { instanceId: this.instanceId, error: errorMessage(error) });
    });
  }

  async handleDisconnected(_instanceId: string, reason: string, willReconnect: boolean): Promise<void> {
    const lib = this.loadedLibrary;
    if (lib) await this.dropSocket(lib, false);
    else this.sock = null;
    this.groupMetadataCache.clear();
    this.activeQr = null;

    const loggedOut = this.pendingLoggedOut;
    this.pendingLoggedOut = false;
    if (loggedOut) {
      // WhatsApp unlinked this device: the stored creds are dead, a new pairing is needed.
      if (lib) {
        try {
          await this.clearStoredAuth(lib);
        } catch (error) {
          this.log.warn("Failed to clear auth after logout", {
            instanceId: this.instanceId,
            error: errorMessage(error),
          });
        }
      }
      this.profile = {};
      this.setState("logged_out", "logged_out", reason);
    } else {
      this.setState("disconnected", disconnectReasonKind(reason), reason);
    }

    await this.emit(this.observed("connection.disconnected", connectionDisconnectedPayload(reason, willReconnect)));
    if (!loggedOut && !willReconnect) this.scheduleSupervisorReconnect("disconnected");
  }

  async handleReconnecting(_instanceId: string, attempt: number, maxAttempts: number): Promise<void> {
    this.reconnectCount++;
    this.setState("reconnecting", "reconnecting", `Reconnecting (attempt ${attempt}/${maxAttempts})`);
    this.log.info("Reconnecting instance", { instanceId: this.instanceId, attempt, maxAttempts });
  }

  handleConnectionError(_instanceId: string, error: string, willRetry: boolean): void {
    this.log.error("Connection error", { instanceId: this.instanceId, error, willRetry });
    if (this.stopped) return;
    // The handler never retries a reconnect that threw, whatever `willRetry` says: move to
    // `disconnected` and let the supervisor re-arm (omni#408).
    if (!this.sock || this.state !== "connected") {
      this.setState("disconnected", "connection_error", error);
      this.scheduleSupervisorReconnect("connection_error");
    }
  }

  async handlePasskeyUpdate(_instanceId: string, update: PasskeyConnectionUpdate): Promise<void> {
    const requestedAt = new Date(this.now()).toISOString();
    if (update.state === "request") {
      this.passkeyState = { state: "request", publicKey: update.publicKey, requestedAt };
      return;
    }
    if (update.state === "error") {
      this.passkeyState = { state: "error", phase: update.phase, message: update.message, requestedAt };
      return;
    }
    if (update.skipHandoffUX) {
      this.passkeyState = { state: "confirming", requestedAt };
      const sock = this.sock;
      if (!sock) {
        this.passkeyState = {
          state: "error",
          phase: "continuation",
          message: "WhatsApp connection ended before passkey confirmation.",
          requestedAt,
        };
        return;
      }
      try {
        await sock.sendPasskeyConfirmation();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to confirm passkey pairing.";
        this.passkeyState = { state: "error", phase: "continuation", message, requestedAt };
        this.log.warn("Failed to auto-confirm passkey pairing", { instanceId: this.instanceId, error: message });
      }
      return;
    }
    this.passkeyState = { state: "confirmation", code: update.code, requiresUserConfirmation: true, requestedAt };
  }

  // ==========================================================================
  // WhatsAppIdentityHost
  // ==========================================================================

  getMeJid(_instanceId?: string): string | undefined {
    return this.sock?.user?.id;
  }

  storeLidMapping(_instanceId: string, lidJid: string, phoneJid: string): void {
    this.lidMappingCache.set(lidJid, phoneJid);
    this.lidMappingCache.set(phoneJid, lidJid);
  }

  getLidMappingCache(_instanceId?: string): Map<string, string> {
    return this.lidMappingCache;
  }

  isLidFirstEnabled(_instanceId?: string): boolean {
    return this.lidFirstEnabled;
  }

  // ==========================================================================
  // WhatsAppMessageHost
  // ==========================================================================

  /**
   * ingestMode of a message Baileys delivered as offline backlog (`append`): the forced
   * `offlineIngestMode` when set, else `history-sync` only when the message is older than
   * `offlineStaleMs` (a short socket gap still gets answered). A backlog message without a
   * usable timestamp is treated as history.
   */
  private offlineBacklogIngestMode(rawMessage: WAMessage): WhatsAppIngestMode {
    if (this.offlineIngestMode) return this.offlineIngestMode;
    const sentAt = messageTimestampMs(rawMessage.messageTimestamp);
    if (sentAt === null) return "history-sync";
    return this.now() - sentAt > this.offlineStaleMs ? "history-sync" : "realtime";
  }

  isBotSentMessage(_instanceId: string, messageId: string): boolean {
    return this.sentIds.has(messageId);
  }

  getMediaBaseDir(): string {
    return this.mediaBaseDir;
  }

  async handleMessageReceived(
    _instanceId: string,
    externalId: string,
    chatId: string,
    from: string,
    content: ExtractedContent,
    replyToId: string | undefined,
    rawMessage: WAMessage,
    isFromMe: boolean,
    _platformTimestamp?: number,
    subStages?: InboundSubStageTimings,
  ): Promise<void> {
    if (externalId && rawMessage.key) {
      this.messageKeys.set(externalId, {
        remoteJid: rawMessage.key.remoteJid ?? chatId,
        fromMe: rawMessage.key.fromMe === true,
        ...(rawMessage.key.participant ? { participant: rawMessage.key.participant } : {}),
      });
      if (rawMessage.message) this.quotable.set(externalId, { key: rawMessage.key, message: rawMessage.message });
    }

    // Cache the sender's pushName for outbound @Name mention resolution.
    const senderPushName = rawMessage.pushName ?? undefined;
    if (senderPushName && from && !isFromMe) {
      const senderIsLid = (rawMessage as unknown as { senderIsLid?: boolean }).senderIsLid === true;
      const normalizedFrom = from.includes("@")
        ? from
        : `${from.split(":")[0]}${senderIsLid ? "@lid" : "@s.whatsapp.net"}`;
      this.cacheContactInfo(normalizedFrom, senderPushName, undefined);
    }

    const extendedPayload: Record<string, unknown> = {
      ...(rawMessage as unknown as Record<string, unknown>),
      isFromMe,
    };

    const contextInfo = getMessageContextInfo(rawMessage);
    const mentionedJids = contextInfo?.mentionedJid ?? [];
    if (mentionedJids.length > 0) {
      extendedPayload.mentionedJids = mentionedJids;
      const mentionedContacts: Array<{ jid: string; name?: string }> = [];
      for (const jid of mentionedJids) {
        const info = await this.getContactInfo(jid, chatId);
        if (info?.name) mentionedContacts.push({ jid, name: info.name });
      }
      if (mentionedContacts.length > 0) extendedPayload.mentionedContacts = mentionedContacts;
      const ownerJid = this.sock?.user?.id;
      if (ownerJid && this.isMentioningOwner(mentionedJids, ownerJid)) extendedPayload.isMentioningInstance = true;
    }

    await this.enrichPayloadWithQuotedMessage(extendedPayload, chatId, rawMessage);

    if (content.poll) extendedPayload.poll = content.poll;
    if (content.pollVotes) extendedPayload.pollVotes = content.pollVotes;
    if (content.event) extendedPayload.event = content.event;
    if (content.product) extendedPayload.product = content.product;
    if (content.location) extendedPayload.location = content.location;
    if (content.contact) extendedPayload.contact = content.contact;
    if (content.targetMessageId) extendedPayload.targetMessageId = content.targetMessageId;
    if (content.mediaLocalPath) extendedPayload.mediaLocalPath = content.mediaLocalPath;

    this.enrichPayloadWithChatName(extendedPayload, chatId);

    const ingestMode: WhatsAppIngestMode =
      externalId && this.offlineIds.has(externalId) ? this.offlineBacklogIngestMode(rawMessage) : "realtime";
    const payloadContent: MessageReceivedContent = {
      type: content.type,
      text: content.text || content.caption,
      mediaUrl: content.mediaUrl,
      mimeType: content.mimeType,
      ...(content.mediaLocalPath ? { localPath: content.mediaLocalPath } : {}),
    };
    const payload = messageReceivedPayload({
      externalId,
      chatId,
      from,
      senderName: senderPushName,
      chatName: typeof extendedPayload.chatName === "string" ? extendedPayload.chatName : undefined,
      content: payloadContent,
      replyToId,
      senderInstanceId: this.resolveSenderInstanceId(from, isFromMe),
      rawPayload: extendedPayload,
    });

    await this.emit(
      this.observed("message.received", payload, {
        id: deterministicEventId(messageIdempotencyKey(this.instanceId, externalId, content.type)),
        ingestMode,
        receivedAt: subStages?.ingestedAt ?? this.now(),
      }),
    );
  }

  async handleReactionReceived(
    _instanceId: string,
    externalId: string,
    chatId: string,
    from: string,
    emoji: string,
    targetMessageId: string,
    isFromMe: boolean,
  ): Promise<void> {
    // Our own reactions echo back through `messages.reaction`, which skips the upsert echo filter.
    if (isFromMe && externalId && this.sentIds.has(externalId)) return;

    // In WhatsApp, an empty emoji means the reaction was removed.
    const kind = emoji ? "reaction.received" : "reaction.removed";
    const payload: ReactionPayload = {
      messageId: targetMessageId,
      chatId,
      from,
      emoji: emoji || "",
      rawPayload: { externalId, isFromMe },
    };
    const id = deterministicEventId(reactionIdempotencyKey(this.instanceId, kind, payload));
    // Upsert and `messages.reaction` both report the same reaction: publish it once.
    if (this.recentReactionEvents.has(id)) return;
    this.recentReactionEvents.set(id, true);
    await this.emit(this.observed(kind, payload, { id }));
  }

  async handleMessageEdited(
    _instanceId: string,
    externalId: string,
    chatId: string,
    newText: string,
    fromMe = false,
    senderJid?: string,
  ): Promise<void> {
    const now = this.now();
    const editExternalId = `${externalId}-edit-${now}`;
    const payload = messageReceivedPayload({
      externalId: editExternalId,
      chatId,
      from: senderJid || chatId,
      content: { type: "edit", text: newText },
      rawPayload: { editedMessageId: externalId, newText, editedAt: now, isFromMe: fromMe },
    });
    await this.emit(
      this.observed("message.received", payload, {
        id: deterministicEventId(messageIdempotencyKey(this.instanceId, editExternalId, "edit")),
        ingestMode: "realtime",
        receivedAt: now,
      }),
    );
  }

  async handleMessageDeleted(_instanceId: string, externalId: string, chatId: string, fromMe: boolean): Promise<void> {
    const now = this.now();
    const deleteExternalId = `${externalId}-delete-${now}`;
    const payload = messageReceivedPayload({
      externalId: deleteExternalId,
      chatId,
      from: chatId,
      content: { type: "delete" },
      rawPayload: { deletedMessageId: externalId, deletedAt: now, deletedByMe: fromMe, isFromMe: fromMe },
    });
    await this.emit(
      this.observed("message.received", payload, {
        id: deterministicEventId(messageIdempotencyKey(this.instanceId, deleteExternalId, "delete")),
        ingestMode: "realtime",
        receivedAt: now,
      }),
    );
  }

  async handleMessageDelivered(_instanceId: string, externalId: string, chatId: string): Promise<void> {
    await this.emit(this.observed("message.delivered", { externalId, chatId, deliveredAt: this.now() }));
  }

  async handleMessageRead(_instanceId: string, externalId: string, chatId: string): Promise<void> {
    await this.emit(this.observed("message.read", { externalId, chatId, readAt: this.now() }));
  }

  async handleMessageFailed(_instanceId: string, externalId: string, chatId: string): Promise<void> {
    await this.emit(
      this.observed("message.failed", {
        externalId,
        chatId,
        error: "Delivery failed: recipient retry receipt not honored",
        errorCode: "WA_DELIVERY_FAILED",
        retryable: false,
      }),
    );
    this.log.warn("Message failed", { instanceId: this.instanceId, externalId, retryable: false });
  }

  // ==========================================================================
  // WhatsAppEventsHost
  // ==========================================================================

  handleCallReceived(
    _instanceId: string,
    callId: string,
    from: string,
    callType: "voice" | "video",
    status: string,
    _rawCall: unknown,
  ): void {
    this.log.info("Call received", { instanceId: this.instanceId, callId, from, callType, status });
  }

  handlePresenceUpdate(_instanceId: string, chatId: string, userId: string, presence: string, lastSeen?: number): void {
    if (presence === "composing" || presence === "recording") {
      this.emitObserved("presence.typing", { chatId, from: userId, timestamp: this.now() });
    } else if (presence === "available") {
      this.emitObserved("presence.online", { userId, lastSeen });
    } else if (presence === "unavailable") {
      this.emitObserved("presence.offline", { userId, lastSeen: lastSeen ?? this.now() });
    }
  }

  handleChatsUpsert(_instanceId: string, chats: unknown[]): void {
    for (const chat of chats) {
      const c = chat as { id?: string; displayName?: string; name?: string; unreadCount?: number | null };
      if (!c.id) continue;
      // Always cache the JID, even without a name, so every chat is discoverable.
      this.chatNamesCache.set(c.id, c.displayName || c.name || c.id);
      this.syncUnreadCount(c.id, c.unreadCount);
    }
  }

  handleChatsUpdate(_instanceId: string, updates: unknown[]): void {
    for (const update of updates) {
      const u = update as { id?: string; displayName?: string; name?: string; unreadCount?: number | null };
      if (!u.id) continue;
      const name = u.displayName || u.name;
      if (name || !this.chatNamesCache.has(u.id)) this.chatNamesCache.set(u.id, name ?? u.id);
      this.syncUnreadCount(u.id, u.unreadCount);
    }
  }

  private syncUnreadCount(chatId: string, unreadCount: number | null | undefined): void {
    if (typeof unreadCount !== "number" || !Number.isFinite(unreadCount)) return;
    this.chatUnreadCache.set(chatId, unreadCount);
    this.emitObserved("custom.chat.unread-updated", { chatId, unreadCount });
  }

  handleChatsDelete(_instanceId: string, _chatIds: string[]): void {}

  handleChatLockUpdate(_instanceId: string, update: { id?: string; locked?: boolean }): void {
    this.emitObserved("custom.whatsapp.chat-lock-updated", {
      instanceId: this.instanceId,
      chatId: update.id ?? "",
      locked: update.locked ?? false,
      timestamp: this.now(),
    });
  }

  handleContactsUpsert(_instanceId: string, contacts: unknown[]): void {
    for (const contact of contacts) {
      const c = contact as {
        id: string;
        lid?: string;
        phoneNumber?: string;
        name?: string;
        notify?: string;
        verifiedName?: string;
        imgUrl?: string | null;
        status?: string;
      };
      if (!c?.id) continue;
      this.contactsCache.set(c.id, this.buildSyncContact(c));
      this.extractContactLidMapping(c.id, c.lid, c.phoneNumber);
    }
    this.publishLidMappings();
    this.publishContactNames();
  }

  handleContactsUpdate(_instanceId: string, updates: unknown[]): void {
    for (const update of updates) {
      const u = update as { id: string; name?: string; notify?: string; verifiedName?: string; imgUrl?: string | null };
      const existing = u?.id ? this.contactsCache.get(u.id) : undefined;
      if (!existing) continue;
      existing.name = u.name || existing.name || u.notify;
      if (u.imgUrl && u.imgUrl !== "changed") existing.profilePicUrl = u.imgUrl;
      if (u.verifiedName) existing.isBusiness = true;
    }
  }

  handleGroupsUpsert(_instanceId: string, groups: unknown[]): void {
    for (const group of groups) {
      const g = group as GroupMetadata;
      if (!g?.id || !g.subject) continue;
      this.groupsCache.set(g.id, { subject: g.subject, desc: g.desc });
      if (g.participants?.length) this.setGroupMetadataCache(g.id, g);
    }
  }

  handleGroupsUpdate(_instanceId: string, updates: unknown[]): void {
    for (const update of updates) {
      const u = update as { id?: string; subject?: string; desc?: string };
      if (!u?.id) continue;
      const existing = this.groupsCache.get(u.id);
      if (existing) {
        if (u.subject) existing.subject = u.subject;
        if (u.desc !== undefined) existing.desc = u.desc;
      } else if (u.subject) {
        this.groupsCache.set(u.id, { subject: u.subject, desc: u.desc });
      }
      this.groupMetadataCache.delete(u.id);
    }
  }

  handleGroupParticipantsUpdate(_instanceId: string, update: unknown): void {
    const u = update as { id?: string } | undefined;
    if (u?.id) this.groupMetadataCache.delete(u.id);
  }

  handleGroupJoinRequest(_instanceId: string, _request: unknown): void {}

  handleGroupMemberTagUpdate(
    _instanceId: string,
    update: {
      groupId?: string;
      participant?: string;
      participantAlt?: string;
      label?: string;
      messageTimestamp?: number;
    },
  ): void {
    this.emitObserved("custom.whatsapp.group-member-tag-updated", {
      instanceId: this.instanceId,
      groupId: update.groupId ?? "",
      participant: update.participant ?? "",
      participantAlt: update.participantAlt,
      label: update.label ?? "",
      messageTimestamp: update.messageTimestamp,
      timestamp: this.now(),
    });
  }

  handleMessageReceiptUpdate(_instanceId: string, _update: unknown): void {}

  handleMediaUpdate(_instanceId: string, _update: unknown): void {}

  handleMessageCappingUpdate(_instanceId: string, info: unknown): void {
    this.emitObserved("custom.whatsapp.message-capping-updated", {
      instanceId: this.instanceId,
      info,
      timestamp: this.now(),
    });
  }

  handleMessagingHistoryStatus(
    _instanceId: string,
    status: { syncType?: unknown; status?: string; explicit?: boolean },
  ): void {
    this.emitObserved("custom.whatsapp.messaging-history-status", {
      instanceId: this.instanceId,
      syncType: status.syncType,
      status: status.status ?? "unknown",
      explicit: status.explicit,
      timestamp: this.now(),
    });
  }

  handleBlocklistSet(_instanceId: string, _blocklist: string[]): void {}

  handleBlocklistUpdate(_instanceId: string, _blocklist: string[], _type: "add" | "remove"): void {}

  handleSettingsUpdate(_instanceId: string, update: { setting?: string; value?: unknown }): void {
    this.emitObserved("custom.whatsapp.settings-updated", {
      instanceId: this.instanceId,
      setting: update.setting ?? "unknown",
      value: update.value,
      timestamp: this.now(),
    });
  }

  handleLabelEdit(_instanceId: string, _label: unknown): void {}

  handleLabelAssociation(_instanceId: string, _association: unknown, _type: "add" | "remove"): void {}

  /**
   * `messaging-history.set` (initial push / on-demand): fill chat and contact caches,
   * then publish every message as `message.received` with ingestMode `history-sync`
   * (the consumer journals it without dispatching an agent).
   */
  async handleHistorySync(_instanceId: string, history: BaileysEventMap["messaging-history.set"]): Promise<void> {
    const { contacts, messages, progress, isLatest } = history;
    if (history.chats.length > 0) this.handleChatsUpsert(this.instanceId, history.chats);
    if (contacts.length > 0) this.handleContactsUpsert(this.instanceId, contacts);

    for (let i = 0; i < messages.length; i += HISTORY_BATCH_SIZE) {
      const batch = messages.slice(i, i + HISTORY_BATCH_SIZE);
      await Promise.all(batch.map((msg) => this.processHistoryMessage(msg)));
    }

    this.historyPushFetchCount += messages.length;
    this.emitObserved("sync.progress", {
      instanceId: this.instanceId,
      jobType: "history-push",
      fetched: this.historyPushFetchCount,
      ...(typeof progress === "number" ? { progress } : {}),
    });
    if (isLatest || progress === 100) {
      this.emitObserved("sync.completed", {
        instanceId: this.instanceId,
        jobType: "history-push",
        totalFetched: this.historyPushFetchCount,
      });
      this.log.info("History sync complete", {
        instanceId: this.instanceId,
        totalMessages: this.historyPushFetchCount,
      });
      this.historyPushFetchCount = 0;
    }
  }

  private async processHistoryMessage(msg: WAMessage): Promise<void> {
    const externalId = msg.key?.id;
    const chatId = msg.key?.remoteJid;
    if (!externalId || !chatId) return;
    // Messages without a timestamp cannot be ordered: skip instead of inventing one.
    const ts = typeof msg.messageTimestamp === "number" ? msg.messageTimestamp : Number(msg.messageTimestamp ?? 0);
    if (!ts || Number.isNaN(ts)) return;

    const content = this.extractHistoryMessageContent(msg);
    if (!content) return;

    if (this.historyDownloadMedia && this.loadedLibrary) {
      const sock = this.sock;
      const context =
        sock && typeof sock.updateMediaMessage === "function" && sock.logger
          ? { reuploadRequest: sock.updateMediaMessage, logger: sock.logger }
          : undefined;
      const media = await this.loadedLibrary.tryDownloadMedia(msg, this.instanceId, externalId, {
        baseDir: this.mediaBaseDir,
        context,
      });
      if (media) {
        content.mediaUrl = media.mediaUrl;
        content.localPath = media.mediaLocalPath;
        content.mimeType = media.mimeType;
      }
    }

    const { id: senderId } = fromJid(msg.key.fromMe ? chatId : msg.key.participant || chatId);
    const rawPayload: Record<string, unknown> = { ...(msg as unknown as Record<string, unknown>) };
    if (content.localPath) rawPayload.mediaLocalPath = content.localPath;
    this.enrichPayloadWithChatName(rawPayload, chatId);
    await this.enrichPayloadWithQuotedMessage(rawPayload, chatId, msg);

    const payload = messageReceivedPayload({
      externalId,
      chatId,
      from: senderId,
      senderName: msg.pushName ?? undefined,
      chatName: typeof rawPayload.chatName === "string" ? rawPayload.chatName : undefined,
      content: {
        type: content.type,
        text: content.text || content.caption,
        mediaUrl: content.mediaUrl,
        mimeType: content.mimeType,
        ...(content.localPath ? { localPath: content.localPath } : {}),
      },
      rawPayload,
    });
    await this.emit(
      this.observed("message.received", payload, {
        id: deterministicEventId(messageIdempotencyKey(this.instanceId, externalId, content.type)),
        ingestMode: "history-sync",
        receivedAt: this.now(),
      }),
    );
  }

  /** Simplified history extractor (text, media, location/contact/poll). */
  private extractHistoryMessageContent(msg: WAMessage): HistoryContent | null {
    const message = msg.message;
    if (!message) return null;
    if (message.conversation) return { type: "text", text: message.conversation };
    if (message.extendedTextMessage?.text) return { type: "text", text: message.extendedTextMessage.text };
    const documentMessage = getDocumentMessage(message);
    if (message.imageMessage) {
      return {
        type: "image",
        mimeType: message.imageMessage.mimetype ?? "image/jpeg",
        caption: message.imageMessage.caption ?? undefined,
      };
    }
    if (message.audioMessage) return { type: "audio", mimeType: message.audioMessage.mimetype ?? "audio/ogg" };
    if (message.videoMessage) {
      return {
        type: "video",
        mimeType: message.videoMessage.mimetype ?? "video/mp4",
        caption: message.videoMessage.caption ?? undefined,
      };
    }
    if (documentMessage) {
      return {
        type: "document",
        mimeType: documentMessage.mimetype ?? "application/octet-stream",
        caption: documentMessage.caption ?? undefined,
      };
    }
    if (message.stickerMessage) return { type: "sticker", mimeType: message.stickerMessage.mimetype ?? "image/webp" };
    if (message.locationMessage) {
      return { type: "location", text: message.locationMessage.name ?? message.locationMessage.address ?? undefined };
    }
    if (message.contactMessage) return { type: "contact", text: message.contactMessage.displayName ?? undefined };
    const poll = message.pollCreationMessage || message.pollCreationMessageV3;
    if (poll) return { type: "poll", text: poll.name ?? undefined };
    return null;
  }

  // ==========================================================================
  // Contacts, names, LID mappings
  // ==========================================================================

  private buildSyncContact(c: {
    id: string;
    phoneNumber?: string;
    name?: string;
    notify?: string;
    verifiedName?: string;
    imgUrl?: string | null;
    status?: string;
    lid?: string;
  }): SyncContact {
    const phone = c.phoneNumber || (c.id.includes("@s.whatsapp.net") ? `+${c.id.split("@")[0]}` : undefined);
    return {
      platformUserId: c.id,
      name: c.name || c.notify || c.verifiedName || undefined,
      phone,
      profilePicUrl: c.imgUrl && c.imgUrl !== "changed" ? c.imgUrl : undefined,
      isGroup: c.id.endsWith("@g.us"),
      isBusiness: !!c.verifiedName,
      metadata: { lid: c.lid, status: c.status, notify: c.notify, verifiedName: c.verifiedName },
    };
  }

  private extractContactLidMapping(contactId: string, lid: string | undefined, phoneNumber: string | undefined): void {
    if (lid && isUserJid(contactId)) {
      this.storeLidMapping(this.instanceId, lid.endsWith("@lid") ? lid : `${lid}@lid`, contactId);
    }
    if (contactId.endsWith("@lid") && phoneNumber) {
      const phoneJid = phoneNumber.includes("@") ? phoneNumber : `${phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`;
      this.storeLidMapping(this.instanceId, contactId, phoneJid);
    }
  }

  /** Only the delta since the last announcement (omni#1040). */
  private publishContactNames(): void {
    const names: Array<{ jid: string; name: string }> = [];
    for (const [jid, contact] of this.contactsCache) {
      if (!contact.name || jid.includes("@g.us") || jid.includes("@broadcast")) continue;
      if (this.publishedContactNames.get(jid) === contact.name) continue;
      this.publishedContactNames.set(jid, contact.name);
      names.push({ jid, name: contact.name });
    }
    if (names.length > 0) this.emitObserved("custom.contacts.names", { names });
  }

  /** Only new or changed lid→phone pairs (omni#1040). */
  private publishLidMappings(): void {
    const mappings: Array<{ lidJid: string; phoneJid: string }> = [];
    for (const [lidJid, phoneJid] of this.lidMappingCache) {
      if (!isLidJid(lidJid) || this.publishedLidMappings.get(lidJid) === phoneJid) continue;
      this.publishedLidMappings.set(lidJid, phoneJid);
      mappings.push({ lidJid, phoneJid });
    }
    if (mappings.length > 0) this.emitObserved("custom.lid-mapping.batch", { mappings });
  }

  private cacheContactInfo(jid: string, name: string | undefined, phone: string | undefined): void {
    const existing = this.contactsCache.get(jid);
    this.contactsCache.set(jid, {
      ...existing,
      platformUserId: jid,
      name,
      phone: phone ?? existing?.phone,
      isGroup: false,
    });
  }

  /** Single-instance `resolveSenderInstanceId` (omni#1148): our own account → this instance. */
  private resolveSenderInstanceId(from: string, isFromMe: boolean): string | undefined {
    if (isFromMe) return this.instanceId;
    const user = this.sock?.user as { id?: string; lid?: string } | undefined;
    if (!user) return undefined;
    const fromJidValue = from.includes("@") ? from : undefined;
    const candidates = new Set(
      [bareId(from), bareId(fromJidValue ? this.lidMappingCache.get(fromJidValue) : undefined)].filter(Boolean),
    );
    if (candidates.has(bareId(user.id)) || candidates.has(bareId(user.lid))) return this.instanceId;
    return undefined;
  }

  private isMentioningOwner(mentionedJids: string[], ownerJid: string): boolean {
    const ownerPhone = bareId(ownerJid);
    return mentionedJids.some((jid) => {
      if (jid === ownerJid) return true;
      if (bareId(jid) === ownerPhone) return true;
      if (jid.endsWith("@lid")) {
        const resolvedPhone = this.lidMappingCache.get(jid);
        if (resolvedPhone) return bareId(resolvedPhone) === ownerPhone;
      }
      return false;
    });
  }

  private enrichPayloadWithChatName(payload: Record<string, unknown>, chatId: string): void {
    if (chatId.includes("@g.us")) {
      const group = this.groupsCache.get(chatId);
      if (group?.subject) {
        payload.chatName = group.subject;
        payload.isGroup = true;
      }
      return;
    }
    const chatName = this.chatNamesCache.get(chatId);
    if (chatName) {
      payload.chatName = chatName;
      return;
    }
    const contact = this.contactsCache.get(chatId);
    if (contact?.name) payload.chatName = contact.name;
  }

  /** Lift the quoted stanza to `rawPayload.quotedMessage` with the quoted sender's name (omni#1090). */
  private async enrichPayloadWithQuotedMessage(
    rawPayload: Record<string, unknown>,
    chatId: string,
    msg: WAMessage,
  ): Promise<void> {
    const lib = this.loadedLibrary;
    if (!lib) return;
    const quoted = lib.extractQuotedContext(msg);
    if (!quoted) return;
    const pushName = quoted.participant ? (await this.getContactInfo(quoted.participant, chatId))?.name : undefined;
    rawPayload.quotedMessage = { ...quoted, pushName };
  }

  /**
   * Ported `getContactInfo`: caches first, then (cache miss) group participants, business
   * profile and `onWhatsApp`. Never throws.
   */
  async getContactInfo(jid: string, groupJid?: string): Promise<{ name?: string; phone?: string } | null> {
    const sock = this.sock;
    if (!sock) return null;
    try {
      let lookupJid = jid;
      const originalLid = jid.endsWith("@lid") ? jid : undefined;
      if (originalLid) {
        const pn =
          this.lidMappingCache.get(originalLid) ??
          (await sock.signalRepository.lidMapping.getPNForLID(originalLid).catch(() => null));
        if (pn) lookupJid = pn;
      }

      const ownerPhone = bareId(sock.user?.id);
      const lookupPhone = bareId(lookupJid);
      if (ownerPhone && lookupPhone && ownerPhone === lookupPhone) {
        return { name: sock.user?.name, phone: ownerPhone };
      }

      const phone = lookupJid.match(/^(\d+)(:\d+)?@/)?.[1];
      const normalizedJid = phone ? `${phone}@s.whatsapp.net` : lookupJid;
      const cached = this.checkContactCaches(lookupJid, normalizedJid, phone, originalLid);
      if (cached) return cached;

      if (groupJid?.endsWith("@g.us")) {
        const groupContact = await this.tryFetchFromGroupParticipants(sock, groupJid, [
          lookupJid,
          normalizedJid,
          originalLid,
        ]);
        if (groupContact?.name) {
          this.cacheContactInfo(lookupJid, groupContact.name, groupContact.phone);
          return groupContact;
        }
      }

      if (!phone) return null;
      return await this.tryFetchFromWhatsApp(sock, lookupJid, phone);
    } catch (error) {
      this.log.debug("Failed to get contact info", { instanceId: this.instanceId, jid, error: errorMessage(error) });
      return null;
    }
  }

  private checkContactCaches(
    lookupJid: string,
    normalizedJid: string,
    phone: string | undefined,
    originalLid: string | undefined,
  ): { name?: string; phone?: string } | null {
    for (const key of [lookupJid, normalizedJid, originalLid]) {
      if (!key) continue;
      const contact = this.contactsCache.get(key);
      if (contact) return { name: contact.name, phone: contact.phone };
    }
    for (const key of [lookupJid, normalizedJid]) {
      const chatName = this.chatNamesCache.get(key);
      if (chatName) return { name: chatName, phone };
    }
    return null;
  }

  private async tryFetchFromGroupParticipants(
    sock: WASocket,
    groupJid: string,
    candidates: Array<string | undefined>,
  ): Promise<{ name?: string; phone?: string } | null> {
    try {
      const metadata = this.getCachedGroupMetadata(groupJid) ?? (await sock.groupMetadata(groupJid));
      if (metadata?.participants?.length) this.setGroupMetadataCache(groupJid, metadata);
      const participant = metadata?.participants?.find((p) => candidates.includes(p.id));
      if (!participant) return null;
      const phoneJid = participant.phoneNumber;
      const name = phoneJid ? (this.contactsCache.get(phoneJid)?.name ?? this.chatNamesCache.get(phoneJid)) : undefined;
      const lookup = candidates.find((candidate): candidate is string => Boolean(candidate)) ?? participant.id;
      return { name, phone: lookup.match(/^(\d+)(:\d+)?@/)?.[1] };
    } catch (error) {
      this.log.debug("Failed to fetch group metadata", { groupJid, error: errorMessage(error) });
      return null;
    }
  }

  private async tryFetchFromWhatsApp(
    sock: WASocket,
    lookupJid: string,
    phone: string,
  ): Promise<{ name?: string; phone?: string } | null> {
    const phoneJid = `${phone}@s.whatsapp.net`;
    try {
      const profile = ((await sock.getBusinessProfile(phoneJid)) ?? undefined) as
        | { verifiedName?: string; verified_name?: string; name?: string; business_name?: string }
        | undefined;
      const businessName = profile
        ? profile.verifiedName || profile.verified_name || profile.name || profile.business_name
        : undefined;
      if (businessName) {
        this.cacheContactInfo(lookupJid, businessName, phone);
        return { name: businessName, phone };
      }
    } catch {
      // Not a business account: fall through to onWhatsApp.
    }
    const results = await sock.onWhatsApp(phone);
    const result = results?.[0] as { exists?: boolean; notify?: string } | undefined;
    if (result?.exists) {
      const name = result.notify || undefined;
      this.cacheContactInfo(lookupJid, name, phone);
      return { name, phone };
    }
    return null;
  }

  // ==========================================================================
  // Group metadata cache + prewarm (#70)
  // ==========================================================================

  private setGroupMetadataCache(jid: string, metadata: GroupMetadata): void {
    this.groupMetadataCache.set(jid, { metadata, cachedAt: this.now() });
    if (metadata.subject) this.groupsCache.set(jid, { subject: metadata.subject, desc: metadata.desc });
  }

  /** `cachedGroupMetadata` for Baileys: fresh (< 5 min) entries only. */
  private getCachedGroupMetadata(jid: string): GroupMetadata | undefined {
    const entry = this.groupMetadataCache.get(jid);
    if (!entry) return undefined;
    if (this.now() - entry.cachedAt > GROUP_CACHE_TTL_MS) {
      this.groupMetadataCache.delete(jid);
      return undefined;
    }
    return entry.metadata;
  }

  private async prefetchGroupMetadata(sock: WASocket): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, metadata] of Object.entries(groups)) this.setGroupMetadataCache(jid, metadata);
      this.log.info("Prefetched group metadata", { instanceId: this.instanceId, groups: Object.keys(groups).length });
      await this.prewarmAllGroupCaches(sock, groups);
    } catch (error) {
      if (isTransientConnectionClosedError(error)) {
        this.log.debug("Group metadata prefetch skipped; socket closed during reconnect", {
          instanceId: this.instanceId,
          error: errorMessage(error),
        });
        return;
      }
      this.log.warn("groupFetchAllParticipating failed", { instanceId: this.instanceId, error: errorMessage(error) });
    }
  }

  /** Warm Baileys device + session caches for one group outside `keys.transaction` (#70). */
  private async prewarmGroupCaches(sock: WASocket, groupJid: string): Promise<void> {
    try {
      let metadata = this.getCachedGroupMetadata(groupJid);
      if (!metadata?.participants?.length) {
        const fresh = await sock.groupMetadata(groupJid);
        if (fresh?.participants?.length) {
          this.setGroupMetadataCache(groupJid, fresh);
          metadata = fresh;
        }
      }
      if (!metadata?.participants?.length) return;
      const devices = await sock.getUSyncDevices(
        metadata.participants.map((p) => p.id),
        true,
        false,
      );
      const deviceJids = devices.map((d) => d.jid).filter(Boolean);
      if (deviceJids.length) await sock.assertSessions(deviceJids, false);
    } catch (error) {
      this.log.debug("Group cache pre-warm failed (non-fatal)", {
        instanceId: this.instanceId,
        group: groupJid,
        error: errorMessage(error),
      });
    }
  }

  /** Warm device + session caches for every group participant after connect, in bounded batches. */
  async prewarmAllGroupCaches(sock: WASocket, groups: Record<string, GroupMetadata>): Promise<void> {
    try {
      const participants = new Set<string>();
      for (const metadata of Object.values(groups)) {
        for (const participant of metadata.participants ?? []) participants.add(participant.id);
      }
      if (participants.size === 0) return;
      const jids = [...participants];
      const deviceBatch = parsePositiveInt(this.env.WHATSAPP_PREWARM_DEVICE_BATCH_SIZE, DEFAULT_PREWARM_BATCH_SIZE);
      const sessionBatch = parsePositiveInt(this.env.WHATSAPP_PREWARM_SESSION_BATCH_SIZE, DEFAULT_PREWARM_BATCH_SIZE);
      const deviceJids: string[] = [];
      for (let i = 0; i < jids.length; i += deviceBatch) {
        const devices = await sock.getUSyncDevices(jids.slice(i, i + deviceBatch), true, false);
        for (const device of devices) if (device.jid) deviceJids.push(device.jid);
      }
      for (let i = 0; i < deviceJids.length; i += sessionBatch) {
        await sock.assertSessions(deviceJids.slice(i, i + sessionBatch), false);
      }
      this.log.info("Pre-warmed device/session caches for all groups", {
        instanceId: this.instanceId,
        participants: jids.length,
        devices: deviceJids.length,
      });
    } catch (error) {
      if (isTransientConnectionClosedError(error)) {
        this.log.debug("Bulk group cache pre-warm skipped; socket closed during reconnect", {
          instanceId: this.instanceId,
          error: errorMessage(error),
        });
        return;
      }
      this.log.warn("Bulk group cache pre-warm failed (non-fatal)", {
        instanceId: this.instanceId,
        error: errorMessage(error),
      });
    }
  }

  // ==========================================================================
  // Outbound plumbing
  // ==========================================================================

  private requireSocket(): WASocket {
    const sock = this.sock;
    if (!sock || this.state !== "connected") {
      throw notConnected(`WhatsApp instance ${this.accountName} is not connected (state: ${this.state})`);
    }
    return sock;
  }

  private getRateLimiter(): RateLimitManager {
    this.rateLimiter ??= createRateLimitManager(this.instanceId, this.log, getWhatsAppRateLimitConfig(this.env));
    return this.rateLimiter;
  }

  /**
   * Feed a send failure to the rate limiter. For a rate-limit error, returns the backoff
   * the caller should wait (sent as `retryAfterMs` on the RATE_LIMITED RPC error).
   */
  private recordRateLimit(limiter: RateLimitManager, error: unknown): number | undefined {
    if (!isRateLimitError(error)) return undefined;
    return limiter.handleRateLimit(error, 0);
  }

  private async waitForRateLimitBackoff(): Promise<RateLimitManager> {
    const limiter = this.getRateLimiter();
    const remaining = limiter.getRemainingBackoff();
    if (remaining > 0) {
      this.log.debug("Waiting for rate limit backoff", { instanceId: this.instanceId, remaining });
      await this.sleep(remaining);
    }
    return limiter;
  }

  /** Randomized gap between outgoing actions (anti-bot heuristics). */
  private async humanDelay(): Promise<void> {
    const timing = this.outboundTiming;
    if (!timing.humanDelayEnabled) return;
    const randomDelay = timing.humanDelayMinMs + Math.random() * (timing.humanDelayMaxMs - timing.humanDelayMinMs);
    const elapsed = this.now() - this.lastActionTime;
    if (elapsed < randomDelay) await this.sleep(randomDelay - elapsed);
    this.lastActionTime = this.now();
  }

  private async simulateTyping(sock: WASocket, jid: string, text: string): Promise<void> {
    const timing = this.outboundTiming;
    if (!timing.typingSimulationEnabled) return;
    try {
      const typingMs = Math.min(
        timing.typingDelayBaseMs + text.length * timing.typingDelayPerCharMs,
        timing.typingDelayMaxMs,
      );
      if (typingMs <= 0) return;
      await sock.sendPresenceUpdate("composing", jid);
      await this.sleep(typingMs);
      await sock.sendPresenceUpdate("paused", jid);
    } catch {
      // Non-critical.
    }
  }

  /** LID-first target: phone JIDs are upgraded to their LID when Baileys knows it. */
  private async resolveSendTarget(sock: WASocket, to: string): Promise<string> {
    const phoneJid = normalizeChatTarget(to);
    if (!isUserJid(phoneJid) || !this.lidFirstEnabled) return phoneJid;
    try {
      const lidJid = await sock.signalRepository.lidMapping.getLIDForPN(phoneJid);
      if (lidJid) {
        this.storeLidMapping(this.instanceId, lidJid, phoneJid);
        return lidJid;
      }
    } catch (error) {
      this.log.debug("lid_send_fallback", { instanceId: this.instanceId, phoneJid, error: errorMessage(error) });
    }
    return phoneJid;
  }

  /** Ported `preprocessOutgoing`: delay, typing, markdown and `@Name` mentions. */
  private async preprocessOutgoing(sock: WASocket, jid: string, message: OutgoingMessage): Promise<OutgoingMessage> {
    await this.humanDelay();
    const textContent = message.content.text || message.content.caption || "";
    if (textContent.length > 0) await this.simulateTyping(sock, jid, textContent);

    let processed = message;
    const formatMode = message.metadata?.messageFormatMode ?? "convert";
    if (processed.content.type === "text" && formatMode !== "passthrough" && processed.content.text) {
      processed = { ...processed, content: { ...processed.content, text: markdownToWhatsApp(processed.content.text) } };
    }

    if (processed.content.text) {
      const resolved = this.resolveMentionsInText(jid, processed.content.text);
      if (resolved.mentions.length > 0) {
        const existing = (processed.metadata?.mentions as Array<{ id: string; type: string }> | undefined) ?? [];
        processed = {
          ...processed,
          content: { ...processed.content, text: resolved.text },
          metadata: { ...processed.metadata, mentions: [...existing, ...resolved.mentions] },
        };
      }
    }
    return processed;
  }

  /** `@Name` → JID from contacts, chat names and (groups) cached participants (omni#209). */
  private resolveMentionsInText(chatJid: string, text: string): MentionResolution {
    const nameToJid = new Map<string, string>();
    const indexName = (name: string, jid: string) => {
      const lower = name.toLowerCase();
      if (!nameToJid.has(lower)) nameToJid.set(lower, jid);
      const firstName = name.split(" ")[0];
      if (firstName && firstName !== name) {
        const firstLower = firstName.toLowerCase();
        if (!nameToJid.has(firstLower)) nameToJid.set(firstLower, jid);
      }
    };
    for (const [jid, contact] of this.contactsCache) if (contact.name) indexName(contact.name, jid);
    for (const [jid, name] of this.chatNamesCache) if (name && !jid.endsWith("@g.us")) indexName(name, jid);
    if (chatJid.endsWith("@g.us")) {
      const entry = this.groupMetadataCache.get(chatJid);
      for (const participant of entry?.metadata.participants ?? []) {
        const phoneJid = participant.phoneNumber;
        const name =
          this.contactsCache.get(participant.id)?.name ||
          this.chatNamesCache.get(participant.id) ||
          (phoneJid ? this.contactsCache.get(phoneJid)?.name || this.chatNamesCache.get(phoneJid) : undefined);
        if (name) indexName(name, participant.id);
      }
    }
    const resolved = resolveMentions(text, nameToJid);
    if (resolved.mentions.length === 0) return resolved;
    // resolveMentions keeps only the number; restore the full JID so LID participants are
    // mentioned as `@lid` instead of a non-existent `<lid>@s.whatsapp.net` (a bug in the ported code).
    const jidByNumber = new Map<string, string>();
    for (const jid of nameToJid.values()) {
      const number = jid.split("@")[0];
      if (number && !jidByNumber.has(number)) jidByNumber.set(number, jid);
    }
    return {
      text: resolved.text,
      mentions: resolved.mentions.map((mention) => ({ ...mention, id: jidByNumber.get(mention.id) ?? mention.id })),
    };
  }

  /** Quoted message for a reply: the cached inbound message, else a minimal fallback. */
  private buildQuoted(replyTo: string | undefined, jid: string): WAMessage | undefined {
    if (!replyTo) return undefined;
    const cached = this.quotable.get(replyTo);
    if (cached) return { key: cached.key, message: cached.message } as WAMessage;
    const own = this.ownMessages.get(replyTo);
    const known = this.messageKeys.get(replyTo);
    const fromMe = own ? true : (known?.fromMe ?? false);
    return {
      key: {
        id: replyTo,
        remoteJid: own?.remoteJid ?? known?.remoteJid ?? jid,
        fromMe,
        ...(known?.participant ? { participant: known.participant } : {}),
      },
      message: {},
    } as WAMessage;
  }

  private trackSentMessage(messageId: string, remoteJid: string, body?: proto.IMessage | null): void {
    this.sentIds.set(messageId, true);
    this.ownMessages.set(messageId, { remoteJid, fromMe: true });
    if (body) this.recentSent.set(messageId, body);
  }

  /** Send built content; tracks the echo id and the retry body, maps failures. */
  private async deliver(
    sock: WASocket,
    jid: string,
    content: AnyMessageContent,
    rateLimiter: RateLimitManager,
    options: { quoted?: WAMessage; sent?: OutgoingMessage; original?: OutgoingMessage } = {},
  ): Promise<string> {
    try {
      if (isGroupJid(jid)) await this.prewarmGroupCaches(sock, jid);
      const result = await sock.sendMessage(jid, content, options.quoted ? { quoted: options.quoted } : undefined);
      const messageId = result?.key?.id ?? "";
      if (messageId) this.trackSentMessage(messageId, result?.key?.remoteJid ?? jid, result?.message);
      rateLimiter.reset();
      if (options.sent && options.original) this.emitMessageSent(messageId, jid, options.original, options.sent);
      return messageId;
    } catch (error) {
      const mapped = toWhatsAppRuntimeError(error, { retryAfterMs: this.recordRateLimit(rateLimiter, error) });
      this.emitObserved("message.failed", {
        chatId: jid,
        error: mapped.message,
        errorCode: mapped.channelCode ?? mapped.code,
        retryable: mapped.status >= 500 || mapped.code === WHATSAPP_RPC_ERROR_CODES.rateLimited,
      });
      throw mapped;
    }
  }

  /** Ported `buildSentEventPayload` (observer only: the daemon records its own sends). */
  private emitMessageSent(externalId: string, chatId: string, original: OutgoingMessage, sent: OutgoingMessage): void {
    const mediaSource = sent.content.mediaUrl ? "url" : sent.metadata?.base64 ? "base64" : undefined;
    this.emitObserved("message.sent", {
      externalId,
      chatId,
      to: original.to,
      content: {
        type: sent.content.type,
        text: sent.content.text ?? sent.content.caption,
        caption: sent.content.caption,
        mediaUrl: sent.content.mediaUrl,
        localPath: sent.content.localPath,
        mimeType: sent.content.mimeType,
        filename: sent.content.filename,
        isVoiceNote: sent.metadata?.ptt === true,
      },
      replyToId: original.replyTo,
      rawPayload: {
        externalId,
        isFromMe: true,
        to: original.to,
        ...(sent.content.caption ? { caption: sent.content.caption } : {}),
        ...(sent.content.filename ? { filename: sent.content.filename } : {}),
        ...(sent.content.mimeType ? { mimeType: sent.content.mimeType } : {}),
        ...(sent.metadata?.ptt === true ? { voiceNote: true } : {}),
        ...(mediaSource ? { mediaSource } : {}),
      },
    });
  }

  private async assertReadableFile(filePath: string): Promise<void> {
    if (!isAbsolute(filePath)) throw invalidRequest(`filePath must be absolute: ${filePath}`);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw invalidRequest(`filePath is not a file: ${filePath}`);
    } catch (error) {
      if (error instanceof WhatsAppRuntimeError) throw error;
      throw invalidRequest(`filePath is not readable: ${filePath}`, error);
    }
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  /** `messages.sendText`. Text made only of routing headers is dropped ("filtered"). */
  async sendText(params: WhatsAppRpcParams<"messages.sendText">): Promise<WhatsAppRpcResult<"messages.sendText">> {
    const text = sanitizeOutboundText(params.text);
    if (!text) {
      this.log.info("Outbound text filtered (only internal headers)", { instanceId: this.instanceId });
      return { messageId: "", status: "sent" };
    }
    const sock = this.requireSocket();
    const jid = await this.resolveSendTarget(sock, params.to);
    const rateLimiter = await this.waitForRateLimitBackoff();
    const formatMode = params.messageFormatMode === "passthrough" ? "passthrough" : "convert";
    const message: OutgoingMessage = {
      to: jid,
      content: { type: "text", text },
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      metadata: {
        ...(params.mentions?.length ? { mentions: params.mentions } : {}),
        messageFormatMode: formatMode,
      },
    };
    const processed = await this.preprocessOutgoing(sock, jid, message);
    const content = buildMessageContent(processed, buildVCard);
    const messageId = await this.deliver(sock, jid, content, rateLimiter, {
      quoted: this.buildQuoted(params.replyTo, jid),
      original: message,
      sent: processed,
    });
    return { messageId, status: "sent" };
  }

  /** `messages.sendMedia`: absolute `filePath` (streamed by Baileys). */
  async sendMedia(params: WhatsAppRpcParams<"messages.sendMedia">): Promise<WhatsAppRpcResult<"messages.sendMedia">> {
    const sock = this.requireSocket();
    const filePath = params.filePath.trim();
    if (!filePath) throw invalidRequest("filePath is required");
    await this.assertReadableFile(filePath);
    const filename = params.filename ?? basename(filePath);
    const voiceNote = params.type === "audio" && params.voiceNote === true;
    const mimeType = normalizeSendMediaMimeType({ type: params.type, mimeType: params.mimeType, filename, voiceNote });

    const jid = await this.resolveSendTarget(sock, params.to);
    const rateLimiter = await this.waitForRateLimitBackoff();
    let message: OutgoingMessage = {
      to: jid,
      content: {
        type: params.type,
        mediaUrl: filePath,
        localPath: filePath,
        ...(params.caption ? { caption: params.caption } : {}),
        ...(filename ? { filename } : {}),
        mimeType,
      },
      metadata: { ...(voiceNote ? { ptt: true } : {}) },
    };
    if (voiceNote) message = await this.processAudioForVoiceNote(message, filePath);

    const processed = await this.preprocessOutgoing(sock, jid, message);
    const content = buildMessageContent(processed, buildVCard);
    const messageId = await this.deliver(sock, jid, content, rateLimiter, { original: message, sent: processed });
    return { messageId, status: "sent" };
  }

  /** Voice notes go out as OGG/Opus: convert with ffmpeg when needed (ported `processAudioForVoiceNote`). */
  private async processAudioForVoiceNote(message: OutgoingMessage, filePath: string): Promise<OutgoingMessage> {
    const lib = await this.library();
    let input: Buffer;
    try {
      input = await readFile(filePath);
    } catch (error) {
      throw invalidRequest(`voice note audio is not readable: ${errorMessage(error)}`, error);
    }
    let converted: { buffer: Buffer; mimeType: string } | null = null;
    try {
      converted = await lib.convertBufferForVoiceNote(input, message.content.mimeType);
    } catch (error) {
      this.log.warn("Audio conversion failed, sending as-is", {
        instanceId: this.instanceId,
        error: errorMessage(error),
      });
    }
    if (converted) {
      this.log.info("Audio converted to OGG/OPUS for voice note", { instanceId: this.instanceId });
      return {
        ...message,
        content: { ...message.content, mimeType: converted.mimeType },
        metadata: { ...message.metadata, audioBuffer: converted.buffer },
      };
    }
    // Already OGG/Opus (or no ffmpeg): stream the file path as-is.
    return message;
  }

  /** `messages.sendSticker`: non-webp input is converted to a 512px webp first. */
  async sendSticker(
    params: WhatsAppRpcParams<"messages.sendSticker">,
  ): Promise<WhatsAppRpcResult<"messages.sendSticker">> {
    const sock = this.requireSocket();
    const filePath = params.filePath.trim();
    if (!filePath) throw invalidRequest("filePath is required");
    await this.assertReadableFile(filePath);
    let buffer: Buffer = await readFile(filePath);
    if (buffer.length === 0) throw invalidRequest("sticker is empty");
    if (!isWebp(buffer)) {
      try {
        buffer = await this.convertSticker(buffer);
      } catch (error) {
        throw invalidRequest(`sticker could not be converted to webp: ${errorMessage(error)}`, error);
      }
    }
    const jid = await this.resolveSendTarget(sock, params.to);
    const rateLimiter = await this.waitForRateLimitBackoff();
    await this.humanDelay();
    const messageId = await this.deliver(sock, jid, { sticker: buffer }, rateLimiter);
    return { messageId, status: "sent" };
  }

  /** `messages.react` (empty emoji removes). Target key fields come from caches. */
  async sendReaction(params: WhatsAppRpcParams<"messages.react">): Promise<WhatsAppRpcResult<"messages.react">> {
    const emoji = params.emoji ?? "";
    if (emoji && /^\d+$/.test(emoji)) {
      throw invalidRequest(
        `Custom emoji reactions are not supported on WhatsApp. Use a standard Unicode emoji instead (received ID: ${emoji})`,
      );
    }
    const sock = this.requireSocket();
    const own = this.ownMessages.get(params.messageId);
    const known = this.messageKeys.get(params.messageId);
    const jid = own?.remoteJid ?? known?.remoteJid ?? (await this.resolveSendTarget(sock, params.to));
    const fromMe = params.fromMe ?? (own ? true : (known?.fromMe ?? false));
    const participant = params.participant ?? (isGroupJid(jid) && !fromMe ? known?.participant : undefined);
    const rateLimiter = await this.waitForRateLimitBackoff();
    await this.humanDelay();
    try {
      const reactionId = await sendReactionMessage(sock, jid, params.messageId, emoji, fromMe, participant);
      // Track the reaction id so its echo is filtered (omni#336).
      if (reactionId) this.sentIds.set(reactionId, true);
      rateLimiter.reset();
      return { messageId: reactionId ?? "", success: true };
    } catch (error) {
      throw toWhatsAppRuntimeError(error, { retryAfterMs: this.recordRateLimit(rateLimiter, error) });
    }
  }

  /** `messages.edit`: edit one of our messages (ported `editMessage`, fromMe). */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const own = this.ownMessages.get(messageId);
    const jid = own?.remoteJid ?? normalizeChatTarget(chatId);
    const editKey: proto.IMessageKey = { remoteJid: jid, id: messageId, fromMe: true };
    // Group chats need the participant to identify the sender.
    if (isGroupJid(jid)) editKey.participant = sock.user?.id;
    try {
      const result = await sock.sendMessage(jid, { edit: editKey, text });
      if (result?.key?.id) this.sentIds.set(result.key.id, true);
      this.log.info("Message edited", { instanceId: this.instanceId, chatJid: jid, messageId });
    } catch (error) {
      this.log.error("Failed to edit message via Baileys", {
        instanceId: this.instanceId,
        chatJid: jid,
        messageId,
        error: errorMessage(error),
      });
      throw toWhatsAppRuntimeError(error);
    }
  }

  /** `messages.delete`: delete for everyone. */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const own = this.ownMessages.get(messageId);
    const known = this.messageKeys.get(messageId);
    const jid = own?.remoteJid ?? known?.remoteJid ?? normalizeChatTarget(chatId);
    const fromMe = own ? true : (known?.fromMe ?? true);
    const key: proto.IMessageKey = {
      remoteJid: jid,
      id: messageId,
      fromMe,
      ...(isGroupJid(jid) && !fromMe && known?.participant ? { participant: known.participant } : {}),
    };
    const result = await sock.sendMessage(jid, { delete: key });
    if (result?.key?.id) this.sentIds.set(result.key.id, true);
    this.log.info("Message deleted for everyone", { instanceId: this.instanceId, chatId: jid, messageId, fromMe });
  }

  /**
   * `presence.set`: typing → composing, recording → recording, both auto-paused
   * after `durationMs` (default 5000ms; 0 keeps it until paused); paused/available/unavailable
   * are sent as-is.
   */
  async sendPresence(
    to: string,
    type: "typing" | "recording" | "paused" | "available" | "unavailable",
    duration?: number,
  ): Promise<void> {
    const sock = this.requireSocket();
    if (type === "available" || type === "unavailable") {
      await sock.sendPresenceUpdate(type);
      return;
    }
    const jid = normalizeChatTarget(to);
    const existing = this.presenceTimers.get(jid);
    if (existing) {
      this.timers.clearTimeout(existing);
      this.presenceTimers.delete(jid);
    }
    if (type === "paused") {
      await sock.sendPresenceUpdate("paused", jid);
      return;
    }
    await sock.sendPresenceUpdate(type === "recording" ? "recording" : "composing", jid);
    const pauseAfter = duration ?? DEFAULT_PRESENCE_DURATION_MS;
    if (pauseAfter <= 0) return;
    const timer = this.timers.setTimeout(() => {
      this.presenceTimers.delete(jid);
      sock.sendPresenceUpdate("paused", jid).catch(() => {});
    }, pauseAfter);
    this.presenceTimers.set(jid, timer);
  }

  /** `messages.markRead` (ported `markAsRead`, honoring the read receipt mode). */
  async markRead(chatId: string, messageIds: string[]): Promise<void> {
    if (this.readReceiptMode === "off") return;
    const sock = this.requireSocket();
    const jid = normalizeChatTarget(chatId);
    if (this.readReceiptMode === "exclude-self") {
      const owner = sock.user?.id;
      if (owner && bareId(jid) === bareId(owner)) return;
    }
    if (messageIds.length === 1 && messageIds[0] === "all") {
      await sock.sendPresenceUpdate("available", jid);
      await sock.readMessages([{ remoteJid: jid, id: "all", fromMe: false }]);
      return;
    }
    const isGroup = isGroupJid(jid);
    let missingParticipants = 0;
    const keys = messageIds.map((id) => {
      const known = this.messageKeys.get(id);
      let participant = known?.participant;
      if (participant && isLidJid(participant)) participant = this.lidMappingCache.get(participant) ?? participant;
      if (isGroup && !participant) missingParticipants++;
      return {
        remoteJid: known?.remoteJid ?? jid,
        id,
        fromMe: known?.fromMe ?? false,
        ...(isGroup && participant ? { participant } : {}),
      };
    });
    if (missingParticipants > 0) {
      this.log.warn("Group read receipt missing participant for some messages", {
        instanceId: this.instanceId,
        chatId: jid,
        total: messageIds.length,
        missingParticipants,
      });
    }
    const filtered = this.readReceiptMode === "exclude-self" ? keys.filter((key) => !key.fromMe) : keys;
    if (filtered.length === 0) return;
    await sock.readMessages(filtered);
  }

  // ==========================================================================
  // Groups
  // ==========================================================================

  async listGroups(params: WhatsAppRpcParams<"groups.list">): Promise<WhatsAppRpcResult<"groups.list">> {
    const sock = this.requireSocket();
    const groups = await sock.groupFetchAllParticipating();
    const records = Object.entries(groups).map(([jid, metadata]) => {
      this.setGroupMetadataCache(jid, metadata);
      return toGroupRecord({ ...metadata, id: metadata.id || jid });
    });
    const result = boundGroupListResult(filterGroupRecords(records, { search: params.search, limit: params.limit }));
    if (result.participantsTruncated) {
      this.log.warn("groups.list result too large; participant lists omitted", {
        instanceId: this.instanceId,
        groups: result.items.length,
      });
    }
    return result;
  }

  async createGroup(subject: string, participants: string[]): Promise<WhatsAppRpcResult<"groups.create">> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const participantJids = participants.map((participant) => normalizeChatTarget(participant));
    this.log.info("Creating group", { instanceId: this.instanceId, participantCount: participantJids.length });
    const metadata = await sock.groupCreate(subject, participantJids);
    this.setGroupMetadataCache(metadata.id, metadata);
    return toGroupRecord(metadata);
  }

  async updateGroupParticipants(
    groupJid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<{ groupJid: string; results: Array<{ jid: string; status: string }> }> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    const participantJids = participants.map((participant) => normalizeChatTarget(participant));
    const result = await sock.groupParticipantsUpdate(jid, participantJids, action);
    this.groupMetadataCache.delete(jid);
    this.log.info("Group participants updated", {
      instanceId: this.instanceId,
      groupJid: jid,
      action,
      participantCount: participantJids.length,
    });
    return { groupJid: jid, results: result.map((entry) => ({ jid: entry.jid ?? "", status: String(entry.status) })) };
  }

  async getGroupInvite(groupJid: string): Promise<WhatsAppRpcGroupInviteRecord> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    const code = (await sock.groupInviteCode(jid)) ?? "";
    return { groupJid: jid, code, inviteLink: code ? inviteLink(code) : "" };
  }

  async revokeGroupInvite(groupJid: string): Promise<WhatsAppRpcGroupInviteRecord> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    const code = (await sock.groupRevokeInvite(jid)) ?? "";
    return { groupJid: jid, code, inviteLink: code ? inviteLink(code) : "" };
  }

  async joinGroup(codeOrLink: string): Promise<WhatsAppRpcResult<"groups.join">> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const groupJid = (await sock.groupAcceptInvite(extractInviteCode(codeOrLink))) ?? "";
    return { groupJid, joined: Boolean(groupJid) };
  }

  async leaveGroup(groupJid: string): Promise<WhatsAppRpcResult<"groups.leave">> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    await sock.groupLeave(jid);
    this.groupMetadataCache.delete(jid);
    this.log.info("Left group", { instanceId: this.instanceId, groupJid: jid });
    return { groupJid: jid, left: true };
  }

  async renameGroup(groupJid: string, subject: string): Promise<WhatsAppRpcResult<"groups.rename">> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    await sock.groupUpdateSubject(jid, subject);
    this.groupMetadataCache.delete(jid);
    const cached = this.groupsCache.get(jid);
    this.groupsCache.set(jid, { subject, desc: cached?.desc });
    return { groupJid: jid, subject };
  }

  async setGroupDescription(
    groupJid: string,
    description: string,
  ): Promise<WhatsAppRpcResult<"groups.setDescription">> {
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    await sock.groupUpdateDescription(jid, description || undefined);
    this.groupMetadataCache.delete(jid);
    return { groupJid: jid, description };
  }

  async setGroupSettings(groupJid: string, setting: string): Promise<WhatsAppRpcResult<"groups.setSettings">> {
    if (!GROUP_SETTINGS.includes(setting as GroupSetting)) {
      throw invalidRequest(`Invalid group setting "${setting}"; expected one of ${GROUP_SETTINGS.join(", ")}`);
    }
    const sock = this.requireSocket();
    await this.humanDelay();
    const jid = normalizeGroupJid(groupJid);
    await sock.groupSettingUpdate(jid, setting as GroupSetting);
    this.groupMetadataCache.delete(jid);
    return { groupJid: jid, setting };
  }

  /** `groups.metadata`: cached when younger than `maxAgeMs` (default: the 5 min cache TTL). */
  async getGroupMetadata(groupJid: string, maxAgeMs?: number): Promise<WhatsAppRpcResult<"groups.metadata">> {
    const sock = this.requireSocket();
    const jid = normalizeGroupJid(groupJid);
    const maxAge = maxAgeMs ?? GROUP_CACHE_TTL_MS;
    let entry = this.groupMetadataCache.get(jid);
    if (!entry || this.now() - entry.cachedAt > maxAge || !entry.metadata.participants?.length) {
      const metadata = await sock.groupMetadata(jid);
      this.setGroupMetadataCache(jid, metadata);
      entry = this.groupMetadataCache.get(jid);
    }
    if (!entry) {
      throw new WhatsAppRuntimeError(WHATSAPP_RPC_ERROR_CODES.notFound, `Group not found: ${jid}`);
    }
    return toGroupMetadataResult(jid, entry.metadata, entry.cachedAt, {
      nameFor: (participantJid) =>
        this.contactsCache.get(participantJid)?.name ?? this.chatNamesCache.get(participantJid),
      phoneJidFor: (lidJid) => this.lidMappingCache.get(lidJid),
    });
  }

  // ==========================================================================
  // Test / diagnostics hooks
  // ==========================================================================

  /** Echo set membership by message id (ported `trackSentMessageId` counterpart). */
  trackSentMessageId(messageId: string): void {
    this.sentIds.set(messageId, true);
  }
}

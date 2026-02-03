/**
 * Matrix Channel Plugin
 *
 * Complete implementation of the Matrix channel using @vector-im/matrix-bot-sdk.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { notif } from "../../notif.js";
import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ConfigAdapter,
  SecurityAdapter,
  OutboundAdapter,
  GatewayAdapter,
  StatusAdapter,
  ResolvedAccount,
  SecurityDecision,
  InboundMessage,
  AccountState,
  AccountSnapshot,
  ChannelHealth,
  SendResult,
  OutboundOptions,
  DmPolicy,
  GroupPolicy,
} from "../types.js";
import type { MatrixConfig, MatrixRawEvent, MatrixInbound } from "./types.js";
import {
  type MatrixConfigInput,
  getAccountConfig,
  parseConfig,
  DEFAULT_CONFIG,
  loadMatrixConfig,
} from "./config.js";
import { sessionManager } from "./session.js";
import { createDirectRoomTracker, type DirectRoomTracker } from "./direct.js";
import {
  shouldProcessEvent,
  normalizeMessage,
  downloadMatrixMedia,
  debounceMessage,
  mergeMessages,
  getRoomInfo,
  getMemberDisplayName,
} from "./inbound.js";
import {
  sendMessage as matrixSendMessage,
  sendTyping as matrixSendTyping,
  sendReadReceipt as matrixSendReadReceipt,
  sendReaction as matrixSendReaction,
  resolveRoomId,
} from "./outbound.js";
import {
  recordReceived,
  recordSent,
  recordError,
  recordStart,
  heartbeat,
  getSnapshot,
  getHealth,
} from "./status.js";
import { transcribeAudio } from "../../transcribe/openai.js";
import {
  isAllowed as isContactAllowed,
  savePendingContact,
} from "../../contacts.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("matrix:plugin");

// ============================================================================
// Plugin Metadata
// ============================================================================

const META: ChannelMeta = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix messaging via matrix-bot-sdk",
  version: "1.0.0",
};

const CAPABILITIES: ChannelCapabilities = {
  media: true,
  reactions: true,
  replies: true,
  edits: false,
  groups: true,
  typing: true,
  readReceipts: true,
};

// ============================================================================
// Config Adapter
// ============================================================================

class MatrixConfigAdapter implements ConfigAdapter<MatrixConfig> {
  private config: MatrixConfig = DEFAULT_CONFIG;

  getConfig(): MatrixConfig {
    return this.config;
  }

  setConfig(config: MatrixConfig): void {
    this.config = config;
  }

  listAccounts(): string[] {
    return Object.keys(this.config.accounts);
  }

  resolveAccount(accountId: string): ResolvedAccount | null {
    const accountConfig = this.config.accounts[accountId];
    if (!accountConfig) {
      return null;
    }

    const state = sessionManager.getState(accountId);
    const userId = sessionManager.getUserId(accountId);

    return {
      id: accountId,
      name: accountConfig.name,
      phone: userId ?? undefined,
      state,
      enabled: accountConfig.enabled,
    };
  }

  isAuthenticated(accountId: string): boolean {
    const state = sessionManager.getState(accountId);
    return state === "connected";
  }
}

// ============================================================================
// Security Adapter
// ============================================================================

class MatrixSecurityAdapter implements SecurityAdapter<MatrixConfig> {
  checkAccess(
    accountId: string,
    senderId: string,
    isGroup: boolean,
    config: MatrixConfig
  ): SecurityDecision {
    const accountConfig = getAccountConfig(config, accountId);
    if (!accountConfig) {
      return { allowed: false, reason: "account_not_found" };
    }

    // Check room/group policy
    if (isGroup) {
      const roomPolicy = accountConfig.roomPolicy;
      if (roomPolicy === "closed") {
        return { allowed: false, reason: "rooms_disabled" };
      }
      if (roomPolicy === "allowlist") {
        // For rooms, senderId is actually roomId when checking room access
        const inAllowlist = accountConfig.roomAllowlist.some(
          (allowed) => allowed === senderId || senderId.includes(allowed)
        );
        const inContactsDb = isContactAllowed(senderId);
        if (!inAllowlist && !inContactsDb) {
          return { allowed: false, pending: true, reason: "room_not_allowed" };
        }
      }
      // For "open" policy, allow all rooms
    }

    // Check DM policy
    if (!isGroup) {
      const dmPolicy = accountConfig.dmPolicy;

      // Check allowFrom list
      if (accountConfig.allowFrom.length > 0) {
        const inAllowList = accountConfig.allowFrom.some(
          (allowed) => allowed === senderId || senderId.toLowerCase() === allowed.toLowerCase()
        );
        if (inAllowList) {
          return { allowed: true };
        }
      }

      // Check contacts database
      if (isContactAllowed(senderId)) {
        return { allowed: true };
      }

      // Apply DM policy
      switch (dmPolicy) {
        case "open":
          return { allowed: true };

        case "pairing":
          return { allowed: false, pending: true, reason: "pending_approval" };

        case "closed":
          return { allowed: false, reason: "dm_closed" };

        default:
          return { allowed: false, reason: "unknown_policy" };
      }
    }

    return { allowed: true };
  }

  getDmPolicy(accountId: string, config: MatrixConfig): DmPolicy {
    const accountConfig = getAccountConfig(config, accountId);
    // Map Matrix policies to standard DmPolicy
    const policy = accountConfig?.dmPolicy ?? "open";
    if (policy === "pairing") return "pairing";
    if (policy === "closed") return "closed";
    return "open";
  }

  getGroupPolicy(accountId: string, config: MatrixConfig): GroupPolicy {
    const accountConfig = getAccountConfig(config, accountId);
    // Map Matrix policies to standard GroupPolicy
    const policy = accountConfig?.roomPolicy ?? "closed";
    if (policy === "allowlist") return "allowlist";
    if (policy === "closed") return "closed";
    return "open";
  }

  isAllowed(accountId: string, senderId: string, config: MatrixConfig): boolean {
    const decision = this.checkAccess(accountId, senderId, false, config);
    return decision.allowed;
  }
}

// ============================================================================
// Outbound Adapter
// ============================================================================

class MatrixOutboundAdapter implements OutboundAdapter<MatrixConfig> {
  async send(
    accountId: string,
    targetId: string,
    options: OutboundOptions
  ): Promise<SendResult> {
    const client = sessionManager.getClient(accountId);
    if (!client) {
      return {
        success: false,
        error: `Account ${accountId} not connected`,
      };
    }

    const result = await matrixSendMessage(client, targetId, options);
    if (result.success) {
      recordSent(accountId);
    } else {
      recordError(accountId, result.error ?? "Unknown send error");
    }

    return result;
  }

  async sendTyping(
    accountId: string,
    targetId: string,
    typing: boolean
  ): Promise<void> {
    const client = sessionManager.getClient(accountId);
    if (!client) {
      log.warn(`Cannot send typing - account ${accountId} not connected`);
      return;
    }

    try {
      const roomId = await resolveRoomId(client, targetId);
      await matrixSendTyping(client, roomId, typing);
    } catch (err) {
      log.debug(`Typing indicator failed: ${err}`);
    }
  }

  async sendReadReceipt(
    accountId: string,
    chatId: string,
    messageIds: string[]
  ): Promise<void> {
    const client = sessionManager.getClient(accountId);
    if (!client) {
      log.warn(`Cannot send read receipt - account ${accountId} not connected`);
      return;
    }

    // Send read receipt for last message
    const lastId = messageIds[messageIds.length - 1];
    if (lastId) {
      await matrixSendReadReceipt(client, chatId, lastId);
    }
  }

  async sendReaction(
    accountId: string,
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const client = sessionManager.getClient(accountId);
    if (!client) {
      log.warn(`Cannot send reaction - account ${accountId} not connected`);
      return;
    }

    await matrixSendReaction(client, chatId, messageId, emoji);
  }
}

// ============================================================================
// Gateway Adapter
// ============================================================================

// Track if session manager listeners have been set up (module-level to survive re-imports)
let sessionListenersConfigured = false;
let gatewayInstance: MatrixGatewayAdapter | null = null;

class MatrixGatewayAdapter implements GatewayAdapter<MatrixConfig> {
  private configAdapter: MatrixConfigAdapter;
  private securityAdapter: MatrixSecurityAdapter;
  private stateCallbacks = new Set<(accountId: string, state: AccountState) => void>();
  private qrCallbacks = new Set<(accountId: string, qr: string) => void>();
  private messageCallbacks = new Set<(message: InboundMessage) => void>();
  private directTrackers = new Map<string, DirectRoomTracker>();
  private subscribedAccounts = new Set<string>();
  private startupTimes = new Map<string, number>();

  constructor(
    configAdapter: MatrixConfigAdapter,
    securityAdapter: MatrixSecurityAdapter
  ) {
    this.configAdapter = configAdapter;
    this.securityAdapter = securityAdapter;

    // Only set up session manager listeners once
    if (sessionListenersConfigured) {
      log.debug("Session listeners already configured, reusing");
      return;
    }
    sessionListenersConfigured = true;
    gatewayInstance = this;

    // Subscribe to session events
    sessionManager.on("stateChange", (accountId, state) => {
      if (!gatewayInstance) return;
      for (const cb of gatewayInstance.stateCallbacks) {
        cb(accountId, state);
      }
    });

    // Subscribe to client ready events
    sessionManager.on("clientReady", (accountId, client) => {
      if (!gatewayInstance) return;
      if (gatewayInstance.subscribedAccounts.has(accountId)) {
        log.debug(`Account ${accountId} already subscribed, skipping`);
        return;
      }
      gatewayInstance.subscribedAccounts.add(accountId);
      log.info(`Client ready for ${accountId}, subscribing to messages`);

      // Record startup time
      gatewayInstance.startupTimes.set(accountId, Date.now());
      recordStart(accountId);

      // Create direct room tracker
      gatewayInstance.directTrackers.set(accountId, createDirectRoomTracker(client));

      // Subscribe to room messages
      client.on("room.message", async (roomId: string, event: MatrixRawEvent) => {
        if (!gatewayInstance) return;
        const config = gatewayInstance.configAdapter.getConfig();
        await gatewayInstance.handleMessage(accountId, client, roomId, event, config);
      });

      // Subscribe to room join events (auto-accept invites)
      client.on("room.invite", async (roomId: string, _event: MatrixRawEvent) => {
        log.info(`Received invite to room ${roomId}`);
        try {
          await client.joinRoom(roomId);
          log.info(`Joined room ${roomId}`);
        } catch (err) {
          log.warn(`Failed to join room ${roomId}:`, err);
        }
      });
    });
  }

  async start(accountId: string, config: MatrixConfig): Promise<void> {
    const accountConfig = getAccountConfig(config, accountId);

    if (!accountConfig) {
      log.warn(`Account ${accountId} not found in config`);
      return;
    }

    if (!accountConfig.enabled) {
      log.info(`Account ${accountId} is disabled, skipping`);
      return;
    }

    await sessionManager.start(accountId, accountConfig);
  }

  async stop(accountId: string): Promise<void> {
    await sessionManager.stop(accountId);
    this.directTrackers.delete(accountId);
    this.startupTimes.delete(accountId);
  }

  getState(accountId: string): AccountState {
    return sessionManager.getState(accountId);
  }

  onStateChange(
    callback: (accountId: string, state: AccountState) => void
  ): () => void {
    this.stateCallbacks.add(callback);
    return () => this.stateCallbacks.delete(callback);
  }

  onQrCode(callback: (accountId: string, qr: string) => void): () => void {
    this.qrCallbacks.add(callback);
    return () => this.qrCallbacks.delete(callback);
  }

  onMessage(callback: (message: InboundMessage) => void): () => void {
    this.messageCallbacks.add(callback);
    return () => this.messageCallbacks.delete(callback);
  }

  private async handleMessage(
    accountId: string,
    client: MatrixClient,
    roomId: string,
    event: MatrixRawEvent,
    config: MatrixConfig
  ): Promise<void> {
    const accountConfig = getAccountConfig(config, accountId);
    if (!accountConfig) return;

    const startupMs = this.startupTimes.get(accountId) ?? Date.now();
    const selfUserId = await client.getUserId();

    // Filter event
    const filterResult = shouldProcessEvent(event, selfUserId, startupMs);
    if (!filterResult.pass) {
      log.debug(`Event filtered: ${filterResult.reason}`);
      return;
    }

    // Check if DM or group
    const directTracker = this.directTrackers.get(accountId);
    const isDirect = directTracker
      ? await directTracker.isDirectMessage({ roomId, senderId: event.sender })
      : false;

    // Get room info
    const roomInfo = await getRoomInfo(client, roomId);
    const senderDisplayName = await getMemberDisplayName(client, roomId, event.sender!);

    // Normalize message
    const message = normalizeMessage({
      accountId,
      roomId,
      event,
      isDirect,
      roomName: roomInfo.name,
      senderDisplayName,
    });

    if (!message) {
      return;
    }

    // Download and transcribe audio if applicable
    if (message.media?.type === "audio" && message.media.url) {
      try {
        const content = event.content as { file?: unknown; info?: { size?: number } };
        const buffer = await downloadMatrixMedia({
          client,
          mxcUrl: message.media.url,
          contentType: message.media.mimetype,
          sizeBytes: content.info?.size,
          maxBytes: 20 * 1024 * 1024, // 20MB limit
          file: content.file as import("./types.js").EncryptedFile | undefined,
        });

        if (buffer) {
          message.media.data = buffer;
          log.debug("Audio downloaded", { size: buffer.length, mimetype: message.media.mimetype });

          // Transcribe audio
          if (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY) {
            const result = await transcribeAudio(buffer, message.media.mimetype);
            message.transcription = result.text;
            log.info("Audio transcribed", { textLength: result.text.length });
          }
        }
      } catch (err) {
        log.warn("Failed to process audio:", err);
      }
    }

    log.info("Message received", {
      accountId,
      senderId: message.senderId,
      roomId: message.chatId,
      isDirect: message.isDirect,
    });

    heartbeat(accountId);
    recordReceived(accountId);

    // Check security
    const checkId = message.isGroup ? message.chatId : message.senderId;
    const decision = this.securityAdapter.checkAccess(
      accountId,
      checkId,
      message.isGroup,
      config
    );

    log.info("Security decision", decision);

    if (!decision.allowed) {
      if (decision.pending) {
        // Save as pending contact
        const pendingId = message.isGroup ? message.chatId : message.senderId;
        const pendingName = message.isGroup ? message.groupName : message.senderName;
        savePendingContact(pendingId, pendingName ?? null);
        log.info("Saved pending", { id: pendingId, isGroup: message.isGroup });
      } else {
        log.debug(`Message blocked: ${decision.reason}`);
      }
      return;
    }

    // Send read receipt if enabled
    if (accountConfig.sendReadReceipts) {
      await matrixSendReadReceipt(client, roomId, message.eventId);
    }

    // Apply debouncing
    const debounceMs = accountConfig.debounceMs;
    if (debounceMs > 0) {
      const messages = await debounceMessage(message, debounceMs);
      const merged = mergeMessages(messages);
      this.emitMessage(merged);
    } else {
      this.emitMessage(message);
    }
  }

  private emitMessage(message: MatrixInbound): void {
    // Strip media.data buffer before emitting (notif.sh has 64KB limit)
    const emitPayload = {
      ...message,
      media: message.media ? { ...message.media, data: undefined } : undefined,
      raw: undefined,
    };

    // Emit to channel-specific inbound topic
    notif.emit(`matrix.${message.accountId}.inbound`, emitPayload as unknown as Record<string, unknown>)
      .catch((err) => log.error("Failed to emit inbound message", err));

    // Also call local callbacks
    for (const cb of this.messageCallbacks) {
      try {
        cb(message);
      } catch (err) {
        log.error("Error in message callback", err);
      }
    }
  }
}

// ============================================================================
// Status Adapter
// ============================================================================

class MatrixStatusAdapter implements StatusAdapter<MatrixConfig> {
  getHealth(): ChannelHealth {
    return getHealth();
  }

  getSnapshot(accountId: string): AccountSnapshot | null {
    return getSnapshot(accountId);
  }

  recordSent(accountId: string): void {
    recordSent(accountId);
  }

  recordReceived(accountId: string): void {
    recordReceived(accountId);
  }

  recordError(accountId: string, error: string): void {
    recordError(accountId, error);
  }
}

// ============================================================================
// Plugin Factory
// ============================================================================

/**
 * Create Matrix channel plugin
 */
export function createMatrixPlugin(
  initialConfig?: MatrixConfigInput
): ChannelPlugin<MatrixConfig> {
  const configAdapter = new MatrixConfigAdapter();
  const securityAdapter = new MatrixSecurityAdapter();
  const outboundAdapter = new MatrixOutboundAdapter();
  const gatewayAdapter = new MatrixGatewayAdapter(configAdapter, securityAdapter);
  const statusAdapter = new MatrixStatusAdapter();

  // Set initial config (from parameter, env+credentials, or defaults)
  if (initialConfig) {
    configAdapter.setConfig(parseConfig(initialConfig));
  } else {
    // Load from environment + stored credentials
    const config = loadMatrixConfig();
    configAdapter.setConfig(config);
  }

  return {
    id: "matrix",
    meta: META,
    capabilities: CAPABILITIES,
    config: configAdapter,
    security: securityAdapter,
    outbound: outboundAdapter,
    gateway: gatewayAdapter,
    status: statusAdapter,

    async init(): Promise<void> {
      log.info("Matrix plugin initialized");

      // Set up state logging
      gatewayAdapter.onStateChange((accountId, state) => {
        log.info(`Account ${accountId} state: ${state}`);
      });
    },

    async shutdown(): Promise<void> {
      log.info("Shutting down Matrix plugin");
      await sessionManager.stopAll();
    },
  };
}


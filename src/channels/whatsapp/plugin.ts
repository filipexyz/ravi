/**
 * WhatsApp Channel Plugin
 *
 * Complete implementation of the WhatsApp channel using Baileys.
 */

import qrcode from "qrcode-terminal";
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
import {
  type WhatsAppConfig,
  type WhatsAppConfigInput,
  type AccountConfig,
  getAccountConfig,
  parseConfig,
  DEFAULT_CONFIG,
  DEFAULT_ACCOUNT_CONFIG,
} from "./config.js";
import { sessionManager } from "./session.js";
import {
  normalizeMessage,
  shouldProcess,
  debounceMessage,
  mergeMessages,
} from "./inbound.js";
import {
  sendMessage,
  sendTyping,
  sendReadReceipt,
  sendReaction,
  sendAckReaction,
} from "./outbound.js";
import {
  recordReceived,
  recordSent,
  recordError,
  getSnapshot,
  getHealth,
  heartbeat,
} from "./status.js";
import { normalizePhone, phoneToJid } from "./normalize.js";
import {
  isAllowed as isContactAllowed,
  savePendingContact,
} from "../../contacts.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("wa:plugin");

// ============================================================================
// Plugin Metadata
// ============================================================================

const META: ChannelMeta = {
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp messaging via Baileys",
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
// Adapters
// ============================================================================

class WhatsAppConfigAdapter implements ConfigAdapter<WhatsAppConfig> {
  private config: WhatsAppConfig = DEFAULT_CONFIG;

  getConfig(): WhatsAppConfig {
    return this.config;
  }

  setConfig(config: WhatsAppConfig): void {
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
    const socket = sessionManager.getSocket(accountId);
    const phone = socket?.user?.id?.split(":")[0];

    return {
      id: accountId,
      name: accountConfig.name,
      phone,
      state,
      enabled: accountConfig.enabled,
    };
  }

  isAuthenticated(accountId: string): boolean {
    const state = sessionManager.getState(accountId);
    return state === "connected";
  }
}

class WhatsAppSecurityAdapter implements SecurityAdapter<WhatsAppConfig> {
  checkAccess(
    accountId: string,
    senderId: string,
    isGroup: boolean,
    config: WhatsAppConfig
  ): SecurityDecision {
    const accountConfig = getAccountConfig(config, accountId);

    // Check group policy
    if (isGroup) {
      const groupPolicy = accountConfig.groupPolicy;
      if (groupPolicy === "closed") {
        return { allowed: false, reason: "groups_disabled" };
      }
      if (groupPolicy === "allowlist") {
        // For groups, senderId is the group ID
        if (!accountConfig.groupAllowFrom.includes(senderId)) {
          return { allowed: false, reason: "group_not_allowed" };
        }
      }
      // For group messages, we check the actual sender below
    }

    // Check DM policy
    const dmPolicy = accountConfig.dmPolicy;
    const normalizedSender = normalizePhone(senderId);

    // Check allowFrom list
    if (accountConfig.allowFrom.length > 0) {
      const inAllowList = accountConfig.allowFrom.some(
        (allowed) => normalizePhone(allowed) === normalizedSender
      );
      if (inAllowList) {
        return { allowed: true };
      }
    }

    // Check contacts database
    if (isContactAllowed(normalizedSender)) {
      return { allowed: true };
    }

    // Apply DM policy
    switch (dmPolicy) {
      case "open":
        return { allowed: true };

      case "pairing":
        // Save as pending for approval
        return { allowed: false, pending: true, reason: "pending_approval" };

      case "closed":
        return { allowed: false, reason: "dm_closed" };

      default:
        return { allowed: false, reason: "unknown_policy" };
    }
  }

  getDmPolicy(accountId: string, config: WhatsAppConfig): DmPolicy {
    return getAccountConfig(config, accountId).dmPolicy;
  }

  getGroupPolicy(accountId: string, config: WhatsAppConfig): GroupPolicy {
    return getAccountConfig(config, accountId).groupPolicy;
  }

  isAllowed(accountId: string, senderId: string, config: WhatsAppConfig): boolean {
    const decision = this.checkAccess(accountId, senderId, false, config);
    return decision.allowed;
  }
}

class WhatsAppOutboundAdapter implements OutboundAdapter<WhatsAppConfig> {
  async send(
    accountId: string,
    targetId: string,
    options: OutboundOptions
  ): Promise<SendResult> {
    const socket = sessionManager.getSocket(accountId);
    if (!socket) {
      return {
        success: false,
        error: `Account ${accountId} not connected`,
      };
    }

    const result = await sendMessage(socket, targetId, options);
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
    const socket = sessionManager.getSocket(accountId);
    if (!socket) {
      log.warn(`Cannot send typing - account ${accountId} not connected`);
      return;
    }

    await sendTyping(socket, targetId, typing);
  }

  async sendReadReceipt(
    accountId: string,
    chatId: string,
    messageIds: string[]
  ): Promise<void> {
    const socket = sessionManager.getSocket(accountId);
    if (!socket) {
      log.warn(`Cannot send read receipt - account ${accountId} not connected`);
      return;
    }

    // For simplicity, use chatId as sender for DMs
    await sendReadReceipt(socket, chatId, chatId, messageIds);
  }

  async sendReaction(
    accountId: string,
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    const socket = sessionManager.getSocket(accountId);
    if (!socket) {
      log.warn(`Cannot send reaction - account ${accountId} not connected`);
      return;
    }

    await sendReaction(socket, chatId, messageId, emoji);
  }
}

class WhatsAppGatewayAdapter implements GatewayAdapter<WhatsAppConfig> {
  private configAdapter: WhatsAppConfigAdapter;
  private securityAdapter: WhatsAppSecurityAdapter;
  private stateCallbacks = new Set<(accountId: string, state: AccountState) => void>();
  private qrCallbacks = new Set<(accountId: string, qr: string) => void>();
  private messageCallbacks = new Set<(message: InboundMessage) => void>();

  constructor(
    configAdapter: WhatsAppConfigAdapter,
    securityAdapter: WhatsAppSecurityAdapter
  ) {
    this.configAdapter = configAdapter;
    this.securityAdapter = securityAdapter;

    // Subscribe to session events
    sessionManager.on("stateChange", (accountId, state) => {
      for (const cb of this.stateCallbacks) {
        cb(accountId, state);
      }
    });

    sessionManager.on("qrCode", (accountId, qr) => {
      for (const cb of this.qrCallbacks) {
        cb(accountId, qr);
      }
    });
  }

  async start(accountId: string, config: WhatsAppConfig): Promise<void> {
    const accountConfig = getAccountConfig(config, accountId);

    if (!accountConfig.enabled) {
      log.info(`Account ${accountId} is disabled, skipping`);
      return;
    }

    const socket = await sessionManager.start(accountId, accountConfig);

    // Subscribe to messages
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        await this.handleMessage(accountId, message, config);
      }
    });
  }

  async stop(accountId: string): Promise<void> {
    await sessionManager.stop(accountId);
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
    rawMessage: import("@whiskeysockets/baileys").WAMessage,
    config: WhatsAppConfig
  ): Promise<void> {
    const accountConfig = getAccountConfig(config, accountId);

    // Check if message should be processed
    const filterResult = shouldProcess(rawMessage, accountConfig);
    if (!filterResult.pass) {
      log.debug(`Message filtered: ${filterResult.reason}`);
      return;
    }

    // Normalize message
    const message = normalizeMessage(accountId, rawMessage);
    if (!message) {
      return;
    }

    log.info("Message received", {
      accountId,
      senderId: message.senderId,
      chatId: message.chatId,
      isGroup: message.isGroup,
    });

    heartbeat(accountId);
    recordReceived(accountId);

    // Check security
    const decision = this.securityAdapter.checkAccess(
      accountId,
      message.senderId,
      message.isGroup,
      config
    );

    if (!decision.allowed) {
      if (decision.pending) {
        // Save as pending contact
        savePendingContact(message.senderId, message.senderName ?? null);
        log.info("Saved pending contact", {
          senderId: message.senderId,
          senderName: message.senderName,
        });
      } else {
        log.debug(`Message blocked: ${decision.reason}`);
      }
      return;
    }

    // Send read receipt if enabled
    if (accountConfig.sendReadReceipts) {
      const socket = sessionManager.getSocket(accountId);
      if (socket) {
        await sendReadReceipt(
          socket,
          message.chatId,
          message.senderId,
          [message.id]
        );
      }
    }

    // Send ACK reaction if configured
    if (accountConfig.ackReaction) {
      const socket = sessionManager.getSocket(accountId);
      if (socket) {
        // Check if message mentions us (for group ACK policy)
        const isMention = false; // TODO: implement mention detection
        await sendAckReaction(
          socket,
          message.chatId,
          message.id,
          message.isGroup,
          isMention,
          accountConfig.ackReaction
        );
      }
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

  private emitMessage(message: InboundMessage): void {
    for (const cb of this.messageCallbacks) {
      try {
        cb(message);
      } catch (err) {
        log.error("Error in message callback", err);
      }
    }
  }
}

class WhatsAppStatusAdapter implements StatusAdapter<WhatsAppConfig> {
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
 * Create WhatsApp channel plugin
 */
export function createWhatsAppPlugin(
  initialConfig?: WhatsAppConfigInput
): ChannelPlugin<WhatsAppConfig> {
  const configAdapter = new WhatsAppConfigAdapter();
  const securityAdapter = new WhatsAppSecurityAdapter();
  const outboundAdapter = new WhatsAppOutboundAdapter();
  const gatewayAdapter = new WhatsAppGatewayAdapter(configAdapter, securityAdapter);
  const statusAdapter = new WhatsAppStatusAdapter();

  // Set initial config if provided (use parseConfig to apply defaults)
  if (initialConfig) {
    configAdapter.setConfig(parseConfig(initialConfig));
  }

  return {
    id: "whatsapp",
    meta: META,
    capabilities: CAPABILITIES,
    config: configAdapter,
    security: securityAdapter,
    outbound: outboundAdapter,
    gateway: gatewayAdapter,
    status: statusAdapter,

    async init(): Promise<void> {
      log.info("WhatsApp plugin initialized");

      // Set up QR code display
      gatewayAdapter.onQrCode((accountId, qr) => {
        log.info(`Scan QR code for ${accountId} (Settings > Linked Devices):`);
        qrcode.generate(qr, { small: true });
      });

      // Set up state logging
      gatewayAdapter.onStateChange((accountId, state) => {
        log.info(`Account ${accountId} state: ${state}`);
      });
    },

    async shutdown(): Promise<void> {
      log.info("Shutting down WhatsApp plugin");
      await sessionManager.stopAll();
    },
  };
}

// ============================================================================
// Default Export
// ============================================================================

export const whatsappPlugin = createWhatsAppPlugin();

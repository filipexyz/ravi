/**
 * Channel Plugin Architecture
 *
 * Provides a unified interface for messaging channels (WhatsApp, Telegram, etc.)
 */

import type { WAMessage } from "@whiskeysockets/baileys";

// ============================================================================
// Core Types
// ============================================================================

/** Channel metadata */
export interface ChannelMeta {
  id: string;
  name: string;
  description: string;
  version: string;
}

/** Channel capabilities */
export interface ChannelCapabilities {
  media: boolean;
  reactions: boolean;
  replies: boolean;
  edits: boolean;
  groups: boolean;
  typing: boolean;
  readReceipts: boolean;
}

/** Account state */
export type AccountState =
  | "disconnected"
  | "connecting"
  | "qr"
  | "connected"
  | "error";

/** Resolved account info */
export interface ResolvedAccount {
  id: string;
  name?: string;
  phone?: string;
  state: AccountState;
  enabled: boolean;
}

/** Inbound message (normalized) */
export interface InboundMessage {
  id: string;
  channelId: string;
  accountId: string;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  chatId: string;
  text?: string;
  media?: InboundMedia;
  replyTo?: QuotedMessage;
  transcription?: string;
  timestamp: number;
  isGroup: boolean;
  groupName?: string;
  groupMembers?: string[];
  outboundEntryId?: string;
  raw: unknown;
}

/** Media attachment */
export interface InboundMedia {
  type: "image" | "video" | "audio" | "document" | "sticker";
  mimetype: string;
  filename?: string;
  caption?: string;
  data?: Buffer;
  url?: string;
  localPath?: string;
  sizeBytes?: number;
}

/** Quoted message info (for replies) */
export interface QuotedMessage {
  id: string;
  senderId: string;
  senderName?: string;
  text?: string;
  mediaType?: "image" | "video" | "audio" | "document" | "sticker";
}

/** Outbound message options */
export interface OutboundOptions {
  text?: string;
  media?: OutboundMedia;
  replyTo?: string;
  reaction?: string;
}

/** Outbound media */
export interface OutboundMedia {
  type: "image" | "video" | "audio" | "document";
  data: Buffer | string;
  mimetype: string;
  filename?: string;
  caption?: string;
}

/** Message send result */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ============================================================================
// Security Types
// ============================================================================

/** DM policy */
export type DmPolicy = "pairing" | "open" | "closed";

/** Group policy */
export type GroupPolicy = "open" | "allowlist" | "closed";

/** Security decision */
export interface SecurityDecision {
  allowed: boolean;
  reason?: string;
  pending?: boolean;
}

// ============================================================================
// Status Types
// ============================================================================

/** Account status snapshot */
export interface AccountSnapshot {
  id: string;
  state: AccountState;
  lastActivity?: number;
  lastError?: string;
  metrics: {
    messagesReceived: number;
    messagesSent: number;
    uptime: number;
  };
}

/** Channel health status */
export interface ChannelHealth {
  healthy: boolean;
  accounts: AccountSnapshot[];
  lastCheck: number;
}

// ============================================================================
// Adapters
// ============================================================================

/**
 * Config Adapter - Account configuration and resolution
 */
export interface ConfigAdapter<T = unknown> {
  /** Get current configuration */
  getConfig(): T;

  /** List all configured accounts */
  listAccounts(): string[];

  /** Resolve account details */
  resolveAccount(accountId: string): ResolvedAccount | null;

  /** Check if account is authenticated */
  isAuthenticated(accountId: string): boolean;
}

/**
 * Security Adapter - Access control and policies
 */
export interface SecurityAdapter<T = unknown> {
  /** Check if a message should be allowed */
  checkAccess(
    accountId: string,
    senderId: string,
    isGroup: boolean,
    config: T
  ): SecurityDecision;

  /** Get DM policy for account */
  getDmPolicy(accountId: string, config: T): DmPolicy;

  /** Get group policy for account */
  getGroupPolicy(accountId: string, config: T): GroupPolicy;

  /** Check if sender is in allowlist */
  isAllowed(accountId: string, senderId: string, config: T): boolean;
}

/**
 * Outbound Adapter - Message sending
 */
export interface OutboundAdapter<_T = unknown> {
  /** Send a message */
  send(
    accountId: string,
    targetId: string,
    options: OutboundOptions
  ): Promise<SendResult>;

  /** Send typing indicator */
  sendTyping(accountId: string, targetId: string, typing: boolean): Promise<void>;

  /** Send read receipt */
  sendReadReceipt(
    accountId: string,
    chatId: string,
    messageIds: string[]
  ): Promise<void>;

  /** Send reaction */
  sendReaction(
    accountId: string,
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<void>;

  /** Resolve a phone number to its actual JID/LID (optional) */
  resolveJid?(accountId: string, phone: string): Promise<string | null>;
}

/**
 * Gateway Adapter - Connection management
 */
export interface GatewayAdapter<T = unknown> {
  /** Start an account connection */
  start(accountId: string, config: T): Promise<void>;

  /** Stop an account connection */
  stop(accountId: string): Promise<void>;

  /** Get current connection state */
  getState(accountId: string): AccountState;

  /** Subscribe to connection events */
  onStateChange(
    callback: (accountId: string, state: AccountState) => void
  ): () => void;

  /** Subscribe to QR code events */
  onQrCode(callback: (accountId: string, qr: string) => void): () => void;

  /** Subscribe to inbound messages */
  onMessage(callback: (message: InboundMessage) => void): () => void;
}

/**
 * Status Adapter - Health monitoring
 */
export interface StatusAdapter<_T = unknown> {
  /** Get health status */
  getHealth(): ChannelHealth;

  /** Get account snapshot */
  getSnapshot(accountId: string): AccountSnapshot | null;

  /** Record message sent */
  recordSent(accountId: string): void;

  /** Record message received */
  recordReceived(accountId: string): void;

  /** Record error */
  recordError(accountId: string, error: string): void;
}

// ============================================================================
// Channel Plugin
// ============================================================================

/**
 * Channel Plugin - Main interface for messaging channels
 */
export interface ChannelPlugin<T = unknown> {
  /** Unique channel identifier */
  id: string;

  /** Channel metadata */
  meta: ChannelMeta;

  /** Channel capabilities */
  capabilities: ChannelCapabilities;

  /** Configuration adapter */
  config: ConfigAdapter<T>;

  /** Security adapter */
  security: SecurityAdapter<T>;

  /** Outbound adapter */
  outbound: OutboundAdapter<T>;

  /** Gateway adapter */
  gateway: GatewayAdapter<T>;

  /** Status adapter */
  status: StatusAdapter<T>;

  /** Initialize the plugin */
  init(): Promise<void>;

  /** Shutdown the plugin */
  shutdown(): Promise<void>;
}

// ============================================================================
// WhatsApp-specific Types
// ============================================================================

/** WhatsApp message with metadata */
export interface WhatsAppInbound extends InboundMessage {
  raw: WAMessage;
  jid: string;
  isLid: boolean;
}

/** WhatsApp JID components */
export interface JidComponents {
  user: string;
  server: string;
  device?: number;
  isLid: boolean;
  isGroup: boolean;
}

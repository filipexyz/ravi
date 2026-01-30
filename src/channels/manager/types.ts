/**
 * Channel Manager Types
 *
 * Runtime state tracking for multi-channel orchestration.
 */

import type { Logger } from "../../utils/logger.js";
import type { ChannelPlugin } from "../types.js";

// ============================================================================
// Channel Account Snapshot
// ============================================================================

/**
 * Detailed runtime state for a single channel account.
 */
export interface ChannelAccountSnapshot {
  /** Account identifier */
  accountId: string;

  /** Display name */
  name?: string;

  /** Whether account is enabled in config */
  enabled: boolean;

  /** Whether account has required configuration */
  configured: boolean;

  /** Whether account is linked/authenticated */
  linked: boolean;

  // Lifecycle
  /** Whether the account gateway is actively running */
  running: boolean;

  /** Whether currently connected to the service */
  connected: boolean;

  /** Timestamp when gateway was last started */
  lastStartAt?: number;

  /** Timestamp when gateway was last stopped */
  lastStopAt?: number;

  /** Timestamp when last connected successfully */
  lastConnectedAt?: number | null;

  /** Last disconnection info */
  lastDisconnect?: {
    reason: string;
    status?: number;
    at: number;
  } | null;

  // Reconnection
  /** Number of reconnection attempts since last successful connection */
  reconnectAttempts: number;

  // Activity
  /** Timestamp of last message sent or received */
  lastMessageAt?: number | null;

  /** Timestamp of last event processed */
  lastEventAt?: number | null;

  // Errors
  /** Last error message */
  lastError?: string | null;
}

// ============================================================================
// Channel Runtime Store
// ============================================================================

/**
 * Runtime store for a single channel (e.g., WhatsApp).
 * Tracks all accounts and their lifecycle state.
 */
export interface ChannelRuntimeStore {
  /** Channel identifier */
  channelId: string;

  /** AbortController per account for graceful shutdown */
  aborts: Map<string, AbortController>;

  /** Running task promises per account */
  tasks: Map<string, Promise<unknown>>;

  /** Current runtime state per account */
  runtimes: Map<string, ChannelAccountSnapshot>;
}

// ============================================================================
// Channel Gateway Context
// ============================================================================

/**
 * Context passed to channel gateway start/stop methods.
 * Provides account info, signals, and runtime update functions.
 */
export interface ChannelGatewayContext<T = unknown> {
  /** Channel identifier (e.g., "whatsapp") */
  channelId: string;

  /** Account identifier (e.g., "main", "work") */
  accountId: string;

  /** Resolved account configuration (channel-specific) */
  account: T;

  /** Full channel configuration */
  config: unknown;

  /** AbortSignal for graceful shutdown */
  abortSignal: AbortSignal;

  /** Get current runtime snapshot */
  getStatus: () => ChannelAccountSnapshot;

  /** Update runtime snapshot (partial merge) */
  setStatus: (partial: Partial<ChannelAccountSnapshot>) => void;

  /** Logger scoped to this account */
  log: Logger;
}

// ============================================================================
// Channel Manager Config
// ============================================================================

/**
 * Configuration for the ChannelManager.
 */
export interface ChannelManagerConfig {
  /** Whether to auto-start channels on manager start */
  autoStart?: boolean;

  /** Default reconnect behavior */
  reconnect?: {
    enabled: boolean;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export const DEFAULT_MANAGER_CONFIG: ChannelManagerConfig = {
  autoStart: true,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
};

// ============================================================================
// Manager Events
// ============================================================================

/**
 * Events emitted by ChannelManager.
 */
export interface ChannelManagerEvents {
  /** Account state changed */
  stateChange: (channelId: string, accountId: string, snapshot: ChannelAccountSnapshot) => void;

  /** Account started */
  started: (channelId: string, accountId: string) => void;

  /** Account stopped */
  stopped: (channelId: string, accountId: string) => void;

  /** Account error */
  error: (channelId: string, accountId: string, error: Error) => void;
}

/**
 * WhatsApp Status Tracking
 *
 * Monitors connection health and message metrics.
 */

import type { AccountSnapshot, ChannelHealth } from "../types.js";
import { sessionManager } from "./session.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("wa:status");

// ============================================================================
// Metrics Storage
// ============================================================================

interface AccountMetrics {
  messagesReceived: number;
  messagesSent: number;
  startTime: number;
  lastError?: string;
  lastErrorTime?: number;
}

const metricsMap = new Map<string, AccountMetrics>();

/**
 * Get or create metrics for an account
 */
function getMetrics(accountId: string): AccountMetrics {
  let metrics = metricsMap.get(accountId);
  if (!metrics) {
    metrics = {
      messagesReceived: 0,
      messagesSent: 0,
      startTime: Date.now(),
    };
    metricsMap.set(accountId, metrics);
  }
  return metrics;
}

// ============================================================================
// Status Adapter Implementation
// ============================================================================

/**
 * Record a received message
 */
export function recordReceived(accountId: string): void {
  const metrics = getMetrics(accountId);
  metrics.messagesReceived++;
  sessionManager.touch(accountId);
}

/**
 * Record a sent message
 */
export function recordSent(accountId: string): void {
  const metrics = getMetrics(accountId);
  metrics.messagesSent++;
  sessionManager.touch(accountId);
}

/**
 * Record an error
 */
export function recordError(accountId: string, error: string): void {
  const metrics = getMetrics(accountId);
  metrics.lastError = error;
  metrics.lastErrorTime = Date.now();
  log.error(`Error recorded for ${accountId}`, { error });
}

/**
 * Reset metrics for an account
 */
export function resetMetrics(accountId: string): void {
  metricsMap.set(accountId, {
    messagesReceived: 0,
    messagesSent: 0,
    startTime: Date.now(),
  });
}

/**
 * Clear all metrics
 */
export function clearAllMetrics(): void {
  metricsMap.clear();
}

// ============================================================================
// Snapshot Functions
// ============================================================================

/**
 * Get snapshot for a single account
 */
export function getSnapshot(accountId: string): AccountSnapshot | null {
  const state = sessionManager.getState(accountId);
  const metrics = metricsMap.get(accountId);

  if (!metrics && state === "disconnected") {
    return null;
  }

  const m = metrics ?? {
    messagesReceived: 0,
    messagesSent: 0,
    startTime: Date.now(),
  };

  return {
    id: accountId,
    state,
    lastActivity: sessionManager.getState(accountId) === "connected"
      ? Date.now()
      : undefined,
    lastError: m.lastError,
    metrics: {
      messagesReceived: m.messagesReceived,
      messagesSent: m.messagesSent,
      uptime: Date.now() - m.startTime,
    },
  };
}

/**
 * Get health status for all accounts
 */
export function getHealth(): ChannelHealth {
  const activeAccounts = sessionManager.getActiveAccounts();
  const snapshots: AccountSnapshot[] = [];

  for (const accountId of activeAccounts) {
    const snapshot = getSnapshot(accountId);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  // Also include accounts with metrics but possibly disconnected
  for (const accountId of metricsMap.keys()) {
    if (!activeAccounts.includes(accountId)) {
      const snapshot = getSnapshot(accountId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
  }

  const healthy = snapshots.some((s) => s.state === "connected");

  return {
    healthy,
    accounts: snapshots,
    lastCheck: Date.now(),
  };
}

// ============================================================================
// Watchdog
// ============================================================================

interface WatchdogConfig {
  intervalMs: number;
  maxInactiveMs: number;
  onInactive?: (accountId: string) => void;
}

let watchdogTimer: NodeJS.Timeout | null = null;
const lastActivityMap = new Map<string, number>();

/**
 * Start watchdog monitoring
 */
export function startWatchdog(config: WatchdogConfig): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  watchdogTimer = setInterval(() => {
    const now = Date.now();
    const activeAccounts = sessionManager.getActiveAccounts();

    for (const accountId of activeAccounts) {
      const state = sessionManager.getState(accountId);
      if (state !== "connected") continue;

      const lastActivity = lastActivityMap.get(accountId) ?? now;
      const inactive = now - lastActivity;

      if (inactive > config.maxInactiveMs) {
        log.warn(`Account ${accountId} inactive for ${inactive}ms`);
        config.onInactive?.(accountId);
      }
    }
  }, config.intervalMs);

  log.info("Watchdog started", {
    intervalMs: config.intervalMs,
    maxInactiveMs: config.maxInactiveMs,
  });
}

/**
 * Stop watchdog monitoring
 */
export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  lastActivityMap.clear();
  log.info("Watchdog stopped");
}

/**
 * Update activity timestamp for watchdog
 */
export function heartbeat(accountId: string): void {
  lastActivityMap.set(accountId, Date.now());
}

// ============================================================================
// Statistics
// ============================================================================

export interface ChannelStats {
  totalAccounts: number;
  connectedAccounts: number;
  totalMessagesReceived: number;
  totalMessagesSent: number;
  totalUptime: number;
  errors: Array<{ accountId: string; error: string; time: number }>;
}

/**
 * Get aggregate statistics
 */
export function getStats(): ChannelStats {
  const activeAccounts = sessionManager.getActiveAccounts();
  const allAccounts = new Set([
    ...activeAccounts,
    ...metricsMap.keys(),
  ]);

  let totalReceived = 0;
  let totalSent = 0;
  let totalUptime = 0;
  let connected = 0;
  const errors: ChannelStats["errors"] = [];

  for (const accountId of allAccounts) {
    const metrics = metricsMap.get(accountId);
    const state = sessionManager.getState(accountId);

    if (state === "connected") {
      connected++;
    }

    if (metrics) {
      totalReceived += metrics.messagesReceived;
      totalSent += metrics.messagesSent;
      totalUptime += Date.now() - metrics.startTime;

      if (metrics.lastError && metrics.lastErrorTime) {
        errors.push({
          accountId,
          error: metrics.lastError,
          time: metrics.lastErrorTime,
        });
      }
    }
  }

  // Sort errors by time (most recent first)
  errors.sort((a, b) => b.time - a.time);

  return {
    totalAccounts: allAccounts.size,
    connectedAccounts: connected,
    totalMessagesReceived: totalReceived,
    totalMessagesSent: totalSent,
    totalUptime,
    errors: errors.slice(0, 10), // Keep last 10 errors
  };
}

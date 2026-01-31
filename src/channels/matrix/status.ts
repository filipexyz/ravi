/**
 * Matrix Status Tracking
 *
 * Metrics, health checks, and status monitoring for Matrix connections.
 */

import type { AccountSnapshot, ChannelHealth, AccountState } from "../types.js";
import { sessionManager } from "./session.js";

// ============================================================================
// Per-Account Metrics
// ============================================================================

interface AccountMetrics {
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  lastError?: string;
  lastErrorAt?: number;
  startedAt?: number;
  lastActivityAt?: number;
}

const metrics = new Map<string, AccountMetrics>();
const startTime = Date.now();

function getOrCreateMetrics(accountId: string): AccountMetrics {
  let m = metrics.get(accountId);
  if (!m) {
    m = {
      messagesReceived: 0,
      messagesSent: 0,
      errors: 0,
    };
    metrics.set(accountId, m);
  }
  return m;
}

// ============================================================================
// Metric Recording
// ============================================================================

/**
 * Record a received message
 */
export function recordReceived(accountId: string): void {
  const m = getOrCreateMetrics(accountId);
  m.messagesReceived++;
  m.lastActivityAt = Date.now();
}

/**
 * Record a sent message
 */
export function recordSent(accountId: string): void {
  const m = getOrCreateMetrics(accountId);
  m.messagesSent++;
  m.lastActivityAt = Date.now();
}

/**
 * Record an error
 */
export function recordError(accountId: string, error: string): void {
  const m = getOrCreateMetrics(accountId);
  m.errors++;
  m.lastError = error;
  m.lastErrorAt = Date.now();
}

/**
 * Record session start
 */
export function recordStart(accountId: string): void {
  const m = getOrCreateMetrics(accountId);
  m.startedAt = Date.now();
}

/**
 * Heartbeat - update last activity
 */
export function heartbeat(accountId: string): void {
  const m = getOrCreateMetrics(accountId);
  m.lastActivityAt = Date.now();
}

// ============================================================================
// Status Retrieval
// ============================================================================

/**
 * Get snapshot for an account
 */
export function getSnapshot(accountId: string): AccountSnapshot | null {
  const m = metrics.get(accountId);
  const state = sessionManager.getState(accountId);

  if (!m && state === "disconnected") {
    return null;
  }

  const accountMetrics = m ?? {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
  };

  return {
    id: accountId,
    state,
    lastActivity: accountMetrics.lastActivityAt,
    lastError: accountMetrics.lastError,
    metrics: {
      messagesReceived: accountMetrics.messagesReceived,
      messagesSent: accountMetrics.messagesSent,
      uptime: accountMetrics.startedAt ? Date.now() - accountMetrics.startedAt : 0,
    },
  };
}

/**
 * Get overall channel health
 */
export function getHealth(): ChannelHealth {
  const accounts: AccountSnapshot[] = [];
  let healthy = true;

  // Collect all known account IDs
  const accountIds = new Set<string>();
  for (const id of metrics.keys()) {
    accountIds.add(id);
  }

  for (const accountId of accountIds) {
    const snapshot = getSnapshot(accountId);
    if (snapshot) {
      accounts.push(snapshot);
      if (snapshot.state === "error") {
        healthy = false;
      }
    }
  }

  // If no accounts are connected, mark as unhealthy
  if (accounts.length === 0 || accounts.every((a) => a.state !== "connected")) {
    healthy = false;
  }

  return {
    healthy,
    accounts,
    lastCheck: Date.now(),
  };
}

/**
 * Reset metrics for an account
 */
export function resetMetrics(accountId: string): void {
  metrics.delete(accountId);
}

/**
 * Get all account IDs with metrics
 */
export function getTrackedAccounts(): string[] {
  return Array.from(metrics.keys());
}

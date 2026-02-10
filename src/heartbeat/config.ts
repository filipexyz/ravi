/**
 * Heartbeat Configuration
 *
 * Helpers for managing agent heartbeat settings.
 */

import { dbGetAgent, dbUpdateAgent, dbUpdateAgentHeartbeatLastRun, dbListAgents } from "../router/router-db.js";
import type { HeartbeatConfig, AgentConfig } from "../router/types.js";

// ============================================================================
// Duration Parsing
// ============================================================================

/**
 * Parse a duration string to milliseconds.
 * Supports: 30s, 5m, 1h, 30m, etc.
 *
 * @example
 * parseDuration("30s") // 30000
 * parseDuration("5m")  // 300000
 * parseDuration("1h")  // 3600000
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use: 30s, 5m, 1h, etc.`);
  }

  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new Error(`Duration must be positive: ${duration}`);
  }

  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format milliseconds to a human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3600000) {
    return `${Math.round(ms / 60000)}m`;
  }
  return `${Math.round(ms / 3600000)}h`;
}

// ============================================================================
// Active Hours
// ============================================================================

/**
 * Parse an active hours range.
 *
 * @example
 * parseActiveHours("09:00-22:00") // { start: "09:00", end: "22:00" }
 */
export function parseActiveHours(range: string): { start: string; end: string } {
  const match = range.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!match) {
    throw new Error(`Invalid active hours format: ${range}. Use: HH:MM-HH:MM (e.g., 09:00-22:00)`);
  }

  const [, start, end] = match;

  // Validate time format
  const validateTime = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      throw new Error(`Invalid time: ${time}`);
    }
  };

  validateTime(start);
  validateTime(end);

  return { start, end };
}

/**
 * Check if current time is within active hours.
 * Returns true if no active hours are configured.
 */
export function isWithinActiveHours(config: HeartbeatConfig): boolean {
  if (!config.activeStart || !config.activeEnd) {
    return true; // No restrictions
  }

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = config.activeStart.split(":").map(Number);
  const [endH, endM] = config.activeEnd.split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight ranges (e.g., 22:00-06:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

// ============================================================================
// Agent Heartbeat Config API
// ============================================================================

/**
 * Get agent's heartbeat configuration.
 */
export function getAgentHeartbeatConfig(agentId: string): HeartbeatConfig | null {
  const agent = dbGetAgent(agentId);
  if (!agent) return null;
  return agent.heartbeat ?? {
    enabled: false,
    intervalMs: 1800000,
  };
}

/**
 * Update agent's heartbeat configuration.
 */
export function updateAgentHeartbeatConfig(
  agentId: string,
  updates: Partial<HeartbeatConfig>
): AgentConfig {
  const agent = dbGetAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const current = agent.heartbeat ?? {
    enabled: false,
    intervalMs: 1800000,
  };

  return dbUpdateAgent(agentId, {
    heartbeat: {
      ...current,
      ...updates,
    },
  });
}

/**
 * Update agent's last heartbeat run timestamp.
 */
export function updateAgentHeartbeatLastRun(agentId: string): void {
  dbUpdateAgentHeartbeatLastRun(agentId);
}

/**
 * Get list of agents with heartbeat enabled.
 */
export function getHeartbeatEnabledAgents(): AgentConfig[] {
  const agents = dbListAgents();
  return agents.filter(a => a.heartbeat?.enabled);
}

// ============================================================================
// Heartbeat Prompt
// ============================================================================

export const HEARTBEAT_PROMPT = `[Sistema Heartbeat]
Leia o arquivo HEARTBEAT.md no seu workspace.
Execute as tarefas pendentes conforme instruído.
CRITICAL: Se não houver nada a fazer, responda EXATAMENTE "HEARTBEAT_OK" — nada antes, nada depois. Qualquer texto adicional será enviado como mensagem pro usuário.`;

export const HEARTBEAT_OK = "HEARTBEAT_OK";

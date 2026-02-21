/**
 * Router Configuration
 *
 * Provides high-level config operations on top of router-db.
 * Most operations are re-exported directly from router-db.ts.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import type { RouterConfig, AgentConfig } from "./types.js";
import { logger } from "../utils/logger.js";
import {
  dbListAgents,
  dbListRoutes,
  dbGetAgent,
  dbUpdateAgent,
  dbDeleteAgent,
  dbCreateAgent,
  dbSetAgentDebounce,
  dbSetAgentSpecMode,
  getDefaultAgentId,
  getDefaultDmScope,
  getRaviDir,
  dbListSettings,
} from "./router-db.js";

const log = logger.child("router:config");

// ============================================================================
// Re-exports from router-db.ts (no wrapper needed)
// ============================================================================

export {
  getRaviDir,
  dbGetAgent as getAgent,
  dbListAgents as getAllAgents,
  dbCreateAgent as createAgent,
  dbDeleteAgent as deleteAgent,
  // Spec mode
  dbSetAgentSpecMode as setAgentSpecMode,
};

// ============================================================================
// Functions with additional logic
// ============================================================================

/**
 * Load router configuration from SQLite
 */
export function loadRouterConfig(): RouterConfig {
  const agents = dbListAgents();
  const routes = dbListRoutes();

  // Build agents record
  const agentsRecord: Record<string, AgentConfig> = {};
  for (const agent of agents) {
    agentsRecord[agent.id] = agent;
  }

  // Build account→agent mapping from settings (e.g., "account.vendas.agent" → "vendas")
  const allSettings = dbListSettings();
  const accountAgents: Record<string, string> = {};
  const instanceToAccount: Record<string, string> = {};
  const prefix = "account.";
  const suffix = ".agent";
  for (const [key, value] of Object.entries(allSettings)) {
    if (key.startsWith(prefix) && key.endsWith(suffix) && value) {
      const accountId = key.slice(prefix.length, -suffix.length);
      accountAgents[accountId] = value;
    }
  }

  // Build instanceId → account name reverse map (e.g., "ef5a692e-..." → "main")
  const instanceIdSuffix = ".instanceId";
  for (const [key, value] of Object.entries(allSettings)) {
    if (key.startsWith(prefix) && key.endsWith(instanceIdSuffix) && value) {
      const accountName = key.slice(prefix.length, -instanceIdSuffix.length);
      instanceToAccount[value] = accountName;
    }
  }

  const config: RouterConfig = {
    agents: agentsRecord,
    routes: routes.map(r => ({
      pattern: r.pattern,
      accountId: r.accountId,
      agent: r.agent,
      dmScope: r.dmScope,
      priority: r.priority,
    })),
    defaultAgent: getDefaultAgentId(),
    defaultDmScope: getDefaultDmScope(),
    accountAgents,
    instanceToAccount,
  };

  log.debug("Loaded router config", {
    agents: Object.keys(config.agents),
    routes: config.routes.length,
  });

  return config;
}

/**
 * Update an existing agent (strips id from partial to prevent accidental change)
 */
export function updateAgent(id: string, partial: Partial<AgentConfig>): void {
  const { id: _ignoreId, ...updates } = partial;
  dbUpdateAgent(id, updates);
}

/**
 * Set debounce time for an agent (0 is converted to null = disable)
 */
export function setAgentDebounce(id: string, debounceMs: number | null): void {
  dbSetAgentDebounce(id, debounceMs === 0 ? null : debounceMs);
}

/**
 * Check if all agent directories exist
 */
export function checkAgentDirs(config: RouterConfig): string[] {
  const missing: string[] = [];

  for (const agent of Object.values(config.agents)) {
    const cwd = agent.cwd.replace("~", homedir());
    if (!existsSync(cwd)) {
      missing.push(cwd);
    }
  }

  return missing;
}

/**
 * Create missing agent directories
 */
export function ensureAgentDirs(config: RouterConfig): void {
  for (const agent of Object.values(config.agents)) {
    const cwd = agent.cwd.replace("~", homedir());
    mkdirSync(cwd, { recursive: true });
  }
}

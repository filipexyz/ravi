/**
 * Router Configuration Schema
 */

import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { RouterConfig, AgentConfig } from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("router:config");

// ============================================================================
// Schemas
// ============================================================================

const DmScopeSchema = z.enum([
  "main",
  "per-peer",
  "per-channel-peer",
  "per-account-channel-peer",
]);

const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cwd: z.string(),
  model: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  /** Debounce time in ms - groups messages arriving within this window */
  debounceMs: z.number().optional(),
});

const RouteConfigSchema = z.object({
  pattern: z.string(),
  agent: z.string(),
  dmScope: DmScopeSchema.optional(),
  priority: z.number().default(0),
});

const RouterConfigSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema),
  routes: z.array(RouteConfigSchema),
  defaultAgent: z.string(),
  defaultDmScope: DmScopeSchema.default("per-peer"),
});

// ============================================================================
// Defaults
// ============================================================================

const RAVI_DIR = join(homedir(), "ravi");
const CONFIG_PATH = join(RAVI_DIR, "router.json");

const DEFAULT_CONFIG: RouterConfig = {
  agents: {
    main: {
      id: "main",
      name: "Ravi",
      cwd: join(RAVI_DIR, "main"),
    },
  },
  routes: [],
  defaultAgent: "main",
  defaultDmScope: "per-peer",
};

// ============================================================================
// Load/Save
// ============================================================================

/**
 * Load router configuration
 */
export function loadRouterConfig(): RouterConfig {
  // Ensure ravi directory exists
  mkdirSync(RAVI_DIR, { recursive: true });

  if (!existsSync(CONFIG_PATH)) {
    log.info("Creating default router config", { path: CONFIG_PATH });
    saveRouterConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const config = RouterConfigSchema.parse(parsed);

    // Ensure agent IDs match keys
    for (const [key, agent] of Object.entries(config.agents)) {
      agent.id = key;
    }

    log.info("Loaded router config", {
      agents: Object.keys(config.agents),
      routes: config.routes.length,
    });

    return config;
  } catch (err) {
    log.error("Failed to load router config, using defaults", err);
    return DEFAULT_CONFIG;
  }
}

/**
 * Save router configuration
 */
export function saveRouterConfig(config: RouterConfig): void {
  mkdirSync(RAVI_DIR, { recursive: true });

  const content = JSON.stringify(config, null, 2);
  writeFileSync(CONFIG_PATH, content, "utf-8");

  log.info("Saved router config", { path: CONFIG_PATH });
}

/**
 * Get the ravi directory path
 */
export function getRaviDir(): string {
  return RAVI_DIR;
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate router configuration
 */
export function validateConfig(config: unknown): RouterConfig {
  return RouterConfigSchema.parse(config);
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

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * Get agent by ID
 */
export function getAgent(id: string): AgentConfig | null {
  const config = loadRouterConfig();
  return config.agents[id] ?? null;
}

/**
 * Get all agents
 */
export function getAllAgents(): AgentConfig[] {
  const config = loadRouterConfig();
  return Object.values(config.agents);
}

/**
 * Create a new agent
 */
export function createAgent(agent: AgentConfig): void {
  const config = loadRouterConfig();

  if (config.agents[agent.id]) {
    throw new Error(`Agent already exists: ${agent.id}`);
  }

  config.agents[agent.id] = agent;
  saveRouterConfig(config);
  log.info("Created agent", { id: agent.id });
}

/**
 * Update an existing agent
 */
export function updateAgent(id: string, partial: Partial<AgentConfig>): void {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    throw new Error(`Agent not found: ${id}`);
  }

  // Don't allow changing the ID via partial update
  const { id: _ignoreId, ...updates } = partial;
  config.agents[id] = { ...config.agents[id], ...updates };
  saveRouterConfig(config);
  log.info("Updated agent", { id });
}

/**
 * Delete an agent
 */
export function deleteAgent(id: string): boolean {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    return false;
  }

  // Don't allow deleting the default agent
  if (id === config.defaultAgent) {
    throw new Error(`Cannot delete default agent: ${id}`);
  }

  delete config.agents[id];
  saveRouterConfig(config);
  log.info("Deleted agent", { id });
  return true;
}

// ============================================================================
// Tool Management
// ============================================================================

/**
 * Set allowed tools for an agent (null = clear whitelist, use bypass mode)
 */
export function setAgentTools(id: string, tools: string[] | null): void {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    throw new Error(`Agent not found: ${id}`);
  }

  if (tools === null) {
    delete config.agents[id].allowedTools;
  } else {
    config.agents[id].allowedTools = tools;
  }

  saveRouterConfig(config);
  log.info("Set agent tools", { id, tools });
}

/**
 * Add a tool to the agent's whitelist
 */
export function addAgentTool(id: string, tool: string): void {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    throw new Error(`Agent not found: ${id}`);
  }

  const agent = config.agents[id];

  // Initialize allowedTools if not present
  if (!agent.allowedTools) {
    agent.allowedTools = [];
  }

  // Don't add duplicates
  if (!agent.allowedTools.includes(tool)) {
    agent.allowedTools.push(tool);
    saveRouterConfig(config);
    log.info("Added tool to agent", { id, tool });
  }
}

/**
 * Remove a tool from the agent's whitelist
 */
export function removeAgentTool(id: string, tool: string): void {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    throw new Error(`Agent not found: ${id}`);
  }

  const agent = config.agents[id];

  if (!agent.allowedTools) {
    return;
  }

  agent.allowedTools = agent.allowedTools.filter(t => t !== tool);
  saveRouterConfig(config);
  log.info("Removed tool from agent", { id, tool });
}

// ============================================================================
// Debounce Management
// ============================================================================

/**
 * Set debounce time for an agent (null or 0 = disable)
 */
export function setAgentDebounce(id: string, debounceMs: number | null): void {
  const config = loadRouterConfig();

  if (!config.agents[id]) {
    throw new Error(`Agent not found: ${id}`);
  }

  if (debounceMs === null || debounceMs === 0) {
    delete config.agents[id].debounceMs;
  } else {
    config.agents[id].debounceMs = debounceMs;
  }

  saveRouterConfig(config);
  log.info("Set agent debounce", { id, debounceMs });
}

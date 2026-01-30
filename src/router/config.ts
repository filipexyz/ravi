/**
 * Router Configuration Schema
 */

import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { RouterConfig } from "./types.js";
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

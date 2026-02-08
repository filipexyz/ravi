/**
 * Plugin Discovery - Auto-discovers and loads Ravi plugins
 *
 * Two sources:
 * 1. Internal plugins - embedded in code, extracted to temp dir at runtime
 * 2. User plugins (~/ravi/plugins/) - custom user plugins
 *
 * Plugins are Claude Code SDK plugins that extend agent capabilities
 * with skills, commands, agents, and hooks.
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";
import { INTERNAL_PLUGINS } from "./internal-registry.js";

const log = logger.child("plugins");

/** Plugin path specification for the SDK */
export interface PluginSpec {
  type: "local";
  path: string;
}

/** Directory where internal plugins are extracted (cache, regenerated on start) */
const INTERNAL_PLUGINS_DIR = join(homedir(), ".cache", "ravi", "plugins");

/** User plugins directory (custom plugins) */
const USER_PLUGINS_DIR = join(homedir(), "ravi", "plugins");

/** Track if internal plugins have been extracted this session */
let internalPluginsExtracted = false;

/**
 * Extract internal plugins to temp directory.
 * SDK needs real filesystem paths, so we write embedded content to disk.
 */
function extractInternalPlugins(): void {
  if (internalPluginsExtracted) return;

  for (const plugin of INTERNAL_PLUGINS) {
    const pluginDir = join(INTERNAL_PLUGINS_DIR, plugin.name);

    for (const file of plugin.files) {
      const filePath = join(pluginDir, file.path);
      const fileDir = dirname(filePath);

      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }

      writeFileSync(filePath, file.content);
    }

    log.debug("Extracted internal plugin", { name: plugin.name, path: pluginDir });
  }

  internalPluginsExtracted = true;
  log.info("Internal plugins extracted", {
    count: INTERNAL_PLUGINS.length,
    dir: INTERNAL_PLUGINS_DIR,
  });
}

/**
 * Get internal plugins (embedded, extracted to temp).
 */
function getInternalPlugins(): PluginSpec[] {
  extractInternalPlugins();

  return INTERNAL_PLUGINS.map((plugin) => ({
    type: "local" as const,
    path: join(INTERNAL_PLUGINS_DIR, plugin.name),
  }));
}

/**
 * Scan user plugins directory.
 */
function getUserPlugins(): PluginSpec[] {
  if (!existsSync(USER_PLUGINS_DIR)) {
    log.debug("User plugins directory not found", { path: USER_PLUGINS_DIR });
    return [];
  }

  const plugins: PluginSpec[] = [];

  try {
    const entries = readdirSync(USER_PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = join(USER_PLUGINS_DIR, entry.name);
      const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");

      if (existsSync(manifestPath)) {
        plugins.push({ type: "local", path: pluginPath });
        log.debug("User plugin found", { name: entry.name, path: pluginPath });
      }
    }
  } catch (err) {
    log.error("Error scanning user plugins", { error: err });
  }

  return plugins;
}

/**
 * Discover all plugins from internal and user directories.
 *
 * Internal plugins are loaded first, then user plugins.
 *
 * @returns Array of plugin specs ready for the SDK
 */
export function discoverPlugins(): PluginSpec[] {
  const internal = getInternalPlugins();
  const user = getUserPlugins();

  const all = [...internal, ...user];

  if (all.length > 0) {
    log.info("Plugins discovered", {
      internal: internal.length,
      user: user.length,
      total: all.length,
      names: all.map((p) => p.path.split("/").pop()),
    });
  }

  return all;
}

/**
 * Get plugin names from discovered plugins.
 */
export function getPluginNames(plugins: PluginSpec[]): string[] {
  return plugins.map((p) => p.path.split("/").pop() ?? "unknown");
}

/**
 * Channel Plugin Registry
 *
 * Manages registration and retrieval of channel plugins.
 */

import type { ChannelPlugin } from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("registry");

/** Global registry of channel plugins */
const plugins = new Map<string, ChannelPlugin>();

/**
 * Register a channel plugin
 */
export function registerPlugin(plugin: ChannelPlugin): void {
  if (plugins.has(plugin.id)) {
    log.warn(`Plugin ${plugin.id} already registered, replacing`);
  }
  plugins.set(plugin.id, plugin);
  log.info(`Registered plugin: ${plugin.id}`);
}

/**
 * Get a registered plugin by ID
 */
export function getPlugin(id: string): ChannelPlugin | undefined {
  return plugins.get(id);
}

/**
 * Get all registered plugins
 */
export function getAllPlugins(): ChannelPlugin[] {
  return Array.from(plugins.values());
}

/**
 * Check if a plugin is registered
 */
export function hasPlugin(id: string): boolean {
  return plugins.has(id);
}

/**
 * Unregister a plugin
 */
export function unregisterPlugin(id: string): boolean {
  const removed = plugins.delete(id);
  if (removed) {
    log.info(`Unregistered plugin: ${id}`);
  }
  return removed;
}

/**
 * Initialize all registered plugins
 */
export async function initAllPlugins(): Promise<void> {
  for (const plugin of plugins.values()) {
    log.info(`Initializing plugin: ${plugin.id}`);
    await plugin.init();
  }
}

/**
 * Shutdown all registered plugins
 */
export async function shutdownAllPlugins(): Promise<void> {
  for (const plugin of plugins.values()) {
    log.info(`Shutting down plugin: ${plugin.id}`);
    await plugin.shutdown();
  }
}

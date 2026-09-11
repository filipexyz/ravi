/**
 * Plugin Discovery - Auto-discovers and loads Ravi plugins
 *
 * Two sources:
 * 1. Internal plugins - source files in dev, generated artifact in packaged builds
 * 2. User plugins (~/ravi/plugins/) - custom user plugins
 *
 * Plugins extend agent capabilities with skills, commands, agents, and hooks.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import { type InternalPlugin, loadInternalPlugins } from "./internal-loader.js";

const log = logger.child("plugins");

/** Plugin path specification for the SDK */
export interface PluginSpec {
  type: "local";
  path: string;
}

/** Root cache for internal plugin snapshots. */
const INTERNAL_PLUGINS_DIR = join(homedir(), ".cache", "ravi", "plugins");

/** User plugins directory (custom plugins) */
const USER_PLUGINS_DIR = join(homedir(), "ravi", "plugins");

/** Process-local view of the immutable internal plugin snapshot. */
let internalPluginSpecs: PluginSpec[] | undefined;
let lastPluginDiscoveryLogKey: string | undefined;

/**
 * Materialize embedded plugins into an immutable, content-addressed snapshot.
 *
 * Multiple Ravi processes share this cache. Each process writes to a private
 * staging directory and publishes with one atomic rename, so readers never see
 * a plugin tree while another process is replacing it.
 */
export function materializeInternalPluginsSnapshot(
  internalPlugins: InternalPlugin[],
  options: { cacheDir?: string } = {},
): string {
  const cacheDir = options.cacheDir ?? INTERNAL_PLUGINS_DIR;
  validateInternalPlugins(internalPlugins);
  const fingerprint = fingerprintInternalPlugins(internalPlugins);
  const snapshotsDir = join(cacheDir, ".snapshots");
  const snapshotDir = join(snapshotsDir, fingerprint);
  const completionMarker = join(snapshotDir, ".complete");

  if (hasCompleteSnapshot(completionMarker, fingerprint)) {
    return snapshotDir;
  }

  mkdirSync(snapshotsDir, { recursive: true });
  const stagingDir = mkdtempSync(join(snapshotsDir, `.staging-${fingerprint}-`));

  try {
    writeInternalPlugins(internalPlugins, stagingDir);
    writeFileSync(join(stagingDir, ".complete"), `${fingerprint}\n`);

    try {
      renameSync(stagingDir, snapshotDir);
    } catch (error) {
      // Another process may have published the same complete snapshot first.
      if (!hasCompleteSnapshot(completionMarker, fingerprint)) {
        throw error;
      }
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return snapshotDir;
}

function validateInternalPlugins(internalPlugins: InternalPlugin[]): void {
  for (const plugin of internalPlugins) {
    if (!plugin.files.some((file) => file.path === ".claude-plugin/plugin.json")) {
      throw new Error(`Internal plugin ${plugin.name} is missing .claude-plugin/plugin.json`);
    }
  }
}

function hasCompleteSnapshot(completionMarker: string, fingerprint: string): boolean {
  try {
    return readFileSync(completionMarker, "utf8").trim() === fingerprint;
  } catch {
    return false;
  }
}

function fingerprintInternalPlugins(internalPlugins: InternalPlugin[]): string {
  const content = internalPlugins
    .map((plugin) => ({
      name: plugin.name,
      files: plugin.files
        .map((file) => ({ path: file.path, content: file.content }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return createHash("sha256")
    .update("ravi-internal-plugin-snapshot-v1\0")
    .update(JSON.stringify(content))
    .digest("hex");
}

function writeInternalPlugins(internalPlugins: InternalPlugin[], rootDir: string): void {
  for (const plugin of internalPlugins) {
    const pluginDir = join(rootDir, plugin.name);

    for (const file of plugin.files) {
      const filePath = join(pluginDir, file.path);
      const fileDir = dirname(filePath);

      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }

      writeFileSync(filePath, file.content);
    }

    log.debug("Materialized internal plugin", { name: plugin.name, path: pluginDir });
  }
}

/**
 * Get internal plugins from the process-local immutable snapshot.
 */
function getInternalPlugins(): PluginSpec[] {
  if (internalPluginSpecs) {
    return internalPluginSpecs;
  }

  const internalPlugins = loadInternalPlugins();
  const snapshotDir = materializeInternalPluginsSnapshot(internalPlugins);

  internalPluginSpecs = internalPlugins.map((plugin) => ({
    type: "local" as const,
    path: join(snapshotDir, plugin.name),
  }));
  log.info("Internal plugins loaded", {
    count: internalPlugins.length,
    dir: snapshotDir,
  });
  return internalPluginSpecs;
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
    const payload = {
      internal: internal.length,
      user: user.length,
      total: all.length,
      names: all.map((p) => p.path.split("/").pop()),
    };
    const discoveryLogKey = all.map((plugin) => plugin.path).join("\0");

    if (discoveryLogKey === lastPluginDiscoveryLogKey) {
      log.debug("Plugins discovered", payload);
    } else {
      log.info("Plugins discovered", payload);
      lastPluginDiscoveryLogKey = discoveryLogKey;
    }
  }

  return all;
}

/**
 * Get plugin names from discovered plugins.
 */
export function getPluginNames(plugins: PluginSpec[]): string[] {
  return plugins.map((p) => p.path.split("/").pop() ?? "unknown");
}

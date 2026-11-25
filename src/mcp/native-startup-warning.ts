/**
 * The daemon's start-up signal for MCP servers a runtime used to load from its
 * own configuration (spec mcp, Import). Runtimes load only registered servers,
 * so an entry still sitting in a Claude Code or Codex file no longer loads.
 * Once per daemon start, off the start path, the same discovery `ravi doctor`
 * runs writes one warning to the daemon log per configuration file that still
 * declares servers the registry does not cover. It names the file, the
 * servers and the agents, and points to `ravi mcp import`: names and paths
 * only, never a URL, a command line or a value. Nothing is sent to anyone and
 * nothing reaches a prompt. A discovery that fails is logged at debug and
 * never blocks the start.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { dbListAgents } from "../router/router-db.js";
import type { AgentConfig } from "../router/types.js";
import { logger } from "../utils/logger.js";
import {
  discoverNativeMcpEntries,
  findUnregisteredNativeMcpEntries,
  MCP_IMPORT_SOURCE_MAX_BYTES,
  type McpImportFs,
  type McpImportRegisteredView,
} from "./import.js";
import { mcpImportAgentsOf } from "./import-agents.js";
import { listMcpServers } from "./registry-db.js";

const log = logger.child("mcp:import");

/** The host's file system, read-only, as `ravi mcp import` and `ravi doctor` read it. */
export const HOST_MCP_IMPORT_FS: McpImportFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => {
    if (statSync(path).size > MCP_IMPORT_SOURCE_MAX_BYTES) throw new Error("source too large");
    return readFileSync(path, "utf8");
  },
  listDirs: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // no-cause: a directory that cannot be listed holds no plugin to report.
      return [];
    }
  },
};

export interface NativeMcpStartupWarning {
  path: string;
  /** Native names of the servers that no longer load, sorted. */
  servers: string[];
  /** The agents whose runtime loaded them, sorted. */
  agents: string[];
}

export interface NativeMcpStartupDeps {
  listAgents?: () => readonly AgentConfig[];
  listRegistered?: () => McpImportRegisteredView[];
  homeDir?: string;
  codexHome?: string | null;
  fs?: McpImportFs;
  warn?: (message: string, fields: Record<string, unknown>) => void;
  debug?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * One warning per configuration file that still declares servers no
 * registered server covers. Returns what it logged; never throws.
 */
export function warnAboutUnregisteredNativeMcp(deps: NativeMcpStartupDeps = {}): NativeMcpStartupWarning[] {
  const warn = deps.warn ?? ((message, fields) => log.warn(message, fields));
  const debug = deps.debug ?? ((message, fields) => log.debug(message, fields));
  let warnings: NativeMcpStartupWarning[];
  try {
    const agents = (deps.listAgents ?? dbListAgents)().filter((agent) => !agent.remote);
    const discovery = discoverNativeMcpEntries({
      agents: mcpImportAgentsOf(agents),
      homeDir: deps.homeDir ?? homedir(),
      codexHome: deps.codexHome !== undefined ? deps.codexHome : process.env.CODEX_HOME?.trim() || null,
      fs: deps.fs ?? HOST_MCP_IMPORT_FS,
    });
    const registered = (
      deps.listRegistered ??
      (() =>
        listMcpServers().map((server) => ({
          name: server.name,
          origin: server.origin,
          transport: server.transport,
          urlDisplay: server.urlDisplay,
          command: server.command,
          args: server.args,
          envKeys: server.envKeys,
        })))
    )();
    const { unregistered } = findUnregisteredNativeMcpEntries(discovery, registered);
    const byPath = new Map<string, { servers: Set<string>; agents: Set<string> }>();
    for (const entry of unregistered) {
      const group = byPath.get(entry.path) ?? { servers: new Set<string>(), agents: new Set<string>() };
      group.servers.add(entry.nativeName);
      for (const agent of entry.agentIds) group.agents.add(agent);
      byPath.set(entry.path, group);
    }
    warnings = [...byPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, group]) => ({ path, servers: [...group.servers].sort(), agents: [...group.agents].sort() }));
  } catch (error) {
    // no-cause: a start-up hint that fails is not worth more than a debug line; `ravi doctor` reports the same.
    debug("Runtime-native MCP entries could not be checked at start", {
      error: error instanceof Error ? error.name : "error",
    });
    return [];
  }
  for (const warning of warnings) {
    warn(
      "MCP servers in a runtime configuration no longer load: register them with `ravi mcp import` (review the plan, then --execute)",
      { path: warning.path, servers: warning.servers, agents: warning.agents },
    );
  }
  return warnings;
}

/** Runs the check once, off the daemon's start path. */
export function scheduleNativeMcpStartupWarning(deps: NativeMcpStartupDeps = {}): void {
  const timer = setTimeout(() => {
    warnAboutUnregisteredNativeMcp(deps);
  }, 0);
  timer.unref?.();
}

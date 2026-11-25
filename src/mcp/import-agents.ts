/**
 * The agents `ravi mcp import` and `ravi doctor` look at, with the runtime
 * each one runs on, so a runtime's own MCP entries go only to the agents of
 * that runtime (spec mcp, Import).
 */

import type { AgentConfig } from "../router/types.js";
import { resolveRequestedRuntimeProvider } from "../runtime/runtime-selection.js";
import type { McpImportAgent } from "./import.js";

/**
 * The runtime an agent's sessions start on: its model preset, its own
 * provider, then the global default. A runtime that cannot be resolved is
 * `unknown`, which loads no native source.
 */
export function mcpImportAgentRuntime(agent: Pick<AgentConfig, "model" | "modelPresetId" | "provider">): string {
  try {
    return resolveRequestedRuntimeProvider({ agent }).value;
  } catch {
    // no-cause: an agent whose runtime cannot be resolved is given no native entry, which never widens access.
    return agent.provider?.trim() || "unknown";
  }
}

export function mcpImportAgentsOf(
  agents: readonly Pick<AgentConfig, "id" | "cwd" | "model" | "modelPresetId" | "provider" | "settingSources">[],
): McpImportAgent[] {
  return agents.map((agent) => ({
    id: agent.id,
    cwd: agent.cwd,
    runtime: mcpImportAgentRuntime(agent),
    ...(agent.settingSources ? { settingSources: agent.settingSources } : {}),
  }));
}

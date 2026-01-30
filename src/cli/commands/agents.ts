/**
 * Agents Commands - Agent management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import {
  getAgent,
  getAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentTools,
  addAgentTool,
  removeAgentTool,
  ensureAgentDirs,
  loadRouterConfig,
} from "../../router/config.js";

@Group({
  name: "agents",
  description: "Agent management",
})
export class AgentsCommands {
  @Command({ name: "list", description: "List all agents" })
  list() {
    const agents = getAllAgents();
    const config = loadRouterConfig();

    if (agents.length === 0) {
      console.log("No agents configured.");
      console.log("\nCreate an agent: ravi agents create <id> <cwd>");
      return;
    }

    console.log("\nAgents:\n");
    console.log("  ID              CWD                          TOOLS");
    console.log("  --------------  ---------------------------  ----------------");

    for (const agent of agents) {
      const isDefault = agent.id === config.defaultAgent;
      const id = (agent.id + (isDefault ? " *" : "")).padEnd(14);
      const cwd = agent.cwd.padEnd(27);
      const tools = agent.allowedTools
        ? `[${agent.allowedTools.length}]`
        : "bypass";

      console.log(`  ${id}  ${cwd}  ${tools}`);
    }

    console.log(`\n  Total: ${agents.length} (* = default)`);
  }

  @Command({ name: "show", description: "Show agent details" })
  show(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    const config = loadRouterConfig();

    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const isDefault = agent.id === config.defaultAgent;

    console.log(`\nAgent: ${agent.id}${isDefault ? " (default)" : ""}`);
    console.log(`  Name:          ${agent.name || "-"}`);
    console.log(`  CWD:           ${agent.cwd}`);
    console.log(`  Model:         ${agent.model || "-"}`);
    console.log(`  DM Scope:      ${agent.dmScope || "-"}`);

    if (agent.allowedTools) {
      console.log(`  Allowed Tools: [${agent.allowedTools.length}]`);
      for (const tool of agent.allowedTools) {
        console.log(`    - ${tool}`);
      }
    } else {
      console.log("  Allowed Tools: bypass (all tools)");
    }

    if (agent.systemPromptAppend) {
      console.log(`  System Append: ${agent.systemPromptAppend.slice(0, 50)}...`);
    }
  }

  @Command({ name: "create", description: "Create a new agent" })
  create(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("cwd", { description: "Working directory" }) cwd: string
  ) {
    try {
      createAgent({ id, cwd });

      // Ensure directory exists
      const config = loadRouterConfig();
      ensureAgentDirs(config);

      console.log(`\u2713 Agent created: ${id}`);
      console.log(`  CWD: ${cwd}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "delete", description: "Delete an agent" })
  delete(@Arg("id", { description: "Agent ID" }) id: string) {
    try {
      const deleted = deleteAgent(id);
      if (deleted) {
        console.log(`\u2713 Agent deleted: ${id}`);
      } else {
        console.log(`Agent not found: ${id}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "set", description: "Set agent property" })
  set(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const validKeys = ["name", "cwd", "model", "dmScope", "systemPromptAppend"];
    if (!validKeys.includes(key)) {
      console.error(`Invalid key: ${key}`);
      console.log(`Valid keys: ${validKeys.join(", ")}`);
      process.exit(1);
    }

    // Validate dmScope values
    if (key === "dmScope") {
      const validScopes = ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"];
      if (!validScopes.includes(value)) {
        console.error(`Invalid dmScope: ${value}`);
        console.log(`Valid scopes: ${validScopes.join(", ")}`);
        process.exit(1);
      }
    }

    try {
      updateAgent(id, { [key]: value });
      console.log(`\u2713 ${key} set: ${id} -> ${value}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "tools", description: "Manage agent tools" })
  tools(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("action", { required: false, description: "Action: allow, deny, clear" }) action?: string,
    @Arg("tool", { required: false, description: "Tool name" }) tool?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    // No action = list tools
    if (!action) {
      console.log(`\nTools for agent: ${id}`);
      if (agent.allowedTools) {
        console.log(`  Mode: whitelist (${agent.allowedTools.length} tools)\n`);
        for (const t of agent.allowedTools) {
          console.log(`    - ${t}`);
        }
        if (agent.allowedTools.length === 0) {
          console.log("    (none)");
        }
      } else {
        console.log("  Mode: bypass (all tools allowed)");
      }
      console.log("\nUsage:");
      console.log("  ravi agents tools <id> allow <tool>  # Add tool to whitelist");
      console.log("  ravi agents tools <id> deny <tool>   # Remove tool from whitelist");
      console.log("  ravi agents tools <id> clear         # Clear whitelist (bypass mode)");
      return;
    }

    // Handle actions
    switch (action) {
      case "allow":
        if (!tool) {
          console.error("Tool name required");
          console.log("Usage: ravi agents tools <id> allow <tool>");
          process.exit(1);
        }
        try {
          addAgentTool(id, tool);
          console.log(`\u2713 Tool allowed: ${tool}`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;

      case "deny":
        if (!tool) {
          console.error("Tool name required");
          console.log("Usage: ravi agents tools <id> deny <tool>");
          process.exit(1);
        }
        try {
          removeAgentTool(id, tool);
          console.log(`\u2713 Tool denied: ${tool}`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;

      case "clear":
        try {
          setAgentTools(id, null);
          console.log(`\u2713 Tools cleared: ${id} (bypass mode)`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;

      default:
        console.error(`Unknown action: ${action}`);
        console.log("Actions: allow, deny, clear");
        process.exit(1);
    }
  }
}

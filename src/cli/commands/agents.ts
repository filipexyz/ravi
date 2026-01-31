/**
 * Agents Commands - Agent management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { notif } from "../../notif.js";
import {
  getAgent,
  getAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentTools,
  addAgentTool,
  removeAgentTool,
  setAgentDebounce,
  ensureAgentDirs,
  loadRouterConfig,
} from "../../router/config.js";
import { DmScopeSchema } from "../../router/router-db.js";
import {
  getSession,
  deleteSession,
  getSessionsByAgent,
} from "../../router/sessions.js";
import {
  SDK_TOOLS,
  MCP_PREFIX,
  getCliToolNames,
  getCliToolsFullNames,
  getAllToolsFullNames,
  toFullToolName,
} from "../tool-registry.js";
import type { PromptMessage, ResponseMessage } from "../../bot.js";

const PROMPT_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Check if a tool is enabled for an agent
 */
function isToolEnabled(
  toolFullName: string,
  allowedTools: string[] | undefined
): boolean {
  if (!allowedTools) return true; // bypass mode
  return allowedTools.includes(toolFullName);
}

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
    console.log(`  Debounce:      ${agent.debounceMs ? `${agent.debounceMs}ms` : "disabled"}`);

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
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        console.error(`Invalid dmScope: ${value}`);
        console.log(`Valid scopes: ${DmScopeSchema.options.join(", ")}`);
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
    @Arg("action", { required: false, description: "Action: allow, deny, clear, init" }) action?: string,
    @Arg("tool", { required: false, description: "Tool name or category (sdk, cli, all)" }) tool?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    // Get tools from registry
    const CLI_TOOL_NAMES = getCliToolNames();
    const CLI_TOOLS_FULL = getCliToolsFullNames();
    const ALL_TOOLS_FULL = getAllToolsFullNames();

    // No action = list all tools with status
    if (!action) {
      const allowed = agent.allowedTools;
      const isBypass = !allowed;

      console.log(`\n🔧 Tools for agent: ${id}`);
      console.log(`   Mode: ${isBypass ? "bypass (all allowed)" : `whitelist (${allowed!.length} enabled)`}\n`);

      // SDK Tools
      console.log("SDK Tools:");
      for (const t of SDK_TOOLS) {
        const enabled = isToolEnabled(t, allowed);
        const icon = enabled ? "✓" : "✗";
        const color = enabled ? "\x1b[32m" : "\x1b[90m";
        console.log(`  ${color}${icon}\x1b[0m ${t}`);
      }

      // CLI Tools (auto-discovered)
      console.log("\nCLI Tools:");
      for (const shortName of CLI_TOOL_NAMES) {
        const fullName = `${MCP_PREFIX}${shortName}`;
        const enabled = isToolEnabled(fullName, allowed);
        const icon = enabled ? "✓" : "✗";
        const color = enabled ? "\x1b[32m" : "\x1b[90m";
        console.log(`  ${color}${icon}\x1b[0m ${shortName}`);
      }

      console.log("\nUsage:");
      console.log("  ravi agents tools <id> allow <tool>   # Enable a tool");
      console.log("  ravi agents tools <id> deny <tool>    # Disable a tool");
      console.log("  ravi agents tools <id> init           # Init whitelist with SDK tools");
      console.log("  ravi agents tools <id> init all       # Init with all tools");
      console.log("  ravi agents tools <id> init cli       # Init with CLI tools only");
      console.log("  ravi agents tools <id> clear          # Clear whitelist (bypass mode)");
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
          // Convert short name to full name if needed
          const fullName = toFullToolName(tool);
          addAgentTool(id, fullName);
          console.log(`✓ Tool enabled: ${tool}`);
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
          // Convert short name to full name if needed
          const fullName = toFullToolName(tool);
          removeAgentTool(id, fullName);
          console.log(`✓ Tool disabled: ${tool}`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;

      case "init": {
        // Initialize whitelist with specific category
        let toolsToAdd: string[];
        if (tool === "all") {
          toolsToAdd = ALL_TOOLS_FULL;
        } else if (tool === "cli") {
          toolsToAdd = CLI_TOOLS_FULL;
        } else {
          // Default: SDK tools only
          toolsToAdd = SDK_TOOLS;
        }

        try {
          setAgentTools(id, toolsToAdd);
          console.log(`✓ Whitelist initialized with ${toolsToAdd.length} tools`);
          console.log(`  Category: ${tool || "sdk"}`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;
      }

      case "clear":
        try {
          setAgentTools(id, null);
          console.log(`✓ Whitelist cleared: ${id} (bypass mode)`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        break;

      default:
        console.error(`Unknown action: ${action}`);
        console.log("Actions: allow, deny, init, clear");
        process.exit(1);
    }
  }

  @Command({ name: "debounce", description: "Set message debounce time" })
  debounce(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("ms", { required: false, description: "Debounce time in ms (0 to disable)" }) ms?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    // No ms = show current debounce
    if (ms === undefined) {
      const current = agent.debounceMs;
      if (current && current > 0) {
        console.log(`\nDebounce for agent: ${id}`);
        console.log(`  Time: ${current}ms`);
        console.log(`\nMessages arriving within ${current}ms will be grouped.`);
      } else {
        console.log(`\nDebounce for agent: ${id}`);
        console.log("  Status: disabled");
      }
      console.log("\nUsage:");
      console.log("  ravi agents debounce <id> <ms>   # Set debounce time");
      console.log("  ravi agents debounce <id> 0      # Disable debounce");
      console.log("\nExamples:");
      console.log("  ravi agents debounce main 2000   # Group messages within 2 seconds");
      console.log("  ravi agents debounce main 500    # Group messages within 500ms");
      return;
    }

    const debounceMs = parseInt(ms, 10);
    if (isNaN(debounceMs) || debounceMs < 0) {
      console.error(`Invalid debounce time: ${ms}`);
      console.log("Must be a positive integer (milliseconds) or 0 to disable");
      process.exit(1);
    }

    try {
      setAgentDebounce(id, debounceMs);
      if (debounceMs === 0) {
        console.log(`✓ Debounce disabled: ${id}`);
      } else {
        console.log(`✓ Debounce set: ${id} -> ${debounceMs}ms`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // ============================================================================
  // Agent Interaction Commands
  // ============================================================================

  @Command({ name: "run", description: "Send a prompt to an agent" })
  async run(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("prompt", { description: "Prompt to send" }) prompt: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const sessionKey = `agent:${id}:main`;

    console.log(`\n📤 Sending to ${sessionKey}\n`);
    console.log(`Prompt: ${prompt}\n`);
    console.log("─".repeat(50));

    const chars = await this.sendPrompt(sessionKey, prompt);

    console.log("\n" + "─".repeat(50));
    console.log(`\n✅ Done (${chars} chars)`);
  }

  @Command({ name: "chat", description: "Interactive chat with an agent" })
  async chat(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const sessionKey = `agent:${id}:main`;

    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n🤖 Interactive Chat`);
    console.log(`   Agent: ${id}`);
    console.log(`   Session: ${sessionKey}`);
    console.log(`   Commands: /reset, /session, /exit\n`);

    const ask = () => {
      rl.question(`\x1b[36m${id}>\x1b[0m `, async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          ask();
          return;
        }

        if (trimmed === "/exit" || trimmed === "/quit") {
          console.log("\nBye!");
          rl.close();
          process.exit(0);
        }

        if (trimmed === "/reset") {
          deleteSession(sessionKey);
          console.log("Session reset.\n");
          ask();
          return;
        }

        if (trimmed === "/session") {
          const session = getSession(sessionKey);
          if (session) {
            console.log(`SDK Session: ${session.sdkSessionId || "(none)"}`);
            console.log(`Tokens: ${(session.inputTokens || 0) + (session.outputTokens || 0)}\n`);
          } else {
            console.log("No active session.\n");
          }
          ask();
          return;
        }

        // Send prompt
        console.log();
        await this.sendPrompt(sessionKey, trimmed);
        console.log("\n");
        ask();
      });
    };

    ask();
  }

  /**
   * Send a prompt to an agent session and stream the response.
   * Returns the number of characters received.
   */
  private async sendPrompt(sessionKey: string, prompt: string): Promise<number> {
    let responseLength = 0;

    // Get subscription streams so we can close them
    const claudeStream = notif.subscribe(`ravi.${sessionKey}.claude`);
    const responseStream = notif.subscribe(`ravi.${sessionKey}.response`);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      // Close streams to stop the for-await loops
      claudeStream.close();
      responseStream.close();
    };

    // Promise that resolves on completion or timeout
    const completion = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        console.log("\n⏱️  Timeout");
        resolve();
      }, PROMPT_TIMEOUT_MS);

      // Wait for result event
      (async () => {
        try {
          for await (const event of claudeStream) {
            if ((event.data as Record<string, unknown>).type === "result") {
              resolve();
              break;
            }
          }
        } catch { /* ignore */ }
      })();
    });

    // Stream responses (runs until completion resolves)
    const streaming = (async () => {
      try {
        for await (const event of responseStream) {
          const data = event.data as ResponseMessage;
          if (data.error) {
            console.log(`\n❌ ${data.error}`);
            break;
          }
          if (data.response) {
            process.stdout.write(data.response);
            responseLength += data.response.length;
          }
        }
      } catch { /* ignore */ }
    })();

    // Send prompt
    await notif.emit(`ravi.${sessionKey}.prompt`, { prompt } as unknown as Record<string, unknown>);

    // Wait for completion, then cleanup
    await completion;
    cleanup();

    // Give streaming a moment to finish any pending writes
    await Promise.race([streaming, new Promise(r => setTimeout(r, 100))]);

    return responseLength;
  }

  @Command({ name: "session", description: "Show agent session status" })
  session(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const sessions = getSessionsByAgent(id);

    console.log(`\n📋 Sessions for agent: ${id}\n`);

    if (sessions.length === 0) {
      console.log("  No active sessions");
      console.log(`\n  Start a session with: ravi agents run ${id} "hello"`);
      return;
    }

    for (const session of sessions) {
      const tokens = (session.inputTokens || 0) + (session.outputTokens || 0);
      const updated = new Date(session.updatedAt).toLocaleString();

      console.log(`  ${session.sessionKey}`);
      console.log(`    SDK: ${session.sdkSessionId || "(none)"}`);
      console.log(`    Tokens: ${tokens}`);
      console.log(`    Updated: ${updated}`);
      console.log();
    }
  }

  @Command({ name: "reset", description: "Reset agent session" })
  reset(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("sessionKey", { required: false, description: "Specific session key (default: agent:ID:main)" }) sessionKey?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      console.error(`Agent not found: ${id}`);
      process.exit(1);
    }

    const key = sessionKey || `agent:${id}:main`;
    const deleted = deleteSession(key);

    if (deleted) {
      console.log(`✅ Session reset: ${key}`);
    } else {
      console.log(`ℹ️  No session to reset: ${key}`);
    }
  }
}

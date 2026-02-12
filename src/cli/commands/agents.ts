/**
 * Agents Commands - Agent management CLI
 */

import "reflect-metadata";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
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
  setAgentBashMode,
  setAgentBashConfig,
  addAgentBashAllowlist,
  removeAgentBashAllowlist,
  addAgentBashDenylist,
  removeAgentBashDenylist,
} from "../../router/config.js";
import { DmScopeSchema, BashModeSchema } from "../../router/router-db.js";
import type { BashConfig, BashMode } from "../../bash/types.js";
import { getDefaultAllowlist, getDefaultDenylist } from "../../bash/permissions.js";
import {
  getSession,
  deleteSession,
  getSessionsByAgent,
  getMainSession,
  resolveSession,
} from "../../router/sessions.js";
import {
  SDK_TOOLS,
  getCliToolNames,
  getAllToolNames,
} from "../tool-registry.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  notif.emit("ravi.config.changed", {}).catch(() => {});
}

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
    console.log("  ID              CWD                          TOOLS     BASH");
    console.log("  --------------  ---------------------------  --------  --------");

    for (const agent of agents) {
      const isDefault = agent.id === config.defaultAgent;
      const id = (agent.id + (isDefault ? " *" : "")).padEnd(14);
      const cwd = agent.cwd.padEnd(27);
      const tools = (agent.allowedTools
        ? `[${agent.allowedTools.length}]`
        : "bypass").padEnd(8);
      const bash = agent.bashConfig
        ? `${agent.bashConfig.mode}[${(agent.bashConfig.mode === "allowlist" ? agent.bashConfig.allowlist?.length : agent.bashConfig.denylist?.length) ?? 0}]`
        : "bypass";

      console.log(`  ${id}  ${cwd}  ${tools}  ${bash}`);
    }

    console.log(`\n  Total: ${agents.length} (* = default)`);
  }

  @Command({ name: "show", description: "Show agent details" })
  show(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    const config = loadRouterConfig();

    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const isDefault = agent.id === config.defaultAgent;

    console.log(`\nAgent: ${agent.id}${isDefault ? " (default)" : ""}`);
    console.log(`  Name:          ${agent.name || "-"}`);
    console.log(`  CWD:           ${agent.cwd}`);
    console.log(`  Model:         ${agent.model || "-"}`);
    console.log(`  DM Scope:      ${agent.dmScope || "-"}`);
    console.log(`  Debounce:      ${agent.debounceMs ? `${agent.debounceMs}ms` : "disabled"}`);
    console.log(`  Matrix:        ${agent.matrixAccount || "-"}`);

    if (agent.allowedTools) {
      console.log(`  Allowed Tools: [${agent.allowedTools.length}]`);
      for (const tool of agent.allowedTools) {
        console.log(`    - ${tool}`);
      }
    } else {
      console.log("  Allowed Tools: bypass (all tools)");
    }

    // Bash config
    if (agent.bashConfig) {
      const bash = agent.bashConfig;
      const listCount = bash.mode === "allowlist"
        ? bash.allowlist?.length ?? 0
        : bash.mode === "denylist"
        ? bash.denylist?.length ?? 0
        : 0;
      console.log(`  Bash Mode:     ${bash.mode} [${listCount}]`);
    } else {
      console.log("  Bash Mode:     bypass (all CLIs)");
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
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "delete", description: "Delete an agent" })
  delete(@Arg("id", { description: "Agent ID" }) id: string) {
    try {
      const deleted = deleteAgent(id);
      if (deleted) {
        console.log(`\u2713 Agent deleted: ${id}`);
        emitConfigChanged();
      } else {
        fail(`Agent not found: ${id}`);
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set agent property" })
  async set(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const validKeys = ["name", "cwd", "model", "dmScope", "systemPromptAppend", "matrixAccount", "settingSources"];
    if (!validKeys.includes(key)) {
      fail(`Invalid key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    }

    // Validate dmScope values
    if (key === "dmScope") {
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        fail(`Invalid dmScope: ${value}. Valid scopes: ${DmScopeSchema.options.join(", ")}`);
      }
    }

    // Validate matrixAccount (will be validated in updateAgent, but give better error)
    if (key === "matrixAccount" && value !== "null" && value !== "") {
      const { dbGetMatrixAccount } = await import("../../router/router-db.js");
      const account = dbGetMatrixAccount(value);
      if (!account) {
        fail(`Matrix account not found: ${value}. Run: ravi matrix users-list`);
      }
    }

    // Parse settingSources as JSON array
    let parsedValue: unknown = value;
    if (key === "settingSources") {
      try {
        parsedValue = JSON.parse(value);
        if (!Array.isArray(parsedValue)) {
          fail(`settingSources must be an array, e.g. '["user", "project"]'`);
        }
        const valid = ["user", "project"];
        for (const s of parsedValue) {
          if (!valid.includes(s)) {
            fail(`Invalid settingSource: ${s}. Valid values: ${valid.join(", ")}`);
          }
        }
      } catch {
        fail(`settingSources must be valid JSON array, e.g. '["user", "project"]'`);
      }
    }

    try {
      updateAgent(id, { [key]: parsedValue });
      console.log(`\u2713 ${key} set: ${id} -> ${typeof parsedValue === "string" ? parsedValue : JSON.stringify(parsedValue)}`);
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
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
      fail(`Agent not found: ${id}`);
    }

    // Get CLI tools from registry (lazy init)
    const CLI_TOOL_NAMES = getCliToolNames();
    const ALL_TOOLS = getAllToolNames();

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
      for (const name of CLI_TOOL_NAMES) {
        const enabled = isToolEnabled(name, allowed);
        const icon = enabled ? "✓" : "✗";
        const color = enabled ? "\x1b[32m" : "\x1b[90m";
        console.log(`  ${color}${icon}\x1b[0m ${name}`);
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
          fail("Tool name required. Usage: ravi agents tools <id> allow <tool>");
        }
        try {
          addAgentTool(id, tool);
          console.log(`✓ Tool enabled: ${tool}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;

      case "deny":
        if (!tool) {
          fail("Tool name required. Usage: ravi agents tools <id> deny <tool>");
        }
        try {
          removeAgentTool(id, tool);
          console.log(`✓ Tool disabled: ${tool}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;

      case "init": {
        // Initialize whitelist with specific category
        let toolsToAdd: string[];
        if (tool === "all") {
          toolsToAdd = ALL_TOOLS;
        } else if (tool === "cli") {
          toolsToAdd = [...CLI_TOOL_NAMES];
        } else {
          // Default: SDK tools only
          toolsToAdd = SDK_TOOLS;
        }

        try {
          setAgentTools(id, toolsToAdd);
          console.log(`✓ Whitelist initialized with ${toolsToAdd.length} tools`);
          console.log(`  Category: ${tool || "sdk"}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "clear":
        try {
          setAgentTools(id, null);
          console.log(`✓ Whitelist cleared: ${id} (bypass mode)`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;

      default:
        fail(`Unknown action: ${action}. Actions: allow, deny, init, clear`);
    }
  }

  @Command({ name: "debounce", description: "Set message debounce time" })
  debounce(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("ms", { required: false, description: "Debounce time in ms (0 to disable)" }) ms?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
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
      fail(`Invalid debounce time: ${ms}. Must be a positive integer (ms) or 0 to disable`);
    }

    try {
      setAgentDebounce(id, debounceMs);
      if (debounceMs === 0) {
        console.log(`✓ Debounce disabled: ${id}`);
      } else {
        console.log(`✓ Debounce set: ${id} -> ${debounceMs}ms`);
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "bash", description: "Manage agent bash CLI permissions" })
  bash(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("action", { required: false, description: "Action: mode, allow, deny, remove, init, clear" }) action?: string,
    @Arg("value", { required: false, description: "CLI name(s) or mode value" }) value?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    // No action = show current config
    if (!action) {
      const config = agent.bashConfig;
      const mode = config?.mode ?? "bypass";

      console.log(`\n🛡️  Bash permissions for agent: ${id}`);
      console.log(`   Mode: ${mode}`);

      if (mode === "bypass") {
        console.log("\n   All CLI commands are allowed (no restrictions).");
      } else if (mode === "allowlist") {
        const list = config?.allowlist ?? [];
        console.log(`\n   Allowlist (${list.length} CLIs):`);
        if (list.length === 0) {
          console.log("   (empty - all bash commands will be blocked!)");
        } else {
          for (const cli of list.sort()) {
            console.log(`   ✓ ${cli}`);
          }
        }
      } else if (mode === "denylist") {
        const list = config?.denylist ?? [];
        console.log(`\n   Denylist (${list.length} CLIs):`);
        if (list.length === 0) {
          console.log("   (empty - all bash commands allowed)");
        } else {
          for (const cli of list.sort()) {
            console.log(`   ✗ ${cli}`);
          }
        }
      }

      console.log("\nUsage:");
      console.log("  ravi agents bash <id> mode <mode>     # Set mode (bypass, allowlist, denylist)");
      console.log("  ravi agents bash <id> allow <cli>     # Add CLI to allowlist");
      console.log("  ravi agents bash <id> deny <cli>      # Add CLI to denylist");
      console.log("  ravi agents bash <id> remove <cli>    # Remove CLI from lists");
      console.log("  ravi agents bash <id> init            # Init denylist with dangerous CLIs");
      console.log("  ravi agents bash <id> init strict     # Init allowlist with safe CLIs");
      console.log("  ravi agents bash <id> clear           # Reset to bypass mode");
      return;
    }

    // Handle actions
    switch (action) {
      case "mode": {
        if (!value) {
          fail("Mode required. Usage: ravi agents bash <id> mode <bypass|allowlist|denylist>");
        }
        const result = BashModeSchema.safeParse(value);
        if (!result.success) {
          fail(`Invalid mode: ${value}. Valid modes: bypass, allowlist, denylist`);
        }
        try {
          setAgentBashMode(id, result.data as BashMode);
          console.log(`✓ Bash mode set: ${id} -> ${value}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "allow": {
        if (!value) {
          fail("CLI name required. Usage: ravi agents bash <id> allow <cli>");
        }
        // Ensure mode is allowlist
        if (agent.bashConfig?.mode !== "allowlist") {
          setAgentBashMode(id, "allowlist");
        }
        try {
          addAgentBashAllowlist(id, value);
          console.log(`✓ Added CLI to allowlist: ${value}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "deny": {
        if (!value) {
          fail("CLI name required. Usage: ravi agents bash <id> deny <cli>");
        }
        // Ensure mode is denylist
        if (agent.bashConfig?.mode !== "denylist") {
          setAgentBashMode(id, "denylist");
        }
        try {
          addAgentBashDenylist(id, value);
          console.log(`✓ Added CLI to denylist: ${value}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "remove": {
        if (!value) {
          fail("CLI name required. Usage: ravi agents bash <id> remove <cli>");
        }
        try {
          removeAgentBashAllowlist(id, value);
          removeAgentBashDenylist(id, value);
          console.log(`✓ Removed CLI from lists: ${value}`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "init": {
        try {
          if (value === "strict") {
            // Init with safe allowlist
            const allowlist = getDefaultAllowlist();
            const config: BashConfig = {
              mode: "allowlist",
              allowlist,
            };
            setAgentBashConfig(id, config);
            console.log(`✓ Initialized strict allowlist with ${allowlist.length} safe CLIs`);
            console.log("  Only these CLIs can be executed. Use 'allow' to add more.");
          } else {
            // Init with dangerous denylist
            const denylist = getDefaultDenylist();
            const config: BashConfig = {
              mode: "denylist",
              denylist,
            };
            setAgentBashConfig(id, config);
            console.log(`✓ Initialized denylist with ${denylist.length} dangerous CLIs`);
            console.log("  These CLIs are blocked. Use 'deny' to add more.");
          }
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      case "clear": {
        try {
          setAgentBashMode(id, null);
          console.log(`✓ Bash permissions cleared: ${id} (bypass mode)`);
        } catch (err) {
          fail(`Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      default:
        fail(`Unknown action: ${action}. Actions: mode, allow, deny, remove, init, clear`);
    }
  }

  @Command({ name: "session", description: "Show agent session status" })
  session(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
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

      console.log(`  ${session.name ?? session.sessionKey}`);
      console.log(`    SDK: ${session.sdkSessionId || "(none)"}`);
      console.log(`    Tokens: ${tokens}`);
      console.log(`    Updated: ${updated}`);
      console.log();
    }
  }

  @Command({ name: "reset", description: "Reset agent session" })
  async reset(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("nameOrKey", { required: false, description: "Session name/key, 'all' to reset all, or omit for main" }) nameOrKey?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    // Helper: abort SDK session + delete from DB
    const resetOne = async (key: string, name?: string): Promise<boolean> => {
      // Abort SDK streaming session in daemon (use session name for topic)
      if (name) {
        await notif.emit("ravi.session.abort", { sessionName: name, sessionKey: key });
      } else {
        await notif.emit("ravi.session.abort", { sessionKey: key });
      }
      return deleteSession(key);
    };

    // Reset all sessions for this agent
    if (nameOrKey === "all") {
      const sessions = getSessionsByAgent(id);
      if (sessions.length === 0) {
        console.log(`ℹ️  No sessions to reset for agent: ${id}`);
        return;
      }
      let count = 0;
      for (const s of sessions) {
        if (await resetOne(s.sessionKey, s.name)) count++;
      }
      console.log(`✅ Reset ${count} session${count !== 1 ? "s" : ""} for agent: ${id}`);
      return;
    }

    // Resolve by name, or find main session
    let session;
    if (nameOrKey) {
      session = resolveSession(nameOrKey);
    } else {
      session = getMainSession(id);
    }

    if (session) {
      const deleted = await resetOne(session.sessionKey, session.name);
      const label = session.name ?? session.sessionKey;
      if (deleted) {
        console.log(`✅ Session reset: ${label}`);
      } else {
        console.log(`ℹ️  Session already clean: ${label}`);
      }
    } else {
      // Show available sessions as hint
      const sessions = getSessionsByAgent(id);
      if (sessions.length > 0) {
        console.log(`ℹ️  No session found: ${nameOrKey ?? "(main)"}`);
        console.log(`\n  Available sessions for ${id}:`);
        for (const s of sessions) {
          console.log(`    ${s.name ?? s.sessionKey}`);
        }
        console.log(`\n  Usage:`);
        console.log(`    ravi agents reset ${id} <name>   Reset specific session`);
        console.log(`    ravi agents reset ${id} all      Reset all sessions`);
      } else {
        console.log(`ℹ️  No sessions to reset for agent: ${id}`);
      }
    }
  }

  @Command({ name: "debug", description: "Show last turns of an agent session (what it received, what it responded)" })
  debug(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("nameOrKey", { required: false, description: "Session name/key (omit for main)" }) nameOrKey?: string,
    @Option({ flags: "-n, --turns <count>", description: "Number of recent turns to show (default: 5)" }) turnsStr?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    let session;
    if (nameOrKey) {
      session = resolveSession(nameOrKey);
    } else {
      session = getMainSession(id);
    }

    if (!session) {
      console.log(`ℹ️  No session found: ${nameOrKey ?? "(main)"}`);
      const sessions = getSessionsByAgent(id);
      if (sessions.length > 0) {
        console.log(`\n  Available sessions for ${id}:`);
        for (const s of sessions) {
          console.log(`    ${s.name ?? s.sessionKey}`);
        }
      }
      return;
    }

    const maxTurns = parseInt(turnsStr ?? "5", 10);

    // Session metadata
    console.log(`\n🔍 Debug: ${session.name ?? session.sessionKey}\n`);
    console.log(`  Agent:       ${session.agentId}`);
    console.log(`  CWD:         ${session.agentCwd}`);
    console.log(`  SDK ID:      ${session.sdkSessionId ?? "(none)"}`);
    console.log(`  Channel:     ${session.lastChannel ?? "-"} → ${session.lastTo ?? "-"}`);
    console.log(`  Tokens:      in=${session.inputTokens} out=${session.outputTokens} total=${session.totalTokens} ctx=${session.contextTokens}`);
    console.log(`  Compactions:  ${session.compactionCount}`);
    console.log(`  Created:     ${new Date(session.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(session.updatedAt).toLocaleString()}`);

    // Try to read SDK session transcript
    if (!session.sdkSessionId) {
      console.log(`\n  ⚠️  No SDK session ID — cannot read transcript`);
      return;
    }

    // SDK stores sessions at ~/.claude/projects/-{escaped-cwd}/{sdkSessionId}.jsonl
    const escapedCwd = session.agentCwd.replace(/\//g, "-");
    const jsonlPath = `${homedir()}/.claude/projects/${escapedCwd}/${session.sdkSessionId}.jsonl`;

    if (!existsSync(jsonlPath)) {
      console.log(`\n  ⚠️  Transcript not found: ${jsonlPath}`);
      return;
    }

    // Read and parse JSONL
    const raw = readFileSync(jsonlPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    // Extract user/assistant turns
    interface Turn {
      type: string;
      timestamp: string;
      text?: string;
      toolUse?: string;
    }

    const turns: Turn[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const content = typeof entry.message.content === "string"
            ? entry.message.content
            : JSON.stringify(entry.message.content).slice(0, 200);
          turns.push({
            type: "user",
            timestamp: entry.timestamp ?? "",
            text: content.slice(0, 300),
          });
        } else if (entry.type === "assistant" && entry.message?.content) {
          const parts = entry.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
          const textParts = parts.filter((p: { type: string }) => p.type === "text").map((p: { text?: string }) => p.text ?? "");
          const toolParts = parts.filter((p: { type: string }) => p.type === "tool_use").map((p: { name?: string; input?: unknown }) => `${p.name}(${JSON.stringify(p.input).slice(0, 100)})`);

          turns.push({
            type: "assistant",
            timestamp: entry.timestamp ?? "",
            text: textParts.join(" ").slice(0, 300) || undefined,
            toolUse: toolParts.join(", ").slice(0, 200) || undefined,
          });
        }
      } catch {
        // skip malformed lines
      }
    }

    // Show last N turns
    const recent = turns.slice(-maxTurns * 2); // user+assistant pairs
    console.log(`\n  📋 Last ${Math.min(recent.length, maxTurns * 2)} entries (of ${turns.length} total):\n`);

    for (const turn of recent) {
      const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : "";
      const prefix = turn.type === "user" ? "  👤 USER" : "  🤖 ASST";

      if (turn.text) {
        console.log(`${prefix} [${time}] ${turn.text}`);
      }
      if (turn.toolUse) {
        console.log(`${prefix} [${time}] 🔧 ${turn.toolUse}`);
      }
    }

    console.log();
  }
}

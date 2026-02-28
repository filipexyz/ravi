/**
 * Agents Commands - Agent management CLI
 */

import "reflect-metadata";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { getScopeContext, filterVisibleAgents, canViewAgent } from "../../permissions/scope.js";
import { nats } from "../../nats.js";
import {
  getAgent,
  getAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentDebounce,
  ensureAgentDirs,
  loadRouterConfig,
  setAgentSpecMode,
} from "../../router/config.js";
import { DmScopeSchema } from "../../router/router-db.js";
import {
  deleteSession,
  getSessionsByAgent,
  getMainSession,
  resolveSession,
} from "../../router/sessions.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

@Group({
  name: "agents",
  description: "Agent management",
})
export class AgentsCommands {
  @Command({ name: "list", description: "List all agents" })
  list() {
    const ctx = getScopeContext();
    const agents = filterVisibleAgents(ctx, getAllAgents());
    const config = loadRouterConfig();

    if (agents.length === 0) {
      console.log("No agents configured.");
      console.log("\nCreate an agent: ravi agents create <id> <cwd>");
      return;
    }

    console.log("\nAgents:\n");
    console.log("  ID              CWD");
    console.log("  --------------  ---------------------------");

    for (const agent of agents) {
      const isDefault = agent.id === config.defaultAgent;
      const id = (agent.id + (isDefault ? " *" : "")).padEnd(14);
      const cwd = agent.cwd;

      console.log(`  ${id}  ${cwd}`);
    }

    console.log(`\n  Total: ${agents.length} (* = default)`);
  }

  @Command({ name: "show", description: "Show agent details" })
  show(@Arg("id", { description: "Agent ID" }) id: string) {
    const ctx = getScopeContext();
    if (!canViewAgent(ctx, id)) {
      fail(`Agent not found: ${id}`);
    }
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
    console.log(`  Mode:          ${agent.mode ?? "active"}`);
    console.log(`  Debounce:      ${agent.debounceMs ? `${agent.debounceMs}ms` : "disabled"}`);
    console.log(`  Group Debounce:${agent.groupDebounceMs ? ` ${agent.groupDebounceMs}ms` : " -"}`);
    console.log(`  Matrix:        ${agent.matrixAccount || "-"}`);

    console.log(`  Spec Mode:     ${agent.specMode ? "enabled" : "disabled"}`);
    console.log(`  Permissions:   ravi permissions list --subject agent:${agent.id}`);

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
      console.log(`  Permissions: closed (no tools, no executables)`);
      console.log(`  Use 'ravi permissions init agent:${id} full-access' to configure`);
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

    const validKeys = ["name", "cwd", "model", "dmScope", "systemPromptAppend", "matrixAccount", "settingSources", "mode", "groupDebounceMs"];
    if (!validKeys.includes(key)) {
      fail(`Invalid key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    }

    // Parse groupDebounceMs as integer
    if (key === "groupDebounceMs") {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed < 0) {
        fail(`Invalid groupDebounceMs: ${value}. Must be a positive integer (ms) or 0 to disable`);
      }
      try {
        updateAgent(id, { groupDebounceMs: parsed === 0 ? undefined : parsed });
        console.log(parsed === 0 ? `\u2713 groupDebounceMs disabled: ${id}` : `\u2713 groupDebounceMs set: ${id} -> ${parsed}ms`);
        emitConfigChanged();
      } catch (err) {
        fail(`Error: ${err instanceof Error ? err.message : err}`);
      }
      return;
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

    // Validate mode values
    if (key === "mode") {
      if (value !== "active" && value !== "sentinel") {
        fail(`Invalid mode: ${value}. Valid modes: active, sentinel`);
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

  @Command({ name: "spec-mode", description: "Enable or disable spec mode for an agent" })
  specMode(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("enabled", { required: false, description: "true/false" }) enabled?: string
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    if (enabled === undefined) {
      console.log(`\nSpec mode for agent: ${id}`);
      console.log(`  Status: ${agent.specMode ? "enabled" : "disabled"}`);
      console.log("\nUsage:");
      console.log("  ravi agents spec-mode <id> true    # Enable spec mode");
      console.log("  ravi agents spec-mode <id> false   # Disable spec mode");
      return;
    }

    if (enabled !== "true" && enabled !== "false") {
      fail(`Invalid value: ${enabled}. Must be 'true' or 'false'`);
    }

    const value = enabled === "true";
    try {
      setAgentSpecMode(id, value);
      console.log(`✓ Spec mode ${value ? "enabled" : "disabled"}: ${id}`);
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
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
        await nats.emit("ravi.session.abort", { sessionName: name, sessionKey: key });
      } else {
        await nats.emit("ravi.session.abort", { sessionKey: key });
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

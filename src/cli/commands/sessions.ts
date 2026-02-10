/**
 * Session Commands - manage agent sessions
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  listSessions,
  getSession,
  getSessionsByAgent,
  deleteSession,
  updateSessionDisplayName,
  updateSessionModelOverride,
  updateSessionThinkingLevel,
} from "../../router/sessions.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

@Group({
  name: "sessions",
  description: "Manage agent sessions",
})
export class SessionCommands {
  @Command({ name: "list", description: "List all sessions" })
  list(
    @Option({ flags: "--agent <id>", description: "Filter by agent ID" }) agentId?: string
  ) {
    const sessions = agentId ? getSessionsByAgent(agentId) : listSessions();

    if (sessions.length === 0) {
      console.log(agentId ? `No sessions for agent: ${agentId}` : "No sessions found.");
      return { sessions: [], total: 0 };
    }

    const label = agentId ? `Sessions for ${agentId}` : "All sessions";
    console.log(`\n${label} (${sessions.length}):\n`);
    console.log("  SESSION KEY                                          AGENT     TOKENS    MODEL      NAME");
    console.log("  ───────────────────────────────────────────────────  ────────  ────────  ─────────  ──────────────────");

    for (const s of sessions) {
      const key = s.sessionKey.padEnd(51);
      const agent = (s.agentId ?? "-").padEnd(8);
      const tokens = formatTokens(s.totalTokens ?? 0).padStart(8);
      const model = (s.modelOverride ?? "-").padEnd(9);
      const name = s.displayName ?? s.lastTo ?? "-";
      console.log(`  ${key}  ${agent}  ${tokens}  ${model}  ${name}`);
    }

    console.log();
    return { sessions, total: sessions.length };
  }

  @Command({ name: "info", description: "Show session details" })
  info(@Arg("sessionKey", { description: "Session key" }) sessionKey: string) {
    const s = getSession(sessionKey);
    if (!s) {
      fail(`Session not found: ${sessionKey}`);
      return;
    }

    console.log(`\nSession:     ${s.sessionKey}`);
    console.log(`Name:        ${s.displayName ?? "(none)"}`);
    console.log(`Agent:       ${s.agentId}`);
    console.log(`Model:       ${s.modelOverride ?? "(agent default)"}`);
    console.log(`Thinking:    ${s.thinkingLevel ?? "(default)"}`);
    console.log(`SDK ID:      ${s.sdkSessionId ?? "(none)"}`);
    console.log(`Tokens:      input=${formatTokens(s.inputTokens ?? 0)} output=${formatTokens(s.outputTokens ?? 0)} total=${formatTokens(s.totalTokens ?? 0)} context=${formatTokens(s.contextTokens ?? 0)}`);

    if (s.lastChannel || s.lastTo) {
      const routing = [s.lastChannel, s.lastTo].filter(Boolean).join(" -> ");
      const account = s.lastAccountId ? ` (account: ${s.lastAccountId})` : "";
      console.log(`Channel:     ${routing}${account}`);
    }

    console.log(`Queue:       ${s.queueMode ?? "(default)"}${s.queueDebounceMs ? ` debounce=${s.queueDebounceMs}ms` : ""}${s.queueCap ? ` cap=${s.queueCap}` : ""}`);
    console.log(`Compactions: ${s.compactionCount ?? 0}`);
    console.log(`Created:     ${formatDate(s.createdAt)}`);
    console.log(`Updated:     ${formatDate(s.updatedAt)}`);
    console.log();

    return s;
  }

  @Command({ name: "rename", description: "Set session display name" })
  rename(
    @Arg("sessionKey", { description: "Session key" }) sessionKey: string,
    @Arg("name", { description: "Display name" }) name: string
  ) {
    const s = getSession(sessionKey);
    if (!s) {
      fail(`Session not found: ${sessionKey}`);
      return;
    }

    updateSessionDisplayName(sessionKey, name);
    console.log(`Renamed: ${sessionKey} -> "${name}"`);
  }

  @Command({ name: "set-model", description: "Set session model override" })
  setModel(
    @Arg("sessionKey", { description: "Session key" }) sessionKey: string,
    @Arg("model", { description: "Model name (sonnet, opus, haiku) or 'clear' to remove override" }) model: string
  ) {
    const s = getSession(sessionKey);
    if (!s) {
      fail(`Session not found: ${sessionKey}`);
      return;
    }

    if (model === "clear") {
      updateSessionModelOverride(sessionKey, null);
      console.log(`Cleared model override for: ${sessionKey}`);
    } else {
      updateSessionModelOverride(sessionKey, model);
      console.log(`Set model to "${model}" for: ${sessionKey}`);
    }

    console.log("Note: takes effect on next session start (reset or daemon restart).");
  }

  @Command({ name: "set-thinking", description: "Set session thinking level" })
  setThinking(
    @Arg("sessionKey", { description: "Session key" }) sessionKey: string,
    @Arg("level", { description: "Thinking level (off, normal, verbose) or 'clear'" }) level: string
  ) {
    const s = getSession(sessionKey);
    if (!s) {
      fail(`Session not found: ${sessionKey}`);
      return;
    }

    const valid = ["off", "normal", "verbose", "clear"];
    if (!valid.includes(level)) {
      fail(`Invalid thinking level: ${level}. Must be one of: ${valid.join(", ")}`);
      return;
    }

    if (level === "clear") {
      updateSessionThinkingLevel(sessionKey, null);
      console.log(`Cleared thinking level for: ${sessionKey}`);
    } else {
      updateSessionThinkingLevel(sessionKey, level);
      console.log(`Set thinking to "${level}" for: ${sessionKey}`);
    }

    console.log("Note: takes effect on next session start (reset or daemon restart).");
  }

  @Command({ name: "reset", description: "Reset a session (fresh start)" })
  reset(@Arg("sessionKey", { description: "Session key" }) sessionKey: string) {
    const s = getSession(sessionKey);
    if (!s) {
      fail(`Session not found: ${sessionKey}`);
      return;
    }

    deleteSession(sessionKey);
    console.log(`Session reset: ${sessionKey}`);
    console.log("Next message will start a fresh conversation.");
  }

  @Command({ name: "reset-all", description: "Reset all sessions for an agent" })
  resetAll(@Arg("agentId", { description: "Agent ID" }) agentId: string) {
    const sessions = getSessionsByAgent(agentId);

    if (sessions.length === 0) {
      console.log(`No sessions to reset for agent: ${agentId}`);
      return;
    }

    let count = 0;
    for (const s of sessions) {
      if (deleteSession(s.sessionKey)) count++;
    }

    console.log(`Reset ${count} session${count !== 1 ? "s" : ""} for agent: ${agentId}`);
  }
}

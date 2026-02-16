/**
 * Session Commands - manage agent sessions
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { notif } from "../../notif.js";
import {
  listSessions,
  getSession,
  getSessionsByAgent,
  deleteSession,
  resetSession,
  resolveSession,
  getOrCreateSession,
  findSessionByChatId,
  updateSessionDisplayName,
  updateSessionModelOverride,
  updateSessionThinkingLevel,
  setSessionEphemeral,
  extendSession,
  makeSessionPermanent,
} from "../../router/sessions.js";
import { deriveSourceFromSessionKey } from "../../router/session-key.js";
import { loadRouterConfig, expandHome } from "../../router/index.js";
import type { ResponseMessage, ChannelContext } from "../../bot.js";
import type { SessionEntry } from "../../router/types.js";
import {
  getScopeContext,
  isScopeEnforced,
  canAccessSession,
  canModifySession,
  filterAccessibleSessions,
} from "../../permissions/scope.js";

const SEND_TIMEOUT_MS = 120000; // 2 minutes

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function parseDurationMs(str: string): number | null {
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m" || unit === "min") return value * 60_000;
  if (unit === "h" || unit === "hr") return value * 3_600_000;
  if (unit === "d") return value * 86_400_000;
  return null;
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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

@Group({
  name: "sessions",
  description: "Manage agent sessions",
  scope: "open",
})
export class SessionCommands {
  @Command({ name: "list", description: "List all sessions" })
  list(
    @Option({ flags: "--agent <id>", description: "Filter by agent ID" }) agentId?: string,
    @Option({ flags: "--ephemeral", description: "Show only ephemeral sessions" }) ephemeralOnly?: boolean
  ) {
    let sessions = agentId ? getSessionsByAgent(agentId) : listSessions();

    // Scope isolation: filter to accessible sessions only
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      sessions = filterAccessibleSessions(scopeCtx, sessions);
    }

    if (ephemeralOnly) {
      sessions = sessions.filter(s => s.ephemeral);
    }

    if (sessions.length === 0) {
      console.log(agentId ? `No sessions for agent: ${agentId}` : "No sessions found.");
      return { sessions: [], total: 0 };
    }

    const label = agentId ? `Sessions for ${agentId}` : ephemeralOnly ? "Ephemeral sessions" : "All sessions";
    console.log(`\n${label} (${sessions.length}):\n`);

    if (ephemeralOnly) {
      console.log("  NAME                                  AGENT     EXPIRES AT          DISPLAY");
      console.log("  ────────────────────────────────────  ────────  ──────────────────  ──────────────────");

      for (const s of sessions) {
        const name = (s.name ?? s.sessionKey).padEnd(38);
        const agent = (s.agentId ?? "-").padEnd(8);
        const expires = s.expiresAt ? formatDate(s.expiresAt).padEnd(18) : "never".padEnd(18);
        const display = s.displayName ?? s.lastTo ?? "-";
        console.log(`  ${name}  ${agent}  ${expires}  ${display}`);
      }
    } else {
      console.log("  NAME                                  AGENT     TOKENS    ACTIVITY   TYPE       EXPIRES             DISPLAY");
      console.log("  ────────────────────────────────────  ────────  ────────  ─────────  ─────────  ──────────────────  ──────────────────");

      for (const s of sessions) {
        const ephTag = s.ephemeral ? "⏳" : "  ";
        const name = (s.name ?? s.sessionKey).padEnd(36);
        const agent = (s.agentId ?? "-").padEnd(8);
        const tokens = formatTokens(s.totalTokens ?? 0).padStart(8);
        const activity = timeAgo(s.updatedAt).padEnd(9);
        const type = (s.ephemeral ? "ephemeral" : "permanent").padEnd(9);
        const expires = s.ephemeral && s.expiresAt ? formatDate(s.expiresAt).padEnd(18) : "-".padEnd(18);
        const display = s.displayName ?? s.lastTo ?? "-";
        console.log(`${ephTag}${name}  ${agent}  ${tokens}  ${activity}  ${type}  ${expires}  ${display}`);
      }
    }

    console.log();
    return { sessions, total: sessions.length };
  }

  @Command({ name: "info", description: "Show session details" })
  info(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only accessible sessions
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canAccessSession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    console.log(`\nSession:     ${s.name ?? s.sessionKey}`);
    console.log(`Key:         ${s.sessionKey}`);
    console.log(`Display:     ${s.displayName ?? "(none)"}`);
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

    if (s.ephemeral) {
      const expiresStr = s.expiresAt ? formatDate(s.expiresAt) : "unknown";
      const remaining = s.expiresAt ? Math.max(0, Math.round((s.expiresAt - Date.now()) / 60_000)) : 0;
      console.log(`Ephemeral:   ⏳ yes — expires ${expiresStr} (${remaining}min left)`);
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
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("displayName", { description: "Display name" }) displayName: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    updateSessionDisplayName(s.sessionKey, displayName);
    console.log(`Renamed: ${s.name ?? s.sessionKey} -> "${displayName}"`);
  }

  @Command({ name: "set-model", description: "Set session model override" })
  setModel(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("model", { description: "Model name (sonnet, opus, haiku) or 'clear' to remove override" }) model: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    const label = s.name ?? s.sessionKey;
    if (model === "clear") {
      updateSessionModelOverride(s.sessionKey, null);
      console.log(`Cleared model override for: ${label}`);
    } else {
      updateSessionModelOverride(s.sessionKey, model);
      console.log(`Set model to "${model}" for: ${label}`);
    }

    console.log("Note: takes effect on next session start (reset or daemon restart).");
  }

  @Command({ name: "set-thinking", description: "Set session thinking level" })
  setThinking(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("level", { description: "Thinking level (off, normal, verbose) or 'clear'" }) level: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    const valid = ["off", "normal", "verbose", "clear"];
    if (!valid.includes(level)) {
      fail(`Invalid thinking level: ${level}. Must be one of: ${valid.join(", ")}`);
      return;
    }

    const label = s.name ?? s.sessionKey;
    if (level === "clear") {
      updateSessionThinkingLevel(s.sessionKey, null);
      console.log(`Cleared thinking level for: ${label}`);
    } else {
      updateSessionThinkingLevel(s.sessionKey, level);
      console.log(`Set thinking to "${level}" for: ${label}`);
    }

    console.log("Note: takes effect on next session start (reset or daemon restart).");
  }

  @Command({ name: "reset", description: "Reset a session (fresh start)" })
  async reset(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Abort active SDK subprocess so it doesn't keep the old context
    try {
      await notif.emit("ravi.session.abort", {
        sessionKey: s.sessionKey,
        sessionName: s.name,
      });
    } catch { /* session may not be active */ }

    resetSession(s.sessionKey);
    console.log(`Session reset: ${s.name ?? s.sessionKey}`);
    console.log("Next message will start a fresh conversation.");
  }

  @Command({ name: "delete", description: "Delete a session permanently" })
  async delete(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Abort SDK subprocess first
    try {
      await notif.emit("ravi.session.abort", {
        sessionKey: s.sessionKey,
        sessionName: s.name,
      });
    } catch { /* session may not be active */ }

    deleteSession(s.sessionKey);
    console.log(`🗑️ Session deleted: ${s.name ?? s.sessionKey}`);
  }

  // ===========================================================================
  // Ephemeral Commands
  // ===========================================================================

  @Command({ name: "set-ttl", description: "Make a session ephemeral with a TTL" })
  setTtl(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("duration", { description: "TTL duration (e.g. 5h, 30m, 1d)" }) duration: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    const ttlMs = parseDurationMs(duration);
    if (!ttlMs) {
      fail(`Invalid duration: ${duration}. Use format like 5h, 30m, 1d`);
      return;
    }

    setSessionEphemeral(s.sessionKey, ttlMs);
    const expiresAt = new Date(Date.now() + ttlMs);
    console.log(`⏳ Session "${s.name ?? s.sessionKey}" is now ephemeral.`);
    console.log(`   Expires: ${formatDate(expiresAt.getTime())}`);
  }

  @Command({ name: "extend", description: "Extend an ephemeral session's TTL" })
  extend(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("duration", { description: "Duration to add (default: 5h)", required: false }) duration?: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    if (!s.ephemeral) {
      fail(`Session "${s.name ?? s.sessionKey}" is not ephemeral.`);
      return;
    }

    const ttlMs = parseDurationMs(duration ?? "5h");
    if (!ttlMs) {
      fail(`Invalid duration: ${duration}. Use format like 5h, 30m, 1d`);
      return;
    }

    extendSession(nameOrKey, ttlMs);
    const newExpiry = Math.max(s.expiresAt ?? Date.now(), Date.now()) + ttlMs;
    console.log(`⏳ Extended "${s.name ?? s.sessionKey}" by ${duration ?? "5h"}.`);
    console.log(`   New expiry: ${formatDate(newExpiry)}`);
  }

  @Command({ name: "keep", description: "Make an ephemeral session permanent" })
  keep(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string
  ) {
    const s = resolveSession(nameOrKey);
    if (!s) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    // Scope: only own session can be modified
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
      fail(`Session not found: ${nameOrKey}`);
      return;
    }

    if (!s.ephemeral) {
      console.log(`Session "${s.name ?? s.sessionKey}" is already permanent.`);
      return;
    }

    makeSessionPermanent(nameOrKey);
    console.log(`✅ Session "${s.name ?? s.sessionKey}" is now permanent.`);
  }

  // ===========================================================================
  // Messaging Commands
  // ===========================================================================

  @Command({ name: "send", description: "Send a prompt to a session (use -i for interactive)" })
  async send(
    @Arg("nameOrKey", { description: "Session name" }) nameOrKey: string,
    @Arg("prompt", { description: "Prompt to send (omit for interactive mode)", required: false }) prompt?: string,
    @Option({ flags: "-i, --interactive", description: "Interactive mode" }) interactive?: boolean,
    @Option({ flags: "-a, --agent <id>", description: "Agent to use when creating a new session" }) agentId?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string
  ) {
    const session = this.resolveTarget(nameOrKey, agentId);
    if (!session) return;

    const sessionName = session.name ?? nameOrKey;

    // Self-send check
    const currentSession = getContext()?.sessionKey;
    if (currentSession && currentSession === sessionName) {
      fail(`Cannot send to same session (${sessionName}) - would cause deadlock`);
      return;
    }

    if (interactive || !prompt) {
      return this.interactiveMode(sessionName, session, channel, to);
    }

    console.log(`\n📤 Sending to ${sessionName}\n`);
    console.log(`Prompt: ${prompt}\n`);
    console.log("─".repeat(50));

    const chars = await this.streamToSession(sessionName, prompt, session, channel, to);

    console.log("\n" + "─".repeat(50));
    console.log(`\n✅ Done (${chars} chars)`);
  }

  @Command({ name: "ask", description: "Ask a question to another session (fire-and-forget)" })
  async ask(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Question to ask" }) message: string,
    @Arg("sender", { required: false, description: "Who originally asked (for attribution)" }) sender?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const origin = getContext()?.sessionKey ?? "unknown";
    const senderTag = sender ? `, sender: ${sender}` : "";
    const prompt = `[System] Ask: [from: ${origin}${senderTag}] ${message}\n(If you already know the answer, send it back immediately with: ravi sessions answer ${origin} "answer" "${sender ?? ""}" — no need to ask in the chat. Otherwise, your text output IS the message sent to the chat — just write the question directly, don't describe what you're doing. When you get answers, send each one back with: ravi sessions answer ${origin} "answer" "${sender ?? ""}". You can call answer multiple times as new info comes in. IMPORTANT: Don't consider the ask "done" after the first reply — if the person keeps adding details, context, or follow-ups, send another answer with the new info each time. Only forward messages related to this question — ignore unrelated conversation.)`;

    await this.emitToSession(session.name ?? target, prompt, session, channel, to);
    console.log(`✓ [ask] sent to ${session.name ?? target}`);
  }

  @Command({ name: "answer", description: "Answer a question from another session (fire-and-forget)" })
  async answer(
    @Arg("target", { description: "Target session name (the one that asked)" }) target: string,
    @Arg("message", { description: "Answer to send back" }) message: string,
    @Arg("sender", { required: false, description: "Who is answering (for attribution)" }) sender?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const origin = getContext()?.sessionKey ?? "unknown";
    const senderTag = sender ? `, sender: ${sender}` : "";
    const prompt = `[System] Answer: [from: ${origin}${senderTag}] ${message}`;

    await this.emitToSession(session.name ?? target, prompt, session, channel, to);
    console.log(`✓ [answer] sent to ${session.name ?? target}`);
  }

  @Command({ name: "execute", description: "Send an execute command to another session (fire-and-forget)" })
  async execute(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Task to execute" }) message: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const prompt = `[System] Execute: ${message}`;

    await this.emitToSession(session.name ?? target, prompt, session, channel, to);
    console.log(`✓ [execute] sent to ${session.name ?? target}`);
  }

  @Command({ name: "inform", description: "Send an informational message to another session (fire-and-forget)" })
  async inform(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Information to send" }) message: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const prompt = `[System] Inform: ${message}`;

    await this.emitToSession(session.name ?? target, prompt, session, channel, to);
    console.log(`✓ [inform] sent to ${session.name ?? target}`);
  }

  @Command({ name: "read", description: "Read message history of a session (normalized)" })
  read(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Option({ flags: "-n, --count <count>", description: "Number of messages to show (default: 20)" }) countStr?: string
  ) {
    const session = this.resolveTarget(nameOrKey);
    if (!session) return;

    if (!session.sdkSessionId) {
      console.log("⚠️  No SDK session — no history available");
      return;
    }

    const { homedir } = require("os");
    const { existsSync, readFileSync } = require("fs");

    const escapedCwd = (session.agentCwd ?? "").replace(/\//g, "-");
    const jsonlPath = `${homedir()}/.claude/projects/${escapedCwd}/${session.sdkSessionId}.jsonl`;

    if (!existsSync(jsonlPath)) {
      console.log("⚠️  Transcript not found");
      return;
    }

    const maxMessages = parseInt(countStr ?? "20", 10);
    const raw = readFileSync(jsonlPath, "utf-8") as string;
    const lines = raw.trim().split("\n").filter(Boolean);

    interface Message {
      role: string;
      text: string;
      time: string;
    }

    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "user" && entry.message?.content) {
          const content = typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((p: { type: string }) => p.type === "text")
                  .map((p: { text?: string }) => p.text ?? "")
                  .join(" ")
              : "";
          if (!content.trim()) continue;
          messages.push({
            role: "user",
            text: content.trim(),
            time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "",
          });
        } else if (entry.type === "assistant" && entry.message?.content) {
          const parts = entry.message.content as Array<{ type: string; text?: string }>;
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(" ")
            .trim();
          if (!text || text === "@@SILENT@@") continue;
          messages.push({
            role: "assistant",
            text,
            time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "",
          });
        }
      } catch {
        // skip malformed
      }
    }

    const recent = messages.slice(-maxMessages);
    console.log(`\n💬 ${session.name ?? nameOrKey} — last ${recent.length} of ${messages.length} messages\n`);

    for (const msg of recent) {
      const who = msg.role === "user" ? "👤" : "🤖";
      const timeStr = msg.time ? ` [${msg.time}]` : "";
      console.log(`${who}${timeStr} ${msg.text}\n`);
    }
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Resolve a target session by name, key, or chatId. Optionally create with -a.
   */
  private resolveTarget(nameOrKey: string, createWithAgent?: string): SessionEntry | null {
    let session = resolveSession(nameOrKey);

    // Try chatId lookup
    if (!session) {
      const match = findSessionByChatId(nameOrKey);
      if (match) session = match;
    }

    // Scope isolation: verify access (use generic "not found" to prevent enumeration)
    if (session) {
      const scopeCtx = getScopeContext();
      if (isScopeEnforced(scopeCtx)) {
        const sessionName = session.name ?? session.sessionKey;
        if (!canAccessSession(scopeCtx, sessionName)) {
          fail(`Session not found: ${nameOrKey}`);
          return null;
        }
      }
    }

    if (!session) {
      if (!createWithAgent) {
        fail(`Session not found: ${nameOrKey}. Use -a <agent> to create it.`);
        return null;
      }

      // Scope: verify the caller can access sessions with this name pattern
      const scopeCtx = getScopeContext();
      if (isScopeEnforced(scopeCtx) && !canAccessSession(scopeCtx, nameOrKey)) {
        fail(`Session not found: ${nameOrKey}`);
        return null;
      }

      const config = loadRouterConfig();
      const agent = config.agents[createWithAgent];
      if (!agent) {
        fail(`Agent not found: ${createWithAgent}`);
        return null;
      }

      const agentCwd = expandHome(agent.cwd);
      getOrCreateSession(nameOrKey, createWithAgent, agentCwd, { name: nameOrKey });
      console.log(`Created session: ${nameOrKey} (agent: ${createWithAgent})`);
      session = resolveSession(nameOrKey);
    }

    return session ?? null;
  }

  /**
   * Resolve source (delivery routing) from session, with optional overrides.
   */
  private resolveSource(
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string
  ): { source?: { channel: string; accountId: string; chatId: string }; context?: ChannelContext } {
    let source: { channel: string; accountId: string; chatId: string } | undefined;
    let context: ChannelContext | undefined;

    if (channelOverride && toOverride) {
      source = { channel: channelOverride, accountId: "default", chatId: toOverride };
    } else if (session.lastChannel && session.lastTo) {
      source = {
        channel: session.lastChannel,
        accountId: session.lastAccountId ?? "default",
        chatId: session.lastTo,
      };
    } else {
      const derived = deriveSourceFromSessionKey(session.sessionKey);
      if (derived) source = derived;
    }

    if (session.lastContext) {
      try { context = JSON.parse(session.lastContext) as ChannelContext; } catch { /* ignore */ }
    }

    return { source, context };
  }

  /**
   * Fire-and-forget emit to a session (for ask/answer/execute/inform).
   */
  private async emitToSession(
    sessionName: string,
    prompt: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string
  ): Promise<void> {
    const { source, context } = this.resolveSource(session, channelOverride, toOverride);
    await notif.emit(`ravi.session.${sessionName}.prompt`, { prompt, source, context } as Record<string, unknown>);
  }

  /**
   * Send a prompt to a session and stream the response.
   */
  private async streamToSession(
    sessionName: string,
    prompt: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string
  ): Promise<number> {
    let responseLength = 0;

    const claudeStream = notif.subscribe(`ravi.session.${sessionName}.claude`);
    const responseStream = notif.subscribe(`ravi.session.${sessionName}.response`);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      claudeStream.close();
      responseStream.close();
    };

    const completion = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        console.log("\n⏱️  Timeout");
        resolve();
      }, SEND_TIMEOUT_MS);

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

    const { source, context } = this.resolveSource(session, channelOverride, toOverride);
    await notif.emit(`ravi.session.${sessionName}.prompt`, { prompt, source, context } as Record<string, unknown>);

    await completion;
    cleanup();

    await Promise.race([streaming, new Promise(r => setTimeout(r, 100))]);

    return responseLength;
  }

  private async interactiveMode(
    sessionName: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string
  ): Promise<void> {
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n🤖 Interactive Chat`);
    console.log(`   Session: ${sessionName}`);
    console.log(`   Commands: /reset, /info, /exit\n`);

    const ask = () => {
      rl.question(`\x1b[36m${sessionName}>\x1b[0m `, async (input) => {
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
          const s = resolveSession(sessionName);
          if (s) {
            const scopeCtx = getScopeContext();
            if (isScopeEnforced(scopeCtx) && !canModifySession(scopeCtx, s.name ?? s.sessionKey)) {
              console.log("Permission denied.\n");
            } else {
              resetSession(s.sessionKey);
              console.log("Session reset.\n");
            }
          }
          ask();
          return;
        }

        if (trimmed === "/info") {
          const s = resolveSession(sessionName);
          if (s) {
            console.log(`Session: ${s.name ?? s.sessionKey}`);
            console.log(`SDK Session: ${s.sdkSessionId || "(none)"}`);
            console.log(`Tokens: ${(s.inputTokens || 0) + (s.outputTokens || 0)}\n`);
          } else {
            console.log("No active session.\n");
          }
          ask();
          return;
        }

        console.log();
        await this.streamToSession(sessionName, trimmed, session, channelOverride, toOverride);
        console.log("\n");
        ask();
      });
    };

    ask();
  }
}

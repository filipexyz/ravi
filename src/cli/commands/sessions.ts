/**
 * Session Commands - manage agent sessions
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { DEFAULT_DELIVERY_BARRIER, normalizeDeliveryBarrier, type DeliveryBarrier } from "../../delivery-barriers.js";
import {
  getSessionAdapterDebugSnapshot,
  listSessionAdapters,
  type SessionAdapterDebugSnapshot,
  type SessionAdapterRecord,
} from "../../adapters/index.js";
import {
  listSessions,
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
import { dbListContexts, type ContextRecord } from "../../router/router-db.js";
import type { SessionEntry } from "../../router/types.js";
import { locateRuntimeTranscript } from "../../transcripts.js";
import {
  getScopeContext,
  isScopeEnforced,
  canAccessSession,
  canModifySession,
  filterAccessibleSessions,
} from "../../permissions/scope.js";
import { formatInspectionSection, printInspectionBlock, printInspectionField } from "../inspection-output.js";

const SEND_TIMEOUT_MS = 120000; // 2 minutes
const CONFIG_DB_META = { source: "config-db", freshness: "persisted", via: "router-config" } as const;
const SESSION_DB_META = { source: "session-db", freshness: "persisted" } as const;
const RUNTIME_SNAPSHOT_META = { source: "runtime-snapshot", freshness: "persisted" } as const;
const CONTEXT_DB_META = { source: "context-db", freshness: "persisted" } as const;
const ADAPTER_DB_META = { source: "adapter-db", freshness: "persisted" } as const;
const SESSION_KEY_META = { source: "resolver", freshness: "derived-now", via: "session-key" } as const;
const NEXT_COMMANDS_META = { source: "derived", freshness: "derived-now", via: "session-inspect" } as const;

type StreamTerminalState =
  | { kind: "complete" }
  | { kind: "failed"; error: string }
  | { kind: "interrupted"; error: string }
  | { kind: "timeout" };

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

function extractRuntimeTerminalError(data: Record<string, unknown>): string | undefined {
  const error = data.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

function formatWaitTimeoutError(sessionName: string): string {
  const seconds = Math.round(SEND_TIMEOUT_MS / 1000);
  return `Timed out waiting for response from ${sessionName} after ${seconds}s`;
}

function resolveDeliveryBarrierOptionWithDefault(
  value: string | undefined,
  fallback: DeliveryBarrier,
): DeliveryBarrier {
  const barrier = normalizeDeliveryBarrier(value);
  if (!value) {
    return fallback;
  }
  if (!barrier) {
    throw new Error(`Unknown delivery barrier: ${value}. Use p0, p1, p2, p3 or the named aliases.`);
  }
  return barrier;
}

function trimDebugText(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function formatDebugPayload(topic: string, data: Record<string, unknown>): string {
  if (topic.endsWith(".prompt")) {
    return trimDebugText(typeof data.prompt === "string" ? data.prompt : "");
  }

  if (topic.endsWith(".response")) {
    return trimDebugText(typeof data.response === "string" ? data.response : "");
  }

  if (topic.endsWith(".stream")) {
    return trimDebugText(typeof data.chunk === "string" ? data.chunk : "");
  }

  if (topic.endsWith(".tool")) {
    const event = typeof data.event === "string" ? data.event : "event";
    const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
    const duration =
      typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
        ? ` ${Math.round(data.durationMs)}ms`
        : "";
    const suffix = data.isError === true ? " error" : "";
    return `${toolName} ${event}${duration}${suffix}`.trim();
  }

  if (topic.endsWith(".runtime") || topic.endsWith(".claude")) {
    const type = typeof data.type === "string" ? data.type : "";
    const subtype = typeof data.subtype === "string" ? `.${data.subtype}` : "";
    const status = typeof data.status === "string" ? ` status=${data.status}` : "";
    const error = extractRuntimeTerminalError(data);
    return `${type}${subtype}${status}${error ? ` error=${trimDebugText(error, 80)}` : ""}`.trim();
  }

  if (topic.endsWith(".delivery")) {
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    const emitId = typeof data.emitId === "string" ? data.emitId : "";
    return [messageId && `messageId=${messageId}`, emitId && `emitId=${emitId}`].filter(Boolean).join(" ");
  }

  if (topic === "ravi.approval.request" || topic === "ravi.approval.response") {
    const type = typeof data.type === "string" ? data.type : "approval";
    const approved = typeof data.approved === "boolean" ? ` approved=${data.approved}` : "";
    return `${type}${approved}`;
  }

  return trimDebugText(JSON.stringify(data));
}

function formatDebugLine(topic: string, data: Record<string, unknown>, asJson?: boolean): string {
  const time = new Date().toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (asJson) {
    return JSON.stringify({ time, topic, data });
  }

  const label = topic.replace(/^ravi\./, "");
  const summary = formatDebugPayload(topic, data);
  return summary ? `[${time}] ${label} :: ${summary}` : `[${time}] ${label}`;
}

type AdapterInspectionState = "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";

function stringifyInspectionValue(value: unknown, max = 160): string {
  if (value === null || value === undefined) {
    return "(none)";
  }

  const rendered =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  return rendered.length <= max ? rendered : `${rendered.slice(0, max - 3)}...`;
}

function formatContextStatus(context: ContextRecord): "active" | "expired" | "revoked" {
  if (context.revokedAt && context.revokedAt <= Date.now()) return "revoked";
  if (context.expiresAt && context.expiresAt <= Date.now()) return "expired";
  return "active";
}

function formatContextSource(context: ContextRecord): string | undefined {
  if (!context.source) return undefined;
  const thread = context.source.threadId ? `#${context.source.threadId}` : "";
  return `${context.source.channel}/${context.source.accountId}/${context.source.chatId}${thread}`;
}

function readContextMetadata(context: ContextRecord, key: string): string | undefined {
  const value = context.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatContextInspectionLine(context: ContextRecord): string {
  const parts = [formatContextStatus(context), context.contextId, context.kind, `caps=${context.capabilities.length}`];

  const source = formatContextSource(context);
  if (source) parts.push(`source=${source}`);

  const runtimeProvider = readContextMetadata(context, "runtimeProvider");
  if (runtimeProvider) parts.push(`provider=${runtimeProvider}`);

  const parentContextId = readContextMetadata(context, "parentContextId");
  if (parentContextId) parts.push(`parent=${parentContextId}`);

  const issuedFor = readContextMetadata(context, "issuedFor");
  if (issuedFor) parts.push(`issuedFor=${issuedFor}`);

  const issuanceMode = readContextMetadata(context, "issuanceMode");
  if (issuanceMode) parts.push(`mode=${issuanceMode}`);

  if (context.lastUsedAt) {
    parts.push(`lastUsed=${formatDate(context.lastUsedAt)}`);
  }

  return parts.join(" ");
}

function resolveAdapterInspectionState(
  adapter: SessionAdapterRecord,
  snapshot: SessionAdapterDebugSnapshot | null,
): AdapterInspectionState {
  if (!snapshot) {
    if (adapter.status === "broken") return "dead";
    if (adapter.status === "stopped") return "stopped";
    if (adapter.status === "configured") return "configured";
    return "unbound";
  }

  if (snapshot.lastProtocolError) {
    return "protocol-invalid";
  }

  const bound = Boolean(snapshot.bind.contextId);
  if (!bound) {
    return "unbound";
  }

  if (snapshot.health.state === "running" && adapter.status === "running") {
    return "live";
  }

  if (snapshot.health.state === "broken" || adapter.status === "broken") {
    return "dead";
  }

  if (snapshot.health.state === "stopped") {
    return "stopped";
  }

  return "configured";
}

function formatAdapterInspectionLine(
  adapter: SessionAdapterRecord,
  snapshot: SessionAdapterDebugSnapshot | null,
): string {
  const state = resolveAdapterInspectionState(adapter, snapshot);
  const parts = [adapter.name, state, `transport=${adapter.transport}`];

  parts.push(`status=${adapter.status}`);
  if (snapshot?.health.state) {
    parts.push(`health=${snapshot.health.state}`);
  }

  const contextId = snapshot?.bind.contextId;
  if (contextId) {
    parts.push(`ctx=${contextId}`);
  }

  const cliName = snapshot?.bind.cliName ?? adapter.definition.bindings.context.cliName;
  if (cliName) {
    parts.push(`cli=${cliName}`);
  }

  if (typeof snapshot?.health.pendingCommands === "number") {
    parts.push(`pending=${snapshot.health.pendingCommands}`);
  }

  const lastError =
    snapshot?.lastProtocolError?.reason ??
    snapshot?.lastProtocolError?.message ??
    snapshot?.health.lastError ??
    adapter.lastError;
  if (typeof lastError === "string" && lastError.trim()) {
    parts.push(`error=${trimDebugText(lastError, 60)}`);
  }

  return parts.join(" ");
}

function buildSuggestedDebugCommands(
  session: SessionEntry,
  contexts: ContextRecord[],
  adapters: SessionAdapterRecord[],
): string[] {
  const target = session.name ?? session.sessionKey;
  const commands = [
    `ravi sessions debug ${target}`,
    `ravi sessions read ${target}`,
    `ravi agents session ${session.agentId}`,
    `ravi agents debug ${session.agentId} ${target}`,
    `ravi context list --session ${session.sessionKey}`,
    `ravi adapters list --session ${session.sessionKey}`,
  ];

  if (contexts.length > 0) {
    commands.push(`ravi context info ${contexts[0]!.contextId}`);
  }

  for (const adapter of adapters.slice(0, 3)) {
    commands.push(`ravi adapters show ${adapter.adapterId}`);
  }

  return commands;
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
    @Option({ flags: "--ephemeral", description: "Show only ephemeral sessions" }) ephemeralOnly?: boolean,
  ) {
    let sessions = agentId ? getSessionsByAgent(agentId) : listSessions();

    // Scope isolation: filter to accessible sessions only
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      sessions = filterAccessibleSessions(scopeCtx, sessions);
    }

    if (ephemeralOnly) {
      sessions = sessions.filter((s) => s.ephemeral);
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
      console.log(
        "  NAME                                  AGENT     TOKENS    ACTIVITY   TYPE       EXPIRES             DISPLAY",
      );
      console.log(
        "  ────────────────────────────────────  ────────  ────────  ─────────  ─────────  ──────────────────  ──────────────────",
      );

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

  @Command({
    name: "info",
    description: "Show unified session inspection details",
    aliases: ["inspect"],
  })
  info(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
    let s = resolveSession(nameOrKey);
    if (!s) {
      const match = findSessionByChatId(nameOrKey);
      if (match) s = match;
    }
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

    const config = loadRouterConfig();
    const agentConfig = config.agents[s.agentId];
    const derivedSource = deriveSourceFromSessionKey(s.sessionKey);
    const relatedContexts = dbListContexts({ sessionKey: s.sessionKey, includeInactive: true });
    const relatedAdapters = listSessionAdapters({ sessionKey: s.sessionKey });
    const suggestedCommands = buildSuggestedDebugCommands(s, relatedContexts, relatedAdapters);

    console.log(`\nSession: ${s.name ?? s.sessionKey}`);
    printInspectionField("Key", s.sessionKey, SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Display", s.displayName ?? "(none)", SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Agent", s.agentId, SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Agent CWD", s.agentCwd, SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Configured", agentConfig?.provider ?? "claude", CONFIG_DB_META, { labelWidth: 14 });
    printInspectionField("Model", agentConfig?.model ?? "(default)", CONFIG_DB_META, { labelWidth: 14 });
    printInspectionField("Override", s.modelOverride ?? "(agent default)", SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Thinking", s.thinkingLevel ?? "(default)", SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Runtime", s.runtimeProvider ?? "(unknown)", RUNTIME_SNAPSHOT_META, { labelWidth: 14 });
    printInspectionField("Runtime ID", s.providerSessionId ?? s.sdkSessionId ?? "(none)", RUNTIME_SNAPSHOT_META, {
      labelWidth: 14,
    });
    if (s.runtimeSessionParams) {
      printInspectionField("Runtime ctx", stringifyInspectionValue(s.runtimeSessionParams), RUNTIME_SNAPSHOT_META, {
        labelWidth: 14,
      });
    }
    printInspectionField(
      "Tokens",
      `input=${formatTokens(s.inputTokens ?? 0)} output=${formatTokens(s.outputTokens ?? 0)} total=${formatTokens(s.totalTokens ?? 0)} context=${formatTokens(s.contextTokens ?? 0)}`,
      RUNTIME_SNAPSHOT_META,
      { labelWidth: 14 },
    );

    if (s.lastChannel || s.lastTo) {
      const routing = [s.lastChannel, s.lastTo].filter(Boolean).join(" -> ");
      const account = s.lastAccountId ? ` (account: ${s.lastAccountId})` : "";
      printInspectionField("Channel", `${routing}${account}`, SESSION_DB_META, { labelWidth: 14 });
    }

    if (derivedSource) {
      printInspectionBlock(
        "Derived route",
        SESSION_KEY_META,
        [
          `channel=${derivedSource.channel}`,
          `account=${derivedSource.accountId || "(none)"}`,
          `chatId=${derivedSource.chatId}`,
          ...(derivedSource.threadId ? [`thread=${derivedSource.threadId}`] : []),
        ],
        { labelWidth: 14 },
      );
    }

    if (s.ephemeral) {
      const expiresStr = s.expiresAt ? formatDate(s.expiresAt) : "unknown";
      const remaining = s.expiresAt ? Math.max(0, Math.round((s.expiresAt - Date.now()) / 60_000)) : 0;
      printInspectionField("Ephemeral", `yes — expires ${expiresStr} (${remaining}min left)`, SESSION_DB_META, {
        labelWidth: 14,
      });
    }

    printInspectionField(
      "Queue",
      `${s.queueMode ?? "(default)"}${s.queueDebounceMs ? ` debounce=${s.queueDebounceMs}ms` : ""}${s.queueCap ? ` cap=${s.queueCap}` : ""}`,
      SESSION_DB_META,
      { labelWidth: 14 },
    );
    printInspectionField("Compactions", s.compactionCount ?? 0, RUNTIME_SNAPSHOT_META, { labelWidth: 14 });
    printInspectionField("Created", formatDate(s.createdAt), SESSION_DB_META, { labelWidth: 14 });
    printInspectionField("Updated", formatDate(s.updatedAt), SESSION_DB_META, { labelWidth: 14 });

    console.log();
    console.log(formatInspectionSection(`Related contexts (${relatedContexts.length}):`, CONTEXT_DB_META));
    if (relatedContexts.length === 0) {
      console.log("  (none)");
    } else {
      for (const context of relatedContexts) {
        console.log(`  ${formatContextInspectionLine(context)}`);
      }
    }

    console.log();
    console.log(formatInspectionSection(`Adapters (${relatedAdapters.length}):`, ADAPTER_DB_META));
    if (relatedAdapters.length === 0) {
      console.log("  (none)");
    } else {
      for (const adapter of relatedAdapters) {
        const snapshot = getSessionAdapterDebugSnapshot(adapter.adapterId);
        console.log(`  ${formatAdapterInspectionLine(adapter, snapshot)}`);
      }
    }

    console.log();
    console.log(formatInspectionSection("Next debug commands:", NEXT_COMMANDS_META));
    for (const command of suggestedCommands) {
      console.log(`  ${command}`);
    }
    console.log();

    return {
      session: s,
      contexts: relatedContexts,
      adapters: relatedAdapters,
      commands: suggestedCommands,
    };
  }

  @Command({ name: "rename", description: "Set session display name" })
  rename(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("displayName", { description: "Display name" }) displayName: string,
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
    @Arg("model", { description: "Model name (sonnet, opus, haiku) or 'clear' to remove override" }) model: string,
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
    @Arg("level", { description: "Thinking level (off, normal, verbose) or 'clear'" }) level: string,
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
      await nats.emit("ravi.session.abort", {
        sessionKey: s.sessionKey,
        sessionName: s.name,
      });
    } catch {
      /* session may not be active */
    }

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
      await nats.emit("ravi.session.abort", {
        sessionKey: s.sessionKey,
        sessionName: s.name,
      });
    } catch {
      /* session may not be active */
    }

    deleteSession(s.sessionKey);
    console.log(`🗑️ Session deleted: ${s.name ?? s.sessionKey}`);
  }

  // ===========================================================================
  // Ephemeral Commands
  // ===========================================================================

  @Command({ name: "set-ttl", description: "Make a session ephemeral with a TTL" })
  setTtl(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Arg("duration", { description: "TTL duration (e.g. 5h, 30m, 1d)" }) duration: string,
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
    @Arg("duration", { description: "Duration to add (default: 5h)", required: false }) duration?: string,
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
  keep(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
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

  @Command({
    name: "send",
    description: "Send a prompt to a session (fire-and-forget). Use -w to wait for response, -i for interactive.",
  })
  async send(
    @Arg("nameOrKey", { description: "Session name" }) nameOrKey: string,
    @Arg("prompt", { description: "Prompt to send (omit for interactive mode)", required: false }) prompt?: string,
    @Option({ flags: "-i, --interactive", description: "Interactive mode" }) interactive?: boolean,
    @Option({ flags: "-w, --wait", description: "Wait for response (chat mode)" }) wait?: boolean,
    @Option({ flags: "-a, --agent <id>", description: "Agent to use when creating a new session" }) agentId?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: p0|p1|p2|p3" }) barrier?: string,
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

    const deliveryBarrier = resolveDeliveryBarrierOptionWithDefault(barrier, "after_tool");

    if (interactive || !prompt) {
      return this.interactiveMode(sessionName, session, channel, to);
    }

    const origin = getContext()?.sessionKey ?? "unknown";
    const fullPrompt = `[System] Inform: [from: ${origin}] ${prompt}`;

    if (wait) {
      console.log(`\n📤 Sending to ${sessionName}\n`);
      console.log(`Prompt: ${prompt}\n`);
      console.log("─".repeat(50));
      const chars = await this.streamToSession(sessionName, fullPrompt, session, channel, to, deliveryBarrier);
      console.log("\n" + "─".repeat(50));
      console.log(`\n✅ Done (${chars} chars)`);
    } else {
      await this.emitToSession(sessionName, fullPrompt, session, channel, to, deliveryBarrier);
      console.log(`📤 Sent to ${sessionName}`);
    }
  }

  @Command({ name: "ask", description: "Ask a question to another session (fire-and-forget)" })
  async ask(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Question to ask" }) message: string,
    @Arg("sender", { required: false, description: "Who originally asked (for attribution)" }) sender?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: p0|p1|p2|p3" }) barrier?: string,
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const origin = getContext()?.sessionKey ?? "unknown";
    const senderTag = sender ? `, sender: ${sender}` : "";
    const prompt = `[System] Ask: [from: ${origin}${senderTag}] ${message}\n(If you already know the answer, send it back immediately with: ravi sessions answer ${origin} "answer" "${sender ?? ""}" — no need to ask in the chat. Otherwise, your text output IS the message sent to the chat — just write the question directly, don't describe what you're doing. When you get answers, send each one back with: ravi sessions answer ${origin} "answer" "${sender ?? ""}". You can call answer multiple times as new info comes in. IMPORTANT: Don't consider the ask "done" after the first reply — if the person keeps adding details, context, or follow-ups, send another answer with the new info each time. Only forward messages related to this question — ignore unrelated conversation.)`;

    await this.emitToSession(
      session.name ?? target,
      prompt,
      session,
      channel,
      to,
      resolveDeliveryBarrierOptionWithDefault(barrier, "after_response"),
    );
    console.log(`✓ [ask] sent to ${session.name ?? target}`);
  }

  @Command({ name: "answer", description: "Answer a question from another session (fire-and-forget)" })
  async answer(
    @Arg("target", { description: "Target session name (the one that asked)" }) target: string,
    @Arg("message", { description: "Answer to send back" }) message: string,
    @Arg("sender", { required: false, description: "Who is answering (for attribution)" }) sender?: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: p0|p1|p2|p3" }) barrier?: string,
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const origin = getContext()?.sessionKey ?? "unknown";
    const senderTag = sender ? `, sender: ${sender}` : "";
    const prompt = `[System] Answer: [from: ${origin}${senderTag}] ${message}`;

    await this.emitToSession(
      session.name ?? target,
      prompt,
      session,
      channel,
      to,
      resolveDeliveryBarrierOptionWithDefault(barrier, "immediate_interrupt"),
    );
    console.log(`✓ [answer] sent to ${session.name ?? target}`);
  }

  @Command({ name: "execute", description: "Send an execute command to another session (fire-and-forget)" })
  async execute(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Task to execute" }) message: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: p0|p1|p2|p3" }) barrier?: string,
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const prompt = `[System] Execute: ${message}`;

    await this.emitToSession(
      session.name ?? target,
      prompt,
      session,
      channel,
      to,
      resolveDeliveryBarrierOptionWithDefault(barrier, "after_task"),
    );
    console.log(`✓ [execute] sent to ${session.name ?? target}`);
  }

  @Command({ name: "inform", description: "Send an informational message to another session (fire-and-forget)" })
  async inform(
    @Arg("target", { description: "Target session name" }) target: string,
    @Arg("message", { description: "Information to send" }) message: string,
    @Option({ flags: "--channel <channel>", description: "Override delivery channel" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Override delivery target" }) to?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: p0|p1|p2|p3" }) barrier?: string,
  ) {
    const session = this.resolveTarget(target);
    if (!session) return;

    const prompt = `[System] Inform: ${message}`;

    await this.emitToSession(
      session.name ?? target,
      prompt,
      session,
      channel,
      to,
      resolveDeliveryBarrierOptionWithDefault(barrier, "after_response"),
    );
    console.log(`✓ [inform] sent to ${session.name ?? target}`);
  }

  @Command({ name: "read", description: "Read message history of a session (normalized)" })
  read(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Option({ flags: "-n, --count <count>", description: "Number of messages to show (default: 20)" })
    countStr?: string,
  ) {
    const session = this.resolveTarget(nameOrKey);
    if (!session) return;

    const providerSessionId = session.providerSessionId ?? session.sdkSessionId;
    if (!providerSessionId) {
      console.log("⚠️  No runtime session — no history available");
      return;
    }

    const { readFileSync } = require("node:fs");
    const agent = loadRouterConfig().agents[session.agentId];
    const transcript = locateRuntimeTranscript({
      runtimeProvider: session.runtimeProvider,
      providerSessionId,
      agentCwd: session.agentCwd,
      remote: agent?.remote,
    });

    if (!transcript.path) {
      console.log(`⚠️  ${transcript.reason ?? "Transcript not found"}`);
      return;
    }

    const maxMessages = parseInt(countStr ?? "20", 10);
    const raw = readFileSync(transcript.path, "utf-8") as string;
    const _lines = raw.trim().split("\n").filter(Boolean);

    const messages = extractNormalizedTranscriptMessages(raw, session.runtimeProvider);

    const recent = messages.slice(-maxMessages);
    console.log(`\n💬 ${session.name ?? nameOrKey} — last ${recent.length} of ${messages.length} messages\n`);

    for (const msg of recent) {
      const who = msg.role === "user" ? "👤" : "🤖";
      const timeStr = msg.time ? ` [${msg.time}]` : "";
      console.log(`${who}${timeStr} ${msg.text}\n`);
    }
  }

  @Command({
    name: "debug",
    description: "Tail live runtime events for a session (defaults to current session when available)",
  })
  async debug(
    @Arg("nameOrKey", { description: "Session name or key", required: false }) nameOrKey?: string,
    @Option({ flags: "-t, --timeout <seconds>", description: "Stop after N seconds (default: 60)" })
    timeoutStr?: string,
    @Option({ flags: "--json", description: "Print raw events as JSONL" }) asJson?: boolean,
  ) {
    const fallbackTarget = getContext()?.sessionName ?? getContext()?.sessionKey;
    const target = nameOrKey?.trim() || fallbackTarget?.trim();
    if (!target) {
      fail("No session specified. Use ravi sessions debug <name> or run from inside a session.");
      return;
    }

    const session = this.resolveTarget(target);
    if (!session) return;

    const sessionName = session.name ?? target;
    const timeoutSeconds = Number.parseInt(timeoutStr ?? "60", 10);
    const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 60_000;

    console.log(`\n🔎 Session debug: ${sessionName}`);
    console.log(`Agent: ${session.agentId}`);
    console.log(
      `Runtime: ${session.runtimeProvider ?? "(unknown)"} :: ${session.providerSessionId ?? session.sdkSessionId ?? "(none)"}`,
    );
    console.log(`Channel: ${session.lastChannel ?? "-"} -> ${session.lastTo ?? "-"}`);
    console.log(`Window: ${Math.round(timeoutMs / 1000)}s\n`);

    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let closed = false;

    const subscriptions = [
      nats.subscribe(`ravi.session.${sessionName}.prompt`),
      nats.subscribe(`ravi.session.${sessionName}.response`),
      nats.subscribe(`ravi.session.${sessionName}.stream`),
      nats.subscribe(`ravi.session.${sessionName}.tool`),
      nats.subscribe(`ravi.session.${sessionName}.runtime`),
      nats.subscribe(`ravi.session.${sessionName}.claude`),
      nats.subscribe(`ravi.session.${sessionName}.delivery`),
      nats.subscribe("ravi.approval.request"),
      nats.subscribe("ravi.approval.response"),
    ];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      for (const sub of subscriptions) sub.return(undefined);
      resolveCompletion?.();
    };

    const timer = setTimeout(() => {
      console.log(`\n⏱️  Debug window ended after ${Math.round(timeoutMs / 1000)}s`);
      cleanup();
    }, timeoutMs);

    const pump = async (sub: AsyncGenerator<{ topic: string; data: Record<string, unknown> }>) => {
      try {
        for await (const event of sub) {
          if (closed) break;

          if (
            (event.topic === "ravi.approval.request" || event.topic === "ravi.approval.response") &&
            event.data.sessionName !== sessionName
          ) {
            continue;
          }

          console.log(formatDebugLine(event.topic, event.data, asJson));
        }
      } catch {
        // ignore subscription shutdown
      }
    };

    const tasks = subscriptions.map((sub) => pump(sub));

    const sigintHandler = () => {
      console.log("\n🛑 Debug interrupted");
      cleanup();
    };
    process.once("SIGINT", sigintHandler);

    try {
      await completion;
      await nats.close();
      await Promise.allSettled(tasks);
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", sigintHandler);
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
    toOverride?: string,
  ): { source?: { channel: string; accountId: string; chatId: string; threadId?: string }; context?: ChannelContext } {
    let source: { channel: string; accountId: string; chatId: string; threadId?: string } | undefined;
    let context: ChannelContext | undefined;

    if (channelOverride && toOverride) {
      source = { channel: channelOverride, accountId: "", chatId: toOverride };
    } else if (session.lastChannel && session.lastTo) {
      // Derive threadId from session key (lastTo doesn't carry it)
      const derived = deriveSourceFromSessionKey(session.sessionKey);
      source = {
        channel: session.lastChannel,
        accountId: session.lastAccountId ?? "",
        chatId: session.lastTo,
        ...(derived?.threadId ? { threadId: derived.threadId } : {}),
      };
    } else {
      const derived = deriveSourceFromSessionKey(session.sessionKey);
      if (derived) source = derived;
    }

    if (session.lastContext) {
      try {
        context = JSON.parse(session.lastContext) as ChannelContext;
      } catch {
        /* ignore */
      }
    }

    return { source, context };
  }

  /**
   * Resolve the caller's channel source for cascading approval delegation.
   * When agent A sends a task to agent B, A's channel becomes B's approval source.
   */
  private resolveCallerApprovalSource(): { channel: string; accountId: string; chatId: string } | undefined {
    const callerCtx = getContext();
    if (!callerCtx?.sessionKey) return undefined;

    const callerSession = resolveSession(callerCtx.sessionKey);
    if (callerSession?.lastChannel && callerSession.lastTo) {
      return {
        channel: callerSession.lastChannel,
        accountId: callerSession.lastAccountId ?? "",
        chatId: callerSession.lastTo,
      };
    }
    return undefined;
  }

  /**
   * Fire-and-forget emit to a session (for ask/answer/execute/inform).
   */
  private async emitToSession(
    sessionName: string,
    prompt: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string,
    deliveryBarrier: DeliveryBarrier = DEFAULT_DELIVERY_BARRIER,
  ): Promise<void> {
    const { source, context } = this.resolveSource(session, channelOverride, toOverride);

    // Resolve caller's source for approval delegation (cascading approvals)
    const _approvalSource = this.resolveCallerApprovalSource();

    await publishSessionPrompt(sessionName, { prompt, source, context, _approvalSource, deliveryBarrier } as Record<
      string,
      unknown
    >);
  }

  /**
   * Send a prompt to a session and stream the response.
   */
  private async streamToSession(
    sessionName: string,
    prompt: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string,
    deliveryBarrier: DeliveryBarrier = DEFAULT_DELIVERY_BARRIER,
  ): Promise<number> {
    let responseLength = 0;
    let settled = false;
    let settleCompletion: ((state: StreamTerminalState) => void) | undefined;

    const runtimeStream = nats.subscribe(`ravi.session.${sessionName}.runtime`);
    const claudeStream = nats.subscribe(`ravi.session.${sessionName}.claude`);
    const responseStream = nats.subscribe(`ravi.session.${sessionName}.response`);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      runtimeStream.return(undefined);
      claudeStream.return(undefined);
      responseStream.return(undefined);
    };

    const completion = new Promise<StreamTerminalState>((resolve) => {
      const settle = (state: StreamTerminalState) => {
        if (settled) return;
        settled = true;
        resolve(state);
      };
      settleCompletion = settle;

      timeoutId = setTimeout(() => {
        console.log("\n⏱️  Timeout");
        settle({ kind: "timeout" });
      }, SEND_TIMEOUT_MS);

      (async () => {
        try {
          for await (const event of runtimeStream) {
            const data = event.data as Record<string, unknown>;
            const type = data.type;
            if (type === "turn.complete") {
              settle({ kind: "complete" });
              break;
            }
            if (type === "turn.failed") {
              settle({
                kind: "failed",
                error: extractRuntimeTerminalError(data) ?? "Session failed",
              });
              break;
            }
            if (type === "turn.interrupted") {
              settle({
                kind: "interrupted",
                error: extractRuntimeTerminalError(data) ?? "Session turn was interrupted",
              });
              break;
            }
          }
        } catch {
          /* ignore */
        }
      })();

      (async () => {
        try {
          for await (const event of claudeStream) {
            if ((event.data as Record<string, unknown>).type === "result") {
              settle({ kind: "complete" });
              break;
            }
          }
        } catch {
          /* ignore */
        }
      })();
    });

    const streaming = (async () => {
      try {
        for await (const event of responseStream) {
          const data = event.data as ResponseMessage;
          if (data.error) {
            settleCompletion?.({ kind: "failed", error: data.error });
            break;
          }
          if (data.response) {
            process.stdout.write(data.response);
            responseLength += data.response.length;
          }
        }
      } catch {
        /* ignore */
      }
    })();

    const { source, context } = this.resolveSource(session, channelOverride, toOverride);
    const _approvalSource = this.resolveCallerApprovalSource();
    await publishSessionPrompt(sessionName, { prompt, source, context, _approvalSource, deliveryBarrier } as Record<
      string,
      unknown
    >);

    const completionState = await completion;
    cleanup();

    await Promise.race([streaming, new Promise((r) => setTimeout(r, 100))]);

    if (completionState.kind === "failed" || completionState.kind === "interrupted") {
      throw new Error(completionState.error);
    }
    if (completionState.kind === "timeout") {
      throw new Error(formatWaitTimeoutError(sessionName));
    }

    return responseLength;
  }

  private async interactiveMode(
    sessionName: string,
    session: SessionEntry,
    channelOverride?: string,
    toOverride?: string,
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
            console.log(`Runtime Session: ${s.providerSessionId ?? s.sdkSessionId ?? "(none)"}`);
            console.log(`Tokens: ${(s.inputTokens || 0) + (s.outputTokens || 0)}\n`);
          } else {
            console.log("No active session.\n");
          }
          ask();
          return;
        }

        console.log();
        try {
          await this.streamToSession(sessionName, trimmed, session, channelOverride, toOverride);
          console.log("\n");
        } catch (err) {
          console.log(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        ask();
      });
    };

    ask();
  }
}

export interface NormalizedTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  time: string;
}

export function extractNormalizedTranscriptMessages(
  raw: string,
  runtimeProvider?: "claude" | "codex",
): NormalizedTranscriptMessage[] {
  if (runtimeProvider === "codex") {
    const messages = extractCodexTranscriptMessages(raw);
    if (messages.length > 0) {
      return messages;
    }
  }

  return extractClaudeTranscriptMessages(raw);
}

function extractClaudeTranscriptMessages(raw: string): NormalizedTranscriptMessage[] {
  const lines = raw.trim().split("\n").filter(Boolean);
  const messages: NormalizedTranscriptMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.type === "user" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
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

  return messages;
}

function extractCodexTranscriptMessages(raw: string): NormalizedTranscriptMessage[] {
  const lines = raw.trim().split("\n").filter(Boolean);
  const messages: NormalizedTranscriptMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: { type?: string; message?: string };
      };

      if (entry.type !== "event_msg") {
        continue;
      }

      const payloadType = entry.payload?.type;
      const text = entry.payload?.message?.trim();
      if (!text || text === "@@SILENT@@") {
        continue;
      }

      if (payloadType === "user_message") {
        messages.push({
          role: "user",
          text,
          time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "",
        });
      } else if (payloadType === "agent_message") {
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

  return messages;
}

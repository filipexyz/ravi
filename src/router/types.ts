/**
 * Session Router Types
 */

import type { BashConfig } from "../bash/types.js";

// ============================================================================
// DM Scope
// ============================================================================

/** How DMs are grouped into sessions */
export type DmScope =
  | "main"                    // All DMs share one session: agent:X:main
  | "per-peer"                // Isolated by contact: agent:X:dm:PHONE
  | "per-channel-peer"        // Isolated by channel+contact: agent:X:whatsapp:dm:PHONE
  | "per-account-channel-peer"; // Full isolation: agent:X:whatsapp:default:dm:PHONE

// ============================================================================
// Heartbeat Configuration
// ============================================================================

export interface HeartbeatConfig {
  /** Whether heartbeat is enabled for this agent */
  enabled: boolean;

  /** Interval between heartbeats in milliseconds (default: 30 minutes) */
  intervalMs: number;

  /** Model to use for heartbeat (null = use agent's model) */
  model?: string;

  /** Active hours start time (HH:MM format) */
  activeStart?: string;

  /** Active hours end time (HH:MM format) */
  activeEnd?: string;

  /** Timestamp of last heartbeat run */
  lastRunAt?: number;
}

// ============================================================================
// Agent Configuration
// ============================================================================

export interface AgentConfig {
  /** Agent ID (used in session keys) */
  id: string;

  /** Display name */
  name?: string;

  /** Working directory for the agent (e.g., ~/ravi/main) */
  cwd: string;

  /** Model override for this agent */
  model?: string;

  /** Default DM scope for this agent */
  dmScope?: DmScope;

  /** System prompt append */
  systemPromptAppend?: string;

  /** Whitelist of allowed tools (undefined = bypass mode, all tools allowed) */
  allowedTools?: string[];

  /** Debounce time in ms - groups messages arriving within this window */
  debounceMs?: number;

  /** Matrix account username (references matrix_accounts table) */
  matrixAccount?: string;

  /** Heartbeat configuration */
  heartbeat?: HeartbeatConfig;

  /** Setting sources for Claude SDK (default: ["project"]) */
  settingSources?: ("user" | "project")[];

  /** Bash CLI permission configuration */
  bashConfig?: BashConfig;

  /** Model to use for memory extraction during PreCompact (default: "haiku") */
  memoryModel?: string;
}

// ============================================================================
// Route Configuration
// ============================================================================

export interface RouteConfig {
  /** Phone pattern (exact match or glob with *) */
  pattern: string;

  /** Agent ID to route to */
  agent: string;

  /** Override DM scope for this route */
  dmScope?: DmScope;

  /** Priority (higher = checked first, default 0) */
  priority?: number;
}

// ============================================================================
// Router Configuration
// ============================================================================

export interface RouterConfig {
  /** Agent definitions */
  agents: Record<string, AgentConfig>;

  /** Routing rules (checked in order by priority) */
  routes: RouteConfig[];

  /** Default agent when no route matches */
  defaultAgent: string;

  /** Default DM scope */
  defaultDmScope: DmScope;
}

// ============================================================================
// Session Key Parameters
// ============================================================================

export interface SessionKeyParams {
  agentId: string;
  channel?: string;
  accountId?: string;
  peerKind?: "dm" | "group" | "channel";
  peerId?: string;
  dmScope?: DmScope;
  threadId?: string;
}

// ============================================================================
// Session Entry (Metadata)
// ============================================================================

export interface SessionEntry {
  // Identification
  sessionKey: string;
  /** Human-readable unique session name (used in notif topics) */
  name?: string;
  sdkSessionId?: string;
  sessionFile?: string;
  updatedAt: number;
  createdAt: number;

  // Agent
  agentId: string;
  agentCwd: string;

  // Flow state
  systemSent?: boolean;
  abortedLastRun?: boolean;
  compactionCount?: number;

  // Origin
  chatType?: "dm" | "group" | "channel";
  channel?: string;
  accountId?: string;
  groupId?: string;
  subject?: string;
  displayName?: string;

  // Delivery context
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string;
  lastContext?: string; // JSON-serialized MessageContext

  // Overrides
  thinkingLevel?: "off" | "normal" | "verbose";
  modelOverride?: string;
  ttsAuto?: "on" | "off" | "voice";

  // Queue mode
  queueMode?: "steer" | "followup" | "collect" | "queue" | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;

  // Usage tracking
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;

  // Heartbeat
  lastHeartbeatText?: string;
  lastHeartbeatSentAt?: number;
}

// ============================================================================
// Resolution Result
// ============================================================================

export interface ResolvedRoute {
  agent: AgentConfig;
  dmScope: DmScope;
  sessionKey: string;
  /** Human-readable session name (used in notif topics) */
  sessionName: string;
  route?: RouteConfig;
}

import type { DeliveryBarrier } from "../delivery-barriers.js";

export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "CwdChanged",
  "FileChanged",
  "Stop",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export const HOOK_SCOPE_TYPES = ["global", "agent", "session", "workspace", "task"] as const;

export type HookScopeType = (typeof HOOK_SCOPE_TYPES)[number];

export const HOOK_ACTION_TYPES = [
  "inject_context",
  "send_session_event",
  "append_history",
  "comment_task",
  "dispatch_task",
] as const;

export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

export type HookHistoryRole = "user" | "assistant";

export interface InjectContextActionPayload {
  message: string;
  sessionName?: string;
  deliveryBarrier?: DeliveryBarrier;
}

export interface SendSessionEventActionPayload {
  message: string;
  sessionName?: string;
  deliveryBarrier?: DeliveryBarrier;
}

export interface AppendHistoryActionPayload {
  message: string;
  sessionName?: string;
  role?: HookHistoryRole;
}

export interface CommentTaskActionPayload {
  body: string;
  taskId?: string;
  author?: string;
}

export interface DispatchTaskActionPayload {
  profileId: string;
  title: string;
  targetAgentId?: string;
  instructions?: string;
  profileInputJson?: string;
  /**
   * R1 — deterministic per-turn cadence. When set (>0), the handler advances
   * a counter stored under `runtimeSessionParams.memoryCuration` on the
   * event's session and only creates the task when
   * `turnCount % cadenceTurns === 0`. Requires event.sessionKey; without it,
   * cadence is ignored and the task fires every event (see runner behavior).
   */
  cadenceTurns?: number;
}

export type HookActionPayload =
  | InjectContextActionPayload
  | SendSessionEventActionPayload
  | AppendHistoryActionPayload
  | CommentTaskActionPayload
  | DispatchTaskActionPayload;

export interface HookRecord {
  id: string;
  name: string;
  eventName: HookEventName;
  scopeType: HookScopeType;
  scopeValue?: string;
  matcher?: string;
  actionType: HookActionType;
  actionPayload: HookActionPayload;
  enabled: boolean;
  async: boolean;
  cooldownMs: number;
  dedupeKey?: string;
  lastFiredAt?: number;
  lastDedupeKey?: string;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HookInput {
  name: string;
  eventName: HookEventName;
  scopeType?: HookScopeType;
  scopeValue?: string;
  matcher?: string;
  actionType: HookActionType;
  actionPayload: HookActionPayload;
  enabled?: boolean;
  async?: boolean;
  cooldownMs?: number;
  dedupeKey?: string;
}

export interface HookStateUpdateInput {
  lastFiredAt: number;
  lastDedupeKey?: string;
  incrementFire?: boolean;
}

export interface NormalizedHookEvent {
  eventName: HookEventName;
  source: string;
  sessionName?: string;
  sessionKey?: string;
  agentId?: string;
  /**
   * Working directory of the agent that owns this session — resolved from
   * SessionEntry.agentCwd. Exposed as a template placeholder so hooks can
   * derive per-agent paths (e.g. `{{agentCwd}}/MEMORY.md`) without knowing
   * the agent id at hook-authoring time.
   */
  agentCwd?: string;
  taskId?: string;
  cwd?: string;
  workspace?: string;
  path?: string;
  paths?: string[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
}

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  eventName: HookEventName;
  skipped?: "disabled" | "cooldown" | "dedupe" | "scope" | "matcher";
  detail?: string;
}

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

export const HOOK_ACTION_TYPES = ["inject_context", "send_session_event", "append_history", "comment_task"] as const;

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

export type HookActionPayload =
  | InjectContextActionPayload
  | SendSessionEventActionPayload
  | AppendHistoryActionPayload
  | CommentTaskActionPayload;

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

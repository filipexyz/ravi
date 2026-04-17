/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against REBAC permissions.
 *
 * Layers:
 * 1. Env spoofing check (RAVI_* override)
 * 2. Executable permissions (via REBAC: execute executable:<name>)
 * 3. Session scope (via REBAC: access session:<name>)
 *
 * Note: ravi CLI group-level scope (execute group:<name>) is handled by
 * enforceScopeCheck() in the CLI process, not here.
 */

import { publish } from "../nats.js";
import { checkDangerousPatterns, parseBashCommand, UNCONDITIONAL_BLOCKS } from "./parser.js";
import { logger } from "../utils/logger.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { agentCan, canWithCapabilityContext } from "../permissions/engine.js";
import { SDK_TOOLS } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";

const log = logger.child("bash:hook");

/**
 * Emit an audit event via NATS (fire-and-forget).
 */
function emitAudit(event: { type: string; agentId: string; denied: string; reason: string; detail?: string }): void {
  publish("ravi.audit.denied", event as unknown as Record<string, unknown>).catch(() => {});
}

function buildBashDeniedAuditEvent(
  command: string,
  decision: BashPermissionDecision,
  agentId?: string,
): { type: string; agentId: string; denied: string; reason: string; detail?: string } | null {
  if (decision.allowed || !decision.denialType) {
    return null;
  }

  const resolvedAgentId = agentId ?? "unknown";
  const detail = command.slice(0, 200);

  if (decision.denialType === "env_spoofing") {
    return {
      type: "env_spoofing",
      agentId: resolvedAgentId,
      denied: "RAVI_* override",
      reason: decision.reason ?? "Cannot override RAVI environment variables",
      detail,
    };
  }

  if (decision.denialType === "executable") {
    return {
      type: "executable",
      agentId: resolvedAgentId,
      denied: command.split(/\s+/)[0] ?? "unknown",
      reason: decision.reason ?? "Bash command denied by Ravi",
      detail,
    };
  }

  if (decision.denialType === "session_scope") {
    return {
      type: "session_scope",
      agentId: resolvedAgentId,
      denied: extractRaviTarget(command) ?? "unknown",
      reason: decision.reason ?? "Bash command denied by Ravi",
      detail,
    };
  }

  return null;
}

/**
 * Hook input structure from Claude Agent SDK.
 */
interface PreToolUseHookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Hook context from Claude Agent SDK.
 */
interface HookContext {
  signal: AbortSignal;
}

/**
 * Hook callback type from Claude Agent SDK.
 */
type HookCallback = (
  input: PreToolUseHookInput,
  toolUseId: string | null,
  context: HookContext,
) => Promise<Record<string, unknown>>;

/**
 * Hook callback matcher type from Claude Agent SDK.
 */
interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
}

/**
 * Extract ravi CLI tool name from a bash command.
 * e.g. "ravi sessions send ..." → "sessions_send"
 *      "ravi daemon restart ..." → "daemon_restart"
 *      "ravi agents list" → "agents_list"
 *
 * Returns null if not a ravi command or can't parse.
 */
function extractRaviToolName(command: string): string | null {
  const match = command.match(/(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+([\w-]+)\s+([\w-]+)/);
  if (match) {
    return `${match[1]}_${match[2]}`;
  }
  return null;
}

/**
 * Extract the first positional argument from a ravi CLI command.
 * e.g. "ravi sessions send main 'msg'" → "main"
 *      "ravi sessions list" → null
 *      "ravi sessions read my-session" → "my-session"
 */
function extractRaviTarget(command: string): string | null {
  const match = command.match(
    /(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+[\w-]+\s+[\w-]+\s+(?:(?:-\w+\s+\S+\s+)*)["']?([^"'\s]+)/,
  );
  return match?.[1] ?? null;
}

/**
 * Check if a command attempts to override RAVI_* env vars (identity/config spoofing).
 * Blocks ALL RAVI_* env var overrides for non-superadmin agents.
 */
function checkEnvSpoofing(command: string): { allowed: boolean; reason?: string } {
  if (/\bRAVI_\w+\s*=/.test(command)) {
    return {
      allowed: false,
      reason: "Cannot override RAVI environment variables",
    };
  }
  return { allowed: true };
}

/** Commands that require session scope check on the target argument */
const SESSION_TARGET_COMMANDS = new Set([
  "sessions_send",
  "sessions_ask",
  "sessions_answer",
  "sessions_execute",
  "sessions_inform",
  "sessions_read",
  "sessions_info",
  "sessions_reset",
  "sessions_delete",
  "sessions_rename",
  "sessions_set-model",
  "sessions_set-thinking",
  "sessions_set-ttl",
  "sessions_extend",
  "sessions_keep",
]);

interface BashHookOptions {
  getAgentId: () => string | undefined;
}

export interface BashPermissionContext {
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  capabilities?: ContextCapability[];
}

export interface BashPermissionDecision {
  allowed: boolean;
  reason?: string;
  denialType?: "env_spoofing" | "executable" | "session_scope";
  toolName?: string | null;
}

function hasContextCapabilities(ctx: BashPermissionContext): ctx is BashPermissionContext & {
  capabilities: ContextCapability[];
} {
  return Array.isArray(ctx.capabilities);
}

function canWithBashContext(
  ctx: BashPermissionContext,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (hasContextCapabilities(ctx)) {
    return canWithCapabilityContext(ctx, permission, objectType, objectId);
  }
  return agentCan(ctx.agentId, permission, objectType, objectId);
}

function isSuperadminContext(ctx: BashPermissionContext): boolean {
  return canWithBashContext(ctx, "admin", "system", "*");
}

function checkExecutablePermissionsForContext(
  command: string,
  ctx: BashPermissionContext,
): { allowed: boolean; reason?: string } {
  if (canWithBashContext(ctx, "execute", "executable", "*")) {
    return { allowed: true };
  }

  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    return { allowed: false, reason: patternCheck.reason };
  }

  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    return { allowed: false, reason: parsed.error || "Failed to parse command" };
  }

  const BUILTIN_EXECUTABLES = new Set(["ravi"]);
  const blocked: string[] = [];

  for (const exec of parsed.executables) {
    if (UNCONDITIONAL_BLOCKS.has(exec)) {
      blocked.push(exec);
      continue;
    }

    if (BUILTIN_EXECUTABLES.has(exec)) continue;

    if (!canWithBashContext(ctx, "execute", "executable", exec)) {
      blocked.push(exec);
    }
  }

  if (blocked.length > 0) {
    return {
      allowed: false,
      reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot execute: ${blocked.join(", ")}`,
    };
  }

  return { allowed: true };
}

function canAccessSessionWithBashContext(ctx: BashPermissionContext, targetNameOrKey: string): boolean {
  if (!ctx.agentId && !hasContextCapabilities(ctx)) return true;

  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  if (!hasContextCapabilities(ctx)) {
    return canAccessSession(
      {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        sessionName: ctx.sessionName,
      },
      targetNameOrKey,
    );
  }

  return canWithCapabilityContext(ctx, "access", "session", targetNameOrKey);
}

function checkScopePermissionForContext(
  command: string,
  toolName: string | null,
  ctx: BashPermissionContext,
): { allowed: boolean; reason?: string } {
  if (!toolName) return { allowed: true };

  if (SESSION_TARGET_COMMANDS.has(toolName)) {
    const target = extractRaviTarget(command);
    if (target && !canAccessSessionWithBashContext(ctx, target)) {
      return {
        allowed: false,
        reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot access session:${target}`,
      };
    }
  }

  return { allowed: true };
}

export function buildPreToolUseDenyResult(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function emitBashDeniedAudit(command: string, decision: BashPermissionDecision, agentId?: string): void {
  const event = buildBashDeniedAuditEvent(command, decision, agentId);
  if (!event) {
    return;
  }

  emitAudit(event);
}

export function evaluateBashPermission(command: string, ctx: BashPermissionContext = {}): BashPermissionDecision {
  const isSuperadmin = isSuperadminContext(ctx);
  const spoofResult = isSuperadmin ? { allowed: true } : checkEnvSpoofing(command);
  if (!spoofResult.allowed) {
    return {
      allowed: false,
      reason: spoofResult.reason,
      denialType: "env_spoofing",
    };
  }

  if (ctx.agentId || hasContextCapabilities(ctx)) {
    const execResult = checkExecutablePermissionsForContext(command, ctx);
    if (!execResult.allowed) {
      return {
        allowed: false,
        reason: execResult.reason,
        denialType: "executable",
      };
    }
  }

  const toolName = extractRaviToolName(command);
  const scopeResult = checkScopePermissionForContext(command, toolName, ctx);
  if (!scopeResult.allowed) {
    return {
      allowed: false,
      reason: scopeResult.reason,
      denialType: "session_scope",
      toolName,
    };
  }

  return {
    allowed: true,
    toolName,
  };
}

/**
 * Create a bash permission hook for the SDK.
 *
 * Validates:
 * 1. Env spoofing (RAVI_* override)
 * 2. Executable permissions (via REBAC)
 * 3. Session scope (via REBAC)
 */
export function createBashPermissionHook(options: BashHookOptions): HookCallbackMatcher {
  const bashPermissionHook: HookCallback = async (input, _toolUseId, _context) => {
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      return {};
    }

    const agentId = options.getAgentId();
    const scopeCtx = getScopeContext();
    const decision = evaluateBashPermission(command, {
      agentId,
      sessionKey: scopeCtx.sessionKey,
      sessionName: scopeCtx.sessionName,
    });

    if (!decision.allowed && decision.denialType === "env_spoofing") {
      log.warn("Env spoofing blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    if (!decision.allowed && decision.denialType === "executable") {
      log.warn("Executable blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    if (!decision.allowed && decision.denialType === "session_scope") {
      log.warn("Scope check blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    log.debug("Bash command allowed", {
      command: command.slice(0, 100),
      raviTool: decision.toolName,
    });

    return {};
  };

  return {
    matcher: "Bash",
    hooks: [bashPermissionHook],
  };
}

/**
 * Create a tool permission hook for the SDK.
 *
 * Intercepts ALL tool calls and checks via REBAC in real-time.
 * This ensures permission changes take effect immediately without
 * needing to restart the session.
 */
export function createToolPermissionHook(options: BashHookOptions): HookCallbackMatcher {
  const toolPermissionHook: HookCallback = async (input) => {
    const agentId = options.getAgentId();
    if (!agentId) return {};

    const toolName = input.tool_name;
    if (!toolName) return {};

    // Only check SDK built-in tools — MCP tools and CLI tools are not gated here
    if (!SDK_TOOLS.includes(toolName)) return {};

    // Check REBAC: can agent use this tool?
    if (!agentCan(agentId, "use", "tool", toolName)) {
      log.warn("Tool blocked", { agentId, tool: toolName });
      emitAudit({
        type: "tool",
        agentId,
        denied: `tool:${toolName}`,
        reason: `Permission denied: agent:${agentId} cannot use tool:${toolName}`,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Permission denied: agent:${agentId} cannot use tool:${toolName}`,
        },
      };
    }

    return {};
  };

  return {
    // No matcher = fires for ALL tools
    hooks: [toolPermissionHook],
  };
}

export type { HookCallbackMatcher };

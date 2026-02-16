/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against the agent's BashConfig, allowedTools, and REBAC engine.
 */

import type { BashConfig } from "./types.js";
import { checkBashPermission } from "./permissions.js";
import { logger } from "../utils/logger.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { agentCan } from "../permissions/engine.js";

const log = logger.child("bash:hook");

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
  context: HookContext
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
 * Check if a ravi CLI tool is allowed by the agent's allowedTools.
 * allowedTools uses plain names like "sessions_send", "media_send".
 */
function checkRaviToolPermission(
  command: string,
  allowedTools: string[] | undefined
): { allowed: boolean; toolName?: string; reason?: string } {
  if (!allowedTools) return { allowed: true };

  const toolName = extractRaviToolName(command);
  if (!toolName) return { allowed: true };

  if (allowedTools.includes(toolName)) {
    return { allowed: true, toolName };
  }

  return {
    allowed: false,
    toolName,
    reason: `ravi CLI tool not allowed: ${toolName}`,
  };
}

/**
 * Extract the first positional argument from a ravi CLI command.
 * e.g. "ravi sessions send main 'msg'" → "main"
 *      "ravi sessions list" → null
 *      "ravi sessions read my-session" → "my-session"
 */
function extractRaviTarget(command: string): string | null {
  // Match: ravi <group> <subcommand> <target>
  // Target is the first non-flag argument after the subcommand
  const match = command.match(
    /(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+[\w-]+\s+[\w-]+\s+(?:(?:-\w+\s+\S+\s+)*)["']?([^"'\s]+)/
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
  "sessions_send", "sessions_ask", "sessions_answer",
  "sessions_execute", "sessions_inform", "sessions_read",
  "sessions_info", "sessions_reset", "sessions_delete",
  "sessions_rename", "sessions_set-model", "sessions_set-thinking",
  "sessions_set-ttl", "sessions_extend", "sessions_keep",
]);

/**
 * Check scope permissions for a ravi CLI command.
 *
 * Group-level scope enforcement is handled by enforceScopeCheck() in the CLI process.
 * The hook only needs to check session target access (inline scope checks).
 */
function checkScopePermission(
  command: string,
  toolName: string | null,
  ctx?: { agentId?: string; sessionName?: string; sessionKey?: string }
): { allowed: boolean; reason?: string } {
  if (!toolName) return { allowed: true };

  const scopeCtx = ctx ?? getScopeContext();
  if (!scopeCtx.agentId) return { allowed: true };

  // Session target commands — check if agent can access the target session
  if (SESSION_TARGET_COMMANDS.has(toolName)) {
    const target = extractRaviTarget(command);
    if (target && !canAccessSession(scopeCtx, target)) {
      return {
        allowed: false,
        reason: "Session not found",
      };
    }
  }

  return { allowed: true };
}

interface BashHookOptions {
  getBashConfig: () => BashConfig | undefined;
  getAllowedTools: () => string[] | undefined;
}

/**
 * Create a bash permission hook for the SDK.
 *
 * Validates:
 * 1. Bash CLI executable permissions (via BashConfig)
 * 2. Ravi CLI subcommand permissions (via allowedTools)
 * 3. Scope permissions (via REBAC engine)
 */
export function createBashPermissionHook(
  options: BashHookOptions
): HookCallbackMatcher {

  const bashPermissionHook: HookCallback = async (input, toolUseId, context) => {
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      return {};
    }

    // Step 0: Block RAVI_* env var spoofing (superadmins exempt — need it for testing)
    const ctx = getScopeContext();
    const isSuperadmin = !ctx.agentId || agentCan(ctx.agentId, "admin", "system", "*");
    const spoofResult = isSuperadmin ? { allowed: true } : checkEnvSpoofing(command);
    if (!spoofResult.allowed) {
      log.warn("Env spoofing blocked", {
        command: command.slice(0, 200),
        reason: spoofResult.reason,
      });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: spoofResult.reason!,
        },
      };
    }

    // Step 1: Check bash CLI permissions (executables)
    const config = options.getBashConfig();
    const bashResult = checkBashPermission(command, config);

    if (!bashResult.allowed) {
      log.warn("Bash command blocked", {
        command: command.slice(0, 200),
        reason: bashResult.reason,
        blockedExecutables: bashResult.blockedExecutables,
      });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Bash command blocked: ${bashResult.reason}`,
        },
      };
    }

    // Step 2: Check ravi CLI subcommand permissions
    const allowedTools = options.getAllowedTools();
    const raviResult = checkRaviToolPermission(command, allowedTools);

    if (!raviResult.allowed) {
      log.warn("Ravi CLI tool blocked", {
        command: command.slice(0, 200),
        tool: raviResult.toolName,
        reason: raviResult.reason,
      });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: raviResult.reason!,
        },
      };
    }

    // Step 3: Check scope permissions (via REBAC engine)
    const scopeResult = checkScopePermission(command, raviResult.toolName ?? extractRaviToolName(command), ctx);

    if (!scopeResult.allowed) {
      log.warn("Scope check blocked", {
        command: command.slice(0, 200),
        reason: scopeResult.reason,
      });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: scopeResult.reason!,
        },
      };
    }

    log.debug("Bash command allowed", {
      command: command.slice(0, 100),
      raviTool: raviResult.toolName,
    });

    return {};
  };

  return {
    matcher: "Bash",
    hooks: [bashPermissionHook],
  };
}

export type { HookCallbackMatcher };

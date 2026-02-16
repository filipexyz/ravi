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

import {
  checkDangerousPatterns,
  parseBashCommand,
  UNCONDITIONAL_BLOCKS,
} from "./parser.js";
import { logger } from "../utils/logger.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { agentCan } from "../permissions/engine.js";
import { SDK_TOOLS } from "../cli/tool-registry.js";

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
 * Extract the first positional argument from a ravi CLI command.
 * e.g. "ravi sessions send main 'msg'" → "main"
 *      "ravi sessions list" → null
 *      "ravi sessions read my-session" → "my-session"
 */
function extractRaviTarget(command: string): string | null {
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

/**
 * Check executable permissions via REBAC.
 *
 * Defense in depth:
 * 1. Check for dangerous patterns (injection attempts)
 * 2. Parse command to extract all executables
 * 3. Check each executable against unconditional blocks
 * 4. Check each executable against REBAC (execute executable:<name>)
 */
function checkExecutablePermissions(
  command: string,
  agentId: string
): { allowed: boolean; reason?: string } {
  // If agent has wildcard access, skip expensive parsing
  if (agentCan(agentId, "execute", "executable", "*")) {
    return { allowed: true };
  }

  // Step 1: Check for dangerous patterns
  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    return { allowed: false, reason: patternCheck.reason };
  }

  // Step 2: Parse command to extract executables
  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    return { allowed: false, reason: parsed.error || "Failed to parse command" };
  }

  // Step 3 & 4: Check each executable
  const blocked: string[] = [];

  for (const exec of parsed.executables) {
    // Unconditional blocks (shells, eval, exec)
    if (UNCONDITIONAL_BLOCKS.has(exec)) {
      blocked.push(exec);
      continue;
    }

    // REBAC check
    if (!agentCan(agentId, "execute", "executable", exec)) {
      blocked.push(exec);
    }
  }

  if (blocked.length > 0) {
    return {
      allowed: false,
      reason: `Permission denied: agent:${agentId} cannot execute: ${blocked.join(", ")}`,
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
        reason: `Permission denied: agent:${scopeCtx.agentId} cannot access session:${target}`,
      };
    }
  }

  return { allowed: true };
}

interface BashHookOptions {
  getAgentId: () => string | undefined;
}

/**
 * Create a bash permission hook for the SDK.
 *
 * Validates:
 * 1. Env spoofing (RAVI_* override)
 * 2. Executable permissions (via REBAC)
 * 3. Session scope (via REBAC)
 */
export function createBashPermissionHook(
  options: BashHookOptions
): HookCallbackMatcher {

  const bashPermissionHook: HookCallback = async (input, toolUseId, context) => {
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      return {};
    }

    const agentId = options.getAgentId();

    // Step 0: Block RAVI_* env var spoofing (superadmins exempt — need it for testing)
    const isSuperadmin = !agentId || agentCan(agentId, "admin", "system", "*");
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

    // Step 1: Check executable permissions via REBAC
    if (agentId) {
      const execResult = checkExecutablePermissions(command, agentId);

      if (!execResult.allowed) {
        log.warn("Executable blocked", {
          command: command.slice(0, 200),
          reason: execResult.reason,
        });

        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: execResult.reason!,
          },
        };
      }
    }

    // Step 2: Check session scope (via REBAC)
    const toolName = extractRaviToolName(command);
    const scopeResult = checkScopePermission(command, toolName);

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
      raviTool: toolName,
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
export function createToolPermissionHook(
  options: BashHookOptions
): HookCallbackMatcher {
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

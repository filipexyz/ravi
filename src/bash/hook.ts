/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against the agent's BashConfig and allowedTools.
 */

import type { BashConfig } from "./types.js";
import { checkBashPermission } from "./permissions.js";
import { logger } from "../utils/logger.js";

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
  const match = command.match(/(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+(\w+)\s+(\w+)/);
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

interface BashHookOptions {
  getBashConfig: () => BashConfig | undefined;
  getAllowedTools: () => string[] | undefined;
}

/**
 * Create a bash permission hook for the SDK.
 *
 * Validates both:
 * 1. Bash CLI executable permissions (via BashConfig)
 * 2. Ravi CLI subcommand permissions (via allowedTools)
 */
export function createBashPermissionHook(
  options: BashHookOptions
): HookCallbackMatcher {

  const bashPermissionHook: HookCallback = async (input, toolUseId, context) => {
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      return {};
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

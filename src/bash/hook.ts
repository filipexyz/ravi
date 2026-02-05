/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against the agent's BashConfig.
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
 * Create a bash permission hook for the SDK.
 *
 * @param getBashConfig Function that returns the current BashConfig for the agent.
 *                      This is called on each tool invocation to get the latest config.
 * @returns A HookCallbackMatcher that can be added to the PreToolUse hooks array.
 */
export function createBashPermissionHook(
  getBashConfig: () => BashConfig | undefined
): HookCallbackMatcher {
  const bashPermissionHook: HookCallback = async (input, toolUseId, context) => {
    // Extract the command from the tool input
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      // No command - likely a malformed request, but let SDK handle it
      return {};
    }

    // Get current config
    const config = getBashConfig();

    // Check permission
    const result = checkBashPermission(command, config);

    if (!result.allowed) {
      log.warn("Bash command blocked", {
        command: command.slice(0, 200),
        reason: result.reason,
        blockedExecutables: result.blockedExecutables,
      });

      // Return deny decision
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Bash command blocked: ${result.reason}`,
        },
      };
    }

    log.debug("Bash command allowed", {
      command: command.slice(0, 100),
    });

    // Allow the command
    return {};
  };

  return {
    matcher: "Bash",
    hooks: [bashPermissionHook],
  };
}

/**
 * Export the types for external use.
 */
export type { HookCallbackMatcher };

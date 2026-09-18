/**
 * Tool Safety Hook
 *
 * Classifies tool calls as "safe" (interruptible) or "unsafe" (has side effects).
 * Used by the delivery queue to decide whether a queued prompt (steer or
 * immediate lane) may preempt the active turn while the tool is running.
 *
 * Safe tools: read-only, no side effects — a queued prompt can cut in without harm.
 * Unsafe tools: may have side effects (write files, run commands, send messages)
 *   — queued prompts wait for them to finish.
 *
 * An explicit abort (reset, kill, delete) does not wait on this classification:
 * it cancels the running tool through the provider's native interrupt.
 */

import { logger } from "../utils/logger.js";

const log = logger.child("hooks:tool-safety");

/**
 * Tools classified as safe to interrupt (read-only, no side effects).
 * Everything NOT in this set is considered unsafe by default.
 */
const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "mcp__spec__enter_spec_mode",
  "mcp__spec__update_spec",
  "mcp__spec__exit_spec_mode",
]);

export type ToolSafety = "safe" | "unsafe";

/**
 * Check if a Bash command is a sleep (always safe to interrupt).
 */
function isBashSleep(command: string): boolean {
  return /^\s*sleep\s+/.test(command.trim());
}

/**
 * Classify a tool call as safe or unsafe.
 * For Bash, inspects the command — sleep is always safe.
 */
export function getToolSafety(toolName: string, toolInput?: Record<string, unknown>): ToolSafety {
  if (SAFE_TOOLS.has(toolName)) {
    log.debug("Tool classified", { toolName, safety: "safe" });
    return "safe";
  }

  if (toolName === "Bash" && toolInput?.command) {
    const command = toolInput.command as string;
    if (isBashSleep(command)) {
      log.debug("Bash sleep classified as safe", { command: command.slice(0, 50) });
      return "safe";
    }
  }

  log.debug("Tool classified", { toolName, safety: "unsafe" });
  return "unsafe";
}

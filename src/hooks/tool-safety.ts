/**
 * Tool Safety Hook
 *
 * Classifies tool calls as "safe" (interruptible) or "unsafe" (has side effects).
 * Used by the abort logic to decide whether to wait for a tool to finish.
 *
 * Safe tools: read-only, no side effects — can be interrupted without harm.
 * Unsafe tools: may have side effects (write files, run commands, send messages)
 *   — must complete before the session can be safely aborted.
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
  "Sleep",
]);

export type ToolSafety = "safe" | "unsafe";

/**
 * Classify a tool call as safe or unsafe.
 */
export function classifyToolSafety(toolName: string): ToolSafety {
  return SAFE_TOOLS.has(toolName) ? "safe" : "unsafe";
}

/**
 * Callback to update streaming session tool safety.
 * Called from bot.ts when tool_use blocks are detected.
 */
export function getToolSafety(toolName: string): ToolSafety {
  const safety = classifyToolSafety(toolName);
  log.debug("Tool classified", { toolName, safety });
  return safety;
}

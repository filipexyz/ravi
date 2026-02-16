/**
 * Shared constants
 */

/**
 * All built-in Claude SDK tools.
 * Used to compute disallowedTools via REBAC.
 */
export const ALL_BUILTIN_TOOLS = [
  // Core tools
  "Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write",
  "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite",
  "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Skill",
  // Additional tools
  "TaskOutput", "KillShell", "TaskStop", "LSP",
] as const;

export type BuiltinTool = typeof ALL_BUILTIN_TOOLS[number];

/**
 * Tool Registry - Central registry of all available tools
 *
 * This file avoids circular dependencies by not importing command classes directly.
 * Instead, it maintains a registry that can be populated dynamically.
 */

// SDK built-in tools
export const SDK_TOOLS = [
  // File operations
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "NotebookEdit",
  // Execution
  "Bash",
  "Task",
  "TaskOutput",
  "TaskStop",
  // Web
  "WebFetch",
  "WebSearch",
  // Planning & interaction
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "TodoWrite",
  // Teams
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
  // Discovery & navigation
  "ToolSearch",
  "EnterWorktree",
  // Other
  "Skill",
  "LSP",
];

/** Named groups of SDK tools for bulk permission grants */
export const TOOL_GROUPS: Record<string, string[]> = {
  "read-only": ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "LSP", "ToolSearch"],
  write: ["Edit", "Write", "NotebookEdit"],
  execute: ["Bash", "Task", "TaskOutput", "TaskStop"],
  plan: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "TodoWrite"],
  teams: ["TeamCreate", "TeamDelete", "SendMessage"],
  navigate: ["EnterWorktree", "Skill"],
};

/**
 * Resolve a tool group name to its member tools.
 * Returns undefined if the group doesn't exist.
 */
export function resolveToolGroup(groupName: string): string[] | undefined {
  return TOOL_GROUPS[groupName];
}

/**
 * Find which tool groups a given tool belongs to.
 */
export function getToolGroups(toolName: string): string[] {
  return Object.entries(TOOL_GROUPS)
    .filter(([, tools]) => tools.includes(toolName))
    .map(([name]) => name);
}

// CLI tool names registry (populated lazily or by registerCliTools)
let cliToolNames: string[] | null = null;
let lazyInitializer: (() => string[]) | null = null;

/**
 * Set a lazy initializer for CLI tool names.
 * Called when getCliToolNames() is invoked and registry is empty.
 */
export function setCliToolsInitializer(init: () => string[]): void {
  lazyInitializer = init;
}

/**
 * Register CLI tool names (called during initialization)
 */
export function registerCliTools(names: string[]): void {
  cliToolNames = names;
}

/**
 * Get all registered CLI tool names (lazy init if needed)
 */
export function getCliToolNames(): string[] {
  if (cliToolNames === null && lazyInitializer) {
    cliToolNames = lazyInitializer();
  }
  return cliToolNames ?? [];
}

/**
 * Get all tools (SDK + CLI)
 */
export function getAllToolNames(): string[] {
  return [...SDK_TOOLS, ...getCliToolNames()];
}

/**
 * Check if a tool name is a CLI tool
 */
export function isCliTool(name: string): boolean {
  return getCliToolNames().includes(name);
}

/**
 * Check if a tool name is an SDK tool
 */
export function isSdkTool(name: string): boolean {
  return SDK_TOOLS.includes(name);
}

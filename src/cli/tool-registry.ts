/**
 * Tool Registry - Central registry of all available tools
 *
 * This file avoids circular dependencies by not importing command classes directly.
 * Instead, it maintains a registry that can be populated dynamically.
 */

// SDK built-in tools
export const SDK_TOOLS = [
  "Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write",
  "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite",
  "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Skill",
  "TaskOutput", "KillShell", "TaskStop", "LSP",
  "TeamCreate", "TeamDelete", "SendMessage",
];

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

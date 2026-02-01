/**
 * Tool Registry - Central registry of all available tools
 *
 * This file avoids circular dependencies by not importing command classes directly.
 * Instead, it maintains a registry that can be populated dynamically.
 */

// MCP naming convention
export const MCP_SERVER = "ravi-cli";
export const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

// SDK built-in tools
export const SDK_TOOLS = [
  "Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write",
  "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite",
  "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Skill",
  "TaskOutput", "KillShell", "TaskStop", "LSP",
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
 * Get all CLI tools with full MCP names
 */
export function getCliToolsFullNames(): string[] {
  return cliToolNames.map(t => `${MCP_PREFIX}${t}`);
}

/**
 * Get all tools (SDK + CLI with full names)
 */
export function getAllToolsFullNames(): string[] {
  return [...SDK_TOOLS, ...getCliToolsFullNames()];
}

/**
 * Convert short tool name to full name (with MCP prefix if CLI tool)
 */
export function toFullToolName(shortName: string): string {
  if (cliToolNames.includes(shortName)) {
    return `${MCP_PREFIX}${shortName}`;
  }
  return shortName;
}

/**
 * Convert full tool name to short name (strip MCP prefix if present)
 */
export function toShortToolName(fullName: string): string {
  if (fullName.startsWith(MCP_PREFIX)) {
    return fullName.replace(MCP_PREFIX, "");
  }
  return fullName;
}

/**
 * Check if a tool name is a CLI tool
 */
export function isCliTool(name: string): boolean {
  const shortName = toShortToolName(name);
  return cliToolNames.includes(shortName);
}

/**
 * Check if a tool name is an SDK tool
 */
export function isSdkTool(name: string): boolean {
  return SDK_TOOLS.includes(name);
}

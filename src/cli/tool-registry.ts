/**
 * Tool Registry - Central registry of built-in runtime tools and CLI tools.
 *
 * This file avoids circular dependencies by not importing command classes directly.
 * It defines Ravi's canonical built-in tool capabilities, then exposes
 * provider-native aliases for backward compatibility.
 */

export interface RuntimeBuiltinToolDefinition {
  capability: string;
  nativeName: string;
  groups: string[];
  description: string;
  operation: "read" | "mutate" | "execute" | "ask";
  risk: "low" | "medium" | "high" | "destructive";
}

export const RUNTIME_BUILTIN_TOOLS: RuntimeBuiltinToolDefinition[] = [
  {
    capability: "fs.read",
    nativeName: "Read",
    groups: ["read-only"],
    description: "Read a local file",
    operation: "read",
    risk: "low",
  },
  {
    capability: "fs.edit",
    nativeName: "Edit",
    groups: ["write"],
    description: "Edit a local file",
    operation: "mutate",
    risk: "medium",
  },
  {
    capability: "fs.write",
    nativeName: "Write",
    groups: ["write"],
    description: "Write a local file",
    operation: "mutate",
    risk: "medium",
  },
  {
    capability: "fs.glob",
    nativeName: "Glob",
    groups: ["read-only"],
    description: "Find local files by pattern",
    operation: "read",
    risk: "low",
  },
  {
    capability: "fs.grep",
    nativeName: "Grep",
    groups: ["read-only"],
    description: "Search local file contents",
    operation: "read",
    risk: "low",
  },
  {
    capability: "fs.notebook.edit",
    nativeName: "NotebookEdit",
    groups: ["write"],
    description: "Edit a notebook",
    operation: "mutate",
    risk: "medium",
  },
  {
    capability: "exec.shell",
    nativeName: "Bash",
    groups: ["execute"],
    description: "Run a local shell command",
    operation: "execute",
    risk: "high",
  },
  {
    capability: "agent.task.start",
    nativeName: "Task",
    groups: ["execute"],
    description: "Start a delegated task",
    operation: "execute",
    risk: "medium",
  },
  {
    capability: "agent.task.output",
    nativeName: "TaskOutput",
    groups: ["execute"],
    description: "Read delegated task output",
    operation: "read",
    risk: "low",
  },
  {
    capability: "agent.task.stop",
    nativeName: "TaskStop",
    groups: ["execute"],
    description: "Stop a delegated task",
    operation: "execute",
    risk: "medium",
  },
  {
    capability: "web.fetch",
    nativeName: "WebFetch",
    groups: ["read-only"],
    description: "Fetch a web resource",
    operation: "read",
    risk: "low",
  },
  {
    capability: "web.search",
    nativeName: "WebSearch",
    groups: ["read-only"],
    description: "Search the web",
    operation: "read",
    risk: "low",
  },
  {
    capability: "plan.enter",
    nativeName: "EnterPlanMode",
    groups: ["plan"],
    description: "Enter planning mode",
    operation: "mutate",
    risk: "low",
  },
  {
    capability: "plan.exit",
    nativeName: "ExitPlanMode",
    groups: ["plan"],
    description: "Leave planning mode",
    operation: "mutate",
    risk: "low",
  },
  {
    capability: "user.ask",
    nativeName: "AskUserQuestion",
    groups: ["plan"],
    description: "Ask the user for input",
    operation: "ask",
    risk: "low",
  },
  {
    capability: "plan.todo.write",
    nativeName: "TodoWrite",
    groups: ["plan"],
    description: "Update the task plan",
    operation: "mutate",
    risk: "low",
  },
  {
    capability: "team.create",
    nativeName: "TeamCreate",
    groups: ["teams"],
    description: "Create an agent team",
    operation: "execute",
    risk: "medium",
  },
  {
    capability: "team.delete",
    nativeName: "TeamDelete",
    groups: ["teams"],
    description: "Remove an agent team",
    operation: "mutate",
    risk: "high",
  },
  {
    capability: "team.message.send",
    nativeName: "SendMessage",
    groups: ["teams"],
    description: "Send a message to an agent",
    operation: "execute",
    risk: "low",
  },
  {
    capability: "tool.search",
    nativeName: "ToolSearch",
    groups: ["read-only"],
    description: "Search available tools",
    operation: "read",
    risk: "low",
  },
  {
    capability: "workspace.enter",
    nativeName: "EnterWorktree",
    groups: ["navigate"],
    description: "Enter a workspace",
    operation: "mutate",
    risk: "low",
  },
  {
    capability: "skill.invoke",
    nativeName: "Skill",
    groups: ["navigate"],
    description: "Load a runtime skill",
    operation: "read",
    risk: "low",
  },
  {
    capability: "lsp.query",
    nativeName: "LSP",
    groups: ["read-only"],
    description: "Query the language server",
    operation: "read",
    risk: "low",
  },
];

export const SDK_TOOLS = RUNTIME_BUILTIN_TOOLS.map((tool) => tool.nativeName);
const RUNTIME_BUILTIN_TOOL_ALIASES = new Map<string, string>();
const RUNTIME_BUILTIN_TOOL_PROVIDER_ALIASES = [
  ["shell", "Bash"],
  ["command_execution", "Bash"],
  ["exec_command", "Bash"],
  ["read", "Read"],
  ["read_file", "Read"],
  ["file_read", "Read"],
  ["fs_read", "Read"],
  ["imageView", "Read"],
  ["image_view", "Read"],
  ["view_image", "Read"],
  ["edit", "Edit"],
  ["file_edit", "Edit"],
  ["fs_edit", "Edit"],
  ["file_change", "Edit"],
  ["apply_patch", "Edit"],
  ["write", "Write"],
  ["file_write", "Write"],
  ["fs_write", "Write"],
  ["glob", "Glob"],
  ["grep", "Grep"],
] as const;

for (const tool of RUNTIME_BUILTIN_TOOLS) {
  RUNTIME_BUILTIN_TOOL_ALIASES.set(normalizeToolAliasKey(tool.nativeName), tool.nativeName);
  RUNTIME_BUILTIN_TOOL_ALIASES.set(normalizeToolAliasKey(tool.capability), tool.nativeName);
}

for (const [alias, nativeName] of RUNTIME_BUILTIN_TOOL_PROVIDER_ALIASES) {
  RUNTIME_BUILTIN_TOOL_ALIASES.set(normalizeToolAliasKey(alias), nativeName);
}

export const RUNTIME_BUILTIN_TOOL_HOOK_NAMES = [
  ...new Set([
    ...SDK_TOOLS,
    ...RUNTIME_BUILTIN_TOOL_PROVIDER_ALIASES.map(([alias]) => alias),
    ...RUNTIME_BUILTIN_TOOL_PROVIDER_ALIASES.map(([alias]) => normalizeToolAliasKey(alias)),
  ]),
];

/** Named groups of built-in tools for bulk permission grants */
export const TOOL_GROUPS: Record<string, string[]> = Object.fromEntries(
  Array.from(new Set(RUNTIME_BUILTIN_TOOLS.flatMap((tool) => tool.groups))).map((group) => [
    group,
    RUNTIME_BUILTIN_TOOLS.filter((tool) => tool.groups.includes(group)).map((tool) => tool.nativeName),
  ]),
);

const BUILTIN_TOOL_BY_NATIVE_NAME = new Map(RUNTIME_BUILTIN_TOOLS.map((tool) => [tool.nativeName, tool]));
const BUILTIN_TOOL_BY_CAPABILITY = new Map(RUNTIME_BUILTIN_TOOLS.map((tool) => [tool.capability, tool]));

function normalizeToolAliasKey(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function normalizeRuntimeBuiltinToolName(toolName: string): string | null {
  const normalized = normalizeToolAliasKey(toolName);
  return RUNTIME_BUILTIN_TOOL_ALIASES.get(normalized) ?? null;
}

export function getBuiltinToolCapability(toolName: string): string | undefined {
  const nativeName = normalizeRuntimeBuiltinToolName(toolName) ?? toolName;
  return BUILTIN_TOOL_BY_NATIVE_NAME.get(nativeName)?.capability;
}

export function getRuntimeBuiltinToolDefinition(toolName: string): RuntimeBuiltinToolDefinition | undefined {
  const nativeName = normalizeRuntimeBuiltinToolName(toolName) ?? toolName;
  return BUILTIN_TOOL_BY_NATIVE_NAME.get(nativeName);
}

export function getBuiltinToolNativeName(capability: string): string | undefined {
  return BUILTIN_TOOL_BY_CAPABILITY.get(capability)?.nativeName;
}

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
  return BUILTIN_TOOL_BY_NATIVE_NAME.get(toolName)?.groups ?? [];
}

// CLI tool names registry (populated lazily or by registerCliTools)
let cliToolNames: string[] | null = null;
let lazyInitializer: (() => string[]) | null = null;

export function setCliToolsInitializer(init: () => string[]): void {
  lazyInitializer = init;
}

export function registerCliTools(names: string[]): void {
  cliToolNames = names;
}

export function getCliToolNames(): string[] {
  if (cliToolNames === null && lazyInitializer) {
    cliToolNames = lazyInitializer();
  }
  return cliToolNames ?? [];
}

export function getAllToolNames(): string[] {
  return [...SDK_TOOLS, ...getCliToolNames()];
}

export function isCliTool(name: string): boolean {
  return getCliToolNames().includes(name);
}

export function isSdkTool(name: string): boolean {
  return SDK_TOOLS.includes(name);
}

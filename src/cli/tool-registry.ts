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
}

export const RUNTIME_BUILTIN_TOOLS: RuntimeBuiltinToolDefinition[] = [
  { capability: "fs.read", nativeName: "Read", groups: ["read-only"] },
  { capability: "fs.edit", nativeName: "Edit", groups: ["write"] },
  { capability: "fs.write", nativeName: "Write", groups: ["write"] },
  { capability: "fs.glob", nativeName: "Glob", groups: ["read-only"] },
  { capability: "fs.grep", nativeName: "Grep", groups: ["read-only"] },
  { capability: "fs.notebook.edit", nativeName: "NotebookEdit", groups: ["write"] },
  { capability: "exec.shell", nativeName: "Bash", groups: ["execute"] },
  { capability: "agent.task.start", nativeName: "Task", groups: ["execute"] },
  { capability: "agent.task.output", nativeName: "TaskOutput", groups: ["execute"] },
  { capability: "agent.task.stop", nativeName: "TaskStop", groups: ["execute"] },
  { capability: "web.fetch", nativeName: "WebFetch", groups: ["read-only"] },
  { capability: "web.search", nativeName: "WebSearch", groups: ["read-only"] },
  { capability: "plan.enter", nativeName: "EnterPlanMode", groups: ["plan"] },
  { capability: "plan.exit", nativeName: "ExitPlanMode", groups: ["plan"] },
  { capability: "user.ask", nativeName: "AskUserQuestion", groups: ["plan"] },
  { capability: "plan.todo.write", nativeName: "TodoWrite", groups: ["plan"] },
  { capability: "team.create", nativeName: "TeamCreate", groups: ["teams"] },
  { capability: "team.delete", nativeName: "TeamDelete", groups: ["teams"] },
  { capability: "team.message.send", nativeName: "SendMessage", groups: ["teams"] },
  { capability: "tool.search", nativeName: "ToolSearch", groups: ["read-only"] },
  { capability: "workspace.enter", nativeName: "EnterWorktree", groups: ["navigate"] },
  { capability: "skill.invoke", nativeName: "Skill", groups: ["navigate"] },
  { capability: "lsp.query", nativeName: "LSP", groups: ["read-only"] },
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

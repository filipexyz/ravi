/**
 * Tool Definitions - CLI tool discovery, schema generation, and inspection
 */

import { extractTools, type ExportedTool } from "./tools-export.js";
import type { CommandSafetyMetadata } from "./decorators.js";
import { setCliToolsInitializer } from "./tool-registry.js";
import { extractOptionName, isBooleanOption } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

type CommandClass = new () => object;

export interface SdkToolDefinition {
  name: string;
  description: string;
  operationKind: CommandSafetyMetadata["operationKind"];
  effectClass: CommandSafetyMetadata["effectClass"];
  risk: CommandSafetyMetadata["risk"];
  requiresConfirmation: boolean;
  classificationSource: CommandSafetyMetadata["classificationSource"];
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface CreateSdkToolsOptions {
  filter?: string | RegExp;
}

// ============================================================================
// Command Classes & Cache
// ============================================================================

// Lazy-loaded command classes (avoids circular dependency)
let _commandClasses: CommandClass[] | null = null;

/**
 * Get all command classes (lazy loaded).
 */
export function getAllCommandClasses(): CommandClass[] {
  if (!_commandClasses) {
    // Dynamic import to avoid circular dependency at load time
    const allCommands = require("./commands/index.js");
    _commandClasses = Object.values(allCommands) as CommandClass[];
  }
  return _commandClasses;
}

// Cache extracted tools - they don't change at runtime
let _cachedTools: ExportedTool[] | null = null;

function getCachedTools(): ExportedTool[] {
  if (!_cachedTools) {
    _cachedTools = extractTools(getAllCommandClasses());
  }
  return _cachedTools;
}

// Set lazy initializer for tool registry (avoids circular dependency)
setCliToolsInitializer(() => getCachedTools().map((t) => t.name));

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all CLI tool names.
 */
export function getAllCliToolNames(): string[] {
  return getCachedTools().map((t) => t.name);
}

export function getCliToolDefinition(name: string): ExportedTool | undefined {
  return getCachedTools().find((tool) => tool.name === name);
}

/**
 * Get CLI tools grouped by command group.
 */
export function getCliToolsByGroup(): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const tool of getCachedTools()) {
    const [group] = tool.name.split("_");
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(tool.name);
  }

  return groups;
}

/**
 * Create SDK tool definitions (JSON Schema format).
 * Used for inspection and documentation.
 */
export function createSdkTools(classes: CommandClass[], options: CreateSdkToolsOptions = {}): SdkToolDefinition[] {
  const { filter } = options;

  // Do not initialize the complete command catalog merely to compare array
  // identity. Focused callers and tests must remain proportional to the command
  // classes they supplied. The cache is used only after getAllCommandClasses()
  // has already established the canonical array.
  let tools = _commandClasses !== null && classes === _commandClasses ? getCachedTools() : extractTools(classes);

  if (filter) {
    const regex = typeof filter === "string" ? new RegExp(filter) : filter;
    tools = tools.filter((t) => regex.test(t.name));
  }

  return tools.map(toSdkDefinition);
}

/**
 * Generate JSON Schema manifest for all tools.
 */
export function generateToolsJsonSchema(classes: CommandClass[]): object {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Ravi CLI Tools",
    description: "CLI commands available as Agent SDK tools",
    tools: createSdkTools(classes),
  };
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Convert to JSON Schema format (for inspection/docs).
 */
function toSdkDefinition(tool: ExportedTool): SdkToolDefinition {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  for (const arg of tool.metadata.args) {
    properties[arg.name] = { type: "string" };
    if (arg.description) properties[arg.name].description = arg.description;
    if (arg.required !== false) required.push(arg.name);
  }

  for (const opt of tool.metadata.options) {
    const optName = extractOptionName(opt.flags);
    properties[optName] = { type: isBooleanOption(opt.flags) ? "boolean" : "string" };
    if (opt.description) properties[optName].description = opt.description;
  }

  return {
    name: tool.name,
    description: tool.description,
    operationKind: tool.metadata.safety.operationKind,
    effectClass: tool.metadata.safety.effectClass,
    risk: tool.metadata.safety.risk,
    requiresConfirmation: tool.metadata.safety.requiresConfirmation,
    classificationSource: tool.metadata.safety.classificationSource,
    inputSchema: { type: "object", properties, required },
  };
}

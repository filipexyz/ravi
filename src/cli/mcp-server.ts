/**
 * MCP Server - CLI commands as MCP tools for Claude Agent SDK
 */

import { createSdkMcpServer as sdkCreateMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { extractTools, type ExportedTool } from "./tools-export.js";
import { registerCliTools } from "./tool-registry.js";
import { extractOptionName, isBooleanOption } from "./utils.js";

import { AgentsCommands } from "./commands/agents.js";
import { DaemonCommands } from "./commands/daemon.js";
import { ServiceCommands } from "./commands/service.js";
import { ContactsCommands } from "./commands/contacts.js";
import { ChannelsCommands } from "./commands/channels.js";

// ============================================================================
// Types
// ============================================================================

type CommandClass = new () => object;

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  allowedTools?: string[];
}

export type McpServer = ReturnType<typeof sdkCreateMcpServer>;

export interface SdkToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface CreateSdkToolsOptions {
  filter?: string | RegExp;
  allowedTools?: string[];
}

// ============================================================================
// Command Classes & Cache
// ============================================================================

export const ALL_COMMAND_CLASSES: CommandClass[] = [
  AgentsCommands,
  DaemonCommands,
  ServiceCommands,
  ContactsCommands,
  ChannelsCommands,
];

// Cache extracted tools - they don't change at runtime
let _cachedTools: ExportedTool[] | null = null;

function getCachedTools(): ExportedTool[] {
  if (!_cachedTools) {
    _cachedTools = extractTools(ALL_COMMAND_CLASSES);
  }
  return _cachedTools;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the tool registry. Call this once at startup.
 */
export function initCliTools(): void {
  const names = getCachedTools().map((t) => t.name);
  registerCliTools(names);
}

/**
 * Create an MCP server from CLI commands.
 */
export function createCliMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const { name = "ravi-cli", version = "1.0.0", allowedTools } = options;

  let tools = getCachedTools();

  if (allowedTools) {
    tools = tools.filter((t) => allowedTools.includes(t.name));
  }

  return sdkCreateMcpServer({
    name,
    version,
    tools: tools.map(convertToSdkTool),
  });
}

/**
 * Get all CLI tool names.
 */
export function getAllCliToolNames(): string[] {
  return getCachedTools().map((t) => t.name);
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
export function createSdkTools(
  classes: CommandClass[],
  options: CreateSdkToolsOptions = {}
): SdkToolDefinition[] {
  const { filter, allowedTools } = options;

  // Use cache if using default classes, otherwise extract fresh
  let tools = classes === ALL_COMMAND_CLASSES ? getCachedTools() : extractTools(classes);

  if (filter) {
    const regex = typeof filter === "string" ? new RegExp(filter) : filter;
    tools = tools.filter((t) => regex.test(t.name));
  }

  if (allowedTools) {
    tools = tools.filter((t) => allowedTools.includes(t.name));
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
    inputSchema: { type: "object", properties, required },
  };
}

/**
 * Convert to SDK's native tool format (with Zod schema).
 */
function convertToSdkTool(t: ExportedTool) {
  const schema: Record<string, z.ZodTypeAny> = {};

  for (const arg of t.metadata.args) {
    let s = z.string();
    if (arg.description) s = s.describe(arg.description);
    schema[arg.name] = arg.required === false ? s.optional() : s;
  }

  for (const opt of t.metadata.options) {
    const name = extractOptionName(opt.flags);
    let s: z.ZodTypeAny = isBooleanOption(opt.flags) ? z.boolean() : z.string();
    if (opt.description) s = s.describe(opt.description);
    schema[name] = s.optional();
  }

  return tool(t.name, t.description, schema, async (args) => {
    return t.handler(args as Record<string, unknown>);
  });
}

/**
 * CLI Exports - Public API for CLI tools infrastructure
 */

export {
  extractTools,
  generateManifest,
  manifestToJSON,
  type ExportedTool,
  type ToolResult,
  type ToolManifestEntry,
} from "./tools-export.js";

export {
  initCliTools,
  createCliMcpServer,
  getAllCliToolNames,
  getCliToolsByGroup,
  createSdkTools,
  generateToolsJsonSchema,
  ALL_COMMAND_CLASSES,
  type McpServer,
  type CreateMcpServerOptions,
  type SdkToolDefinition,
  type CreateSdkToolsOptions,
} from "./mcp-server.js";

export {
  MCP_SERVER,
  MCP_PREFIX,
  SDK_TOOLS,
  registerCliTools,
  getCliToolNames,
  getCliToolsFullNames,
  getAllToolsFullNames,
  toFullToolName,
  toShortToolName,
  isCliTool,
  isSdkTool,
} from "./tool-registry.js";

export {
  runWithContext,
  getContext,
  getContextValue,
  hasContext,
  type ToolContext,
} from "./context.js";

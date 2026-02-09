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
  getAllCliToolNames,
  getCliToolsByGroup,
  createSdkTools,
  generateToolsJsonSchema,
  getAllCommandClasses,
  type SdkToolDefinition,
  type CreateSdkToolsOptions,
} from "./tool-definitions.js";

export {
  SDK_TOOLS,
  registerCliTools,
  getCliToolNames,
  getAllToolNames,
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

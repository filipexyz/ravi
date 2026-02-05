/**
 * CLI Tools Export - Extract CLI commands as tool definitions
 */

import {
  getGroupMetadata,
  getCommandsMetadata,
  getArgsMetadata,
  getOptionsMetadata,
  type ArgMetadata,
  type OptionMetadata,
} from "./decorators.js";
import { extractOptionName, inferOptionType } from "./utils.js";
import { notif } from "../notif.js";
import { getContext } from "./context.js";

// ============================================================================
// Types
// ============================================================================

type CommandClass = new () => object;

/** Exported tool definition */
export interface ExportedTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  metadata: {
    group: string;
    command: string;
    method: string;
    args: ArgMetadata[];
    options: OptionMetadata[];
  };
}

/** Tool execution result */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Manifest entry for documentation/inspection */
export interface ToolManifestEntry {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
    defaultValue?: unknown;
  }>;
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Extract all tools from decorated command classes.
 */
export function extractTools(classes: CommandClass[]): ExportedTool[] {
  const tools: ExportedTool[] = [];

  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;

    const commandsMeta = getCommandsMetadata(cls);
    if (commandsMeta.length === 0) continue;

    const instance = new cls();

    for (const cmdMeta of commandsMeta) {
      const argsMeta = getArgsMetadata(instance, cmdMeta.method);
      const optionsMeta = getOptionsMetadata(instance, cmdMeta.method);

      tools.push({
        name: `${groupMeta.name}_${cmdMeta.name}`,
        description: cmdMeta.description,
        handler: buildHandler(
          instance,
          cmdMeta.method,
          argsMeta,
          optionsMeta,
          `${groupMeta.name}_${cmdMeta.name}`,
          groupMeta.name,
          cmdMeta.name
        ),
        metadata: {
          group: groupMeta.name,
          command: cmdMeta.name,
          method: cmdMeta.method,
          args: argsMeta,
          options: optionsMeta,
        },
      });
    }
  }

  return tools;
}

/**
 * Generate a manifest of all tools for documentation/inspection.
 */
export function generateManifest(tools: ExportedTool[]): ToolManifestEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: [
      ...tool.metadata.args.map((arg) => ({
        name: arg.name,
        type: "string",
        required: arg.required ?? true,
        description: arg.description,
        defaultValue: arg.defaultValue,
      })),
      ...tool.metadata.options.map((opt) => ({
        name: extractOptionName(opt.flags),
        type: inferOptionType(opt.flags),
        required: false,
        description: opt.description,
        defaultValue: opt.defaultValue,
      })),
    ],
  }));
}

/**
 * Format manifest as JSON for SDK consumption.
 */
export function manifestToJSON(tools: ExportedTool[]): string {
  const manifest = generateManifest(tools);
  return JSON.stringify(manifest, null, 2);
}

// ============================================================================
// Internal Helpers
// ============================================================================

const MAX_INPUT_LENGTH = 500;

function truncateForEvent(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_INPUT_LENGTH
      ? value.slice(0, MAX_INPUT_LENGTH) + "…"
      : value;
  }
  if (value && typeof value === "object") {
    const truncated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      truncated[k] = truncateForEvent(v);
    }
    return truncated;
  }
  return value;
}

/**
 * Build handler function that executes the command method.
 */
function buildHandler(
  instance: object,
  methodName: string,
  args: ArgMetadata[],
  options: OptionMetadata[],
  toolName: string,
  group: string,
  command: string
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (toolArgs: Record<string, unknown>): Promise<ToolResult> => {
    const ctx = getContext();
    const sessionKey = ctx?.sessionKey ?? "_cli";
    const agentId = ctx?.agentId;

    notif
      .emit(`ravi.${sessionKey}.cli.${group}.${command}`, {
        event: "start",
        tool: toolName,
        input: truncateForEvent(toolArgs),
        timestamp: new Date().toISOString(),
        sessionKey,
        agentId,
      })
      .catch(() => {});

    const startTime = Date.now();

    // Capture console output
    const output: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      output.push(`[ERROR] ${args.map(String).join(" ")}`);
    };

    let isError = false;

    try {
      // Build args array in parameter order
      const finalArgs: unknown[] = [];
      const totalParams = args.length + options.length;

      for (let i = 0; i < totalParams; i++) {
        // Check if this index is an arg
        const argAtIndex = args.find((a) => a.index === i);
        if (argAtIndex) {
          finalArgs.push(toolArgs[argAtIndex.name]);
          continue;
        }

        // Check if this index is an option
        const optAtIndex = options.find((o) => o.index === i);
        if (optAtIndex) {
          const optName = extractOptionName(optAtIndex.flags);
          finalArgs.push(toolArgs[optName]);
        }
      }

      // Call the method
      const method = (instance as Record<string, Function>)[methodName];
      const result = method.apply(instance, finalArgs);

      // Handle async methods
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      isError = true;
      output.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Restore console
      console.log = originalLog;
      console.error = originalError;
    }

    const text = output.join("\n").trim() || "(no output)";

    notif
      .emit(`ravi.${sessionKey}.cli.${group}.${command}`, {
        event: "end",
        tool: toolName,
        output: truncateForEvent(text),
        isError,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        sessionKey,
        agentId,
      })
      .catch(() => {});

    return {
      content: [{ type: "text", text }],
      isError,
    };
  };
}


/** @jsxImportSource @opentui/react */

import { useState, useCallback } from "react";
import type { ToolMessage } from "../hooks/useNats.js";

interface ToolBlockProps {
  tool: ToolMessage;
}

/**
 * Formats tool input for display.
 * For Bash-like tools, shows the command. Otherwise shows truncated JSON.
 */
function formatInput(toolName: string, input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  const obj = input as Record<string, unknown>;
  // Bash tool: show the command
  if (toolName === "Bash" && typeof obj.command === "string") {
    return `$ ${obj.command}`;
  }
  // Read tool: show file path
  if (toolName === "Read" && typeof obj.file_path === "string") {
    return `file: ${obj.file_path}`;
  }
  // Write tool: show file path
  if (toolName === "Write" && typeof obj.file_path === "string") {
    return `file: ${obj.file_path}`;
  }
  // Edit tool: show file path
  if (toolName === "Edit" && typeof obj.file_path === "string") {
    return `file: ${obj.file_path}`;
  }
  // Grep tool: show pattern
  if (toolName === "Grep" && typeof obj.pattern === "string") {
    return `pattern: ${obj.pattern}`;
  }
  // Glob tool: show pattern
  if (toolName === "Glob" && typeof obj.pattern === "string") {
    return `pattern: ${obj.pattern}`;
  }
  // Generic: truncated JSON
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 117) + "..." : json;
}

/**
 * Formats tool output for display.
 */
function formatOutput(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") {
    return output.length > 2000 ? output.slice(0, 1997) + "..." : output;
  }
  const json = JSON.stringify(output, null, 2);
  return json.length > 2000 ? json.slice(0, 1997) + "..." : json;
}

/**
 * Generates a short summary for the collapsed tool header.
 */
function toolSummary(toolName: string, input: unknown): string {
  if (!input) return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "Bash" && typeof obj.command === "string") {
    const cmd = obj.command;
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if (toolName === "Read" && typeof obj.file_path === "string") {
    return obj.file_path as string;
  }
  if (toolName === "Write" && typeof obj.file_path === "string") {
    return obj.file_path as string;
  }
  if (toolName === "Edit" && typeof obj.file_path === "string") {
    return obj.file_path as string;
  }
  if (toolName === "Grep" && typeof obj.pattern === "string") {
    return obj.pattern as string;
  }
  if (toolName === "Glob" && typeof obj.pattern === "string") {
    return obj.pattern as string;
  }
  return "";
}

/**
 * Collapsible inline block for tool executions.
 *
 * - Running state: shows spinner icon with tool name
 * - Collapsed state (default for done): single line with tool name, summary, and duration
 * - Expanded state: shows full input and output
 */
export function ToolBlock({ tool }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    if (tool.status === "done") {
      setExpanded((prev) => !prev);
    }
  }, [tool.status]);

  const isRunning = tool.status === "running";
  const icon = isRunning ? "\u27F3" : expanded ? "\u25BC" : "\u25B6";
  const summary = toolSummary(tool.toolName, tool.input);
  const durationStr =
    tool.durationMs != null ? `${tool.durationMs}ms` : "";

  // Header line
  const headerParts = [
    `${icon} [${tool.toolName}]`,
    summary ? ` ${summary}` : "",
    isRunning ? " ..." : "",
    durationStr ? `  ${durationStr}` : "",
  ];
  const headerText = headerParts.join("");
  const headerColor = isRunning
    ? "yellow"
    : tool.isError
      ? "red"
      : "gray";

  if (!expanded) {
    return (
      <box width="100%" marginBottom={0} onClick={toggle}>
        <text content={headerText} fg={headerColor} />
      </box>
    );
  }

  // Expanded: show input and output
  const inputStr = formatInput(tool.toolName, tool.input);
  const outputStr = formatOutput(tool.output);
  const outputColor = tool.isError ? "red" : "white";
  const border = "\u2514" + "\u2500".repeat(40);

  return (
    <box flexDirection="column" width="100%" marginBottom={0} onClick={toggle}>
      <text content={headerText} fg={headerColor} />
      {inputStr ? (
        <text content={`\u2502 ${inputStr}`} fg="cyan" />
      ) : null}
      {outputStr ? (
        <text
          content={outputStr
            .split("\n")
            .map((line) => `\u2502 ${line}`)
            .join("\n")}
          fg={outputColor}
        />
      ) : null}
      <text content={border} fg="gray" />
    </box>
  );
}

import { createHash } from "node:crypto";
import type {
  RuntimeDynamicToolCallContentItem,
  RuntimeDynamicToolCallResult,
  RuntimeDynamicToolSpec,
} from "../runtime/types.js";

export interface OpenAiRealtimeFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RaviRealtimeToolEntry extends OpenAiRealtimeFunctionTool {
  runtimeToolName: string;
}

export interface RaviRealtimeToolManifest {
  kind: "ravi.meetings.realtime_tools";
  version: 1;
  generatedAt: string;
  agentId?: string;
  sessionName?: string;
  contextId?: string;
  toolCount: number;
  tools: RaviRealtimeToolEntry[];
}

export interface BuildRaviRealtimeToolManifestInput {
  tools: RuntimeDynamicToolSpec[];
  agentId?: string;
  sessionName?: string;
  contextId?: string;
  generatedAt?: string;
}

const REALTIME_TOOL_NAME_MAX_LENGTH = 64;

export function buildRaviRealtimeToolManifest(input: BuildRaviRealtimeToolManifestInput): RaviRealtimeToolManifest {
  const usedNames = new Set<string>();
  const tools = input.tools
    .filter((tool) => !isInternalRealtimeBridgeTool(tool.name))
    .map((tool) => toRaviRealtimeToolEntry(tool, usedNames));

  return {
    kind: "ravi.meetings.realtime_tools",
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionName ? { sessionName: input.sessionName } : {}),
    ...(input.contextId ? { contextId: input.contextId } : {}),
    toolCount: tools.length,
    tools,
  };
}

export function toOpenAiRealtimeTool(entry: RaviRealtimeToolEntry): OpenAiRealtimeFunctionTool {
  return {
    type: "function",
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
  };
}

export function serializeRuntimeDynamicToolResultForRealtime(
  toolName: string,
  result: RuntimeDynamicToolCallResult,
): Record<string, unknown> {
  return {
    ok: result.success,
    tool: toolName,
    content: result.contentItems.map(serializeContentItemForRealtime),
    ...(result.reason ? { reason: truncateRealtimeText(result.reason) } : {}),
  };
}

function toRaviRealtimeToolEntry(tool: RuntimeDynamicToolSpec, usedNames: Set<string>): RaviRealtimeToolEntry {
  const name = uniqueRealtimeToolName(tool.name, usedNames);
  usedNames.add(name);
  return {
    type: "function",
    name,
    runtimeToolName: tool.name,
    description: tool.description || `Run Ravi tool ${tool.name}.`,
    parameters: normalizeRealtimeParameters(tool.inputSchema),
  };
}

function isInternalRealtimeBridgeTool(name: string): boolean {
  return name === "meetings_realtime-tools" || name === "meetings_realtime-call";
}

function uniqueRealtimeToolName(name: string, usedNames: Set<string>): string {
  const sanitized = sanitizeRealtimeToolName(name);
  if (!usedNames.has(sanitized)) return sanitized;

  const suffix = `_${hashSuffix(name)}`;
  const base = sanitized.slice(0, Math.max(1, REALTIME_TOOL_NAME_MAX_LENGTH - suffix.length));
  let candidate = `${base}${suffix}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    const numberedSuffix = `${suffix}_${counter++}`;
    candidate = `${base.slice(0, Math.max(1, REALTIME_TOOL_NAME_MAX_LENGTH - numberedSuffix.length))}${numberedSuffix}`;
  }
  return candidate;
}

export function sanitizeRealtimeToolName(name: string): string {
  const sanitized =
    name
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[-_]+|[-_]+$/g, "") || "ravi_tool";
  if (sanitized.length <= REALTIME_TOOL_NAME_MAX_LENGTH) return sanitized;
  const suffix = `_${hashSuffix(name)}`;
  return `${sanitized.slice(0, REALTIME_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function hashSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function normalizeRealtimeParameters(schema: unknown): Record<string, unknown> {
  const source = recordOrEmpty(schema);
  const properties = recordOrEmpty(source.properties);
  const required = Array.isArray(source.required)
    ? source.required.filter((item): item is string => typeof item === "string")
    : [];

  return {
    ...source,
    type: "object",
    properties: jsonClone(properties),
    required,
    additionalProperties: source.additionalProperties ?? false,
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const REALTIME_TOOL_TEXT_MAX_CHARS = 4000;

function serializeContentItemForRealtime(item: RuntimeDynamicToolCallContentItem): Record<string, unknown> {
  if (item.type === "inputImage") {
    return { type: "input_image", imageUrl: item.imageUrl };
  }
  return { type: "text", text: truncateRealtimeText(item.text) };
}

function truncateRealtimeText(text: string): string {
  if (text.length <= REALTIME_TOOL_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, REALTIME_TOOL_TEXT_MAX_CHARS)}\n\n[...truncated by ravi realtime bridge]`;
}

import { sanitizePublicValue } from "../cli/redaction.js";
import { buildKimiCodeRequest, type KimiCodeStreamEvent } from "./kimi-code-transport.js";
import type { RuntimeDynamicToolCallResult, RuntimeDynamicToolSpec, RuntimeStartRequest } from "./types.js";

export const KIMI_CODE_MAX_TOOL_ROUNDS = 8;
export const KIMI_CODE_MAX_TOOL_CALLS = 32;
const MAX_KIMI_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_KIMI_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_KIMI_ACCUMULATED_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface KimiCodeToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

export type KimiCodeTerminalFinishReason = "stop" | "tool_calls";

export interface KimiCodeNativeError {
  status?: number;
  code?: string;
  type?: string;
  requestId?: string;
}

export type KimiCodeNativeProtocolCode =
  | "incomplete_tool_call"
  | "inconsistent_finish_reason"
  | "invalid_finish_reason"
  | "invalid_tool_index"
  | "invalid_usage"
  | "missing_finish_reason"
  | "terminal_content_filter"
  | "terminal_length"
  | "tool_identity_mutation"
  | "unrecognized_event";

export class KimiCodeNativeProtocolError extends Error {
  constructor(readonly code: KimiCodeNativeProtocolCode) {
    super(code);
    this.name = "KimiCodeNativeProtocolError";
  }
}

/** @internal Completed provider-native state for tool and session continuation. */
export interface KimiCodeCompletedTurn {
  finishReason: KimiCodeTerminalFinishReason;
  text: string;
  reasoning: string;
  toolCalls: KimiCodeToolCallFragment[];
  usage?: KimiCodeUsage;
}

export interface KimiCodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type KimiCodeConversationMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoning_content: string;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ValidKimiCodeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  publicArguments: unknown;
  rawArguments: string;
}

interface ParsedKimiCodeChoice {
  content?: string;
  reasoning?: string;
  toolCalls: KimiCodeToolCallFragment[];
  finishReason?: string;
}

interface ParsedKimiCodeChunk {
  choices: ParsedKimiCodeChoice[];
  usage?: KimiCodeUsagePatch;
  nativeError?: KimiCodeNativeError;
}

interface ParsedKimiCodeUsage {
  usage: KimiCodeUsagePatch;
  recognized: boolean;
}

interface KimiCodeUsagePatch {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type KimiCodeTurnChunkResult =
  | { kind: "accepted"; textDeltas: string[]; reasoningDelta: boolean; finished: boolean }
  | { kind: "malformed"; code: KimiCodeNativeProtocolCode }
  | { kind: "provider_error"; nativeError: KimiCodeNativeError }
  | {
      kind: "post_finish" | "response_limit" | "tool_argument_limit";
    };

/** @internal Deterministic Kimi chunk assembly boundary for Tasks 4 and 5. */
export function createKimiCodeCompletedTurnAccumulator(): {
  accept(data: unknown): KimiCodeTurnChunkResult;
  complete(): KimiCodeCompletedTurn;
} {
  let text = "";
  let reasoning = "";
  let usage: KimiCodeUsagePatch | undefined;
  let finishReason: KimiCodeTerminalFinishReason | undefined;
  let accumulatedResponseBytes = 0;
  const toolCalls = new Map<number, KimiCodeToolCallFragment>();

  return {
    accept(data) {
      const chunk = parseKimiCodeChunk({ type: "message", data });
      if ("code" in chunk) return { kind: "malformed", code: chunk.code };
      if (chunk.nativeError) return { kind: "provider_error", nativeError: chunk.nativeError };
      const textDeltas = chunk.choices.flatMap((choice) => (choice.content ? [choice.content] : []));
      const reasoningDelta = chunk.choices.some((choice) => Boolean(choice.reasoning));
      const hasPostFinishDelta =
        textDeltas.length > 0 || reasoningDelta || chunk.choices.some((choice) => choice.toolCalls.length > 0);
      if (finishReason && hasPostFinishDelta) return { kind: "post_finish" };
      const nextToolCalls = new Map([...toolCalls.entries()].map(([index, fragment]) => [index, { ...fragment }]));
      for (const choice of chunk.choices) {
        const mergeError = mergeToolCallFragments(nextToolCalls, choice.toolCalls);
        if (mergeError) return { kind: "malformed", code: mergeError };
      }
      const terminalReasons = chunk.choices.flatMap((choice) => (choice.finishReason ? [choice.finishReason] : []));
      for (const terminalReason of terminalReasons) {
        if (terminalReason === "length" || terminalReason === "content_filter") {
          return { kind: "malformed", code: `terminal_${terminalReason}` };
        }
        if (finishReason && finishReason !== terminalReason) {
          return { kind: "malformed", code: "inconsistent_finish_reason" };
        }
        if (terminalReason === "tool_calls" && !hasCompleteToolCalls(nextToolCalls)) {
          return { kind: "malformed", code: "incomplete_tool_call" };
        }
        if (terminalReason === "stop" && nextToolCalls.size > 0) {
          return { kind: "malformed", code: "inconsistent_finish_reason" };
        }
      }
      const fragmentBytes = chunk.choices.reduce(
        (total, choice) =>
          total +
          utf8Length(choice.content ?? "") +
          utf8Length(choice.reasoning ?? "") +
          choice.toolCalls.reduce(
            (toolTotal, fragment) =>
              toolTotal +
              utf8Length(fragment.id ?? "") +
              utf8Length(fragment.name ?? "") +
              utf8Length(fragment.arguments),
            0,
          ),
        0,
      );
      if (accumulatedResponseBytes + fragmentBytes > MAX_KIMI_ACCUMULATED_RESPONSE_BYTES) {
        return { kind: "response_limit" };
      }
      const projectedToolArgumentBytes = new Map<number, number>();
      for (const choice of chunk.choices) {
        for (const fragment of choice.toolCalls) {
          const currentBytes =
            projectedToolArgumentBytes.get(fragment.index) ??
            utf8Length(toolCalls.get(fragment.index)?.arguments ?? "");
          const nextBytes = currentBytes + utf8Length(fragment.arguments);
          if (nextBytes > MAX_KIMI_TOOL_ARGUMENT_BYTES) return { kind: "tool_argument_limit" };
          projectedToolArgumentBytes.set(fragment.index, nextBytes);
        }
      }
      if (chunk.usage) usage = mergeKimiCodeUsage(usage, chunk.usage);
      for (const choice of chunk.choices) {
        if (choice.content) text += choice.content;
        if (choice.reasoning) reasoning += choice.reasoning;
        if (choice.finishReason === "stop" || choice.finishReason === "tool_calls") finishReason = choice.finishReason;
      }
      toolCalls.clear();
      for (const [index, fragment] of nextToolCalls) toolCalls.set(index, fragment);
      accumulatedResponseBytes += fragmentBytes;
      return { kind: "accepted", textDeltas, reasoningDelta, finished: finishReason !== undefined };
    },
    complete() {
      if (!finishReason) throw protocol("missing_finish_reason");
      return completeKimiCodeTurn({ finishReason, text, reasoning, toolCalls, usage });
    },
  };
}

export function createKimiCodeTurnRequest(
  input: RuntimeStartRequest,
  messages: readonly KimiCodeConversationMessage[],
  sessionId: string,
) {
  const request = buildKimiCodeRequest(input, messages as Parameters<typeof buildKimiCodeRequest>[1], sessionId);
  return {
    ...request,
    body: {
      ...request.body,
      ...(input.dynamicTools?.length ? { tools: input.dynamicTools.map(toKimiCodeToolSpec) } : {}),
    },
    signal: input.abortController.signal,
  };
}

export function validateKimiCodeToolCalls(
  toolCalls: readonly KimiCodeToolCallFragment[],
  seenIds: ReadonlySet<string>,
): ValidKimiCodeToolCall[] | null {
  const batchIds = new Set<string>();
  const valid: ValidKimiCodeToolCall[] = [];
  for (const toolCall of toolCalls) {
    const id = toolCall.id;
    const name = toolCall.name;
    if (!id?.trim() || !name?.trim() || seenIds.has(id) || batchIds.has(id)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.arguments);
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    batchIds.add(id);
    valid.push({
      id,
      name,
      arguments: parsed,
      publicArguments: sanitizePublicValue(parsed),
      rawArguments: toolCall.arguments,
    });
  }
  return valid;
}

export function createKimiCodeToolResultViews(result: RuntimeDynamicToolCallResult): {
  providerContent: string;
  publicContent: unknown;
} {
  const providerContent = boundUtf8(
    result.contentItems.map((item) => (item.type === "inputText" ? item.text : "[image omitted]")).join("\n"),
    MAX_KIMI_TOOL_RESULT_BYTES,
  );
  return { providerContent, publicContent: sanitizePublicValue(providerContent) };
}

export function addKimiCodeUsage(current: KimiCodeUsage, next: KimiCodeUsage): KimiCodeUsage {
  const cacheReadTokens = checkedAddTokenCounts(current.cacheReadTokens ?? 0, next.cacheReadTokens ?? 0);
  const cacheCreationTokens = checkedAddTokenCounts(current.cacheCreationTokens ?? 0, next.cacheCreationTokens ?? 0);
  return {
    inputTokens: checkedAddTokenCounts(current.inputTokens, next.inputTokens),
    outputTokens: checkedAddTokenCounts(current.outputTokens, next.outputTokens),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
  };
}

function toKimiCodeToolSpec(tool: RuntimeDynamicToolSpec) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function boundUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const suffix = "\n[truncated]";
  const suffixBytes = encoder.encode(suffix);
  const prefixLimit = Math.max(0, maximumBytes - suffixBytes.byteLength - 3);
  return `${new TextDecoder().decode(encoded.slice(0, prefixLimit))}${suffix}`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseKimiCodeChunk(
  event: Extract<KimiCodeStreamEvent, { type: "message" }>,
): ParsedKimiCodeChunk | { code: KimiCodeNativeProtocolCode } {
  if (!isRecord(event.data)) return { code: "unrecognized_event" };
  if (event.data.error !== undefined) {
    if (!isRecord(event.data.error)) return { code: "unrecognized_event" };
    return { choices: [], nativeError: projectKimiCodeNativeError(event.data.error) };
  }
  const choicesValue = event.data.choices;
  const usageValue = event.data.usage;
  if (choicesValue === undefined && usageValue === undefined) return { code: "unrecognized_event" };
  if (choicesValue !== undefined && !Array.isArray(choicesValue)) return { code: "unrecognized_event" };
  const parsedUsage = usageValue === undefined ? undefined : parseKimiCodeUsage(usageValue);
  if (parsedUsage && "code" in parsedUsage) return parsedUsage;
  const usage = parsedUsage?.usage;
  let recognized = parsedUsage?.recognized ?? false;
  if (choicesValue === undefined) {
    return recognized ? { choices: [], ...(usage ? { usage } : {}) } : { code: "unrecognized_event" };
  }
  if (choicesValue.length > 1) return { code: "unrecognized_event" };
  const choices: ParsedKimiCodeChoice[] = [];
  for (const rawChoice of choicesValue) {
    if (!isRecord(rawChoice)) return { code: "unrecognized_event" };
    if (rawChoice.index !== undefined && rawChoice.index !== 0) return { code: "unrecognized_event" };
    const delta = rawChoice.delta === undefined ? {} : rawChoice.delta;
    if (!isRecord(delta)) return { code: "unrecognized_event" };
    const toolCalls = parseToolCallFragments(delta.tool_calls);
    if (!toolCalls || "code" in toolCalls) return toolCalls ?? { code: "unrecognized_event" };
    if (delta.content !== undefined && typeof delta.content !== "string") return { code: "unrecognized_event" };
    if (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string")
      return { code: "unrecognized_event" };
    const finishReason = rawChoice.finish_reason;
    if (finishReason !== undefined && finishReason !== null && !isKimiCodeFinishReason(finishReason)) {
      return { code: "invalid_finish_reason" };
    }
    recognized ||=
      delta.content !== undefined ||
      delta.reasoning_content !== undefined ||
      delta.tool_calls !== undefined ||
      finishReason !== undefined;
    choices.push({
      ...(typeof delta.content === "string" ? { content: delta.content } : {}),
      ...(typeof delta.reasoning_content === "string" ? { reasoning: delta.reasoning_content } : {}),
      toolCalls,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
    });
  }
  return recognized ? { choices, ...(usage ? { usage } : {}) } : { code: "unrecognized_event" };
}

function isKimiCodeFinishReason(value: unknown): value is "stop" | "length" | "tool_calls" | "content_filter" {
  return value === "stop" || value === "length" || value === "tool_calls" || value === "content_filter";
}

function parseToolCallFragments(
  value: unknown,
): KimiCodeToolCallFragment[] | { code: KimiCodeNativeProtocolCode } | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const fragments: KimiCodeToolCallFragment[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const raw = value[position];
    if (!isRecord(raw)) return null;
    const fn = raw.function === undefined ? {} : raw.function;
    if (!isRecord(fn)) return null;
    const index = raw.index === undefined ? position : raw.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= KIMI_CODE_MAX_TOOL_CALLS) {
      return { code: "invalid_tool_index" };
    }
    if (raw.id !== undefined && typeof raw.id !== "string") return null;
    if (fn.name !== undefined && typeof fn.name !== "string") return null;
    if (fn.arguments !== undefined && typeof fn.arguments !== "string") return null;
    fragments.push({
      index,
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      ...(typeof fn.name === "string" ? { name: fn.name } : {}),
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    });
  }
  return fragments;
}

function mergeToolCallFragments(
  toolCalls: Map<number, KimiCodeToolCallFragment>,
  fragments: readonly KimiCodeToolCallFragment[],
): "tool_identity_mutation" | undefined {
  for (const fragment of fragments) {
    const current = toolCalls.get(fragment.index) ?? { index: fragment.index, arguments: "" };
    if (
      (current.id && fragment.id && current.id !== fragment.id) ||
      (current.name && fragment.name && current.name !== fragment.name)
    ) {
      return "tool_identity_mutation";
    }
    toolCalls.set(fragment.index, {
      index: fragment.index,
      ...((fragment.id ?? current.id) ? { id: fragment.id ?? current.id } : {}),
      ...((fragment.name ?? current.name) ? { name: fragment.name ?? current.name } : {}),
      arguments: current.arguments + fragment.arguments,
    });
  }
  return undefined;
}

function hasCompleteToolCalls(toolCalls: ReadonlyMap<number, KimiCodeToolCallFragment>): boolean {
  return (
    toolCalls.size > 0 &&
    [...toolCalls.values()].every(
      (toolCall) => Boolean(toolCall.id?.trim()) && Boolean(toolCall.name?.trim()) && toolCall.arguments.length > 0,
    )
  );
}

function completeKimiCodeTurn(input: {
  finishReason: KimiCodeTerminalFinishReason;
  text: string;
  reasoning: string;
  toolCalls: ReadonlyMap<number, KimiCodeToolCallFragment>;
  usage?: KimiCodeUsagePatch;
}): KimiCodeCompletedTurn {
  const usage =
    input.usage?.inputTokens !== undefined && input.usage.outputTokens !== undefined
      ? {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          ...(input.usage.cacheReadTokens !== undefined ? { cacheReadTokens: input.usage.cacheReadTokens } : {}),
          ...(input.usage.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: input.usage.cacheCreationTokens }
            : {}),
        }
      : undefined;
  return {
    finishReason: input.finishReason,
    text: input.text,
    reasoning: input.reasoning,
    toolCalls: [...input.toolCalls.values()].sort((left, right) => left.index - right.index),
    ...(usage ? { usage } : {}),
  };
}

function mergeKimiCodeUsage(current: KimiCodeUsagePatch | undefined, value: KimiCodeUsagePatch): KimiCodeUsagePatch {
  return {
    ...((value.inputTokens ?? current?.inputTokens) !== undefined
      ? { inputTokens: value.inputTokens ?? current?.inputTokens }
      : {}),
    ...((value.outputTokens ?? current?.outputTokens) !== undefined
      ? { outputTokens: value.outputTokens ?? current?.outputTokens }
      : {}),
    ...((value.cacheReadTokens ?? current?.cacheReadTokens) !== undefined
      ? { cacheReadTokens: value.cacheReadTokens ?? current?.cacheReadTokens }
      : {}),
    ...((value.cacheCreationTokens ?? current?.cacheCreationTokens) !== undefined
      ? { cacheCreationTokens: value.cacheCreationTokens ?? current?.cacheCreationTokens }
      : {}),
  };
}

function parseKimiCodeUsage(value: unknown): ParsedKimiCodeUsage | { code: KimiCodeNativeProtocolCode } {
  if (!isRecord(value)) return { code: "invalid_usage" };
  try {
    const details = value.prompt_tokens_details;
    if (details !== undefined && !isRecord(details)) throw protocol("invalid_usage");
    const hasCacheReadTokens = details?.cached_tokens !== undefined || value.cache_read_input_tokens !== undefined;
    const recognized =
      value.prompt_tokens !== undefined ||
      value.completion_tokens !== undefined ||
      hasCacheReadTokens ||
      value.cache_creation_input_tokens !== undefined;
    return {
      usage: {
        ...(value.prompt_tokens !== undefined ? { inputTokens: checkedTokenCount(value.prompt_tokens) } : {}),
        ...(value.completion_tokens !== undefined ? { outputTokens: checkedTokenCount(value.completion_tokens) } : {}),
        ...(hasCacheReadTokens
          ? { cacheReadTokens: checkedTokenCount(details?.cached_tokens ?? value.cache_read_input_tokens) }
          : {}),
        ...(value.cache_creation_input_tokens !== undefined
          ? { cacheCreationTokens: checkedTokenCount(value.cache_creation_input_tokens) }
          : {}),
      },
      recognized,
    };
  } catch (error) {
    if (error instanceof KimiCodeNativeProtocolError) return { code: error.code };
    throw error;
  }
}

function checkedTokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocol("invalid_usage");
  return value as number;
}

function checkedAddTokenCounts(left: unknown, right: unknown): number {
  const total = checkedTokenCount(left) + checkedTokenCount(right);
  if (!Number.isSafeInteger(total)) throw protocol("invalid_usage");
  return total;
}

function projectKimiCodeNativeError(error: Record<string, unknown>): KimiCodeNativeError {
  const status = error.status;
  const code = safeNativeToken(error.code);
  const type = safeNativeToken(error.type);
  const requestId = safeNativeToken(error.request_id) ?? safeNativeToken(error.requestId);
  return {
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function safeNativeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : undefined;
}

function protocol(code: KimiCodeNativeProtocolCode): KimiCodeNativeProtocolError {
  return new KimiCodeNativeProtocolError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

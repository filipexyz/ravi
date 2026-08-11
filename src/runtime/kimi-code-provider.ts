import { KIMI_CODE_PROVIDER_ID, type KimiCodeModel } from "./kimi-code-models.js";
import {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  type KimiCodeStreamEvent,
  type KimiCodeTransport,
} from "./kimi-code-transport.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import type {
  RuntimeDynamicToolCallResult,
  RuntimeDynamicToolSpec,
  RuntimeEvent,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

const MAX_KIMI_TOOL_ROUNDS = 8;
const MAX_KIMI_TOOL_CALLS = 32;
const MAX_KIMI_TOOL_RESULT_BYTES = 64 * 1024;

export { KIMI_CODE_CREDENTIAL_ENV_KEY } from "./kimi-code-models.js";
export {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  type KimiCodeStreamEvent,
  type KimiCodeTransport,
  type KimiCodeTransportRequest,
} from "./kimi-code-transport.js";

export interface KimiCodeRuntimeProvider extends SessionRuntimeProvider {
  id: typeof KIMI_CODE_PROVIDER_ID;
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export interface CreateKimiCodeRuntimeProviderOptions {
  defaultModel?: KimiCodeModel["id"];
  /** Creates a transport per provider turn so callers can supply offline fixtures. */
  transportFactory?: () => KimiCodeTransport;
}

export function createKimiCodeRuntimeProvider(
  options: CreateKimiCodeRuntimeProviderOptions = {},
): KimiCodeRuntimeProvider {
  return {
    id: KIMI_CODE_PROVIDER_ID,
    getCapabilities() {
      return {
        runtimeControl: { supported: false, operations: [] },
        dynamicTools: { mode: "host" },
        execution: { mode: "external-service" },
        sessionState: { mode: "file-backed", requiresCwdMatch: true },
        usage: { semantics: "terminal-event" },
        tools: { permissionMode: "ravi-host", accessRequirement: "tool_surface", supportsParallelCalls: false },
        systemPrompt: { mode: "append" },
        terminalEvents: { guarantee: "adapter" },
        skillVisibility: { availability: "none", loadedState: "none" },
        supportsSessionResume: true,
        supportsSessionFork: false,
        supportsPartialText: true,
        supportsToolHooks: false,
        supportsHostSessionHooks: false,
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
        toolAccessRequirement: "tool_surface",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      const hostServices = input.hostServices;
      if (!hostServices) {
        return { startRequest: { dynamicTools: [] } };
      }
      return {
        startRequest: {
          dynamicTools: hostServices.listDynamicTools(),
          handleRuntimeToolCall: (request) => hostServices.executeDynamicTool(request),
        },
      };
    },
    startSession(input: RuntimeStartRequest): RuntimeSessionHandle {
      return createKimiCodeSession(input, options.transportFactory ?? createKimiCodeHttpTransport);
    },
  };
}

export interface KimiCodeToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

/** @internal Completed provider-native state for the future tool/session continuation work. */
export interface KimiCodeCompletedTurn {
  text: string;
  reasoning: string;
  toolCalls: KimiCodeToolCallFragment[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

function createKimiCodeSession(
  input: RuntimeStartRequest,
  transportFactory: () => KimiCodeTransport,
): RuntimeSessionHandle {
  let closed = false;
  let activeTurn: KimiCodeActiveTurn | undefined;
  const closeTurnTransport = async (turn: KimiCodeActiveTurn) => {
    if (!turn.transport || turn.transportClosed) return;
    turn.transportClosed = true;
    try {
      await turn.transport.close();
    } catch {
      // Transport teardown must not expose provider internals after terminalization.
    }
  };
  return {
    provider: KIMI_CODE_PROVIDER_ID,
    events: (async function* () {
      for await (const prompt of input.prompt) {
        const terminalTracker = createRuntimeTerminalEventTracker();
        const metadata = { provider: KIMI_CODE_PROVIDER_ID };
        if (closed || input.abortController.signal.aborted) {
          const terminal = terminalTracker.interrupt({ metadata });
          if (terminal) yield terminal;
          if (input.abortController.signal.aborted) break;
          continue;
        }

        const turn: KimiCodeActiveTurn = { interrupted: false, transportClosed: false };
        activeTurn = turn;
        yield {
          type: "turn.started",
          turn: { id: prompt.clientMessageId ?? prompt.session_id, status: "in_progress" },
          metadata,
        };
        let thinkingPublished = false;
        let completedUsage: KimiCodeCompletedTurn["usage"] = { inputTokens: 0, outputTokens: 0 };
        let toolRounds = 0;
        let totalToolCalls = 0;
        const seenToolCallIds = new Set<string>();
        const messages: KimiCodeConversationMessage[] = [{ role: "user", content: prompt.message.content }];

        try {
          turnLoop: while (!terminalTracker.terminalEmitted) {
            if (turn.interrupted || closed || input.abortController.signal.aborted) {
              const terminal = terminalTracker.interrupt({ metadata });
              if (terminal) yield terminal;
              break;
            }

            turn.transport = transportFactory();
            turn.transportClosed = false;
            if (turn.interrupted || closed || input.abortController.signal.aborted) {
              const terminal = terminalTracker.interrupt({ metadata });
              if (terminal) yield terminal;
              break;
            }

            const accumulator = createKimiCodeCompletedTurnAccumulator();
            let providerDone = false;
            const request = createKimiCodeTurnRequest(input, messages, prompt.session_id);
            try {
              for await (const event of turn.transport.stream(request)) {
                if (turn.interrupted || closed || input.abortController.signal.aborted) {
                  const terminal = terminalTracker.interrupt({ metadata });
                  if (terminal) yield terminal;
                  break;
                }

                if (event.type === "eof") {
                  const terminal = terminalTracker.fail({
                    error: "Kimi Code stream ended before completion",
                    recoverable: true,
                    metadata,
                  });
                  if (terminal) yield terminal;
                  break;
                }
                if (event.type === "done") {
                  providerDone = true;
                  break;
                }

                const accepted = accumulator.accept(event.data);
                if (accepted.kind !== "accepted") {
                  const terminal = terminalTracker.fail({
                    error: "Kimi Code stream failed",
                    recoverable: true,
                    metadata,
                  });
                  if (terminal) yield terminal;
                  break;
                }
                if (accepted.reasoningDelta && !thinkingPublished) {
                  thinkingPublished = true;
                  yield { type: "status", status: "thinking", metadata };
                }
                for (const text of accepted.textDeltas) {
                  if (text) yield { type: "text.delta", text, metadata };
                }
              }
            } finally {
              await closeTurnTransport(turn);
            }

            if (terminalTracker.terminalEmitted) break;
            if (!providerDone) {
              const terminal = terminalTracker.fail({
                error: "Kimi Code stream ended before completion",
                recoverable: true,
                metadata,
              });
              if (terminal) yield terminal;
              break;
            }

            const completed = accumulator.complete();
            completedUsage = addKimiCodeUsage(completedUsage, completed.usage);
            if (completed.toolCalls.length === 0) {
              yield { type: "assistant.message", text: completed.text, metadata };
              const terminal: RuntimeEvent = {
                type: "turn.complete",
                execution: { provider: KIMI_CODE_PROVIDER_ID, model: input.model, billingType: "subscription" },
                usage: completedUsage,
                metadata,
              };
              if (terminalTracker.accept(terminal)) yield terminal;
              break;
            }

            if (
              toolRounds >= MAX_KIMI_TOOL_ROUNDS ||
              totalToolCalls + completed.toolCalls.length > MAX_KIMI_TOOL_CALLS
            ) {
              const terminal = terminalTracker.fail({ error: "Kimi Code tool loop limit exceeded", metadata });
              if (terminal) yield terminal;
              break;
            }

            const toolCalls = validateKimiCodeToolCalls(completed.toolCalls, seenToolCallIds);
            if (!toolCalls || !input.handleRuntimeToolCall) {
              const terminal = terminalTracker.fail({
                error: toolCalls ? "Kimi Code dynamic tool handler is unavailable" : "Kimi Code tool call was invalid",
                metadata,
              });
              if (terminal) yield terminal;
              break;
            }

            toolRounds += 1;
            totalToolCalls += toolCalls.length;
            for (const call of toolCalls) seenToolCallIds.add(call.id);
            messages.push({
              role: "assistant",
              content: completed.text,
              reasoning_content: completed.reasoning,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.rawArguments },
              })),
            });

            for (const call of toolCalls) {
              if (turn.interrupted || closed || input.abortController.signal.aborted) {
                const terminal = terminalTracker.interrupt({ metadata });
                if (terminal) yield terminal;
                break turnLoop;
              }

              yield {
                type: "tool.started",
                toolUse: { id: call.id, name: call.name, input: call.arguments },
                metadata,
              };
              if (turn.interrupted || closed || input.abortController.signal.aborted) {
                const terminal = terminalTracker.interrupt({ metadata });
                if (terminal) yield terminal;
                break turnLoop;
              }

              let result: RuntimeDynamicToolCallResult;
              try {
                result = await input.handleRuntimeToolCall({
                  toolName: call.name,
                  callId: call.id,
                  arguments: call.arguments,
                });
              } catch {
                result = {
                  success: false,
                  contentItems: [{ type: "inputText", text: "Tool execution failed." }],
                };
              }
              const content = kimiCodeToolResultText(result);
              yield {
                type: "tool.completed",
                toolUseId: call.id,
                toolName: call.name,
                content,
                isError: !result.success,
                metadata,
              };
              yield { type: "tool.result_delivered", toolCallId: call.id, metadata };
              messages.push({ role: "tool", tool_call_id: call.id, content });
            }
          }
        } catch {
          const terminal =
            turn.interrupted || closed || input.abortController.signal.aborted
              ? terminalTracker.interrupt({ metadata })
              : terminalTracker.fail({ error: "Kimi Code stream failed", recoverable: true, metadata });
          if (terminal) yield terminal;
        } finally {
          await closeTurnTransport(turn);
          if (activeTurn === turn) activeTurn = undefined;
        }
      }
    })(),
    interrupt: async () => {
      if (!activeTurn || activeTurn.interrupted) return;
      activeTurn.interrupted = true;
      await closeTurnTransport(activeTurn);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (!activeTurn) return;
      activeTurn.interrupted = true;
      await closeTurnTransport(activeTurn);
    },
  };
}

interface KimiCodeActiveTurn {
  interrupted: boolean;
  transport?: KimiCodeTransport;
  transportClosed: boolean;
}

type KimiCodeConversationMessage =
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

interface ValidKimiCodeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

function createKimiCodeTurnRequest(
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

function validateKimiCodeToolCalls(
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
    valid.push({ id, name, arguments: parsed, rawArguments: toolCall.arguments });
  }
  return valid;
}

function kimiCodeToolResultText(result: RuntimeDynamicToolCallResult): string {
  const text = result.contentItems
    .map((item) => (item.type === "inputText" ? item.text : "[image omitted]"))
    .join("\n");
  return boundUtf8(text, MAX_KIMI_TOOL_RESULT_BYTES);
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

function addKimiCodeUsage(
  current: KimiCodeCompletedTurn["usage"],
  next: KimiCodeCompletedTurn["usage"],
): KimiCodeCompletedTurn["usage"] {
  const cacheReadTokens = (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  const cacheCreationTokens = (current.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0);
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
  };
}

interface ParsedKimiCodeChoice {
  content?: string;
  reasoning?: string;
  toolCalls: KimiCodeToolCallFragment[];
  finishReason?: string;
}

interface ParsedKimiCodeChunk {
  choices: ParsedKimiCodeChoice[];
  usage?: Record<string, unknown>;
  error: boolean;
}

export type KimiCodeTurnChunkResult =
  | { kind: "accepted"; textDeltas: string[]; reasoningDelta: boolean; finished: boolean }
  | { kind: "malformed" | "provider_error" | "post_finish" };

/** @internal Deterministic Kimi chunk assembly boundary for Tasks 4 and 5. */
export function createKimiCodeCompletedTurnAccumulator(): {
  accept(data: unknown): KimiCodeTurnChunkResult;
  complete(): KimiCodeCompletedTurn;
} {
  let text = "";
  let reasoning = "";
  let usage: KimiCodeCompletedTurn["usage"] = { inputTokens: 0, outputTokens: 0 };
  let finished = false;
  const toolCalls = new Map<number, KimiCodeToolCallFragment>();

  return {
    accept(data) {
      const chunk = parseKimiCodeChunk({ type: "message", data });
      if (!chunk) return { kind: "malformed" };
      if (chunk.error) return { kind: "provider_error" };
      const textDeltas = chunk.choices.flatMap((choice) => (choice.content ? [choice.content] : []));
      const reasoningDelta = chunk.choices.some((choice) => Boolean(choice.reasoning));
      const hasPostFinishDelta =
        textDeltas.length > 0 || reasoningDelta || chunk.choices.some((choice) => choice.toolCalls.length > 0);
      if (finished && hasPostFinishDelta) return { kind: "post_finish" };
      if (chunk.usage) usage = mergeKimiCodeUsage(usage, chunk.usage);
      for (const choice of chunk.choices) {
        if (choice.content) text += choice.content;
        if (choice.reasoning) reasoning += choice.reasoning;
        mergeToolCallFragments(toolCalls, choice.toolCalls);
        if (choice.finishReason) finished = true;
      }
      return { kind: "accepted", textDeltas, reasoningDelta, finished };
    },
    complete() {
      return completeKimiCodeTurn({ text, reasoning, toolCalls, usage });
    },
  };
}

function parseKimiCodeChunk(event: Extract<KimiCodeStreamEvent, { type: "message" }>): ParsedKimiCodeChunk | null {
  if (!isRecord(event.data)) return null;
  if (event.data.error !== undefined) return { choices: [], error: true };
  const choicesValue = event.data.choices;
  if (choicesValue === undefined) {
    return { choices: [], usage: isRecord(event.data.usage) ? event.data.usage : undefined, error: false };
  }
  if (!Array.isArray(choicesValue)) return null;
  if (choicesValue.length > 1) return null;
  const choices: ParsedKimiCodeChoice[] = [];
  for (const rawChoice of choicesValue) {
    if (!isRecord(rawChoice)) return null;
    if (rawChoice.index !== undefined && rawChoice.index !== 0) return null;
    const delta = rawChoice.delta === undefined ? {} : rawChoice.delta;
    if (!isRecord(delta)) return null;
    const toolCalls = parseToolCallFragments(delta.tool_calls);
    if (!toolCalls) return null;
    if (delta.content !== undefined && typeof delta.content !== "string") return null;
    if (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string") return null;
    const finishReason = rawChoice.finish_reason;
    if (finishReason !== undefined && finishReason !== null && !isKimiCodeFinishReason(finishReason)) return null;
    choices.push({
      ...(typeof delta.content === "string" ? { content: delta.content } : {}),
      ...(typeof delta.reasoning_content === "string" ? { reasoning: delta.reasoning_content } : {}),
      toolCalls,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
    });
  }
  return { choices, usage: isRecord(event.data.usage) ? event.data.usage : undefined, error: false };
}

function isKimiCodeFinishReason(value: unknown): value is "stop" | "length" | "tool_calls" | "content_filter" {
  return value === "stop" || value === "length" || value === "tool_calls" || value === "content_filter";
}

function parseToolCallFragments(value: unknown): KimiCodeToolCallFragment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const fragments: KimiCodeToolCallFragment[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const raw = value[position];
    if (!isRecord(raw)) return null;
    const fn = raw.function === undefined ? {} : raw.function;
    if (!isRecord(fn)) return null;
    const index = typeof raw.index === "number" && Number.isInteger(raw.index) ? raw.index : position;
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
): void {
  for (const fragment of fragments) {
    const current = toolCalls.get(fragment.index) ?? { index: fragment.index, arguments: "" };
    toolCalls.set(fragment.index, {
      index: fragment.index,
      ...((fragment.id ?? current.id) ? { id: fragment.id ?? current.id } : {}),
      ...((fragment.name ?? current.name) ? { name: fragment.name ?? current.name } : {}),
      arguments: current.arguments + fragment.arguments,
    });
  }
}

function completeKimiCodeTurn(input: {
  text: string;
  reasoning: string;
  toolCalls: ReadonlyMap<number, KimiCodeToolCallFragment>;
  usage: KimiCodeCompletedTurn["usage"];
}): KimiCodeCompletedTurn {
  return {
    text: input.text,
    reasoning: input.reasoning,
    toolCalls: [...input.toolCalls.values()].sort((left, right) => left.index - right.index),
    usage: input.usage,
  };
}

function mergeKimiCodeUsage(
  current: KimiCodeCompletedTurn["usage"],
  value: Record<string, unknown>,
): KimiCodeCompletedTurn["usage"] {
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const cacheReadTokens = readTokenCount(details.cached_tokens) ?? readTokenCount(value.cache_read_input_tokens);
  const cacheCreationTokens = readTokenCount(value.cache_creation_input_tokens);
  return {
    inputTokens: readTokenCount(value.prompt_tokens) ?? current.inputTokens,
    outputTokens: readTokenCount(value.completion_tokens) ?? current.outputTokens,
    ...((cacheReadTokens ?? current.cacheReadTokens) !== undefined
      ? { cacheReadTokens: cacheReadTokens ?? current.cacheReadTokens }
      : {}),
    ...((cacheCreationTokens ?? current.cacheCreationTokens) !== undefined
      ? { cacheCreationTokens: cacheCreationTokens ?? current.cacheCreationTokens }
      : {}),
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

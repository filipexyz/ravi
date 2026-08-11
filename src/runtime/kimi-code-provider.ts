import { KIMI_CODE_PROVIDER_ID, type KimiCodeModel } from "./kimi-code-models.js";
import {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  type KimiCodeStreamEvent,
  type KimiCodeTransport,
} from "./kimi-code-transport.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import type {
  RuntimeEvent,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

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

interface KimiCodeToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

/** Private result boundary consumed by the future Kimi tool/session continuation work. */
interface KimiCodeCompletedTurn {
  text: string;
  reasoning: string;
  toolCalls: KimiCodeToolCallFragment[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

function createKimiCodeSession(
  input: RuntimeStartRequest,
  transportFactory: () => KimiCodeTransport,
): RuntimeSessionHandle {
  let interrupted = false;
  let closed = false;
  let activeTransport: KimiCodeTransport | undefined;
  let activeTransportClosed = false;
  const closeActiveTransport = async () => {
    if (!activeTransport || activeTransportClosed) return;
    activeTransportClosed = true;
    await activeTransport.close();
  };
  return {
    provider: KIMI_CODE_PROVIDER_ID,
    events: (async function* () {
      for await (const prompt of input.prompt) {
        const terminalTracker = createRuntimeTerminalEventTracker();
        const metadata = { provider: KIMI_CODE_PROVIDER_ID };
        if (interrupted || closed || input.abortController.signal.aborted) {
          const terminal = terminalTracker.interrupt({ metadata });
          if (terminal) yield terminal;
          continue;
        }

        yield {
          type: "turn.started",
          turn: { id: prompt.clientMessageId ?? prompt.session_id, status: "in_progress" },
          metadata,
        };

        let text = "";
        let reasoning = "";
        let thinkingPublished = false;
        let sawDone = false;
        let usage: KimiCodeCompletedTurn["usage"] = { inputTokens: 0, outputTokens: 0 };
        const toolCalls = new Map<number, KimiCodeToolCallFragment>();

        try {
          activeTransport = transportFactory();
          activeTransportClosed = false;
          const request = {
            ...buildKimiCodeRequest(input, [{ role: "user", content: prompt.message.content }], prompt.session_id),
            signal: input.abortController.signal,
          };
          for await (const event of activeTransport.stream(request)) {
            if (interrupted || closed || input.abortController.signal.aborted) {
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
              sawDone = true;
              const completed = completeKimiCodeTurn({ text, reasoning, toolCalls, usage });
              yield { type: "assistant.message", text: completed.text, metadata };
              const terminal: RuntimeEvent = {
                type: "turn.complete",
                execution: { provider: KIMI_CODE_PROVIDER_ID, model: input.model, billingType: "subscription" },
                usage: completed.usage,
                metadata,
              };
              if (terminalTracker.accept(terminal)) yield terminal;
              break;
            }

            const chunk = parseKimiCodeChunk(event);
            if (!chunk) {
              const terminal = terminalTracker.fail({ error: "Kimi Code stream failed", recoverable: true, metadata });
              if (terminal) yield terminal;
              break;
            }
            if (chunk.error) {
              const terminal = terminalTracker.fail({ error: "Kimi Code stream failed", recoverable: true, metadata });
              if (terminal) yield terminal;
              break;
            }
            if (chunk.usage) usage = mergeKimiCodeUsage(usage, chunk.usage);
            for (const choice of chunk.choices) {
              if (choice.reasoning) {
                reasoning += choice.reasoning;
                if (!thinkingPublished) {
                  thinkingPublished = true;
                  yield { type: "status", status: "thinking", metadata };
                }
              }
              if (choice.content) {
                text += choice.content;
                yield { type: "text.delta", text: choice.content, metadata };
              }
              mergeToolCallFragments(toolCalls, choice.toolCalls);
            }
          }
          if (!terminalTracker.terminalEmitted) {
            const terminal =
              interrupted || closed || input.abortController.signal.aborted
                ? terminalTracker.interrupt({ metadata })
                : terminalTracker.fail({
                    error: sawDone ? "Kimi Code stream failed" : "Kimi Code stream ended before completion",
                    recoverable: true,
                    metadata,
                  });
            if (terminal) yield terminal;
          }
        } catch {
          const terminal =
            interrupted || closed || input.abortController.signal.aborted
              ? terminalTracker.interrupt({ metadata })
              : terminalTracker.fail({ error: "Kimi Code stream failed", recoverable: true, metadata });
          if (terminal) yield terminal;
        } finally {
          activeTransport = undefined;
          activeTransportClosed = false;
        }
      }
    })(),
    interrupt: async () => {
      if (interrupted) return;
      interrupted = true;
      await closeActiveTransport();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closeActiveTransport();
    },
  };
}

interface ParsedKimiCodeChoice {
  content?: string;
  reasoning?: string;
  toolCalls: KimiCodeToolCallFragment[];
}

interface ParsedKimiCodeChunk {
  choices: ParsedKimiCodeChoice[];
  usage?: Record<string, unknown>;
  error: boolean;
}

function parseKimiCodeChunk(event: Extract<KimiCodeStreamEvent, { type: "message" }>): ParsedKimiCodeChunk | null {
  if (!isRecord(event.data)) return null;
  if (event.data.error !== undefined) return { choices: [], error: true };
  const choicesValue = event.data.choices;
  if (choicesValue === undefined) {
    return { choices: [], usage: isRecord(event.data.usage) ? event.data.usage : undefined, error: false };
  }
  if (!Array.isArray(choicesValue)) return null;
  const choices: ParsedKimiCodeChoice[] = [];
  for (const rawChoice of choicesValue) {
    if (!isRecord(rawChoice)) return null;
    const delta = rawChoice.delta === undefined ? {} : rawChoice.delta;
    if (!isRecord(delta)) return null;
    const toolCalls = parseToolCallFragments(delta.tool_calls);
    if (!toolCalls) return null;
    if (delta.content !== undefined && typeof delta.content !== "string") return null;
    if (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string") return null;
    choices.push({
      ...(typeof delta.content === "string" ? { content: delta.content } : {}),
      ...(typeof delta.reasoning_content === "string" ? { reasoning: delta.reasoning_content } : {}),
      toolCalls,
    });
  }
  return { choices, usage: isRecord(event.data.usage) ? event.data.usage : undefined, error: false };
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

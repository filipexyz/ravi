import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeControlState,
  RuntimeEvent,
  RuntimeEventMetadata,
  RuntimeExecutionMetadata,
  RuntimePrepareSessionResult,
  RuntimePromptMessage,
  RuntimeSessionHandle,
  RuntimeSessionState,
  RuntimeSkillVisibilitySnapshot,
  RuntimeStartRequest,
  RuntimeToolUse,
  RuntimeUsage,
  SessionRuntimeProvider,
} from "./types.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import { emptySkillVisibilitySnapshot } from "./skill-visibility.js";

const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_PI_RESPONSE_TIMEOUT_MS = 30_000;
const PI_INTERRUPT_GRACE_MS = 1_000;
const DEFAULT_PI_MODEL_PROVIDER = "openai";

const PI_RUNTIME_CONTROL_OPERATIONS: RuntimeControlOperation[] = [
  "session.new",
  "session.read",
  "session.switch",
  "session.compact",
  "turn.steer",
  "turn.follow_up",
  "turn.interrupt",
  "model.set",
  "thinking.set",
];

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface PiModel {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
}

interface PiUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
}

interface PiAgentMessage extends Record<string, unknown> {
  role?: unknown;
  content?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  responseId?: unknown;
  usage?: PiUsage;
  stopReason?: unknown;
  errorMessage?: unknown;
  timestamp?: unknown;
}

interface PiRpcSessionState extends Record<string, unknown> {
  model?: PiModel | null;
  thinkingLevel?: unknown;
  isStreaming?: unknown;
  isCompacting?: unknown;
  steeringMode?: unknown;
  followUpMode?: unknown;
  sessionFile?: unknown;
  sessionId?: unknown;
  sessionName?: unknown;
  messageCount?: unknown;
  pendingMessageCount?: unknown;
}

export interface PiRpcStartInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
  modelArg?: string;
  thinkingLevel?: PiThinkingLevel;
  systemPromptAppend?: string;
}

export interface PiRpcCommand extends Record<string, unknown> {
  id?: string;
  type: string;
}

export interface PiRpcResponse extends Record<string, unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcEvent extends Record<string, unknown> {
  type: string;
}

export interface PiRpcTransport {
  events: AsyncIterable<PiRpcEvent>;
  start(input: PiRpcStartInput): Promise<void> | void;
  send(command: PiRpcCommand): Promise<PiRpcResponse>;
  close(): Promise<void>;
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

interface PendingRequest {
  resolve(response: PiRpcResponse): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PiSessionRuntimeState {
  activeTurn: boolean;
  interrupted: boolean;
  currentState?: PiRpcSessionState;
  started: boolean;
  transport?: PiRpcTransport;
  pendingSteers: string[];
}

interface CreatePiRpcSubprocessTransportOptions {
  command?: string;
  commandArgs?: string[];
  responseTimeoutMs?: number;
}

export interface CreatePiRuntimeProviderOptions extends CreatePiRpcSubprocessTransportOptions {
  transport?: PiRpcTransport;
  transportFactory?: () => PiRpcTransport;
}

export interface PiRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export function createPiRuntimeProvider(options: CreatePiRuntimeProviderOptions = {}): PiRuntimeProvider {
  return {
    id: "pi",
    getCapabilities() {
      return {
        runtimeControl: {
          supported: true,
          operations: PI_RUNTIME_CONTROL_OPERATIONS,
        },
        dynamicTools: {
          mode: "none",
        },
        execution: {
          mode: "subprocess-rpc",
        },
        sessionState: {
          mode: "file-backed",
          requiresCwdMatch: true,
        },
        usage: {
          semantics: "terminal-event",
        },
        tools: {
          permissionMode: "provider-native",
          accessRequirement: "tool_and_executable",
          supportsParallelCalls: false,
        },
        systemPrompt: {
          mode: "append",
        },
        terminalEvents: {
          guarantee: "adapter",
        },
        skillVisibility: {
          availability: "none",
          loadedState: "none",
        },
        supportsSessionResume: true,
        supportsSessionFork: false,
        supportsPartialText: true,
        supportsToolHooks: false,
        supportsHostSessionHooks: false,
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
        toolAccessRequirement: "tool_and_executable",
      };
    },
    prepareSession(): RuntimePrepareSessionResult {
      return {};
    },
    startSession(input) {
      const createTransport =
        options.transportFactory ??
        (options.transport
          ? () => options.transport!
          : () =>
              createPiRpcSubprocessTransport({
                command: options.command,
                commandArgs: options.commandArgs,
                responseTimeoutMs: options.responseTimeoutMs,
              }));
      const canRestartTransport = Boolean(options.transportFactory) || !options.transport;
      const initialTransport = createTransport();
      const skillVisibility = emptySkillVisibilitySnapshot();
      const state: PiSessionRuntimeState = {
        activeTurn: false,
        interrupted: false,
        started: false,
        transport: initialTransport,
        pendingSteers: [],
      };

      const requireTransport = () => {
        if (!state.transport) {
          throw new Error("Pi RPC transport is not connected");
        }
        return state.transport;
      };

      return {
        provider: "pi",
        skillVisibility,
        events: runPiTurns(input, createTransport, state, { canRestartTransport, skillVisibility }),
        interrupt: async () => {
          state.interrupted = true;
          const transport = state.transport;
          if (transport) {
            await safePiCommand(transport, { type: "abort" });
          }
        },
        setModel: async (model) => {
          const parsed = parsePiModelSelector(model);
          await sendPiCommand(requireTransport(), {
            type: "set_model",
            provider: parsed.provider ?? defaultPiModelProvider(),
            modelId: parsed.modelId ?? model,
          });
        },
        control: (request) => controlPiRuntime(state, request),
      };
    },
  };
}

function createPiRpcSubprocessTransport(options: CreatePiRpcSubprocessTransportOptions = {}): PiRpcTransport {
  const command = options.command ?? process.env.RAVI_PI_COMMAND ?? DEFAULT_PI_COMMAND;
  const commandArgs = options.commandArgs ?? [];
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_PI_RESPONSE_TIMEOUT_MS;
  const queue = createAsyncQueue<PiRpcEvent>();
  const pending = new Map<string, PendingRequest>();

  let child: ChildProcessWithoutNullStreams | null = null;
  let nextRequestId = 1;
  let stderr = "";
  let stopStdoutReader: (() => void) | null = null;
  let closed = true;
  let intentionalClose = false;
  let closeFailure: Error | null = null;

  const failPending = (error: unknown) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const failure = new Error(
        `Invalid Pi RPC JSONL event: ${error instanceof Error ? error.message : String(error)}`,
      );
      queue.fail(failure);
      failPending(failure);
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === "response" && typeof parsed.id === "string" && pending.has(parsed.id)) {
      const request = pending.get(parsed.id)!;
      pending.delete(parsed.id);
      clearTimeout(request.timeout);
      request.resolve(parsed as PiRpcResponse);
      return;
    }

    queue.push(parsed as PiRpcEvent);
  };

  return {
    events: queue,
    async start(input) {
      if (child) {
        throw new Error("Pi RPC transport is already started");
      }

      const args = buildPiRpcProcessArgs(input, commandArgs);
      stderr = "";
      closeFailure = null;
      closed = false;
      intentionalClose = false;
      child = spawn(command, args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      stopStdoutReader = attachStrictJsonlLineReader(child.stdout, handleLine);
      child.once("error", (error) => {
        closed = true;
        closeFailure = error;
        queue.fail(error);
        failPending(error);
      });
      child.once("close", (code, signal) => {
        closed = true;
        if (intentionalClose) {
          queue.end();
          failPending(new Error("Pi RPC process closed"));
          return;
        }
        const suffix = stderr.trim() ? ` Stderr: ${stderr.trim()}` : "";
        const failure =
          code === 0 && signal === null
            ? null
            : new Error(`Pi RPC process exited with code ${code ?? "unknown"} signal ${signal ?? "none"}.${suffix}`);
        if (failure) {
          closeFailure = failure;
          queue.fail(failure);
          failPending(failure);
        } else {
          closeFailure = new Error("Pi RPC process closed");
          queue.end();
          failPending(closeFailure);
        }
      });
    },
    send(commandBody) {
      if (!child || closed) {
        return Promise.reject(closeFailure ?? new Error("Pi RPC transport is not connected"));
      }

      const id = `pi-${nextRequestId++}`;
      const commandWithId: PiRpcCommand = { ...commandBody, id };

      return new Promise<PiRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout waiting for Pi RPC response to ${commandBody.type}`));
        }, responseTimeoutMs);
        pending.set(id, { resolve, reject, timeout });
        child!.stdin.write(`${JSON.stringify(commandWithId)}\n`, (error) => {
          if (!error) {
            return;
          }
          pending.delete(id);
          clearTimeout(timeout);
          reject(error);
        });
      });
    },
    async close() {
      stopStdoutReader?.();
      stopStdoutReader = null;
      const currentChild = child;
      child = null;
      if (!currentChild || closed) {
        queue.end();
        failPending(new Error("Pi RPC transport closed"));
        return;
      }

      closed = true;
      intentionalClose = true;
      currentChild.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          currentChild.kill("SIGKILL");
          resolve();
        }, PI_INTERRUPT_GRACE_MS);
        currentChild.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      queue.end();
      failPending(new Error("Pi RPC transport closed"));
    },
  };
}

async function* runPiTurns(
  input: RuntimeStartRequest,
  createTransport: () => PiRpcTransport,
  state: PiSessionRuntimeState,
  options: { canRestartTransport: boolean; skillVisibility: RuntimeSkillVisibilitySnapshot },
): AsyncGenerator<RuntimeEvent> {
  const modelSelector = parsePiModelSelector(input.model);
  const thinkingLevel = toPiThinkingLevel(input.effort, input.thinking);
  const abortSignal = input.abortController.signal;
  const startInput: PiRpcStartInput = {
    cwd: input.cwd,
    env: input.env ?? process.env,
    provider: modelSelector.provider,
    model: modelSelector.modelId,
    modelArg: modelSelector.modelArg,
    thinkingLevel,
    systemPromptAppend: input.systemPromptAppend,
  };
  let transport = state.transport ?? createTransport();
  state.transport = transport;
  let eventIterator = transport.events[Symbol.asyncIterator]();

  const startTransport = async () => {
    await transport.start(startInput);
    state.started = true;
    eventIterator = transport.events[Symbol.asyncIterator]();
    await resumePiSessionIfNeeded(transport, input, state.currentState);
    state.currentState = await readPiState(transport, state.currentState);
    await configurePiQueueModes(transport, state);
    await flushPendingPiSteers(transport, state);
  };

  const restartTransport = async (): Promise<boolean> => {
    if (!options.canRestartTransport || abortSignal.aborted) {
      return false;
    }
    await transport.close().catch(() => {});
    transport = createTransport();
    state.transport = transport;
    await startTransport();
    return true;
  };

  try {
    await startTransport();
    let turnIndex = 0;

    for await (const promptMessage of input.prompt) {
      if (abortSignal.aborted) {
        break;
      }

      const prompt = extractPromptText(promptMessage);
      if (!prompt) {
        continue;
      }

      const terminalTracker = createRuntimeTerminalEventTracker();
      turnIndex += 1;
      const context: PiEventContext = {
        cwd: input.cwd,
        promptMessage,
        turnIndex,
        itemIndex: 0,
        state: state.currentState,
      };

      state.activeTurn = true;
      const abortListener = () => {
        state.interrupted = true;
        void safePiCommand(transport, { type: "abort" });
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });

      try {
        let promptResponse: PiRpcResponse;
        try {
          promptResponse = await sendPiPrompt(transport, prompt);
        } catch (error) {
          if (!isPiTransportDisconnectedError(error) || !(await restartTransport())) {
            throw error;
          }
          promptResponse = await sendPiPrompt(transport, prompt);
        }
        if (!promptResponse.success) {
          const terminal = terminalTracker.fail({
            error: promptResponse.error ?? "Pi prompt was rejected",
            recoverable: true,
            rawEvent: promptResponse,
            metadata: buildPiEventMetadata(promptResponse, context),
          });
          if (terminal) {
            yield terminal;
          }
          continue;
        }

        while (!terminalTracker.terminalEmitted) {
          const next = await eventIterator.next();
          if (next.done) {
            const terminal = state.interrupted
              ? terminalTracker.interrupt({
                  rawEvent: { type: "stream.ended", reason: "interrupt" },
                  metadata: buildPiEventMetadata({ type: "stream.ended" }, context),
                })
              : terminalTracker.fail({
                  error: "Pi RPC stream ended without a terminal event",
                  recoverable: true,
                  rawEvent: { type: "stream.ended", reason: "missing_terminal_event" },
                  metadata: buildPiEventMetadata({ type: "stream.ended" }, context),
                });
            if (terminal) {
              yield terminal;
            }
            break;
          }

          const event = next.value;
          for (const runtimeEvent of normalizePiEvent(event, context)) {
            if (!terminalTracker.accept(runtimeEvent)) {
              continue;
            }
            attachPiSkillVisibility(runtimeEvent, options.skillVisibility);
            yield runtimeEvent;
            if (runtimeEvent.type === "turn.complete") {
              state.currentState = context.state;
            }
          }

          const terminal = await maybeBuildPiTerminalEvent(event, context, transport, terminalTracker);
          if (terminal) {
            attachPiSkillVisibility(terminal, options.skillVisibility);
            if (terminal.type === "turn.complete") {
              state.currentState = context.state;
            }
            yield terminal;
            break;
          }
        }
      } catch (error) {
        if (abortSignal.aborted || state.interrupted) {
          const terminal = terminalTracker.interrupt({
            rawEvent: { type: "stream.error", reason: "interrupt" },
            metadata: buildPiEventMetadata({ type: "stream.error" }, context),
          });
          if (terminal) {
            yield { type: "status", status: "idle", metadata: terminal.metadata };
            yield terminal;
          }
          continue;
        }

        const disconnected = isPiTransportDisconnectedError(error);
        const terminal = terminalTracker.fail({
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
          rawEvent: disconnected ? { type: "transport.disconnected" } : undefined,
          metadata: buildPiEventMetadata({ type: disconnected ? "transport.disconnected" : "stream.error" }, context),
        });
        if (terminal) {
          yield terminal;
        }
        if (disconnected) {
          return;
        }
      } finally {
        abortSignal.removeEventListener("abort", abortListener);
        state.activeTurn = false;
        state.interrupted = false;
      }
    }
  } finally {
    await transport.close();
    if (state.transport === transport) {
      state.transport = undefined;
    }
  }
}

interface PiEventContext {
  cwd: string;
  promptMessage: RuntimePromptMessage;
  turnIndex: number;
  itemIndex: number;
  activeTurnId?: string;
  state?: PiRpcSessionState;
  lastAssistantMessage?: PiAgentMessage;
}

function normalizePiEvent(event: PiRpcEvent, context: PiEventContext): RuntimeEvent[] {
  const rawEvent = event as Record<string, unknown>;
  const metadata = buildPiEventMetadata(rawEvent, context);
  const events: RuntimeEvent[] = [{ type: "provider.raw", rawEvent, metadata }];

  switch (event.type) {
    case "agent_start":
      events.push({ type: "status", status: "thinking", rawEvent, metadata });
      break;
    case "turn_start": {
      context.activeTurnId = context.activeTurnId ?? `pi-turn-${context.turnIndex}`;
      const turn = { id: context.activeTurnId, status: "running" };
      events.push({ type: "turn.started", turn, rawEvent, metadata: buildPiEventMetadata(rawEvent, context) });
      break;
    }
    case "message_start": {
      const message = asPiAgentMessage(event.message);
      const item = buildPiItemMetadata(message, context, "started");
      events.push({ type: "item.started", item, rawEvent, metadata });
      break;
    }
    case "message_update": {
      const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
      const eventType = firstString(assistantEvent?.type);
      if (eventType === "text_delta") {
        const text = firstString(assistantEvent?.delta);
        if (text) {
          events.push({ type: "text.delta", text, metadata });
        }
      } else if (eventType === "thinking_delta") {
        events.push({ type: "status", status: "thinking", rawEvent, metadata });
      }
      break;
    }
    case "message_end": {
      const message = asPiAgentMessage(event.message);
      const item = buildPiItemMetadata(message, context, "completed");
      events.push({ type: "item.completed", item, rawEvent, metadata });
      if (message?.role === "assistant") {
        context.lastAssistantMessage = message;
        const text = extractPiAssistantText(message);
        if (text) {
          events.push({ type: "assistant.message", text, rawEvent, metadata });
        }
      }
      break;
    }
    case "tool_execution_start": {
      const toolUse = buildPiToolUse(event);
      if (toolUse) {
        events.push({ type: "tool.started", toolUse, rawEvent, metadata });
      }
      break;
    }
    case "tool_execution_end":
      events.push({
        type: "tool.completed",
        toolUseId: firstString(event.toolCallId),
        toolName: firstString(event.toolName),
        content: event.result,
        isError: event.isError === true,
        rawEvent,
        metadata,
      });
      break;
    case "queue_update": {
      const pendingCount = countPiQueuedMessages(event);
      events.push({ type: "status", status: pendingCount > 0 ? "queued" : "thinking", rawEvent, metadata });
      break;
    }
    case "compaction_start":
      events.push({ type: "status", status: "compacting", rawEvent, metadata });
      break;
    case "compaction_end":
      events.push({ type: "status", status: "idle", rawEvent, metadata });
      break;
  }

  return events;
}

function countPiQueuedMessages(event: PiRpcEvent): number {
  return (
    (Array.isArray(event.steering) ? event.steering.length : 0) +
    (Array.isArray(event.followUp) ? event.followUp.length : 0)
  );
}

async function maybeBuildPiTerminalEvent(
  event: PiRpcEvent,
  context: PiEventContext,
  transport: PiRpcTransport,
  terminalTracker: ReturnType<typeof createRuntimeTerminalEventTracker>,
): Promise<Extract<RuntimeEvent, { type: "turn.complete" | "turn.failed" | "turn.interrupted" }> | null> {
  const rawEvent = event as Record<string, unknown>;

  if (event.type === "turn_end") {
    const message = asPiAgentMessage(event.message);
    if (message?.role === "assistant") {
      context.lastAssistantMessage = message;
    }
    const stopReason = firstString(message?.stopReason);
    if (stopReason === "aborted") {
      return terminalTracker.interrupt({
        rawEvent,
        metadata: buildPiEventMetadata(rawEvent, context),
      });
    }
    if (stopReason === "error") {
      return terminalTracker.fail({
        error: firstString(message?.errorMessage) ?? "Pi turn failed",
        recoverable: true,
        rawEvent,
        metadata: buildPiEventMetadata(rawEvent, context),
      });
    }
  }

  if (event.type !== "agent_end") {
    return null;
  }

  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastAssistant = findLastAssistantMessage(messages) ?? context.lastAssistantMessage;
  context.lastAssistantMessage = lastAssistant;
  context.state = await readPiState(transport, context.state);
  const sessionState = buildPiRuntimeSessionState(context.state, context.cwd);
  const providerSessionId = readPiProviderSessionId(context.state);
  const metadata = buildPiEventMetadata(rawEvent, context);

  const terminal: RuntimeEvent = {
    type: "turn.complete",
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(sessionState ? { session: sessionState } : {}),
    execution: buildPiExecutionMetadata(lastAssistant, context.state),
    usage: mapPiUsage(lastAssistant?.usage),
    rawEvent,
    metadata,
  };

  return terminalTracker.accept(terminal) ? terminal : null;
}

async function controlPiRuntime(
  state: PiSessionRuntimeState,
  request: RuntimeControlRequest,
): Promise<RuntimeControlResult> {
  const buildState = (): RuntimeControlState => ({
    provider: "pi",
    threadId: firstString(state.currentState?.sessionId),
    activeTurn: state.activeTurn,
    supportedOperations: PI_RUNTIME_CONTROL_OPERATIONS,
  });
  const transport = state.transport;

  if (!transport) {
    return failControl(request, "Pi RPC transport is not connected", buildState());
  }

  try {
    switch (request.operation) {
      case "turn.interrupt":
        state.interrupted = true;
        return okControl(request, await sendPiCommand(transport, { type: "abort" }), buildState());
      case "turn.steer":
        if (!state.activeTurn && !state.started) {
          state.pendingSteers.push(request.text ?? "");
          return okControl(
            request,
            {
              type: "response",
              command: "steer",
              success: true,
              queued: true,
              data: {
                queued: true,
                reason: "provider_starting",
              },
            },
            buildState(),
          );
        }
        return okControl(
          request,
          await sendPiCommand(transport, { type: "steer", message: request.text ?? "" }),
          buildState(),
        );
      case "turn.follow_up":
        if (!state.activeTurn) {
          return failControl(request, "Pi turn.follow_up requires an active turn", buildState());
        }
        return okControl(
          request,
          await sendPiCommand(transport, { type: "follow_up", message: request.text ?? "" }),
          buildState(),
        );
      case "model.set": {
        const model = firstString(request.params?.model, request.text);
        if (!model) {
          return failControl(request, "Missing model for Pi model.set", buildState());
        }
        const parsed = parsePiModelSelector(model);
        return okControl(
          request,
          await sendPiCommand(transport, {
            type: "set_model",
            provider: parsed.provider ?? defaultPiModelProvider(),
            modelId: parsed.modelId ?? model,
          }),
          buildState(),
        );
      }
      case "thinking.set": {
        const level = normalizePiThinkingLevel(firstString(request.params?.level, request.text));
        if (!level) {
          return failControl(request, "Missing or invalid thinking level for Pi thinking.set", buildState());
        }
        return okControl(request, await sendPiCommand(transport, { type: "set_thinking_level", level }), buildState());
      }
      case "session.new":
        return okControl(request, await sendPiCommand(transport, { type: "new_session" }), buildState());
      case "session.read": {
        const response = await sendPiCommand(transport, { type: "get_state" });
        state.currentState = asPiSessionState(response.data) ?? state.currentState;
        return okControl(request, response, buildState());
      }
      case "session.switch": {
        const sessionPath = firstString(request.path, request.params?.sessionPath, request.text);
        if (!sessionPath) {
          return failControl(request, "Missing session path for Pi session.switch", buildState());
        }
        return okControl(
          request,
          await sendPiCommand(transport, { type: "switch_session", sessionPath }),
          buildState(),
        );
      }
      case "session.compact":
        return okControl(
          request,
          await sendPiCommand(transport, {
            type: "compact",
            customInstructions: firstString(request.params?.customInstructions, request.text),
          }),
          buildState(),
        );
      default:
        return failControl(request, `Pi runtime does not support ${request.operation}`, buildState());
    }
  } catch (error) {
    return failControl(request, error instanceof Error ? error.message : String(error), buildState());
  }
}

function okControl(
  request: RuntimeControlRequest,
  response: PiRpcResponse,
  state: RuntimeControlState,
): RuntimeControlResult {
  return {
    ok: true,
    operation: request.operation,
    data: {
      response,
    },
    state,
  };
}

function failControl(request: RuntimeControlRequest, error: string, state: RuntimeControlState): RuntimeControlResult {
  return {
    ok: false,
    operation: request.operation,
    state,
    error,
  };
}

async function resumePiSessionIfNeeded(
  transport: PiRpcTransport,
  input: RuntimeStartRequest,
  currentState?: PiRpcSessionState,
): Promise<void> {
  const sessionFile = firstString(
    currentState?.sessionFile,
    input.resumeSession?.params?.sessionFile,
    input.resumeSession?.params?.filePath,
    input.resumeSession?.params?.path,
    input.resume,
  );
  if (!sessionFile) {
    return;
  }
  await sendPiCommand(transport, { type: "switch_session", sessionPath: sessionFile });
}

async function readPiState(
  transport: PiRpcTransport,
  fallback?: PiRpcSessionState,
): Promise<PiRpcSessionState | undefined> {
  try {
    const response = await sendPiCommand(transport, { type: "get_state" });
    return asPiSessionState(response.data) ?? fallback;
  } catch {
    return fallback;
  }
}

async function configurePiQueueModes(transport: PiRpcTransport, state: PiSessionRuntimeState): Promise<void> {
  // Pi defaults steering to one-at-a-time. Ravi channel prompts should not become
  // serial assistant turns; they should be drained together at Pi's next steer poll.
  if (state.currentState?.steeringMode === "all") {
    return;
  }
  await sendPiCommand(transport, { type: "set_steering_mode", mode: "all" });
  state.currentState = {
    ...(state.currentState ?? {}),
    steeringMode: "all",
  };
}

async function flushPendingPiSteers(transport: PiRpcTransport, state: PiSessionRuntimeState): Promise<void> {
  if (state.pendingSteers.length === 0) {
    return;
  }
  const pending = state.pendingSteers.splice(0);
  for (const message of pending) {
    await sendPiCommand(transport, { type: "steer", message });
  }
}

async function sendPiCommand(transport: PiRpcTransport, command: PiRpcCommand): Promise<PiRpcResponse> {
  const response = await transport.send(command);
  if (!response.success) {
    throw new Error(response.error ?? `Pi RPC command ${command.type} failed`);
  }
  return response;
}

function sendPiPrompt(transport: PiRpcTransport, prompt: string): Promise<PiRpcResponse> {
  return transport.send({
    type: "prompt",
    message: prompt,
  });
}

function isPiTransportDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Pi RPC transport is not connected") ||
    message.includes("Pi RPC transport closed") ||
    message.includes("Pi RPC process closed") ||
    message.includes("Pi RPC process exited")
  );
}

async function safePiCommand(transport: PiRpcTransport, command: PiRpcCommand): Promise<void> {
  try {
    await sendPiCommand(transport, command);
  } catch {
    // Interrupt paths must be best-effort. The stream terminality layer handles
    // subprocess exit or missing terminal events.
  }
}

function buildPiRpcProcessArgs(input: PiRpcStartInput, commandArgs: string[]): string[] {
  const args = [...commandArgs, "--mode", "rpc"];
  const modelArg = input.modelArg ?? input.model;

  if (input.provider) {
    args.push("--provider", input.provider);
  }
  if (modelArg) {
    args.push("--model", modelArg);
  }
  if (input.thinkingLevel) {
    args.push("--thinking", input.thinkingLevel);
  }
  const systemPromptAppend = input.systemPromptAppend?.trim();
  if (systemPromptAppend) {
    args.push("--append-system-prompt", systemPromptAppend);
  }

  return args;
}

function attachStrictJsonlLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown;

  return {
    push(value) {
      if (ended || failure) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended || failure) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error) {
      if (ended || failure) {
        return;
      }
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve({ value: undefined as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

function parsePiModelSelector(model: string | undefined): { provider?: string; modelId?: string; modelArg?: string } {
  const value = model?.trim();
  if (!value) {
    return {};
  }

  const slashIndex = value.indexOf("/");
  if (slashIndex > 0 && slashIndex < value.length - 1) {
    return {
      provider: value.slice(0, slashIndex),
      modelId: value.slice(slashIndex + 1),
      modelArg: value,
    };
  }

  return {
    modelId: value,
    modelArg: value,
  };
}

function defaultPiModelProvider(): string {
  return process.env.RAVI_PI_PROVIDER?.trim() || process.env.PI_PROVIDER?.trim() || DEFAULT_PI_MODEL_PROVIDER;
}

function toPiThinkingLevel(
  effort: RuntimeStartRequest["effort"],
  thinking: RuntimeStartRequest["thinking"],
): PiThinkingLevel | undefined {
  if (thinking === "off") {
    return "off";
  }
  if (thinking === "verbose" && !effort) {
    return "high";
  }
  return normalizePiThinkingLevel(effort) ?? (thinking === "normal" ? "medium" : undefined);
}

function normalizePiThinkingLevel(value?: string): PiThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
}

function extractPromptText(message: RuntimePromptMessage): string {
  return message.message.content.trim();
}

function buildPiEventMetadata(rawEvent: Record<string, unknown>, context: PiEventContext): RuntimeEventMetadata {
  const sessionId = firstString(context.state?.sessionId);
  const sessionName = firstString(context.state?.sessionName);
  const item = buildPiItemMetadata(asPiAgentMessage(rawEvent.message), context, undefined);
  return {
    provider: "pi",
    nativeEvent: firstString(rawEvent.type),
    ...(sessionId || sessionName
      ? {
          thread: {
            ...(sessionId ? { id: sessionId } : {}),
            ...(sessionName ? { title: sessionName } : {}),
          },
        }
      : {}),
    ...(context.activeTurnId
      ? {
          turn: {
            id: context.activeTurnId,
          },
        }
      : {}),
    ...(item.id || item.type ? { item } : {}),
  };
}

function buildPiItemMetadata(message: PiAgentMessage | undefined, context: PiEventContext, status: string | undefined) {
  const id =
    firstString(message?.responseId) ??
    (typeof message?.timestamp === "number" ? `${firstString(message.role) ?? "message"}-${message.timestamp}` : "");
  return {
    ...(id ? { id } : {}),
    ...(firstString(message?.role) ? { type: firstString(message?.role) } : {}),
    ...(status ? { status } : {}),
    ...(context.activeTurnId ? { parentId: context.activeTurnId } : {}),
  };
}

function buildPiToolUse(event: PiRpcEvent): RuntimeToolUse | null {
  const id = firstString(event.toolCallId);
  const name = firstString(event.toolName);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    input: event.args,
  };
}

function buildPiRuntimeSessionState(
  state: PiRpcSessionState | undefined,
  cwd: string,
): RuntimeSessionState | undefined {
  if (!state) {
    return undefined;
  }

  const sessionFile = firstString(state.sessionFile);
  const sessionId = firstString(state.sessionId);
  const sessionName = firstString(state.sessionName);
  const model = isRecord(state.model) ? state.model : undefined;
  const modelProvider = firstString(model?.provider);
  const modelId = firstString(model?.id);
  const displayId = sessionName ?? sessionId ?? (sessionFile ? basename(sessionFile) : undefined);

  return {
    params: {
      integration: "rpc",
      cwd,
      ...(sessionFile ? { sessionFile } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionName ? { sessionName } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      ...(modelId ? { modelId } : {}),
      ...(firstString(state.thinkingLevel) ? { thinkingLevel: firstString(state.thinkingLevel) } : {}),
    },
    displayId: displayId ?? null,
  };
}

function attachPiSkillVisibility(event: RuntimeEvent, skillVisibility: RuntimeSkillVisibilitySnapshot): void {
  if (event.type !== "turn.complete" || !event.session?.params) {
    return;
  }
  event.session.params.skillVisibility = skillVisibility;
}

function readPiProviderSessionId(state: PiRpcSessionState | undefined): string | undefined {
  return firstString(state?.sessionFile, state?.sessionId);
}

function buildPiExecutionMetadata(
  assistant: PiAgentMessage | undefined,
  state: PiRpcSessionState | undefined,
): RuntimeExecutionMetadata {
  const model = isRecord(state?.model) ? state?.model : undefined;
  return {
    provider: firstString(assistant?.provider, model?.provider) ?? null,
    model: firstString(assistant?.model, model?.id, model?.name) ?? null,
    billingType: "unknown",
  };
}

function mapPiUsage(usage: PiUsage | undefined): RuntimeUsage {
  return {
    inputTokens: numberOrZero(usage?.input),
    outputTokens: numberOrZero(usage?.output),
    cacheReadTokens: numberOrZero(usage?.cacheRead),
    cacheCreationTokens: numberOrZero(usage?.cacheWrite),
  };
}

function extractPiAssistantText(message: PiAgentMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function findLastAssistantMessage(messages: unknown[]): PiAgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asPiAgentMessage(messages[index]);
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function asPiAgentMessage(value: unknown): PiAgentMessage | undefined {
  return isRecord(value) ? (value as PiAgentMessage) : undefined;
}

function asPiSessionState(value: unknown): PiRpcSessionState | undefined {
  return isRecord(value) ? (value as PiRpcSessionState) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

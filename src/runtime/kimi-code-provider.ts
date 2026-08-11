import { KIMI_CODE_PROVIDER_ID, type KimiCodeModel } from "./kimi-code-models.js";
import {
  commitKimiCodeSessionState,
  createKimiCodeSessionId,
  loadKimiCodeSessionState,
  type KimiCodeSessionSnapshot,
} from "./kimi-code-state.js";
import {
  addKimiCodeUsage,
  createKimiCodeCompletedTurnAccumulator,
  createKimiCodeToolResultViews,
  createKimiCodeTurnRequest,
  KIMI_CODE_MAX_TOOL_CALLS,
  KIMI_CODE_MAX_TOOL_ROUNDS,
  type KimiCodeCompletedTurn,
  type KimiCodeConversationMessage,
  type KimiCodeTurnChunkResult,
  validateKimiCodeToolCalls,
} from "./kimi-code-turn.js";
import {
  createKimiCodeHttpTransport,
  KimiCodeHttpError,
  KimiCodePreflightError,
  KimiCodeProtocolError,
  KimiCodeTransportError,
  projectKimiCodeHttpError,
  type KimiCodeTransport,
} from "./kimi-code-transport.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import type {
  RuntimeDynamicToolCallResult,
  RuntimeEvent,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

export { KIMI_CODE_CREDENTIAL_ENV_KEY } from "./kimi-code-models.js";
export {
  createKimiCodeCompletedTurnAccumulator,
  type KimiCodeCompletedTurn,
  type KimiCodeToolCallFragment,
  type KimiCodeTurnChunkResult,
} from "./kimi-code-turn.js";
export {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  KimiCodeHttpError,
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

function createKimiCodeSession(
  input: RuntimeStartRequest,
  transportFactory: () => KimiCodeTransport,
): RuntimeSessionHandle {
  let closed = false;
  let activeTurn: KimiCodeActiveTurn | undefined;
  let committedSnapshot: KimiCodeSessionSnapshot | undefined;
  let continuityInitialized = false;
  let continuityInvalid = false;
  let providerSessionId = createKimiCodeSessionId();
  let threadStartedEmitted = false;
  const stateEnv: NodeJS.ProcessEnv = { ...process.env, ...input.env };
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

        const turn: KimiCodeActiveTurn = {
          phase: "initializing",
          interrupted: false,
          transportClosed: false,
        };
        activeTurn = turn;
        if (
          !threadStartedEmitted &&
          !input.forkSession &&
          input.resume === undefined &&
          input.resumeSession === undefined
        ) {
          threadStartedEmitted = true;
          yield { type: "thread.started", thread: { id: providerSessionId }, metadata };
        }
        yield {
          type: "turn.started",
          turn: { id: prompt.clientMessageId ?? prompt.session_id, status: "in_progress" },
          metadata,
        };
        if (input.forkSession) {
          turn.phase = "failed";
          const terminal = terminalTracker.fail({ error: "Kimi Code session fork is unsupported", metadata });
          if (terminal) yield terminal;
          continue;
        }
        if (!continuityInitialized) {
          continuityInitialized = true;
          if (input.resumeSession) {
            try {
              committedSnapshot = await loadKimiCodeSessionState({
                session: input.resumeSession,
                model: input.model,
                cwd: input.cwd,
                env: stateEnv,
              });
              providerSessionId = committedSnapshot.sessionId;
              if (
                (input.resume !== undefined && input.resume !== committedSnapshot.sessionId) ||
                input.resumeSession.displayId !== committedSnapshot.sessionId
              ) {
                throw new Error("Kimi Code session identifiers do not match");
              }
            } catch {
              continuityInvalid = true;
            }
          } else if (input.resume !== undefined) {
            continuityInvalid = true;
          }
        }
        if (continuityInvalid) {
          turn.phase = "failed";
          const terminal = terminalTracker.fail({ error: "Kimi Code session state is invalid", metadata });
          if (terminal) yield terminal;
          continue;
        }
        let thinkingPublished = false;
        let completedUsage: KimiCodeCompletedTurn["usage"] = { inputTokens: 0, outputTokens: 0 };
        let toolRounds = 0;
        let totalToolCalls = 0;
        const seenToolCallIds = new Set<string>();
        const messages: KimiCodeConversationMessage[] = [
          ...(committedSnapshot?.messages ?? []),
          { role: "user", content: prompt.message.content },
        ];

        try {
          turnLoop: while (!terminalTracker.terminalEmitted) {
            if (turn.interrupted || closed || input.abortController.signal.aborted) {
              turn.phase = "interrupted";
              const terminal = terminalTracker.interrupt({ metadata });
              if (terminal) yield terminal;
              break;
            }

            turn.phase = "requesting";
            turn.transport = transportFactory();
            turn.transportClosed = false;
            if (turn.interrupted || closed || input.abortController.signal.aborted) {
              turn.phase = "interrupted";
              const terminal = terminalTracker.interrupt({ metadata });
              if (terminal) yield terminal;
              break;
            }

            const accumulator = createKimiCodeCompletedTurnAccumulator();
            let providerDone = false;
            const request = createKimiCodeTurnRequest(input, messages, providerSessionId);
            try {
              turn.phase = "streaming";
              for await (const event of turn.transport.stream(request)) {
                if (turn.interrupted || closed || input.abortController.signal.aborted) {
                  turn.phase = "interrupted";
                  const terminal = terminalTracker.interrupt({ metadata });
                  if (terminal) yield terminal;
                  break;
                }

                if (event.type === "eof") {
                  turn.phase = "failed";
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
                  turn.phase = "failed";
                  const protocolFailure = projectAccumulatorProtocolFailure(accepted);
                  const terminal = terminalTracker.fail({
                    error: protocolFailure.message,
                    rawEvent: protocolFailure.rawEvent,
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
            if (turn.interrupted || closed || input.abortController.signal.aborted) {
              turn.phase = "interrupted";
              const terminal = terminalTracker.interrupt({ metadata });
              if (terminal) yield terminal;
              break;
            }
            if (!providerDone) {
              turn.phase = "failed";
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
            if (completed.finishReason === "stop") {
              messages.push({
                role: "assistant",
                content: completed.text,
                reasoning_content: completed.reasoning,
                tool_calls: [],
              });
              if (turn.interrupted || closed || input.abortController.signal.aborted) {
                turn.phase = "interrupted";
                const terminal = terminalTracker.interrupt({ metadata });
                if (terminal) yield terminal;
                break;
              }
              let committed: Awaited<ReturnType<typeof commitKimiCodeSessionState>>;
              turn.phase = "committing";
              try {
                committed = await commitKimiCodeSessionState({
                  sessionId: providerSessionId,
                  model: input.model,
                  cwd: input.cwd,
                  lastCommittedTurnId: prompt.clientMessageId ?? prompt.session_id,
                  messages,
                  previousSnapshot: committedSnapshot,
                  env: stateEnv,
                });
              } catch {
                const interrupted = turn.interrupted || closed || input.abortController.signal.aborted;
                turn.phase = interrupted ? "interrupted" : "failed";
                const terminal = interrupted
                  ? terminalTracker.interrupt({ metadata })
                  : terminalTracker.fail({ error: "Kimi Code session state commit failed", metadata });
                if (terminal) yield terminal;
                break;
              }
              if (turn.interrupted || closed || input.abortController.signal.aborted) {
                turn.phase = "interrupted";
                const interruptedTerminal = terminalTracker.interrupt({ metadata });
                if (interruptedTerminal) yield interruptedTerminal;
                break;
              }
              committedSnapshot = committed.snapshot;
              const terminal: RuntimeEvent = {
                type: "turn.complete",
                providerSessionId: committed.snapshot.sessionId,
                session: committed.session,
                execution: { provider: KIMI_CODE_PROVIDER_ID, model: input.model, billingType: "subscription" },
                usage: completedUsage,
                metadata,
              };
              turn.committedTerminal = terminal;
              turn.phase = "completed";
              if (!terminalTracker.accept(terminal)) break;
              if (completed.text) yield { type: "assistant.message", text: completed.text, metadata };
              yield terminal;
              break;
            }

            turn.phase = "tool-fenced";
            if (
              toolRounds >= KIMI_CODE_MAX_TOOL_ROUNDS ||
              totalToolCalls + completed.toolCalls.length > KIMI_CODE_MAX_TOOL_CALLS
            ) {
              turn.phase = "failed";
              const terminal = terminalTracker.fail({ error: "Kimi Code tool loop limit exceeded", metadata });
              if (terminal) yield terminal;
              break;
            }

            const toolCalls = validateKimiCodeToolCalls(completed.toolCalls, seenToolCallIds);
            if (!toolCalls || !input.handleRuntimeToolCall) {
              turn.phase = "failed";
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
                turn.phase = "interrupted";
                const terminal = terminalTracker.interrupt({ metadata });
                if (terminal) yield terminal;
                break turnLoop;
              }

              yield {
                type: "tool.started",
                toolUse: { id: call.id, name: call.name, input: call.publicArguments },
                metadata,
              };
              if (turn.interrupted || closed || input.abortController.signal.aborted) {
                turn.phase = "interrupted";
                const terminal = terminalTracker.interrupt({ metadata });
                if (terminal) yield terminal;
                break turnLoop;
              }

              let result: RuntimeDynamicToolCallResult;
              turn.phase = "tool-running";
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
              const { providerContent, publicContent } = createKimiCodeToolResultViews(result);
              yield {
                type: "tool.completed",
                toolUseId: call.id,
                toolName: call.name,
                content: publicContent,
                isError: !result.success,
                metadata,
              };
              yield { type: "tool.result_delivered", toolCallId: call.id, metadata };
              messages.push({ role: "tool", tool_call_id: call.id, content: providerContent });
            }
            if (!isKimiCodeTerminalPhase(turn.phase)) turn.phase = "continuing";
          }
        } catch (error) {
          const kimiFailure = error instanceof KimiCodeHttpError ? projectKimiCodeHttpError(error) : undefined;
          const preflightFailure =
            error instanceof KimiCodePreflightError ? projectKimiCodePreflightError(error) : undefined;
          const protocolFailure =
            error instanceof KimiCodeProtocolError
              ? { message: error.message, rawEvent: { protocol: error.code } }
              : undefined;
          const transportFailure =
            error instanceof KimiCodeTransportError ? projectKimiCodeTransportError(error) : undefined;
          const interrupted = turn.interrupted || closed || input.abortController.signal.aborted;
          if (turn.phase !== "completed") turn.phase = interrupted ? "interrupted" : "failed";
          const terminal =
            turn.phase === "completed"
              ? turn.committedTerminal
              : interrupted
                ? terminalTracker.interrupt({ metadata })
                : kimiFailure
                  ? terminalTracker.fail({ error: kimiFailure.message, rawEvent: kimiFailure.rawEvent, metadata })
                  : preflightFailure
                    ? terminalTracker.fail({ ...preflightFailure, metadata })
                    : protocolFailure
                      ? terminalTracker.fail({
                          error: protocolFailure.message,
                          rawEvent: protocolFailure.rawEvent,
                          metadata,
                        })
                      : transportFailure
                        ? terminalTracker.fail({ ...transportFailure, metadata })
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
      if (isKimiCodeTerminalPhase(activeTurn.phase)) {
        await closeTurnTransport(activeTurn);
        return;
      }
      activeTurn.interrupted = true;
      activeTurn.phase = "interrupted";
      await closeTurnTransport(activeTurn);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (!activeTurn) return;
      if (isKimiCodeTerminalPhase(activeTurn.phase)) {
        await closeTurnTransport(activeTurn);
        return;
      }
      activeTurn.interrupted = true;
      activeTurn.phase = "interrupted";
      await closeTurnTransport(activeTurn);
    },
  };
}

function projectAccumulatorProtocolFailure(failure: Exclude<KimiCodeTurnChunkResult, { kind: "accepted" }>): {
  message: string;
  rawEvent: Record<string, unknown>;
} {
  if (failure.kind === "malformed") {
    return {
      message: "Kimi Code protocol error: malformed response chunk",
      rawEvent: { protocol: failure.code },
    };
  }
  if (failure.kind === "provider_error") {
    return {
      message: "Kimi Code provider returned an error",
      rawEvent: { ...failure.nativeError },
    };
  }
  const failures = {
    post_finish: {
      message: "Kimi Code protocol error: data after finish",
      rawEvent: { protocol: "post_finish_data" },
    },
    response_limit: {
      message: "Kimi Code protocol error: response limit exceeded",
      rawEvent: { protocol: "response_limit" },
    },
    tool_argument_limit: {
      message: "Kimi Code protocol error: tool argument limit exceeded",
      rawEvent: { protocol: "tool_argument_limit" },
    },
  } as const;
  return failures[failure.kind];
}

function projectKimiCodePreflightError(error: KimiCodePreflightError) {
  return {
    error: "Kimi Code request preflight failed",
    recoverable: false,
    rawEvent: { preflight: error.code },
  } as const;
}

function projectKimiCodeTransportError(error: KimiCodeTransportError) {
  const messages = {
    request_not_sent: "Kimi Code request was not sent",
    acceptance_ambiguous: "Kimi Code request delivery is ambiguous",
    provider_protocol: "Kimi Code transport protocol failed",
  } as const;
  return {
    error: messages[error.phase],
    recoverable: error.phase === "request_not_sent",
    rawEvent: { phase: error.phase },
  };
}

type KimiCodeTurnPhase =
  | "initializing"
  | "requesting"
  | "streaming"
  | "committing"
  | "tool-fenced"
  | "tool-running"
  | "continuing"
  | "completed"
  | "failed"
  | "interrupted";

function isKimiCodeTerminalPhase(phase: KimiCodeTurnPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

interface KimiCodeActiveTurn {
  phase: KimiCodeTurnPhase;
  interrupted: boolean;
  committedTerminal?: Extract<RuntimeEvent, { type: "turn.complete" }>;
  transport?: KimiCodeTransport;
  transportClosed: boolean;
}

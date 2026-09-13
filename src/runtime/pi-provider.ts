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
  RuntimePrepareSessionRequest,
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
import { coalesceAssistantTextBlocks } from "./assistant-transcript.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import { buildPluginSkillVisibilitySnapshot } from "./skill-visibility.js";
import {
  materializeRuntimeModelBroker,
  resolveRuntimeModelBrokerLocalProviderId,
} from "./model-broker-materializer.js";
import { SANITIZED_ENV_VARS } from "../hooks/sanitize-bash.js";
import { resolveRuntimeModelBrokerProviderModel } from "./model-broker.js";
import {
  createPiApprovalHandler,
  DEFAULT_PI_PERMISSION_HOOKS_READY_TIMEOUT_MS,
  isPiPermissionBridgeError,
  isPiPermissionHooksReadyEvent,
  materializePiPermissionExtensionFile,
  PI_PERMISSION_BRIDGE_UNAVAILABLE_MESSAGE,
  PI_PERMISSION_EXTENSION_FILENAME,
  PiPermissionBridgeError,
  resolvePiExtensionUiResponse,
} from "./pi-tool-permissions.js";

const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_PI_RESPONSE_TIMEOUT_MS = 30_000;
const PI_INTERRUPT_GRACE_MS = 1_000;
// Backoff schedule for retrying a prompt rejected with "Agent is already processing".
// Pi's internal isStreaming flag can lag behind the agent_end event ravi observes,
// so a fresh prompt may briefly hit the race window. Each retry is a fresh stdin
// command, so the cumulative wait (~3.85s) covers the worst cases observed without
// risking the orphan/out-of-order pitfalls of streamingBehavior=followUp.
const PI_PROMPT_BUSY_BACKOFF_MS: readonly number[] = [100, 250, 500, 1_000, 2_000];
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
  isProcessing?: unknown;
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
  extensionPath?: string;
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
  /** Fire-and-forget stdin write used by the permission UI sub-protocol. */
  writeMessage?(message: Record<string, unknown>): Promise<void>;
  /** Discard events already queued from a previous turn without blocking. */
  drainPendingEvents?(): PiRpcEvent[];
  close(): Promise<void>;
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
  drain(): T[];
}

interface PendingRequest {
  resolve(response: PiRpcResponse): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PiSessionRuntimeState {
  activeTurn: boolean;
  interrupted: boolean;
  /**
   * After interrupt/fail, leftover `agent_end` / `turn_end` from the previous
   * Pi run can still be in-flight. Ignore those as terminals until the next
   * prompt observes `agent_start` or `turn_start`.
   */
  ignoreStaleTerminals: boolean;
  permissionHooksReady: boolean;
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
  /** How long to wait for `ravi.permission.hooks.ready` after RPC start. */
  permissionHooksReadyTimeoutMs?: number;
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
          permissionMode: "ravi-host",
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
          availability: "provider",
          loadedState: "none",
        },
        modelBroker: {
          protocols: ["openai-completions"],
          principalIsolation: "none",
        },
        supportsSessionResume: true,
        supportsSessionFork: false,
        supportsPartialText: true,
        supportsToolHooks: true,
        supportsHostSessionHooks: false,
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
        toolAccessRequirement: "tool_and_executable",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      const materialized = input.modelBroker ? materializeRuntimeModelBroker(input.modelBroker) : undefined;
      return {
        ...(materialized?.env ? { env: materialized.env } : {}),
        ...(input.hostServices
          ? { startRequest: { approveRuntimeRequest: createPiApprovalHandler(input.hostServices) } }
          : {}),
      };
    },
    startSession(input) {
      if (input.modelBroker) assertNoPiModelBrokerCredentialEnv(input.env);
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
      const skillVisibility = buildPluginSkillVisibilitySnapshot({
        provider: "pi",
        plugins: input.plugins,
        state: "advertised",
        confidence: "declared",
        evidenceKind: "system-prompt",
        ...(input.allowedSkills && input.allowedSkills.length > 0 ? { allowedSkills: input.allowedSkills } : {}),
      });
      const request: RuntimeStartRequest = {
        ...input,
        systemPromptAppend: input.omitAdvertisedSkillCatalog
          ? input.systemPromptAppend
          : buildPiSkillCatalogSystemPrompt(input.systemPromptAppend, skillVisibility),
      };
      const state: PiSessionRuntimeState = {
        activeTurn: false,
        interrupted: false,
        ignoreStaleTerminals: false,
        permissionHooksReady: false,
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
        concurrentInputStrategy: "native_steer",
        events: runPiTurns(request, createTransport, state, {
          canRestartTransport,
          skillVisibility,
          permissionHooksReadyTimeoutMs:
            options.permissionHooksReadyTimeoutMs ?? DEFAULT_PI_PERMISSION_HOOKS_READY_TIMEOUT_MS,
        }),
        interrupt: async () => {
          state.interrupted = true;
          const transport = state.transport;
          if (transport) {
            await safePiCommand(transport, { type: "abort" });
          }
        },
        close: async () => {
          const transport = state.transport;
          state.transport = undefined;
          await transport?.close();
        },
        setModel: async (model) => {
          if (input.modelBroker && model !== input.modelBroker.model) {
            throw new Error("Changing models requires resolving a matching model-broker route.");
          }
          const parsed = parsePiModelSelector(model);
          await sendPiCommand(requireTransport(), {
            type: "set_model",
            provider: input.modelBroker
              ? resolveRuntimeModelBrokerLocalProviderId(input.modelBroker)
              : (parsed.provider ?? defaultPiModelProvider()),
            modelId: parsed.modelId ?? model,
          });
        },
        control: (request) => controlPiRuntime(state, request, input.modelBroker),
      };
    },
  };
}

function assertNoPiModelBrokerCredentialEnv(env: Record<string, string> | undefined): void {
  if (!env) return;
  const credentialKeys = SANITIZED_ENV_VARS.filter((key) => key !== "DATABASE_URL");
  const leaked = credentialKeys.find((key) => env[key]?.trim());
  if (leaked) {
    throw new Error(`Pi model broker refuses upstream credential environment variable ${leaked}.`);
  }
}

export function buildPiSkillCatalogSystemPrompt(
  basePrompt: string,
  skillVisibility: RuntimeSkillVisibilitySnapshot,
): string {
  if (skillVisibility.skills.length === 0) {
    return basePrompt;
  }

  const catalog = skillVisibility.skills.map((skill) => {
    const alias = piManagedSkillAlias(skill);
    return alias === skill.id ? `- ${alias}` : `- ${alias} (skill: ${skill.id})`;
  });

  return [
    basePrompt.trim(),
    "",
    "## Ravi Skills Available to Pi",
    "",
    "The following skills are indexed for this session. When a task matches one, load its complete instructions before acting with:",
    "",
    "`ravi skills show <skill-name> --json`",
    "",
    ...catalog,
    "",
    "Treat this catalog as availability only. A skill is loaded only after its complete instructions are read.",
  ]
    .filter((line, index) => line || index > 0)
    .join("\n");
}

function piManagedSkillAlias(skill: RuntimeSkillVisibilitySnapshot["skills"][number]): string {
  const sourceMatch = /^plugin:([^/]+)\/([^/]+)$/.exec(skill.source ?? "");
  if (!sourceMatch) {
    return skill.id;
  }
  return `${piSkillSlug(sourceMatch[1] ?? "")}-${piSkillSlug(sourceMatch[2] ?? skill.id)}`;
}

function piSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    drainPendingEvents() {
      return queue.drain();
    },
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
        env: buildPiRpcSpawnEnv(input),
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
    writeMessage(message) {
      if (!child || closed) {
        return Promise.reject(closeFailure ?? new Error("Pi RPC transport is not connected"));
      }
      return new Promise<void>((resolve, reject) => {
        child!.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
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

export function buildPiRpcSpawnEnv(input: Pick<PiRpcStartInput, "env">): NodeJS.ProcessEnv {
  const env = { ...input.env };
  // Tool execution still shares the Pi RPC process. Keep provider secrets out
  // of that env even after permission hooks unlock restricted agents.
  for (const key of SANITIZED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

async function* runPiTurns(
  input: RuntimeStartRequest,
  createTransport: () => PiRpcTransport,
  state: PiSessionRuntimeState,
  options: {
    canRestartTransport: boolean;
    skillVisibility: RuntimeSkillVisibilitySnapshot;
    permissionHooksReadyTimeoutMs: number;
  },
): AsyncGenerator<RuntimeEvent> {
  const modelSelector = parsePiModelSelector(input.model);
  const thinkingLevel = toPiThinkingLevel(input.effort, input.thinking);
  const abortSignal = input.abortController.signal;
  const startInput: PiRpcStartInput = {
    cwd: input.cwd,
    env: buildPiRpcSpawnEnv({
      env: input.modelBroker ? (input.env ?? {}) : (input.env ?? process.env),
    }),
    provider: input.modelBroker ? resolveRuntimeModelBrokerLocalProviderId(input.modelBroker) : modelSelector.provider,
    model: modelSelector.modelId,
    modelArg: input.modelBroker
      ? `${resolveRuntimeModelBrokerLocalProviderId(input.modelBroker)}/${resolveRuntimeModelBrokerProviderModel(input.modelBroker)}`
      : modelSelector.modelArg,
    thinkingLevel,
    systemPromptAppend: input.systemPromptAppend,
    extensionPath: materializePiPermissionExtensionFile(),
  };
  let transport = state.transport ?? createTransport();
  state.transport = transport;
  let eventIterator = transport.events[Symbol.asyncIterator]();
  let pendingStartupEvents: PiRpcEvent[] = [];

  const takeNextPiEvent = async (): Promise<IteratorResult<PiRpcEvent>> => {
    if (pendingStartupEvents.length > 0) {
      return { value: pendingStartupEvents.shift()!, done: false };
    }
    return eventIterator.next();
  };

  const startTransport = async () => {
    await transport.start(startInput);
    state.started = true;
    state.permissionHooksReady = false;
    eventIterator = transport.events[Symbol.asyncIterator]();
    await resumePiSessionIfNeeded(transport, input, state.currentState);
    state.currentState = await readPiState(transport, state.currentState);
    await configurePiQueueModes(transport, state);
    await flushPendingPiSteers(transport, state);
    if (!transport.writeMessage) {
      await transport.close().catch(() => {});
      throw new PiPermissionBridgeError("Pi RPC transport cannot answer extension UI permission requests");
    }
    try {
      pendingStartupEvents = await awaitPiPermissionHooksReady(
        transport,
        eventIterator,
        options.permissionHooksReadyTimeoutMs,
        abortSignal,
      );
      state.permissionHooksReady = true;
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
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
    try {
      await startTransport();
    } catch (error) {
      if (!isPiPermissionBridgeError(error)) {
        throw error;
      }
      for await (const promptMessage of input.prompt) {
        if (!extractPromptText(promptMessage)) {
          continue;
        }
        yield {
          type: "turn.failed",
          error: error.message,
          recoverable: true,
          failureKind: "transport",
          rawEvent: { type: "permission.bridge_unavailable" },
        };
        return;
      }
      return;
    }
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
        ignoreStaleTerminals: state.ignoreStaleTerminals,
        lifecycleStarted: !state.ignoreStaleTerminals,
      };

      state.activeTurn = true;
      const abortListener = () => {
        state.interrupted = true;
        void safePiCommand(transport, { type: "abort" });
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
      let lastTerminalFailed = false;
      let lastTerminalInterrupted = false;

      try {
        let promptResponse: PiRpcResponse;
        try {
          promptResponse = await sendPiPromptOrRecover(transport, prompt, abortSignal, restartTransport, state);
        } catch (error) {
          if (!isPiTransportDisconnectedError(error) || !(await restartTransport())) {
            throw error;
          }
          state.ignoreStaleTerminals = false;
          context.ignoreStaleTerminals = false;
          context.lifecycleStarted = true;
          promptResponse = await sendPiPromptOrRecover(
            state.transport ?? transport,
            prompt,
            abortSignal,
            restartTransport,
            state,
          );
        }
        if (!promptResponse.success) {
          lastTerminalFailed = true;
          const terminal = terminalTracker.fail({
            error: promptResponse.error ?? "Pi prompt was rejected",
            recoverable: true,
            ...(isPiBusyResponse(promptResponse) ? { failureKind: "transport" as const } : {}),
            rawEvent: promptResponse,
            metadata: buildPiEventMetadata(promptResponse, context),
          });
          if (terminal) {
            yield terminal;
          }
          continue;
        }

        while (!terminalTracker.terminalEmitted) {
          const next = await takeNextPiEvent();
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
          if (isPiPermissionHooksReadyEvent(event)) {
            state.permissionHooksReady = true;
          }
          if (event.type === "tool_execution_start" && !state.permissionHooksReady) {
            lastTerminalFailed = true;
            const terminal = terminalTracker.fail({
              error: PI_PERMISSION_BRIDGE_UNAVAILABLE_MESSAGE,
              recoverable: true,
              failureKind: "transport",
              rawEvent: event,
              metadata: buildPiEventMetadata(event, context),
            });
            if (terminal) {
              yield terminal;
            }
            break;
          }
          if (event.type === "extension_ui_request") {
            await answerPiExtensionUiRequest(transport, event, input);
          }
          if (event.type === "agent_start" || event.type === "turn_start") {
            context.lifecycleStarted = true;
            context.ignoreStaleTerminals = false;
            state.ignoreStaleTerminals = false;
          }
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
            if (terminal.type === "turn.failed") {
              lastTerminalFailed = true;
            }
            if (terminal.type === "turn.interrupted") {
              lastTerminalInterrupted = true;
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
        const permissionBridgeFailed = isPiPermissionBridgeError(error);
        const terminal = terminalTracker.fail({
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
          ...(disconnected || permissionBridgeFailed ? { failureKind: "transport" as const } : {}),
          rawEvent: disconnected
            ? { type: "transport.disconnected" }
            : permissionBridgeFailed
              ? { type: "permission.bridge_unavailable" }
              : undefined,
          metadata: buildPiEventMetadata(
            {
              type: disconnected
                ? "transport.disconnected"
                : permissionBridgeFailed
                  ? "permission.bridge_unavailable"
                  : "stream.error",
            },
            context,
          ),
        });
        if (terminal) {
          yield terminal;
        }
        if (disconnected) {
          return;
        }
      } finally {
        abortSignal.removeEventListener("abort", abortListener);
        const interrupted = state.interrupted || abortSignal.aborted;
        state.activeTurn = false;
        drainPendingPiEvents(transport);
        if (!abortSignal.aborted && (interrupted || lastTerminalFailed || lastTerminalInterrupted)) {
          const idle = await recoverPiAfterInterrupt(transport, state);
          state.ignoreStaleTerminals = true;
          context.ignoreStaleTerminals = true;
          if (!idle && (await restartTransport())) {
            state.ignoreStaleTerminals = false;
            context.ignoreStaleTerminals = false;
          }
        } else if (interrupted || lastTerminalInterrupted) {
          state.ignoreStaleTerminals = true;
        }
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
  ignoreStaleTerminals?: boolean;
  lifecycleStarted?: boolean;
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
        for (const text of extractPiAssistantTexts(message)) {
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
  if (shouldIgnoreStalePiTerminal(event, context)) {
    return null;
  }

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
  modelBroker?: RuntimeStartRequest["modelBroker"],
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
        if (modelBroker && model !== modelBroker.model) {
          return failControl(
            request,
            "Changing models requires resolving a matching model-broker route.",
            buildState(),
          );
        }
        const parsed = parsePiModelSelector(model);
        return okControl(
          request,
          await sendPiCommand(transport, {
            type: "set_model",
            provider: modelBroker
              ? resolveRuntimeModelBrokerLocalProviderId(modelBroker)
              : (parsed.provider ?? defaultPiModelProvider()),
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

export function isPiBusyResponse(response: PiRpcResponse): boolean {
  if (response.success) return false;
  return isPiAlreadyProcessingError(response.error);
}

export function isPiAlreadyProcessingError(error: unknown): boolean {
  const text = typeof error === "string" ? error : "";
  return text.toLowerCase().includes("already processing");
}

function isPiSessionBusy(session?: PiRpcSessionState): boolean {
  return session?.isStreaming === true || session?.isProcessing === true || session?.isCompacting === true;
}

function drainPendingPiEvents(transport: PiRpcTransport): PiRpcEvent[] {
  return transport.drainPendingEvents?.() ?? [];
}

async function recoverPiAfterInterrupt(transport: PiRpcTransport, state: PiSessionRuntimeState): Promise<boolean> {
  await safePiCommand(transport, { type: "abort" });
  drainPendingPiEvents(transport);
  const current = await readPiState(transport, state.currentState);
  state.currentState = current;
  return !isPiSessionBusy(current);
}

function shouldIgnoreStalePiTerminal(event: PiRpcEvent, context: PiEventContext): boolean {
  if (!context.ignoreStaleTerminals || context.lifecycleStarted) {
    return false;
  }
  return event.type === "turn_end" || event.type === "agent_end";
}

async function sendPiPromptOrRecover(
  transport: PiRpcTransport,
  prompt: string,
  signal: AbortSignal,
  restartTransport: () => Promise<boolean>,
  state: PiSessionRuntimeState,
): Promise<PiRpcResponse> {
  const response = await sendPiPromptWithBusyRetry(transport, prompt, signal);
  if (!isPiBusyResponse(response) || signal.aborted) {
    return response;
  }
  if (!(await restartTransport())) {
    return response;
  }
  state.ignoreStaleTerminals = false;
  const nextTransport = state.transport;
  if (!nextTransport) {
    return response;
  }
  return sendPiPromptWithBusyRetry(nextTransport, prompt, signal);
}

function piPromptBackoffMs(attempt: number): number | undefined {
  return PI_PROMPT_BUSY_BACKOFF_MS[attempt];
}

async function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendPiPromptWithBusyRetry(
  transport: PiRpcTransport,
  prompt: string,
  signal: AbortSignal,
): Promise<PiRpcResponse> {
  let attempt = 0;
  let response = await sendPiPrompt(transport, prompt);
  while (isPiBusyResponse(response)) {
    const delayMs = piPromptBackoffMs(attempt);
    if (delayMs === undefined) {
      return response;
    }
    if (await waitWithAbort(delayMs, signal)) {
      return response;
    }
    attempt += 1;
    response = await sendPiPrompt(transport, prompt);
  }
  return response;
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

export function buildPiRpcProcessArgs(input: PiRpcStartInput, commandArgs: string[] = []): string[] {
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
  if (input.extensionPath) {
    args.push("--extension", input.extensionPath);
  }

  return args;
}

async function awaitPiPermissionHooksReady(
  transport: PiRpcTransport,
  eventIterator: AsyncIterator<PiRpcEvent>,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<PiRpcEvent[]> {
  const buffered: PiRpcEvent[] = [];
  const consume = (event: PiRpcEvent): boolean => {
    if (isPiPermissionHooksReadyEvent(event)) {
      return true;
    }
    if (event.type === "extension_error") {
      const extensionPath = firstString(event.extensionPath) ?? "";
      if (!extensionPath || extensionPath.includes(PI_PERMISSION_EXTENSION_FILENAME)) {
        throw new PiPermissionBridgeError(
          `Pi permission extension failed: ${firstString(event.error) ?? "unknown error"}`,
        );
      }
    }
    if (event.type === "tool_execution_start") {
      throw new PiPermissionBridgeError(
        "Pi tool started before permission hooks were confirmed live. Refusing ungoverned ravi-host execution.",
      );
    }
    buffered.push(event);
    return false;
  };

  for (const event of transport.drainPendingEvents?.() ?? []) {
    if (consume(event)) {
      return buffered;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (!abortSignal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const next = await Promise.race([
      eventIterator.next().then((result) => ({ kind: "event" as const, result })),
      waitWithAbort(remaining, abortSignal).then((aborted) => ({
        kind: aborted ? ("abort" as const) : ("timeout" as const),
      })),
    ]);
    if (next.kind !== "event") {
      if (next.kind === "abort") {
        throw new PiPermissionBridgeError("Pi permission handshake aborted before hooks were confirmed live.");
      }
      break;
    }
    if (next.result.done) {
      break;
    }
    if (consume(next.result.value)) {
      return buffered;
    }
  }

  throw new PiPermissionBridgeError(PI_PERMISSION_BRIDGE_UNAVAILABLE_MESSAGE);
}

async function answerPiExtensionUiRequest(
  transport: PiRpcTransport,
  event: PiRpcEvent,
  input: RuntimeStartRequest,
): Promise<void> {
  const response = await resolvePiExtensionUiResponse(event, {
    canUseTool: input.canUseTool,
    approveRuntimeRequest: input.approveRuntimeRequest,
    allowedSkills: input.allowedSkills,
  });
  if (!response) {
    return;
  }
  if (!transport.writeMessage) {
    throw new Error("Pi RPC transport cannot answer extension UI permission requests");
  }
  await transport.writeMessage(response);
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
    drain() {
      return values.splice(0, values.length);
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

function extractPiAssistantTexts(message: PiAgentMessage): string[] {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? [content.trim()] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      blocks.push(block.text);
    }
  }
  return coalesceAssistantTextBlocks(blocks);
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

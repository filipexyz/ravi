import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { syncCodexSkills } from "../plugins/codex-skills.js";
import { ensureAgentInstructionFiles, loadAgentWorkspaceInstructions } from "./agent-instructions.js";
import type {
  RuntimeApprovalEvent,
  RuntimeApprovalHandler,
  RuntimeApprovalKind,
  RuntimeApprovalQuestion,
  RuntimeApprovalRequest,
  RuntimeApprovalResult,
  RuntimeBillingType,
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeControlState,
  RuntimeDynamicToolCallContentItem,
  RuntimeDynamicToolCallHandler,
  RuntimeDynamicToolCallRequest,
  RuntimeDynamicToolCallResult,
  RuntimeDynamicToolSpec,
  RuntimeExecutionMetadata,
  RuntimeEvent,
  RuntimeEventMetadata,
  RuntimeHostServices,
  RuntimeItemMetadata,
  RuntimePlugin,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimePromptMessage,
  RuntimeSessionState,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  RuntimeStatus,
  RuntimeThreadMetadata,
  RuntimeTurnMetadata,
  RuntimeToolUse,
  RuntimeUsage,
  SessionRuntimeProvider,
} from "./types.js";

const DEFAULT_CODEX_MODEL = "gpt-5";
const INTERRUPT_GRACE_MS = 1_500;
const CODEX_APP_SERVER_SANDBOX = "danger-full-access";
const RAVI_CODEX_BASH_HOOK_STATUS = "ravi codex bash permission gate";
const RAVI_CODEX_BASH_HOOK_MATCHER = "^Bash$";
const CODEX_RUNTIME_CONTROL_OPERATIONS: RuntimeControlOperation[] = [
  "thread.list",
  "thread.read",
  "thread.rollback",
  "thread.fork",
  "turn.steer",
  "turn.interrupt",
];
const CODEX_SKILL_DISCOVERY_NOTE = [
  "Ravi may install native Codex skills under ~/.codex/skills (or $CODEX_HOME/skills).",
  "If the task clearly matches a skill, inspect that directory and follow the relevant SKILL.md files.",
].join(" ");

interface CodexCliUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface CodexCliEvent extends Record<string, unknown> {
  type: string;
}

interface CodexJsonRpcMessage extends Record<string, unknown> {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CodexCliTurnRequest {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: string;
  prompt: string;
  resume?: string;
  systemPromptAppend: string;
  approveRuntimeRequest?: RuntimeApprovalHandler;
  dynamicTools?: RuntimeDynamicToolSpec[];
  handleRuntimeToolCall?: RuntimeDynamicToolCallHandler;
}

interface CodexCliTurnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface CodexCliTurnHandle {
  events: AsyncIterable<CodexCliEvent>;
  result: Promise<CodexCliTurnResult>;
  interrupt(): Promise<void> | void;
  control?(request: RuntimeControlRequest): Promise<RuntimeControlResult>;
}

interface CodexCliTransport {
  startTurn(input: CodexCliTurnRequest): CodexCliTurnHandle;
  control?(request: RuntimeControlRequest): Promise<RuntimeControlResult>;
  close?(): Promise<void>;
}

interface CodexSessionState {
  activeTurn: CodexCliTurnHandle | null;
  interrupted: boolean;
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

interface ToolCompletedEvent {
  syntheticStart?: RuntimeToolUse;
  toolUseId?: string;
  toolName?: string;
  content?: unknown;
  isError?: boolean;
}

type PendingRequest = {
  resolve(value: Record<string, unknown>): void;
  reject(error: unknown): void;
};

interface AppServerApprovalTurn {
  threadId?: string;
  turnId?: string;
}

export interface CreateCodexRuntimeProviderOptions {
  transport?: CodexCliTransport;
  defaultModel?: string;
  command?: string;
  syncSkills?: (plugins: RuntimePlugin[]) => string[] | undefined;
}

export interface CodexRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export function createCodexRuntimeProvider(options: CreateCodexRuntimeProviderOptions = {}): CodexRuntimeProvider {
  const defaultModel = options.defaultModel ?? process.env.RAVI_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
  const syncSkills = options.syncSkills ?? syncCodexSkills;
  const syncedSkillsByCwd = new Map<string, string[]>();

  return {
    id: "codex",
    getCapabilities() {
      return {
        supportsSessionResume: true,
        supportsSessionFork: false,
        supportsPartialText: true,
        supportsToolHooks: true,
        supportsHostSessionHooks: false,
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
        toolAccessRequirement: "tool_surface",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      ensureAgentInstructionFiles(input.cwd);
      ensureGlobalCodexBashHookConfig();
      const syncedSkills = syncSkills(input.plugins ?? []);
      syncedSkillsByCwd.set(input.cwd, Array.isArray(syncedSkills) ? syncedSkills : []);
      return input.hostServices
        ? {
            startRequest: createCodexRuntimeStartRequest(input.hostServices),
          }
        : {};
    },
    startSession(input) {
      const transport = options.transport ?? createCodexAppServerTransport({ command: options.command });
      const state: CodexSessionState = {
        activeTurn: null,
        interrupted: false,
      };

      return {
        provider: "codex",
        events: normalizeCodexEvents(input, transport, defaultModel, state, syncedSkillsByCwd.get(input.cwd) ?? []),
        interrupt: async () => {
          if (!state.activeTurn) {
            return;
          }
          state.interrupted = true;
          await state.activeTurn.interrupt();
        },
        control: async (request) => {
          if (transport.control) {
            return transport.control(request);
          }
          if (state.activeTurn?.control) {
            return state.activeTurn.control(request);
          }
          return {
            ok: false,
            operation: request.operation,
            state: {
              provider: "codex",
              activeTurn: Boolean(state.activeTurn),
              supportedOperations: [],
            },
            error: "Codex runtime control is unavailable for this transport.",
          };
        },
      };
    },
  };
}

function createCodexRuntimeStartRequest(
  hostServices: RuntimeHostServices,
): NonNullable<RuntimePrepareSessionResult["startRequest"]> {
  return {
    approveRuntimeRequest: createCodexApprovalHandler(hostServices),
    dynamicTools: hostServices.listDynamicTools(),
    handleRuntimeToolCall: createCodexDynamicToolHandler(hostServices),
  };
}

function createCodexApprovalHandler(hostServices: RuntimeHostServices): RuntimeApprovalHandler {
  return async (request) => {
    switch (request.kind) {
      case "command_execution":
        return authorizeCodexCommandExecution(hostServices, request);
      case "file_change":
        return authorizeCodexFileChange(hostServices, request);
      case "permission":
        return authorizeCodexPermissionRequest(hostServices, request);
      case "user_input":
        return requestCodexUserInput(hostServices, request);
    }
  };
}

function createCodexDynamicToolHandler(hostServices: RuntimeHostServices): RuntimeDynamicToolCallHandler {
  return (request) =>
    hostServices.executeDynamicTool(request, {
      eventData: buildCodexDynamicToolEventData(request),
    });
}

async function authorizeCodexCommandExecution(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<RuntimeApprovalResult> {
  const command = typeof request.input?.command === "string" ? request.input.command : "";
  if (!command.trim()) {
    return { approved: false, reason: "Codex command approval request did not include a command." };
  }

  return hostServices.authorizeCommandExecution({
    command,
    input: request.input,
    eventData: buildCodexApprovalEventData(request),
  });
}

async function authorizeCodexFileChange(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<RuntimeApprovalResult> {
  return hostServices.authorizeToolUse({
    toolName: request.toolName ?? "Edit",
    input: request.input,
    eventData: buildCodexApprovalEventData(request),
  });
}

async function authorizeCodexPermissionRequest(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<RuntimeApprovalResult> {
  const capabilities = extractRuntimeApprovalCapabilities(request);
  if (capabilities.length === 0) {
    return {
      approved: false,
      reason: "Unsupported Codex permission approval request shape.",
      permissions: {},
    };
  }

  let inherited = true;
  const eventData = buildCodexApprovalEventData(request);
  for (const capability of capabilities) {
    const result = await hostServices.authorizeCapability({
      ...capability,
      eventData,
    });
    if (!result.allowed) {
      return {
        approved: false,
        reason: result.reason ?? `${capability.permission} ${capability.objectType}:${capability.objectId} denied.`,
        permissions: {},
      };
    }
    inherited = inherited && result.inherited;
  }

  return {
    approved: true,
    inherited,
    permissions: buildGrantedPermissionsPayload(request.input?.permissions),
  };
}

function requestCodexUserInput(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<RuntimeApprovalResult> {
  const questions = Array.isArray(request.input?.questions)
    ? (request.input.questions as RuntimeApprovalQuestion[])
    : [];
  return hostServices.requestUserInput({
    questions,
    eventData: buildCodexApprovalEventData(request),
  });
}

function buildCodexApprovalEventData(request: RuntimeApprovalRequest): Record<string, unknown> {
  return {
    runtimeApproval: {
      provider: "codex",
      kind: request.kind,
      method: request.method,
      toolName: request.toolName,
      input: truncateRuntimeEventData(request.input),
    },
    runtimeMetadata: request.metadata,
  };
}

function buildCodexDynamicToolEventData(request: RuntimeDynamicToolCallRequest): Record<string, unknown> {
  return {
    runtimeToolCall: {
      provider: "codex",
      method: "item/tool/call",
      toolName: request.toolName,
      callId: request.callId,
      arguments: truncateRuntimeEventData(request.arguments),
    },
    runtimeMetadata: request.metadata,
  };
}

function extractRuntimeApprovalCapabilities(
  request: RuntimeApprovalRequest,
): Array<{ permission: string; objectType: string; objectId: string }> {
  const permissions = request.input?.permissions ?? request.rawRequest;
  const candidates = collectRuntimeApprovalCapabilityCandidates(permissions);
  return candidates.flatMap((candidate) => parseRuntimeApprovalCapability(candidate));
}

function collectRuntimeApprovalCapabilityCandidates(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object") {
    return [];
  }

  const direct = parseRuntimeApprovalCapability(value);
  if (direct.length > 0) {
    return [value];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (entry === true || entry === null || entry === undefined) {
      return [key];
    }
    if (entry === false) {
      return [];
    }
    return [entry, key];
  });
}

function parseRuntimeApprovalCapability(
  candidate: unknown,
): Array<{ permission: string; objectType: string; objectId: string }> {
  if (typeof candidate === "string") {
    const match = candidate.match(/^([a-z_]+)(?:\s+|:)([a-z_]+):(.+)$/i);
    if (!match) {
      return [];
    }
    return [{ permission: match[1], objectType: match[2], objectId: match[3] }];
  }

  const record = asRecord(candidate);
  if (!record) {
    return [];
  }

  const permission = firstString(record.permission, record.action, record.verb);
  const objectType = firstString(record.objectType, record.object_type, record.resourceType, record.type);
  const objectId = firstString(record.objectId, record.object_id, record.resourceId, record.id, record.name);
  if (permission && objectType && objectId) {
    return [{ permission, objectType, objectId }];
  }

  const toolName = firstString(record.toolName, record.tool_name, record.tool);
  if (toolName) {
    return [{ permission: "use", objectType: "tool", objectId: toolName }];
  }

  return [];
}

function buildGrantedPermissionsPayload(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  const capabilities = collectRuntimeApprovalCapabilityCandidates(value).flatMap((candidate) =>
    parseRuntimeApprovalCapability(candidate),
  );
  return Object.fromEntries(
    capabilities.map((capability) => [
      `${capability.permission}:${capability.objectType}:${capability.objectId}`,
      true,
    ]),
  );
}

function truncateRuntimeEventData(value: unknown): unknown {
  if (typeof value === "string" && value.length > 1000) {
    return value.slice(0, 1000) + "... [truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateRuntimeEventData(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, truncateRuntimeEventData(entry)]),
  );
}

async function* normalizeCodexEvents(
  input: RuntimeStartRequest,
  transport: CodexCliTransport,
  defaultModel: string,
  state: CodexSessionState,
  syncedSkillNames: string[],
): AsyncGenerator<RuntimeEvent> {
  let previousSessionId = resolveCodexResumeId(input.resumeSession, input.resume, input.cwd);
  const outerAbortSignal = input.abortController.signal;
  const systemPromptAppend = await buildCodexSystemPromptAppend(input.cwd, input.systemPromptAppend, syncedSkillNames);

  try {
    for await (const promptMessage of input.prompt) {
      if (outerAbortSignal.aborted) {
        break;
      }

      const promptText = extractPromptText(promptMessage);
      if (!promptText) {
        continue;
      }

      const turn = transport.startTurn({
        cwd: input.cwd,
        env: input.env ?? process.env,
        model: resolveCodexModelArg(input.model, defaultModel),
        effort: resolveCodexEffortArg(input.effort),
        prompt: promptText,
        resume: previousSessionId,
        systemPromptAppend,
        approveRuntimeRequest: input.approveRuntimeRequest,
        dynamicTools: input.dynamicTools,
        handleRuntimeToolCall: input.handleRuntimeToolCall,
      });

      state.activeTurn = turn;

      const interruptOnAbort = () => {
        void turn.interrupt();
      };
      outerAbortSignal.addEventListener("abort", interruptOnAbort, { once: true });

      let turnEnded = false;
      let turnSessionId = previousSessionId;
      let activeTurnId: string | undefined;
      let lastErrorMessage: string | undefined;
      const startedToolUseIds = new Set<string>();

      try {
        for await (const event of turn.events) {
          const rawEvent = event as Record<string, unknown>;
          const metadata = buildCodexEventMetadata(rawEvent, {
            threadId: turnSessionId,
            turnId: activeTurnId,
          });
          if (event.type !== "agent_message.delta") {
            yield { type: "provider.raw", rawEvent, metadata };
          }

          const status = mapStatusFromCliEvent(event.type);
          if (status) {
            yield { type: "status", status, rawEvent, metadata };
          }

          if (event.type === "agent_message.delta") {
            const delta = firstString(event.delta);
            if (delta) {
              yield {
                type: "text.delta",
                text: delta,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "thread.started") {
            const thread = metadata.thread ?? extractRuntimeThreadMetadata(rawEvent);
            const threadId = thread?.id;
            if (threadId) {
              turnSessionId = threadId;
            }
            if (thread) {
              yield {
                type: "thread.started",
                thread,
                rawEvent,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "turn.started") {
            const turnMetadata = metadata.turn ?? extractRuntimeTurnMetadata(rawEvent);
            if (turnMetadata?.id) {
              activeTurnId = turnMetadata.id;
            }
            if (turnMetadata) {
              yield {
                type: "turn.started",
                turn: turnMetadata,
                rawEvent,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "item.started") {
            const itemMetadata = metadata.item ?? extractRuntimeItemMetadata(event.item);
            if (itemMetadata) {
              yield {
                type: "item.started",
                item: itemMetadata,
                rawEvent,
                metadata,
              };
            }

            const toolStart = extractCliToolStarted(event.item);
            if (toolStart) {
              startedToolUseIds.add(toolStart.id);
              yield {
                type: "tool.started",
                toolUse: toolStart,
                rawEvent,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "item.completed") {
            const itemMetadata = metadata.item ?? extractRuntimeItemMetadata(event.item);
            if (itemMetadata) {
              yield {
                type: "item.completed",
                item: itemMetadata,
                rawEvent,
                metadata,
              };
            }

            const assistantText = extractAssistantText(event.item);
            if (assistantText) {
              yield {
                type: "assistant.message",
                text: assistantText,
                rawEvent,
                metadata,
              };
            }

            const toolCompleted = extractCliToolCompleted(event.item);
            const toolUseId = toolCompleted?.toolUseId ?? toolCompleted?.syntheticStart?.id;
            if (toolCompleted?.syntheticStart && !(toolUseId && startedToolUseIds.has(toolUseId))) {
              yield {
                type: "tool.started",
                toolUse: toolCompleted.syntheticStart,
                rawEvent,
                metadata,
              };
            }
            if (toolCompleted) {
              yield {
                type: "tool.completed",
                toolUseId: toolCompleted.toolUseId,
                toolName: toolCompleted.toolName,
                content: toolCompleted.content,
                isError: toolCompleted.isError,
                rawEvent,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "approval.requested" || event.type === "approval.resolved") {
            const approval = extractRuntimeApprovalEvent(rawEvent);
            if (approval) {
              yield {
                type: event.type,
                approval,
                rawEvent,
                metadata,
              };
            }
            continue;
          }

          if (event.type === "error") {
            lastErrorMessage = extractCliErrorMessage(event) ?? lastErrorMessage;
            continue;
          }

          if (event.type === "turn.interrupted") {
            yield { type: "turn.interrupted", rawEvent, metadata };
            turnEnded = true;
            break;
          }

          if (event.type === "turn.failed") {
            yield {
              type: "turn.failed",
              error: extractCliFailureMessage(event) ?? lastErrorMessage ?? "Codex turn failed",
              recoverable: true,
              rawEvent,
              metadata,
            };
            turnEnded = true;
            break;
          }

          if (event.type === "turn.completed") {
            previousSessionId = metadata.thread?.id ?? turnSessionId;
            yield {
              type: "turn.complete",
              providerSessionId: previousSessionId,
              session: buildCodexSessionState(previousSessionId, input.cwd),
              execution: buildCodexExecutionMetadata(
                input,
                defaultModel,
                firstString(event.model),
                firstString(event.model_provider),
              ),
              usage: mapCliUsage(event.usage),
              rawEvent,
              metadata,
            };
            turnEnded = true;
            break;
          }
        }

        const result = await turn.result;
        if (turnEnded) {
          state.interrupted = false;
          continue;
        }

        if (outerAbortSignal.aborted && !state.interrupted) {
          break;
        }

        if (state.interrupted || result.signal === "SIGINT" || result.signal === "SIGTERM") {
          state.interrupted = false;
          const metadata = buildCodexEventMetadata(
            { type: "turn.interrupted", thread_id: turnSessionId, turn_id: activeTurnId },
            { threadId: turnSessionId, turnId: activeTurnId },
          );
          yield { type: "status", status: "idle", metadata };
          yield { type: "turn.interrupted", metadata };
          continue;
        }

        const stderrMessage = result.stderr.trim();
        const metadata = buildCodexEventMetadata(
          { type: "turn.failed", thread_id: turnSessionId, turn_id: activeTurnId },
          { threadId: turnSessionId, turnId: activeTurnId },
        );
        yield {
          type: "turn.failed",
          error:
            lastErrorMessage ??
            (stderrMessage || `Codex CLI exited without a terminal event (code ${result.exitCode ?? "unknown"})`),
          recoverable: true,
          metadata,
        };
      } catch (error) {
        if (outerAbortSignal.aborted && !state.interrupted) {
          break;
        }

        if (state.interrupted || isAbortLikeError(error)) {
          state.interrupted = false;
          const metadata = buildCodexEventMetadata(
            { type: "turn.interrupted", thread_id: turnSessionId, turn_id: activeTurnId },
            { threadId: turnSessionId, turnId: activeTurnId },
          );
          yield { type: "status", status: "idle", metadata };
          yield { type: "turn.interrupted", metadata };
          continue;
        }

        throw error;
      } finally {
        outerAbortSignal.removeEventListener("abort", interruptOnAbort);
        if (state.activeTurn === turn) {
          state.activeTurn = null;
        }
      }
    }
  } finally {
    await transport.close?.();
  }
}

function createCodexAppServerTransport(options: { command?: string } = {}): CodexCliTransport {
  const command = options.command ?? "codex";

  type AppServerTurnState = {
    queue: AsyncQueue<CodexCliEvent>;
    result: Promise<CodexCliTurnResult>;
    resolveResult: (result: CodexCliTurnResult) => void;
    stderrOffset: number;
    lastUsage?: CodexCliUsage;
    turnId?: string;
    threadId?: string;
    approveRuntimeRequest?: RuntimeApprovalHandler;
    handleRuntimeToolCall?: RuntimeDynamicToolCallHandler;
    settled: boolean;
    interruptRequested: boolean;
  };

  let child: ReturnType<typeof spawn> | null = null;
  let closed = true;
  let forcedKillTimer: ReturnType<typeof setTimeout> | null = null;
  let stderr = "";
  let nextRequestId = 1;
  let currentThreadId: string | undefined;
  let resolvedModel: string | null = null;
  let resolvedModelProvider = "openai";
  let pendingRequests = new Map<string, PendingRequest>();
  let bootstrapPromise: Promise<void> | null = null;
  let activeTurn: AppServerTurnState | null = null;

  const clearForcedKillTimer = () => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer);
      forcedKillTimer = null;
    }
  };

  const currentChild = () => {
    if (!child || closed) {
      throw new Error("Codex app-server is not connected");
    }
    return child;
  };

  const settleTurn = (
    turn: AppServerTurnState,
    result: Partial<CodexCliTurnResult> = {},
    options?: { failQueue?: unknown },
  ) => {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    if (activeTurn === turn) {
      activeTurn = null;
    }

    if (options?.failQueue !== undefined) {
      turn.queue.fail(options.failQueue);
    } else {
      turn.queue.end();
    }

    turn.resolveResult({
      exitCode: result.exitCode ?? 0,
      signal: result.signal ?? null,
      stderr: result.stderr ?? stderr.slice(turn.stderrOffset),
    });
  };

  const rejectPendingRequests = (error: Error) => {
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
  };

  const handleChildTermination = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
    closed = true;
    clearForcedKillTimer();
    const disconnectError =
      error ?? new Error(`Codex app-server exited unexpectedly (${signal ?? exitCode ?? "unknown"})`);
    rejectPendingRequests(disconnectError);
    if (activeTurn) {
      settleTurn(
        activeTurn,
        {
          exitCode,
          signal,
          stderr: stderr.slice(activeTurn.stderrOffset),
        },
        error ? { failQueue: error } : undefined,
      );
    }
    child = null;
  };

  const spawnChild = (input: CodexCliTurnRequest) => {
    ensureGlobalCodexBashHookConfig();
    const spawned = spawn(command, ["-c", "features.codex_hooks=true", "app-server"], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child = spawned;
    closed = false;
    stderr = "";
    nextRequestId = 1;
    pendingRequests = new Map();
    clearForcedKillTimer();

    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    spawned.stdout.setEncoding("utf8");
    const stdoutLines = createInterface({ input: spawned.stdout });
    stdoutLines.on("line", (line) => {
      const value = line.trim();
      if (!value) {
        return;
      }

      try {
        const parsed = JSON.parse(value) as CodexJsonRpcMessage;
        routeAppServerMessage(parsed);
      } catch (error) {
        if (activeTurn) {
          settleTurn(activeTurn, { exitCode: 1, stderr }, { failQueue: error });
        }
        spawned.kill("SIGKILL");
      }
    });

    spawned.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        if (activeTurn) {
          settleTurn(activeTurn, { exitCode: 1, stderr }, { failQueue: error });
        }
        spawned.kill("SIGKILL");
      }
    });

    spawned.on("error", (error) => {
      handleChildTermination(1, null, error);
    });

    spawned.on("close", (exitCode, signal) => {
      handleChildTermination(exitCode, signal);
    });
  };

  async function writeJsonRpc(message: Record<string, unknown>): Promise<void> {
    const payload = `${JSON.stringify(message)}\n`;
    const activeChild = currentChild();
    const stdin = activeChild.stdin;
    if (!stdin) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  function sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(nextRequestId++);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      void writeJsonRpc({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  async function handleServerRequest(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    if (isCodexApprovalRequestMethod(method)) {
      const request = buildRuntimeApprovalRequest(method, params, activeTurn, currentThreadId);
      activeTurn?.queue.push(buildApprovalTraceEvent("approval.requested", request));

      let approvalResult: RuntimeApprovalResult;
      if (!activeTurn?.approveRuntimeRequest) {
        approvalResult = {
          approved: false,
          reason: "No Ravi approval handler is available for this Codex request.",
        };
      } else {
        try {
          approvalResult = await activeTurn.approveRuntimeRequest(request);
        } catch (error) {
          approvalResult = {
            approved: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      activeTurn?.queue.push(buildApprovalTraceEvent("approval.resolved", request, approvalResult));
      await writeJsonRpc({ id, result: buildCodexApprovalResponse(method, params, approvalResult) });
      return;
    }

    switch (method) {
      case "item/tool/call":
        await handleDynamicToolCall(id, params);
        return;
      default:
        await writeJsonRpc({
          id,
          error: {
            code: -32601,
            message: `Unsupported Codex app-server request: ${method}`,
          },
        });
    }
  }

  async function handleDynamicToolCall(id: string, params: Record<string, unknown>): Promise<void> {
    const request = buildRuntimeDynamicToolCallRequest(params, activeTurn, currentThreadId);
    activeTurn?.queue.push(buildDynamicToolTraceEvent("item.started", request));

    let result: RuntimeDynamicToolCallResult;
    if (!activeTurn?.handleRuntimeToolCall) {
      result = {
        success: false,
        contentItems: [
          { type: "inputText", text: "No Ravi dynamic tool handler is available for this Codex request." },
        ],
      };
    } else {
      try {
        result = await activeTurn.handleRuntimeToolCall(request);
      } catch (error) {
        result = {
          success: false,
          contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }

    const response = buildCodexDynamicToolCallResponse(result);
    activeTurn?.queue.push(buildDynamicToolTraceEvent("item.completed", request, response));
    await writeJsonRpc({ id, result: response });
  }

  const requestTurnInterrupt = async (turn: AppServerTurnState) => {
    if (turn.settled || !turn.turnId) {
      return;
    }

    const threadId = turn.threadId ?? currentThreadId;
    if (!threadId) {
      return;
    }

    try {
      await sendRequest("turn/interrupt", {
        threadId,
        turnId: turn.turnId,
      });
    } catch {
      if (!child || closed) {
        return;
      }
      child.kill("SIGINT");
      forcedKillTimer = setTimeout(() => {
        if (!closed && child) {
          child.kill("SIGKILL");
        }
      }, INTERRUPT_GRACE_MS);
      forcedKillTimer.unref?.();
    }
  };

  const buildRuntimeControlState = (): RuntimeControlState => ({
    provider: "codex",
    threadId: activeTurn?.threadId ?? currentThreadId,
    turnId: activeTurn?.turnId,
    activeTurn: Boolean(activeTurn && !activeTurn.settled),
    supportedOperations: CODEX_RUNTIME_CONTROL_OPERATIONS,
  });

  const buildRuntimeControlSuccess = (
    request: RuntimeControlRequest,
    data: Record<string, unknown> = {},
  ): RuntimeControlResult => ({
    ok: true,
    operation: request.operation,
    data,
    state: buildRuntimeControlState(),
  });

  const buildRuntimeControlError = (request: RuntimeControlRequest, error: unknown): RuntimeControlResult => ({
    ok: false,
    operation: request.operation,
    error: error instanceof Error ? error.message : String(error),
    state: buildRuntimeControlState(),
  });

  const resolveControlThreadId = (request: RuntimeControlRequest): string => {
    const threadId = request.threadId ?? activeTurn?.threadId ?? currentThreadId;
    if (!threadId) {
      throw new Error(`${request.operation} requires a Codex thread id.`);
    }
    return threadId;
  };

  const resolveActiveTurnForControl = (request: RuntimeControlRequest): AppServerTurnState => {
    if (!activeTurn || activeTurn.settled) {
      throw new Error(`${request.operation} requires an active Codex turn.`);
    }
    return activeTurn;
  };

  const normalizeRuntimeControlUserInput = (request: RuntimeControlRequest): unknown[] => {
    if (Array.isArray(request.input) && request.input.length > 0) {
      return request.input;
    }

    const text = typeof request.text === "string" ? request.text : "";
    if (!text.trim()) {
      throw new Error("turn.steer requires text or input.");
    }

    return [
      {
        type: "text",
        text,
        text_elements: [],
      },
    ];
  };

  const assertNoActiveTurnForThreadMutation = (request: RuntimeControlRequest) => {
    if (activeTurn && !activeTurn.settled) {
      throw new Error(`${request.operation} cannot run while a Codex turn is active.`);
    }
  };

  const handleRuntimeControl = async (request: RuntimeControlRequest): Promise<RuntimeControlResult> => {
    try {
      switch (request.operation) {
        case "thread.list": {
          const data = await sendRequest("thread/list", {
            cursor: request.cursor ?? null,
            limit: request.limit ?? null,
            sortKey: request.sortKey ?? null,
            modelProviders: request.modelProviders ?? null,
            sourceKinds: request.sourceKinds ?? null,
            archived: request.archived ?? null,
            cwd: request.cwd ?? null,
            searchTerm: request.searchTerm ?? null,
          });
          return buildRuntimeControlSuccess(request, data);
        }

        case "thread.read": {
          const threadId = resolveControlThreadId(request);
          const data = await sendRequest("thread/read", {
            threadId,
            includeTurns: request.includeTurns ?? true,
          });
          return buildRuntimeControlSuccess(request, data);
        }

        case "thread.rollback": {
          assertNoActiveTurnForThreadMutation(request);
          const threadId = resolveControlThreadId(request);
          const numTurns = request.numTurns ?? 1;
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            throw new Error("thread.rollback requires numTurns >= 1.");
          }

          const data = await sendRequest("thread/rollback", {
            threadId,
            numTurns,
          });
          return buildRuntimeControlSuccess(request, data);
        }

        case "thread.fork": {
          assertNoActiveTurnForThreadMutation(request);
          const threadId = resolveControlThreadId(request);
          const data = await sendRequest("thread/fork", {
            threadId,
            path: request.path ?? null,
            model: null,
            modelProvider: null,
            serviceTier: null,
            cwd: request.cwd ?? null,
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandbox: CODEX_APP_SERVER_SANDBOX,
            config: null,
            baseInstructions: null,
            developerInstructions: null,
            ephemeral: false,
            persistExtendedHistory: true,
          });
          return buildRuntimeControlSuccess(request, data);
        }

        case "turn.steer": {
          const turn = resolveActiveTurnForControl(request);
          const threadId = request.threadId ?? turn.threadId ?? currentThreadId;
          const turnId = request.expectedTurnId ?? request.turnId ?? turn.turnId;
          if (!threadId || !turnId) {
            throw new Error("turn.steer requires an active Codex thread and turn id.");
          }

          const data = await sendRequest("turn/steer", {
            threadId,
            input: normalizeRuntimeControlUserInput(request),
            responsesapiClientMetadata: null,
            expectedTurnId: turnId,
          });
          return buildRuntimeControlSuccess(request, data);
        }

        case "turn.interrupt": {
          const turn = resolveActiveTurnForControl(request);
          turn.interruptRequested = true;
          const threadId = request.threadId ?? turn.threadId ?? currentThreadId;
          const turnId = request.turnId ?? turn.turnId;
          if (!threadId) {
            throw new Error("turn.interrupt requires an active Codex thread id.");
          }

          if (turnId) {
            if (turnId === turn.turnId) {
              await requestTurnInterrupt(turn);
            } else {
              await sendRequest("turn/interrupt", { threadId, turnId });
            }
          }

          return buildRuntimeControlSuccess(request, {
            interrupted: Boolean(turnId),
            pending: !turnId,
            threadId,
            turnId: turnId ?? null,
          });
        }

        default:
          return buildRuntimeControlError(request, `Unsupported Codex runtime control operation: ${request.operation}`);
      }
    } catch (error) {
      return buildRuntimeControlError(request, error);
    }
  };

  function routeAppServerMessage(message: CodexJsonRpcMessage): void {
    if (typeof message.id === "string" || typeof message.id === "number") {
      const requestId = String(message.id);
      if (typeof message.method === "string") {
        void handleServerRequest(requestId, message.method, asRecord(message.params) ?? {}).catch((error) => {
          if (activeTurn) {
            settleTurn(activeTurn, { exitCode: 1, stderr }, { failQueue: error });
          }
        });
        return;
      }

      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        if (message.error) {
          pending.reject(new Error(extractJsonRpcError(message.error) ?? "Codex app-server request failed"));
        } else {
          pending.resolve(asRecord(message.result) ?? {});
        }
      }
      return;
    }

    const method = typeof message.method === "string" ? message.method : undefined;
    const params = asRecord(message.params) ?? {};
    if (!method) {
      return;
    }

    const turn = activeTurn;

    switch (method) {
      case "error": {
        if (turn) {
          turn.queue.push({
            type: "error",
            message: extractAppServerErrorMessage(params) ?? "Codex app-server error",
          });
        }
        break;
      }
      case "thread/started": {
        const thread = normalizeAppServerThread(params.thread);
        const threadId = thread?.id;
        if (threadId) {
          currentThreadId = threadId;
          if (turn) {
            turn.threadId = threadId;
            turn.queue.push({
              type: "thread.started",
              source: "codex.app-server",
              thread_id: threadId,
              thread,
            });
            if (turn.interruptRequested && turn.turnId) {
              void requestTurnInterrupt(turn);
            }
          }
        }
        break;
      }
      case "turn/started": {
        if (turn) {
          const startedTurn = normalizeAppServerTurn(params.turn);
          turn.threadId = firstString(params.threadId, turn.threadId, currentThreadId);
          turn.turnId = firstString(startedTurn?.id, turn.turnId);
          turn.queue.push({
            type: "turn.started",
            source: "codex.app-server",
            thread_id: turn.threadId,
            turn_id: turn.turnId,
            turn: startedTurn,
          });
          if (turn.interruptRequested) {
            void requestTurnInterrupt(turn);
          }
        }
        break;
      }
      case "item/started": {
        if (turn) {
          const item = normalizeAppServerItem(params.item);
          if (item) {
            turn.queue.push({
              type: "item.started",
              source: "codex.app-server",
              thread_id: turn.threadId ?? currentThreadId,
              turn_id: turn.turnId,
              item,
            });
          }
        }
        break;
      }
      case "item/completed": {
        if (turn) {
          const item = normalizeAppServerItem(params.item);
          if (item) {
            turn.queue.push({
              type: "item.completed",
              source: "codex.app-server",
              thread_id: turn.threadId ?? currentThreadId,
              turn_id: turn.turnId,
              item,
            });
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        if (turn) {
          const delta = firstString(params.delta);
          if (delta) {
            turn.queue.push({
              type: "agent_message.delta",
              source: "codex.app-server",
              thread_id: turn.threadId ?? currentThreadId,
              turn_id: turn.turnId,
              delta,
              item_id: firstString(params.itemId),
            });
          }
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        if (turn) {
          turn.lastUsage = extractAppServerUsage(params.tokenUsage);
        }
        break;
      }
      case "turn/completed": {
        if (!turn) {
          break;
        }

        const completedTurn = asRecord(params.turn);
        const status = typeof completedTurn?.status === "string" ? completedTurn.status : "completed";
        if (status === "completed") {
          turn.queue.push({
            type: "turn.completed",
            source: "codex.app-server",
            thread_id: turn.threadId ?? currentThreadId,
            turn_id: turn.turnId,
            turn: normalizeAppServerTurn(completedTurn),
            usage: turn.lastUsage ?? {},
            model: resolvedModel,
            model_provider: resolvedModelProvider,
          });
        } else if (status === "interrupted") {
          turn.queue.push({
            type: "turn.interrupted",
            source: "codex.app-server",
            thread_id: turn.threadId ?? currentThreadId,
            turn_id: turn.turnId,
            turn: normalizeAppServerTurn(completedTurn),
          });
        } else {
          turn.queue.push({
            type: "turn.failed",
            source: "codex.app-server",
            thread_id: turn.threadId ?? currentThreadId,
            turn_id: turn.turnId,
            turn: normalizeAppServerTurn(completedTurn),
            error: extractAppServerTurnError(completedTurn) ?? `Codex turn ${status}`,
          });
        }
        settleTurn(turn);
        break;
      }
      default:
        break;
    }
  }

  async function ensureClient(input: CodexCliTurnRequest): Promise<void> {
    if (!closed && child && !bootstrapPromise) {
      return;
    }
    if (bootstrapPromise) {
      await bootstrapPromise;
      return;
    }

    if (!child || closed) {
      spawnChild(input);
    }

    bootstrapPromise = (async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: {
            name: "ravi",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: CODEX_APP_SERVER_OPTOUT_METHODS,
          },
        });

        await writeJsonRpc({
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        });

        const resumeThreadId = currentThreadId ?? input.resume;
        const threadResponse = resumeThreadId
          ? await sendRequest("thread/resume", {
              threadId: resumeThreadId,
              model: input.model ?? null,
              modelProvider: null,
              cwd: input.cwd,
              approvalPolicy: "never",
              sandbox: CODEX_APP_SERVER_SANDBOX,
              config: input.effort ? { model_reasoning_effort: input.effort } : null,
              baseInstructions: null,
              developerInstructions: input.systemPromptAppend || null,
              dynamicTools: input.dynamicTools ?? null,
              personality: null,
              persistExtendedHistory: false,
            })
          : await sendRequest("thread/start", {
              model: input.model ?? null,
              modelProvider: null,
              cwd: input.cwd,
              approvalPolicy: "never",
              sandbox: CODEX_APP_SERVER_SANDBOX,
              config: input.effort ? { model_reasoning_effort: input.effort } : null,
              serviceName: null,
              baseInstructions: null,
              developerInstructions: input.systemPromptAppend || null,
              dynamicTools: input.dynamicTools ?? null,
              personality: null,
              ephemeral: false,
              experimentalRawEvents: false,
              persistExtendedHistory: false,
            });

        currentThreadId = firstString(asRecord(threadResponse.thread)?.id, resumeThreadId);
        resolvedModel = firstString(threadResponse.model, input.model) ?? null;
        resolvedModelProvider = firstString(threadResponse.modelProvider, resolvedModelProvider) ?? "openai";
      } finally {
        bootstrapPromise = null;
      }
    })();

    await bootstrapPromise;
  }

  const close = async () => {
    if (!child || closed) {
      return;
    }
    const targetChild = child;
    targetChild.stdin?.end();
    targetChild.kill("SIGTERM");
    forcedKillTimer = setTimeout(() => {
      if (child === targetChild && !closed) {
        targetChild.kill("SIGKILL");
      }
    }, INTERRUPT_GRACE_MS);
    forcedKillTimer.unref?.();

    await new Promise<void>((resolve) => {
      if (closed || child !== targetChild) {
        resolve();
        return;
      }
      targetChild.once("close", () => resolve());
    });
  };

  return {
    control: handleRuntimeControl,
    startTurn(input) {
      if (activeTurn && !activeTurn.settled) {
        throw new Error("Codex app-server transport does not support overlapping turns");
      }

      let resolveResult!: (result: CodexCliTurnResult) => void;
      const queue = createAsyncQueue<CodexCliEvent>();
      const turn: AppServerTurnState = {
        queue,
        result: new Promise<CodexCliTurnResult>((resolve) => {
          resolveResult = resolve;
        }),
        resolveResult,
        stderrOffset: stderr.length,
        approveRuntimeRequest: input.approveRuntimeRequest,
        handleRuntimeToolCall: input.handleRuntimeToolCall,
        settled: false,
        interruptRequested: false,
      };
      activeTurn = turn;

      void (async () => {
        try {
          await ensureClient(input);
          turn.threadId = currentThreadId ?? input.resume;
          if (!turn.threadId) {
            throw new Error("Codex app-server did not initialize a thread");
          }
          await sendRequest("turn/start", {
            threadId: turn.threadId,
            input: [
              {
                type: "text",
                text: input.prompt,
                text_elements: [],
              },
            ],
            cwd: null,
            approvalPolicy: null,
            sandboxPolicy: null,
            model: null,
            effort: input.effort ?? null,
            summary: null,
            personality: null,
            outputSchema: null,
            collaborationMode: null,
          });
        } catch (error) {
          settleTurn(turn, { exitCode: 1, stderr: stderr.slice(turn.stderrOffset) }, { failQueue: error });
          if (child && !closed) {
            child.kill("SIGKILL");
          }
        }
      })();

      return {
        events: queue,
        result: turn.result,
        interrupt: async () => {
          if (turn.settled) {
            return;
          }
          turn.interruptRequested = true;
          if (turn.turnId) {
            await requestTurnInterrupt(turn);
          }
        },
        control: handleRuntimeControl,
      };
    },
    close,
  };
}

function _createCodexCliTransport(options: { command?: string } = {}): CodexCliTransport {
  const command = options.command ?? "codex";

  return {
    startTurn(input) {
      const args = buildExecArgs(input.resume, input.model, input.effort);
      const child = spawn(command, args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const queue = createAsyncQueue<CodexCliEvent>();
      let stderr = "";
      let closed = false;
      let forcedKillTimer: ReturnType<typeof setTimeout> | null = null;

      const result = new Promise<CodexCliTurnResult>((resolve, reject) => {
        child.on("error", (error) => {
          queue.fail(error);
          reject(error);
        });

        child.on("close", (exitCode, signal) => {
          closed = true;
          if (forcedKillTimer) {
            clearTimeout(forcedKillTimer);
            forcedKillTimer = null;
          }
          queue.end();
          resolve({
            exitCode,
            signal,
            stderr,
          });
        });
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.stdout.setEncoding("utf8");
      const stdoutLines = createInterface({ input: child.stdout });
      stdoutLines.on("line", (line) => {
        const value = line.trim();
        if (!value) {
          return;
        }

        try {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
            throw new Error(`Invalid Codex JSON event: ${value}`);
          }
          queue.push(parsed as CodexCliEvent);
        } catch (error) {
          queue.fail(error);
        }
      });

      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          queue.fail(error);
        }
      });
      child.stdin.end(composePrompt(input.prompt, input.systemPromptAppend));

      return {
        events: queue,
        result,
        interrupt: async () => {
          if (closed) {
            return;
          }

          child.kill("SIGINT");
          forcedKillTimer = setTimeout(() => {
            if (!closed) {
              child.kill("SIGKILL");
            }
          }, INTERRUPT_GRACE_MS);
          forcedKillTimer.unref?.();
        },
      };
    },
  };
}

function buildExecArgs(resume: string | undefined, model?: string, effort?: string): string[] {
  const args = resume ? ["exec", "resume"] : ["exec"];

  args.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");

  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }

  if (resume) {
    args.push(resume);
  }

  args.push("-");

  return args;
}

function composePrompt(promptText: string, systemPromptAppend: string): string {
  const systemInstructions = systemPromptAppend.trim();
  if (!systemInstructions) {
    return promptText;
  }

  return [
    "Additional system instructions. Follow them exactly.",
    systemInstructions,
    "",
    "User request:",
    promptText,
  ].join("\n");
}

async function buildCodexSystemPromptAppend(
  cwd: string,
  runtimeSystemPromptAppend: string,
  syncedSkillNames: string[],
): Promise<string> {
  const sections = [buildCodexSkillCatalogInstruction(syncedSkillNames)];
  const runtimeInstructions = runtimeSystemPromptAppend.trim();
  const workspaceInstructions = runtimePromptIncludesWorkspaceInstructions(runtimeInstructions)
    ? null
    : await loadWorkspaceInstructions(cwd);
  if (workspaceInstructions) {
    sections.push(
      [
        `Workspace instructions loaded from ${workspaceInstructions.path}. Treat them as authoritative for this workspace.`,
        `Resolve relative file references from ${cwd}/.`,
        "",
        workspaceInstructions.content,
      ].join("\n"),
    );
  }

  if (runtimeInstructions) {
    sections.push(runtimeInstructions);
  }

  return sections.join("\n\n");
}

function runtimePromptIncludesWorkspaceInstructions(runtimeSystemPromptAppend: string): boolean {
  return /^## Workspace Instructions$/m.test(runtimeSystemPromptAppend);
}

function buildCodexSkillCatalogInstruction(syncedSkillNames: string[]): string {
  if (syncedSkillNames.length === 0) {
    return CODEX_SKILL_DISCOVERY_NOTE;
  }

  const catalog = syncedSkillNames.map((name) => `- ${name}`).join("\n");
  return [
    CODEX_SKILL_DISCOVERY_NOTE,
    "",
    "Ravi synchronized these Codex skills for this session:",
    catalog,
    "",
    "If the user asks what skills are available, answer from this list. When a task matches one of these skills, inspect the corresponding SKILL.md file and follow it.",
  ].join("\n");
}

async function loadWorkspaceInstructions(cwd: string): Promise<{ path: string; content: string } | null> {
  return loadAgentWorkspaceInstructions(cwd);
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

function resolveCodexModelArg(model: string, fallbackModel: string): string | undefined {
  const value = model?.trim();
  if (!value) {
    return normalizeDefaultCodexModel(fallbackModel);
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("claude") || lower === "sonnet" || lower === "haiku" || lower === "opus") {
    return normalizeDefaultCodexModel(fallbackModel);
  }

  if (fallbackModel.trim() && lower === fallbackModel.trim().toLowerCase()) {
    return normalizeDefaultCodexModel(fallbackModel);
  }

  if (lower === "gpt-5") {
    return undefined;
  }

  return value;
}

function resolveCodexExecutionModel(model: string, fallbackModel: string): string | null {
  const resolved = resolveCodexModelArg(model, fallbackModel);
  if (resolved) {
    return resolved;
  }

  const value = fallbackModel.trim();
  if (!value || value.toLowerCase() === DEFAULT_CODEX_MODEL) {
    return null;
  }

  return value;
}

function resolveCodexEffortArg(effort: string | undefined): string | undefined {
  return effort === "max" ? "xhigh" : effort;
}

function normalizeDefaultCodexModel(fallbackModel: string): string | undefined {
  const value = fallbackModel.trim();
  if (!value || value.toLowerCase() === DEFAULT_CODEX_MODEL) {
    return undefined;
  }
  return value;
}

function resolveCodexResumeId(
  resumeSession: RuntimeSessionState | undefined,
  legacyResumeId: string | undefined,
  cwd: string,
): string | undefined {
  const params = asRecord(resumeSession?.params);
  const sessionId = firstString(params?.sessionId) ?? legacyResumeId;
  if (!sessionId) {
    return undefined;
  }

  const storedCwd = firstString(params?.cwd);
  if (storedCwd && storedCwd !== cwd) {
    return undefined;
  }

  return sessionId;
}

function buildCodexSessionState(sessionId: string | undefined, cwd: string): RuntimeSessionState | undefined {
  if (!sessionId) {
    return undefined;
  }

  return {
    params: {
      sessionId,
      cwd,
    },
    displayId: sessionId,
  };
}

function buildCodexExecutionMetadata(
  input: RuntimeStartRequest,
  defaultModel: string,
  actualModel?: string,
  actualProvider?: string,
): RuntimeExecutionMetadata {
  return {
    provider: actualProvider ?? "openai",
    model: actualModel ?? resolveCodexExecutionModel(input.model, defaultModel),
    billingType: resolveCodexBillingType(input.env ?? process.env),
  };
}

function resolveCodexBillingType(env: NodeJS.ProcessEnv): RuntimeBillingType {
  const apiKey = env.OPENAI_API_KEY;
  return typeof apiKey === "string" && apiKey.trim().length > 0 ? "api" : "subscription";
}

function extractPromptText(message: RuntimePromptMessage): string | null {
  const content = message.message.content;
  const value = content.trim();
  return value.length > 0 ? value : null;
}

function mapCliUsage(usage: unknown): RuntimeUsage {
  const value = (usage ?? {}) as CodexCliUsage;
  return {
    inputTokens: toNumber(value.input_tokens),
    outputTokens: toNumber(value.output_tokens),
    cacheReadTokens: toNumber(value.cached_input_tokens),
    cacheCreationTokens: 0,
  };
}

function mapStatusFromCliEvent(type: string): RuntimeStatus | null {
  if (type === "turn.started") {
    return "thinking";
  }
  if (type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted") {
    return "idle";
  }
  return null;
}

function buildCodexEventMetadata(
  event: Record<string, unknown>,
  fallback: { threadId?: string; turnId?: string } = {},
): RuntimeEventMetadata {
  const thread =
    extractRuntimeThreadMetadata(event) ??
    (fallback.threadId
      ? {
          id: fallback.threadId,
        }
      : undefined);
  const turn =
    extractRuntimeTurnMetadata(event) ??
    (fallback.turnId
      ? {
          id: fallback.turnId,
        }
      : undefined);
  const item = extractRuntimeItemMetadata(event.item) ?? extractRuntimeItemMetadata(event);

  return {
    provider: "codex",
    source: firstString(event.source) ?? "codex",
    nativeEvent: typeof event.type === "string" ? event.type : undefined,
    ...(thread ? { thread } : {}),
    ...(turn ? { turn } : {}),
    ...(item ? { item } : {}),
  };
}

function extractRuntimeThreadMetadata(event: Record<string, unknown> | null): RuntimeThreadMetadata | undefined {
  if (!event) {
    return undefined;
  }

  const thread = asRecord(event.thread);
  const id = firstString(event.thread_id, event.threadId, thread?.id);
  const title = firstString(thread?.title, event.thread_title, event.threadTitle);
  if (!id && !title) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
  };
}

function extractRuntimeTurnMetadata(event: Record<string, unknown> | null): RuntimeTurnMetadata | undefined {
  if (!event) {
    return undefined;
  }

  const turn = asRecord(event.turn);
  const id = firstString(event.turn_id, event.turnId, turn?.id);
  const status = firstString(event.turn_status, event.turnStatus, turn?.status);
  if (!id && !status) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
  };
}

function extractRuntimeItemMetadata(item: unknown): RuntimeItemMetadata | undefined {
  const record = asRecord(item);
  if (!record) {
    return undefined;
  }

  const nested = asRecord(record.item);
  const source = nested ?? record;
  const id = firstString(record.item_id, record.itemId, source.id);
  const type = nested || (!record.item_id && !record.itemId) ? firstString(source.type) : undefined;
  const status = firstString(source.status);
  const parentId = firstString(
    source.parent_id,
    source.parentId,
    source.parent_item_id,
    source.parentItemId,
    record.parent_item_id,
    record.parentItemId,
  );

  if (!id && !type && !status && !parentId) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function extractAssistantText(item: unknown): string {
  const record = asRecord(item);
  if (!record || record.type !== "agent_message") {
    return "";
  }

  return typeof record.text === "string" ? record.text : "";
}

function extractCliToolStarted(item: unknown): RuntimeToolUse | null {
  const record = asRecord(item);
  if (!record || typeof record.type !== "string" || isNonToolItemType(record.type)) {
    return null;
  }

  const status = typeof record.status === "string" ? record.status : undefined;
  if (status && status !== "in_progress") {
    return null;
  }

  const toolName =
    record.type === "dynamic_tool_call" ? (firstString(record.tool) ?? record.type) : normalizeCliToolName(record.type);
  const toolUseId = firstString(record.id);
  if (!toolUseId) {
    return null;
  }

  return {
    id: toolUseId,
    name: toolName,
    input: extractCliToolInput(record),
  };
}

function extractCliToolCompleted(item: unknown): ToolCompletedEvent | null {
  const record = asRecord(item);
  if (!record || typeof record.type !== "string" || isNonToolItemType(record.type)) {
    return null;
  }

  const toolUseId = firstString(record.id);
  const toolName =
    record.type === "dynamic_tool_call" ? (firstString(record.tool) ?? record.type) : normalizeCliToolName(record.type);
  const status = typeof record.status === "string" ? record.status : "completed";

  const result: ToolCompletedEvent = {
    toolUseId,
    toolName,
    content: extractCliToolOutput(record),
    isError: status === "failed",
  };

  if (!hasExplicitStart(record)) {
    result.syntheticStart = {
      id: toolUseId ?? `${toolName}-unknown`,
      name: toolName,
      input: extractCliToolInput(record),
    };
  }

  return result;
}

function hasExplicitStart(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  return type === "command_execution";
}

function isNonToolItemType(type: string): boolean {
  return type === "agent_message" || type === "user_message" || type === "reasoning";
}

function normalizeCliToolName(type: string): string {
  if (type === "command_execution") {
    return "shell";
  }
  return type;
}

function extractCliToolInput(item: Record<string, unknown>): unknown {
  if (item.type === "dynamic_tool_call") {
    return item.arguments;
  }
  if (typeof item.command === "string") {
    return { command: item.command };
  }
  if (Array.isArray(item.changes)) {
    return { changes: item.changes };
  }
  return undefined;
}

function extractCliToolOutput(item: Record<string, unknown>): unknown {
  if (item.type === "dynamic_tool_call") {
    return item.content_items;
  }
  if (typeof item.aggregated_output === "string") {
    return item.aggregated_output;
  }
  if (Array.isArray(item.changes)) {
    return item.changes;
  }
  return item;
}

function extractCliFailureMessage(event: Record<string, unknown>): string | undefined {
  const error = asRecord(event.error);
  if (error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return undefined;
}

function extractCliErrorMessage(event: Record<string, unknown>): string | undefined {
  if (typeof event.message === "string" && event.message.trim().length > 0) {
    return event.message;
  }
  return undefined;
}

function normalizeAppServerThread(value: unknown): RuntimeThreadMetadata | undefined {
  const thread = asRecord(value);
  if (!thread) {
    return undefined;
  }

  const id = firstString(thread.id);
  const title = firstString(thread.title);
  if (!id && !title) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
  };
}

function normalizeAppServerTurn(value: unknown): RuntimeTurnMetadata | undefined {
  const turn = asRecord(value);
  if (!turn) {
    return undefined;
  }

  const id = firstString(turn.id);
  const status = normalizeAppServerStatus(turn.status);
  if (!id && !status) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeAppServerItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  if (!item || typeof item.type !== "string") {
    return null;
  }

  const base = {
    id: item.id,
    status: normalizeAppServerStatus(item.status),
    parent_id: firstString(item.parentItemId, item.parentId, item.parent_item_id),
    title: item.title,
    phase: item.phase,
  };

  switch (item.type) {
    case "agentMessage":
      return {
        ...base,
        type: "agent_message",
        text: item.text,
      };
    case "commandExecution":
      return {
        ...base,
        type: "command_execution",
        command: item.command,
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
        process_id: item.processId,
        cwd: item.cwd,
      };
    case "fileChange":
      return {
        ...base,
        type: "file_change",
        changes: item.changes,
        diff: item.diff,
        path: item.path,
      };
    case "dynamicToolCall":
    case "dynamic_tool_call":
      return {
        ...base,
        type: "dynamic_tool_call",
        tool: item.tool,
        arguments: item.arguments,
        success: item.success,
        content_items: item.contentItems ?? item.content_items,
        duration_ms: item.durationMs ?? item.duration_ms,
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        text: item.text,
        summary: item.summary,
      };
    case "userMessage":
      return {
        ...base,
        type: "user_message",
        content: item.content,
      };
    default:
      return {
        ...item,
        ...base,
        type: item.type,
        status: normalizeAppServerStatus(item.status),
      };
  }
}

function normalizeAppServerStatus(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  if (value === "inProgress") {
    return "in_progress";
  }

  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function isCodexApprovalRequestMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "item/tool/requestUserInput"
  );
}

function buildRuntimeDynamicToolCallRequest(
  params: Record<string, unknown>,
  turn: AppServerApprovalTurn | null,
  currentThreadId: string | undefined,
): RuntimeDynamicToolCallRequest {
  const toolName = firstString(params.tool, params.toolName, params.name) ?? "unknown";
  const callId = firstString(params.callId, params.call_id, params.id);
  const threadId = firstString(params.threadId, params.thread_id, turn?.threadId, currentThreadId);
  const turnId = firstString(params.turnId, params.turn_id, turn?.turnId);
  const args = params.arguments ?? params.input ?? params.args ?? {};
  const item = buildDynamicToolCallItem({
    callId,
    toolName,
    args,
    status: "in_progress",
    parentId: turnId,
  });
  const metadata = buildCodexEventMetadata(
    {
      type: "item/tool/call",
      source: "codex.app-server",
      thread_id: threadId,
      turn_id: turnId,
      item,
    },
    { threadId, turnId },
  );

  return {
    toolName,
    ...(callId ? { callId } : {}),
    arguments: args,
    rawRequest: params,
    metadata,
  };
}

function buildDynamicToolTraceEvent(
  type: "item.started" | "item.completed",
  request: RuntimeDynamicToolCallRequest,
  result?: { success: boolean; contentItems: RuntimeDynamicToolCallContentItem[] },
): CodexCliEvent {
  const status = type === "item.started" ? "in_progress" : result?.success ? "completed" : "failed";
  return {
    type,
    source: "codex.app-server",
    ...(request.metadata?.thread?.id ? { thread_id: request.metadata.thread.id } : {}),
    ...(request.metadata?.turn?.id ? { turn_id: request.metadata.turn.id } : {}),
    item: buildDynamicToolCallItem({
      callId: request.callId,
      toolName: request.toolName,
      args: request.arguments,
      status,
      parentId: request.metadata?.turn?.id,
      result,
    }),
  };
}

function buildDynamicToolCallItem(input: {
  callId?: string;
  toolName: string;
  args: unknown;
  status: string;
  parentId?: string;
  result?: { success: boolean; contentItems: RuntimeDynamicToolCallContentItem[] };
}): Record<string, unknown> {
  return {
    id: input.callId ?? `${input.toolName}-unknown`,
    type: "dynamic_tool_call",
    status: input.status,
    parent_id: input.parentId,
    tool: input.toolName,
    arguments: input.args,
    ...(input.result
      ? {
          success: input.result.success,
          content_items: input.result.contentItems,
        }
      : {}),
  };
}

function buildCodexDynamicToolCallResponse(result: RuntimeDynamicToolCallResult): {
  success: boolean;
  contentItems: RuntimeDynamicToolCallContentItem[];
} {
  const success = result.success === true;
  const contentItems = normalizeDynamicToolCallContentItems(result.contentItems, result.reason);
  return { success, contentItems };
}

function normalizeDynamicToolCallContentItems(
  contentItems: RuntimeDynamicToolCallContentItem[] | undefined,
  fallbackText?: string,
): RuntimeDynamicToolCallContentItem[] {
  const normalized =
    contentItems?.filter((item): item is RuntimeDynamicToolCallContentItem => {
      if (item?.type === "inputText") {
        return typeof item.text === "string";
      }
      if (item?.type === "inputImage") {
        return typeof item.imageUrl === "string";
      }
      return false;
    }) ?? [];

  if (normalized.length > 0) {
    return normalized;
  }

  return [{ type: "inputText", text: fallbackText ?? "(no output)" }];
}

function buildRuntimeApprovalRequest(
  method: string,
  params: Record<string, unknown>,
  turn: AppServerApprovalTurn | null,
  currentThreadId: string | undefined,
): RuntimeApprovalRequest {
  const item = normalizeAppServerItem(params.item) ?? asRecord(params.item) ?? undefined;
  const metadataEvent = {
    type: method,
    source: "codex.app-server",
    thread_id: turn?.threadId ?? currentThreadId,
    turn_id: turn?.turnId,
    ...(item ? { item } : {}),
  };
  const metadata = buildCodexEventMetadata(metadataEvent, {
    threadId: turn?.threadId ?? currentThreadId,
    turnId: turn?.turnId,
  });

  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = extractApprovalCommand(params);
    return {
      kind: "command_execution",
      method,
      toolName: "Bash",
      input: {
        ...(command ? { command } : {}),
        ...(item ? { item } : {}),
      },
      rawRequest: params,
      metadata,
    };
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const input = extractFileChangeApprovalInput(params, item);
    return {
      kind: "file_change",
      method,
      toolName: inferFileChangeToolName(input),
      input,
      rawRequest: params,
      metadata,
    };
  }

  if (method === "item/tool/requestUserInput") {
    return {
      kind: "user_input",
      method,
      toolName: "AskUserQuestion",
      input: {
        questions: extractApprovalQuestions(params),
        ...(item ? { item } : {}),
      },
      rawRequest: params,
      metadata,
    };
  }

  return {
    kind: "permission",
    method,
    input: {
      permissions: extractRequestedPermissions(params),
      ...(item ? { item } : {}),
    },
    rawRequest: params,
    metadata,
  };
}

function buildApprovalTraceEvent(
  type: "approval.requested" | "approval.resolved",
  request: RuntimeApprovalRequest,
  result?: RuntimeApprovalResult,
): CodexCliEvent {
  const approval: RuntimeApprovalEvent = {
    kind: request.kind,
    ...(request.method ? { method: request.method } : {}),
    ...(request.toolName ? { toolName: request.toolName } : {}),
    ...(result ? { approved: result.approved } : {}),
    ...(typeof result?.inherited === "boolean" ? { inherited: result.inherited } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
  };

  return {
    type,
    source: "codex.app-server",
    ...(request.metadata?.thread?.id ? { thread_id: request.metadata.thread.id } : {}),
    ...(request.metadata?.turn?.id ? { turn_id: request.metadata.turn.id } : {}),
    ...(request.input?.item ? { item: request.input.item } : {}),
    approval,
  };
}

function extractRuntimeApprovalEvent(event: Record<string, unknown>): RuntimeApprovalEvent | null {
  const approval = asRecord(event.approval);
  const kind = firstString(approval?.kind);
  if (!approval || !isRuntimeApprovalKind(kind)) {
    return null;
  }

  return {
    kind,
    ...(firstString(approval.method) ? { method: firstString(approval.method) } : {}),
    ...(firstString(approval.toolName) ? { toolName: firstString(approval.toolName) } : {}),
    ...(typeof approval.approved === "boolean" ? { approved: approval.approved } : {}),
    ...(typeof approval.inherited === "boolean" ? { inherited: approval.inherited } : {}),
    ...(firstString(approval.reason) ? { reason: firstString(approval.reason) } : {}),
  };
}

function isRuntimeApprovalKind(value: unknown): value is RuntimeApprovalKind {
  return value === "command_execution" || value === "file_change" || value === "permission" || value === "user_input";
}

function buildCodexApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  result: RuntimeApprovalResult,
): Record<string, unknown> {
  if (method === "item/tool/requestUserInput") {
    return {
      answers: result.answers ?? {},
      ...(result.approved ? {} : { denied: true, reason: result.reason ?? "Denied by Ravi approval policy." }),
    };
  }

  if (method === "item/permissions/requestApproval") {
    if (result.approved) {
      return {
        permissions: result.permissions ?? extractRequestedPermissions(params) ?? {},
      };
    }
    return {
      permissions: {},
      denied: true,
      reason: result.reason ?? "Denied by Ravi approval policy.",
    };
  }

  if (result.approved) {
    return { decision: "acceptForSession" };
  }

  return {
    decision: "deny",
    reason: result.reason ?? "Denied by Ravi approval policy.",
  };
}

function extractApprovalCommand(params: Record<string, unknown>): string | undefined {
  const item = asRecord(params.item);
  const commandExecution = asRecord(params.commandExecution) ?? asRecord(params.command_execution);
  const toolInput = asRecord(params.toolInput) ?? asRecord(params.tool_input);
  return firstCommand(
    params.command,
    params.commandLine,
    params.command_line,
    commandExecution?.command,
    toolInput?.command,
    item?.command,
  );
}

function firstCommand(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      const joined = value.join(" ").trim();
      if (joined.length > 0) {
        return joined;
      }
    }
  }
  return undefined;
}

function extractFileChangeApprovalInput(
  params: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fileChange = asRecord(params.fileChange) ?? asRecord(params.file_change);
  const changes = firstArray(params.changes, fileChange?.changes, item?.changes);
  const path = firstString(params.path, fileChange?.path, item?.path);
  const diff = firstString(params.diff, fileChange?.diff, item?.diff);
  return {
    ...(changes ? { changes } : {}),
    ...(path ? { path } : {}),
    ...(diff ? { diff } : {}),
    ...(item ? { item } : {}),
  };
}

function inferFileChangeToolName(input: Record<string, unknown>): string {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const hasAdditiveChange = changes.some((change) => {
    const record = asRecord(change);
    const kind = firstString(record?.kind, record?.type, record?.operation);
    return kind === "add" || kind === "create" || kind === "write";
  });
  return hasAdditiveChange ? "Write" : "Edit";
}

function extractRequestedPermissions(params: Record<string, unknown>): unknown {
  return params.permissions ?? params.permission ?? params.requestedPermissions ?? params.requested_permissions;
}

function extractApprovalQuestions(params: Record<string, unknown>): RuntimeApprovalQuestion[] {
  const toolInput = asRecord(params.toolInput) ?? asRecord(params.tool_input);
  const questions = firstArray(params.questions, toolInput?.questions);
  if (!questions) {
    return [];
  }

  return questions.flatMap((question) => {
    const record = asRecord(question);
    if (!record) {
      return [];
    }

    const text = firstString(record.question, record.text, record.prompt, record.label, record.header);
    if (!text) {
      return [];
    }

    const options = firstArray(record.options, record.choices, record.values)
      ?.map((option) => {
        if (typeof option === "string") {
          return { label: option };
        }
        const optionRecord = asRecord(option);
        const label = firstString(optionRecord?.label, optionRecord?.value, optionRecord?.text, optionRecord?.name);
        if (!label) {
          return null;
        }
        return {
          label,
          ...(firstString(optionRecord?.description) ? { description: firstString(optionRecord?.description) } : {}),
        };
      })
      .filter((option): option is { label: string; description?: string } => !!option);

    return [
      {
        ...(firstString(record.id, record.name) ? { id: firstString(record.id, record.name) } : {}),
        ...(firstString(record.header) ? { header: firstString(record.header) } : {}),
        question: text,
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof record.multiSelect === "boolean"
          ? { multiSelect: record.multiSelect }
          : typeof record.selectableCount === "number"
            ? { multiSelect: record.selectableCount > 1 }
            : {}),
      },
    ];
  });
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function extractAppServerUsage(tokenUsage: unknown): CodexCliUsage | undefined {
  const record = asRecord(tokenUsage);
  const last = asRecord(record?.last);
  if (!last) {
    return undefined;
  }

  return {
    input_tokens: last.inputTokens,
    cached_input_tokens: last.cachedInputTokens,
    output_tokens: last.outputTokens,
  };
}

function extractAppServerTurnError(turn: Record<string, unknown> | null): string | undefined {
  const error = asRecord(turn?.error);
  if (error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return undefined;
}

function extractJsonRpcError(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record && typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message;
  }
  return undefined;
}

function extractAppServerErrorMessage(params: Record<string, unknown>): string | undefined {
  if (typeof params.message === "string" && params.message.trim().length > 0) {
    return params.message;
  }
  return extractJsonRpcError(params.error);
}

function ensureGlobalCodexBashHookConfig(): void {
  const hooksPath = getGlobalCodexHooksPath();
  mkdirSync(getGlobalCodexConfigDir(), { recursive: true });

  const nextConfig = upsertRaviCodexBashHook(readCodexHooksConfig(hooksPath));
  const nextJson = JSON.stringify(nextConfig, null, 2) + "\n";
  const currentJson = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;
  if (currentJson !== nextJson) {
    writeFileSync(hooksPath, nextJson, "utf8");
  }
}

function getGlobalCodexHooksPath(): string {
  return join(getGlobalCodexConfigDir(), "hooks.json");
}

function getGlobalCodexConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".codex");
}

function readCodexHooksConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return { hooks: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return asRecord(parsed) ?? { hooks: {} };
  } catch {
    return { hooks: {} };
  }
}

function upsertRaviCodexBashHook(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = asRecord(config.hooks) ?? {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const raviGroup = {
    matcher: RAVI_CODEX_BASH_HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: buildRaviCodexHookCommand(),
        statusMessage: RAVI_CODEX_BASH_HOOK_STATUS,
      },
    ],
  };

  const nextPreToolUse = preToolUse.filter((group) => !isRaviCodexHookGroup(group));
  nextPreToolUse.push(raviGroup);

  return {
    ...config,
    hooks: {
      ...hooks,
      PreToolUse: nextPreToolUse,
    },
  };
}

function isRaviCodexHookGroup(value: unknown): boolean {
  const group = asRecord(value);
  if (!group || group.matcher !== RAVI_CODEX_BASH_HOOK_MATCHER) {
    return false;
  }

  const handlers = Array.isArray(group.hooks) ? group.hooks : [];
  return handlers.some((handler) => {
    const entry = asRecord(handler);
    return entry?.statusMessage === RAVI_CODEX_BASH_HOOK_STATUS;
  });
}

function buildRaviCodexHookCommand(): string {
  const bundlePath = process.argv[1];
  if (bundlePath) {
    return [process.execPath, bundlePath, "context", "codex-bash-hook"].map(shellEscape).join(" ");
  }

  return ["ravi", "context", "codex-bash-hook"].map(shellEscape).join(" ");
}

function shellEscape(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const CODEX_APP_SERVER_OPTOUT_METHODS = [
  "codex/event/agent_message",
  "codex/event/agent_message_content_delta",
  "codex/event/agent_message_delta",
  "codex/event/agent_reasoning_delta",
  "codex/event/exec_command_begin",
  "codex/event/exec_command_end",
  "codex/event/exec_command_output_delta",
  "codex/event/item_completed",
  "codex/event/item_started",
  "codex/event/mcp_startup_complete",
  "codex/event/mcp_startup_update",
  "codex/event/reasoning_content_delta",
  "codex/event/reasoning_raw_content_delta",
  "codex/event/task_complete",
  "codex/event/task_started",
  "codex/event/token_count",
  "codex/event/user_message",
  "item/commandExecution/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  return /abort|terminated/i.test(error.message);
}

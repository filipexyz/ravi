import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { syncCodexSkills } from "../plugins/codex-skills.js";
import { ensureAgentInstructionFiles, loadAgentWorkspaceInstructions } from "./agent-instructions.js";
import type {
  RuntimeBillingType,
  RuntimeExecutionMetadata,
  RuntimeEvent,
  RuntimePlugin,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimePromptMessage,
  RuntimeSessionState,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  RuntimeStatus,
  RuntimeToolUse,
  RuntimeUsage,
  SessionRuntimeProvider,
} from "./types.js";

const DEFAULT_CODEX_MODEL = "gpt-5";
const INTERRUPT_GRACE_MS = 1_500;
const CODEX_APP_SERVER_SANDBOX = "danger-full-access";
const RAVI_CODEX_BASH_HOOK_STATUS = "ravi codex bash permission gate";
const RAVI_CODEX_BASH_HOOK_MATCHER = "^Bash$";
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
  prompt: string;
  resume?: string;
  systemPromptAppend: string;
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
}

interface CodexCliTransport {
  startTurn(input: CodexCliTurnRequest): CodexCliTurnHandle;
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
        supportsPlugins: false,
        supportsMcpServers: false,
        supportsRemoteSpawn: false,
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      ensureAgentInstructionFiles(input.cwd);
      ensureGlobalCodexBashHookConfig();
      const syncedSkills = syncSkills(input.plugins ?? []);
      syncedSkillsByCwd.set(input.cwd, Array.isArray(syncedSkills) ? syncedSkills : []);
      return {};
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
      };
    },
  };
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
        prompt: promptText,
        resume: previousSessionId,
        systemPromptAppend,
      });

      state.activeTurn = turn;

      const interruptOnAbort = () => {
        void turn.interrupt();
      };
      outerAbortSignal.addEventListener("abort", interruptOnAbort, { once: true });

      let turnEnded = false;
      let turnSessionId = previousSessionId;
      let lastErrorMessage: string | undefined;

      try {
        for await (const event of turn.events) {
          const rawEvent = event as Record<string, unknown>;
          if (event.type !== "agent_message.delta") {
            yield { type: "provider.raw", rawEvent };
          }

          const status = mapStatusFromCliEvent(event.type);
          if (status) {
            yield { type: "status", status, rawEvent };
          }

          if (event.type === "agent_message.delta") {
            const delta = firstString(event.delta);
            if (delta) {
              yield {
                type: "text.delta",
                text: delta,
              };
            }
            continue;
          }

          if (event.type === "thread.started") {
            const threadId = firstString(event.thread_id);
            if (threadId) {
              turnSessionId = threadId;
            }
            continue;
          }

          if (event.type === "item.started") {
            const toolStart = extractCliToolStarted(event.item);
            if (toolStart) {
              yield {
                type: "tool.started",
                toolUse: toolStart,
                rawEvent,
              };
            }
            continue;
          }

          if (event.type === "item.completed") {
            const assistantText = extractAssistantText(event.item);
            if (assistantText) {
              yield {
                type: "assistant.message",
                text: assistantText,
                rawEvent,
              };
            }

            const toolCompleted = extractCliToolCompleted(event.item);
            if (toolCompleted?.syntheticStart) {
              yield {
                type: "tool.started",
                toolUse: toolCompleted.syntheticStart,
                rawEvent,
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
              };
            }
            continue;
          }

          if (event.type === "error") {
            lastErrorMessage = extractCliErrorMessage(event) ?? lastErrorMessage;
            continue;
          }

          if (event.type === "turn.interrupted") {
            yield { type: "turn.interrupted", rawEvent };
            turnEnded = true;
            break;
          }

          if (event.type === "turn.failed") {
            yield {
              type: "turn.failed",
              error: extractCliFailureMessage(event) ?? lastErrorMessage ?? "Codex turn failed",
              recoverable: true,
              rawEvent,
            };
            turnEnded = true;
            break;
          }

          if (event.type === "turn.completed") {
            previousSessionId = turnSessionId;
            yield {
              type: "turn.complete",
              providerSessionId: turnSessionId,
              session: buildCodexSessionState(turnSessionId, input.cwd),
              execution: buildCodexExecutionMetadata(
                input,
                defaultModel,
                firstString(event.model),
                firstString(event.model_provider),
              ),
              usage: mapCliUsage(event.usage),
              rawEvent,
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
          yield { type: "status", status: "idle" };
          yield { type: "turn.interrupted" };
          continue;
        }

        const stderrMessage = result.stderr.trim();
        yield {
          type: "turn.failed",
          error:
            lastErrorMessage ??
            (stderrMessage || `Codex CLI exited without a terminal event (code ${result.exitCode ?? "unknown"})`),
          recoverable: true,
        };
      } catch (error) {
        if (outerAbortSignal.aborted && !state.interrupted) {
          break;
        }

        if (state.interrupted || isAbortLikeError(error)) {
          state.interrupted = false;
          yield { type: "status", status: "idle" };
          yield { type: "turn.interrupted" };
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

  async function handleServerRequest(id: string, method: string, _params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
        await writeJsonRpc({ id, result: { decision: "acceptForSession" } });
        return;
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
        await writeJsonRpc({ id, result: { decision: "acceptForSession" } });
        return;
      case "item/permissions/requestApproval":
        await writeJsonRpc({ id, result: { permissions: {} } });
        return;
      case "item/tool/requestUserInput":
        await writeJsonRpc({ id, result: { answers: {} } });
        return;
      case "item/tool/call":
        await writeJsonRpc({
          id,
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "Dynamic tools are unsupported in the Ravi Codex adapter." }],
          },
        });
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
        const threadId = firstString(asRecord(params.thread)?.id);
        if (threadId) {
          currentThreadId = threadId;
          if (turn) {
            turn.threadId = threadId;
            turn.queue.push({ type: "thread.started", thread_id: threadId });
            if (turn.interruptRequested && turn.turnId) {
              void requestTurnInterrupt(turn);
            }
          }
        }
        break;
      }
      case "turn/started": {
        if (turn) {
          const startedTurn = asRecord(params.turn);
          turn.threadId = firstString(params.threadId, turn.threadId, currentThreadId);
          turn.turnId = firstString(startedTurn?.id, turn.turnId);
          turn.queue.push({ type: "turn.started" });
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
            turn.queue.push({ type: "item.started", item });
          }
        }
        break;
      }
      case "item/completed": {
        if (turn) {
          const item = normalizeAppServerItem(params.item);
          if (item) {
            turn.queue.push({ type: "item.completed", item });
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
            usage: turn.lastUsage ?? {},
            model: resolvedModel,
            model_provider: resolvedModelProvider,
          });
        } else if (status === "interrupted") {
          turn.queue.push({ type: "turn.interrupted" });
        } else {
          turn.queue.push({
            type: "turn.failed",
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
              config: null,
              baseInstructions: null,
              developerInstructions: input.systemPromptAppend || null,
              personality: null,
              persistExtendedHistory: false,
            })
          : await sendRequest("thread/start", {
              model: input.model ?? null,
              modelProvider: null,
              cwd: input.cwd,
              approvalPolicy: "never",
              sandbox: CODEX_APP_SERVER_SANDBOX,
              config: null,
              serviceName: null,
              baseInstructions: null,
              developerInstructions: input.systemPromptAppend || null,
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
            effort: null,
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
      };
    },
    close,
  };
}

function _createCodexCliTransport(options: { command?: string } = {}): CodexCliTransport {
  const command = options.command ?? "codex";

  return {
    startTurn(input) {
      const args = buildExecArgs(input.resume, input.model);
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

function buildExecArgs(resume: string | undefined, model?: string): string[] {
  const args = resume ? ["exec", "resume"] : ["exec"];

  args.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");

  if (model) {
    args.push("--model", model);
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
  const workspaceInstructions = await loadWorkspaceInstructions(cwd);
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

  const runtimeInstructions = runtimeSystemPromptAppend.trim();
  if (runtimeInstructions) {
    sections.push(runtimeInstructions);
  }

  return sections.join("\n\n");
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

  const toolName = normalizeCliToolName(record.type);
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
  const toolName = normalizeCliToolName(record.type);
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
  if (typeof item.command === "string") {
    return { command: item.command };
  }
  if (Array.isArray(item.changes)) {
    return { changes: item.changes };
  }
  return undefined;
}

function extractCliToolOutput(item: Record<string, unknown>): unknown {
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

function normalizeAppServerItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  if (!item || typeof item.type !== "string") {
    return null;
  }

  switch (item.type) {
    case "agentMessage":
      return {
        type: "agent_message",
        id: item.id,
        text: item.text,
        status: normalizeAppServerStatus(item.status),
        phase: item.phase,
      };
    case "commandExecution":
      return {
        type: "command_execution",
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
        status: normalizeAppServerStatus(item.status),
        process_id: item.processId,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        status: normalizeAppServerStatus(item.status),
      };
    case "userMessage":
      return {
        type: "user_message",
        id: item.id,
        content: item.content,
      };
    default:
      return {
        ...item,
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

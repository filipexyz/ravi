import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { RuntimeEffort } from "./effort.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";
import type {
  RuntimeApprovalHandler,
  RuntimeApprovalQuestion,
  RuntimeApprovalRequest,
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeControlState,
  RuntimeEvent,
  RuntimeEventMetadata,
  RuntimeHostServices,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimePromptMessage,
  RuntimeSessionHandle,
  RuntimeSessionState,
  RuntimeStartRequest,
  RuntimeToolPermissionHandler,
  RuntimeToolUse,
  RuntimeUsage,
  SessionRuntimeProvider,
} from "./types.js";

const DEFAULT_GROK_COMMAND = "grok";
const DEFAULT_GROK_RPC_TIMEOUT_MS = 30_000;
const GROK_INTERRUPT_GRACE_MS = 1_000;
const GROK_RUNTIME_CONTROL_OPERATIONS: RuntimeControlOperation[] = ["turn.interrupt"];
const GROK_ACP_PROTOCOL_VERSION = 1;
const GROK_ACP_CLIENT_NAME = "ravi";
const GROK_ACP_CLIENT_TITLE = "Ravi Runtime";
const GROK_ACP_CLIENT_VERSION_FALLBACK = "ravi";

export interface GrokAcpInitializeParams extends Record<string, unknown> {
  protocolVersion: number;
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  clientCapabilities: {
    fs: {
      readTextFile: boolean;
      writeTextFile: boolean;
    };
    terminal: boolean;
  };
}

export type GrokEffort = "none" | "minimal" | "low" | "medium" | "high";

export const GROK_HOSTED_TOOLS = ["Bash", "Edit", "Read", "Grep", "WebFetch", "WebSearch", "MCPTool"] as const;

export type GrokHostedTool = (typeof GROK_HOSTED_TOOLS)[number];

const GROK_TOOL_ALIASES: Record<GrokHostedTool, readonly string[]> = {
  Bash: ["Shell", "Terminal"],
  Edit: ["Write"],
  Read: ["ReadFile", "ListDir"],
  Grep: ["Glob"],
  WebFetch: ["WebFetch"],
  WebSearch: ["WebSearch"],
  MCPTool: ["MCPTool"],
};

export interface GrokAcpStartInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: RuntimeEffort;
  systemPromptAppend?: string;
  allowTools?: string[];
  denyTools?: string[];
}

export interface GrokToolAccessRules {
  allow: string[];
  deny: string[];
}

export type GrokPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface GrokPermissionAuthorizationHandlers {
  canUseTool?: RuntimeToolPermissionHandler;
  approveRuntimeRequest?: RuntimeApprovalHandler;
  interrupted?: boolean;
}

export interface GrokJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface GrokJsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface GrokAcpNotification extends Record<string, unknown> {
  method: string;
  params?: Record<string, unknown>;
}

export interface GrokAcpTransport {
  events: AsyncIterable<GrokAcpNotification>;
  start(input: GrokAcpStartInput): Promise<void> | void;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface GrokSessionRuntimeState {
  activeTurn: boolean;
  interrupted: boolean;
  sessionId?: string;
  transport?: GrokAcpTransport;
  loadSessionSupported: boolean;
}

interface CreateGrokAcpSubprocessTransportOptions {
  command?: string;
  commandArgs?: string[];
  responseTimeoutMs?: number;
  promptTimeoutMs?: number;
  authorizePermission?: (
    params: Record<string, unknown>,
    context: { interrupted: boolean },
  ) => Promise<GrokPermissionOutcome>;
}

export interface CreateGrokRuntimeProviderOptions extends CreateGrokAcpSubprocessTransportOptions {
  transport?: GrokAcpTransport;
}

export interface GrokRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

interface GrokEventContext {
  cwd: string;
  model?: string;
  promptMessage: RuntimePromptMessage;
  turnIndex: number;
  sessionId?: string;
  assistantText: string;
  usage: RuntimeUsage;
}

export function createGrokRuntimeProvider(options: CreateGrokRuntimeProviderOptions = {}): GrokRuntimeProvider {
  return {
    id: "grok",
    getCapabilities() {
      return {
        runtimeControl: {
          supported: true,
          operations: GROK_RUNTIME_CONTROL_OPERATIONS,
        },
        dynamicTools: {
          mode: "none",
        },
        execution: {
          mode: "subprocess-rpc",
        },
        sessionState: {
          mode: "provider-session-id",
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
          availability: "none",
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
      return input.hostServices ? { startRequest: createGrokRuntimeStartRequest(input.hostServices) } : {};
    },
    startSession(input) {
      const state: GrokSessionRuntimeState = {
        activeTurn: false,
        interrupted: false,
        loadSessionSupported: false,
      };
      const transport =
        options.transport ??
        createGrokAcpSubprocessTransport({
          command: options.command,
          commandArgs: options.commandArgs,
          responseTimeoutMs: options.responseTimeoutMs,
          promptTimeoutMs: options.promptTimeoutMs,
          authorizePermission: (params, context) =>
            authorizeGrokAcpPermission(params, {
              canUseTool: input.canUseTool,
              approveRuntimeRequest: input.approveRuntimeRequest,
              interrupted: context.interrupted || state.interrupted,
            }),
        });
      state.transport = transport;

      return {
        provider: "grok",
        events: runGrokTurns(input, transport, state),
        interrupt: async () => {
          state.interrupted = true;
          if (state.sessionId) {
            await safeGrokNotify(transport, "session/cancel", { sessionId: state.sessionId });
          }
        },
        close: async () => {
          const current = state.transport;
          state.transport = undefined;
          await current?.close();
        },
        control: (request) => controlGrokRuntime(state, request),
      };
    },
  };
}

export function createGrokAcpSubprocessTransport(
  options: CreateGrokAcpSubprocessTransportOptions = {},
): GrokAcpTransport {
  const command = options.command ?? process.env.RAVI_GROK_COMMAND ?? DEFAULT_GROK_COMMAND;
  const commandArgs = options.commandArgs ?? [];
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_GROK_RPC_TIMEOUT_MS;
  const promptTimeoutMs = options.promptTimeoutMs ?? 0;
  const queue = createAsyncQueue<GrokAcpNotification>();
  const pending = new Map<number, PendingRequest>();

  let child: ChildProcessWithoutNullStreams | null = null;
  let nextRequestId = 1;
  let stderr = "";
  let stopStdoutReader: (() => void) | null = null;
  let closed = true;
  let intentionalClose = false;
  let closeFailure: Error | null = null;
  let interrupted = false;

  const failPending = (error: unknown) => {
    for (const request of pending.values()) {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      request.reject(error);
    }
    pending.clear();
  };

  const writeMessage = (message: object): Promise<void> => {
    if (!child || closed) {
      return Promise.reject(closeFailure ?? new Error("Grok ACP transport is not connected"));
    }
    return new Promise((resolve, reject) => {
      child!.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const handleIncomingRequest = (message: Record<string, unknown>) => {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") {
      return;
    }
    const method = firstString(message.method);
    const params = isRecord(message.params) ? message.params : {};
    if (method !== "session/request_permission") {
      void writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method ?? "unknown"}` },
      }).catch(() => {});
      return;
    }
    void (async () => {
      const outcome = options.authorizePermission
        ? await options.authorizePermission(params, { interrupted })
        : await authorizeGrokAcpPermission(params, { interrupted });
      await writeMessage({
        jsonrpc: "2.0",
        id,
        result: { outcome },
      });
    })().catch(() => {});
  };

  const handleLine = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const failure = new Error(
        `Invalid Grok ACP JSONL event: ${error instanceof Error ? error.message : String(error)}`,
      );
      queue.fail(failure);
      failPending(failure);
      return;
    }

    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
      return;
    }

    if (parsed.id !== undefined && pending.has(Number(parsed.id))) {
      const request = pending.get(Number(parsed.id))!;
      pending.delete(Number(parsed.id));
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      if (isRecord(parsed.error)) {
        request.reject(new Error(firstString(parsed.error.message) ?? "Grok ACP request failed"));
        return;
      }
      request.resolve(parsed.result);
      return;
    }

    if (typeof parsed.method === "string" && parsed.id !== undefined) {
      handleIncomingRequest(parsed);
      return;
    }

    if (typeof parsed.method === "string") {
      queue.push({
        method: parsed.method,
        ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
      });
    }
  };

  return {
    events: queue,
    async start(input) {
      if (child) {
        throw new Error("Grok ACP transport is already started");
      }

      const args = [...commandArgs, ...buildGrokAcpProcessArgs(input)];
      stderr = "";
      closeFailure = null;
      closed = false;
      intentionalClose = false;
      interrupted = false;
      child = spawn(command, args, {
        cwd: input.cwd,
        env: buildGrokAcpSpawnEnv(input),
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
          failPending(new Error("Grok ACP process closed"));
          return;
        }
        const suffix = stderr.trim() ? ` Stderr: ${stderr.trim()}` : "";
        const failure =
          code === 0 && signal === null
            ? null
            : new Error(`Grok ACP process exited with code ${code ?? "unknown"} signal ${signal ?? "none"}.${suffix}`);
        if (failure) {
          closeFailure = failure;
          queue.fail(failure);
          failPending(failure);
        } else {
          closeFailure = new Error("Grok ACP process closed");
          queue.end();
          failPending(closeFailure);
        }
      });
    },
    request(method, params) {
      if (!child || closed) {
        return Promise.reject(closeFailure ?? new Error("Grok ACP transport is not connected"));
      }

      const id = nextRequestId++;
      const timeoutMs = method === "session/prompt" ? promptTimeoutMs : responseTimeoutMs;
      const message: GrokJsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      };

      return new Promise<unknown>((resolve, reject) => {
        const timeout =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Timeout waiting for Grok ACP response to ${method}`));
              }, timeoutMs)
            : undefined;
        pending.set(id, { resolve, reject, timeout });
        void writeMessage(message).catch((error) => {
          pending.delete(id);
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(error);
        });
      });
    },
    async notify(method, params) {
      if (method === "session/cancel") {
        interrupted = true;
      }
      await writeMessage({
        jsonrpc: "2.0",
        method,
        ...(params ? { params } : {}),
      });
    },
    async close() {
      stopStdoutReader?.();
      stopStdoutReader = null;
      const currentChild = child;
      child = null;
      if (!currentChild || closed) {
        queue.end();
        failPending(new Error("Grok ACP transport closed"));
        return;
      }

      closed = true;
      intentionalClose = true;
      currentChild.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          currentChild.kill("SIGKILL");
          resolve();
        }, GROK_INTERRUPT_GRACE_MS);
        currentChild.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      queue.end();
      failPending(new Error("Grok ACP transport closed"));
    },
  };
}

export function resolveGrokAcpClientVersion(): string {
  return (
    firstString(process.env.npm_package_version, process.env.RAVI_VERSION, readNearbyRaviPackageVersion()) ??
    GROK_ACP_CLIENT_VERSION_FALLBACK
  );
}

export function buildGrokAcpInitializeParams(): GrokAcpInitializeParams {
  return {
    protocolVersion: GROK_ACP_PROTOCOL_VERSION,
    clientInfo: {
      name: GROK_ACP_CLIENT_NAME,
      title: GROK_ACP_CLIENT_TITLE,
      version: resolveGrokAcpClientVersion(),
    },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  };
}

function readNearbyRaviPackageVersion(): string | undefined {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function buildGrokAcpProcessArgs(
  input: Pick<GrokAcpStartInput, "model" | "effort" | "systemPromptAppend" | "allowTools" | "denyTools">,
): string[] {
  const args = ["--no-auto-update", "--no-alt-screen", "--permission-mode", "default"];
  for (const tool of input.allowTools ?? []) {
    args.push("--allow", tool);
  }
  for (const tool of input.denyTools ?? []) {
    args.push("--deny", tool);
  }
  if ((input.allowTools?.length ?? 0) > 0) {
    args.push("--tools", input.allowTools!.join(","));
  } else if ((input.denyTools?.length ?? 0) > 0) {
    args.push("--disallowed-tools", input.denyTools!.join(","));
  }
  const model = input.model?.trim();
  if (model && model !== "default") {
    args.push("-m", model);
  }
  const effort = toGrokEffort(input.effort);
  if (effort) {
    args.push("--effort", effort);
  }
  const systemPromptAppend = input.systemPromptAppend?.trim();
  if (systemPromptAppend) {
    args.push("--append-system-prompt", systemPromptAppend);
  }
  args.push("agent", "stdio");
  return args;
}

export function buildGrokAcpSpawnEnv(input: Pick<GrokAcpStartInput, "env">): NodeJS.ProcessEnv {
  return { ...input.env };
}

export function toGrokEffort(value?: RuntimeEffort): GrokEffort | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "xhigh" || value === "max" || value === "ultra") {
    return "high";
  }
  return value;
}

export function selectGrokAuthMethod(authMethods: unknown[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ids = authMethods
    .map((method) => (isRecord(method) ? firstString(method.id) : undefined))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    return undefined;
  }
  if (env.XAI_API_KEY?.trim() && ids.includes("xai.api_key")) {
    return "xai.api_key";
  }
  if (ids.includes("cached_token")) {
    return "cached_token";
  }
  if (ids.includes("xai.api_key")) {
    return "xai.api_key";
  }
  return ids[0];
}

export function selectGrokPermissionOutcome(
  options: unknown,
  preference: "allow" | "reject" = "reject",
): GrokPermissionOutcome {
  const list = Array.isArray(options) ? options : [];
  const match = list.find((option) => {
    if (!isRecord(option)) {
      return false;
    }
    const kind = firstString(option.kind)?.toLowerCase() ?? "";
    const optionId = firstString(option.optionId, option.id)?.toLowerCase() ?? "";
    return preference === "allow"
      ? kind.includes("allow") || optionId.includes("allow")
      : kind.includes("reject") || kind.includes("deny") || optionId.includes("reject") || optionId.includes("deny");
  });
  const optionId = isRecord(match) ? firstString(match.optionId, match.id) : undefined;
  if (!optionId) {
    return { outcome: "cancelled" };
  }
  return { outcome: "selected", optionId };
}

export async function resolveGrokToolAccessRules(
  canUseTool?: RuntimeToolPermissionHandler,
): Promise<GrokToolAccessRules> {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const tool of GROK_HOSTED_TOOLS) {
    if (await isGrokHostedToolAllowed(tool, canUseTool)) {
      allow.push(tool);
    } else {
      deny.push(tool);
    }
  }
  return { allow, deny };
}

export function mapGrokToolNameToRavi(name?: string): string {
  const normalized =
    name
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "") ?? "";
  if (!normalized) {
    return "tool";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized === "execute" ||
    normalized === "terminal"
  ) {
    return "Bash";
  }
  if (normalized.includes("webfetch") || normalized.includes("webget")) {
    return "WebFetch";
  }
  if (normalized.includes("websearch") || normalized.includes("webquery")) {
    return "WebSearch";
  }
  if (normalized.includes("mcp")) {
    return "MCPTool";
  }
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("searchcontent")) {
    return "Grep";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("searchreplace") ||
    normalized.includes("strreplace")
  ) {
    return "Edit";
  }
  if (normalized.includes("read") || normalized.includes("listdir") || normalized.includes("list_dir")) {
    return "Read";
  }
  return name?.trim() || "tool";
}

export function extractGrokPermissionTool(params: Record<string, unknown>): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : isRecord(params.tool_call) ? params.tool_call : params;
  const rawName = firstString(toolCall.toolName, toolCall.tool_name, toolCall.name, toolCall.kind, toolCall.title);
  const rawInput = toolCall.rawInput ?? toolCall.raw_input ?? toolCall.input ?? toolCall.arguments ?? params.rawInput;
  return {
    toolName: mapGrokToolNameToRavi(rawName),
    input: isRecord(rawInput) ? rawInput : {},
  };
}

export async function authorizeGrokAcpPermission(
  params: Record<string, unknown>,
  handlers: GrokPermissionAuthorizationHandlers = {},
): Promise<GrokPermissionOutcome> {
  if (handlers.interrupted) {
    return { outcome: "cancelled" };
  }

  const { toolName, input } = extractGrokPermissionTool(params);
  const approved = await decideGrokToolAuthorization(toolName, input, params, handlers);
  return selectGrokPermissionOutcome(params.options, approved ? "allow" : "reject");
}

async function* runGrokTurns(
  input: RuntimeStartRequest,
  transport: GrokAcpTransport,
  state: GrokSessionRuntimeState,
): AsyncGenerator<RuntimeEvent> {
  const abortSignal = input.abortController.signal;
  const toolAccess = await resolveGrokToolAccessRules(input.canUseTool);
  const startInput: GrokAcpStartInput = {
    cwd: input.cwd,
    env: input.env ?? process.env,
    model: input.model,
    effort: input.effort,
    systemPromptAppend: input.systemPromptAppend,
    allowTools: toolAccess.allow,
    denyTools: toolAccess.deny,
  };
  const eventIterator = transport.events[Symbol.asyncIterator]();

  try {
    await transport.start(startInput);
    await initializeGrokSession(transport, input, state);

    if (state.sessionId) {
      yield {
        type: "thread.started",
        thread: { id: state.sessionId },
        metadata: buildGrokEventMetadata({ method: "session/new" }, { sessionId: state.sessionId }),
      };
    }

    let turnIndex = 0;
    for await (const promptMessage of input.prompt) {
      if (abortSignal.aborted || state.interrupted) {
        break;
      }

      const prompt = extractPromptText(promptMessage);
      if (!prompt) {
        continue;
      }
      if (!state.sessionId) {
        throw new Error("Grok ACP session is not initialized");
      }

      const terminalTracker = createRuntimeTerminalEventTracker();
      turnIndex += 1;
      const context: GrokEventContext = {
        cwd: input.cwd,
        model: input.model,
        promptMessage,
        turnIndex,
        sessionId: state.sessionId,
        assistantText: "",
        usage: emptyUsage(),
      };

      state.activeTurn = true;
      const abortListener = () => {
        state.interrupted = true;
        void safeGrokNotify(transport, "session/cancel", { sessionId: state.sessionId });
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });

      const turn = { id: `grok-turn-${turnIndex}`, status: "running" };
      yield {
        type: "turn.started",
        turn,
        metadata: buildGrokEventMetadata({ method: "session/prompt" }, context),
      };

      try {
        const promptPromise = transport.request("session/prompt", {
          sessionId: state.sessionId,
          prompt: [{ type: "text", text: prompt }],
        });

        for await (const notification of consumeUntilSettled(eventIterator, promptPromise)) {
          for (const runtimeEvent of normalizeGrokNotification(notification, context)) {
            if (!terminalTracker.accept(runtimeEvent)) {
              continue;
            }
            yield runtimeEvent;
          }
        }

        const result = await promptPromise;
        const stopReason = firstString(isRecord(result) ? result.stopReason : undefined) ?? "end_turn";
        const metadata = buildGrokEventMetadata(
          { method: "session/prompt", stopReason, ...(isRecord(result) ? result : {}) },
          context,
        );

        if (state.interrupted || abortSignal.aborted || stopReason === "cancelled") {
          const terminal = terminalTracker.interrupt({
            rawEvent: isRecord(result) ? result : { stopReason },
            metadata,
          });
          if (terminal) {
            yield terminal;
          }
          continue;
        }

        if (stopReason === "refusal" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
          const terminal = terminalTracker.fail({
            error: `Grok turn stopped: ${stopReason}`,
            recoverable: stopReason !== "refusal",
            rawEvent: isRecord(result) ? result : { stopReason },
            metadata,
          });
          if (terminal) {
            yield terminal;
          }
          continue;
        }

        if (context.assistantText) {
          const message: RuntimeEvent = {
            type: "assistant.message",
            text: context.assistantText,
            rawEvent: isRecord(result) ? result : { stopReason },
            metadata,
          };
          if (terminalTracker.accept(message)) {
            yield message;
          }
        }

        const session = buildGrokRuntimeSessionState(state.sessionId, context);
        const terminal: RuntimeEvent = {
          type: "turn.complete",
          providerSessionId: state.sessionId,
          session,
          execution: {
            provider: "grok",
            model: context.model ?? null,
            billingType: "unknown",
          },
          usage: context.usage,
          rawEvent: isRecord(result) ? result : { stopReason },
          metadata,
        };
        if (terminalTracker.accept(terminal)) {
          yield terminal;
        }
      } catch (error) {
        if (abortSignal.aborted || state.interrupted) {
          const terminal = terminalTracker.interrupt({
            rawEvent: { type: "stream.error", reason: "interrupt" },
            metadata: buildGrokEventMetadata({ method: "session/cancel" }, context),
          });
          if (terminal) {
            yield { type: "status", status: "idle", metadata: terminal.metadata };
            yield terminal;
          }
          continue;
        }

        const terminal = terminalTracker.fail({
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
          rawEvent: { type: "stream.error" },
          metadata: buildGrokEventMetadata({ method: "session/prompt" }, context),
        });
        if (terminal) {
          yield terminal;
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

async function initializeGrokSession(
  transport: GrokAcpTransport,
  input: RuntimeStartRequest,
  state: GrokSessionRuntimeState,
): Promise<void> {
  const init = await transport.request("initialize", buildGrokAcpInitializeParams());
  const initRecord = isRecord(init) ? init : {};
  const agentCapabilities = isRecord(initRecord.agentCapabilities) ? initRecord.agentCapabilities : {};
  state.loadSessionSupported = agentCapabilities.loadSession === true;

  const authMethods = Array.isArray(initRecord.authMethods) ? initRecord.authMethods : [];
  const methodId = selectGrokAuthMethod(authMethods, input.env ?? process.env);
  if (methodId) {
    await transport.request("authenticate", {
      methodId,
      _meta: { headless: true },
    });
  } else if (authMethods.length > 0) {
    throw new Error("Run `grok login` first, or set XAI_API_KEY.");
  }

  const resumeSessionId = readGrokResumeSessionId(input);
  if (resumeSessionId && !input.forkSession) {
    if (!state.loadSessionSupported) {
      throw new Error("Grok ACP agent does not advertise session/load; cannot resume");
    }
    await transport.request("session/load", {
      sessionId: resumeSessionId,
      cwd: input.cwd,
      mcpServers: [],
    });
    state.sessionId = resumeSessionId;
    return;
  }

  const created = await transport.request("session/new", {
    cwd: input.cwd,
    mcpServers: [],
  });
  const sessionId = firstString(isRecord(created) ? created.sessionId : undefined);
  if (!sessionId) {
    throw new Error("Grok ACP session/new did not return a sessionId");
  }
  state.sessionId = sessionId;
}

function readGrokResumeSessionId(input: RuntimeStartRequest): string | undefined {
  return firstString(input.resumeSession?.params?.sessionId, input.resume);
}

function normalizeGrokNotification(notification: GrokAcpNotification, context: GrokEventContext): RuntimeEvent[] {
  const rawEvent = notification as Record<string, unknown>;
  const metadata = buildGrokEventMetadata(rawEvent, context);
  const events: RuntimeEvent[] = [{ type: "provider.raw", rawEvent, metadata }];
  if (notification.method !== "session/update") {
    return events;
  }

  const params = isRecord(notification.params) ? notification.params : {};
  const update = isRecord(params.update) ? params.update : params;
  const sessionUpdate = firstString(update.sessionUpdate, update.type);
  const sessionId = firstString(params.sessionId);
  if (sessionId) {
    context.sessionId = sessionId;
  }

  switch (sessionUpdate) {
    case "agent_message_chunk": {
      const text = extractGrokContentText(update.content);
      if (text) {
        context.assistantText += text;
        events.push({ type: "text.delta", text, metadata });
      }
      break;
    }
    case "agent_thought_chunk":
      events.push({ type: "status", status: "thinking", rawEvent, metadata });
      break;
    case "tool_call": {
      const toolUse = buildGrokToolUse(update);
      if (toolUse) {
        events.push({ type: "tool.started", toolUse, rawEvent, metadata });
      }
      break;
    }
    case "tool_call_update": {
      const status = firstString(update.status);
      if (status === "completed" || status === "failed") {
        events.push({
          type: "tool.completed",
          toolUseId: firstString(update.toolCallId, update.toolCallID),
          toolName: firstString(update.title, update.kind),
          content: update.content,
          isError: status === "failed",
          rawEvent,
          metadata,
        });
      }
      break;
    }
    case "plan":
      events.push({ type: "status", status: "thinking", rawEvent, metadata });
      break;
    case "usage_update":
      context.usage = mapGrokUsage(update, context.usage);
      break;
    default:
      break;
  }

  return events;
}

function buildGrokToolUse(update: Record<string, unknown>): RuntimeToolUse | null {
  const id = firstString(update.toolCallId, update.toolCallID);
  const name = mapGrokToolNameToRavi(firstString(update.toolName, update.kind, update.title));
  if (!id) {
    return null;
  }
  return {
    id,
    name,
    input: update.rawInput ?? update.input ?? update.arguments,
  };
}

function createGrokRuntimeStartRequest(
  hostServices: RuntimeHostServices,
): NonNullable<RuntimePrepareSessionResult["startRequest"]> {
  return {
    approveRuntimeRequest: async (request) => authorizeGrokHostApproval(hostServices, request),
  };
}

async function authorizeGrokHostApproval(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<Awaited<ReturnType<RuntimeApprovalHandler>>> {
  switch (request.kind) {
    case "command_execution": {
      const command = typeof request.input?.command === "string" ? request.input.command : "";
      if (!command.trim()) {
        return { approved: false, reason: "Grok command approval request did not include a command." };
      }
      return hostServices.authorizeCommandExecution({
        command,
        input: request.input,
        eventData: buildGrokApprovalEventData(request),
      });
    }
    case "file_change":
    case "permission":
      return hostServices.authorizeToolUse({
        toolName: request.toolName ?? (request.kind === "file_change" ? "Edit" : "tool"),
        input: request.input,
        eventData: buildGrokApprovalEventData(request),
      });
    case "user_input":
      return hostServices.requestUserInput({
        questions: Array.isArray(request.input?.questions)
          ? (request.input.questions as RuntimeApprovalQuestion[])
          : [],
        eventData: buildGrokApprovalEventData(request),
      });
  }
}

function buildGrokApprovalEventData(request: RuntimeApprovalRequest): Record<string, unknown> {
  return {
    runtimeApproval: {
      provider: "grok",
      kind: request.kind,
      method: request.method,
      toolName: request.toolName,
      input: request.input,
    },
  };
}

async function isGrokHostedToolAllowed(
  tool: GrokHostedTool,
  canUseTool?: RuntimeToolPermissionHandler,
): Promise<boolean> {
  if (!canUseTool) {
    return false;
  }
  const names = [tool, ...(GROK_TOOL_ALIASES[tool] ?? [])];
  for (const name of names) {
    const result = await canUseTool(name, {});
    if (result.behavior === "allow") {
      return true;
    }
  }
  return false;
}

async function decideGrokToolAuthorization(
  toolName: string,
  input: Record<string, unknown>,
  rawRequest: Record<string, unknown>,
  handlers: GrokPermissionAuthorizationHandlers,
): Promise<boolean> {
  const command = firstString(input.command, input.cmd);
  if (command && handlers.approveRuntimeRequest) {
    const result = await handlers.approveRuntimeRequest({
      kind: "command_execution",
      method: "session/request_permission",
      toolName: "Bash",
      input: { ...input, command },
      rawRequest,
    });
    return result.approved;
  }

  if (handlers.canUseTool) {
    const names = uniqueStrings([toolName, ...aliasesForGrokTool(toolName)]);
    for (const name of names) {
      const result = await handlers.canUseTool(name, input);
      if (result.behavior === "allow") {
        return true;
      }
    }
    return false;
  }

  if (handlers.approveRuntimeRequest) {
    const kind = toolName === "Edit" || toolName === "Write" ? "file_change" : "permission";
    const result = await handlers.approveRuntimeRequest({
      kind,
      method: "session/request_permission",
      toolName,
      input,
      rawRequest,
    });
    return result.approved;
  }

  return false;
}

function aliasesForGrokTool(toolName: string): string[] {
  const canonical = mapGrokToolNameToRavi(toolName);
  if (isGrokHostedTool(canonical)) {
    return [...GROK_TOOL_ALIASES[canonical]];
  }
  return [];
}

function isGrokHostedTool(value: string): value is GrokHostedTool {
  return (GROK_HOSTED_TOOLS as readonly string[]).includes(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function mapGrokUsage(update: Record<string, unknown>, fallback: RuntimeUsage): RuntimeUsage {
  const used = numberOrZero(update.used);
  if (used === 0 && fallback.inputTokens === 0 && fallback.outputTokens === 0) {
    return fallback;
  }
  return {
    inputTokens: used || fallback.inputTokens,
    outputTokens: fallback.outputTokens,
  };
}

function extractGrokContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (isRecord(content) && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function buildGrokRuntimeSessionState(sessionId: string | undefined, context: GrokEventContext): RuntimeSessionState {
  return {
    params: {
      integration: "acp",
      cwd: context.cwd,
      ...(sessionId ? { sessionId } : {}),
      ...(context.model ? { model: context.model } : {}),
    },
    displayId: sessionId ?? null,
  };
}

function buildGrokEventMetadata(
  rawEvent: Record<string, unknown>,
  context: Pick<GrokEventContext, "sessionId"> & { turnIndex?: number },
): RuntimeEventMetadata {
  return {
    provider: "grok",
    nativeEvent: firstString(rawEvent.method, rawEvent.sessionUpdate, rawEvent.type),
    ...(context.sessionId ? { thread: { id: context.sessionId } } : {}),
    ...(context.turnIndex
      ? {
          turn: {
            id: `grok-turn-${context.turnIndex}`,
          },
        }
      : {}),
  };
}

async function controlGrokRuntime(
  state: GrokSessionRuntimeState,
  request: RuntimeControlRequest,
): Promise<RuntimeControlResult> {
  const controlState = (): RuntimeControlState => ({
    provider: "grok",
    threadId: state.sessionId,
    activeTurn: state.activeTurn,
    supportedOperations: GROK_RUNTIME_CONTROL_OPERATIONS,
  });

  if (request.operation !== "turn.interrupt") {
    return {
      ok: false,
      operation: request.operation,
      state: controlState(),
      error: `Grok runtime does not support ${request.operation}`,
    };
  }

  state.interrupted = true;
  if (!state.sessionId || !state.transport) {
    return {
      ok: false,
      operation: request.operation,
      state: controlState(),
      error: "Grok ACP session is not connected",
    };
  }

  try {
    await state.transport.notify("session/cancel", { sessionId: state.sessionId });
    return {
      ok: true,
      operation: request.operation,
      state: controlState(),
    };
  } catch (error) {
    return {
      ok: false,
      operation: request.operation,
      state: controlState(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeGrokNotify(
  transport: GrokAcpTransport,
  method: string,
  params?: Record<string, unknown>,
): Promise<void> {
  try {
    await transport.notify(method, params);
  } catch {
    // Interrupt paths must be best-effort. The stream terminality layer handles
    // subprocess exit or missing terminal events.
  }
}

async function* consumeUntilSettled<T, R>(iterator: AsyncIterator<T>, settled: Promise<R>): AsyncGenerator<T> {
  let pendingNext = iterator.next();
  let settledValue: { current: R } | undefined;
  const settledBox = settled.then((value) => {
    settledValue = { current: value };
    return value;
  });

  while (!settledValue) {
    const winner = await Promise.race([
      pendingNext.then((result) => ({ tag: "item" as const, result })),
      settledBox.then(() => ({ tag: "settled" as const })),
    ]);
    if (winner.tag === "settled") {
      break;
    }
    if (winner.result.done) {
      await settledBox;
      return;
    }
    yield winner.result.value;
    pendingNext = iterator.next();
  }

  while (true) {
    const leftover = await peekIfResolved(pendingNext);
    if (!leftover || leftover.done) {
      return;
    }
    yield leftover.value;
    pendingNext = iterator.next();
  }
}

function peekIfResolved<T>(promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([promise, Promise.resolve(undefined)]);
}

function extractPromptText(message: RuntimePromptMessage): string {
  return message.message.content.trim();
}

function emptyUsage(): RuntimeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
  };
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

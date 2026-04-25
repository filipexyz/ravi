import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeExecutionMetadata,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionState,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  RuntimeThinking,
  RuntimeStatus,
  SessionRuntimeProvider,
} from "./types.js";
import { toStrongestCompatibleRuntimeEffort } from "./effort.js";
import { createRuntimeTerminalEventTracker } from "./terminality.js";

const nodeRequire = createRequire(import.meta.url);
const CLAUDE_CODE_EXECUTABLE_ENV_KEYS = ["RAVI_CLAUDE_CODE_EXECUTABLE", "CLAUDE_CODE_EXECUTABLE"] as const;
const CLAUDE_CODE_AUTH_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

export interface ClaudeRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export function createClaudeRuntimeProvider(): ClaudeRuntimeProvider {
  return {
    id: "claude",
    getCapabilities() {
      return {
        runtimeControl: {
          supported: false,
          operations: [],
        },
        dynamicTools: {
          mode: "none",
        },
        execution: {
          mode: "sdk",
        },
        sessionState: {
          mode: "provider-session-id",
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
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsPartialText: true,
        supportsToolHooks: true,
        supportsHostSessionHooks: true,
        supportsPlugins: true,
        supportsMcpServers: true,
        supportsRemoteSpawn: true,
        legacyEventTopicSuffix: "claude",
      };
    },
    prepareSession(input: RuntimePrepareSessionRequest): RuntimePrepareSessionResult {
      ensureClaudeSettings(input.cwd);
      return {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          CLAUDECODE: "",
        },
      };
    },
    startSession(input) {
      const resumeSessionId = readRuntimeSessionId(input.resumeSession) ?? input.resume;
      const env = buildClaudeCodeEnvironment(input.env);
      const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable(env);
      let activeQuery: Query | null = null;
      let currentModel = input.model;

      return {
        provider: "claude",
        events: runClaudeTurns(input, {
          initialResumeSessionId: resumeSessionId,
          env,
          pathToClaudeCodeExecutable,
          getModel: () => currentModel,
          setActiveQuery: (queryResult) => {
            activeQuery = queryResult;
          },
        }),
        interrupt: async () => {
          await activeQuery?.interrupt();
        },
        setModel: async (model: string) => {
          currentModel = model;
          if (activeQuery) {
            try {
              await activeQuery.setModel(model);
            } catch {
              // Some transports only accept model changes between turns. The
              // next query still uses currentModel.
            }
          }
        },
      };
    },
  };
}

async function* runClaudeTurns(
  input: RuntimeStartRequest,
  runtime: {
    initialResumeSessionId?: string;
    env: Record<string, string>;
    pathToClaudeCodeExecutable?: string;
    getModel(): string;
    setActiveQuery(queryResult: Query | null): void;
  },
): AsyncGenerator<RuntimeEvent> {
  let resumeSessionId = runtime.initialResumeSessionId;
  let useForkSession = input.forkSession;

  for await (const message of input.prompt) {
    if (input.abortController.signal.aborted) {
      break;
    }

    const prompt = stringifyUserPrompt(message.message.content);
    if (!prompt.trim()) {
      continue;
    }

    const queryResult = query({
      prompt,
      options: buildClaudeQueryOptions({ ...input, model: runtime.getModel() }, runtime.env, {
        resumeSessionId,
        forkSession: useForkSession,
        pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      }),
    });
    runtime.setActiveQuery(queryResult);

    const terminalTracker = createRuntimeTerminalEventTracker();
    try {
      for await (const event of normalizeClaudeEvents(queryResult)) {
        if (!terminalTracker.accept(event)) {
          continue;
        }
        if (event.type === "turn.complete") {
          resumeSessionId = event.providerSessionId ?? readRuntimeSessionId(event.session) ?? resumeSessionId;
          useForkSession = false;
        }
        yield event;
      }
      if (!terminalTracker.terminalEmitted) {
        const terminal = input.abortController.signal.aborted
          ? terminalTracker.interrupt({
              rawEvent: {
                type: "stream.ended",
                reason: "abort",
              },
            })
          : terminalTracker.fail({
              error: "Runtime provider stream ended without a terminal event",
              recoverable: true,
              rawEvent: {
                type: "stream.ended",
                reason: "missing_terminal_event",
              },
            });
        if (terminal) {
          yield terminal;
        }
      }
    } catch (error) {
      const terminal = input.abortController.signal.aborted
        ? terminalTracker.interrupt({
            rawEvent: {
              type: "stream.error",
              reason: "abort",
            },
          })
        : terminalTracker.fail({
            error: error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
      if (terminal) {
        yield terminal;
      }
    } finally {
      runtime.setActiveQuery(null);
    }
  }
}

function buildClaudeQueryOptions(
  input: RuntimeStartRequest,
  env: Record<string, string>,
  runtime: {
    resumeSessionId?: string;
    forkSession?: boolean;
    pathToClaudeCodeExecutable?: string;
  },
): Options {
  const thinking = resolveClaudeThinkingConfig(input.thinking);
  const effort = toStrongestCompatibleRuntimeEffort(input.effort);
  return {
    model: input.model,
    effort: effort as Options["effort"],
    ...(thinking ? { thinking } : {}),
    cwd: input.cwd,
    ...(runtime.resumeSessionId ? { resume: runtime.resumeSessionId } : {}),
    ...(runtime.forkSession ? { forkSession: true } : {}),
    abortController: input.abortController,
    ...(input.permissionOptions as Partial<Options> | undefined),
    ...(input.canUseTool
      ? {
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>): Promise<PermissionResult> => {
            const result = await input.canUseTool!(toolName, toolInput);
            if (result.behavior === "deny") {
              return {
                behavior: "deny",
                message: result.reason ?? `Tool denied: ${toolName}`,
              };
            }
            return {
              behavior: "allow",
              updatedInput: result.updatedInput ?? toolInput,
            };
          },
        }
      : {}),
    includePartialMessages: true,
    env,
    ...(runtime.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers as Record<string, McpServerConfig> } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.systemPromptAppend,
    },
    settingSources: input.settingSources ?? ["project"],
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.plugins && input.plugins.length > 0 ? { plugins: input.plugins } : {}),
    ...(input.remoteSpawn ? { spawnClaudeCodeProcess: input.remoteSpawn as Options["spawnClaudeCodeProcess"] } : {}),
  };
}

function resolveClaudeThinkingConfig(thinking?: RuntimeThinking): Options["thinking"] | undefined {
  switch (thinking) {
    case "off":
      return { type: "disabled" };
    case "verbose":
      return { type: "adaptive", display: "summarized" };
    case "normal":
      return { type: "adaptive", display: "omitted" };
    default:
      return undefined;
  }
}

function stringifyUserPrompt(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function buildClaudeCodeEnvironment(inputEnv?: Record<string, string>): Record<string, string> {
  const env = inputEnv
    ? { ...inputEnv }
    : Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );

  for (const key of CLAUDE_CODE_AUTH_ENV_KEYS) {
    const processValue = process.env[key]?.trim();
    if (processValue && !env[key]?.trim()) {
      env[key] = processValue;
    }
  }

  return env;
}

export function resolveClaudeCodeExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const key of CLAUDE_CODE_EXECUTABLE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }

  const nativeExecutable = resolveNativeClaudeCodeExecutable();
  if (nativeExecutable) {
    return nativeExecutable;
  }

  return resolveExecutableFromPath("claude", env);
}

function resolveNativeClaudeCodeExecutable(): string | undefined {
  const executableName = process.platform === "win32" ? "claude.exe" : "claude";

  for (const packageName of getNativePackagePreference()) {
    try {
      return nodeRequire.resolve(`${packageName}/${executableName}`);
    } catch {
      // Optional native packages are platform/package-manager dependent.
    }
  }

  return undefined;
}

function getNativePackagePreference(): string[] {
  const arch = process.arch;

  if (process.platform === "linux") {
    const linuxPackages = [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
    ];
    return isMuslRuntime() ? linuxPackages.reverse() : linuxPackages;
  }

  return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`];
}

function isMuslRuntime(): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function resolveExecutableFromPath(command: string, env: Record<string, string | undefined>): string | undefined {
  const path = env.PATH;
  if (!path) {
    return undefined;
  }

  const executableNames = process.platform === "win32" ? [`${command}.exe`, command] : [command];

  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const executableName of executableNames) {
      const candidate = join(directory, executableName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function* normalizeClaudeEvents(queryResult: Query): AsyncGenerator<RuntimeEvent> {
  for await (const message of queryResult as AsyncIterable<any>) {
    if (message.type === "stream_event") {
      const evt = message.event;
      if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yield { type: "text.delta", text: evt.delta.text };
      }
      continue;
    }

    const rawEvent = message as Record<string, unknown>;
    yield { type: "provider.raw", rawEvent };

    if (message.type === "system" && message.subtype === "status") {
      yield {
        type: "status",
        status: normalizeClaudeStatus(message.status),
        rawEvent,
      };
      continue;
    }

    if (message.type === "assistant") {
      const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
      let text = "";

      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          yield {
            type: "tool.started",
            toolUse: { id: block.id, name: block.name, input: block.input },
            rawEvent,
          };
        }
      }

      if (text) {
        yield {
          type: "assistant.message",
          text,
          rawEvent,
        };
      }
      continue;
    }

    if (message.type === "user") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        const toolResult = content.find((block: any) => block?.type === "tool_result");
        if (toolResult) {
          yield {
            type: "tool.completed",
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content,
            isError: toolResult.is_error,
            rawEvent,
          };
        }
      }
      continue;
    }

    if (message.type === "result") {
      if (message.subtype && message.subtype !== "success") {
        yield {
          type: "turn.failed",
          error:
            Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join("; ")
              : "Claude turn failed",
          recoverable: true,
          rawEvent,
        };
        continue;
      }

      yield {
        type: "turn.complete",
        providerSessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        session: buildClaudeSessionState(typeof message.session_id === "string" ? message.session_id : undefined),
        execution: buildClaudeExecutionMetadata(message),
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
        },
        rawEvent,
      };
    }
  }
}

function buildClaudeSessionState(sessionId: string | undefined): RuntimeSessionState | undefined {
  if (!sessionId) {
    return undefined;
  }

  return {
    params: { sessionId },
    displayId: sessionId,
  };
}

function buildClaudeExecutionMetadata(message: Record<string, any>): RuntimeExecutionMetadata {
  const model =
    typeof message.model === "string"
      ? message.model
      : typeof message.message?.model === "string"
        ? message.message.model
        : null;

  return {
    provider: "anthropic",
    model,
    billingType: "api",
  };
}

function readRuntimeSessionId(session: RuntimeStartRequest["resumeSession"]): string | undefined {
  if (!session?.params) {
    return undefined;
  }

  const value = session.params.sessionId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function ensureClaudeSettings(cwd: string): void {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    return;
  }

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        PermissionRequest: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: 'echo \'{"decision":"allow"}\'', timeout: 5 }],
          },
        ],
      },
      null,
      2,
    ),
  );
}

function normalizeClaudeStatus(status: string): RuntimeStatus {
  if (status === "queued" || status === "thinking" || status === "compacting" || status === "idle") {
    return status;
  }
  return status === "done" ? "idle" : "thinking";
}

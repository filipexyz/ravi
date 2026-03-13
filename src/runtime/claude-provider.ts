import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeExecutionMetadata,
  RuntimePrepareSessionRequest,
  RuntimePrepareSessionResult,
  RuntimeSessionState,
  RuntimeSessionHandle,
  RuntimeStartRequest,
  RuntimeStatus,
  SessionRuntimeProvider,
} from "./types.js";

export interface ClaudeRuntimeProvider extends SessionRuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}

export function createClaudeRuntimeProvider(): ClaudeRuntimeProvider {
  return {
    id: "claude",
    getCapabilities() {
      return {
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsPartialText: true,
        supportsToolHooks: true,
        supportsPlugins: true,
        supportsMcpServers: true,
        supportsRemoteSpawn: true,
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
      const options: Options = {
        model: input.model,
        cwd: input.cwd,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(input.forkSession ? { forkSession: true } : {}),
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
        env: input.env ?? process.env,
        ...(input.mcpServers ? { mcpServers: input.mcpServers as Record<string, McpServerConfig> } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: input.systemPromptAppend,
        },
        settingSources: input.settingSources ?? ["project"],
        ...(input.hooks ? { hooks: input.hooks } : {}),
        ...(input.plugins && input.plugins.length > 0 ? { plugins: input.plugins } : {}),
        ...(input.remoteSpawn
          ? { spawnClaudeCodeProcess: input.remoteSpawn as Options["spawnClaudeCodeProcess"] }
          : {}),
      };

      const queryResult = query({
        prompt: input.prompt,
        options,
      });

      return {
        provider: "claude",
        events: normalizeClaudeEvents(queryResult),
        interrupt: async () => {
          await queryResult.interrupt();
        },
      };
    },
  };
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

import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { notif } from "./notif.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";
import { buildSystemPrompt, SILENT_TOKEN } from "./prompt-builder.js";
import {
  loadRouterConfig,
  getOrCreateSession,
  updateSdkSessionId,
  updateTokens,
  updateSessionSource,
  updateSessionContext,
  updateSessionDisplayName,
  closeRouterDb,
  expandHome,
  type RouterConfig,
  type SessionEntry,
  type AgentConfig,
} from "./router/index.js";
// MCP disabled - uncomment to re-enable:
// import { createCliMcpServer, initCliTools } from "./cli/exports.js";
// import { MCP_SERVER, MCP_PREFIX } from "./cli/tool-registry.js";
import { runWithContext } from "./cli/context.js";
import { HEARTBEAT_OK } from "./heartbeat/index.js";
import { createBashPermissionHook } from "./bash/index.js";
import { createPreCompactHook } from "./hooks/index.js";
import { ALL_BUILTIN_TOOLS } from "./constants.js";
import { discoverPlugins } from "./plugins/index.js";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_NOTIF_BYTES = 60000; // leave margin for notif 64KB limit

function truncateOutput(output: unknown): unknown {
  if (typeof output === "string" && output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]`;
  }
  if (Array.isArray(output)) {
    return output.map(item => {
      if (item?.type === "text" && typeof item?.text === "string" && item.text.length > MAX_OUTPUT_LENGTH) {
        return { ...item, text: item.text.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]` };
      }
      return item;
    });
  }
  return output;
}

/** Emit to notif, truncating payload if it exceeds the size limit */
async function safeEmit(topic: string, data: Record<string, unknown>): Promise<void> {
  let json = JSON.stringify(data);
  if (json.length <= MAX_NOTIF_BYTES) {
    await notif.emit(topic, data);
    return;
  }
  // Truncate the largest string values until it fits
  const truncated = { ...data, _truncated: true };
  for (const key of Object.keys(truncated)) {
    const val = truncated[key];
    if (typeof val === "string" && val.length > MAX_OUTPUT_LENGTH) {
      truncated[key] = val.slice(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
    } else if (typeof val === "object" && val !== null) {
      const s = JSON.stringify(val);
      if (s.length > MAX_OUTPUT_LENGTH) {
        truncated[key] = s.slice(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
      }
    }
  }
  json = JSON.stringify(truncated);
  if (json.length > MAX_NOTIF_BYTES) {
    // Still too big - emit minimal event
    await notif.emit(topic, { _truncated: true, type: (data as any).type ?? (data as any).event ?? "unknown" });
    return;
  }
  await notif.emit(topic, truncated);
}

/** Message context for structured prompts */
export interface MessageContext {
  channelId: string;
  channelName: string;
  accountId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  timestamp: number;
}

/** Stable channel/group metadata persisted in session for cross-send reuse */
export interface ChannelContext {
  channelId: string;
  channelName: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
}

/** Debounce state for grouping messages */
interface DebounceState {
  messages: Array<{ prompt: PromptMessage; source?: MessageTarget }>;
  timer: ReturnType<typeof setTimeout>;
  debounceMs: number;
}

/** Message routing target */
export interface MessageTarget {
  channel: string;
  accountId: string;
  chatId: string;
}

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
  source?: MessageTarget;
  context?: MessageContext;
  /** Outbound system context injected by outbound module */
  _outboundSystemContext?: string;
}

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
  target?: MessageTarget;
  /** Unique emit ID to detect ghost/duplicate responses */
  _emitId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** Streaming session — persistent SDK subprocess that accepts messages via AsyncGenerator */
interface StreamingSession {
  /** The SDK query handle */
  queryHandle: Query;
  /** Abort controller to kill the subprocess */
  abortController: AbortController;
  /** Resolve function to unblock the generator and yield the next message */
  pushMessage: ((msg: UserMessage) => void) | null;
  /** Current response source for routing */
  currentSource?: MessageTarget;
  /** Tool tracking */
  toolRunning: boolean;
  currentToolId?: string;
  currentToolName?: string;
  toolStartTime?: number;
  /** Activity tracking */
  lastActivity: number;
  /** Whether the event loop is done (result received) */
  done: boolean;
}

/** User message format for the SDK streaming input */
interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}

export interface RaviBotOptions {
  config: Config;
}

export class RaviBot {
  private config: Config;
  private routerConfig: RouterConfig;
  private running = false;
  private streamingSessions = new Map<string, StreamingSession>();
  private debounceStates = new Map<string, DebounceState>();
  private promptSubscriptionActive = false;
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    this.routerConfig = loadRouterConfig();
    logger.setLevel(options.config.logLevel);
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...", { pid: process.pid, instanceId: this.instanceId });
    // initCliTools(); // MCP disabled
    this.running = true;
    this.subscribeToPrompts();
    log.info("Ravi bot started", {
      pid: process.pid,
      instanceId: this.instanceId,
      agents: Object.keys(this.routerConfig.agents),
    });
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    // Abort ALL streaming sessions
    if (this.streamingSessions.size > 0) {
      log.info("Aborting streaming sessions", {
        count: this.streamingSessions.size,
        sessions: [...this.streamingSessions.keys()],
      });
      for (const [sessionKey, session] of this.streamingSessions) {
        log.info("Aborting streaming session", { sessionKey });
        session.abortController.abort();
      }
      this.streamingSessions.clear();
    }

    closeDb();
    closeRouterDb();
    log.info("Ravi bot stopped");
  }

  private async subscribeToPrompts(): Promise<void> {
    if (this.promptSubscriptionActive) {
      log.warn("Prompt subscription already active, skipping duplicate");
      return;
    }
    this.promptSubscriptionActive = true;

    const topic = "ravi.*.prompt";
    log.info(`Subscribing to ${topic}`);

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        // Extract session key from topic: ravi.{sessionKey}.prompt
        const sessionKey = event.topic.split(".").slice(1, -1).join(".");
        const prompt = event.data as unknown as PromptMessage;

        // Don't await - handle concurrently
        this.handlePrompt(sessionKey, prompt).catch(err => {
          log.error("Failed to handle prompt", err);
        });
      }
    } catch (err) {
      log.error("Subscription error", err);
    } finally {
      this.promptSubscriptionActive = false;
      if (this.running) {
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    }
  }

  private async handlePrompt(sessionKey: string, prompt: PromptMessage): Promise<void> {
    // Reload config to get latest settings
    this.routerConfig = loadRouterConfig();

    // Get agent config for debounce setting
    const parts = sessionKey.split(":");
    const agentId = parts[0] === "agent" ? parts[1] : this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];
    const debounceMs = agent?.debounceMs;

    log.debug("handlePrompt", { sessionKey, agentId, debounceMs });

    // If debounce is configured, use debounce flow
    if (debounceMs && debounceMs > 0) {
      this.handlePromptWithDebounce(sessionKey, prompt, debounceMs);
      return;
    }

    // No debounce - use immediate flow
    await this.handlePromptImmediate(sessionKey, prompt);
  }

  private handlePromptWithDebounce(sessionKey: string, prompt: PromptMessage, debounceMs: number): void {
    const existing = this.debounceStates.get(sessionKey);

    if (existing) {
      log.debug("Debounce: adding message", { sessionKey, count: existing.messages.length + 1 });
      clearTimeout(existing.timer);
      existing.messages.push({ prompt, source: prompt.source });
      existing.timer = setTimeout(() => this.flushDebounce(sessionKey), debounceMs);
    } else {
      log.debug("Debounce: starting", { sessionKey, debounceMs });
      const state: DebounceState = {
        messages: [{ prompt, source: prompt.source }],
        timer: setTimeout(() => this.flushDebounce(sessionKey), debounceMs),
        debounceMs,
      };
      this.debounceStates.set(sessionKey, state);
    }
  }

  private async flushDebounce(sessionKey: string): Promise<void> {
    const state = this.debounceStates.get(sessionKey);
    if (!state) return;

    this.debounceStates.delete(sessionKey);

    // Combine all messages into one
    const combinedPrompt = state.messages.map(m => m.prompt.prompt).join("\n\n");
    const lastSource = state.messages[state.messages.length - 1].source;

    log.info("Debounce: flushing", { sessionKey, messageCount: state.messages.length });

    // Process the combined message
    await this.handlePromptImmediate(sessionKey, {
      prompt: combinedPrompt,
      source: lastSource,
    });
  }

  private async handlePromptImmediate(sessionKey: string, prompt: PromptMessage): Promise<void> {
    const existing = this.streamingSessions.get(sessionKey);

    if (existing && !existing.done) {
      // Session alive — just push the new message into the generator
      log.info("Streaming: pushing message to existing session", { sessionKey });
      this.updateSessionMetadata(sessionKey, prompt);
      saveMessage(sessionKey, "user", prompt.prompt);

      // Update source for response routing
      if (prompt.source) {
        existing.currentSource = prompt.source;
      }

      if (existing.pushMessage) {
        const resolver = existing.pushMessage;
        existing.pushMessage = null; // consumed
        resolver({
          type: "user",
          message: { role: "user", content: prompt.prompt },
        });
      } else {
        // Generator not yet waiting — this shouldn't normally happen,
        // but if it does, abort and start fresh
        log.warn("Streaming: generator not ready, restarting session", { sessionKey });
        existing.abortController.abort();
        this.streamingSessions.delete(sessionKey);
        await this.startStreamingSession(sessionKey, prompt);
      }
      return;
    }

    // No active session or previous one finished — start new streaming session
    if (existing?.done) {
      this.streamingSessions.delete(sessionKey);
    }
    await this.startStreamingSession(sessionKey, prompt);
  }

  /** Start a new streaming session with an AsyncGenerator that stays alive */
  private async startStreamingSession(sessionKey: string, prompt: PromptMessage): Promise<void> {
    // Parse session key to get agent ID
    const parts = sessionKey.split(":");
    const agentId = parts[0] === "agent" ? parts[1] : this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];

    if (!agent) {
      log.error("No agent found", { sessionKey, agentId });
      return;
    }

    const agentCwd = expandHome(agent.cwd);
    const session = getOrCreateSession(sessionKey, agent.id, agentCwd);

    // Resolve source for response routing
    let resolvedSource = prompt.source;
    if (!resolvedSource && session.lastChannel && session.lastTo) {
      resolvedSource = {
        channel: session.lastChannel,
        accountId: session.lastAccountId ?? "default",
        chatId: session.lastTo,
      };
    }

    this.updateSessionMetadata(sessionKey, prompt);
    saveMessage(sessionKey, "user", prompt.prompt);

    const model = agent.model ?? this.config.model;

    // Build permission options
    let permissionOptions: Record<string, unknown>;
    if (agent.allowedTools) {
      const disallowed = ALL_BUILTIN_TOOLS.filter(t => !agent.allowedTools!.includes(t));
      permissionOptions = { disallowedTools: disallowed, allowedTools: agent.allowedTools };
    } else {
      permissionOptions = { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true };
    }

    // Build system prompt
    let systemPromptAppend = buildSystemPrompt(agent.id, prompt.context);
    if (prompt._outboundSystemContext) {
      systemPromptAppend += "\n\n" + prompt._outboundSystemContext;
    }

    // Build hooks
    const hooks: Record<string, unknown[]> = {};
    if (agent.bashConfig) {
      hooks.PreToolUse = [createBashPermissionHook(() => agent.bashConfig)];
    }
    hooks.PreCompact = [createPreCompactHook({ memoryModel: agent.memoryModel })];

    const plugins = discoverPlugins();
    const abortController = new AbortController();

    // Create the streaming session state
    const streamingSession: StreamingSession = {
      queryHandle: null as any, // set below
      abortController,
      pushMessage: null,
      currentSource: resolvedSource,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
    };
    this.streamingSessions.set(sessionKey, streamingSession);

    // Create the AsyncGenerator that feeds messages to the SDK
    const messageGenerator = this.createMessageGenerator(sessionKey, prompt.prompt, streamingSession);

    const runId = Math.random().toString(36).slice(2, 8);
    log.info("Starting streaming session", {
      runId,
      sessionKey,
      agentId: agent.id,
      sdkSessionId: session.sdkSessionId ?? null,
      resuming: !!session.sdkSessionId,
    });

    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model,
        cwd: agentCwd,
        resume: session.sdkSessionId,
        abortController,
        ...permissionOptions,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
        settingSources: agent.settingSources ?? ["project"],
        ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
        ...(plugins.length > 0 ? { plugins } : {}),
      },
    });

    streamingSession.queryHandle = queryResult;

    // Build tool context for CLI tools
    const toolContext = {
      sessionKey,
      agentId: agent.id,
      source: resolvedSource,
    };

    // Run the event loop in the background (don't await — it stays alive)
    runWithContext(toolContext, () =>
      this.runEventLoop(runId, sessionKey, session, agent, streamingSession, queryResult)
    ).catch(err => {
      const isAbort = err instanceof Error && /abort/i.test(err.message);
      if (isAbort) {
        log.info("Streaming session aborted", { sessionKey });
      } else {
        log.error("Streaming session failed", { sessionKey, error: err });
      }
    });
  }

  /** AsyncGenerator that yields user messages. Stays alive between turns. */
  private async *createMessageGenerator(
    sessionKey: string,
    firstMessage: string,
    session: StreamingSession
  ): AsyncGenerator<UserMessage> {
    // Yield the first message immediately
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: firstMessage },
    };

    // Then wait for subsequent messages
    while (!session.done) {
      const msg = await new Promise<UserMessage | null>((resolve) => {
        session.pushMessage = resolve;
      });

      if (msg === null) break; // session ended
      yield msg;
    }
  }

  /** Process SDK events from the streaming query */
  private async runEventLoop(
    runId: string,
    sessionKey: string,
    session: SessionEntry,
    agent: AgentConfig,
    streaming: StreamingSession,
    queryResult: Query
  ): Promise<void> {
    // Timeout watchdog
    const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (longer for streaming)
    const watchdog = setInterval(() => {
      const elapsed = Date.now() - streaming.lastActivity;
      if (elapsed > SESSION_TIMEOUT_MS) {
        log.warn("Streaming session idle timeout", { sessionKey, elapsedMs: elapsed });
        streaming.done = true;
        if (streaming.pushMessage) {
          streaming.pushMessage(null as any);
          streaming.pushMessage = null;
        }
        streaming.abortController.abort();
        this.streamingSessions.delete(sessionKey);
        clearInterval(watchdog);
      }
    }, 30000);

    let sdkEventCount = 0;
    let responseText = "";

    const emitSdkEvent = async (event: Record<string, unknown>) => {
      await safeEmit(`ravi.${sessionKey}.claude`, event);
    };

    const emitResponse = async (text: string) => {
      const emitId = Math.random().toString(36).slice(2, 8);
      log.info("Emitting response", { sessionKey, emitId, textLen: text.length });
      await notif.emit(`ravi.${sessionKey}.response`, {
        response: text,
        target: streaming.currentSource,
        _emitId: emitId,
        _instanceId: this.instanceId,
        _pid: process.pid,
        _v: 2,
      });
    };

    try {
      for await (const message of queryResult) {
        sdkEventCount++;
        streaming.lastActivity = Date.now();

        // Log SDK events
        log.info("SDK event", {
          runId,
          seq: sdkEventCount,
          type: message.type,
          sessionKey,
          ...(message.type === "assistant" ? {
            contentTypes: message.message.content.map((b: any) => b.type),
            textPreview: message.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text?.slice(0, 80))
              .join("") || undefined,
          } : {}),
          ...(message.type === "result" ? {
            sessionId: (message as any).session_id,
          } : {}),
        });

        // Emit all SDK events for typing heartbeat etc.
        await emitSdkEvent(message as unknown as Record<string, unknown>);

        // Handle assistant messages
        if (message.type === "assistant") {
          const blocks = message.message.content;
          let messageText = "";
          for (const block of blocks) {
            if (block.type === "text") {
              messageText += block.text;
            }
            if (block.type === "tool_use") {
              streaming.toolRunning = true;
              streaming.currentToolId = block.id;
              streaming.currentToolName = block.name;
              streaming.toolStartTime = Date.now();

              safeEmit(`ravi.${sessionKey}.tool`, {
                event: "start",
                toolId: block.id,
                toolName: block.name,
                input: truncateOutput(block.input),
                timestamp: new Date().toISOString(),
                sessionKey,
                agentId: agent.id,
              }).catch(err => log.warn("Failed to emit tool start", { error: err }));
            }
          }
          if (messageText) {
            messageText = messageText.trimStart();
            log.info("Assistant message", { runId, text: messageText.slice(0, 100) });
            responseText += messageText;

            if (messageText.trim() === SILENT_TOKEN) {
              log.info("Silent response", { sessionKey });
              await emitSdkEvent({ type: "silent" });
            } else if (messageText.trim() === HEARTBEAT_OK) {
              log.info("Heartbeat OK", { sessionKey });
              await emitSdkEvent({ type: "silent" });
            } else {
              await emitResponse(messageText);
            }
          }
        }

        // Handle tool results
        if (message.type === "user") {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            const toolResult = content.find((b: any) => b.type === "tool_result");
            if (toolResult) {
              const durationMs = streaming.toolStartTime ? Date.now() - streaming.toolStartTime : undefined;

              safeEmit(`ravi.${sessionKey}.tool`, {
                event: "end",
                toolId: streaming.currentToolId ?? toolResult?.tool_use_id ?? "unknown",
                toolName: streaming.currentToolName ?? "unknown",
                output: truncateOutput(toolResult?.content),
                isError: toolResult?.is_error ?? false,
                durationMs,
                timestamp: new Date().toISOString(),
                sessionKey,
                agentId: agent.id,
              }).catch(err => log.warn("Failed to emit tool end", { error: err }));

              streaming.toolRunning = false;
              streaming.currentToolId = undefined;
              streaming.currentToolName = undefined;
              streaming.toolStartTime = undefined;
            }
          }
        }

        // Handle result (turn complete — save and wait for next message)
        if (message.type === "result") {
          const inputTokens = message.usage?.input_tokens ?? 0;
          const outputTokens = message.usage?.output_tokens ?? 0;
          const cacheRead = (message.usage as any)?.cache_read_input_tokens ?? 0;
          const cacheCreation = (message.usage as any)?.cache_creation_input_tokens ?? 0;

          log.info("Turn complete", {
            runId,
            total: inputTokens + cacheRead + cacheCreation,
            new: inputTokens,
            cached: cacheRead,
            written: cacheCreation,
            output: outputTokens,
            sessionId: message.session_id,
          });

          if ("session_id" in message && message.session_id) {
            updateSdkSessionId(sessionKey, message.session_id);
          }
          updateTokens(sessionKey, inputTokens, outputTokens);

          if (responseText.trim()) {
            saveMessage(sessionKey, "assistant", responseText.trim());
          }

          // Reset for next turn
          responseText = "";
        }
      }
    } finally {
      log.info("Streaming session ended", { runId, sessionKey });
      clearInterval(watchdog);

      streaming.done = true;

      // Unblock generator if it's waiting
      if (streaming.pushMessage) {
        streaming.pushMessage(null as any);
        streaming.pushMessage = null;
      }

      // Abort subprocess if still alive
      if (!streaming.abortController.signal.aborted) {
        streaming.abortController.abort();
      }

      this.streamingSessions.delete(sessionKey);
    }
  }

  /** Update session metadata (source, context, display name) */
  private updateSessionMetadata(sessionKey: string, prompt: PromptMessage): void {
    if (prompt.source) {
      updateSessionSource(sessionKey, prompt.source);
    }

    if (prompt.context?.senderId) {
      const channelCtx: ChannelContext = {
        channelId: prompt.context.channelId,
        channelName: prompt.context.channelName,
        isGroup: prompt.context.isGroup,
        groupName: prompt.context.groupName,
        groupId: prompt.context.groupId,
        groupMembers: prompt.context.groupMembers,
      };
      updateSessionContext(sessionKey, JSON.stringify(channelCtx));
      if (prompt.context.groupName) {
        updateSessionDisplayName(sessionKey, prompt.context.groupName);
      }
    }
  }
}

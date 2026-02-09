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
  /** Resolve function to unblock the generator when waiting between turns */
  pushMessage: ((msg: UserMessage | null) => void) | null;
  /** Queue of messages — stays in queue until turn completes without interrupt */
  pendingMessages: UserMessage[];
  /** Current response source for routing */
  currentSource?: MessageTarget;
  /** Tool tracking */
  toolRunning: boolean;
  currentToolId?: string;
  currentToolName?: string;
  toolStartTime?: number;
  /** Activity tracking */
  lastActivity: number;
  /** Whether the event loop is done (session ended) */
  done: boolean;
  /** Whether the current turn was interrupted (discard response, keep queue) */
  interrupted: boolean;
  /** Signal from result handler to unblock generator after turn completes */
  onTurnComplete: (() => void) | null;
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

/** Pending approval waiting for a reaction */
interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RaviBot {
  private config: Config;
  private routerConfig: RouterConfig;
  private running = false;
  private streamingSessions = new Map<string, StreamingSession>();
  private debounceStates = new Map<string, DebounceState>();
  private promptSubscriptionActive = false;
  /** Pending approvals keyed by outbound messageId */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    this.routerConfig = loadRouterConfig();
    logger.setLevel(options.config.logLevel);
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...", { pid: process.pid, instanceId: this.instanceId });
    this.running = true;
    this.subscribeToPrompts();
    this.subscribeToInboundReactions();
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

  /**
   * Listen for inbound reactions and resolve pending approvals.
   */
  private async subscribeToInboundReactions(): Promise<void> {
    for await (const event of notif.subscribe("ravi.inbound.reaction")) {
      if (!this.running) break;
      const data = event.data as {
        targetMessageId: string;
        emoji: string;
        senderId: string;
      };

      const pending = this.pendingApprovals.get(data.targetMessageId);
      if (!pending) continue;

      const approved = data.emoji === "👍";
      log.info("Approval reaction received", {
        targetMessageId: data.targetMessageId,
        emoji: data.emoji,
        approved,
        senderId: data.senderId,
      });

      clearTimeout(pending.timer);
      this.pendingApprovals.delete(data.targetMessageId);
      pending.resolve(approved);
    }
  }

  /**
   * Send a message to WhatsApp and wait for a reaction (👍 or ❌).
   * Returns true if approved, false if rejected or timed out.
   */
  private async requestApproval(
    source: MessageTarget,
    text: string,
    timeoutMs = 5 * 60 * 1000 // 5 minutes
  ): Promise<boolean> {
    // Send via gateway with replyTopic to get the messageId back
    const replyTopic = `ravi.approval.reply.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    // Start listening before emitting (to avoid race condition)
    const sendResultPromise = new Promise<{ messageId?: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({}), 5000);
      notif.subscribe(replyTopic).next().then(({ value }) => {
        clearTimeout(timeout);
        resolve((value?.data as { messageId?: string }) ?? {});
      });
    });

    await notif.emit("ravi.outbound.deliver", {
      channel: source.channel,
      accountId: source.accountId,
      to: source.chatId,
      text,
      replyTopic,
    });

    const sendResult = await sendResultPromise;

    if (!sendResult.messageId) {
      log.warn("Failed to get messageId for approval message");
      return true; // default to approved if we can't track
    }

    log.info("Waiting for approval reaction", { messageId: sendResult.messageId });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(sendResult.messageId!);
        log.warn("Approval timed out", { messageId: sendResult.messageId });
        resolve(false);
      }, timeoutMs);

      this.pendingApprovals.set(sendResult.messageId!, { resolve, timer });
    });
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

      const userMsg: UserMessage = {
        type: "user",
        message: { role: "user", content: prompt.prompt },
      };

      // Always enqueue — messages only leave the queue when a turn completes without interrupt
      existing.pendingMessages.push(userMsg);

      if (existing.pushMessage) {
        // Generator waiting between turns — wake it up to yield the queue
        log.info("Streaming: waking generator", { sessionKey, queueSize: existing.pendingMessages.length });
        const resolver = existing.pushMessage;
        existing.pushMessage = null;
        resolver(null); // wake-up signal
      } else if (existing.toolRunning) {
        // Tool running — just enqueue, don't interrupt
        log.info("Streaming: queueing (tool running)", {
          sessionKey,
          queueSize: existing.pendingMessages.length,
          tool: existing.currentToolName,
        });
      } else {
        // SDK generating text — interrupt, discard response, re-process with full queue
        log.info("Streaming: interrupting turn", {
          sessionKey,
          queueSize: existing.pendingMessages.length,
        });
        existing.interrupted = true;
        existing.queryHandle.interrupt().catch(() => {});
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
    if (agent.bashConfig || agent.allowedTools) {
      hooks.PreToolUse = [createBashPermissionHook({
        getBashConfig: () => agent.bashConfig,
        getAllowedTools: () => agent.allowedTools,
      })];
    }
    hooks.PreCompact = [createPreCompactHook({ memoryModel: agent.memoryModel })];

    const plugins = discoverPlugins();
    const abortController = new AbortController();

    // Create the streaming session state
    const streamingSession: StreamingSession = {
      queryHandle: null as any, // set below
      abortController,
      pushMessage: null,
      pendingMessages: [],
      currentSource: resolvedSource,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      onTurnComplete: null,
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

    // Build RAVI_* env vars for session context (available in Bash tools)
    const raviEnv: Record<string, string> = {
      RAVI_SESSION_KEY: sessionKey,
      RAVI_AGENT_ID: agent.id,
    };
    if (resolvedSource) {
      raviEnv.RAVI_CHANNEL = resolvedSource.channel;
      raviEnv.RAVI_ACCOUNT_ID = resolvedSource.accountId;
      raviEnv.RAVI_CHAT_ID = resolvedSource.chatId;
    }
    if (prompt.context) {
      raviEnv.RAVI_SENDER_ID = prompt.context.senderId;
      if (prompt.context.senderName) raviEnv.RAVI_SENDER_NAME = prompt.context.senderName;
      if (prompt.context.senderPhone) raviEnv.RAVI_SENDER_PHONE = prompt.context.senderPhone;
      if (prompt.context.isGroup) {
        if (prompt.context.groupId) raviEnv.RAVI_GROUP_ID = prompt.context.groupId;
        if (prompt.context.groupName) raviEnv.RAVI_GROUP_NAME = prompt.context.groupName;
      }
    }

    // Build canUseTool — intercept ExitPlanMode for reaction-based approval
    const canUseTool = resolvedSource
      ? async (toolName: string, input: Record<string, unknown>) => {
          if (toolName !== "ExitPlanMode") {
            return { behavior: "allow" as const, updatedInput: input };
          }

          log.info("ExitPlanMode called, requesting approval via reaction", { sessionKey });

          const plan = typeof input.plan === "string" ? input.plan : JSON.stringify(input);
          const approvalText = `📋 *Plano pendente*\n\n${plan}\n\n_Reaja com 👍 pra aprovar ou qualquer outro emoji pra rejeitar._`;

          const approved = await this.requestApproval(resolvedSource!, approvalText);

          if (approved) {
            log.info("Plan approved via reaction", { sessionKey });
            return { behavior: "allow" as const, updatedInput: input };
          } else {
            log.info("Plan rejected via reaction", { sessionKey });
            return { behavior: "deny" as const, message: "Plano rejeitado pelo usuário." };
          }
        }
      : undefined;

    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model,
        cwd: agentCwd,
        resume: session.sdkSessionId,
        abortController,
        ...permissionOptions,
        ...(canUseTool ? { canUseTool } : {}),
        env: { ...process.env, ...raviEnv },
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
    // First message goes directly into queue so the same drain logic handles it
    session.pendingMessages.push({
      type: "user" as const,
      message: { role: "user" as const, content: firstMessage },
    });

    while (!session.done) {
      // Wait for messages if queue is empty
      if (session.pendingMessages.length === 0) {
        await new Promise<void>((resolve) => {
          session.pushMessage = () => resolve();
        });
        if (session.pendingMessages.length === 0 && session.done) break;
        if (session.pendingMessages.length === 0) continue;
      }

      // Snapshot how many messages we're yielding (more may arrive during the turn)
      const yieldedCount = session.pendingMessages.length;
      const combined = session.pendingMessages.map(m => m.message.content).join("\n\n");
      log.info("Generator: yielding", {
        sessionKey, count: yieldedCount,
      });

      yield {
        type: "user" as const,
        message: { role: "user" as const, content: combined },
      };

      // Wait for result handler to signal turn complete
      await new Promise<void>((resolve) => {
        session.onTurnComplete = resolve;
      });

      if (session.interrupted) {
        // Turn was interrupted — keep ALL messages (they'll be re-yielded combined)
        log.info("Generator: turn interrupted, keeping queue", {
          sessionKey, count: session.pendingMessages.length,
        });
        session.interrupted = false;
      } else {
        // Turn completed normally — remove only the messages that were yielded
        // New messages that arrived during the turn (e.g. during tool execution) stay
        session.pendingMessages.splice(0, yieldedCount);
        log.info("Generator: turn complete", {
          sessionKey, cleared: yieldedCount, remaining: session.pendingMessages.length,
        });
      }
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
            log.info("Assistant message", { runId, interrupted: streaming.interrupted, text: messageText.slice(0, 100) });

            if (streaming.interrupted) {
              // Turn was interrupted — discard response
              log.info("Discarding interrupted response", { sessionKey, textLen: messageText.length });
            } else {
              responseText += messageText;

              const trimmed = messageText.trim().toLowerCase();
              if (messageText.trim() === SILENT_TOKEN) {
                log.info("Silent response", { sessionKey });
                await emitSdkEvent({ type: "silent" });
              } else if (messageText.trim() === HEARTBEAT_OK) {
                log.info("Heartbeat OK", { sessionKey });
                await emitSdkEvent({ type: "silent" });
              } else if (trimmed === "no response requested." || trimmed === "no response requested" || trimmed === "no response needed." || trimmed === "no response needed") {
                log.info("Silent response (no response requested)", { sessionKey });
                await emitSdkEvent({ type: "silent" });
              } else {
                await emitResponse(messageText);
              }
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
            interrupted: streaming.interrupted,
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

          if (!streaming.interrupted && responseText.trim()) {
            saveMessage(sessionKey, "assistant", responseText.trim());
          }

          // Reset for next turn
          responseText = "";
          streaming.toolRunning = false;

          // Signal generator to continue (it will clear or keep queue based on interrupted flag)
          if (streaming.onTurnComplete) {
            streaming.onTurnComplete();
            streaming.onTurnComplete = null;
          }
        }
      }
    } finally {
      log.info("Streaming session ended", { runId, sessionKey });
      clearInterval(watchdog);

      streaming.done = true;

      // Unblock generator if it's waiting (between turns or waiting for turn complete)
      if (streaming.pushMessage) {
        streaming.pushMessage(null as any);
        streaming.pushMessage = null;
      }
      if (streaming.onTurnComplete) {
        streaming.onTurnComplete();
        streaming.onTurnComplete = null;
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

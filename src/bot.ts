import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { notif } from "./notif.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";
import { buildDefaultPrompt, buildSystemPrompt, SILENT_TOKEN } from "./prompt-builder.js";
import {
  loadRouterConfig,
  getOrCreateSession,
  updateSdkSessionId,
  updateTokens,
  updateSessionSource,
  closeRouterDb,
  expandHome,
  type RouterConfig,
  type SessionEntry,
  type AgentConfig,
} from "./router/index.js";
import { createCliMcpServer, initCliTools } from "./cli/exports.js";
import { MCP_SERVER, MCP_PREFIX } from "./cli/tool-registry.js";
import { runWithContext } from "./cli/context.js";

const log = logger.child("bot");

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

/** Queued message waiting to be processed */
interface QueuedMessage {
  prompt: PromptMessage;
  source?: MessageTarget;
}

/** Active session state for interrupt handling */
interface ActiveSession {
  query: Query;
  toolRunning: boolean;
  currentToolId?: string;
  messageQueue: QueuedMessage[];
  interrupted: boolean;
}

/** Debounce state for grouping messages */
interface DebounceState {
  messages: QueuedMessage[];
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
}

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
  target?: MessageTarget;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface RaviBotOptions {
  config: Config;
}

export class RaviBot {
  private config: Config;
  private routerConfig: RouterConfig;
  private running = false;
  private activeSessions = new Map<string, ActiveSession>();
  private debounceStates = new Map<string, DebounceState>();

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    this.routerConfig = loadRouterConfig();
    logger.setLevel(options.config.logLevel);
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...");
    initCliTools();
    this.running = true;
    this.subscribeToPrompts();
    log.info("Ravi bot started", {
      agents: Object.keys(this.routerConfig.agents),
    });
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;
    closeDb();
    closeRouterDb();
    log.info("Ravi bot stopped");
  }

  private async subscribeToPrompts(): Promise<void> {
    const topic = "ravi.*.prompt";
    log.info(`Subscribing to ${topic}`);

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        // Extract session key from topic: ravi.{sessionKey}.prompt
        const sessionKey = event.topic.split(".").slice(1, -1).join(".");
        const prompt = event.data as unknown as PromptMessage;

        // Don't await - handle concurrently to allow interrupts
        this.handlePrompt(sessionKey, prompt).catch(err => {
          log.error("Failed to handle prompt", err);
        });
      }
    } catch (err) {
      log.error("Subscription error", err);
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

    log.info("handlePrompt debounce check", { sessionKey, agentId, debounceMs });

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
      // Add to existing debounce, reset timer
      log.info("Debounce: adding message", {
        sessionKey,
        debounceMs,
        messageCount: existing.messages.length + 1
      });
      clearTimeout(existing.timer);
      existing.messages.push({ prompt, source: prompt.source });
      existing.timer = setTimeout(() => this.flushDebounce(sessionKey), debounceMs);
    } else {
      // Start new debounce
      log.info("Debounce: starting", { sessionKey, debounceMs });
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

    log.info("Debounce: flushing", {
      sessionKey,
      messageCount: state.messages.length,
      combinedLength: combinedPrompt.length
    });

    // Process the combined message
    await this.handlePromptImmediate(sessionKey, {
      prompt: combinedPrompt,
      source: lastSource,
    });
  }

  private async handlePromptImmediate(sessionKey: string, prompt: PromptMessage): Promise<void> {
    const active = this.activeSessions.get(sessionKey);
    log.info("handlePrompt called", {
      sessionKey,
      hasActiveSession: !!active,
      toolRunning: active?.toolRunning,
      queueSize: active?.messageQueue.length
    });

    if (active) {
      // Session already active - queue or interrupt
      if (active.toolRunning) {
        // Tool running - queue message and wait for it to finish
        log.info("Tool running, queueing message", {
          sessionKey,
          queueSize: active.messageQueue.length + 1
        });
        active.messageQueue.push({ prompt, source: prompt.source });
        return;
      } else {
        // No tool running - interrupt immediately
        log.info("Interrupting session for new message (no tool running)", { sessionKey });
        active.messageQueue.push({ prompt, source: prompt.source });
        if (!active.interrupted) {
          active.interrupted = true;
          try {
            await active.query.interrupt();
            log.info("Interrupt sent successfully", { sessionKey });
          } catch (err) {
            log.error("Interrupt failed", { sessionKey, error: err });
          }
        }
        return;
      }
    }

    // No active session - process normally
    await this.processNewPrompt(sessionKey, prompt);
  }

  private async processNewPrompt(sessionKey: string, prompt: PromptMessage): Promise<void> {
    // Parse session key to get agent ID: "agent:main:..." -> "main"
    const parts = sessionKey.split(":");
    const agentId = parts[0] === "agent" ? parts[1] : this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];

    if (!agent) {
      log.error("No agent found", { sessionKey, agentId });
      return;
    }

    const agentCwd = expandHome(agent.cwd);
    const session = getOrCreateSession(sessionKey, agent.id, agentCwd);

    // Update source for response routing (cross-session messages need this)
    if (prompt.source) {
      updateSessionSource(sessionKey, prompt.source);
    }

    log.info("Processing prompt", { sessionKey, agentId, cwd: agentCwd });

    // Save message
    saveMessage(sessionKey, "user", prompt.prompt);

    // Build tool context for CLI tools
    const toolContext = {
      sessionKey,
      agentId: agent.id,
      source: prompt.source,
    };

    try {
      // Emit partial messages as they arrive
      const onMessage = async (text: string) => {
        const partialResponse: ResponseMessage = {
          response: text,
          target: prompt.source,
        };
        await notif.emit(`ravi.${sessionKey}.response`, partialResponse as Record<string, unknown>);
      };

      // Emit all SDK events
      const onSdkEvent = async (event: Record<string, unknown>) => {
        await notif.emit(`ravi.${sessionKey}.claude`, event);
      };

      // Run with context so CLI tools can access session info
      const response = await runWithContext(toolContext, () =>
        this.processPrompt(prompt, session, agent, agentCwd, onMessage, onSdkEvent)
      );

      if (response.response) {
        saveMessage(sessionKey, "assistant", response.response);
      }

      // Final response with usage (not sent to channel, just for tracking)
      if (response.usage) {
        log.info("Completed", { sessionKey, tokens: response.usage.input_tokens + response.usage.output_tokens });
      }
    } catch (err) {
      log.error("Query failed", { sessionKey, error: err });
      const errorResponse: ResponseMessage = {
        error: err instanceof Error ? err.message : "Unknown error",
        target: prompt.source,
      };
      await notif.emit(`ravi.${sessionKey}.response`, errorResponse as Record<string, unknown>);
    }
  }

  private async processPrompt(
    prompt: PromptMessage,
    session: SessionEntry,
    agent: AgentConfig,
    agentCwd: string,
    onMessage?: (text: string) => Promise<void>,
    onSdkEvent?: (event: Record<string, unknown>) => Promise<void>
  ): Promise<ResponseMessage> {
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const model = agent.model ?? this.config.model;

    // All built-in tools (used to compute disallowedTools)
    const ALL_BUILTIN_TOOLS = [
      // Core tools
      "Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write",
      "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite",
      "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Skill",
      // Additional tools
      "TaskOutput", "KillShell", "TaskStop", "LSP",
    ];

    // Build permission options: use disallowedTools if whitelist defined, otherwise bypass mode
    let permissionOptions: Record<string, unknown>;
    if (agent.allowedTools) {
      const disallowed = ALL_BUILTIN_TOOLS.filter(t => !agent.allowedTools!.includes(t));
      log.info("Tool restriction", {
        agentId: agent.id,
        allowedTools: agent.allowedTools,
        disallowedTools: disallowed
      });
      permissionOptions = {
        disallowedTools: disallowed,
        // Use allowedTools to auto-approve the allowed tools
        allowedTools: agent.allowedTools,
      };
    } else {
      log.info("Bypass mode (no tool restriction)", { agentId: agent.id });
      permissionOptions = {
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true
      };
    }

    // Build system prompt with context if available
    const systemPromptAppend = prompt.context
      ? buildSystemPrompt(agent.id, prompt.context)
      : buildDefaultPrompt();

    log.debug("System prompt", { agentId: agent.id, hasContext: !!prompt.context });

    // Create MCP server with CLI tools filtered by agent permissions
    // MCP tool naming: mcp__{server}__{tool}
    // Example: mcp__ravi-cli__agents_list

    // Filter allowed tools to only MCP tools for our server
    const mcpToolsWhitelist = agent.allowedTools?.filter(t => t.startsWith(MCP_PREFIX));
    const cliMcpServer = createCliMcpServer({
      name: MCP_SERVER,
      // Strip MCP prefix to get internal tool names
      allowedTools: mcpToolsWhitelist?.length
        ? mcpToolsWhitelist.map(t => t.replace(MCP_PREFIX, ""))
        : undefined,
    });

    log.debug("CLI MCP Server created", {
      agentId: agent.id,
      serverName: cliMcpServer.name,
    });

    const queryResult = query({
      prompt: prompt.prompt,
      options: {
        model,
        cwd: agentCwd,
        resume: session.sdkSessionId,
        ...permissionOptions,
        mcpServers: {
          "ravi-cli": cliMcpServer,
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
        settingSources: ["project"],
      },
    });

    // Register active session for interrupt handling
    const activeSession: ActiveSession = {
      query: queryResult,
      toolRunning: false,
      messageQueue: [],
      interrupted: false,
    };
    this.activeSessions.set(session.sessionKey, activeSession);

    try {
      for await (const message of queryResult) {
        log.debug("SDK message", {
        type: message.type,
        toolRunning: activeSession.toolRunning,
        queueSize: activeSession.messageQueue.length
      });

        // Emit all SDK events
        if (onSdkEvent) {
          await onSdkEvent(message as unknown as Record<string, unknown>);
        }

        // Detect tool start (assistant message with tool_use blocks)
        if (message.type === "assistant") {
          const blocks = message.message.content;
          let messageText = "";
          for (const block of blocks) {
            if (block.type === "text") {
              messageText += block.text;
            }
            if (block.type === "tool_use") {
              activeSession.toolRunning = true;
              activeSession.currentToolId = block.id;
              log.debug("Tool started", { sessionKey: session.sessionKey, toolName: block.name, toolId: block.id });
            }
          }
          if (messageText) {
            log.info("Assistant message", { text: messageText.slice(0, 100) });
            responseText += messageText;

            // Skip silent responses - don't emit to channel
            if (messageText.trim() === SILENT_TOKEN) {
              log.info("Silent response detected, not emitting", { sessionKey: session.sessionKey });
            } else if (onMessage) {
              await onMessage(messageText);
            }
          }
        }

        // Detect tool end (user message with tool_result)
        if (message.type === "user") {
          // Log full message structure for debugging
          log.debug("User message received", {
            sessionKey: session.sessionKey,
            messageKeys: Object.keys(message),
            hasMessage: !!(message as any).message,
            hasToolUseResult: !!(message as any).tool_use_result
          });

          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            const hasToolResult = content.some((b: any) => b.type === "tool_result");
            if (hasToolResult) {
              activeSession.toolRunning = false;
              activeSession.currentToolId = undefined;
              log.info("Tool finished", { sessionKey: session.sessionKey });

              // Check if there are pending messages - interrupt to process them
              if (activeSession.messageQueue.length > 0 && !activeSession.interrupted) {
                log.info("Tool finished, interrupting for pending messages", {
                  sessionKey: session.sessionKey,
                  queueSize: activeSession.messageQueue.length
                });
                activeSession.interrupted = true;
                await queryResult.interrupt();
                log.info("Interrupt completed, breaking loop", { sessionKey: session.sessionKey });
                break;
              } else if (activeSession.messageQueue.length > 0 && activeSession.interrupted) {
                log.info("Already interrupted, waiting for loop to end", { sessionKey: session.sessionKey });
              }
            }
          }
        }

        if (message.type === "result") {
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
          log.info("Result", { inputTokens, outputTokens, sessionId: message.session_id });

          if ("session_id" in message && message.session_id) {
            updateSdkSessionId(session.sessionKey, message.session_id);
          }

          updateTokens(session.sessionKey, inputTokens, outputTokens);
        }
      }
    } finally {
      log.info("processPrompt finally block", { sessionKey: session.sessionKey });

      // Get pending messages before cleaning up
      const pendingMessages = [...activeSession.messageQueue];
      this.activeSessions.delete(session.sessionKey);

      // Process all pending messages in order
      if (pendingMessages.length > 0) {
        log.info("Processing pending messages", {
          sessionKey: session.sessionKey,
          count: pendingMessages.length
        });

        for (const queued of pendingMessages) {
          log.info("Processing queued message", {
            sessionKey: session.sessionKey,
            prompt: queued.prompt.prompt.slice(0, 50)
          });
          try {
            await this.processNewPrompt(session.sessionKey, {
              prompt: queued.prompt.prompt,
              source: queued.source
            });
          } catch (err) {
            log.error("Failed to process queued message", { sessionKey: session.sessionKey, error: err });
          }
        }
      }
    }

    return {
      response: responseText.trim(),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}

import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { notif } from "./notif.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";
import { buildSystemPrompt, SILENT_TOKEN } from "./prompt-builder.js";
import { getPluginPromptSections } from "./plugins/extensions.js";
import {
  loadRouterConfig,
  getOrCreateSession,
  getSessionByName,
  updateSdkSessionId,
  updateTokens,
  updateSessionName,
  updateSessionSource,
  updateSessionContext,
  updateSessionDisplayName,
  closeRouterDb,
  deleteSession,
  expandHome,
  getAnnounceCompaction,
  generateSessionName,
  ensureUniqueName,
  type RouterConfig,
  type SessionEntry,
  type AgentConfig,
} from "./router/index.js";
import { runWithContext } from "./cli/context.js";
import { HEARTBEAT_OK } from "./heartbeat/index.js";
import { createBashPermissionHook } from "./bash/index.js";
import { createPreCompactHook } from "./hooks/index.js";
import { getToolSafety } from "./hooks/tool-safety.js";
import { ALL_BUILTIN_TOOLS } from "./constants.js";
import { discoverPlugins } from "./plugins/index.js";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  isMentioned?: boolean;
  botTag?: string;
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
  botTag?: string;
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
  /** Flag: SDK returned "Prompt is too long" — session needs reset */
  _promptTooLong?: boolean;
  /** Whether the SDK is currently compacting (don't interrupt during compaction) */
  compacting: boolean;
  /** Tool safety classification — "safe" tools can be interrupted, "unsafe" cannot */
  currentToolSafety: "safe" | "unsafe" | null;
  /** Pending abort — set when abort is requested during an unsafe tool call */
  pendingAbort: boolean;
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

/** Pending approval waiting for a reaction or reply */
interface PendingApproval {
  resolve: (result: { approved: boolean; reason?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Only this senderId can approve/reject (if set) */
  allowedSenderId?: string;
}

/** Pending poll question waiting for a vote or text reply */
interface PendingPollQuestion {
  resolve: (result: { selectedLabels: string[] } | { freeText: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Only this senderId can answer (if set) */
  allowedSenderId?: string;
  /** Poll option labels for mapping votes back */
  optionLabels: string[];
}

/**
 * In-process reply callbacks for replyTopic.
 * Used by gateway to resolve send results without SSE round-trip.
 */
export const pendingReplyCallbacks = new Map<string, (data: { messageId?: string }) => void>();

export class RaviBot {
  private config: Config;
  private routerConfig: RouterConfig;
  private running = false;
  private streamingSessions = new Map<string, StreamingSession>();
  private debounceStates = new Map<string, DebounceState>();
  private promptSubscriptionActive = false;
  /** Pending approvals keyed by outbound messageId */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Pending poll questions keyed by poll messageId */
  private pendingPollQuestions = new Map<string, PendingPollQuestion>();
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  /** Subscriber health: incremented on every prompt received */
  private promptsReceived = 0;
  /** Subscriber health: watchdog timer */
  private subscriberHealthTimer: ReturnType<typeof setInterval> | null = null;

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
    this.subscribeToInboundReplies();
    this.subscribeToInboundPollVotes();
    this.subscribeToSessionAborts();
    this.startSubscriberHealthCheck();
    log.info("Ravi bot started", {
      pid: process.pid,
      instanceId: this.instanceId,
      agents: Object.keys(this.routerConfig.agents),
    });
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    // Stop subscriber health check
    if (this.subscriberHealthTimer) {
      clearInterval(this.subscriberHealthTimer);
      this.subscriberHealthTimer = null;
    }

    // Abort ALL streaming sessions
    if (this.streamingSessions.size > 0) {
      log.info("Aborting streaming sessions", {
        count: this.streamingSessions.size,
        sessions: [...this.streamingSessions.keys()],
      });
      for (const [sessionName, session] of this.streamingSessions) {
        log.info("Aborting streaming session", { sessionName });
        session.abortController.abort();
      }
      this.streamingSessions.clear();
    }

    // Cancel all pending approvals
    if (this.pendingApprovals.size > 0) {
      log.info("Cancelling pending approvals", { count: this.pendingApprovals.size });
      for (const [messageId, approval] of this.pendingApprovals) {
        clearTimeout(approval.timer);
        approval.resolve({ approved: false, reason: "Bot shutting down." });
      }
      this.pendingApprovals.clear();
    }

    // Cancel all pending poll questions
    if (this.pendingPollQuestions.size > 0) {
      log.info("Cancelling pending poll questions", { count: this.pendingPollQuestions.size });
      for (const [, pending] of this.pendingPollQuestions) {
        clearTimeout(pending.timer);
        pending.resolve({ freeText: "Bot shutting down." });
      }
      this.pendingPollQuestions.clear();
    }

    closeDb();
    closeRouterDb();
    log.info("Ravi bot stopped");
  }

  /**
   * Abort and remove a streaming session by key.
   * Used by /reset to kill the SDK process before deleting the DB entry.
   */
  /** Abort a streaming session by name. Used by /reset.
   *  If an unsafe tool is running, defers the abort until the tool completes. */
  public abortSession(sessionName: string): boolean {
    const allNames = [...this.streamingSessions.keys()];
    log.info("abortSession called", {
      sessionName,
      allNames,
      found: this.streamingSessions.has(sessionName),
    });
    const session = this.streamingSessions.get(sessionName);
    if (!session) return false;

    // If an unsafe tool is running, defer the abort
    if (session.toolRunning && session.currentToolSafety === "unsafe") {
      log.info("Deferring abort — unsafe tool running", {
        sessionName,
        tool: session.currentToolName,
      });
      session.pendingAbort = true;
      return true;
    }

    log.info("Aborting streaming session", { sessionName, done: session.done });
    session.abortController.abort();
    this.streamingSessions.delete(sessionName);
    return true;
  }

  /**
   * Listen for inbound reactions and resolve pending approvals.
   */
  private async subscribeToInboundReactions(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of notif.subscribe("ravi.inbound.reaction")) {
          if (!this.running) break;
          const data = event.data as {
            targetMessageId: string;
            emoji: string;
            senderId: string;
          };

          const pending = this.pendingApprovals.get(data.targetMessageId);
          if (!pending) continue;

          // Only the session owner can approve/reject
          if (pending.allowedSenderId && data.senderId !== pending.allowedSenderId) {
            log.info("Ignoring reaction from non-owner", {
              targetMessageId: data.targetMessageId,
              senderId: data.senderId,
              expected: pending.allowedSenderId,
            });
            continue;
          }

          const approved = data.emoji === "👍" || data.emoji === "❤️" || data.emoji === "❤";
          log.info("Approval reaction received", {
            targetMessageId: data.targetMessageId,
            emoji: data.emoji,
            approved,
            senderId: data.senderId,
          });

          clearTimeout(pending.timer);
          this.pendingApprovals.delete(data.targetMessageId);
          pending.resolve({ approved });
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Reaction subscription error, reconnecting in 2s", { error: err });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Listen for inbound replies and resolve pending approvals as rejections.
   */
  private async subscribeToInboundReplies(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of notif.subscribe("ravi.inbound.reply")) {
          if (!this.running) break;
          const data = event.data as {
            targetMessageId: string;
            text: string;
            senderId: string;
          };

          // Check pending approvals
          const pending = this.pendingApprovals.get(data.targetMessageId);
          if (pending) {
            // Only the session owner can reject
            if (pending.allowedSenderId && data.senderId !== pending.allowedSenderId) {
              log.info("Ignoring reply from non-owner", {
                targetMessageId: data.targetMessageId,
                senderId: data.senderId,
                expected: pending.allowedSenderId,
              });
              continue;
            }

            log.info("Approval reply received (rejection)", {
              targetMessageId: data.targetMessageId,
              text: data.text,
              senderId: data.senderId,
            });

            clearTimeout(pending.timer);
            this.pendingApprovals.delete(data.targetMessageId);
            pending.resolve({ approved: false, reason: data.text });
            continue;
          }

          // Check pending poll questions (text reply = free text answer)
          const pendingPoll = this.pendingPollQuestions.get(data.targetMessageId);
          if (pendingPoll) {
            if (pendingPoll.allowedSenderId && data.senderId !== pendingPoll.allowedSenderId) {
              continue;
            }

            log.info("Poll question answered via text reply", {
              pollMessageId: data.targetMessageId,
              text: data.text,
              senderId: data.senderId,
            });

            clearTimeout(pendingPoll.timer);
            this.pendingPollQuestions.delete(data.targetMessageId);
            pendingPoll.resolve({ freeText: data.text });
          }
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Reply subscription error, reconnecting in 2s", { error: err });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Listen for inbound poll votes and resolve pending poll questions.
   */
  private async subscribeToInboundPollVotes(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of notif.subscribe("ravi.inbound.pollVote")) {
          if (!this.running) break;
          const data = event.data as {
            pollMessageId: string;
            votes: Array<{ name: string; voters: string[] }>;
          };

          const pending = this.pendingPollQuestions.get(data.pollMessageId);
          if (!pending) continue;

          // Find which options got votes (from any voter — in DMs there's only one)
          const selected = data.votes
            .filter(v => v.voters.length > 0)
            .map(v => v.name);

          if (selected.length === 0) continue; // vote retracted, keep waiting

          log.info("Poll vote received for pending question", {
            pollMessageId: data.pollMessageId,
            selected,
          });

          clearTimeout(pending.timer);
          this.pendingPollQuestions.delete(data.pollMessageId);
          pending.resolve({ selectedLabels: selected });
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Poll vote subscription error, reconnecting in 2s", { error: err });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Listen for session abort events (from /reset slash command).
   * Kills the streaming SDK process so it doesn't compact or respond after reset.
   */
  private async subscribeToSessionAborts(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of notif.subscribe("ravi.session.abort")) {
          if (!this.running) break;
          const data = event.data as { sessionKey?: string; sessionName?: string };
          // Try session name first (streaming sessions are keyed by name), then DB key
          const key = data.sessionName ?? data.sessionKey;
          if (!key) continue;
          const aborted = this.abortSession(key);
          log.info("Session abort request", { key, aborted });
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Session abort subscription error, reconnecting in 2s", { error: err });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Send a message to WhatsApp and wait for a reaction (👍) or reply (rejection).
   * Returns { approved, reason } — reason is the reply text if rejected.
   */
  private async requestApproval(
    source: MessageTarget,
    text: string,
    options?: { timeoutMs?: number; allowedSenderId?: string }
  ): Promise<{ approved: boolean; reason?: string }> {
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000; // 5 minutes
    // Use in-process callback to capture messageId (avoids SSE round-trip race condition)
    const replyTopic = `ravi.approval.reply.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    const sendResultPromise = new Promise<{ messageId?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        pendingReplyCallbacks.delete(replyTopic);
        resolve({});
      }, 5000);
      pendingReplyCallbacks.set(replyTopic, (data) => {
        clearTimeout(timeout);
        pendingReplyCallbacks.delete(replyTopic);
        resolve(data);
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
      log.warn("Failed to get messageId for approval message — rejecting by default");
      return { approved: false, reason: "Falha ao enviar mensagem de aprovação." };
    }

    log.info("Waiting for approval reaction or reply", { messageId: sendResult.messageId });

    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(sendResult.messageId!);
        log.warn("Approval timed out", { messageId: sendResult.messageId });
        resolve({ approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." });
      }, timeoutMs);

      this.pendingApprovals.set(sendResult.messageId!, { resolve, timer, allowedSenderId: options?.allowedSenderId });
    });
  }

  /**
   * Send a WhatsApp poll and wait for a vote or text reply.
   * Returns selected option labels or free text.
   */
  private async requestPollAnswer(
    source: MessageTarget,
    pollName: string,
    optionLabels: string[],
    options?: { timeoutMs?: number; allowedSenderId?: string; selectableCount?: number }
  ): Promise<{ selectedLabels: string[] } | { freeText: string }> {
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
    const replyTopic = `ravi.poll.reply.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    const sendResultPromise = new Promise<{ messageId?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        pendingReplyCallbacks.delete(replyTopic);
        resolve({});
      }, 5000);
      pendingReplyCallbacks.set(replyTopic, (data) => {
        clearTimeout(timeout);
        pendingReplyCallbacks.delete(replyTopic);
        resolve(data);
      });
    });

    await notif.emit("ravi.outbound.deliver", {
      channel: source.channel,
      accountId: source.accountId,
      to: source.chatId,
      poll: {
        name: pollName,
        values: optionLabels,
        selectableCount: options?.selectableCount ?? 1,
      },
      replyTopic,
    });

    const sendResult = await sendResultPromise;

    if (!sendResult.messageId) {
      log.warn("Failed to get messageId for poll — falling back to free text");
      return { freeText: "Failed to send poll." };
    }

    log.info("Poll sent, waiting for vote or reply", { messageId: sendResult.messageId, optionLabels });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPollQuestions.delete(sendResult.messageId!);
        log.warn("Poll answer timed out", { messageId: sendResult.messageId });
        resolve({ freeText: "Timeout — nenhuma resposta." });
      }, timeoutMs);

      this.pendingPollQuestions.set(sendResult.messageId!, {
        resolve,
        timer,
        allowedSenderId: options?.allowedSenderId,
        optionLabels,
      });
    });
  }

  /**
   * Periodic health check for the prompt subscriber.
   * If subscriber died without reconnecting, force a resubscribe.
   */
  private startSubscriberHealthCheck(): void {
    const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
    this.subscriberHealthTimer = setInterval(() => {
      if (!this.running) return;

      if (!this.promptSubscriptionActive) {
        log.warn("Subscriber health check: prompt subscription INACTIVE — forcing resubscribe", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.streamingSessions.size,
        });
        this.subscribeToPrompts();
      } else {
        log.debug("Subscriber health check: OK", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.streamingSessions.size,
        });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async subscribeToPrompts(): Promise<void> {
    if (this.promptSubscriptionActive) {
      log.warn("Prompt subscription already active, skipping duplicate");
      return;
    }
    this.promptSubscriptionActive = true;

    const topic = "ravi.session.*.prompt";
    log.info(`Subscribing to ${topic}`);

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        this.promptsReceived++;

        // Extract session name from topic: ravi.session.{name}.prompt
        const sessionName = event.topic.split(".")[2];
        const prompt = event.data as unknown as PromptMessage;

        // Don't await - handle concurrently
        this.handlePrompt(sessionName, prompt).catch(err => {
          log.error("Failed to handle prompt", err);
        });
      }
    } catch (err) {
      log.error("Prompt subscription error — will reconnect", { error: err });
    } finally {
      this.promptSubscriptionActive = false;
      log.warn("Prompt subscription ended", { running: this.running, promptsReceived: this.promptsReceived });
      if (this.running) {
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    }
  }

  private async handlePrompt(sessionName: string, prompt: PromptMessage): Promise<void> {
    // Reload config to get latest settings
    this.routerConfig = loadRouterConfig();

    // Look up session by name to get agentId
    // _agentId from heartbeat overrides DB (fixes race condition)
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];
    const debounceMs = agent?.debounceMs;
    log.debug("handlePrompt", { sessionName, agentId, debounceMs });

    // If debounce is configured, use debounce flow
    if (debounceMs && debounceMs > 0) {
      this.handlePromptWithDebounce(sessionName, prompt, debounceMs);
      return;
    }

    // No debounce - use immediate flow
    await this.handlePromptImmediate(sessionName, prompt);
  }

  private handlePromptWithDebounce(sessionName: string, prompt: PromptMessage, debounceMs: number): void {
    const existing = this.debounceStates.get(sessionName);

    if (existing) {
      log.debug("Debounce: adding message", { sessionName, count: existing.messages.length + 1 });
      clearTimeout(existing.timer);
      existing.messages.push({ prompt, source: prompt.source });
      existing.timer = setTimeout(() => this.flushDebounce(sessionName), debounceMs);
    } else {
      log.debug("Debounce: starting", { sessionName, debounceMs });
      const state: DebounceState = {
        messages: [{ prompt, source: prompt.source }],
        timer: setTimeout(() => this.flushDebounce(sessionName), debounceMs),
        debounceMs,
      };
      this.debounceStates.set(sessionName, state);
    }
  }

  private async flushDebounce(sessionName: string): Promise<void> {
    const state = this.debounceStates.get(sessionName);
    if (!state) return;

    this.debounceStates.delete(sessionName);

    // Combine all messages into one
    const combinedPrompt = state.messages.map(m => m.prompt.prompt).join("\n\n");
    const lastSource = state.messages[state.messages.length - 1].source;

    log.info("Debounce: flushing", { sessionName, messageCount: state.messages.length });

    // Process the combined message
    await this.handlePromptImmediate(sessionName, {
      prompt: combinedPrompt,
      source: lastSource,
    });
  }

  private async handlePromptImmediate(sessionName: string, prompt: PromptMessage): Promise<void> {
    const existing = this.streamingSessions.get(sessionName);

    if (existing && !existing.done) {
      // Session alive — just push the new message into the generator
      log.info("Streaming: pushing message to existing session", { sessionName });
      // Resolve DB primary key for metadata updates
      const entry = getSessionByName(sessionName);
      if (entry) {
        this.updateSessionMetadata(entry.sessionKey, prompt);
      }
      saveMessage(sessionName, "user", prompt.prompt);

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
        log.info("Streaming: waking generator", { sessionName, queueSize: existing.pendingMessages.length });
        const resolver = existing.pushMessage;
        existing.pushMessage = null;
        resolver(null); // wake-up signal
      } else if (existing.toolRunning || existing.compacting) {
        // Tool running or compacting — just enqueue, don't interrupt
        log.info("Streaming: queueing (busy)", {
          sessionName,
          queueSize: existing.pendingMessages.length,
          reason: existing.compacting ? "compacting" : "tool",
          tool: existing.currentToolName,
        });
      } else {
        // SDK generating text — interrupt, discard response, re-process with full queue
        log.info("Streaming: interrupting turn", {
          sessionName,
          queueSize: existing.pendingMessages.length,
        });
        existing.interrupted = true;
        existing.queryHandle.interrupt().catch(() => {});
      }
      return;
    }

    // No active session or previous one finished — start new streaming session
    if (existing?.done) {
      this.streamingSessions.delete(sessionName);
    }
    await this.startStreamingSession(sessionName, prompt);
  }

  /** Start a new streaming session with an AsyncGenerator that stays alive */
  private async startStreamingSession(sessionName: string, prompt: PromptMessage): Promise<void> {
    // Look up agent from DB by session name
    // _agentId from heartbeat/cross-session overrides DB value (fixes race where bot
    // creates session with default agent before the runner's session is committed)
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];

    if (!agent) {
      log.error("No agent found", { sessionName, agentId });
      return;
    }

    const agentCwd = expandHome(agent.cwd);

    // Ensure .claude/settings.json exists with PermissionRequest auto-approve hook.
    // Subagents (teams/tasks) inherit settings from the project dir but NOT
    // programmatic hooks, so this file is required for headless operation.
    const settingsPath = join(agentCwd, ".claude", "settings.json");
    if (!existsSync(settingsPath)) {
      mkdirSync(join(agentCwd, ".claude"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        PermissionRequest: [{
          matcher: "*",
          hooks: [{ type: "command", command: "echo '{\"decision\":\"allow\"}'", timeout: 5 }],
        }],
      }, null, 2));
      log.info("Created auto-approve settings for agent", { agentId: agent.id, path: settingsPath });
    }

    // Session should already exist (created by resolver/CLI/heartbeat).
    // If not (e.g. direct notif emit), create one using the name as both key and name.
    // If session exists but agent_id is wrong, getOrCreateSession with same key fixes it.
    let session: SessionEntry;
    if (sessionEntry && sessionEntry.agentId !== agentId) {
      // Fix agent_id mismatch (e.g. heartbeat created session with wrong agent)
      session = getOrCreateSession(sessionEntry.sessionKey, agentId, agentCwd);
    } else {
      session = sessionEntry ?? getOrCreateSession(sessionName, agentId, agentCwd, { name: sessionName });
    }
    const dbSessionKey = session.sessionKey; // actual DB primary key
    log.info("startStreamingSession", {
      sessionName,
      dbSessionKey,
      sdkSessionId: session.sdkSessionId,
      willResume: !!session.sdkSessionId,
    });

    // Resolve source for response routing
    let resolvedSource = prompt.source;
    if (!resolvedSource && session.lastChannel && session.lastTo) {
      resolvedSource = {
        channel: session.lastChannel,
        accountId: session.lastAccountId ?? "default",
        chatId: session.lastTo,
      };
    }

    this.updateSessionMetadata(dbSessionKey, prompt);
    saveMessage(sessionName, "user", prompt.prompt);

    const model = session.modelOverride ?? agent.model ?? this.config.model;

    // Build permission options
    // Use bypassPermissions so subagents (teams/tasks) inherit skip-all-permissions.
    // canUseTool callback still intercepts ExitPlanMode for reaction-based approval.
    let permissionOptions: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
    };
    if (agent.allowedTools) {
      const disallowed = ALL_BUILTIN_TOOLS.filter(t => !agent.allowedTools!.includes(t));
      permissionOptions = { ...permissionOptions, disallowedTools: disallowed, allowedTools: agent.allowedTools };
    }

    // Build system prompt (with plugin-injected sections)
    const pluginSections = await getPluginPromptSections(dbSessionKey, prompt.context);
    let systemPromptAppend = buildSystemPrompt(agent.id, prompt.context, pluginSections.length > 0 ? pluginSections : undefined);
    if (prompt._outboundSystemContext) {
      systemPromptAppend += "\n\n" + prompt._outboundSystemContext;
    }

    // Build hooks (SDK expects HookCallbackMatcher[] per event)
    const hooks: Record<string, Array<{ hooks: Array<(...args: any[]) => any> }>> = {};
    if (agent.bashConfig || agent.allowedTools) {
      hooks.PreToolUse = [{ hooks: [createBashPermissionHook({
        getBashConfig: () => agent.bashConfig,
        getAllowedTools: () => agent.allowedTools,
      })] }];
    }

    // Auto-approve all permission requests for subagents (teams/tasks).
    // The parent process uses canUseTool callback which isn't inherited by
    // subagent child processes. This hook ensures they don't hang waiting
    // for interactive approval in headless daemon mode.
    hooks.PermissionRequest = [{ hooks: [async () => ({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest" as const,
        decision: { behavior: "allow" as const },
      },
    })] }];
    const preCompactHook = createPreCompactHook({ memoryModel: agent.memoryModel });
    hooks.PreCompact = [{ hooks: [async (input, toolUseId, context) => {
      log.info("PreCompact hook CALLED by SDK", {
        sessionName,
        agentId: agent.id,
        inputKeys: Object.keys(input),
        hookEventName: (input as any).hook_event_name,
      });
      return preCompactHook(input as any, toolUseId ?? null, context as any);
    }] }];

    // PreToolUse hook for ExitPlanMode — request approval via WhatsApp reaction.
    // With bypassPermissions the canUseTool callback is NOT called, but hooks still fire.
    const exitPlanHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> = async (input) => {
      if (!resolvedSource) {
        log.info("ExitPlanMode auto-approved (no channel source)", { sessionName });
        return {};
      }

      log.info("ExitPlanMode hook: requesting approval via reaction", { sessionName });

      // The plan content lives in the plan file written by the SDK.
      // tool_input may have a "plan" field or we can read the plan file directly.
      let planText = "";
      const toolInput = input.tool_input as Record<string, unknown> | undefined;

      // Try to read the plan file from the agent's cwd
      try {
        const { readFileSync } = await import("node:fs");
        const { globSync } = await import("node:fs");
        const planDir = join(agentCwd, ".claude", "plans");
        // Find most recently modified plan file
        const files = await import("node:fs").then(fs => {
          try {
            return fs.readdirSync(planDir)
              .filter((f: string) => f.endsWith(".md"))
              .map((f: string) => ({ name: f, mtime: fs.statSync(join(planDir, f)).mtimeMs }))
              .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
          } catch { return []; }
        });
        if (files.length > 0) {
          planText = readFileSync(join(planDir, files[0].name), "utf-8");
        }
      } catch {
        // Fallback: use tool_input fields
      }

      // Fallback to tool_input if we couldn't read the file
      if (!planText && toolInput) {
        if (typeof toolInput.plan === "string") {
          planText = toolInput.plan;
        } else {
          // Strip internal fields, show only meaningful content
          const { allowedPrompts, pushToRemote, remoteSessionId, remoteSessionTitle, remoteSessionUrl, ...rest } = toolInput;
          planText = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "(plano vazio)";
        }
      }

      if (!planText) planText = "(plano vazio)";

      const approvalText = `📋 *Plano pendente*\n\n${planText}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;

      const result = await this.requestApproval(resolvedSource, approvalText, {
        allowedSenderId: prompt.context?.senderId,
      });

      if (result.approved) {
        log.info("Plan approved via reaction (hook)", { sessionName });
        return {};
      }

      const reason = result.reason
        ? `Plano rejeitado: ${result.reason}`
        : "Plano rejeitado pelo usuário.";
      log.info("Plan rejected (hook)", { sessionName, reason: result.reason });

      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };

    // PreToolUse hook for AskUserQuestion — send WhatsApp poll and wait for answer.
    const askUserQuestionHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> = async (input) => {
      if (!resolvedSource) {
        log.info("AskUserQuestion auto-approved (no channel source)", { sessionName });
        return {};
      }

      const toolInput = input.tool_input as Record<string, unknown> | undefined;
      const questions = toolInput?.questions as Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }> | undefined;

      if (!questions || questions.length === 0) {
        return {};
      }

      log.info("AskUserQuestion hook: sending polls", { sessionName, questionCount: questions.length });

      const answers: Record<string, string> = {};

      for (const q of questions) {
        const optionLabels = q.options.map(o => o.label);

        // Build poll title with option descriptions (polls only support option names, no description field)
        const hasDescriptions = q.options.some(o => o.description);
        let pollName = q.question;
        if (hasDescriptions) {
          const descLines = q.options.map(o => `• ${o.label} — ${o.description}`).join("\n");
          pollName += "\n\n" + descLines;
        }
        pollName += "\n(responda a mensagem para outro)";

        const result = await this.requestPollAnswer(
          resolvedSource,
          pollName,
          optionLabels,
          {
            allowedSenderId: prompt.context?.senderId,
            selectableCount: q.multiSelect ? optionLabels.length : 1,
          }
        );

        if ("selectedLabels" in result) {
          answers[q.question] = result.selectedLabels.join(", ");
        } else {
          answers[q.question] = result.freeText;
        }
      }

      log.info("AskUserQuestion answers collected", { sessionName, answers });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    // Append hooks to PreToolUse
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      { matcher: "ExitPlanMode", hooks: [exitPlanHook] },
      { matcher: "AskUserQuestion", hooks: [askUserQuestionHook] },
    ];

    log.info("Hooks registered", {
      sessionName,
      hookEvents: Object.keys(hooks),
    });

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
      compacting: false,
      onTurnComplete: null,
      currentToolSafety: null,
      pendingAbort: false,
    };
    this.streamingSessions.set(sessionName, streamingSession);

    // Create the AsyncGenerator that feeds messages to the SDK
    const messageGenerator = this.createMessageGenerator(sessionName, prompt.prompt, streamingSession);

    const runId = Math.random().toString(36).slice(2, 8);
    log.info("Starting streaming session", {
      runId,
      sessionName,
      agentId: agent.id,
      sdkSessionId: session.sdkSessionId ?? null,
      resuming: !!session.sdkSessionId,
    });

    // Build RAVI_* env vars for session context (available in Bash tools)
    const raviEnv: Record<string, string> = {
      RAVI_SESSION_KEY: dbSessionKey,
      RAVI_SESSION_NAME: sessionName,
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

    // Build canUseTool — auto-approve all tools.
    // Note: with bypassPermissions, canUseTool is NOT called. We use PreToolUse hooks instead.
    const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      if (toolName !== "ExitPlanMode") {
        return { behavior: "allow" as const, updatedInput: input };
      }

      // ExitPlanMode: request approval via WhatsApp reaction
      if (!resolvedSource) {
        // No channel to send approval request — auto-approve
        log.info("ExitPlanMode auto-approved (no channel source)", { sessionName });
        return { behavior: "allow" as const, updatedInput: input };
      }

      log.info("ExitPlanMode called, requesting approval via reaction", { sessionName });

      const plan = typeof input.plan === "string" ? input.plan : JSON.stringify(input);
      const approvalText = `📋 *Plano pendente*\n\n${plan}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;

      const result = await this.requestApproval(resolvedSource, approvalText, {
        allowedSenderId: prompt.context?.senderId,
      });

      if (result.approved) {
        log.info("Plan approved via reaction", { sessionName });
        return { behavior: "allow" as const, updatedInput: input };
      } else {
        const reason = result.reason
          ? `Plano rejeitado: ${result.reason}`
          : "Plano rejeitado pelo usuário.";
        log.info("Plan rejected", { sessionName, reason: result.reason });
        return { behavior: "deny" as const, message: reason };
      }
    };

    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model,
        cwd: agentCwd,
        resume: session.sdkSessionId,
        abortController,
        ...permissionOptions,
        canUseTool,
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
      sessionKey: sessionName,
      agentId: agent.id,
      source: resolvedSource,
    };

    // Run the event loop in the background (don't await — it stays alive)
    runWithContext(toolContext, () =>
      this.runEventLoop(runId, sessionName, session, agent, streamingSession, queryResult)
    ).catch(err => {
      const isAbort = err instanceof Error && /abort/i.test(err.message);
      if (isAbort) {
        log.info("Streaming session aborted", { sessionName });
      } else {
        log.error("Streaming session failed", { sessionName, error: err });
      }
    });
  }

  /** AsyncGenerator that yields user messages. Stays alive between turns. */
  private async *createMessageGenerator(
    sessionName: string,
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
        sessionName, count: yieldedCount,
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
          sessionName, count: session.pendingMessages.length,
        });
        session.interrupted = false;
      } else {
        // Turn completed normally — remove only the messages that were yielded
        // New messages that arrived during the turn (e.g. during tool execution) stay
        session.pendingMessages.splice(0, yieldedCount);
        log.info("Generator: turn complete", {
          sessionName, cleared: yieldedCount, remaining: session.pendingMessages.length,
        });
      }
    }
  }

  /** Process SDK events from the streaming query */
  private async runEventLoop(
    runId: string,
    sessionName: string,
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
        log.warn("Streaming session idle timeout", { sessionName, elapsedMs: elapsed });
        streaming.done = true;
        if (streaming.pushMessage) {
          streaming.pushMessage(null as any);
          streaming.pushMessage = null;
        }
        streaming.abortController.abort();
        this.streamingSessions.delete(sessionName);
        clearInterval(watchdog);
      }
    }, 30000);

    let sdkEventCount = 0;
    let responseText = "";

    const emitSdkEvent = async (event: Record<string, unknown>) => {
      await safeEmit(`ravi.session.${sessionName}.claude`, event);
    };

    const emitResponse = async (text: string) => {
      const emitId = Math.random().toString(36).slice(2, 8);
      log.info("Emitting response", { sessionName, emitId, textLen: text.length });
      await notif.emit(`ravi.session.${sessionName}.response`, {
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
          sessionName,
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

        // Track compaction status — block interrupts while compacting
        if (message.type === "system" && (message as any).subtype === "status") {
          const status = (message as any).status;
          const wasCompacting = streaming.compacting;
          streaming.compacting = status === "compacting";
          log.info("Compaction status", { sessionName, compacting: streaming.compacting });

          if (getAnnounceCompaction() && streaming.currentSource) {
            if (streaming.compacting && !wasCompacting) {
              emitResponse("🧠 Compactando memória... um momento.").catch(() => {});
            } else if (!streaming.compacting && wasCompacting) {
              emitResponse("🧠 Memória compactada. Pronto pra continuar.").catch(() => {});
            }
          }
        }

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
              streaming.currentToolSafety = getToolSafety(block.name, block.input as Record<string, unknown>);

              safeEmit(`ravi.session.${sessionName}.tool`, {
                event: "start",
                toolId: block.id,
                toolName: block.name,
                safety: streaming.currentToolSafety,
                input: truncateOutput(block.input),
                timestamp: new Date().toISOString(),
                sessionName,
                agentId: agent.id,
              }).catch(err => log.warn("Failed to emit tool start", { error: err }));
            }
          }
          if (messageText) {
            // Strip @@SILENT@@ from anywhere in the text and trim
            messageText = messageText.replace(new RegExp(SILENT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g"), "").trim();
            log.info("Assistant message", { runId, interrupted: streaming.interrupted, text: messageText.slice(0, 100) });

            if (streaming.interrupted) {
              // Turn was interrupted — discard response
              log.info("Discarding interrupted response", { sessionName, textLen: messageText.length });
            } else if (!messageText) {
              // After stripping SILENT_TOKEN, nothing left
              log.info("Silent response (stripped)", { sessionName });
              await emitSdkEvent({ type: "silent" });
            } else {
              responseText += messageText;

              const trimmed = messageText.trim().toLowerCase();
              if (trimmed === "prompt is too long") {
                log.warn("Prompt too long — will auto-reset session", { sessionName });
                streaming._promptTooLong = true;
                await emitSdkEvent({ type: "silent" });
              } else if (messageText.trim().endsWith(HEARTBEAT_OK)) {
                log.info("Heartbeat OK", { sessionName });
                await emitSdkEvent({ type: "silent" });
              } else if (trimmed === "no response requested." || trimmed === "no response requested" || trimmed === "no response needed." || trimmed === "no response needed") {
                log.info("Silent response (no response requested)", { sessionName });
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

              safeEmit(`ravi.session.${sessionName}.tool`, {
                event: "end",
                toolId: streaming.currentToolId ?? toolResult?.tool_use_id ?? "unknown",
                toolName: streaming.currentToolName ?? "unknown",
                output: truncateOutput(toolResult?.content),
                isError: toolResult?.is_error ?? false,
                durationMs,
                timestamp: new Date().toISOString(),
                sessionName,
                agentId: agent.id,
              }).catch(err => log.warn("Failed to emit tool end", { error: err }));

              streaming.toolRunning = false;
              streaming.currentToolId = undefined;
              streaming.currentToolName = undefined;
              streaming.toolStartTime = undefined;
              streaming.currentToolSafety = null;

              // Execute deferred abort now that unsafe tool has completed
              if (streaming.pendingAbort) {
                log.info("Executing deferred abort after unsafe tool completed", { sessionName });
                streaming.abortController.abort();
                this.streamingSessions.delete(sessionName);
              }
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
            updateSdkSessionId(session.sessionKey, message.session_id);
          }
          updateTokens(session.sessionKey, inputTokens, outputTokens);

          // Auto-reset session when prompt is too long (compact failed)
          if (streaming._promptTooLong) {
            log.warn("Auto-resetting session due to 'Prompt is too long'", { sessionName });
            deleteSession(session.sessionKey);
            streaming._promptTooLong = false;

            // Notify the user that the session was reset
            if (streaming.currentSource) {
              notif.emit("ravi.outbound.deliver", {
                channel: streaming.currentSource.channel,
                accountId: streaming.currentSource.accountId,
                to: streaming.currentSource.chatId,
                text: "⚠️ Sessão resetada (contexto estourou). Pode mandar de novo.",
              }).catch(err => log.warn("Failed to notify session reset", { error: err }));
            }

            // Abort the streaming session so next message creates a fresh one
            streaming.abortController.abort();
          }

          if (!streaming.interrupted && responseText.trim()) {
            saveMessage(sessionName, "assistant", responseText.trim());
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
      log.info("Streaming session ended", { runId, sessionName });
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

      this.streamingSessions.delete(sessionName);
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

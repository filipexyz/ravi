import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { nats } from "./nats.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, backfillSdkSessionId, close as closeDb } from "./db.js";
import { buildSystemPrompt, SILENT_TOKEN } from "./prompt-builder.js";
import {
  getOrCreateSession,
  getSession,
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
  dbGetSetting,
  dbListSettings,
  type SessionEntry,
  type AgentConfig,
} from "./router/index.js";
import { configStore } from "./config-store.js";
import { runWithContext } from "./cli/context.js";
import { HEARTBEAT_OK } from "./heartbeat/index.js";
import { createBashPermissionHook, createToolPermissionHook } from "./bash/index.js";
import { createPreCompactHook } from "./hooks/index.js";
import { createSanitizeBashHook } from "./hooks/sanitize-bash.js";
import { createSpecServer, isSpecModeActive, getSpecState } from "./spec/server.js";
import { getToolSafety } from "./hooks/tool-safety.js";
import { discoverPlugins } from "./plugins/index.js";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_PAYLOAD_BYTES = 60000; // keep payloads reasonable
const MAX_CONCURRENT_SESSIONS = 8;

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

/** Emit to NATS, truncating payload if it exceeds the size limit */
async function safeEmit(topic: string, data: Record<string, unknown>): Promise<void> {
  let json = JSON.stringify(data);
  if (json.length <= MAX_PAYLOAD_BYTES) {
    await nats.emit(topic, data);
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
  if (json.length > MAX_PAYLOAD_BYTES) {
    // Still too big - emit minimal event
    await nats.emit(topic, { _truncated: true, type: (data as any).type ?? (data as any).event ?? "unknown" });
    return;
  }
  await nats.emit(topic, truncated);
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
  /** Approval routing: channel to send approval requests when agent has no direct channel */
  _approvalSource?: MessageTarget;
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
  /** Agent mode (e.g. "sentinel") — controls compaction announcements and system commands */
  agentMode?: string;
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

/** Pending session start request — queued when concurrency limit is reached */
interface PendingStart {
  sessionName: string;
  prompt: PromptMessage;
  resolve: () => void;
}

/** Pending approval waiting for a reaction or reply */
interface PendingApproval {
  resolve: (result: { approved: boolean; reason?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pending poll question waiting for a vote or text reply */
interface PendingPollQuestion {
  resolve: (result: { selectedLabels: string[] } | { freeText: string }) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private running = false;
  private streamingSessions = new Map<string, StreamingSession>();
  private debounceStates = new Map<string, DebounceState>();
  private promptSubscriptionActive = false;
  /** Pending approvals keyed by outbound messageId */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Pending poll questions keyed by poll messageId */
  private pendingPollQuestions = new Map<string, PendingPollQuestion>();
  /** Queued session starts waiting for a concurrency slot */
  private pendingStarts: PendingStart[] = [];
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  /** Subscriber health: incremented on every prompt received */
  private promptsReceived = 0;
  /** Subscriber health: watchdog timer */
  private subscriberHealthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RaviBotOptions) {
    this.config = options.config;
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
      agents: Object.keys(configStore.getConfig().agents),
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

    // Clear pending session start queue
    if (this.pendingStarts.length > 0) {
      log.info("Clearing pending session starts", { count: this.pendingStarts.length });
      this.pendingStarts.length = 0;
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
        for await (const event of nats.subscribe("ravi.inbound.reaction")) {
          if (!this.running) break;
          const data = event.data as {
            targetMessageId: string;
            emoji: string;
            senderId: string;
          };

          const pending = this.pendingApprovals.get(data.targetMessageId);
          if (!pending) continue;

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
        for await (const event of nats.subscribe("ravi.inbound.reply")) {
          if (!this.running) break;
          const data = event.data as {
            targetMessageId: string;
            text: string;
            senderId: string;
          };

          // Check pending approvals
          const pending = this.pendingApprovals.get(data.targetMessageId);
          if (pending) {
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
        for await (const event of nats.subscribe("ravi.inbound.pollVote")) {
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
        for await (const event of nats.subscribe("ravi.session.abort")) {
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
    options?: { timeoutMs?: number }
  ): Promise<{ approved: boolean; reason?: string }> {
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000; // 5 minutes
    // Use in-process callback to capture messageId (avoids SSE round-trip race condition)
    const replyTopic = `ravi.approval.reply.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    const sendResultPromise = new Promise<{ messageId?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        pendingReplyCallbacks.delete(replyTopic);
        resolve({});
      }, 5 * 60 * 1000);
      pendingReplyCallbacks.set(replyTopic, (data) => {
        clearTimeout(timeout);
        pendingReplyCallbacks.delete(replyTopic);
        resolve(data);
      });
    });

    await nats.emit("ravi.outbound.deliver", {
      channel: source.channel,
      accountId: source.accountId,
      to: source.chatId,
      text,
      replyTopic,
    });

    const sendResult = await sendResultPromise;

    if (!sendResult.messageId) {
      log.warn("Failed to get messageId for approval/poll message (send timeout)");
      return { approved: false, reason: "Falha ao enviar mensagem de aprovação." };
    }

    log.info("Waiting for approval reaction or reply", { messageId: sendResult.messageId });

    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(sendResult.messageId!);
        log.warn("Approval timed out", { messageId: sendResult.messageId });
        resolve({ approved: false, reason: "Timeout — nenhuma resposta em 5 minutos." });
      }, timeoutMs);

      this.pendingApprovals.set(sendResult.messageId!, { resolve, timer });
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
    options?: { timeoutMs?: number; selectableCount?: number }
  ): Promise<{ selectedLabels: string[] } | { freeText: string }> {
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
    const replyTopic = `ravi.poll.reply.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;

    const sendResultPromise = new Promise<{ messageId?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        pendingReplyCallbacks.delete(replyTopic);
        resolve({});
      }, 5 * 60 * 1000);
      pendingReplyCallbacks.set(replyTopic, (data) => {
        clearTimeout(timeout);
        pendingReplyCallbacks.delete(replyTopic);
        resolve(data);
      });
    });

    await nats.emit("ravi.outbound.deliver", {
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
        optionLabels,
      });
    });
  }

  /**
   * Request approval via cascading: uses resolvedSource (direct) or approvalSource (delegated).
   * Emits ravi.approval.request/response events for audit trail.
   */
  private async requestCascadingApproval(opts: {
    resolvedSource?: MessageTarget;
    approvalSource?: MessageTarget;
    type: "plan" | "spec";
    sessionName: string;
    agentId: string;
    text: string;
  }): Promise<{ approved: boolean; reason?: string; isDelegated: boolean }> {
    const targetSource = opts.resolvedSource ?? opts.approvalSource;
    if (!targetSource) {
      log.info(`${opts.type} auto-approved (no source available)`, { sessionName: opts.sessionName });
      return { approved: true, isDelegated: false };
    }

    const isDelegated = !opts.resolvedSource && !!opts.approvalSource;
    log.info(`${opts.type} approval requested`, { sessionName: opts.sessionName, isDelegated });

    nats.emit("ravi.approval.request", {
      type: opts.type,
      sessionName: opts.sessionName,
      agentId: opts.agentId,
      delegated: isDelegated,
      channel: targetSource.channel,
      chatId: targetSource.chatId,
      timestamp: Date.now(),
    }).catch(() => {});

    const label = opts.type === "plan" ? "Plano pendente" : "Spec pendente";
    const approvalText = isDelegated
      ? `📋 *${label}* (de _${opts.agentId}_)\n\n${opts.text}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`
      : `📋 *${label}*\n\n${opts.text}\n\n_Reaja com 👍 ou ❤️ pra aprovar, ou responda pra rejeitar._`;

    const result = await this.requestApproval(targetSource, approvalText);

    nats.emit("ravi.approval.response", {
      type: opts.type,
      sessionName: opts.sessionName,
      agentId: opts.agentId,
      approved: result.approved,
      reason: result.reason,
      timestamp: Date.now(),
    }).catch(() => {});

    return { ...result, isDelegated };
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
      for await (const event of nats.subscribe(topic)) {
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
    const routerConfig = configStore.getConfig();

    // Look up session by name to get agentId
    // _agentId from heartbeat overrides DB (fixes race condition)
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

    // Use group-specific debounce when available and session is a group
    const isGroup = sessionEntry?.chatType === "group" || sessionName.includes(":group:");
    const debounceMs = (isGroup && agent?.groupDebounceMs) ? agent.groupDebounceMs : agent?.debounceMs;
    log.debug("handlePrompt", { sessionName, agentId, debounceMs, isGroup });

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
      saveMessage(sessionName, "user", prompt.prompt, entry?.sdkSessionId);

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
    // Check concurrency limit — queue if at capacity
    if (this.streamingSessions.size >= MAX_CONCURRENT_SESSIONS) {
      log.warn("Session start queued — concurrency limit reached", {
        sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length + 1,
        max: MAX_CONCURRENT_SESSIONS,
      });
      await new Promise<void>((resolve) => {
        this.pendingStarts.push({ sessionName, prompt, resolve });
      });
      log.info("Pending session start resumed", {
        sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length,
        max: MAX_CONCURRENT_SESSIONS,
      });
    }

    // Look up agent from DB by session name
    // _agentId from heartbeat/cross-session overrides DB value (fixes race where bot
    // creates session with default agent before the runner's session is committed)
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

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
    // If not (e.g. direct NATS publish), create one using the name as both key and name.
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
        accountId: session.lastAccountId ?? "",
        chatId: session.lastTo,
      };
    }

    // Approval source for cascading approvals (from delegating agent's channel)
    const approvalSource = prompt._approvalSource;

    this.updateSessionMetadata(dbSessionKey, prompt);
    saveMessage(sessionName, "user", prompt.prompt, session.sdkSessionId);

    const model = session.modelOverride ?? agent.model ?? this.config.model;

    // Build permission options
    // Use bypassPermissions so subagents (teams/tasks) inherit skip-all-permissions.
    // canUseTool callback still intercepts ExitPlanMode for reaction-based approval.
    // SDK tool permissions are enforced dynamically via PreToolUse hook (not disallowedTools)
    // so permission changes take effect immediately without session restart.
    const permissionOptions: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
    };

    // Build system prompt
    let systemPromptAppend = buildSystemPrompt(agent.id, prompt.context, undefined, sessionName, { agentMode: agent.mode });
    if (prompt._outboundSystemContext) {
      systemPromptAppend += "\n\n" + prompt._outboundSystemContext;
    }

    // Build hooks (SDK expects HookCallbackMatcher[] per event)
    const hooks: Record<string, Array<{ hooks: Array<(...args: any[]) => any> }>> = {};
    const hookOpts = { getAgentId: () => agent.id };
    hooks.PreToolUse = [
      createToolPermissionHook(hookOpts),   // SDK tools (dynamic REBAC)
      createBashPermissionHook(hookOpts),    // Bash executables
      createSanitizeBashHook(),              // Strip secrets from Bash env
    ];

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
    // Supports cascading approvals: if agent has no channel, uses _approvalSource from delegating agent.
    const exitPlanHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> = async (input) => {
      // Extract plan text from plan file or tool_input
      let planText = "";
      const toolInput = input.tool_input as Record<string, unknown> | undefined;

      try {
        const { readFileSync, readdirSync, statSync } = await import("node:fs");
        const planDir = join(agentCwd, ".claude", "plans");
        const files = (() => {
          try {
            return readdirSync(planDir)
              .filter((f: string) => f.endsWith(".md"))
              .map((f: string) => ({ name: f, mtime: statSync(join(planDir, f)).mtimeMs }))
              .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
          } catch { return []; }
        })();
        if (files.length > 0) {
          planText = readFileSync(join(planDir, files[0].name), "utf-8");
        }
      } catch { /* fallback below */ }

      if (!planText && toolInput) {
        if (typeof toolInput.plan === "string") {
          planText = toolInput.plan;
        } else {
          const { allowedPrompts, pushToRemote, remoteSessionId, remoteSessionTitle, remoteSessionUrl, ...rest } = toolInput;
          planText = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "(plano vazio)";
        }
      }
      if (!planText) planText = "(plano vazio)";

      const result = await this.requestCascadingApproval({
        resolvedSource, approvalSource, type: "plan",
        sessionName, agentId: agent.id, text: planText,
      });

      if (result.approved) return {};

      const reason = result.reason ? `Plano rejeitado: ${result.reason}` : "Plano rejeitado pelo usuário.";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };

    // PreToolUse hook for AskUserQuestion — send WhatsApp poll and wait for answer.
    // Supports cascading approvals via _approvalSource.
    const askUserQuestionHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> = async (input) => {
      const targetSource = resolvedSource ?? approvalSource;
      if (!targetSource) {
        log.info("AskUserQuestion auto-approved (no source available)", { sessionName });
        return {};
      }

      const isDelegated = !resolvedSource && !!approvalSource;

      const toolInput = input.tool_input as Record<string, unknown> | undefined;
      const questions = toolInput?.questions as Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }> | undefined;

      if (!questions || questions.length === 0) return {};

      log.info("AskUserQuestion hook: sending polls", { sessionName, questionCount: questions.length, isDelegated });

      nats.emit("ravi.approval.request", {
        type: "question", sessionName, agentId: agent.id, delegated: isDelegated,
        channel: targetSource.channel, chatId: targetSource.chatId,
        questionCount: questions.length, timestamp: Date.now(),
      }).catch(() => {});

      const answers: Record<string, string> = {};

      for (const q of questions) {
        const optionLabels = q.options.map(o => o.label);
        const hasDescriptions = q.options.some(o => o.description);
        let pollName = isDelegated ? `[${agent.id}] ${q.question}` : q.question;
        if (hasDescriptions) {
          const descLines = q.options.map(o => `• ${o.label} — ${o.description}`).join("\n");
          pollName += "\n\n" + descLines;
        }
        pollName += "\n(responda a mensagem para outro)";

        const result = await this.requestPollAnswer(targetSource, pollName, optionLabels, {
          selectableCount: q.multiSelect ? optionLabels.length : 1,
        });

        if ("selectedLabels" in result) {
          answers[q.question] = result.selectedLabels.join(", ");
        } else {
          answers[q.question] = result.freeText;
        }
      }

      nats.emit("ravi.approval.response", {
        type: "question", sessionName, agentId: agent.id,
        approved: true, answers, timestamp: Date.now(),
      }).catch(() => {});

      log.info("AskUserQuestion answers collected", { sessionName, answers, isDelegated });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    // Spec mode hooks
    const specBlockHook = async (input: any) => {
      if (!isSpecModeActive(sessionName)) return {};

      const toolName = input.tool_name;
      const BLOCKED_IN_SPEC = ["Edit", "Write", "Bash", "NotebookEdit", "Skill", "Task"];

      // Allow spec tools themselves
      if (typeof toolName === "string" && toolName.startsWith("mcp__spec__")) return {};

      if (BLOCKED_IN_SPEC.includes(toolName)) {
        log.info("Spec mode blocked tool", { sessionName, toolName });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Spec mode ativo. Colete informações e complete a spec antes de implementar. Use Read, Glob, Grep, WebFetch para explorar.",
          },
        };
      }
      return {};
    };

    // Supports cascading approvals via _approvalSource.
    const exitSpecHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> = async (input) => {
      const spec = (input.tool_input as Record<string, unknown> | undefined)?.spec as string | undefined;
      if (!spec) return {};

      const result = await this.requestCascadingApproval({
        resolvedSource, approvalSource, type: "spec",
        sessionName, agentId: agent.id, text: spec,
      });

      if (result.approved) {
        const state = getSpecState(sessionName);
        if (state) state.active = false;
        return {};
      }

      const reason = result.reason ? `Spec rejeitada: ${result.reason}` : "Spec rejeitada pelo usuário.";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };

    // Append hooks to PreToolUse
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      { hooks: [specBlockHook] },
      { matcher: "mcp__spec__exit_spec_mode", hooks: [exitSpecHook] },
      { matcher: "ExitPlanMode", hooks: [exitPlanHook] },
      { matcher: "AskUserQuestion", hooks: [askUserQuestionHook] },
    ];

    log.info("Hooks registered", {
      sessionName,
      hookEvents: Object.keys(hooks),
    });

    // Create spec mode MCP server for this session (only if agent has specMode enabled)
    const specServer = agent.specMode ? createSpecServer(sessionName, agentCwd) : null;

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
      agentMode: agent.mode,
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
    } else if (prompt.context?.accountId) {
      // Sentinel inbound: no source but context carries accountId from gateway
      raviEnv.RAVI_ACCOUNT_ID = prompt.context.accountId;
      if (prompt.context.channelId) raviEnv.RAVI_CHANNEL = prompt.context.channelId;
    } else if (agent.mode === "sentinel") {
      // Sentinel heartbeat/cross-send: resolve accountId from settings mapping
      // Settings format: account.<accountId>.agent = <agentId>
      // Common case: accountId = agentId (e.g., account.luis.agent = luis)
      if (dbGetSetting(`account.${agent.id}.agent`) === agent.id) {
        raviEnv.RAVI_ACCOUNT_ID = agent.id;
      } else {
        // Reverse lookup when accountId ≠ agentId
        const allSettings = dbListSettings();
        for (const [key, value] of Object.entries(allSettings)) {
          if (key.startsWith("account.") && key.endsWith(".agent") && value === agent.id) {
            raviEnv.RAVI_ACCOUNT_ID = key.slice("account.".length, -".agent".length);
            break;
          }
        }
      }
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

    // canUseTool — auto-approve all tools.
    // Note: with bypassPermissions, canUseTool is NOT called. We use PreToolUse hooks instead.
    const canUseTool = async (_toolName: string, input: Record<string, unknown>) => {
      return { behavior: "allow" as const, updatedInput: input };
    };

    // Note: Spec MCP tools are not affected by REBAC tool permissions.
    // The PreToolUse hook only checks SDK_TOOLS, so MCP tools pass through.

    // Fork: new thread session → copy context from parent session
    let forkFromSdkId: string | undefined;
    if (!session.sdkSessionId && dbSessionKey.includes(":thread:")) {
      const parentKey = dbSessionKey.replace(/:thread:.*$/, "");
      const parentSession = getSession(parentKey);
      if (parentSession?.sdkSessionId) {
        forkFromSdkId = parentSession.sdkSessionId;
        log.info("Forking thread session from parent", {
          threadKey: dbSessionKey, parentKey,
          parentSdkId: forkFromSdkId,
        });
      }
    }

    const queryResult = query({
      prompt: messageGenerator,
      options: {
        model,
        cwd: agentCwd,
        resume: forkFromSdkId ?? session.sdkSessionId,
        ...(forkFromSdkId ? { forkSession: true } : {}),
        abortController,
        ...permissionOptions,
        canUseTool,
        includePartialMessages: true,
        env: { ...process.env, ...raviEnv, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
        ...(specServer ? { mcpServers: { spec: specServer } } : {}),
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
      await nats.emit(`ravi.session.${sessionName}.response`, {
        response: text,
        target: streaming.agentMode === "sentinel" ? undefined : streaming.currentSource,
        _emitId: emitId,
        _instanceId: this.instanceId,
        _pid: process.pid,
        _v: 2,
      });
    };

    const emitChunk = async (text: string) => {
      await safeEmit(`ravi.session.${sessionName}.stream`, {
        chunk: text,
      });
    };

    try {
      for await (const message of queryResult) {
        sdkEventCount++;
        streaming.lastActivity = Date.now();

        // Log SDK events (stream_event is debug-level to avoid noise)
        const logLevel = message.type === "stream_event" ? "debug" : "info";
        log[logLevel]("SDK event", {
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

        // Stream text deltas to TUI — skip emitSdkEvent for stream events (noisy, not needed)
        if (message.type === "stream_event") {
          const evt = (message as any).event;
          if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
            await emitChunk(evt.delta.text);
          }
          continue;
        }

        // Emit all SDK events for typing heartbeat etc.
        await emitSdkEvent(message as unknown as Record<string, unknown>);

        // Track compaction status — block interrupts while compacting
        if (message.type === "system" && (message as any).subtype === "status") {
          const status = (message as any).status;
          const wasCompacting = streaming.compacting;
          streaming.compacting = status === "compacting";
          log.info("Compaction status", { sessionName, compacting: streaming.compacting });

          if (getAnnounceCompaction() && streaming.currentSource && streaming.agentMode !== "sentinel") {
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
            backfillSdkSessionId(sessionName, message.session_id);
          }
          updateTokens(session.sessionKey, inputTokens, outputTokens);

          // Auto-reset session when prompt is too long (compact failed)
          if (streaming._promptTooLong) {
            log.warn("Auto-resetting session due to 'Prompt is too long'", { sessionName });
            deleteSession(session.sessionKey);
            streaming._promptTooLong = false;

            // Notify the user that the session was reset (skip for sentinel)
            if (streaming.currentSource && streaming.agentMode !== "sentinel") {
              nats.emit("ravi.outbound.deliver", {
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
            const sdkId = ("session_id" in message && message.session_id) ? message.session_id : undefined;
            saveMessage(sessionName, "assistant", responseText.trim(), sdkId);
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
      this.drainPendingStarts();
    }
  }

  /** Dequeue and start the next pending session if a slot is available */
  private drainPendingStarts(): void {
    if (this.pendingStarts.length > 0 && this.streamingSessions.size < MAX_CONCURRENT_SESSIONS) {
      const next = this.pendingStarts.shift()!;
      log.info("Dequeuing pending session start", {
        sessionName: next.sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length,
        max: MAX_CONCURRENT_SESSIONS,
      });
      next.resolve();
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

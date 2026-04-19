import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { close as closeDb } from "./db.js";
import { closeRouterDb } from "./router/index.js";
import { configStore } from "./config-store.js";
import type { RuntimeControlNatsRequest } from "./runtime/control-host.js";
import type { RuntimeHostStreamingSession } from "./runtime/host-session.js";
import type { PromptMessage } from "./runtime/message-types.js";
import { RuntimeHostSubscriptions } from "./runtime/host-subscriptions.js";
import { RuntimePromptSubscription } from "./runtime/prompt-subscription.js";
import { safeEmit } from "./runtime/safe-emit.js";
import { RuntimeSessionDispatcher } from "./runtime/session-dispatcher.js";

export type {
  ChannelContext,
  MessageContext,
  MessageTarget,
  PromptMessage,
  ResponseMessage,
} from "./runtime/message-types.js";

const log = logger.child("bot");

const MAX_CONCURRENT_SESSIONS = 30;

type StreamingSession = RuntimeHostStreamingSession;

export interface RaviBotOptions {
  config: Config;
}

export class RaviBot {
  private config: Config;
  private running = false;
  private readonly sessionDispatcher: RuntimeSessionDispatcher;
  private readonly hostSubscriptions: RuntimeHostSubscriptions;
  private readonly promptSubscription: RuntimePromptSubscription;
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  /** Resolves when the JetStream consumer is active and ready to receive messages */
  readonly consumerReady: Promise<void>;
  private resolveConsumerReady!: () => void;
  private consumerReadyResolved = false;

  constructor(options: RaviBotOptions) {
    this.consumerReady = new Promise<void>((resolve) => {
      this.resolveConsumerReady = resolve;
    });
    this.config = options.config;
    logger.setLevel(options.config.logLevel);
    this.sessionDispatcher = new RuntimeSessionDispatcher({
      instanceId: this.instanceId,
      maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
      safeEmit,
      getConfigModel: () => this.config.model,
    });
    this.hostSubscriptions = new RuntimeHostSubscriptions({
      isRunning: () => this.running,
      dispatcher: this.sessionDispatcher,
      safeEmit,
    });
    this.promptSubscription = new RuntimePromptSubscription({
      isRunning: () => this.running,
      getStreamingSessionCount: () => this.streamingSessions.size,
      markConsumerReady: () => this.markConsumerReady(),
      handlePrompt: (sessionName, prompt) => this.handlePrompt(sessionName, prompt),
    });
  }

  private get streamingSessions(): Map<string, StreamingSession> {
    return this.sessionDispatcher.streamingSessions;
  }

  private get deferredAfterTaskStarts() {
    return this.sessionDispatcher.deferredAfterTaskStarts;
  }

  private markConsumerReady(): void {
    if (this.consumerReadyResolved) return;
    this.consumerReadyResolved = true;
    this.resolveConsumerReady();
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...", { pid: process.pid, instanceId: this.instanceId });
    this.running = true;
    this.promptSubscription.subscribe();
    this.hostSubscriptions.startAll();
    this.promptSubscription.startHealthCheck();
    void this.recoverActiveTasksAfterRestart();
    log.info("Ravi bot started", {
      pid: process.pid,
      instanceId: this.instanceId,
      agents: Object.keys(configStore.getConfig().agents),
    });
  }

  private async recoverActiveTasksAfterRestart(): Promise<void> {
    try {
      const { recoverActiveTasksAfterRestart } = await import("./tasks/service.js");
      const recovery = await recoverActiveTasksAfterRestart();
      if (recovery.recoveredTaskIds.length === 0 && recovery.skipped.length === 0) {
        return;
      }
      log.info("Recovered active tasks after restart", {
        recovered: recovery.recoveredTaskIds,
        skipped: recovery.skipped,
      });
    } catch (error) {
      log.error("Failed to recover active tasks after restart", { error });
    }
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    this.promptSubscription.stopHealthCheck();

    this.sessionDispatcher.shutdownAll();

    closeDb();
    closeRouterDb();
    log.info("Ravi bot stopped");
  }

  /** Abort a streaming session by name. If an unsafe tool is running, defers until the tool completes. */
  public abortSession(sessionName: string): boolean {
    return this.sessionDispatcher.abortSession(sessionName);
  }

  private async handleRuntimeControlRequest(data: RuntimeControlNatsRequest): Promise<void> {
    await this.hostSubscriptions.handleRuntimeControlRequest(data);
  }

  private async applySessionModelChange(
    sessionName: string,
    model: string,
  ): Promise<"missing" | "unchanged" | "applied" | "restart-next-turn"> {
    return this.sessionDispatcher.applySessionModelChange(sessionName, model);
  }

  private async startDeferredAfterTaskSessionIfDeliverable(sessionName: string): Promise<void> {
    await this.sessionDispatcher.startDeferredAfterTaskSessionIfDeliverable(sessionName);
  }

  private wakeStreamingSessionIfDeliverable(sessionName: string): void {
    this.sessionDispatcher.wakeStreamingSessionIfDeliverable(sessionName);
  }

  private async handlePrompt(sessionName: string, prompt: PromptMessage): Promise<void> {
    await this.sessionDispatcher.handlePrompt(sessionName, prompt);
  }

  private async handlePromptImmediate(sessionName: string, prompt: PromptMessage): Promise<void> {
    await this.sessionDispatcher.handlePromptImmediate(sessionName, prompt);
  }
}

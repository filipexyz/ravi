import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { close as closeDb } from "./db.js";
import { closeRouterDb } from "./router/index.js";
import { configStore } from "./config-store.js";
import type { RuntimeControlNatsRequest } from "./runtime/control-host.js";
import {
  RuntimeCrashRecoveryCoordinator,
  type RuntimeCrashRecoveryOwnershipLostError,
} from "./runtime/crash-recovery.js";
import type { RuntimeHostStreamingSession } from "./runtime/host-session.js";
import type { PromptMessage } from "./runtime/message-types.js";
import { RuntimeHostSubscriptions } from "./runtime/host-subscriptions.js";
import { RuntimePromptSubscription } from "./runtime/prompt-subscription.js";
import { notifyRuntimeRecoveryExhausted } from "./runtime/runtime-recovery-alert.js";
import { safeEmit } from "./runtime/safe-emit.js";
import { RuntimeSessionDispatcher, type RuntimeAbortProvenance } from "./runtime/session-dispatcher.js";
import { resolveRuntimeInteractiveReservedSlots, resolveRuntimeSessionPoolMax } from "./runtime/session-pool.js";

export type {
  ChannelContext,
  MessageContext,
  MessageTarget,
  PromptMessage,
  ResponseMessage,
} from "./runtime/message-types.js";

const log = logger.child("bot");

type StreamingSession = RuntimeHostStreamingSession;

export interface RaviBotOptions {
  config: Config;
}

export interface RaviBotStopOptions {
  restart?: {
    restartEpoch: string;
    reason: string;
  };
}

export class RaviBot {
  private config: Config;
  private running = false;
  private stopping = false;
  private readonly sessionDispatcher: RuntimeSessionDispatcher;
  private readonly crashRecovery: RuntimeCrashRecoveryCoordinator;
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
    const maxConcurrentSessions = resolveRuntimeSessionPoolMax();
    const interactiveReservedSessions = resolveRuntimeInteractiveReservedSlots(undefined, maxConcurrentSessions);
    this.crashRecovery = new RuntimeCrashRecoveryCoordinator({
      instanceId: this.instanceId,
      bootMetadata: { component: "runtime-host" },
      onOwnershipLost: (error) => this.handleCrashRecoveryOwnershipLost(error),
    });
    this.sessionDispatcher = new RuntimeSessionDispatcher({
      instanceId: this.instanceId,
      maxConcurrentSessions,
      interactiveReservedSessions,
      safeEmit,
      notifyRuntimeRecoveryExhausted: async (input) => {
        await notifyRuntimeRecoveryExhausted(input);
      },
      getConfigModel: () => this.config.model,
      crashRecovery: this.crashRecovery,
    });
    this.hostSubscriptions = new RuntimeHostSubscriptions({
      isRunning: () => this.running,
      dispatcher: this.sessionDispatcher,
      safeEmit,
    });
    this.promptSubscription = new RuntimePromptSubscription({
      isRunning: () => this.running,
      canAcceptPrompt: () => this.crashRecovery.acceptingDeliveries,
      getStreamingSessionCount: () => this.streamingSessions.size,
      getRuntimeSessionPoolSnapshot: () => this.sessionDispatcher.getRuntimeSessionPoolSnapshot(),
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

  private handleCrashRecoveryOwnershipLost(error: RuntimeCrashRecoveryOwnershipLostError): void {
    log.error("Runtime crash recovery ownership lost; fencing prompt intake", {
      instanceId: this.instanceId,
      error,
    });
    this.running = false;
    this.promptSubscription.stopHealthCheck();
    if (this.stopping) {
      // stop() already owns a full dispatcher sweep. Re-entering shutdownAll
      // from a terminal ledger failure would interrupt the same provider twice
      // and could clear the map underneath the outer sweep.
      return;
    }
    try {
      // Per-attempt ownership callbacks run before this host callback and
      // detach their ledger bindings. Dispatcher shutdown can therefore close
      // providers without attempting a stale terminal write.
      this.sessionDispatcher.shutdownAll();
    } catch (shutdownError) {
      log.error("Failed to close runtime sessions after crash recovery ownership loss", {
        instanceId: this.instanceId,
        error: shutdownError,
      });
    }
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...", { pid: process.pid, instanceId: this.instanceId });
    this.crashRecovery.start();
    this.running = true;
    this.promptSubscription.subscribe();
    this.hostSubscriptions.startAll();
    this.promptSubscription.startHealthCheck();
    log.info("Ravi bot started", {
      pid: process.pid,
      instanceId: this.instanceId,
      agents: Object.keys(configStore.getConfig().agents),
    });
  }

  async stop(options: RaviBotStopOptions = {}): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    this.promptSubscription.stopHealthCheck();

    const ownershipFailureBeforeStop = this.crashRecovery.ownershipFailure;
    this.stopping = true;
    let shutdownError: unknown;
    if (options.restart) {
      try {
        this.sessionDispatcher.recordDaemonRestartSnapshot({
          restartEpoch: options.restart.restartEpoch,
          reason: options.restart.reason,
          stoppedAt: Date.now(),
        });
      } catch (error) {
        shutdownError = error;
        log.error("Failed to persist daemon restart recovery snapshot", { error });
      }
    }

    try {
      this.sessionDispatcher.shutdownAll();
    } catch (error) {
      shutdownError ??= error;
      log.error("Failed to shut down all runtime sessions", { error });
    }
    try {
      if (this.crashRecovery.boot?.status === "active" && !this.crashRecovery.ownershipFailure) {
        this.crashRecovery.stopGracefully(options.restart ? `daemon_restart:${options.restart.reason}` : "daemon_stop");
      }
      const ownershipFailureDuringStop = this.crashRecovery.ownershipFailure;
      if (!ownershipFailureBeforeStop && ownershipFailureDuringStop) {
        // Dispatcher terminalization deliberately continues provider cleanup
        // after a fence loss. Preserve that ownership failure for stop()'s
        // caller instead of silently treating the shutdown as graceful.
        shutdownError ??= ownershipFailureDuringStop;
      }
    } catch (error) {
      shutdownError ??= error;
      log.error("Failed to persist graceful runtime boot shutdown", { error });
    } finally {
      this.stopping = false;
      try {
        closeDb();
      } catch (error) {
        shutdownError ??= error;
        log.error("Failed to close primary database during shutdown", { error });
      }
      try {
        closeRouterDb();
      } catch (error) {
        shutdownError ??= error;
        log.error("Failed to close router database during shutdown", { error });
      }
    }
    log.info("Ravi bot stopped");
    if (shutdownError) throw shutdownError;
  }

  /** Abort a streaming session by name. If an unsafe tool is running, defers until the tool completes. */
  public abortSession(sessionName: string, provenance?: RuntimeAbortProvenance): boolean {
    return this.sessionDispatcher.abortSession(sessionName, provenance);
  }

  public isRuntimeSessionActive(sessionName: string): boolean {
    const session = this.streamingSessions.get(sessionName);
    if (!session) return false;
    if (session.done) return false;
    return session.starting || session.turnActive || session.toolRunning || session.compacting;
  }

  public canAcceptRuntimePrompt(sessionName?: string): boolean {
    return this.sessionDispatcher.canAcceptRuntimePrompt(sessionName);
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

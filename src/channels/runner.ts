import { closeAllRaviDbs } from "../db/close-all.js";
import { closeNats, connectNats, getNats } from "../nats.js";
import { configStore } from "../config-store.js";
import { logger } from "../utils/logger.js";
import {
  startNativeInboundChannelActionResponder,
  type NativeInboundChannelActionResponder,
  type NativeInboundChannelActionResponderConnection,
} from "./inbound-actions.js";
import {
  startChannelRunnerHealthResponder,
  type ChannelAdapterHealth,
  type ChannelRunnerHealthResponder,
  type ChannelRunnerRuntimeStatus,
} from "./health.js";
import {
  NativeChannelDriverContractError,
  NativeChannelDriverManager,
  NativeChannelDriverRegistry,
  loadNativeChannelDriverModules,
  parseNativeChannelDriverModuleConfigs,
  type NativeChannelReconcileOptions,
  type NativeInboundChannelActionHandler,
  type NativeChannelDriverRuntime,
} from "./native/driver.js";
import type { NativeChatActionDelivery, NativePresenceDelivery, NativeTextDelivery } from "./native/types.js";
import { ChannelOutboundConsumer } from "./outbound-consumer.js";
import {
  ChannelOutboundPublishReconciler,
  CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS,
  getChannelOutboundPublishOutboxSummary,
  sqliteChannelOutboundPublishOutboxStore,
  type ChannelOutboundPublishOutboxStore,
  type ChannelOutboundPublishOutboxSummary,
} from "./outbound-publish-outbox.js";
import {
  CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS,
  type ChannelOutboundReceiptStore,
  sqliteChannelOutboundReceiptStore,
} from "./outbound-receipts.js";
import {
  CHANNEL_OUTBOUND_CONSUMER,
  CHANNEL_OUTBOUND_STREAM,
  ensureChannelOutboundInfrastructure,
} from "./outbound-stream.js";
import { ChannelPresenceConsumer } from "./presence-consumer.js";
import {
  startChannelBackendEgressResponder,
  type ChannelBackendEgressResponder,
  type ChannelBackendEgressResponderConnection,
} from "./backend-egress.js";
import { startChannelBackendPublicationReconciler } from "./backend.js";
import { createSlackNativeChannelDriver, slackNativeRuntimeHealth } from "./slack/driver.js";
import type { SlackSocketModeStatus } from "./slack/index.js";
import { canonicalChannelId } from "./capabilities.js";
import type { ChannelConfig } from "../router/router-db.js";
import { WHATSAPP_PROVIDER } from "./whatsapp/contract.js";
import { createWhatsAppChannelDriver, whatsappChannelBindingKey } from "./whatsapp/driver.js";

const log = logger.child("channels:runner");

export const CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const RAVI_CONFIG_CHANGED_SUBJECT = "ravi.config.changed" as const;
export const NATIVE_CHANNEL_RECONCILE_DEBOUNCE_MS = 250;
/** Safety net for a missed `ravi.config.changed` (failed channels are not retried by it). */
export const NATIVE_CHANNEL_RECONCILE_INTERVAL_MS = 60_000;
/**
 * Providers `ravi channels probe` never starts: the probe runs a second, short-lived
 * runner next to the real one, and a second WhatsApp socket for the same account
 * would replace the live session (Baileys 440 connectionReplaced).
 */
export const CHANNEL_PROBE_SKIPPED_PROVIDERS: readonly string[] = [WHATSAPP_PROVIDER];

/** Reconcile key for state a native channel depends on outside its `channels` row. */
export function nativeChannelBindingKey(
  config: Parameters<typeof whatsappChannelBindingKey>[0],
  channel: Pick<ChannelConfig, "name" | "provider">,
): string | undefined {
  return canonicalChannelId(channel.provider) === WHATSAPP_PROVIDER
    ? whatsappChannelBindingKey(config, channel.name)
    : undefined;
}

export interface NativeRuntimeSurfaces {
  deliveries: NativeTextDelivery[];
  actionDeliveries: NativeChatActionDelivery[];
  presenceDeliveries: NativePresenceDelivery[];
  inboundActionHandlers: NativeInboundChannelActionHandler[];
}

/**
 * Copy the manager's current surfaces into the runner's arrays IN PLACE: the
 * outbound/presence consumers and the inbound action responder hold these array
 * references, so reconciled runtimes become visible to them without a restart.
 */
export function syncNativeRuntimeSurfaces(
  target: NativeRuntimeSurfaces,
  source: Pick<
    NativeChannelDriverManager,
    "deliveries" | "actionDeliveries" | "presenceDeliveries" | "inboundActionHandlers"
  >,
): void {
  target.deliveries.splice(0, target.deliveries.length, ...source.deliveries());
  target.actionDeliveries.splice(0, target.actionDeliveries.length, ...source.actionDeliveries());
  target.presenceDeliveries.splice(0, target.presenceDeliveries.length, ...source.presenceDeliveries());
  target.inboundActionHandlers.splice(0, target.inboundActionHandlers.length, ...source.inboundActionHandlers());
}

export interface NativeChannelConfigWatchConnection {
  subscribe(subject: string): AsyncIterable<unknown> & { unsubscribe(): void };
}

export interface NativeChannelConfigWatch {
  stop(): Promise<void>;
}

/**
 * Run `reconcile` after every `ravi.config.changed` (debounced, coalesced: at most
 * one pass runs at a time and one more is queued) and on a slow interval.
 * Config-change passes retry failed channels; interval passes do not.
 */
export function startNativeChannelConfigWatch(options: {
  connection: NativeChannelConfigWatchConnection;
  reconcile: (options: NativeChannelReconcileOptions) => Promise<void>;
  debounceMs?: number;
  intervalMs?: number;
}): NativeChannelConfigWatch {
  const debounceMs = options.debounceMs ?? NATIVE_CHANNEL_RECONCILE_DEBOUNCE_MS;
  const intervalMs = options.intervalMs ?? NATIVE_CHANNEL_RECONCILE_INTERVAL_MS;
  const subscription = options.connection.subscribe(RAVI_CONFIG_CHANGED_SUBJECT);
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let queued = false;
  let retryFailed = false;

  const run = () => {
    debounce = null;
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = (async () => {
      do {
        queued = false;
        const retry = retryFailed;
        retryFailed = false;
        try {
          await options.reconcile({ retryFailed: retry });
        } catch (error) {
          log.warn("Native channel reconcile failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } while (queued && !stopped);
    })().finally(() => {
      running = null;
    });
  };
  const schedule = (retry: boolean) => {
    if (stopped) return;
    retryFailed ||= retry;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(run, debounceMs);
  };

  const loop = (async () => {
    for await (const _event of subscription) {
      if (stopped) break;
      schedule(true);
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      log.warn("Native channel config watch ended", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const interval = setInterval(() => schedule(false), intervalMs);
  interval.unref?.();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      debounce = null;
      try {
        subscription.unsubscribe();
      } catch {
        // Connection already closed.
      }
      await loop;
      await running;
    },
  };
}

export function collectNativeRuntimeDeliveries(
  runtimes: readonly Pick<NativeChannelDriverRuntime, "delivery" | "actions" | "presence">[],
): {
  deliveries: NativeTextDelivery[];
  actionDeliveries: NativeChatActionDelivery[];
  presenceDeliveries: NativePresenceDelivery[];
} {
  return {
    deliveries: runtimes.flatMap((runtime) => (runtime.delivery ? [runtime.delivery] : [])),
    actionDeliveries: runtimes.flatMap((runtime) => (runtime.actions ? [runtime.actions] : [])),
    presenceDeliveries: runtimes.flatMap((runtime) => (runtime.presence ? [runtime.presence] : [])),
  };
}

export function startChannelRunnerInboundActionResponder(options: {
  connection: NativeInboundChannelActionResponderConnection;
  handlers: readonly NativeInboundChannelActionHandler[];
  startResponder?: typeof startNativeInboundChannelActionResponder;
}): NativeInboundChannelActionResponder | null {
  if (options.handlers.length === 0) return null;
  return (options.startResponder ?? startNativeInboundChannelActionResponder)({
    connection: options.connection,
    handlers: options.handlers,
  });
}

export function startChannelRunnerBackendEgressResponder(options: {
  connection: ChannelBackendEgressResponderConnection;
  startResponder?: typeof startChannelBackendEgressResponder;
}): ChannelBackendEgressResponder {
  return (options.startResponder ?? startChannelBackendEgressResponder)({
    connection: options.connection,
  });
}

type ReceiptPruneTimer = ReturnType<typeof setInterval>;

export interface ChannelOutboundReceiptPrunerOptions {
  intervalMs?: number;
  now?: () => number;
  store?: Pick<ChannelOutboundReceiptStore, "pruneExpired">;
  publishOutboxStore?: Pick<ChannelOutboundPublishOutboxStore, "prunePublished">;
  setInterval?: (callback: () => void, intervalMs: number) => ReceiptPruneTimer;
  clearInterval?: (timer: ReceiptPruneTimer) => void;
}

export interface ChannelRunnerOptions {
  natsUrl?: string;
  consumeOutbound?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Foreground probe (`ravi channels probe`): skip CHANNEL_PROBE_SKIPPED_PROVIDERS
   * (WhatsApp sockets belong to the running runner) and do not watch config changes.
   */
  probe?: boolean;
}

export type ChannelRunnerStatus = ChannelRunnerRuntimeStatus;

type AdapterStatus = ChannelAdapterHealth;

export class ChannelRunner {
  private running = false;
  private startedAt: number | null = null;
  private outboundInfrastructureReady = false;
  private outboundPublishReconciler: ChannelOutboundPublishReconciler | null = null;
  private outboundConsumer: ChannelOutboundConsumer | null = null;
  private presenceConsumer: ChannelPresenceConsumer | null = null;
  private deliveries: NativeTextDelivery[] = [];
  private actionDeliveries: NativeChatActionDelivery[] = [];
  private presenceDeliveries: NativePresenceDelivery[] = [];
  private inboundActionHandlers: NativeInboundChannelActionHandler[] = [];
  private nativeChannelManager: NativeChannelDriverManager | null = null;
  private nativeChannelConfigWatch: NativeChannelConfigWatch | null = null;
  private inboundActionResponder: NativeInboundChannelActionResponder | null = null;
  private adapterStatuses = new Map<string, AdapterStatus>();
  private stopReceiptPruner: (() => void) | null = null;
  private healthResponder: ChannelRunnerHealthResponder | null = null;
  private backendEgressResponder: ChannelBackendEgressResponder | null = null;
  private stopBackendPublicationReconciler: (() => void) | null = null;

  constructor(private readonly options: ChannelRunnerOptions = {}) {}

  async start(): Promise<void> {
    if (this.running) {
      log.warn("Channel runner already started");
      return;
    }

    this.startedAt = null;
    this.outboundInfrastructureReady = false;
    this.adapterStatuses.clear();

    const env = this.options.env ?? process.env;
    await connectNats(this.options.natsUrl ?? env.NATS_URL ?? "nats://127.0.0.1:4222", {
      explicit: true,
      retry: true,
    });
    await configStore.startRefresh();
    await ensureChannelOutboundInfrastructure();
    runChannelOutboundLedgerMaintenance();
    this.stopReceiptPruner = startChannelOutboundReceiptPruner();

    this.outboundInfrastructureReady = true;
    this.running = true;
    this.startedAt = Date.now();
    this.healthResponder = startChannelRunnerHealthResponder({
      pid: process.pid,
      getStatus: () => this.status(),
      connection: getNats(),
    });

    await this.startNativeChannels(env);
    this.stopBackendPublicationReconciler = startChannelBackendPublicationReconciler();
    this.backendEgressResponder = startChannelRunnerBackendEgressResponder({
      connection: getNats(),
    });

    if (this.options.consumeOutbound !== false) {
      this.outboundPublishReconciler = new ChannelOutboundPublishReconciler({
        isRunning: () => this.running,
      });
      this.outboundPublishReconciler.start();

      this.outboundConsumer = new ChannelOutboundConsumer({
        deliveries: this.deliveries,
        actionDeliveries: this.actionDeliveries,
        isRunning: () => this.running,
      });
      this.outboundConsumer.start();

      this.presenceConsumer = new ChannelPresenceConsumer({
        deliveries: this.presenceDeliveries,
        isRunning: () => this.running,
      });
      this.presenceConsumer.start();
    }

    log.info("Channel runner started", {
      pid: process.pid,
      consumeOutbound: this.options.consumeOutbound !== false,
      outboundStream: CHANNEL_OUTBOUND_STREAM,
      outboundConsumer: CHANNEL_OUTBOUND_CONSUMER,
      adapters: this.status().adapters,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.healthResponder?.stop();
    this.healthResponder = null;
    this.stopReceiptPruner?.();
    this.stopReceiptPruner = null;
    this.stopBackendPublicationReconciler?.();
    this.stopBackendPublicationReconciler = null;
    log.info("Stopping channel runner", { pid: process.pid });
    await this.outboundPublishReconciler?.stop();
    this.outboundPublishReconciler = null;
    await this.outboundConsumer?.stop();
    this.outboundConsumer = null;
    await this.presenceConsumer?.stop();
    this.presenceConsumer = null;
    await this.backendEgressResponder?.stop();
    this.backendEgressResponder = null;
    await this.nativeChannelConfigWatch?.stop();
    this.nativeChannelConfigWatch = null;
    await this.inboundActionResponder?.stop();
    this.inboundActionResponder = null;
    await this.nativeChannelManager?.stop();
    this.nativeChannelManager = null;
    this.deliveries = [];
    this.actionDeliveries = [];
    this.presenceDeliveries = [];
    this.inboundActionHandlers = [];
    this.outboundInfrastructureReady = false;
    this.startedAt = null;
    configStore.stop();
    closeAllRaviDbs();
    await closeNats({ drainTimeoutMs: 2_000 });
    log.info("Channel runner stopped", { pid: process.pid });
  }

  status(): ChannelRunnerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      pid: process.pid,
      outbound: {
        stream: CHANNEL_OUTBOUND_STREAM,
        consumer: CHANNEL_OUTBOUND_CONSUMER,
        enabled: this.options.consumeOutbound !== false,
        infrastructureReady: this.outboundInfrastructureReady,
        consuming: this.outboundConsumer?.isConsuming() ?? false,
        publishOutbox: this.outboundPublishOutboxStatus(),
        ...this.outboundConsumer?.status(),
      },
      adapters: this.currentAdapterStatuses(),
    };
  }

  private async startNativeChannels(env: NodeJS.ProcessEnv): Promise<void> {
    const registry = new NativeChannelDriverRegistry();
    registry.register(createSlackNativeChannelDriver(env));
    registry.register(createWhatsAppChannelDriver());

    try {
      const moduleConfigs = parseNativeChannelDriverModuleConfigs(env.RAVI_NATIVE_CHANNEL_DRIVERS);
      const loaded = await loadNativeChannelDriverModules(moduleConfigs, registry);
      for (const failure of loaded.failures) {
        this.markAdapter(`native-driver:${failure.provider}`, failure.provider, "failed", failure.reason);
        log.warn("Native channel driver was not loaded", {
          provider: failure.provider,
          reason: failure.reason,
        });
      }
    } catch (error) {
      const reason = error instanceof NativeChannelDriverContractError ? error.reason : "invalid_driver_configuration";
      this.markAdapter("native-driver:configuration", "native", "failed", reason);
      log.warn("Native channel driver configuration was rejected", { reason });
    }

    this.nativeChannelManager = new NativeChannelDriverManager({
      channels: configStore.getConfig().channels ?? {},
      registry,
      bindingKey: (channel) => nativeChannelBindingKey(configStore.getConfig(), channel),
      ...(this.options.probe ? { skipProviders: CHANNEL_PROBE_SKIPPED_PROVIDERS } : {}),
    });
    await this.nativeChannelManager.start();
    await this.syncNativeSurfaces();

    if (!this.options.probe) {
      this.nativeChannelConfigWatch = startNativeChannelConfigWatch({
        connection: getNats(),
        reconcile: (options) => this.reconcileNativeChannels(options),
      });
    }
  }

  private async reconcileNativeChannels(options: NativeChannelReconcileOptions): Promise<void> {
    const manager = this.nativeChannelManager;
    if (!manager || !this.running) return;
    // configStore refreshes on the same event, but its subscription may not have run yet.
    configStore.refresh();
    const result = await manager.reconcile(configStore.getConfig().channels ?? {}, options);
    if (!this.running || this.nativeChannelManager !== manager) return;
    await this.syncNativeSurfaces();
    if (result.started.length > 0 || result.stopped.length > 0) {
      log.info("Native channels reconciled", {
        started: result.started,
        stopped: result.stopped,
        inactive: result.inactive,
      });
    }
  }

  private async syncNativeSurfaces(): Promise<void> {
    const manager = this.nativeChannelManager;
    if (!manager) return;
    syncNativeRuntimeSurfaces(
      {
        deliveries: this.deliveries,
        actionDeliveries: this.actionDeliveries,
        presenceDeliveries: this.presenceDeliveries,
        inboundActionHandlers: this.inboundActionHandlers,
      },
      manager,
    );
    if (this.inboundActionHandlers.length > 0 && !this.inboundActionResponder) {
      this.inboundActionResponder = startChannelRunnerInboundActionResponder({
        connection: getNats(),
        handlers: this.inboundActionHandlers,
      });
    } else if (this.inboundActionHandlers.length === 0 && this.inboundActionResponder) {
      const responder = this.inboundActionResponder;
      this.inboundActionResponder = null;
      await responder.stop();
    }
  }

  private currentAdapterStatuses(): AdapterStatus[] {
    const statuses = new Map(this.adapterStatuses);
    for (const health of this.nativeChannelManager?.health() ?? []) {
      statuses.set(health.id, health);
    }
    return Array.from(statuses.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  private outboundPublishOutboxStatus(): ChannelOutboundPublishOutboxSummary {
    try {
      return this.outboundPublishReconciler?.status() ?? getChannelOutboundPublishOutboxSummary();
    } catch (error) {
      return {
        pendingCount: 0,
        lastError: {
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      };
    }
  }

  private markAdapter(id: string, channelId: string, status: AdapterStatus["status"], reason?: string): void {
    this.adapterStatuses.set(id, {
      id,
      channelId,
      status,
      ...(reason ? { reason } : {}),
    });
  }
}

export function slackAdapterHealth(accountId: string, status: SlackSocketModeStatus): ChannelAdapterHealth {
  return {
    id: `slack:${accountId}`,
    channelId: "slack",
    ...slackNativeRuntimeHealth(status),
  };
}

export function pruneChannelOutboundReceiptLedger(
  now = Date.now(),
  store: Pick<ChannelOutboundReceiptStore, "pruneExpired"> = sqliteChannelOutboundReceiptStore,
): number {
  return store.pruneExpired(now - CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS, now);
}

export function pruneChannelOutboundPublishOutbox(
  now = Date.now(),
  store: Pick<ChannelOutboundPublishOutboxStore, "prunePublished"> = sqliteChannelOutboundPublishOutboxStore,
): number {
  return store.prunePublished(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now);
}

export function runChannelOutboundLedgerMaintenance(
  now = Date.now(),
  stores: {
    receiptStore?: Pick<ChannelOutboundReceiptStore, "pruneExpired">;
    publishOutboxStore?: Pick<ChannelOutboundPublishOutboxStore, "prunePublished">;
  } = {},
): { receipts: number; publishJobs: number } {
  let receipts = 0;
  try {
    receipts = pruneChannelOutboundReceiptLedger(now, stores.receiptStore);
    if (receipts > 0) {
      log.info("Pruned expired channel outbound receipts", { count: receipts });
    }
  } catch (error) {
    log.warn("Failed to prune expired channel outbound receipts", { error });
  }

  let publishJobs = 0;
  try {
    publishJobs = pruneChannelOutboundPublishOutbox(now, stores.publishOutboxStore);
    if (publishJobs > 0) {
      log.info("Pruned expired channel outbound publish jobs", { count: publishJobs });
    }
  } catch (error) {
    log.warn("Failed to prune expired channel outbound publish jobs", { error });
  }

  return { receipts, publishJobs };
}

export function startChannelOutboundReceiptPruner(options: ChannelOutboundReceiptPrunerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Channel outbound receipt prune interval must be greater than zero");
  }

  const now = options.now ?? Date.now;
  const store = options.store ?? sqliteChannelOutboundReceiptStore;
  const publishOutboxStore = options.publishOutboxStore ?? sqliteChannelOutboundPublishOutboxStore;
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelInterval = options.clearInterval ?? clearInterval;
  const timer = scheduleInterval(() => {
    runChannelOutboundLedgerMaintenance(now(), { receiptStore: store, publishOutboxStore });
  }, intervalMs);
  timer.unref?.();

  return () => cancelInterval(timer);
}

export async function startChannelRunner(options: ChannelRunnerOptions = {}): Promise<ChannelRunner> {
  const runner = new ChannelRunner(options);
  await runner.start();
  return runner;
}

/** The process-level hooks `installChannelRunnerCrashGuards` registers on. */
export interface ChannelRunnerProcessHooks {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

/**
 * Keep the channel runner alive through a stray rejection or exception (a Baileys
 * listener, a socket callback): log it instead of letting Bun exit, so the other
 * channels keep running and the failing one reports its state through health. Mirrors
 * the daemon's handlers. Returns an uninstaller.
 */
export function installChannelRunnerCrashGuards(hooks: ChannelRunnerProcessHooks = process): () => void {
  const onRejection = (reason: unknown) => {
    log.error("Unhandled rejection in channel runner", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
  const onException = (error: Error) => {
    log.error("Uncaught exception in channel runner", { error: error.message, stack: error.stack });
  };
  hooks.on("unhandledRejection", onRejection);
  hooks.on("uncaughtException", onException);
  return () => {
    hooks.off("unhandledRejection", onRejection);
    hooks.off("uncaughtException", onException);
  };
}

export async function runChannelRunnerFromEnv(): Promise<void> {
  installChannelRunnerCrashGuards();
  const runner = await startChannelRunner({
    consumeOutbound: process.env.RAVI_CHANNELS_CONSUME_OUTBOUND !== "0",
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("Received channel runner shutdown signal", { signal });
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await new Promise<void>(() => {});
}

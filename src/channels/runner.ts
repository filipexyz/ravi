import { closeAllRaviDbs } from "../db/close-all.js";
import { closeNats, connectNats, getNats } from "../nats.js";
import { configStore } from "../config-store.js";
import { listRemoteInstallationCredentials } from "../cloud-auth/installation-storage.js";
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
  type NativeInboundChannelActionHandler,
  type NativeChannelDriverRuntime,
} from "./native/driver.js";
import { mergeInstallationCredentialChannels } from "./native/installation-channels.js";
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

const log = logger.child("channels:runner");

export const CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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
  private nativeChannelManager: NativeChannelDriverManager | null = null;
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
    await this.inboundActionResponder?.stop();
    this.inboundActionResponder = null;
    await this.nativeChannelManager?.stop();
    this.nativeChannelManager = null;
    this.deliveries = [];
    this.actionDeliveries = [];
    this.presenceDeliveries = [];
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

    let channels = configStore.getConfig().channels ?? {};
    try {
      channels = mergeInstallationCredentialChannels({
        configured: channels,
        credentials: listRemoteInstallationCredentials(env),
        registry,
      });
    } catch {
      this.markAdapter("native-driver:installation-credentials", "native", "failed", "missing_credentials");
      log.warn("Remote installation credentials were unavailable to native channels");
    }

    this.nativeChannelManager = new NativeChannelDriverManager({
      channels,
      registry,
    });
    await this.nativeChannelManager.start();
    this.inboundActionResponder = startChannelRunnerInboundActionResponder({
      connection: getNats(),
      handlers: this.nativeChannelManager.inboundActionHandlers(),
    });
    this.deliveries.push(...this.nativeChannelManager.deliveries());
    this.actionDeliveries.push(...this.nativeChannelManager.actionDeliveries());
    this.presenceDeliveries.push(...this.nativeChannelManager.presenceDeliveries());
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

export async function runChannelRunnerFromEnv(): Promise<void> {
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

import { closeAllRaviDbs } from "../db/close-all.js";
import { closeNats, connectNats, getNats } from "../nats.js";
import { configStore } from "../config-store.js";
import { logger } from "../utils/logger.js";
import {
  startChannelRunnerHealthResponder,
  type ChannelAdapterHealth,
  type ChannelRunnerHealthResponder,
  type ChannelRunnerRuntimeStatus,
} from "./health.js";
import type { NativePresenceDelivery, NativeTextDelivery } from "./native/types.js";
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
  createSlackNativeRuntimesFromEnv,
  type SlackNativeRuntime,
  type SlackSocketModeStatus,
} from "./slack/index.js";

const log = logger.child("channels:runner");

export const CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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
  private presenceDeliveries: NativePresenceDelivery[] = [];
  private slackRuntimes: SlackNativeRuntime[] = [];
  private adapterStatuses = new Map<string, AdapterStatus>();
  private stopReceiptPruner: (() => void) | null = null;
  private healthResponder: ChannelRunnerHealthResponder | null = null;

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

    await this.startSlack(env);

    if (this.options.consumeOutbound !== false) {
      this.outboundPublishReconciler = new ChannelOutboundPublishReconciler({
        isRunning: () => this.running,
      });
      this.outboundPublishReconciler.start();

      this.outboundConsumer = new ChannelOutboundConsumer({
        deliveries: this.deliveries,
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
    log.info("Stopping channel runner", { pid: process.pid });
    await this.outboundPublishReconciler?.stop();
    this.outboundPublishReconciler = null;
    await this.outboundConsumer?.stop();
    this.outboundConsumer = null;
    await this.presenceConsumer?.stop();
    this.presenceConsumer = null;
    for (const runtime of this.slackRuntimes) {
      await runtime.socketMode.stop();
      this.markAdapter(`slack:${runtime.accountId}`, "slack", "disconnected");
    }
    this.slackRuntimes = [];
    this.deliveries = [];
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

  private async startSlack(env: NodeJS.ProcessEnv): Promise<void> {
    this.markAdapter("slack", "slack", "starting");
    try {
      const runtimes = await createSlackNativeRuntimesFromEnv(env, {
        onRuntimeDisabled: (channel, reason) => {
          this.markAdapter(`slack:${channel.name}`, "slack", "failed", reason);
        },
        onRuntimeError: (channel, error) => {
          this.markAdapter(`slack:${channel.name}`, "slack", "failed", "startup_failed");
          log.error("Failed to start configured Slack native runtime", {
            channel: channel.name,
            error,
          });
        },
      });
      this.adapterStatuses.delete("slack");
      if (!runtimes.length) {
        this.markAdapter("slack", "slack", "disabled", "not_configured");
        return;
      }

      this.slackRuntimes = runtimes;
      for (const runtime of runtimes) {
        this.deliveries.push(runtime.delivery);
        this.presenceDeliveries.push(runtime.presence);
        runtime.socketMode.start();
        this.markAdapter(`slack:${runtime.accountId}`, "slack", "starting", "opening_socket");
      }
    } catch (error) {
      this.markAdapter("slack", "slack", "failed", "startup_failed");
      log.error("Failed to start Slack native runtime", { error });
    }
  }

  private currentAdapterStatuses(): AdapterStatus[] {
    const statuses = new Map(this.adapterStatuses);
    for (const runtime of this.slackRuntimes) {
      const socketStatus = runtime.socketMode.status();
      statuses.set(`slack:${runtime.accountId}`, slackAdapterHealth(runtime.accountId, socketStatus));
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
  const adapterStatus: ChannelAdapterHealth["status"] =
    status.state === "stopped"
      ? "disconnected"
      : status.state === "connecting"
        ? "starting"
        : status.state === "reconnecting"
          ? "reconnecting"
          : "connected";
  return {
    id: `slack:${accountId}`,
    channelId: "slack",
    status: adapterStatus,
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.connectedAt !== undefined ? { connectedAt: status.connectedAt } : {}),
    ...(status.lastPongAt !== undefined ? { lastPongAt: status.lastPongAt } : {}),
    reconnectCount: status.reconnectCount,
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

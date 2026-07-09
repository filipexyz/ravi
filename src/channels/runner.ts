import { closeAllRaviDbs } from "../db/close-all.js";
import { closeNats, connectNats } from "../nats.js";
import { logger } from "../utils/logger.js";
import type { NativePresenceDelivery, NativeTextDelivery } from "./native/types.js";
import { ChannelOutboundConsumer } from "./outbound-consumer.js";
import {
  CHANNEL_OUTBOUND_CONSUMER,
  CHANNEL_OUTBOUND_STREAM,
  ensureChannelOutboundInfrastructure,
} from "./outbound-stream.js";
import { ChannelPresenceConsumer } from "./presence-consumer.js";
import { createSlackNativeRuntimesFromEnv, type SlackNativeRuntime } from "./slack/index.js";

const log = logger.child("channels:runner");

export interface ChannelRunnerOptions {
  natsUrl?: string;
  consumeOutbound?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ChannelRunnerStatus {
  running: boolean;
  startedAt: number | null;
  pid: number;
  outbound: {
    stream: string;
    consumer: string;
    infrastructureReady: boolean;
    consuming: boolean;
  };
  adapters: Array<{
    id: string;
    channelId: string;
    status: "disabled" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
    reason?: string;
  }>;
}

interface AdapterStatus {
  id: string;
  channelId: string;
  status: ChannelRunnerStatus["adapters"][number]["status"];
  reason?: string;
}

export class ChannelRunner {
  private running = false;
  private startedAt: number | null = null;
  private outboundInfrastructureReady = false;
  private outboundConsumer: ChannelOutboundConsumer | null = null;
  private presenceConsumer: ChannelPresenceConsumer | null = null;
  private deliveries: NativeTextDelivery[] = [];
  private presenceDeliveries: NativePresenceDelivery[] = [];
  private slackRuntimes: SlackNativeRuntime[] = [];
  private adapterStatuses = new Map<string, AdapterStatus>();

  constructor(private readonly options: ChannelRunnerOptions = {}) {}

  async start(): Promise<void> {
    if (this.running) {
      log.warn("Channel runner already started");
      return;
    }

    const env = this.options.env ?? process.env;
    await connectNats(this.options.natsUrl ?? env.NATS_URL ?? "nats://127.0.0.1:4222", {
      explicit: true,
      retry: true,
    });
    await ensureChannelOutboundInfrastructure();

    this.outboundInfrastructureReady = true;
    this.running = true;
    this.startedAt = Date.now();

    await this.startSlack(env);

    if (this.options.consumeOutbound !== false) {
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
    log.info("Stopping channel runner", { pid: process.pid });
    await this.outboundConsumer?.stop();
    this.outboundConsumer = null;
    await this.presenceConsumer?.stop();
    this.presenceConsumer = null;
    await Promise.all(this.slackRuntimes.map((runtime) => runtime.socketMode.stop()));
    this.slackRuntimes = [];
    this.deliveries = [];
    this.presenceDeliveries = [];
    this.markAdapter("slack", "slack", "disconnected");
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
        infrastructureReady: this.outboundInfrastructureReady,
        consuming: this.outboundConsumer?.isConsuming() ?? false,
      },
      adapters: Array.from(this.adapterStatuses.values()).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private async startSlack(env: NodeJS.ProcessEnv): Promise<void> {
    this.markAdapter("slack", "slack", "starting");
    try {
      const runtimes = await createSlackNativeRuntimesFromEnv(env);
      if (runtimes.length === 0) {
        this.markAdapter("slack", "slack", "disabled", "not_configured");
        return;
      }

      this.slackRuntimes = runtimes;
      for (const runtime of runtimes) {
        this.deliveries.push(runtime.delivery);
        this.presenceDeliveries.push(runtime.presence);
        runtime.socketMode.start();
      }
      this.markAdapter("slack", "slack", "connected");
    } catch (error) {
      this.markAdapter("slack", "slack", "failed", error instanceof Error ? error.message : String(error));
      log.error("Failed to start Slack native runtime", { error });
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

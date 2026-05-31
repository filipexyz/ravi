import { logger } from "../utils/logger.js";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import { enqueueTraceExportBatch, pushTraceExportBatch } from "../session-trace/cloud-trace-export.js";
import { createConsoleSyncBridge, type ConsoleSyncBridge } from "./console-bridge.js";

const log = logger.child("sync:runner");
const DEFAULT_INTERVAL_MS = 60_000;

export interface SyncRunnerOptions {
  intervalMs?: number;
  bridge?: ConsoleSyncBridge;
  enabled?: boolean;
  pullDomains?: string[];
}

export class SyncRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private bridge: ConsoleSyncBridge;
  private intervalMs: number;
  private enabled: boolean;
  private pullDomains: string[];

  constructor(options: SyncRunnerOptions = {}) {
    this.bridge = options.bridge ?? createConsoleSyncBridge();
    this.intervalMs = options.intervalMs ?? numberEnv("RAVI_SYNC_RUNNER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
    this.enabled = options.enabled ?? process.env.RAVI_DISABLE_SYNC_RUNNER !== "1";
    this.pullDomains = options.pullDomains ?? listEnv("RAVI_SYNC_PULL_DOMAINS");
  }

  configure(options: SyncRunnerOptions): void {
    if (options.bridge) this.bridge = options.bridge;
    if (options.intervalMs) this.intervalMs = options.intervalMs;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.pullDomains) this.pullDomains = options.pullDomains;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (!this.enabled) {
      log.info("Sync runner disabled");
      return;
    }
    log.info("Starting sync runner", { intervalMs: this.intervalMs });
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Sync runner stopped");
  }

  async tick(): Promise<void> {
    if (!this.running || !this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      if (readCloudCredentials()) {
        const trace = enqueueTraceExportBatch();
        if (trace.enqueued) {
          log.debug("Trace export batch enqueued", {
            sourceEvents: trace.sourceEvents,
            exportedEvents: trace.exportedEvents,
            firstEventId: trace.firstEventId,
            lastEventId: trace.lastEventId,
          });
        }
        const tracePush = await pushTraceExportBatch({ bridge: this.bridge });
        if (tracePush.status === "uploaded" || tracePush.status === "failed") {
          log.info("Trace export push", {
            status: tracePush.status,
            attempted: tracePush.attempted,
            acked: tracePush.acked,
            failed: tracePush.failed,
            errorCode: tracePush.errorCode,
          });
        }
      }
      const push = await this.bridge.push();
      if (push.status === "uploaded" || push.status === "failed") {
        log.info("Sync runner push", {
          status: push.status,
          attempted: push.attempted,
          sent: push.sent,
          acked: push.acked,
          failed: push.failed,
          errorCode: push.errorCode,
        });
      }
      for (const domain of this.pullDomains) {
        const pull = await this.bridge.pull({ domain, scope: "organization" });
        if (pull.status === "downloaded" || pull.status === "failed") {
          log.info("Sync runner pull", {
            domain,
            status: pull.status,
            downloaded: pull.downloaded,
            applied: pull.applied,
            failed: pull.failed,
            errorCode: pull.errorCode,
          });
        }
      }
    } catch (error) {
      log.warn("Sync runner tick failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }
}

let runner: SyncRunner | null = null;

export function getSyncRunner(options?: SyncRunnerOptions): SyncRunner {
  if (!runner) runner = new SyncRunner(options);
  else if (options) runner.configure(options);
  return runner;
}

export async function startSyncRunner(options?: SyncRunnerOptions): Promise<void> {
  await getSyncRunner(options).start();
}

export async function stopSyncRunner(): Promise<void> {
  if (!runner) return;
  await runner.stop();
  runner = null;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

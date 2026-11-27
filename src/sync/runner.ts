import { logger } from "../utils/logger.js";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import { enqueueTraceExportBatch, pushTraceExportBatch } from "../session-trace/cloud-trace-export.js";
import { createConsoleSyncBridge, type ConsoleSyncBridge } from "./console-bridge.js";
import { getSyncRuntimeConfig, numberEnv, SYNC_RUNNER_INTERVAL_ENV } from "./config.js";
import { sanitizeSyncError } from "./redaction.js";
import { enqueueCredentialInventorySnapshot } from "../credentials/inventory-sync.js";

const log = logger.child("sync:runner");
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TRACE_ENQUEUE_LIMIT = 25;
const DEFAULT_TRACE_PUSH_LIMIT = 25;

export interface SyncRunnerOptions {
  intervalMs?: number;
  bridge?: ConsoleSyncBridge;
  enabled?: boolean;
  pullDomains?: string[];
  /** Injected in tests; defaults to the opt-in credential inventory enqueue. */
  credentialInventory?: () => Promise<unknown>;
}

export class SyncRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private bridge: ConsoleSyncBridge;
  private intervalMs: number;
  private enabled: boolean;
  private pullDomains: string[];
  private traceEnqueueLimit: number;
  private tracePushLimit: number;
  private credentialInventory: () => Promise<unknown>;
  /** Exposed for tests: the in-flight background snapshot, if any. */
  credentialInventoryInFlight: Promise<void> | null = null;

  constructor(options: SyncRunnerOptions = {}) {
    const config = getSyncRuntimeConfig();
    this.bridge = options.bridge ?? createConsoleSyncBridge();
    this.intervalMs = options.intervalMs ?? numberEnv(SYNC_RUNNER_INTERVAL_ENV, DEFAULT_INTERVAL_MS);
    this.enabled = options.enabled ?? config.runnerEnabled;
    this.pullDomains = options.pullDomains ?? config.pullDomains;
    this.traceEnqueueLimit = numberEnv("RAVI_TRACE_EXPORT_ENQUEUE_LIMIT", DEFAULT_TRACE_ENQUEUE_LIMIT);
    this.tracePushLimit = numberEnv("RAVI_TRACE_EXPORT_PUSH_LIMIT", DEFAULT_TRACE_PUSH_LIMIT);
    this.credentialInventory = options.credentialInventory ?? (() => enqueueCredentialInventorySnapshot());
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
      log.info("Sync runner disabled; set RAVI_SYNC_RUNNER_ENABLED=1 to enable automatic sync");
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

  /**
   * Credential inventory in the background, one at a time: the tick (push and
   * pull of every domain) never waits on the Vault. Opt-in is checked inside,
   * before the inventory is built; the event goes up on a later tick.
   */
  private startCredentialInventory(): void {
    if (this.credentialInventoryInFlight) return;
    let run: Promise<unknown>;
    try {
      run = this.credentialInventory();
    } catch (error) {
      run = Promise.reject(error);
    }
    this.credentialInventoryInFlight = run
      .then((result) => {
        const status = (result as { status?: string; hash?: string } | undefined)?.status;
        if (status === "enqueued")
          log.info("Credential inventory enqueued", { hash: (result as { hash?: string }).hash });
      })
      .catch((error) => {
        // The reason is fixed text without paths or values.
        log.warn("Credential inventory snapshot failed", { error: sanitizeSyncError(error) });
      })
      .finally(() => {
        this.credentialInventoryInFlight = null;
      });
  }

  async tick(): Promise<void> {
    if (!this.running || !this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      if (readCloudCredentials()) {
        let traceBatches = 0;
        let traceSourceEvents = 0;
        let traceExportedEvents = 0;
        let traceSkippedEvents = 0;
        let traceFirstEventId: number | null = null;
        let traceLastEventId: number | null = null;
        for (let i = 0; i < this.traceEnqueueLimit; i += 1) {
          const trace = enqueueTraceExportBatch();
          traceSkippedEvents += trace.skippedEvents;
          if (trace.sourceEvents === 0) break;
          traceSourceEvents += trace.sourceEvents;
          traceExportedEvents += trace.exportedEvents;
          traceFirstEventId ??= trace.firstEventId;
          traceLastEventId = trace.lastEventId;
          if (trace.enqueued) traceBatches += 1;
        }
        if (traceBatches > 0 || traceSkippedEvents > 0) {
          log.debug("Trace export batches enqueued", {
            batches: traceBatches,
            sourceEvents: traceSourceEvents,
            exportedEvents: traceExportedEvents,
            skippedEvents: traceSkippedEvents,
            firstEventId: traceFirstEventId,
            lastEventId: traceLastEventId,
          });
        }
        const tracePush = await pushTraceExportBatch({ bridge: this.bridge, limit: this.tracePushLimit });
        if (tracePush.status === "uploaded" || tracePush.status === "failed") {
          log.info("Trace export push", {
            status: tracePush.status,
            attempted: tracePush.attempted,
            acked: tracePush.acked,
            failed: tracePush.failed,
            errorCode: tracePush.errorCode,
          });
        }
        this.startCredentialInventory();
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

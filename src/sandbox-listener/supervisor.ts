// Keeps the daemon's sandbox listener in step with the `gateway.*` settings
// without a daemon restart (ADR 0002 #8). `ravi.config.changed` carries no
// payload, so every event (and a 30 s safety-net timer, like the config
// store's) re-reads the settings and reconciles: start when they became
// complete, stop when they were cleared or became invalid, restart when any
// value changed, nothing otherwise. Reconciles are serialised.

import { logger } from "../utils/logger.js";
import {
  type ReadSandboxListenerConfigResult,
  readSandboxListenerConfig,
  type SandboxListenerConfig,
  sameSandboxListenerConfig,
} from "./config.js";
import { type SandboxListenerHandle, startSandboxListener } from "./server.js";

const log = logger.child("sandbox-listener-supervisor");

export const SANDBOX_LISTENER_RECONCILE_INTERVAL_MS = 30_000;

export type ListenerReconcileAction = "started" | "stopped" | "restarted" | "unchanged" | "failed";

export interface ListenerReconcileResult {
  action: ListenerReconcileAction;
  enabled: boolean;
  port: number | null;
}

export interface SandboxListenerSupervisorDeps {
  readConfig?: () => ReadSandboxListenerConfigResult;
  start?: (config: SandboxListenerConfig) => Promise<SandboxListenerHandle>;
}

export class SandboxListenerSupervisor {
  private handle: SandboxListenerHandle | null = null;
  private config: SandboxListenerConfig | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly readConfig: () => ReadSandboxListenerConfigResult;
  private readonly start: (config: SandboxListenerConfig) => Promise<SandboxListenerHandle>;

  constructor(deps: SandboxListenerSupervisorDeps = {}) {
    this.readConfig = deps.readConfig ?? (() => readSandboxListenerConfig());
    this.start = deps.start ?? ((config) => startSandboxListener({ port: config.port, config }));
  }

  current(): SandboxListenerHandle | null {
    return this.handle;
  }

  reconcile(trigger: string): Promise<ListenerReconcileResult> {
    const next = this.chain.then(() => this.reconcileNow(trigger));
    this.chain = next.catch(() => {});
    return next;
  }

  stop(): Promise<void> {
    const next = this.chain.then(() => this.stopCurrent());
    this.chain = next.catch(() => {});
    return next;
  }

  private async reconcileNow(trigger: string): Promise<ListenerReconcileResult> {
    let read: ReadSandboxListenerConfigResult;
    try {
      read = this.readConfig();
    } catch (error) {
      log.error("Sandbox listener settings could not be read; keeping the current state", { trigger, error });
      return this.result("failed");
    }

    if (!read.enabled) {
      if (read.reason === "config_invalid") {
        log.error("Sandbox listener settings are invalid", { trigger, invalid: read.invalid });
      }
      if (!this.handle) return this.result("unchanged");
      await this.stopCurrent();
      log.info("Sandbox listener stopped after a settings change", { trigger, reason: read.reason });
      return this.result("stopped");
    }

    if (this.handle && this.config && sameSandboxListenerConfig(this.config, read.config)) {
      return this.result("unchanged");
    }
    const restarting = this.handle !== null;
    await this.stopCurrent();
    try {
      this.handle = await this.start(read.config);
      this.config = read.config;
    } catch (error) {
      log.error("Sandbox listener failed to start", { trigger, error });
      return this.result("failed");
    }
    log.info(restarting ? "Sandbox listener restarted with new settings" : "Sandbox listener started", {
      trigger,
      url: this.handle.url,
    });
    return this.result(restarting ? "restarted" : "started");
  }

  private async stopCurrent(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.config = null;
    if (handle) await handle.stop();
  }

  private result(action: ListenerReconcileAction): ListenerReconcileResult {
    return { action, enabled: this.handle !== null, port: this.handle?.port ?? null };
  }
}

export interface ListenerConfigWatchDeps {
  /** `ravi.config.changed` events; the daemon passes the NATS subscription. */
  subscribe?: (subject: string) => AsyncIterable<unknown>;
  intervalMs?: number;
}

/** Reconciles on every `ravi.config.changed` and on a timer; returns the stop function. */
export function watchSandboxListenerConfig(
  supervisor: SandboxListenerSupervisor,
  deps: ListenerConfigWatchDeps = {},
): () => void {
  let running = true;
  const timer = setInterval(() => {
    void supervisor.reconcile("timer");
  }, deps.intervalMs ?? SANDBOX_LISTENER_RECONCILE_INTERVAL_MS);
  timer.unref?.();

  void (async () => {
    const subscribe: (subject: string) => AsyncIterable<unknown> =
      deps.subscribe ?? (await import("../nats.js").then(({ subscribe: natsSubscribe }) => natsSubscribe));
    while (running) {
      try {
        for await (const _event of subscribe("ravi.config.changed")) {
          if (!running) break;
          await supervisor.reconcile("config_changed");
        }
        if (!running) break;
      } catch (error) {
        if (!running) break;
        log.warn("Config subscription for the sandbox listener failed; retrying in 2s", { error });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })();

  return () => {
    running = false;
    clearInterval(timer);
  };
}

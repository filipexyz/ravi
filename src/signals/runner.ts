import { logger } from "../utils/logger.js";
import { tickSignals } from "./tick.js";

const log = logger.child("signals:runner");
const SIGNALS_SWEEP_INTERVAL_MS = 5 * 60_000;

export class SignalsRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sweeping = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting signals runner", { sweepIntervalMs: SIGNALS_SWEEP_INTERVAL_MS });
    await this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, SIGNALS_SWEEP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Stopped signals runner");
  }

  async sweep(now = Date.now()): Promise<void> {
    if (!this.running || this.sweeping) return;
    this.sweeping = true;
    try {
      const result = await tickSignals({ execute: true, now });
      if (result.escalated > 0 || result.resolved > 0 || result.expired > 0 || result.errors.length > 0) {
        log.info("Signals sweep completed", {
          evaluated: result.evaluated,
          resolved: result.resolved,
          expired: result.expired,
          escalated: result.escalated,
          errors: result.errors.length,
        });
      }
    } catch (error) {
      log.error("Signals sweep failed", { error });
    } finally {
      this.sweeping = false;
    }
  }
}

let runner: SignalsRunner | null = null;

export function getSignalsRunner(): SignalsRunner {
  if (!runner) runner = new SignalsRunner();
  return runner;
}

export async function startSignalsRunner(): Promise<void> {
  await getSignalsRunner().start();
}

export async function stopSignalsRunner(): Promise<void> {
  await getSignalsRunner().stop();
}

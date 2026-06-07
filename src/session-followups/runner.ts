import { logger } from "../utils/logger.js";
import { runDueSessionFollowups } from "./service.js";

const log = logger.child("session-followups:runner");

export class SessionFollowupRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;

  constructor(private readonly intervalMs = resolveRunnerIntervalMs()) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.armTimer(1_000);
    log.info("Session followup runner started", { intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("Session followup runner stopped");
  }

  async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      const result = await runDueSessionFollowups();
      if (result.cadencesScanned > 0 || result.runsProcessed > 0) {
        log.info("Session followup tick completed", result);
      }
    } catch (error) {
      log.error("Session followup tick failed", { error });
    } finally {
      this.processing = false;
      this.armTimer(this.intervalMs);
    }
  }

  private armTimer(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.tick().catch((error) => log.error("Session followup tick crashed", { error }));
      },
      Math.max(1_000, delayMs),
    );
  }
}

let singleton: SessionFollowupRunner | null = null;

export function getSessionFollowupRunner(): SessionFollowupRunner {
  if (!singleton) singleton = new SessionFollowupRunner();
  return singleton;
}

export async function startSessionFollowupRunner(): Promise<void> {
  if (process.env.RAVI_SESSION_FOLLOWUPS_ENABLED === "0") {
    log.info("Session followup runner disabled by RAVI_SESSION_FOLLOWUPS_ENABLED=0");
    return;
  }
  await getSessionFollowupRunner().start();
}

export async function stopSessionFollowupRunner(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
}

function resolveRunnerIntervalMs(): number {
  const raw = process.env.RAVI_SESSION_FOLLOWUP_RUNNER_INTERVAL_MS;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 30_000;
}

/**
 * Cron Runner
 *
 * Manages scheduled job execution using a timer-based approach.
 * Similar to heartbeat runner but for user-defined cron jobs.
 */

import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { getDefaultAgentId } from "../router/router-db.js";
import { deriveSourceFromSessionKey } from "../router/session-key.js";
import {
  getMainSession,
  getOrCreateSession,
  resolveSession,
  generateSessionName,
  ensureUniqueName,
  updateSessionName,
  expandHome,
} from "../router/index.js";
import { getAgent } from "../router/config.js";
import {
  dbGetDueJobs,
  dbGetNextDueJob,
  dbUpdateJobState,
  dbDeleteCronJob,
  dbGetCronJob,
} from "./cron-db.js";
import { calculateNextRun } from "./schedule.js";
import type { CronJob } from "./types.js";

const log = logger.child("cron:runner");

/**
 * CronRunner - manages scheduled job execution
 */
export class CronRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;

  /**
   * Start the cron runner.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting cron runner");

    // Arm timer for next due job
    this.armTimer();

    // Subscribe to config refresh signals
    this.subscribeToConfigRefresh();

    // Subscribe to manual trigger signals
    this.subscribeToTriggerEvents();

    log.info("Cron runner started");
  }

  /**
   * Stop the cron runner.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    log.info("Stopping cron runner");

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    log.info("Cron runner stopped");
  }

  /**
   * Set timer for the next due job.
   */
  private armTimer(): void {
    if (!this.running) return;

    // Clear existing timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Find next job to run
    const nextJob = dbGetNextDueJob();
    if (!nextJob || !nextJob.nextRunAt) {
      log.debug("No jobs scheduled, timer idle");
      return;
    }

    const delay = Math.max(0, nextJob.nextRunAt - Date.now());
    log.debug("Timer armed", {
      jobId: nextJob.id,
      jobName: nextJob.name,
      delay,
      nextRunAt: new Date(nextJob.nextRunAt).toISOString(),
    });

    this.timer = setTimeout(() => {
      this.runDueJobs().catch(err => {
        log.error("Error running due jobs", { error: err });
      });
    }, delay);
  }

  /**
   * Run all due jobs.
   */
  private async runDueJobs(): Promise<void> {
    if (!this.running) return;
    if (this.processing) {
      log.debug("Already processing, skipping");
      return;
    }

    this.processing = true;

    try {
      const dueJobs = dbGetDueJobs();
      log.debug("Running due jobs", { count: dueJobs.length });

      for (const job of dueJobs) {
        if (!this.running) break;
        await this.executeJob(job);
      }
    } finally {
      this.processing = false;
      // Re-arm timer for next job
      this.armTimer();
    }
  }

  /**
   * Execute a single job.
   * Note: This is fire-and-forget - we emit the prompt and mark as "ok".
   * The actual agent processing happens asynchronously.
   */
  private async executeJob(job: CronJob): Promise<void> {
    const startTime = Date.now();
    log.info("Executing job", { jobId: job.id, jobName: job.name, sessionTarget: job.sessionTarget });

    try {
      if (job.sessionTarget === "main") {
        await this.executeMainJob(job);
      } else {
        await this.executeIsolatedJob(job);
      }

      // Calculate next run from the scheduled time (not now) to prevent drift
      // For interval jobs, use the original nextRunAt as base
      const baseTime = job.schedule.type === "every" && job.nextRunAt
        ? job.nextRunAt
        : startTime;
      const nextRunAt = calculateNextRun(job.schedule, baseTime);

      dbUpdateJobState(job.id, {
        lastRunAt: startTime,
        lastStatus: "ok",
        lastDurationMs: Date.now() - startTime,
        nextRunAt,
      });

      log.info("Job triggered", { jobId: job.id, jobName: job.name });

      // Delete one-shot jobs after successful trigger
      if (job.deleteAfterRun || job.schedule.type === "at") {
        log.info("Deleting one-shot job", { jobId: job.id });
        dbDeleteCronJob(job.id);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Calculate next run even on error so job can retry
      const baseTime = job.schedule.type === "every" && job.nextRunAt
        ? job.nextRunAt
        : startTime;
      const nextRunAt = calculateNextRun(job.schedule, baseTime);

      dbUpdateJobState(job.id, {
        lastRunAt: startTime,
        lastStatus: "error",
        lastError: errorMessage,
        lastDurationMs: Date.now() - startTime,
        nextRunAt,
      });

      log.error("Job failed", { jobId: job.id, jobName: job.name, error: errorMessage });
    }
  }

  /**
   * Format current time for prompt injection.
   */
  private formatNow(): string {
    return new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /**
   * Resolve session name for an agent's main session (find or create).
   */
  private resolveMainSessionName(agentId: string): string {
    // If replySession is set, try to resolve it as a session name
    const main = getMainSession(agentId);
    if (main?.name) return main.name;

    // Create main session
    const agent = getAgent(agentId);
    const agentCwd = agent ? expandHome(agent.cwd) : `/tmp/ravi-${agentId}`;
    const baseName = generateSessionName(agentId, { isMain: true });
    const sessionName = ensureUniqueName(baseName);
    const session = getOrCreateSession(`agent:${agentId}:main`, agentId, agentCwd, { name: sessionName });
    if (!session.name) {
      updateSessionName(session.sessionKey, sessionName);
    }
    return sessionName;
  }

  /**
   * Resolve session name for a reply session (name or legacy key).
   */
  private resolveReplySessionName(replySession: string): string | null {
    const session = resolveSession(replySession);
    return session?.name ?? null;
  }

  /**
   * Execute a job in the main session (shared with TUI/WhatsApp/etc).
   * If replySession is set, uses that session instead of agent main.
   */
  private async executeMainJob(job: CronJob): Promise<void> {
    const agentId = job.agentId ?? getDefaultAgentId();

    let sessionName: string;
    let source: { channel: string; accountId: string; chatId: string } | undefined;

    if (job.replySession) {
      const resolved = this.resolveReplySessionName(job.replySession);
      if (resolved) {
        sessionName = resolved;
        const session = resolveSession(job.replySession);
        if (session?.lastChannel && session.lastTo) {
          source = { channel: session.lastChannel, accountId: session.lastAccountId ?? "default", chatId: session.lastTo };
        }
      } else {
        // Fallback: derive source from old-style key and use main session
        source = deriveSourceFromSessionKey(job.replySession) ?? undefined;
        sessionName = this.resolveMainSessionName(agentId);
      }
    } else {
      sessionName = this.resolveMainSessionName(agentId);
    }

    const prompt = `[Cron: ${job.name} ${this.formatNow()}]\n${job.message}`;

    await nats.emit(`ravi.session.${sessionName}.prompt`, {
      prompt,
      source,
      _cron: true,
      _jobId: job.id,
    });
  }

  /**
   * Execute a job in an isolated session.
   */
  private async executeIsolatedJob(job: CronJob): Promise<void> {
    const agentId = job.agentId ?? getDefaultAgentId();
    const agent = getAgent(agentId);
    const agentCwd = agent ? expandHome(agent.cwd) : `/tmp/ravi-${agentId}`;

    // Create/find isolated cron session
    const dbKey = `agent:${agentId}:cron:${job.id}`;
    const existing = resolveSession(dbKey);
    let sessionName: string;

    if (existing?.name) {
      sessionName = existing.name;
    } else {
      const baseName = generateSessionName(agentId, { suffix: `cron-${job.name}` });
      sessionName = ensureUniqueName(baseName);
      const session = getOrCreateSession(dbKey, agentId, agentCwd, { name: sessionName });
      if (!session.name) {
        updateSessionName(session.sessionKey, sessionName);
      }
    }

    const prompt = `[Cron: ${job.name} ${this.formatNow()}]\n${job.message}`;

    // Derive source from replySession if set, so responses route correctly
    let source: { channel: string; accountId: string; chatId: string } | undefined;
    if (job.replySession) {
      const replyResolved = resolveSession(job.replySession);
      if (replyResolved?.lastChannel && replyResolved.lastTo) {
        source = { channel: replyResolved.lastChannel, accountId: replyResolved.lastAccountId ?? "default", chatId: replyResolved.lastTo };
      } else {
        source = deriveSourceFromSessionKey(job.replySession) ?? undefined;
      }
    }

    await nats.emit(`ravi.session.${sessionName}.prompt`, {
      prompt,
      source,
      _cron: true,
      _jobId: job.id,
    });
  }

  /**
   * Refresh timers (called after config changes).
   */
  refreshTimers(): void {
    log.info("Refreshing cron timers");
    this.armTimer();
  }

  /**
   * Manually trigger a job (ignores schedule, runs immediately).
   */
  async triggerJob(id: string): Promise<boolean> {
    const job = dbGetCronJob(id);
    if (!job) {
      log.warn("Job not found for manual trigger", { id });
      return false;
    }

    log.info("Manually triggering job", { jobId: id, jobName: job.name });
    await this.executeJob(job);
    return true;
  }

  /**
   * Subscribe to config refresh signals from CLI.
   */
  private async subscribeToConfigRefresh(): Promise<void> {
    const topic = "ravi.cron.refresh";
    log.debug("Subscribing to config refresh", { topic });

    try {
      for await (const _event of nats.subscribe(topic)) {
        if (!this.running) break;
        log.info("Received cron config refresh signal");
        this.refreshTimers();
      }
    } catch (err) {
      log.error("Config refresh subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToConfigRefresh(), 5000);
      }
    }
  }

  /**
   * Subscribe to manual trigger events from CLI.
   */
  private async subscribeToTriggerEvents(): Promise<void> {
    const topic = "ravi.cron.trigger";
    log.debug("Subscribing to trigger events", { topic });

    try {
      for await (const event of nats.subscribe(topic)) {
        if (!this.running) break;

        const data = event.data as { jobId?: string };
        if (!data.jobId) continue;

        log.info("Received manual trigger", { jobId: data.jobId });
        await this.triggerJob(data.jobId);
      }
    } catch (err) {
      log.error("Trigger subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToTriggerEvents(), 5000);
      }
    }
  }
}

// Singleton instance
let runner: CronRunner | null = null;

/**
 * Get or create the cron runner instance.
 */
export function getCronRunner(): CronRunner {
  if (!runner) {
    runner = new CronRunner();
  }
  return runner;
}

/**
 * Start the cron runner.
 */
export async function startCronRunner(): Promise<void> {
  await getCronRunner().start();
}

/**
 * Stop the cron runner.
 */
export async function stopCronRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}

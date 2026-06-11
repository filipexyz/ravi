/**
 * Cron Runner
 *
 * Manages scheduled job execution using a timer-based approach.
 * Similar to heartbeat runner but for user-defined cron jobs.
 */

import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
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
import { dbGetDueJobs, dbGetNextDueJob, dbUpdateJobState, dbDeleteCronJob, dbGetCronJob } from "./cron-db.js";
import { calculateNextRun } from "./schedule.js";
import { markCronSourceAsBackground, type CronPromptSource } from "./source.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS, runShellCronCommand, type ShellCronRunResult } from "./shell-executor.js";
import type { CronJob } from "./types.js";

const log = logger.child("cron:runner");
const MAX_NOTIFY_OUTPUT_CHARS = 4000;

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
      this.runDueJobs().catch((err) => {
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
    log.info("Executing job", {
      jobId: job.id,
      jobName: job.name,
      executionType: job.executionType,
      sessionTarget: job.sessionTarget,
    });

    if (job.executionType === "shell") {
      await this.executeShellJob(job, startTime);
      return;
    }

    try {
      if (job.sessionTarget === "main") {
        await this.executeMainJob(job);
      } else {
        await this.executeIsolatedJob(job);
      }

      // Calculate next run from the scheduled time (not now) to prevent drift
      // For interval jobs, use the original nextRunAt as base
      const baseTime = job.schedule.type === "every" && job.nextRunAt ? job.nextRunAt : startTime;
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
      const baseTime = job.schedule.type === "every" && job.nextRunAt ? job.nextRunAt : startTime;
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

  private calculateFollowupRun(job: CronJob, startTime: number): number | undefined {
    const baseTime = job.schedule.type === "every" && job.nextRunAt ? job.nextRunAt : startTime;
    return calculateNextRun(job.schedule, baseTime);
  }

  private truncateForPrompt(value: string): string {
    if (value.length <= MAX_NOTIFY_OUTPUT_CHARS) return value;
    return `${value.slice(0, MAX_NOTIFY_OUTPUT_CHARS)}\n...[truncated]`;
  }

  private formatShellError(result: ShellCronRunResult): string {
    if (result.timedOut) {
      return `Shell command timed out after ${result.durationMs}ms`;
    }
    const exit = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.exitCode}`;
    const stderr = result.stderr.trim();
    return stderr
      ? `Shell command failed with ${exit}: ${this.truncateForPrompt(stderr)}`
      : `Shell command failed with ${exit}`;
  }

  private async notifyShellError(job: CronJob, result: ShellCronRunResult, errorMessage: string): Promise<void> {
    if (!job.onError) return;
    const prefix = "notify-session:";
    if (!job.onError.startsWith(prefix)) {
      log.warn("Unsupported cron on-error action", { jobId: job.id, onError: job.onError });
      return;
    }

    const sessionRef = job.onError.slice(prefix.length).trim();
    if (!sessionRef) {
      log.warn("Cron on-error notify-session missing target", { jobId: job.id });
      return;
    }

    const resolved = resolveSession(sessionRef);
    const sessionName = resolved?.name ?? sessionRef;
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const prompt = [
      `[System] Inform: [from: cron:${job.id}] Cron shell job failed.`,
      "",
      `Job: ${job.name}`,
      `Command: ${job.shellCommand ?? result.command}`,
      `Error: ${errorMessage}`,
      `Exit code: ${result.exitCode ?? "(none)"}`,
      `Signal: ${result.signal ?? "(none)"}`,
      `Duration: ${result.durationMs}ms`,
      stderr ? `\nStderr:\n${this.truncateForPrompt(stderr)}` : "",
      stdout ? `\nStdout:\n${this.truncateForPrompt(stdout)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await publishSessionPrompt(sessionName, {
      prompt,
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _cron: true,
      _jobId: job.id,
      _cronOnError: true,
    });
  }

  private async executeShellJob(job: CronJob, startTime: number): Promise<void> {
    try {
      if (!job.shellCommand?.trim()) {
        throw new Error("Shell cron job is missing shellCommand");
      }

      const result = await runShellCronCommand(job.shellCommand, {
        timeoutMs: job.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS,
        envFile: job.shellEnvFile,
      });

      if (result.stdout.trim()) {
        log.info("Shell job stdout", { jobId: job.id, output: this.truncateForPrompt(result.stdout.trim()) });
      }
      if (result.stderr.trim()) {
        log.warn("Shell job stderr", { jobId: job.id, output: this.truncateForPrompt(result.stderr.trim()) });
      }

      const ok = !result.timedOut && result.exitCode === 0;
      const errorMessage = ok ? undefined : this.formatShellError(result);
      const nextRunAt = this.calculateFollowupRun(job, startTime);

      dbUpdateJobState(job.id, {
        lastRunAt: startTime,
        lastStatus: ok ? "ok" : "error",
        lastError: errorMessage,
        lastDurationMs: result.durationMs,
        nextRunAt,
        lastExitCode: result.exitCode ?? undefined,
      });

      if (!ok && errorMessage) {
        try {
          await this.notifyShellError(job, result, errorMessage);
        } catch (notifyError) {
          log.error("Failed to notify session about cron shell error", {
            jobId: job.id,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }

      log.info("Shell job completed", {
        jobId: job.id,
        jobName: job.name,
        status: ok ? "ok" : "error",
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
      });

      if (ok && (job.deleteAfterRun || job.schedule.type === "at")) {
        log.info("Deleting one-shot shell job", { jobId: job.id });
        dbDeleteCronJob(job.id);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const nextRunAt = this.calculateFollowupRun(job, startTime);

      dbUpdateJobState(job.id, {
        lastRunAt: startTime,
        lastStatus: "error",
        lastError: errorMessage,
        lastDurationMs: Date.now() - startTime,
        nextRunAt,
      });

      if (job.onError) {
        try {
          await this.notifyShellError(
            job,
            {
              command: job.shellCommand ?? "",
              exitCode: null,
              signal: null,
              stdout: "",
              stderr: errorMessage,
              durationMs: Date.now() - startTime,
              timedOut: false,
            },
            errorMessage,
          );
        } catch (notifyError) {
          log.error("Failed to notify session about cron shell exception", {
            jobId: job.id,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }

      log.error("Shell job failed", { jobId: job.id, jobName: job.name, error: errorMessage });
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
    let source: CronPromptSource | undefined;

    if (job.replySession) {
      const resolved = this.resolveReplySessionName(job.replySession);
      if (resolved) {
        sessionName = resolved;
        const session = resolveSession(job.replySession);
        if (session?.lastChannel && session.lastTo) {
          source = {
            channel: session.lastChannel,
            accountId: job.accountId ?? session.lastAccountId ?? "",
            chatId: session.lastTo,
          };
        }
      } else {
        // Fallback: derive source from old-style key and use main session
        source = deriveSourceFromSessionKey(job.replySession) ?? undefined;
        sessionName = this.resolveMainSessionName(agentId);
      }
    } else {
      sessionName = this.resolveMainSessionName(agentId);
    }

    // Override accountId in source if job has explicit accountId
    if (source && job.accountId) {
      source.accountId = job.accountId;
    }

    const prompt = `[Cron: ${job.name} ${this.formatNow()}]\n${job.message}`;

    await publishSessionPrompt(sessionName, {
      prompt,
      source: markCronSourceAsBackground(source),
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
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
    let source: CronPromptSource | undefined;
    if (job.replySession) {
      const replyResolved = resolveSession(job.replySession);
      if (replyResolved?.lastChannel && replyResolved.lastTo) {
        source = {
          channel: replyResolved.lastChannel,
          accountId: job.accountId ?? replyResolved.lastAccountId ?? "",
          chatId: replyResolved.lastTo,
        };
      } else {
        source = deriveSourceFromSessionKey(job.replySession) ?? undefined;
      }
    }

    // Override accountId in source if job has explicit accountId
    if (source && job.accountId) {
      source.accountId = job.accountId;
    }

    await publishSessionPrompt(sessionName, {
      prompt,
      source: markCronSourceAsBackground(source),
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
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

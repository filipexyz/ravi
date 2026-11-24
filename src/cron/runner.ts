/**
 * Cron Runner
 *
 * Manages scheduled job execution using a timer-based approach.
 * Similar to heartbeat runner but for user-defined cron jobs.
 */

import { randomUUID } from "node:crypto";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { isTriggerOwnSessionKey } from "../triggers/authority.js";
import { dbGetTrigger } from "../triggers/triggers-db.js";
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
import { slugify } from "../router/session-name.js";
import { spawnedAutomationEnv } from "../runtime/turn-origin.js";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";
import { cronOwnerActsAsOperator } from "../link/connector-turn.js";
import { CRON_RUN_AUTHORITY_ENV, type CronRunAuthority } from "./authority.js";
import { cronOwnershipError } from "./ownership.js";
import {
  dbGetDueJobs,
  dbGetNextDueJob,
  dbUpdateJobState,
  dbDeleteCronJob,
  dbGetCronJob,
  dbListCronJobs,
  dbDisableShellJobForOwner,
  dbSetJobNextRun,
} from "./cron-db.js";
import { classifyDiskPressureHint } from "./disk-pressure.js";
import { issueShellCronContext, redactContextKey } from "./shell-context.js";
import { calculateNextRun } from "./schedule.js";
import { markCronSourceAsBackground, type CronPromptSource } from "./source.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS, runShellCronCommand, type ShellCronRunResult } from "./shell-executor.js";
import {
  CRON_RUNTIME_EVENTS_TOPIC,
  buildCronTurnOutcomeState,
  parseCronTurnOutcome,
  type CronTurnOutcome,
} from "./turn-outcome.js";
import type { CronJob, JobOutcomeUpdate } from "./types.js";
import type { SessionEntry } from "../router/types.js";
import {
  CHILD_RUN_STALE_MS,
  childRunParentRefusal,
  childRunSurfaceFor,
  pendingChildRunSession,
  childRunPromptNote,
  closeChildRun,
  closeChildRunAfterTurn,
  getChildRun,
  listOpenChildRuns,
  openChildRun,
  reconcileChildRuns,
  releaseChildRunRuntime,
} from "../automation/child-runs.js";
import { notifyAutomationOff } from "./automation-notice.js";
import {
  deliverCronFailureReports,
  describeCronFailure,
  notifyCronFailure,
  notifyUndeliveredRunReturn,
  prepareCronFailureReport,
  recordUnreadableCronFailure,
  type CronFailureJob,
  type CronFailureReport,
} from "./failure-notification.js";
import {
  admitCronRun,
  getCronRun,
  settleCronRun,
  cronRunNotification,
  pendingCronFailureReports,
  markCronRunReported,
  rebindCronRunSession,
  isCronFailureReportPending,
  type CronRunRow,
} from "./run-db.js";

const log = logger.child("cron:runner");
const MAX_NOTIFY_OUTPUT_CHARS = 4000;
/**
 * How long `stop()` waits for the failure report in flight. The daemon stops its
 * components one after another inside a single 15 s guard, and a delivery may
 * hold for 30 s (`deliverToChat`), so cron keeps its share to about a second; a
 * report that has not settled by then stays pending for the next start.
 */
const FAILURE_REPORT_STOP_GRACE_MS = 1_000;
/** Failures one reconciliation pass keeps for `stop()` to raise; every failure is logged. */
const MAX_RECORDED_REPORT_FAILURES = 10;
/** A thread-mode run open longer than this is closed as failed, so its job can run again. */
export const THREAD_RUN_STALE_MS = CHILD_RUN_STALE_MS;
/** How often the leader reconciles automation runs: undelivered returns, runs left open. */
const CHILD_RUN_RECONCILE_INTERVAL_MS = 5 * 60_000;

function captureRunAuthority(job: CronJob): CronRunAuthority {
  return {
    jobId: job.id,
    ownerPrincipal: job.ownerPrincipal ?? "unknown",
    ownerIsOperator: cronOwnerActsAsOperator(job.ownerPrincipal ?? null),
    ...(job.creatorChat ? { creatorChat: job.creatorChat } : {}),
  };
}

/**
 * CronRunner - manages scheduled job execution
 */
export class CronRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private runtimeEventStream: ReturnType<typeof nats.subscribe> | null = null;
  private runtimeEventAbort: AbortController | null = null;
  private runtimeEventLoop: Promise<void> | null = null;
  private failureReportLoop: Promise<void> | null = null;
  private childRunTimer: ReturnType<typeof setInterval> | null = null;
  private childRunReconcile: Promise<void> | null = null;
  private failureReportGeneration = 0;
  private readonly failureReportStopGraceMs: number;
  private readonly runtimeEventStopFailures: Error[] = [];

  constructor(options: { failureReportStopGraceMs?: number } = {}) {
    this.failureReportStopGraceMs = options.failureReportStopGraceMs ?? FAILURE_REPORT_STOP_GRACE_MS;
  }

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

    // Subscribe to runtime terminal events so job state reflects turn outcomes
    this.runtimeEventLoop = this.subscribeToRuntimeEvents();
    // Remote notification delivery must not hold daemon readiness hostage to a
    // backlog or an offline channel. Stop waits only briefly for the report in
    // flight; whatever is unsettled stays pending for the next start.
    const generation = ++this.failureReportGeneration;
    this.failureReportLoop = this.reconcileFailureReports(generation).catch((cause) => {
      this.runtimeEventStopFailures.push(new Error("Cron failure report reconciliation failed", { cause }));
      log.error("Cron failure report reconciliation failed", { error: cause });
    });

    // Automation runs (cron and trigger): retry undelivered returns, close runs left open. In the
    // background, never on the readiness path; one pass at a time.
    this.scheduleChildRunReconcile();
    this.childRunTimer = setInterval(() => this.scheduleChildRunReconcile(), CHILD_RUN_RECONCILE_INTERVAL_MS);
    this.childRunTimer.unref?.();

    log.info("Cron runner started");
  }

  private scheduleChildRunReconcile(): void {
    if (!this.running || this.childRunReconcile) return;
    this.childRunReconcile = reconcileChildRuns({
      isRunning: () => this.running,
      releaseSource: "cron-runner",
      onAbandoned: async (run) => {
        // Cron: the run's admitted owner, even after the job changed hands or a one-shot was deleted.
        // Trigger: its stored owner (a deleted trigger owes nobody a message; the inbox keeps the record).
        const admitted = run.originKind === "cron" ? getCronRun(run.id) : null;
        const ownerPrincipal = admitted
          ? cronRunNotification(admitted).ownerPrincipal
          : // A trigger with no owner, or deleted since, owes nobody a message (an absent owner would
            // read as the operator).
            (dbGetTrigger(run.originId)?.ownerPrincipal ?? "unknown");
        await notifyUndeliveredRunReturn({
          originKind: run.originKind,
          originId: run.originId,
          originName: run.originName,
          agentId: run.agentId,
          ownerPrincipal,
          runId: run.id,
          runSessionName: run.childSessionName,
          parentSessionName: run.parentSessionName,
        });
      },
    })
      .then((result) => {
        if (result.redelivered || result.abandoned.length || result.staleClosed.length)
          log.info("Reconciled automation runs", {
            redelivered: result.redelivered,
            abandoned: result.abandoned.length,
            staleClosed: result.staleClosed.length,
          });
      })
      .catch((error) => log.error("Automation run reconciliation failed", { error }))
      .finally(() => {
        this.childRunReconcile = null;
      });
  }

  private async reconcileFailureReports(generation: number): Promise<void> {
    let recorded = 0;
    const recordFailure = (runId: string, cause: unknown) => {
      // An unexpected failure (a refused write, say) must not strand the reports behind it.
      // The report stays pending and `stop()` raises the failure.
      log.error("Cron failure report reconciliation failed", { runId, error: cause });
      if (recorded++ < MAX_RECORDED_REPORT_FAILURES)
        this.runtimeEventStopFailures.push(new Error(`Cron failure report ${runId} reconciliation failed`, { cause }));
    };
    // Settle locally what needs no message, and gather the rest: the backlog goes out as one digest
    // per owner (a line per job with its count), never one message per failed run.
    const owed: Array<{ runId: string; report: CronFailureReport }> = [];
    for (const run of pendingCronFailureReports()) {
      // A later start owns the backlog once this generation has been superseded.
      if (!this.running || generation !== this.failureReportGeneration) return;
      try {
        const report = this.prepareFailureReport(run);
        if (report) owed.push({ runId: run.id, report });
      } catch (cause) {
        recordFailure(run.id, cause);
      }
      // Reports that settle locally never wait on I/O; give timers and sockets a turn between them.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // A report settled meanwhile (`cron ack-failures`) is not sent.
    const stillOwed = owed.filter(({ runId }) => isCronFailureReportPending(runId));
    if (stillOwed.length === 0 || !this.running || generation !== this.failureReportGeneration) return;
    let settled: Set<string>;
    try {
      settled = await deliverCronFailureReports(stillOwed.map(({ report }) => report));
    } catch (cause) {
      recordFailure(stillOwed[0]!.runId, cause);
      return;
    }
    for (const { runId, report } of stillOwed) {
      if (!settled.has(report.itemId)) continue;
      try {
        markCronRunReported(runId);
      } catch (cause) {
        // Delivered but not marked: it stays pending (an unconfirmed send may go again next start).
        recordFailure(runId, cause);
      }
    }
  }

  /** `null` when the run is settled without a message (and marked reported); otherwise its report. */
  private prepareFailureReport(run: CronRunRow): CronFailureReport | null {
    let notification: CronFailureJob;
    try {
      notification = cronRunNotification(run);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      // Bad data, not a fault to raise at every shutdown: a stored notice that does not parse never
      // will, so retrying only repeats the failure. Record it once and settle it.
      log.warn("Cron failure notice is unreadable; recorded in the inbox and settled", {
        runId: run.id,
        jobId: run.job_id,
        error: cause,
      });
      recordUnreadableCronFailure(run);
      markCronRunReported(run.id);
      return null;
    }
    const report = prepareCronFailureReport(notification, run.error ?? "Agent turn failed");
    if (!report) markCronRunReported(run.id);
    return report;
  }

  /** Wait for the report in flight, but only a moment: the daemon stops its components in series. */
  private async settleChildRunReconcile(): Promise<void> {
    const pass = this.childRunReconcile;
    if (!pass) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pass.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.failureReportStopGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) log.warn("Automation run reconciliation still in flight at shutdown; the next start resumes it");
  }

  private async settleFailureReportLoop(): Promise<void> {
    const loop = this.failureReportLoop;
    if (!loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      loop.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.failureReportStopGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) log.warn("Cron failure report still in flight at shutdown; it stays pending for the next start");
  }

  /**
   * Stop the cron runner.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.runtimeEventStream && !this.failureReportLoop && !this.runtimeEventStopFailures.length)
      return;
    this.running = false;

    log.info("Stopping cron runner");

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.childRunTimer) {
      clearInterval(this.childRunTimer);
      this.childRunTimer = null;
    }
    // A pass in flight stops between runs once `running` is false. Waited for as briefly as the failure
    // reports (a notice may hold a chat for 30 s; the daemon stops components inside one 15 s guard):
    // an unfinished pass keeps its state persisted and the next start reconciles again.
    await this.settleChildRunReconcile();

    this.runtimeEventAbort?.abort();
    if (this.runtimeEventStream) {
      try {
        await this.runtimeEventStream.return?.(undefined);
      } catch (cause) {
        this.runtimeEventStopFailures.push(new Error("Cron runtime subscription close failed", { cause }));
      }
    }
    await this.runtimeEventLoop;
    await this.settleFailureReportLoop();
    if (this.runtimeEventStopFailures.length) {
      throw new AggregateError(this.runtimeEventStopFailures, "Cron runner shutdown failed", {
        cause: this.runtimeEventStopFailures[0],
      });
    }
    this.runtimeEventStream = null;
    this.runtimeEventAbort = null;
    this.runtimeEventLoop = null;
    this.failureReportLoop = null;

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

    // Reconcile all enabled jobs, including distant and unscheduled legacy rows.
    for (const job of dbListCronJobs()) this.reconcileOwnership(job);

    // Find next job to run
    const nextJob = dbGetNextDueJob();
    if (!nextJob || !nextJob.nextRunAt) {
      log.debug("No jobs scheduled, timer idle");
      return;
    }

    const delay = Math.min(2_147_483_647, Math.max(0, nextJob.nextRunAt - Date.now()));
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
        await this.executeJob(job, true);
      }
    } finally {
      this.processing = false;
      // Re-arm timer for next job
      this.armTimer();
    }
  }

  /**
   * Execute a single job.
   *
   * Agent jobs are asynchronous: the prompt is published to the session work
   * queue and the job is only marked as dispatched here. The ok/error outcome
   * is recorded by `handleRuntimeEvent` when the agent turn terminates, so a
   * turn that fails (e.g. provider rejects the model) surfaces as an error
   * instead of a healthy run.
   */
  private async executeJob(job: CronJob, scheduled = false): Promise<void> {
    // Recheck immediately before execution (manual runs and ownership changes
    // since the timer was armed follow the same rule).
    const current = dbGetCronJob(job.id);
    if (!current || (scheduled && !current.enabled) || !this.reconcileOwnership(current)) return;
    job = current;
    const authority = captureRunAuthority(job);
    const startTime = Date.now();
    log.info("Executing job", {
      jobId: job.id,
      jobName: job.name,
      executionType: job.executionType,
      sessionTarget: job.sessionTarget,
    });

    if (job.executionType === "shell") {
      await this.executeShellJob(job, startTime, authority);
      return;
    }

    if (scheduled && job.sessionTarget === "thread" && (await this.threadRunStillOpen(job, startTime))) {
      // One run at a time: a slow run never piles up open children. A manual run still goes.
      dbSetJobNextRun(job.id, this.calculateFollowupRun(job, startTime));
      log.info("Thread run skipped; the previous run is still open", { jobId: job.id, jobName: job.name });
      return;
    }

    const runId = randomUUID();
    try {
      const sessionName =
        job.sessionTarget === "thread"
          ? await this.executeThreadJob(job, startTime, authority, runId)
          : job.sessionTarget === "main"
            ? await this.executeMainJob(job, startTime, authority, runId)
            : await this.executeIsolatedJob(job, startTime, authority, runId);

      log.info("Job dispatched", { jobId: job.id, jobName: job.name, sessionName });

      // One-shots stay inspectable until their turn actually succeeds.
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      const run = getCronRun(runId);
      if (run) {
        await this.recordTurnOutcome({
          kind: "failed",
          sessionName: run.session_name,
          provenance: "cron",
          jobId: job.id,
          runId,
          error: errorMessage,
        });
      } else {
        dbUpdateJobState(job.id, {
          lastRunAt: startTime,
          lastStatus: "error",
          lastError: errorMessage,
          lastDurationMs: Date.now() - startTime,
          nextRunAt: this.calculateFollowupRun(job, startTime),
        });
        await notifyCronFailure(
          { ...job, ownerPrincipal: authority.ownerPrincipal, lastRunAt: startTime, runId },
          errorMessage,
        );
      }

      log.error("Job dispatch failed", { jobId: job.id, jobName: job.name, error: errorMessage });
    }
  }

  /** Only durable per-run provenance can attribute a terminal event. */
  async handleRuntimeEvent(event: { topic: string; data: unknown }): Promise<void> {
    const outcome = parseCronTurnOutcome(event);
    if (outcome?.provenance === "cron" && outcome.jobId && outcome.runId) await this.recordTurnOutcome(outcome);
  }

  private async recordTurnOutcome(outcome: CronTurnOutcome): Promise<void> {
    if (!outcome.runId) return;
    const pending = getCronRun(outcome.runId);
    if (!pending || pending.job_id !== outcome.jobId) return;
    if (pending.session_name !== outcome.sessionName) {
      // A visible run was admitted under its placeholder; the core row knows the session its surface
      // bound (on whichever daemon made the thread). Anything else is not this run's turn.
      if (pending.session_name !== pendingChildRunSession(pending.id)) return;
      if (getChildRun(pending.id)?.childSessionName !== outcome.sessionName) return;
      if (!rebindCronRunSession(pending.id, pending.session_name, outcome.sessionName)) return;
    }
    const state = buildCronTurnOutcomeState(outcome, { dispatchedAt: pending.admitted_at });
    const settled = settleCronRun(pending.id, outcome.sessionName, state);
    if (!settled) return;
    if (state.lastStatus === "error") {
      if (await notifyCronFailure(cronRunNotification(settled), state.lastError ?? "Agent turn failed"))
        markCronRunReported(settled.id);
    }
    // After the owner's notice: a parent that cannot be reached never delays it.
    try {
      await this.finishThreadRun(settled.id, state);
    } catch (error) {
      log.warn("Failed to close a thread run after its turn", {
        runId: settled.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log[state.lastStatus === "ok" ? "info" : "warn"]("Job turn finished", {
      jobId: settled.job_id,
      runId: settled.id,
      sessionName: outcome.sessionName,
      outcome: outcome.kind,
      status: state.lastStatus,
      durationMs: state.lastDurationMs,
    });
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
    const diskHint = classifyDiskPressureHint(stderr, result.stdout, result.command);
    const base = stderr
      ? `Shell command failed with ${exit}: ${this.truncateForPrompt(stderr)}`
      : `Shell command failed with ${exit}`;
    return diskHint ? `${base} [disk-pressure] ${diskHint}` : base;
  }

  private async notifyShellError(
    job: CronJob,
    result: ShellCronRunResult,
    errorMessage: string,
    authority: CronRunAuthority,
  ): Promise<void> {
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
    const diskHint = classifyDiskPressureHint(stderr, result.stdout, result.command);
    const prompt = [
      `[System] Inform: [from: cron:${job.id}] Cron shell job failed.`,
      "",
      `Job: ${job.name}`,
      `Command: ${job.shellCommand ?? result.command}`,
      `Error: ${errorMessage}`,
      diskHint ? `Disk pressure: ${diskHint}` : "",
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
      _cronAuthority: authority,
      _cronOnError: true,
    });
  }

  private async executeShellJob(job: CronJob, startTime: number, authority: CronRunAuthority): Promise<void> {
    try {
      if (!job.shellCommand?.trim()) {
        throw new Error("Shell cron job is missing shellCommand");
      }
      const timeoutMs = job.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS;
      // An operator-owned run gets a short-lived context, so `ravi ...` in the
      // command reaches the daemon's gateway and acts for the job's owner.
      const shellContext = issueShellCronContext(job, authority, timeoutMs);
      const contextKey = shellContext?.context.contextKey;
      let result: ShellCronRunResult;
      try {
        result = await runShellCronCommand(job.shellCommand, {
          timeoutMs,
          envFile: job.shellEnvFile,
          // Wins over the env file: the command acts for this job (and its
          // owner), never as the operator's terminal.
          env: {
            ...spawnedAutomationEnv("cron", job.id),
            [CRON_RUN_AUTHORITY_ENV]: JSON.stringify(authority),
            ...(contextKey ? { [RAVI_CONTEXT_KEY_ENV]: contextKey } : {}),
          },
        });
      } finally {
        shellContext?.release();
      }
      // The key never reaches a log, a stored error or a notice, even if the
      // command printed its environment.
      result = {
        ...result,
        stdout: redactContextKey(result.stdout, contextKey),
        stderr: redactContextKey(result.stderr, contextKey),
      };

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
          await this.notifyShellError(job, result, errorMessage, authority);
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      const diskHint = classifyDiskPressureHint(rawMessage, job.shellCommand);
      const errorMessage = diskHint ? `${rawMessage} [disk-pressure] ${diskHint}` : rawMessage;
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
              stderr: rawMessage,
              durationMs: Date.now() - startTime,
              timedOut: false,
            },
            errorMessage,
            authority,
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

  /** Invalid ownership is configuration state, not a failed execution. */
  private reconcileOwnership(job: CronJob): boolean {
    const code = cronOwnershipError(job);
    if (!code) return true;
    if (dbDisableShellJobForOwner(job)) {
      // The persisted transition is the notice claim, including across reloads
      // and competing runners. Never include the command, env or output here.
      log.error("Shell cron disabled: owner is not the operator", { jobId: job.id, code });
      // Told to the operator alone by direct message, no model in the path: the
      // owner does not act as the operator (it can be a contact) and cannot act
      // on it. The main session's prompt, which is the operator's, is the
      // fallback when that message does not reach them. The authority is read
      // now, at the transition: the fallback runs after the awaited delivery,
      // and the owner's operator link can change meanwhile.
      const authority = captureRunAuthority(job);
      void notifyAutomationOff({
        kind: "cron",
        id: job.id,
        name: job.name,
        ownerPrincipal: job.ownerPrincipal,
        code,
        reason:
          "O dono dele não age como o operador, e um comando de shell roda com o acesso desta máquina. Nenhum comando foi executado e nenhuma nova execução está agendada.",
        next: `Veja com ravi cron show ${job.id}. O operador pode recriá-lo a partir do próprio chat com o Ravi ou convertê-lo em um job de agente.`,
        audience: "operator",
        fallback: () => {
          const agentId = getDefaultAgentId();
          const sessionName = getMainSession(agentId)?.name ?? agentId;
          return publishSessionPrompt(sessionName, {
            prompt: `[System] Inform: [from: cron:${job.id}] Shell cron disabled (${code}). Its owner does not act as the operator. No command was executed and no retry is scheduled. Inspect with ravi cron show ${job.id}. The operator can recreate it or convert it to an agent job.`,
            deliveryBarrier: "after_response",
            deliveryBarrierSource: "default",
            _cron: true,
            _jobId: job.id,
            _cronAuthority: authority,
            _cronOnError: true,
          });
        },
      }).catch((error) => {
        log.error("Failed to send cron ownership notice; job remains disabled", {
          jobId: job.id,
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return false;
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
    // A trigger's own session runs that trigger's fires only: a job whose
    // reply session is one runs in the agent's main session instead.
    if (isTriggerOwnSessionKey(session?.sessionKey)) return null;
    return session?.name ?? null;
  }

  /**
   * Execute a job in the main session (shared with TUI/WhatsApp/etc).
   * If replySession is set, uses that session instead of agent main.
   * Returns the session name the prompt was published to.
   */
  private async executeMainJob(
    job: CronJob,
    startTime: number,
    authority: CronRunAuthority,
    runId: string,
  ): Promise<string> {
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

    this.trackAgentDispatch(job, sessionName, startTime, runId);
    await publishSessionPrompt(sessionName, {
      prompt,
      source: markCronSourceAsBackground(source),
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _cron: true,
      _jobId: job.id,
      _cronAuthority: authority,
      _cronRunId: runId,
    });
    return sessionName;
  }

  /**
   * Execute a job in an isolated session.
   * Returns the session name the prompt was published to.
   */
  private async executeIsolatedJob(
    job: CronJob,
    startTime: number,
    authority: CronRunAuthority,
    runId: string,
  ): Promise<string> {
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

    this.trackAgentDispatch(job, sessionName, startTime, runId);
    await publishSessionPrompt(sessionName, {
      prompt,
      source: markCronSourceAsBackground(source),
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _cron: true,
      _jobId: job.id,
      _cronAuthority: authority,
      _cronRunId: runId,
    });
    return sessionName;
  }

  /**
   * Execute a job in thread mode: a fresh child session that only this run
   * enters, parented to the job's report-to session. The prompt carries the
   * job's own authority, exactly as in the other modes; the run reaches its
   * parent only through `sessions report` / `close-thread --return`, or the
   * automatic return when its turn ends (`finishThreadRun`).
   */
  private async executeThreadJob(
    job: CronJob,
    startTime: number,
    authority: CronRunAuthority,
    runId: string,
  ): Promise<string> {
    const agentId = job.agentId ?? getDefaultAgentId();
    const parent = this.resolveThreadParent(job, agentId);
    const parentName = parent.name ?? parent.sessionKey;
    const launch = {
      prompt: this.buildThreadRunPrompt(job, parentName),
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _cron: true,
      _jobId: job.id,
      _cronAuthority: authority,
      _cronRunId: runId,
    };
    const surface = childRunSurfaceFor(parent);
    if (surface) {
      // A visible run (a Slack thread under the parent's chat): its session is made when the thread
      // lands, and the launch above is published there then. Until bound, it goes by a placeholder.
      const pending = pendingChildRunSession(runId);
      this.trackAgentDispatch(job, pending, startTime, runId);
      const run = openChildRun({
        id: runId,
        originKind: "cron",
        originId: job.id,
        originName: job.name,
        agentId,
        parentSessionKey: parent.sessionKey,
        parentSessionName: parentName,
        childSessionKey: pending,
        childSessionName: pending,
        surface: surface.id,
        surfaceRef: `${surface.id}:${runId}`,
        launch,
        now: startTime,
      });
      await surface.open({ run, parent, title: `Execução do cron “${job.name}”` });
      return pending;
    }
    const agent = getAgent(agentId);
    const agentCwd = agent ? expandHome(agent.cwd) : `/tmp/ravi-${agentId}`;
    const childKey = `agent:${agentId}:cron:${job.id}:run:${runId}`;
    // Named after the whole run id, never truncated: a run never takes the name, and so the
    // history, of an earlier run whose session was pruned.
    const childName = ensureUniqueName(`${slugify(agentId).slice(0, 24)}-run-${runId}`);
    const session = getOrCreateSession(childKey, agentId, agentCwd, { name: childName });
    if (!session.name) updateSessionName(session.sessionKey, childName);
    // Admitted first: a failure from here on settles the run, which closes its child.
    this.trackAgentDispatch(job, childName, startTime, runId);
    openChildRun({
      id: runId,
      originKind: "cron",
      originId: job.id,
      originName: job.name,
      agentId,
      parentSessionKey: parent.sessionKey,
      parentSessionName: parentName,
      childSessionKey: childKey,
      childSessionName: childName,
      now: startTime,
    });

    // No source: a headless run's replies reach no chat, only its returns reach the parent.
    await publishSessionPrompt(childName, launch);
    return childName;
  }

  /**
   * Whether the job's previous run is still open. A run open longer than
   * `THREAD_RUN_STALE_MS` (its turn's end was never seen) is closed as failed
   * first, its parent told once, so the job is never stuck behind it.
   */
  private async threadRunStillOpen(job: CronJob, now: number): Promise<boolean> {
    let stillOpen = false;
    for (const run of listOpenChildRuns("cron", job.id)) {
      if (now - run.createdAt < THREAD_RUN_STALE_MS) {
        stillOpen = true;
        continue;
      }
      try {
        await closeChildRun(run, {
          kind: "error",
          text: `The run did not end within ${THREAD_RUN_STALE_MS / 60_000} min; it was closed so the job can run again.`,
        });
      } catch (error) {
        log.warn("Failed to return a stale run's error to its parent", {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await releaseChildRunRuntime(run, "cron-runner");
    }
    return stillOpen;
  }

  /**
   * The session a thread-mode run reports to: the job's reply session, else
   * the agent's main session. It must be one of the job agent's own sessions;
   * a trigger's own session never is one.
   */
  private resolveThreadParent(job: CronJob, agentId: string): SessionEntry {
    const ref = job.replySession ?? this.resolveMainSessionName(agentId);
    const parent = resolveSession(ref);
    if (!parent || isTriggerOwnSessionKey(parent.sessionKey)) {
      throw new Error(
        `THREAD_PARENT_MISSING: the session this run reports to (${ref}) does not resolve. Set it with: ravi cron set ${job.id} reply-session <session>`,
      );
    }
    if (parent.agentId !== agentId) {
      throw new Error(
        `THREAD_PARENT_OTHER_AGENT: the session this run reports to (${parent.name ?? parent.sessionKey}) belongs to agent ${parent.agentId}, not to the job's agent ${agentId}`,
      );
    }
    const refusal = childRunParentRefusal(parent);
    if (refusal) {
      throw new Error(
        `THREAD_PARENT_UNSTABLE: ${refusal}. Set the session runs report to with: ravi cron set ${job.id} reply-session <session>`,
      );
    }
    return parent;
  }

  private buildThreadRunPrompt(job: CronJob, parentName: string): string {
    return [`[Cron: ${job.name} ${this.formatNow()}]`, job.message, "", childRunPromptNote(parentName)].join("\n");
  }

  /**
   * A thread-mode run closes when its turn ends, unless it already did: a
   * reply that is not silent reaches the parent once, silence closes without
   * a word, a failed turn sends one error. Then the child's runtime is
   * released and the job's oldest closed runs are pruned.
   */
  private async finishThreadRun(runId: string, state: JobOutcomeUpdate): Promise<void> {
    const run = getChildRun(runId);
    if (!run) return;
    await closeChildRunAfterTurn(
      run,
      { failed: state.lastStatus === "error", error: state.lastError },
      {
        describeFailure: describeCronFailure,
        details: `Detalhes para o operador: ravi cron show ${run.originId}`,
        releaseSource: "cron-runner",
      },
    );
  }

  private trackAgentDispatch(job: CronJob, sessionName: string, startTime: number, runId: string): void {
    // Register before publish: a launch failure may arrive before its ack.
    admitCronRun(runId, job, sessionName, startTime, this.calculateFollowupRun(job, startTime));
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

  /**
   * Subscribe to runtime terminal events for every session. Runtime events are
   * core pub/sub, so the leader daemon observes turns processed by any daemon.
   */
  private async subscribeToRuntimeEvents(): Promise<void> {
    log.debug("Subscribing to runtime turn events", { topic: CRON_RUNTIME_EVENTS_TOPIC });
    const controller = new AbortController();
    const stream = nats.subscribe(CRON_RUNTIME_EVENTS_TOPIC, { signal: controller.signal });
    this.runtimeEventStream = stream;
    this.runtimeEventAbort = controller;

    try {
      for await (const event of stream) {
        if (!this.running) break;
        try {
          await this.handleRuntimeEvent(event);
        } catch (err) {
          if (!this.running)
            this.runtimeEventStopFailures.push(new Error("Cron turn outcome failed during shutdown", { cause: err }));
          log.error("Failed to record cron turn outcome", { topic: event.topic, error: err });
        }
      }
    } catch (err) {
      if (!this.running || this.runtimeEventStream !== stream) {
        this.runtimeEventStopFailures.push(
          new Error("Cron runtime subscription failed during shutdown", { cause: err }),
        );
        return;
      }
      log.error("Runtime event subscription error", { error: err });
      this.runtimeEventStream = null;
      setTimeout(() => {
        if (this.running && !this.runtimeEventStream) this.runtimeEventLoop = this.subscribeToRuntimeEvents();
      }, 5000);
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

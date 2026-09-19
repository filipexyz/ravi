/**
 * Runner de jobs: quem é dono do processo.
 *
 * O job é despachado pelo daemon (líder), não pelo processo do CLI. É isso que
 * permite destacar o comando, observar o desfecho e entregá-lo na sessão muito
 * depois de o pedido ter sido feito.
 *
 * O CLI só cria o registro e publica `ravi.jobs.start`. Se ninguém estiver escutando
 * (daemon fora), o job fica `pending` e é liquidado no próximo start.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { dbFinishJob, dbGetJob, dbListJobs, dbListRunningJobs, dbMarkJobNotified, dbMarkJobRunning } from "./store.js";
import { isJobTerminal, type JobRecord } from "./types.js";

const log = logger.child("jobs:runner");

export const JOB_START_TOPIC = "ravi.jobs.start";
export const JOB_KILL_TOPIC = "ravi.jobs.kill";

/** Depois disso, quem ignorou SIGTERM recebe SIGKILL. */
export const KILL_ESCALATION_MS = 5_000;

/** Tail que acompanha o aviso de conclusão. Suficiente para decidir, não para afogar. */
export const JOB_RESULT_TAIL_CHARS = 2_000;

export interface JobsRunnerOptions {
  /** Injetável para teste. */
  spawnCommand?: (
    command: string,
    cwd: string | null,
    logPath: string,
  ) => { pid: number | null; onExit: (cb: (code: number | null, signal: string | null) => void) => void };
  notifySession?: (job: JobRecord, summary: string) => Promise<void>;
  now?: () => number;
}

interface SpawnedJob {
  pid: number | null;
}

export class JobsRunner {
  private running = false;
  private readonly jobs = new Map<string, SpawnedJob>();
  private subscription: { unsubscribe?: () => void } | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private readonly spawnCommand: NonNullable<JobsRunnerOptions["spawnCommand"]>;
  private readonly notify: NonNullable<JobsRunnerOptions["notifySession"]>;

  constructor(options: JobsRunnerOptions = {}) {
    this.spawnCommand = options.spawnCommand ?? defaultSpawnCommand;
    this.notify = options.notifySession ?? defaultNotifySession;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Jobs que ficaram pendentes/rodando de um daemon anterior.
    await this.reconcileOrphans();

    this.subscription = nats.subscribe(JOB_START_TOPIC) as unknown as { unsubscribe?: () => void };
    void this.consumeStartRequests();
    void this.consumeKillRequests();

    this.reconcileTimer = setInterval(() => {
      void this.reconcileOrphans();
    }, 30_000);
    this.reconcileTimer.unref?.();
    log.info("Jobs runner started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.subscription?.unsubscribe?.();
    this.subscription = undefined;
    log.info("Jobs runner stopped", { tracked: this.jobs.size });
  }

  /** Marca rodando e começa a observar o desfecho. */
  startJob(jobId: string): boolean {
    if (!this.running) return false;
    const job = dbGetJob(jobId);
    if (!job || isJobTerminal(job.status)) return false;
    if (this.jobs.has(jobId)) return true;

    let spawned: { pid: number | null; onExit: (cb: (code: number | null, signal: string | null) => void) => void };
    try {
      spawned = this.spawnCommand(job.command, job.cwd, job.logPath);
    } catch (error) {
      dbFinishJob(jobId, { status: "failed", exitCode: null, signal: null });
      appendFileSync(
        job.logPath,
        `\n[jobs] falha ao iniciar: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      log.warn("Job failed to spawn", { jobId, error });
      return false;
    }

    dbMarkJobRunning(jobId, spawned.pid);
    this.jobs.set(jobId, { pid: spawned.pid });

    spawned.onExit((exitCode, signal) => {
      this.jobs.delete(jobId);
      const status = signal ? "killed" : exitCode === 0 ? "succeeded" : "failed";
      dbFinishJob(jobId, { status, exitCode, signal });
      const finished = dbGetJob(jobId);
      if (!finished) return;
      log.info("Job finished", { jobId, status, exitCode, signal, sessionName: finished.sessionName });
      void this.deliverOutcome(finished);
    });

    log.info("Job started", { jobId, pid: spawned.pid, sessionName: job.sessionName, origin: job.origin });
    return true;
  }

  /** Entrega o desfecho na sessão que pediu. Sem sessão, não há para quem avisar. */
  private async deliverOutcome(job: JobRecord): Promise<void> {
    if (!job.sessionName) return;
    try {
      await this.notify(job, buildJobOutcomeSummary(job));
      dbMarkJobNotified(job.id);
    } catch (error) {
      log.warn("Could not deliver job outcome to session", { jobId: job.id, sessionName: job.sessionName, error });
    }
  }

  async killJob(jobId: string): Promise<boolean> {
    const job = dbGetJob(jobId);
    if (!job || isJobTerminal(job.status)) return false;
    const pid = this.jobs.get(jobId)?.pid ?? job.pid ?? null;
    if (!pid) {
      dbFinishJob(jobId, { status: "killed", exitCode: null, signal: "SIGTERM" });
      return true;
    }
    const signalled = killProcessGroup(pid);
    if (!signalled) return false;
    // SIGTERM não é garantia: um processo que ignora o sinal deixaria o job
    // "running" para sempre, e o desfecho nunca chegaria na sessão.
    const escalation = setTimeout(() => {
      if (isPidAlive(pid)) killProcessGroup(pid, "SIGKILL");
    }, KILL_ESCALATION_MS);
    escalation.unref?.();
    return true;
  }

  private async reconcileOrphans(): Promise<void> {
    for (const job of dbListRunningJobs()) {
      if (this.jobs.has(job.id)) continue;
      if (job.status === "pending") {
        // Pedido feito com o daemon fora: assume agora.
        this.startJob(job.id);
        continue;
      }
      if (job.pid && isPidAlive(job.pid)) continue;
      dbFinishJob(job.id, { status: "failed", exitCode: null, signal: null });
      const finished = dbGetJob(job.id);
      if (finished && !finished.notifiedAt) {
        // O processo sumiu sem o daemon ver: entrega o que houver no log.
        await this.deliverOutcome(finished);
      }
    }
  }

  private async consumeKillRequests(): Promise<void> {
    for await (const event of nats.subscribe(JOB_KILL_TOPIC)) {
      if (!this.running) return;
      const data = event.data as { jobId?: string } | undefined;
      if (!data?.jobId) continue;
      const killed = await this.killJob(data.jobId);
      log.info("Job kill requested", { jobId: data.jobId, killed });
    }
  }

  private async consumeStartRequests(): Promise<void> {
    for await (const event of nats.subscribe(JOB_START_TOPIC)) {
      if (!this.running) return;
      const data = event.data as { jobId?: string } | undefined;
      if (!data?.jobId) continue;
      this.startJob(data.jobId);
    }
  }
}

/** Resumo curto + tail do log: o agente decide o próximo passo a partir disso. */
export function buildJobOutcomeSummary(job: JobRecord, tailChars = JOB_RESULT_TAIL_CHARS): string {
  const exit = job.exitCode === null ? "sem exit code" : `exit ${job.exitCode}`;
  const when = job.signal ? `sinal ${job.signal}` : exit;
  const header = `[System] Job ${job.id} terminou (${job.status}, ${when}).`;
  const tail = readJobTail(job.logPath, tailChars);
  const body = tail.trim() ? `\nÚltimas linhas:\n${tail.trim()}` : "\n(sem saída)";
  return `${header}${body}\nO turno não está bloqueado; siga com o próximo passo ou use \`ravi jobs tail ${job.id}\`.`;
}

export function readJobTail(logPath: string, maxChars = JOB_RESULT_TAIL_CHARS): string {
  if (!existsSync(logPath)) return "";
  try {
    const content = readFileSync(logPath, "utf8");
    if (content.length <= maxChars) return content;
    return content.slice(content.length - maxChars);
  } catch {
    return "";
  }
}

async function defaultNotifySession(job: JobRecord, summary: string): Promise<void> {
  if (!job.sessionName) return;
  await publishSessionPrompt(job.sessionName, {
    prompt: summary,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _jobOutcome: { jobId: job.id, status: job.status },
  });
}

function defaultSpawnCommand(command: string, cwd: string | null, logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  const child = spawn(command, {
    shell: true,
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", fd, fd],
    detached: process.platform !== "win32",
    env: process.env,
  });
  closeSync(fd);
  return {
    pid: child.pid ?? null,
    onExit: (callback: (code: number | null, signal: string | null) => void) => {
      child.on("close", (code, signal) => callback(code, signal));
      child.on("error", () => callback(null, null));
    },
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return true;
    }
  } catch {
    // cai no kill direto
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

let singleton: JobsRunner | null = null;

export function getJobsRunner(): JobsRunner {
  if (!singleton) singleton = new JobsRunner();
  return singleton;
}

export async function startJobsRunner(): Promise<void> {
  if (process.env.RAVI_JOBS_ENABLED === "0") {
    log.info("Jobs runner disabled by RAVI_JOBS_ENABLED=0");
    return;
  }
  await getJobsRunner().start();
}

export async function stopJobsRunner(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
}

export { dbListJobs };

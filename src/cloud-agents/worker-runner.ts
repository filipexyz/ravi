/**
 * Cloud worker runner (F4, "Daemon as executor"). Started by the daemon and
 * idle until `ravi cloud worker enable --execute`. Every 30 s, while enabled,
 * it reads this installation's assignments (`GET workers`: the self-hosted
 * environments of agents placed on this machine) and for each one:
 *
 * 1. without a local environment key: runs nothing (the Console keeps it
 *    `waiting_key`);
 * 2. with a key: keeps one `EnvironmentWorker` of the Anthropic SDK running
 *    (`@anthropic-ai/sdk/helpers/beta/environments`), which claims the
 *    environment's work and runs its tools (bash, files) in
 *    `~/.ravi/cloud-workers/<agentId>/work`, and heartbeats `online`;
 * 3. a worker that failed restarts after a backoff and sends no heartbeat
 *    meanwhile, so the Console marks it offline after 120 s and refuses its runs.
 *
 * Assignments that disappear stop their worker. Disabling the runner (`ravi
 * cloud worker disable`) stops them all on the next tick and heartbeats
 * `disabled` once, so the Console refuses their runs at once. Each tick writes
 * what it did to `~/.ravi/cloud-workers/runtime.json` for `ravi cloud worker
 * list`. The environment key goes to the provider only, never to the Console.
 */

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";

import { logger } from "../utils/logger.js";
import { openCloudAgentsSession, type CloudAgentsSession, type CloudAgentsSessionOptions } from "./client.js";
import { heartbeatCloudWorker, listCloudWorkers } from "./client-product.js";
import type { CloudWorker } from "./types.js";
import {
  type CloudWorkerRuntime,
  cloudWorkerWorkdir,
  readCloudWorkerKey,
  readCloudWorkerState,
  writeCloudWorkerRuntime,
} from "./worker-store.js";

const log = logger.child("cloud-agents:worker-runner");

export const CLOUD_WORKER_HEARTBEAT_MS = 30_000;
const RESTART_BACKOFF_MIN_MS = 30_000;
const RESTART_BACKOFF_MAX_MS = 15 * 60_000;

export interface StartEnvironmentWorkerInput {
  environmentId: string;
  environmentKey: string;
  workdir: string;
  /** A name for this machine's worker, reported to the provider. */
  workerName: string;
  signal: AbortSignal;
}

/** Runs one environment worker until `signal` aborts (resolves) or it fails (rejects). */
export type StartEnvironmentWorker = (input: StartEnvironmentWorkerInput) => Promise<void>;

export interface CloudWorkerRunnerOptions {
  intervalMs?: number;
  openSession?: (options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>;
  startWorker?: StartEnvironmentWorker;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface CloudWorkerTickResult {
  status: "disabled" | "skipped" | "ran";
  reason?: "no_login" | "console_error";
  assignments: number;
  running: number;
  started: number;
  stopped: number;
  waitingKey: number;
  /** Workers waiting out a restart backoff (no heartbeat: the Console marks them offline). */
  backoff: number;
  heartbeats: number;
  errors: number;
}

interface RunningWorker {
  workerId: string;
  environmentId: string;
  key: string;
  controller: AbortController;
  done: Promise<void>;
}

interface WorkerHistory {
  failures: number;
  lastError: string | null;
  restartAt: number;
}

/** A provider error for the heartbeat: one line, bounded, never a key. */
function errorText(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(key).join("[key]").replace(/\s+/g, " ").trim().slice(0, 300) || "worker failed";
}

export class CloudWorkerRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<CloudWorkerTickResult> | null = null;
  private readonly intervalMs: number;
  private readonly workers = new Map<string, RunningWorker>();
  private readonly history = new Map<string, WorkerHistory>();
  /** Set while enabled; the first disabled tick after it reports `disabled` to the Console once. */
  private reportDisabled = false;

  constructor(private readonly options: CloudWorkerRunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? CLOUD_WORKER_HEARTBEAT_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting cloud worker runner", { intervalMs: this.intervalMs });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
    await this.stopAll();
    if (wasRunning) log.info("Stopped cloud worker runner");
  }

  /** Worker ids with a running environment worker. */
  runningWorkerIds(): string[] {
    return [...this.workers.keys()].sort();
  }

  /** One pass: reconcile the running workers with the assignments and heartbeat each. */
  async tick(): Promise<CloudWorkerTickResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error) => log.warn("Cloud worker tick failed", { error: errorText(error, "\u0000") }))
        .finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async runTick(): Promise<CloudWorkerTickResult> {
    const env = this.options.env ?? process.env;
    const result: CloudWorkerTickResult = {
      status: "ran",
      assignments: 0,
      running: 0,
      started: 0,
      stopped: 0,
      waitingKey: 0,
      backoff: 0,
      heartbeats: 0,
      errors: 0,
    };
    const open = this.options.openSession ?? ((options) => openCloudAgentsSession(options));
    if (!readCloudWorkerState(env).enabled) {
      result.stopped = await this.stopAll();
      // No Console call while the runner is off, except one `disabled` report right after it was on.
      if (this.reportDisabled) {
        this.reportDisabled = false;
        const session = await open({ resolveProject: false }).catch(() => null);
        const assignments = session ? await listCloudWorkers(session.client).catch(() => []) : [];
        for (const worker of session ? this.ours(assignments, session) : []) {
          if (await this.heartbeat(session!, worker.id, { status: "disabled" })) result.heartbeats += 1;
          else result.errors += 1;
        }
      }
      this.writeRuntime(env, {});
      return { ...result, status: "disabled" };
    }
    this.reportDisabled = true;
    const session = await open({ resolveProject: false });
    if (!session) {
      result.stopped = await this.stopAll();
      this.writeRuntime(env, {});
      return { ...result, status: "skipped", reason: "no_login" };
    }
    let assignments: CloudWorker[];
    try {
      assignments = await listCloudWorkers(session.client);
    } catch (error) {
      // A Console hiccup leaves the running workers alone; the next tick retries.
      log.warn("Could not read cloud worker assignments", { error: errorText(error, "\u0000") });
      return { ...result, status: "skipped", reason: "console_error", running: this.workers.size, errors: 1 };
    }
    const ours = this.ours(assignments, session);
    result.assignments = ours.length;
    const wanted = new Set<string>();
    const runtime: CloudWorkerRuntime["workers"] = {};
    for (const worker of ours) {
      if (!worker.providerEnvironmentId) continue;
      const key = readCloudWorkerKey(worker.id, env);
      if (!key) {
        if (await this.stopOne(worker.id)) result.stopped += 1;
        result.waitingKey += 1;
        runtime[worker.id] = { state: "waiting_key", error: null, restartAt: null };
        continue;
      }
      wanted.add(worker.id);
      const current = this.workers.get(worker.id);
      if (current && (current.key !== key || current.environmentId !== worker.providerEnvironmentId)) {
        await this.stopOne(worker.id);
        this.history.delete(worker.id);
        result.stopped += 1;
      }
      if (!this.workers.has(worker.id)) {
        const history = this.history.get(worker.id);
        if (!history || this.now() >= history.restartAt) {
          this.launch(worker, key, env);
          result.started += 1;
        }
      }
      const history = this.history.get(worker.id);
      if (this.workers.has(worker.id)) {
        runtime[worker.id] = { state: "running", error: history?.lastError ?? null, restartAt: null };
        if (await this.heartbeat(session, worker.id, { status: "online" })) result.heartbeats += 1;
        else result.errors += 1;
      } else {
        // Waiting out the restart backoff: no heartbeat, so the Console marks it offline and refuses its runs.
        result.backoff += 1;
        runtime[worker.id] = {
          state: "backoff",
          error: history?.lastError ?? null,
          restartAt: history ? new Date(history.restartAt).toISOString() : null,
        };
      }
    }
    for (const id of [...this.workers.keys()]) {
      if (!wanted.has(id) && (await this.stopOne(id))) result.stopped += 1;
    }
    result.running = this.workers.size;
    this.writeRuntime(env, runtime);
    return result;
  }

  /** The assignments of this installation (the Console lists only the caller's; the filter is a guard). */
  private ours(assignments: CloudWorker[], session: CloudAgentsSession): CloudWorker[] {
    return assignments.filter((worker) => !worker.installationId || worker.installationId === session.installationId);
  }

  private writeRuntime(env: NodeJS.ProcessEnv, workers: CloudWorkerRuntime["workers"]): void {
    try {
      writeCloudWorkerRuntime({ updatedAt: new Date(this.now()).toISOString(), workers }, env);
    } catch (error) {
      log.warn("Could not write the cloud worker runtime state", { error: errorText(error, "\u0000") });
    }
  }

  private launch(worker: CloudWorker, key: string, env: NodeJS.ProcessEnv): void {
    const controller = new AbortController();
    const start = this.options.startWorker ?? defaultStartEnvironmentWorker;
    const workdir = cloudWorkerWorkdir(worker.agentId || worker.id, env);
    log.info("Starting cloud environment worker", { workerId: worker.id, agent: worker.agentName });
    const entry: RunningWorker = {
      workerId: worker.id,
      environmentId: worker.providerEnvironmentId,
      key,
      controller,
      done: Promise.resolve(),
    };
    entry.done = Promise.resolve()
      .then(() =>
        start({
          environmentId: worker.providerEnvironmentId,
          environmentKey: key,
          workdir,
          workerName: `ravi-${hostname()}`.slice(0, 64),
          signal: controller.signal,
        }),
      )
      .then(
        () => {
          if (!controller.signal.aborted) this.recordFailure(worker.id, "The environment worker stopped.");
          else this.history.delete(worker.id);
        },
        (error) => {
          if (controller.signal.aborted) return;
          this.recordFailure(worker.id, errorText(error, key));
        },
      )
      .finally(() => {
        if (this.workers.get(worker.id) === entry) this.workers.delete(worker.id);
      });
    this.workers.set(worker.id, entry);
  }

  private recordFailure(workerId: string, message: string): void {
    const previous = this.history.get(workerId);
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = Math.min(RESTART_BACKOFF_MIN_MS * 2 ** (failures - 1), RESTART_BACKOFF_MAX_MS);
    this.history.set(workerId, { failures, lastError: message, restartAt: this.now() + backoff });
    log.warn("Cloud environment worker failed", { workerId, failures, error: message });
  }

  private async heartbeat(
    session: CloudAgentsSession,
    workerId: string,
    body: { status: "online" | "disabled"; error?: string | null },
  ): Promise<boolean> {
    try {
      await heartbeatCloudWorker(session.client, workerId, body);
      return true;
    } catch (error) {
      log.warn("Cloud worker heartbeat failed", { workerId, error: errorText(error, "\u0000") });
      return false;
    }
  }

  private async stopOne(workerId: string): Promise<boolean> {
    const entry = this.workers.get(workerId);
    if (!entry) return false;
    entry.controller.abort();
    this.workers.delete(workerId);
    await entry.done.catch(() => undefined);
    return true;
  }

  private async stopAll(): Promise<number> {
    let stopped = 0;
    for (const id of [...this.workers.keys()]) {
      if (await this.stopOne(id)) stopped += 1;
    }
    return stopped;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** The Anthropic SDK's environment worker: polls the environment's work with the key and runs its tools here. */
const defaultStartEnvironmentWorker: StartEnvironmentWorker = async (input) => {
  const [{ default: Anthropic }, { EnvironmentWorker }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@anthropic-ai/sdk/helpers/beta/environments"),
  ]);
  mkdirSync(input.workdir, { recursive: true, mode: 0o700 });
  // The environment key is the only credential: no organization API key is read from the environment.
  const client = new Anthropic({ apiKey: null, authToken: input.environmentKey });
  const worker = new EnvironmentWorker({
    client,
    environmentId: input.environmentId,
    environmentKey: input.environmentKey,
    workdir: input.workdir,
    workerId: input.workerName,
    signal: input.signal,
  });
  try {
    await worker.run(input.signal);
  } catch (error) {
    if (input.signal.aborted) return;
    throw error;
  }
};

let singleton: CloudWorkerRunner | null = null;

export function getCloudWorkerRunner(): CloudWorkerRunner {
  singleton ??= new CloudWorkerRunner();
  return singleton;
}

export async function startCloudWorkerRunner(): Promise<void> {
  await getCloudWorkerRunner().start();
}

export async function stopCloudWorkerRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}

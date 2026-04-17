/**
 * NATS Remote Spawn — runs Claude Code on a remote worker over NATS pub/sub
 *
 * Implements the SDK's SpawnedProcess interface by tunneling stdin/stdout through
 * NATS subjects. The worker on the remote VM receives the spawn request, starts
 * a Claude process, and bridges its I/O to the agreed subjects.
 *
 * Protocol subjects (workerId + spawnId are known before the worker starts):
 *   ravi.worker.{workerId}.spawn          — request-reply to initiate
 *   ravi.worker.{workerId}.{spawnId}.in   — stdin (local → worker)
 *   ravi.worker.{workerId}.{spawnId}.out  — stdout (worker → local)
 *   ravi.worker.{workerId}.{spawnId}.exit — exit event (worker → local)
 *   ravi.worker.{workerId}.{spawnId}.kill — kill signal (local → worker)
 */

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { StringCodec, type NatsConnection } from "nats";
import { getNats } from "./nats.js";
import { logger } from "./utils/logger.js";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const log = logger.child("nats-spawn");
const sc = StringCodec();

/** Inactivity timeout: if no stdout received for 60s, treat process as dead. */
const INACTIVITY_TIMEOUT_MS = 60_000;

/** Auth env vars forwarded to the remote worker. */
const FORWARDED_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * Filter SDK args for remote execution.
 * - Strips the local CLI entry point (cli.js / sdk.mjs)
 * - Removes --plugin-dir <path> (local paths won't exist on worker)
 * - Removes --setting-sources (project settings are local)
 */
function filterArgs(args: string[]): string[] {
  const filtered: string[] = [];
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const arg = args[i];

    // Skip the CLI entry point (first arg is usually a .js/.mjs path)
    if (i === 0 && (arg.endsWith(".js") || arg.endsWith(".mjs"))) {
      continue;
    }

    // Skip --plugin-dir <path> (local paths won't exist on worker)
    if (arg === "--plugin-dir") {
      skipNext = true;
      continue;
    }

    // Skip --setting-sources (project settings are local)
    if (arg === "--setting-sources") {
      skipNext = true;
      continue;
    }

    filtered.push(arg);
  }

  return filtered;
}

/**
 * SpawnedProcess implementation over NATS pub/sub.
 *
 * The spawnId is generated locally (UUID) and included in the spawn request so
 * the worker uses OUR spawnId — this lets us set up subscriptions before the
 * worker even acknowledges, eliminating any race condition on stdout/exit.
 */
export class NatsSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;

  private _killed = false;
  private _exitCode: number | null = null;
  private _inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private _ready = false;
  private _pendingChunks: { data: Uint8Array; callback: (err?: Error | null) => void }[] = [];
  private _pendingFinal = false;
  private _pendingKillSignal: NodeJS.Signals | null = null;

  private readonly outSub: ReturnType<NatsConnection["subscribe"]>;
  private readonly exitSub: ReturnType<NatsConnection["subscribe"]>;

  private readonly subjectIn: string;
  private readonly subjectOut: string;
  private readonly subjectExit: string;
  private readonly subjectKill: string;

  constructor(
    private readonly workerId: string,
    private readonly spawnId: string,
    private readonly nc: NatsConnection,
  ) {
    super();

    this.subjectIn = `ravi.worker.${workerId}.${spawnId}.in`;
    this.subjectOut = `ravi.worker.${workerId}.${spawnId}.out`;
    this.subjectExit = `ravi.worker.${workerId}.${spawnId}.exit`;
    this.subjectKill = `ravi.worker.${workerId}.${spawnId}.kill`;

    // --- stdin: Writable that publishes chunks as raw bytes ---
    // Buffers until ready() is called (after spawn reply confirms worker is listening)
    const self = this;
    this.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
          if (self._ready) {
            self.nc.publish(self.subjectIn, data);
            callback();
          } else {
            self._pendingChunks.push({ data, callback });
          }
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
      final(callback) {
        // Signal EOF by publishing a zero-length message
        try {
          if (self._ready) {
            self.nc.publish(self.subjectIn, new Uint8Array(0));
          } else {
            self._pendingFinal = true;
          }
        } catch {
          // Best-effort EOF signal
        }
        callback();
      },
    });

    // --- stdout: Readable fed from the out subscription ---
    const stdout = (this.stdout = new Readable({ read() {} }));

    // --- Subscribe to stdout subject ---
    const outSub = (this.outSub = nc.subscribe(this.subjectOut));
    this._startInactivityTimer();

    (async () => {
      for await (const msg of outSub) {
        if (msg.data.length === 0) {
          // EOF signal from worker
          stdout.push(null);
          break;
        }
        this._resetInactivityTimer();
        // Push raw bytes to the Readable
        stdout.push(Buffer.from(msg.data));
      }
    })().catch((err) => {
      if (!this._killed && this._exitCode === null) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    // --- Subscribe to exit subject ---
    const exitSub = (this.exitSub = nc.subscribe(this.subjectExit));

    (async () => {
      for await (const msg of exitSub) {
        try {
          const payload = JSON.parse(sc.decode(msg.data)) as {
            code: number | null;
            signal: string | null;
          };
          this._onExit(payload.code, (payload.signal as NodeJS.Signals | null) ?? null);
        } catch (err) {
          log.warn("Failed to parse exit payload", { spawnId, err });
          this._onExit(-1, null);
        }
        break; // Only process first exit event
      }
    })().catch((err) => {
      if (!this._killed && this._exitCode === null) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  get killed(): boolean {
    return this._killed;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this._killed || this._exitCode !== null) return false;
    try {
      if (this._ready) {
        this.nc.publish(this.subjectKill, sc.encode(JSON.stringify({ signal })));
      } else {
        this._pendingKillSignal = signal;
      }
      this._killed = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Signal that the worker is ready — flush any buffered stdin chunks. */
  ready(): void {
    if (this._exitCode !== null) return;
    this._ready = true;

    if (this._pendingKillSignal) {
      this._failPendingChunks(new Error("Remote process was killed before startup completed"));
      try {
        this.nc.publish(this.subjectKill, sc.encode(JSON.stringify({ signal: this._pendingKillSignal })));
      } catch {
        // Best-effort kill signal
      }
      this._pendingKillSignal = null;
      this._pendingFinal = false;
      return;
    }

    for (const { data, callback } of this._pendingChunks) {
      try {
        this.nc.publish(this.subjectIn, data);
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this._pendingChunks = [];

    if (this._pendingFinal) {
      try {
        this.nc.publish(this.subjectIn, new Uint8Array(0));
      } catch {
        // Best-effort EOF signal
      }
      this._pendingFinal = false;
    }
  }

  failStartup(error: Error): void {
    if (this._exitCode !== null) return;
    this.emit("error", error);
    this._failPendingChunks(error);
    this._onExit(1, null);
  }

  // ---- inactivity timer ----

  private _startInactivityTimer(): void {
    this._inactivityTimer = setTimeout(() => {
      if (this._exitCode === null) {
        log.warn("Inactivity timeout — no stdout for 60s", {
          workerId: this.workerId,
          spawnId: this.spawnId,
        });
        this._onExit(-1, null);
      }
    }, INACTIVITY_TIMEOUT_MS);

    // Don't let the timer prevent Node/Bun from exiting
    this._inactivityTimer.unref?.();
  }

  private _resetInactivityTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._startInactivityTimer();
    }
  }

  // ---- cleanup ----

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this._exitCode !== null) return; // guard double-fire

    this._exitCode = code;
    this._failPendingChunks(new Error("Remote process exited before pending stdin could be delivered"));
    this._pendingFinal = false;
    this._pendingKillSignal = null;

    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }

    // Drain subscriptions
    try {
      this.outSub.unsubscribe();
    } catch {
      /* best-effort */
    }
    try {
      this.exitSub.unsubscribe();
    } catch {
      /* best-effort */
    }

    // Push EOF to stdout if not already done
    try {
      this.stdout.push(null);
    } catch {
      /* best-effort */
    }

    log.info("Remote process exited", {
      workerId: this.workerId,
      spawnId: this.spawnId,
      code,
      signal,
    });

    this.emit("exit", code, signal);
  }

  private _failPendingChunks(error: Error): void {
    if (this._pendingChunks.length === 0) return;
    for (const { callback } of this._pendingChunks) {
      callback(error);
    }
    this._pendingChunks = [];
  }
}

/**
 * Factory: returns a spawnClaudeCodeProcess-compatible function that runs
 * Claude Code on the specified NATS worker.
 *
 * @param workerId - Worker identifier (e.g., a VM ID or hostname)
 */
export function createNatsRemoteSpawn(workerId: string): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const { args, cwd, env, signal } = options;

    const nc = getNats();
    const spawnId = randomUUID();

    const filteredArgs = filterArgs(args);

    // Forward only auth tokens — strip undefined values
    const forwardedEnv: Record<string, string> = {};
    for (const key of FORWARDED_ENV_KEYS) {
      const val = env[key];
      if (val !== undefined) forwardedEnv[key] = val;
    }

    log.info("Spawning NATS remote Claude process", {
      workerId,
      spawnId,
      filteredArgs,
      cwd,
    });

    // Create the process object immediately — subscriptions are wired up in the
    // constructor using the locally-generated spawnId, so no data is lost even
    // if the worker starts responding before we get the reply.
    const proc = new NatsSpawnedProcess(workerId, spawnId, nc);

    // Send spawn request asynchronously — the local spawnId is included so the
    // worker uses it instead of generating its own.
    const spawnSubject = `ravi.worker.${workerId}.spawn`;
    const spawnPayload = sc.encode(JSON.stringify({ args: filteredArgs, env: forwardedEnv, cwd, spawnId }));

    nc.request(spawnSubject, spawnPayload, { timeout: 30_000 })
      .then((reply) => {
        const response = JSON.parse(sc.decode(reply.data)) as
          | { ok: true; spawnId: string }
          | { ok: false; error: string };

        if (!response.ok) {
          log.error("Worker rejected spawn request", {
            workerId,
            spawnId,
            error: response.error,
          });
          proc.failStartup(new Error(`Worker spawn failed: ${response.error}`));
        } else {
          // Worker is ready — flush buffered stdin data
          log.debug("Worker acknowledged spawn, flushing stdin buffer", { workerId, spawnId });
          proc.ready();
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Spawn request failed", { workerId, spawnId, error: message });
        proc.failStartup(new Error(`NATS spawn request failed: ${message}`));
      });

    // Handle AbortSignal from the SDK
    if (signal) {
      const onAbort = () => {
        log.info("Aborting NATS remote process", { workerId, spawnId });
        proc.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      proc.once("exit", () => signal.removeEventListener("abort", onAbort));
    }

    return proc;
  };
}

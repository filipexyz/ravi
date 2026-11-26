import {
  findRejectedRuntimeStart,
  preserveRejectedRuntimeStart,
  runtimeStartReceiptKey,
} from "./start-admission-inbox.js";
import { RuntimeStartCapacityError } from "./start-admission.js";
import {
  RETAINED_START_RESUME_INTERVAL_MS,
  resumeRetainedStarts,
  type RetainedStartDecision,
} from "./start-admission-resume.js";
import { admitTaskDispatch } from "../tasks/dispatch-admission.js";
import { admitDecisionAnswer } from "../decisions/delivery.js";
import { admitThreadAttention } from "../channels/slack/thread-attention-admission.js";
import { StringCodec, type JsMsg } from "nats";
import { getNats, nats } from "../nats.js";
import {
  SESSION_STREAM,
  ensureSessionPromptInfrastructure,
  getConsumerName,
  type EnsureSessionPromptInfrastructureOptions,
} from "../omni/session-stream.js";
import { isSqliteCapacityError, SQLITE_CAPACITY_USER_MESSAGE } from "../db/write-retry.js";
import { logger } from "../utils/logger.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import type { RuntimeSessionPoolSnapshot } from "./session-pool.js";
import { formatUserFacingTurnFailure } from "./public-failure.js";

const log = logger.child("runtime:prompt-subscription");
const PROMPT_DISPATCH_RETRY_DELAY_MS = 5_000;
const PROMPT_ACK_PROGRESS_INTERVAL_MS = 30_000;
const START_CAPACITY_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export interface RuntimePromptSubscriptionOptions {
  isRunning(): boolean;
  canAcceptPrompt(sessionName: string): boolean;
  getStreamingSessionCount(): number;
  getRuntimeSessionPoolSnapshot?(): RuntimeSessionPoolSnapshot;
  ensurePromptInfrastructure?(options?: EnsureSessionPromptInfrastructureOptions): Promise<void>;
  promptAckProgressIntervalMs?: number;
  startCapacityRetryDelaysMs?: readonly number[];
  /** How often saved capacity refusals are retried; 0 disables the timer (tests drive it by hand). */
  retainedStartResumeIntervalMs?: number;
  markConsumerReady(): void;
  handlePrompt(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void>;
}

export class RuntimePromptSubscription {
  active = false;
  promptsReceived = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private resumeInFlight: Promise<RetainedStartDecision[]> | null = null;
  private healthProbeInFlight = false;
  private readonly sessionDispatchTails = new Map<string, Promise<void>>();

  constructor(private readonly options: RuntimePromptSubscriptionOptions) {}

  subscribe(): void {
    void this.run();
  }

  startHealthCheck(): void {
    this.startRetainedStartResume();
    const healthCheckIntervalMs = 30_000;
    this.healthTimer = setInterval(() => {
      if (!this.options.isRunning()) return;

      if (!this.active) {
        const runtimeSessionPool = this.options.getRuntimeSessionPoolSnapshot?.();
        log.warn("Subscriber health check: prompt subscription INACTIVE - forcing resubscribe", {
          promptsReceived: this.promptsReceived,
          streamingSessions: runtimeSessionPool?.active ?? this.options.getStreamingSessionCount(),
          runtimeSessionPoolLimit: runtimeSessionPool?.limit,
          pendingStarts: runtimeSessionPool?.pendingStarts,
        });
        this.emitRuntimeSessionPoolGauge(runtimeSessionPool);
        this.subscribe();
      } else {
        const runtimeSessionPool = this.options.getRuntimeSessionPoolSnapshot?.();
        log.debug("Subscriber health check: OK", {
          promptsReceived: this.promptsReceived,
          streamingSessions: runtimeSessionPool?.active ?? this.options.getStreamingSessionCount(),
          runtimeSessionPoolLimit: runtimeSessionPool?.limit,
          pendingStarts: runtimeSessionPool?.pendingStarts,
        });
        this.emitRuntimeSessionPoolGauge(runtimeSessionPool);
        this.ensurePromptInfrastructureForHealthCheck();
      }
    }, healthCheckIntervalMs);
  }

  stopHealthCheck(): void {
    if (this.resumeTimer) {
      clearInterval(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (!this.healthTimer) {
      return;
    }
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async run(): Promise<void> {
    if (this.active) {
      log.warn("Prompt subscription already active, skipping duplicate");
      return;
    }
    this.active = true;

    log.info("Subscribing to SESSION_PROMPTS JetStream stream");

    const sc = StringCodec();

    let intakeFenced = false;
    try {
      const nc = getNats();
      const js = nc.jetstream();

      const consumerName = getConsumerName();
      await this.ensurePromptInfrastructure({ force: true });

      while (this.options.isRunning()) {
        try {
          const consumer = await js.consumers.get(SESSION_STREAM, consumerName);
          const messages = await consumer.consume({
            expires: 2000,
            // The nats.js default keeps a consume loop alive while stream/consumer
            // resources are missing. Ravi owns this durable, so fail fast and let
            // the outer loop recreate the JetStream infrastructure.
            abort_on_missing_resource: true,
          });

          this.options.markConsumerReady();

          for await (const msg of messages) {
            if (!this.options.isRunning()) {
              msg.nak();
              break;
            }

            let prompt: RuntimeLaunchPrompt;
            try {
              const raw = sc.decode(msg.data);
              prompt = JSON.parse(raw) as RuntimeLaunchPrompt;
            } catch (err) {
              log.error("Failed to parse session prompt", {
                error: err,
                subject: msg.subject,
              });
              msg.nak();
              continue;
            }

            const sessionName = msg.subject.split(".")[2];
            let canAcceptPrompt = false;
            try {
              canAcceptPrompt = this.options.canAcceptPrompt(sessionName);
            } catch (error) {
              log.error("Failed to evaluate runtime prompt intake fence", {
                sessionName,
                error,
              });
            }
            if (!canAcceptPrompt) {
              intakeFenced = true;
              log.warn("Runtime prompt intake fenced before acknowledgement", {
                sessionName,
                subject: msg.subject,
              });
              msg.nak();
              break;
            }

            // Receipt is independent of both pool capacity and the session dispatch tail.
            // Keep event publication ordered before a possible immediate rejection.
            const receipt = this.emitPromptReceipt(sessionName, prompt);
            this.schedulePromptDispatch(sessionName, prompt, msg, receipt);
          }

          if (!this.options.isRunning() || intakeFenced) {
            break;
          }

          log.debug("Prompt pull window ended, renewing", {
            promptsReceived: this.promptsReceived,
          });
        } catch (err) {
          if (!this.options.isRunning()) {
            break;
          }

          if (isPromptBootstrapError(err)) {
            log.warn("Prompt pull unavailable during bootstrap, re-ensuring stream/consumer", { error: err });
            await this.ensurePromptInfrastructure({ force: true });
          } else {
            log.error("Prompt subscription error - will reconnect pull", {
              error: err,
            });
          }

          await delay(1000);
        }
      }
    } catch (err) {
      log.error("Prompt subscription setup error", { error: err });
    } finally {
      this.active = false;
      log.warn("Prompt subscription ended", {
        running: this.options.isRunning(),
        promptsReceived: this.promptsReceived,
      });
      if (this.options.isRunning() && !intakeFenced) {
        setTimeout(() => this.subscribe(), 1000);
      }
    }
  }

  private emitRuntimeSessionPoolGauge(snapshot: RuntimeSessionPoolSnapshot | undefined): void {
    if (!snapshot) return;
    nats
      .emit("ravi.runtime.session_pool.gauge", {
        ...snapshot,
        source: "prompt-subscription.health",
      })
      .catch((error) => {
        log.warn("Failed to emit runtime session pool gauge", { error });
      });
  }

  private schedulePromptDispatch(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    msg: JsMsg,
    receipt: Promise<void>,
  ): void {
    const previous = this.sessionDispatchTails.get(sessionName) ?? Promise.resolve();
    const progressTimer = setInterval(() => {
      try {
        msg.working();
      } catch (error) {
        log.warn("Failed to renew pending prompt acknowledgement", {
          sessionName,
          subject: msg.subject,
          error,
        });
      }
    }, this.options.promptAckProgressIntervalMs ?? PROMPT_ACK_PROGRESS_INTERVAL_MS);
    progressTimer.unref?.();

    let dispatch!: Promise<void>;
    dispatch = previous
      .then(async () => {
        await receipt;
        await this.dispatchPrompt(sessionName, prompt, msg);
      })
      .catch(async (error) => {
        await this.emitAdmissionRejected(sessionName, prompt, "dispatch_failed");
        log.error("Unexpected prompt dispatch lane failure", {
          sessionName,
          subject: msg.subject,
          error,
        });
        try {
          msg.nak(PROMPT_DISPATCH_RETRY_DELAY_MS);
        } catch (nakError) {
          log.warn("Failed to NAK prompt after dispatch lane failure", {
            sessionName,
            subject: msg.subject,
            error: nakError,
          });
        }
      })
      .finally(() => {
        clearInterval(progressTimer);
        if (this.sessionDispatchTails.get(sessionName) === dispatch) {
          this.sessionDispatchTails.delete(sessionName);
        }
      });
    this.sessionDispatchTails.set(sessionName, dispatch);
    void dispatch;
  }

  /** The same admission owners as live intake (thread attention, task, decision), then the session itself. */
  private async admitAndRun(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    run: (accepted: RuntimeLaunchPrompt) => Promise<void>,
  ): Promise<void> {
    if (
      !(await admitThreadAttention(sessionName, prompt, run)) &&
      !(await admitTaskDispatch(sessionName, prompt, run)) &&
      !(await admitDecisionAnswer(sessionName, prompt, (accepted) => this.options.handlePrompt(sessionName, accepted)))
    ) {
      await run(prompt);
    }
  }

  private startRetainedStartResume(): void {
    const intervalMs = this.options.retainedStartResumeIntervalMs ?? RETAINED_START_RESUME_INTERVAL_MS;
    if (intervalMs <= 0 || this.resumeTimer) return;
    this.resumeTimer = setInterval(() => {
      if (!this.options.isRunning() || !this.active) return;
      void this.resumeRetainedStarts().catch((error) => log.warn("Retained start resume pass failed", { error }));
    }, intervalMs);
    this.resumeTimer.unref?.();
  }

  /**
   * Retries requests saved for lack of capacity. Each one runs once, inside its session's dispatch lane so it
   * keeps order with live prompts, through the same admission owners as live intake and a single start attempt.
   */
  resumeRetainedStarts(): Promise<RetainedStartDecision[]> {
    if (this.resumeInFlight) return this.resumeInFlight;
    const pass = resumeRetainedStarts({
      runOnce: (sessionName, prompt) =>
        this.runInSessionLane(sessionName, () =>
          this.admitAndRun(sessionName, prompt, (accepted) => this.options.handlePrompt(sessionName, accepted)),
        ),
      emit: (topic, payload) => nats.emit(topic, payload),
    }).finally(() => {
      this.resumeInFlight = null;
    });
    this.resumeInFlight = pass;
    return pass;
  }

  private runInSessionLane(sessionName: string, work: () => Promise<void>): Promise<void> {
    const previous = this.sessionDispatchTails.get(sessionName) ?? Promise.resolve();
    // The previous item already reported its own failure to its caller; it must not block this one.
    const run = previous
      .catch((error) => log.debug("Earlier lane work failed; running the next item", { sessionName, error }))
      .then(work);
    // `run` carries this item's failure to its caller; the lane tail only needs to settle.
    const tail = run.catch((error) => log.debug("Resumed lane work failed", { sessionName, error }));
    this.sessionDispatchTails.set(sessionName, tail);
    void tail.finally(() => {
      if (this.sessionDispatchTails.get(sessionName) === tail) this.sessionDispatchTails.delete(sessionName);
    });
    return run;
  }

  private async handlePromptWithCapacityRetry(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
    const delays = this.options.startCapacityRetryDelaysMs ?? START_CAPACITY_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.options.handlePrompt(sessionName, prompt);
        return;
      } catch (error) {
        // Only this typed refusal proves that no provider handoff happened.
        // Decision receipts already have their own durable retry owner.
        if (
          !(error instanceof RuntimeStartCapacityError) ||
          prompt._decisionDeliveryId ||
          attempt >= delays.length ||
          !this.options.isRunning()
        )
          throw error;
        const retryDelayMs = delays[attempt]!;
        log.info("Retrying runtime admission before provider handoff", {
          sessionName,
          attempt: attempt + 1,
          retryDelayMs,
        });
        await nats
          .emit(`ravi.session.${sessionName}.runtime`, {
            type: "dispatch.start_retry",
            reason: error.capacity.reason,
            attempt: attempt + 1,
            retryDelayMs,
            providerHandoff: false,
            ...(prompt.source ? { _source: prompt.source } : {}),
            timestamp: new Date().toISOString(),
          })
          .catch((emitError) => log.warn("Failed to emit admission retry", { sessionName, error: emitError }));
        await delay(retryDelayMs);
        if (!this.options.isRunning()) throw error;
      }
    }
  }

  private async dispatchPrompt(sessionName: string, prompt: RuntimeLaunchPrompt, msg: JsMsg): Promise<void> {
    const info = msg.info;
    const key = runtimeStartReceiptKey(
      sessionName,
      prompt,
      `${info?.stream ?? SESSION_STREAM}:${info?.streamSequence ?? "unknown"}:${info?.timestampNanos ?? "unknown"}`,
    );
    // A redelivery after the inbox commit (e.g. a lost ACK) must not execute it.
    const retained = findRejectedRuntimeStart(key);
    if (retained) {
      msg.ack();
      await this.emitAdmissionRejected(sessionName, prompt, "retained_in_inbox", {
        receipt: retained.id,
        retainedBy: "inbox",
      });
      return;
    }
    try {
      // Keep the transport work item unacknowledged until the dispatcher has accepted
      // it. Provider/bootstrap failures can happen before a turn exists, so
      // acknowledging earlier loses the only retryable copy.
      await this.admitAndRun(sessionName, prompt, (accepted) =>
        this.handlePromptWithCapacityRetry(sessionName, accepted),
      );
    } catch (error) {
      if (error instanceof RuntimeStartCapacityError) {
        if (prompt._decisionDeliveryId) {
          // Decisions already own a durable, idempotent answer and retry scheduler.
          // Admission marked it failed before throwing; do not create a second recovery owner.
          msg.ack();
          await this.emitAdmissionRejected(sessionName, prompt, error.capacity.reason, {
            ...error.capacity,
            receipt: prompt._decisionDeliveryId,
            retainedBy: "decision",
            retryDelayMs: 30_000,
          });
          return;
        }
        const { item, created } = preserveRejectedRuntimeStart({ key, sessionName, prompt, capacity: error.capacity });
        msg.ack();
        await this.emitAdmissionRejected(sessionName, prompt, error.capacity.reason, {
          ...error.capacity,
          receipt: item.id,
          retainedBy: "inbox",
          recovery: "auto_resume_saved_envelope",
        });
        if (created) {
          await nats
            .emit("ravi.inbox.system.runtime_start_rejected", {
              inboxItemId: item.id,
              sessionName,
              reason: error.capacity.reason,
              occurredAt: new Date().toISOString(),
            })
            .catch((emitError) => log.warn("Failed to emit admission inbox event", { sessionName, error: emitError }));
        }
        // Only a person waits for this receipt. An automation turn (cron, trigger, follow-up, observer, task,
        // agent/system relay) has no one waiting: its `source` is just the chat it would have posted to, which can
        // be a group with outsiders. The saved inbox item and the runtime_start_rejected event above are the
        // operator's receipt. Same predicate as the SQLite capacity notice below.
        if (prompt.source && created && classifyTurnProvenance({ prompt }).background !== true) {
          const c = error.capacity;
          // Occupant identities belong in operator telemetry, never in an unrelated chat.
          const response =
            `Sem capacidade agora: ${c.active + c.reserved}/${c.max} sessões ocupadas` +
            (c.lane === "background" ? ` (limite de background: ${c.backgroundLimit})` : "") +
            `. Seu pedido foi salvo na caixa de entrada. Recibo: ${item.id}. ` +
            "Ele será retomado sozinho quando houver vaga; não é necessário reenviar a mensagem.";
          await nats
            .emit(`ravi.session.${sessionName}.response`, {
              response,
              target: prompt.source,
              _emitId: `capacity:${item.id}`,
              _pid: process.pid,
              _v: 2,
            })
            .catch((emitError) => log.warn("Failed to emit capacity receipt", { sessionName, error: emitError }));
        }
        return;
      }
      await this.emitAdmissionRejected(sessionName, prompt, "dispatch_failed");
      if (isSqliteCapacityError(error)) {
        log.error("Failed to handle prompt because SQLite/process memory (or disk) is exhausted", {
          sessionName,
          subject: msg.subject,
          error,
        });
        try {
          msg.ack();
        } catch (ackError) {
          log.warn("Failed to ACK prompt after sqlite capacity error", {
            sessionName,
            subject: msg.subject,
            error: ackError,
          });
        }
        this.emitSqliteCapacityTurnFailed(sessionName, prompt);
        if (classifyTurnProvenance({ prompt }).background !== true && prompt.source) {
          nats
            .emit(`ravi.session.${sessionName}.response`, {
              response: formatUserFacingTurnFailure(SQLITE_CAPACITY_USER_MESSAGE),
              target: prompt.source,
              _emitId: Math.random().toString(36).slice(2, 8),
              _pid: process.pid,
              _v: 2,
            })
            .catch((emitError) => {
              log.warn("Failed to emit sqlite capacity failure", { sessionName, error: emitError });
            });
        }
        return;
      }
      log.error("Failed to handle prompt before acknowledgement", {
        sessionName,
        subject: msg.subject,
        retryDelayMs: PROMPT_DISPATCH_RETRY_DELAY_MS,
        error,
      });
      try {
        msg.nak(PROMPT_DISPATCH_RETRY_DELAY_MS);
      } catch (nakError) {
        log.warn("Failed to NAK rejected prompt", {
          sessionName,
          subject: msg.subject,
          error: nakError,
        });
      }
      return;
    }

    try {
      msg.ack();
    } catch (error) {
      log.warn("Failed to ACK accepted prompt", {
        sessionName,
        subject: msg.subject,
        error,
      });
      return;
    }
    this.promptsReceived++;
  }

  private async emitPromptReceipt(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
    if (prompt._skipTurn) return;
    const provenance = classifyTurnProvenance({ prompt });
    await nats
      .emit(`ravi.session.${sessionName}.runtime`, {
        type: "prompt.received",
        sessionName,
        prompt: prompt.prompt,
        source: prompt.source,
        ...(prompt.source
          ? {
              _source: {
                ...prompt.source,
                suppressPresence: prompt.source.suppressPresence === true || provenance.background,
              },
            }
          : {}),
        context: prompt.context,
        deliveryBarrier: prompt.deliveryBarrier,
        deliveryBarrierSource: prompt.deliveryBarrierSource,
        taskBarrierTaskId: prompt.taskBarrierTaskId,
        commands: prompt.commands,
        observation: prompt._observation,
        ...(prompt._taskRuntime ? { taskRuntime: prompt._taskRuntime } : {}),
        turnProvenance: provenance,
        thread: prompt._thread,
        _agentId: prompt._agentId,
        timestamp: new Date().toISOString(),
      })
      .catch((error) => log.warn("Failed to emit prompt receipt", { sessionName, error }));
  }

  // Moved verbatim out of `dispatchPrompt`'s catch so that handler no longer builds a raw `turn.failed` envelope
  // inline. Rebuilding it through the shared diagnostic constructor is a separate change.
  private emitSqliteCapacityTurnFailed(sessionName: string, prompt: RuntimeLaunchPrompt): void {
    nats
      .emit(`ravi.session.${sessionName}.runtime`, {
        type: "turn.failed",
        error: SQLITE_CAPACITY_USER_MESSAGE,
        _turnProvenance: classifyTurnProvenance({ prompt }),
        recoverable: false,
        sessionName,
        timestamp: new Date().toISOString(),
      })
      .catch((emitError) => {
        log.warn("Failed to emit sqlite capacity runtime failure", { sessionName, error: emitError });
      });
  }

  private async emitAdmissionRejected(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await nats
      .emit(`ravi.session.${sessionName}.runtime`, {
        type: "dispatch.start_rejected",
        sessionName,
        reason,
        ...details,
        ...(prompt.source ? { _source: prompt.source } : {}),
        timestamp: new Date().toISOString(),
      })
      .catch((error) => log.warn("Failed to clear rejected prompt presence", { sessionName, error }));
  }

  private ensurePromptInfrastructureForHealthCheck(): void {
    if (this.healthProbeInFlight) return;
    this.healthProbeInFlight = true;
    this.ensurePromptInfrastructure({ force: true })
      .catch((error) => {
        log.warn("Subscriber health check: failed to verify prompt infrastructure", { error });
      })
      .finally(() => {
        this.healthProbeInFlight = false;
      });
  }

  private ensurePromptInfrastructure(options?: EnsureSessionPromptInfrastructureOptions): Promise<void> {
    return this.options.ensurePromptInfrastructure?.(options) ?? ensureSessionPromptInfrastructure(undefined, options);
  }
}

function isPromptBootstrapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("stream not found") ||
    message.includes("consumer not found") ||
    message.includes("consumer deleted") ||
    message.includes("no responders")
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

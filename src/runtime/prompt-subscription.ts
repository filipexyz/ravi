import { StringCodec } from "nats";
import { getNats, nats } from "../nats.js";
import {
  SESSION_STREAM,
  ensureSessionPromptInfrastructure,
  getConsumerName,
  type EnsureSessionPromptInfrastructureOptions,
} from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import type { RuntimeSessionPoolSnapshot } from "./session-pool.js";

const log = logger.child("runtime:prompt-subscription");
const PROMPT_DISPATCH_RETRY_DELAY_MS = 5_000;

export interface RuntimePromptSubscriptionOptions {
  isRunning(): boolean;
  canAcceptPrompt(sessionName: string): boolean;
  getStreamingSessionCount(): number;
  getRuntimeSessionPoolSnapshot?(): RuntimeSessionPoolSnapshot;
  ensurePromptInfrastructure?(options?: EnsureSessionPromptInfrastructureOptions): Promise<void>;
  markConsumerReady(): void;
  handlePrompt(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void>;
}

export class RuntimePromptSubscription {
  active = false;
  promptsReceived = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbeInFlight = false;

  constructor(private readonly options: RuntimePromptSubscriptionOptions) {}

  subscribe(): void {
    void this.run();
  }

  startHealthCheck(): void {
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

            try {
              // Keep the JetStream work item durable until the dispatcher has
              // accepted the prompt. Provider/bootstrap failures can happen
              // before a turn exists, so acknowledging earlier loses the only
              // retryable copy.
              await this.options.handlePrompt(sessionName, prompt);
            } catch (error) {
              log.error("Failed to handle prompt before acknowledgement", {
                sessionName,
                subject: msg.subject,
                retryDelayMs: PROMPT_DISPATCH_RETRY_DELAY_MS,
                error,
              });
              msg.nak(PROMPT_DISPATCH_RETRY_DELAY_MS);
              continue;
            }

            msg.ack();
            this.promptsReceived++;

            nats
              .emit(`ravi.session.${sessionName}.runtime`, {
                type: "prompt.received",
                sessionName,
                prompt: prompt.prompt,
                source: prompt.source,
                context: prompt.context,
                deliveryBarrier: prompt.deliveryBarrier,
                deliveryBarrierSource: prompt.deliveryBarrierSource,
                taskBarrierTaskId: prompt.taskBarrierTaskId,
                commands: prompt.commands,
                observation: prompt._observation,
                turnProvenance: classifyTurnProvenance({ prompt }),
                thread: prompt._thread,
                _agentId: prompt._agentId,
                timestamp: new Date().toISOString(),
              })
              .catch((error) => {
                log.warn("Failed to emit prompt audit event", {
                  sessionName,
                  error,
                });
              });
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

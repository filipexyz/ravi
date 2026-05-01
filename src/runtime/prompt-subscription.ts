import { StringCodec } from "nats";
import { getNats, nats } from "../nats.js";
import {
  SESSION_STREAM,
  ensureSessionConsumer,
  ensureSessionPromptsStream,
  getConsumerName,
} from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";

const log = logger.child("runtime:prompt-subscription");

export interface RuntimePromptSubscriptionOptions {
  isRunning(): boolean;
  getStreamingSessionCount(): number;
  markConsumerReady(): void;
  handlePrompt(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void>;
}

export class RuntimePromptSubscription {
  active = false;
  promptsReceived = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RuntimePromptSubscriptionOptions) {}

  subscribe(): void {
    void this.run();
  }

  startHealthCheck(): void {
    const healthCheckIntervalMs = 30_000;
    this.healthTimer = setInterval(() => {
      if (!this.options.isRunning()) return;

      if (!this.active) {
        log.warn("Subscriber health check: prompt subscription INACTIVE - forcing resubscribe", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.options.getStreamingSessionCount(),
        });
        this.subscribe();
      } else {
        log.debug("Subscriber health check: OK", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.options.getStreamingSessionCount(),
        });
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

    try {
      const nc = getNats();
      const jsm = await nc.jetstreamManager();
      const js = nc.jetstream();

      const consumerName = getConsumerName();
      await ensureSessionPromptsStream();
      await ensureSessionConsumer(jsm);

      while (this.options.isRunning()) {
        try {
          const consumer = await js.consumers.get(SESSION_STREAM, consumerName);
          const messages = await consumer.consume({ expires: 2000 });

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
              log.error("Failed to parse session prompt", { error: err, subject: msg.subject });
              msg.nak();
              continue;
            }

            msg.ack();
            this.promptsReceived++;

            const sessionName = msg.subject.split(".")[2];
            nats
              .emit(`ravi.session.${sessionName}.runtime`, {
                type: "prompt.received",
                sessionName,
                prompt: prompt.prompt,
                source: prompt.source,
                context: prompt.context,
                deliveryBarrier: prompt.deliveryBarrier,
                taskBarrierTaskId: prompt.taskBarrierTaskId,
                commands: prompt.commands,
                _agentId: prompt._agentId,
                timestamp: new Date().toISOString(),
              })
              .catch((error) => {
                log.warn("Failed to emit prompt audit event", { sessionName, error });
              });
            this.options.handlePrompt(sessionName, prompt).catch((err) => {
              log.error("Failed to handle prompt", err);
            });
          }

          if (!this.options.isRunning()) {
            break;
          }

          log.debug("Prompt pull window ended, renewing", { promptsReceived: this.promptsReceived });
        } catch (err) {
          if (!this.options.isRunning()) {
            break;
          }

          if (isPromptBootstrapError(err)) {
            log.warn("Prompt pull unavailable during bootstrap, re-ensuring stream/consumer", { error: err });
            await ensureSessionPromptsStream();
            await ensureSessionConsumer(jsm);
          } else {
            log.error("Prompt subscription error - will reconnect pull", { error: err });
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
      if (this.options.isRunning()) {
        setTimeout(() => this.subscribe(), 1000);
      }
    }
  }
}

function isPromptBootstrapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("stream not found") || message.includes("consumer not found");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

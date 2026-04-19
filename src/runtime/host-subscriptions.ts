import { nats } from "../nats.js";
import { SESSION_MODEL_CHANGED_TOPIC, type SessionModelChangedEvent } from "../session-control.js";
import { logger } from "../utils/logger.js";
import {
  handleRuntimeControlRequest as handleRuntimeControl,
  replyRuntimeControlError,
  type RuntimeControlNatsRequest,
} from "./control-host.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import type { RuntimeSessionDispatcher } from "./session-dispatcher.js";

const log = logger.child("runtime:host-subscriptions");

export interface RuntimeHostSubscriptionsOptions {
  isRunning(): boolean;
  dispatcher: RuntimeSessionDispatcher;
  safeEmit: RuntimeSafeEmit;
}

export class RuntimeHostSubscriptions {
  constructor(private readonly options: RuntimeHostSubscriptionsOptions) {}

  startAll(): void {
    void this.subscribeToSessionAborts();
    void this.subscribeToSessionModelChanges();
    void this.subscribeToRuntimeControls();
    void this.subscribeToTaskEvents();
  }

  async handleRuntimeControlRequest(data: RuntimeControlNatsRequest): Promise<void> {
    await handleRuntimeControl(data, {
      streamingSessions: this.options.dispatcher.streamingSessions,
      safeEmit: this.options.safeEmit,
    });
  }

  private async replyRuntimeControlError(replyTopic: string | undefined, error: string): Promise<void> {
    await replyRuntimeControlError(replyTopic, error, this.options.safeEmit);
  }

  private async subscribeToSessionAborts(): Promise<void> {
    while (this.options.isRunning()) {
      try {
        for await (const event of nats.subscribe("ravi.session.abort")) {
          if (!this.options.isRunning()) break;
          const data = event.data as { sessionKey?: string; sessionName?: string };
          const key = data.sessionName ?? data.sessionKey;
          if (!key) continue;
          const aborted = this.options.dispatcher.abortSession(key);
          log.info("Session abort request", { key, aborted });
        }
      } catch (err) {
        if (!this.options.isRunning()) break;
        log.warn("Session abort subscription error, reconnecting in 2s", { error: err });
        await delay(2000);
      }
    }
  }

  private async subscribeToRuntimeControls(): Promise<void> {
    while (this.options.isRunning()) {
      try {
        for await (const event of nats.subscribe("ravi.session.runtime.control")) {
          if (!this.options.isRunning()) break;
          try {
            await this.handleRuntimeControlRequest(event.data as RuntimeControlNatsRequest);
          } catch (error) {
            const data = event.data as RuntimeControlNatsRequest;
            await this.replyRuntimeControlError(
              data?.replyTopic,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } catch (err) {
        if (!this.options.isRunning()) break;
        log.warn("Runtime control subscription error, reconnecting in 2s", { error: err });
        await delay(2000);
      }
    }
  }

  private async subscribeToSessionModelChanges(): Promise<void> {
    while (this.options.isRunning()) {
      try {
        for await (const event of nats.subscribe(SESSION_MODEL_CHANGED_TOPIC)) {
          if (!this.options.isRunning()) break;
          const data = event.data as Partial<SessionModelChangedEvent>;
          const effectiveModel = typeof data.effectiveModel === "string" ? data.effectiveModel.trim() : "";
          if (!effectiveModel) continue;

          const keys = [data.sessionName, data.sessionKey]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim());

          for (const key of new Set(keys)) {
            const status = await this.options.dispatcher.applySessionModelChange(key, effectiveModel);
            if (status !== "missing") {
              log.info("Session model change applied", { key, effectiveModel, status });
              break;
            }
          }
        }
      } catch (err) {
        if (!this.options.isRunning()) break;
        log.warn("Session model change subscription error, reconnecting in 2s", { error: err });
        await delay(2000);
      }
    }
  }

  private async subscribeToTaskEvents(): Promise<void> {
    while (this.options.isRunning()) {
      try {
        for await (const event of nats.subscribe("ravi.task.*.event")) {
          if (!this.options.isRunning()) break;
          const data = event.data as {
            type?: string;
            taskId?: string;
            assigneeSessionName?: string | null;
            assigneeAgentId?: string | null;
            task?: { title?: string | null; summary?: string | null };
            event?: { type?: string; sessionName?: string | null };
          };
          const type = data.event?.type ?? data.type;
          const sessionName =
            type === "task.done" || type === "task.failed"
              ? (data.assigneeSessionName ?? data.event?.sessionName ?? undefined)
              : (data.event?.sessionName ?? data.assigneeSessionName ?? undefined);

          if ((type === "task.done" || type === "task.failed") && sessionName) {
            await this.options.dispatcher.startDeferredAfterTaskSessionIfDeliverable(sessionName);
            this.options.dispatcher.wakeStreamingSessionIfDeliverable(sessionName);
          }
        }
      } catch (err) {
        if (!this.options.isRunning()) break;
        log.warn("Task event subscription error, reconnecting in 2s", { error: err });
        await delay(2000);
      }
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

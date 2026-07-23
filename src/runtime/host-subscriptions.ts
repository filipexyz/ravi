import { nats } from "../nats.js";
import { deleteSession, getSessionByName } from "../router/sessions.js";
import { SESSION_MODEL_CHANGED_TOPIC, type SessionModelChangedEvent } from "../session-control.js";
import { logger } from "../utils/logger.js";
import {
  handleRuntimeControlRequest as handleRuntimeControl,
  replyRuntimeControlError,
  type RuntimeControlNatsRequest,
} from "./control-host.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import type { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import { isTaskRuntimeSessionName } from "../tasks/session-retention.js";

const log = logger.child("runtime:host-subscriptions");

export interface RuntimeHostSubscriptionsOptions {
  isRunning(): boolean;
  dispatcher: RuntimeSessionDispatcher;
  safeEmit: RuntimeSafeEmit;
}

interface RuntimeTaskEventPayload {
  type?: string;
  taskId?: string;
  assigneeSessionName?: string | null;
  assigneeAgentId?: string | null;
  task?: { title?: string | null; summary?: string | null };
  event?: {
    id?: number;
    type?: string;
    sessionName?: string | null;
  };
}

const TASK_RUNTIME_RELEASE_EVENTS = new Set(["task.done", "task.failed", "task.blocked"]);

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

  async handleTaskEventForRuntime(data: RuntimeTaskEventPayload): Promise<void> {
    const type = trimString(data.event?.type ?? data.type);
    const assigneeSessionName = trimString(data.assigneeSessionName);
    const eventSessionName = trimString(data.event?.sessionName);
    const releaseSessionName = resolveTaskRuntimeReleaseSessionName({
      taskId: data.taskId,
      assigneeSessionName,
      eventSessionName,
    });
    const deliverableSessionName =
      type === "task.done" || type === "task.failed"
        ? (assigneeSessionName ?? eventSessionName)
        : (eventSessionName ?? assigneeSessionName);

    if (type && TASK_RUNTIME_RELEASE_EVENTS.has(type) && releaseSessionName) {
      const reason = type === "task.blocked" ? "task_blocked_release" : "task_terminal_release";
      const aborted = this.options.dispatcher.abortSession(
        { sessionName: releaseSessionName },
        {
          source: "task_event",
          action: "task.runtime.release",
          reason,
          actor: eventSessionName,
          correlationId: buildTaskEventCorrelationId(data),
          request: {
            taskId: data.taskId,
            eventType: type,
            eventId: data.event?.id,
            assigneeSessionName,
            eventSessionName,
          },
        },
      );
      await this.options.safeEmit(`ravi.session.${releaseSessionName}.runtime`, {
        type: "task.runtime.release",
        taskId: data.taskId,
        taskEventType: type,
        eventId: data.event?.id,
        sessionName: releaseSessionName,
        aborted,
        reason,
        timestamp: new Date().toISOString(),
      });
    }

    if ((type === "task.done" || type === "task.failed") && deliverableSessionName) {
      await this.options.dispatcher.startDeferredAfterTaskSessionIfDeliverable(deliverableSessionName);
      this.options.dispatcher.wakeStreamingSessionIfDeliverable(deliverableSessionName);
    }

    // Delete ephemeral task-work sessions immediately on terminal events instead of waiting
    // for natural TTL expiry. Without this, sessions linger as zombies in `ravi sessions list`
    // for up to the session TTL (default 24h) even though the underlying task is `done`/`failed`.
    if (type && (type === "task.done" || type === "task.failed") && releaseSessionName) {
      const sessionEntry = getSessionByName(releaseSessionName);
      if (sessionEntry?.ephemeral === true && isTaskRuntimeSessionName(sessionEntry.name ?? releaseSessionName)) {
        deleteSession(sessionEntry.sessionKey);
        log.info("Deleted ephemeral task-work session after task terminal event", {
          sessionName: releaseSessionName,
          sessionKey: sessionEntry.sessionKey,
          taskId: data.taskId,
          eventType: type,
        });
      }
    }
  }

  private async replyRuntimeControlError(replyTopic: string | undefined, error: string): Promise<void> {
    await replyRuntimeControlError(replyTopic, error, this.options.safeEmit);
  }

  private async subscribeToSessionAborts(): Promise<void> {
    while (this.options.isRunning()) {
      try {
        for await (const event of nats.subscribe("ravi.session.abort")) {
          if (!this.options.isRunning()) break;
          const data = event.data as {
            sessionKey?: string;
            sessionName?: string;
            source?: string;
            action?: string;
            reason?: string;
            actor?: string;
            correlationId?: string;
          };
          const key = data.sessionName ?? data.sessionKey;
          if (!key) continue;
          const provenance = {
            source: data.source ?? "nats",
            action: data.action ?? "ravi.session.abort",
            reason: data.reason ?? "nats_abort_request",
            actor: data.actor,
            correlationId: data.correlationId,
            request: data,
          };
          const aborted = this.options.dispatcher.abortSession(
            { sessionName: data.sessionName, sessionKey: data.sessionKey },
            provenance,
          );
          this.options
            .safeEmit(`ravi.session.${key}.runtime`, {
              type: "session.abort.received",
              sessionName: data.sessionName,
              sessionKey: data.sessionKey,
              key,
              aborted,
              provenance,
              request: data,
              timestamp: new Date().toISOString(),
            })
            .catch((error) => {
              log.warn("Failed to emit session abort audit event", { key, error });
            });
          log.info("Session abort request", { key, aborted, provenance });
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
          await this.handleTaskEventForRuntime(event.data as RuntimeTaskEventPayload);
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

function resolveTaskRuntimeReleaseSessionName(input: {
  taskId?: string | null;
  assigneeSessionName?: string;
  eventSessionName?: string;
}): string | undefined {
  const candidates = [input.assigneeSessionName, input.eventSessionName].filter((value): value is string =>
    Boolean(value),
  );
  for (const candidate of candidates) {
    if (isTaskRuntimeSessionName(candidate)) {
      return candidate;
    }
    if (input.taskId && candidate.startsWith(`${input.taskId}-`)) {
      return candidate;
    }
  }
  return undefined;
}

function buildTaskEventCorrelationId(data: RuntimeTaskEventPayload): string | undefined {
  const taskId = trimString(data.taskId);
  if (!taskId) return undefined;
  return data.event?.id !== undefined ? `${taskId}:${data.event.id}` : taskId;
}

function trimString(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

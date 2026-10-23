import { resolveSession } from "../router/sessions.js";
import { getLatestSessionTurn } from "../session-trace/session-trace-db.js";
import { logger } from "../utils/logger.js";
import { resolveTaskCheckpointIntervalMs, TASK_CHECKPOINT_SWEEP_INTERVAL_MS } from "./checkpoint.js";
import { TASK_OBSERVER_ACTOR } from "./observer-contract.js";
import { neutralizeSystemMarkers } from "./progress-contract.js";
import { resolveTaskProfileForTask, taskProfileUsesObserver } from "./profiles.js";
import { dbAppendTaskEvent, dbGetActiveAssignment, dbListTasks, dbRegisterTaskCheckpointMiss } from "./task-db.js";
import {
  buildTaskCheckpointReminderPrompt,
  emitTaskEvent,
  publishTaskAssigneePrompt,
  reportTaskStall,
  resolveTaskAssigneeSession,
} from "./service.js";
import type { TaskAssignment, TaskEvent, TaskRecord } from "./types.js";

const log = logger.child("tasks:checkpoint-runner");

/** Record a stall and tell the requester. The observer never owns this path. */
export async function recordTaskStall(
  task: TaskRecord,
  message: string,
  actor: { actor: string; agentId?: string; sessionName?: string },
): Promise<TaskEvent> {
  const { task: current, event } = dbAppendTaskEvent(task.id, "task.stalled", {
    ...actor,
    message: neutralizeSystemMarkers(message),
    progress: task.progress,
  });
  await emitTaskEvent(current, event);
  try {
    await reportTaskStall(current, event);
  } catch (error) {
    log.warn("Failed to report task stall", { taskId: task.id, error });
  }
  return event;
}

/**
 * Tasks the checkpoint sweep may look at.
 *
 * Archived tasks keep their pre-archive status (the archive is a flag, not a
 * status): without the explicit exclude an archived-but-in_progress task keeps
 * being swept and reports checkpoint.missed/task.stalled forever.
 */
export function listTaskCheckpointSweepTasks(): TaskRecord[] {
  return [
    ...dbListTasks({ status: "dispatched", archiveMode: "exclude" }),
    ...dbListTasks({ status: "in_progress", archiveMode: "exclude" }),
  ];
}

/** When this process started; the checkpoint runner runs inside the daemon. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * What an observed task's silence means, from the worker's persisted turns.
 *
 * The checkpoint only moves on task mutations, so a miss says the observer
 * recorded nothing, not that the worker stopped. The session trace survives a
 * daemon restart, unlike the in-memory runtime session map, so it is what
 * tells a hung or missing worker apart from a worker that answered and an
 * observer that never wrote it down. A turn left `running` by a process that
 * has since exited is not running.
 */
export function describeObservedTaskSilence(
  assignment: Pick<TaskAssignment, "sessionName" | "assignedAt" | "checkpointLastReportAt">,
  silentForMinutes: number,
  now = Date.now(),
  processStartedAt = PROCESS_STARTED_AT,
): string {
  const fallback = `No worker activity seen for ${silentForMinutes} min; the turn may be hung or the session gone.`;
  try {
    const session = resolveSession(assignment.sessionName);
    if (!session) return fallback;
    const turn = getLatestSessionTurn(session.sessionKey, assignment.assignedAt);
    if (!turn) return fallback;
    if (turn.status === "running" || !turn.completedAt) {
      if (turn.startedAt < processStartedAt) {
        return `The worker turn started before the last daemon restart and has no recorded end; it may have died with the daemon.`;
      }
      return `The worker turn is still running, but the task has recorded no status for ${silentForMinutes} min; the task observer may not be reading the worker.`;
    }
    const agoMinutes = Math.max(0, Math.round((now - turn.completedAt) / 60000));
    const silence = assignment.checkpointLastReportAt
      ? `no task status was recorded since the last report ${Math.max(0, Math.round((now - assignment.checkpointLastReportAt) / 60000))} min ago`
      : "no task status was recorded after dispatch";
    return `The worker turn ended (${turn.status}) ${agoMinutes} min ago, but ${silence}; the task observer may not be reading the worker.`;
  } catch (error) {
    log.warn("Could not read the worker turn for an observed task stall", {
      sessionName: assignment.sessionName,
      error,
    });
    return fallback;
  }
}

export interface TaskCheckpointRunnerOptions {
  canPublishSessionPrompt?(sessionName: string): boolean;
}

export class TaskCheckpointRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sweeping = false;

  constructor(private options: TaskCheckpointRunnerOptions = {}) {}

  configure(options: TaskCheckpointRunnerOptions): void {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting task checkpoint runner", {
      sweepIntervalMs: TASK_CHECKPOINT_SWEEP_INTERVAL_MS,
    });

    await this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, TASK_CHECKPOINT_SWEEP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    log.info("Stopped task checkpoint runner");
  }

  async sweep(now = Date.now()): Promise<number> {
    if (!this.running || this.sweeping) {
      return 0;
    }

    this.sweeping = true;
    let reminders = 0;
    let stalls = 0;

    try {
      const tasks = listTaskCheckpointSweepTasks();

      for (const task of tasks) {
        if (!this.running) break;

        try {
          const assignment = dbGetActiveAssignment(task.id);
          if (!assignment?.checkpointDueAt || assignment.checkpointDueAt > now) {
            continue;
          }

          if (this.options.canPublishSessionPrompt && !this.options.canPublishSessionPrompt(assignment.sessionName)) {
            log.warn("Task checkpoint reminder delayed by runtime session pool backpressure", {
              taskId: task.id,
              sessionName: assignment.sessionName,
            });
            continue;
          }

          // An observed task's worker is never asked for status. Its checkpoint is a
          // silence detector that only moves on task mutations (reports, status
          // changes), so a miss means nothing was recorded for a whole interval. The
          // requester hears it once, with what the worker's turns say about why.
          if (taskProfileUsesObserver(resolveTaskProfileForTask(task))) {
            const silentForMinutes = Math.round(
              resolveTaskCheckpointIntervalMs(assignment.checkpointIntervalMs) / 60000,
            );
            const previousOverdue = assignment.checkpointOverdueCount ?? 0;
            const missed = dbRegisterTaskCheckpointMiss(task.id, assignment.id, now, {
              message: (count) => `No worker activity seen by the task observer for ${count * silentForMinutes} min.`,
            });
            if (!missed) continue;
            stalls += 1;
            await emitTaskEvent(missed.task, missed.event);
            if (previousOverdue === 0) {
              await recordTaskStall(
                missed.task,
                describeObservedTaskSilence(missed.assignment, silentForMinutes, now),
                { actor: TASK_OBSERVER_ACTOR },
              );
            }
            continue;
          }

          const missed = dbRegisterTaskCheckpointMiss(task.id, assignment.id, now);
          if (!missed) {
            continue;
          }

          await emitTaskEvent(missed.task, missed.event);

          const target = resolveTaskAssigneeSession(missed.task, missed.assignment);
          if (!target.ok) {
            log.warn("Task checkpoint reminder not delivered to the assignee", {
              taskId: task.id,
              reason: target.reason,
            });
            continue;
          }

          reminders += 1;
          await publishTaskAssigneePrompt(missed.task, target, {
            prompt: buildTaskCheckpointReminderPrompt(missed.task, {
              ...missed.assignment,
              checkpointOverdueCount: missed.assignment.checkpointOverdueCount ?? missed.missedCount,
            }),
            deliveryBarrier: "after_response",
            deliveryBarrierSource: "default",
          });
        } catch (error) {
          log.error("Task checkpoint reminder failed", { taskId: task.id, error });
        }
      }

      if (reminders > 0 || stalls > 0) {
        log.info("Task checkpoint sweep emitted", { reminders, stalls });
      }

      return reminders + stalls;
    } catch (error) {
      log.error("Task checkpoint sweep failed", { error });
      return reminders;
    } finally {
      this.sweeping = false;
    }
  }
}

let runner: TaskCheckpointRunner | null = null;

export function getTaskCheckpointRunner(options?: TaskCheckpointRunnerOptions): TaskCheckpointRunner {
  if (!runner) {
    runner = new TaskCheckpointRunner(options);
  } else if (options) {
    runner.configure(options);
  }
  return runner;
}

export async function startTaskCheckpointRunner(options?: TaskCheckpointRunnerOptions): Promise<void> {
  await getTaskCheckpointRunner(options).start();
}

export async function stopTaskCheckpointRunner(): Promise<void> {
  await getTaskCheckpointRunner().stop();
}

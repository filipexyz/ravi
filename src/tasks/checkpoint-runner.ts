import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { TASK_CHECKPOINT_SWEEP_INTERVAL_MS } from "./checkpoint.js";
import { dbGetActiveAssignment, dbListTasks, dbRegisterTaskCheckpointMiss } from "./task-db.js";
import { buildTaskCheckpointReminderPrompt, emitTaskEvent } from "./service.js";

const log = logger.child("tasks:checkpoint-runner");

export class TaskCheckpointRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sweeping = false;

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

    try {
      const tasks = [...dbListTasks({ status: "dispatched" }), ...dbListTasks({ status: "in_progress" })];

      for (const task of tasks) {
        if (!this.running) break;

        try {
          const assignment = dbGetActiveAssignment(task.id);
          if (!assignment?.checkpointDueAt || assignment.checkpointDueAt > now) {
            continue;
          }

          const missed = dbRegisterTaskCheckpointMiss(task.id, assignment.id, now);
          if (!missed) {
            continue;
          }

          reminders += 1;
          await emitTaskEvent(missed.task, missed.event);

          await publishSessionPrompt(missed.assignment.sessionName, {
            prompt: buildTaskCheckpointReminderPrompt(missed.task, {
              ...missed.assignment,
              checkpointOverdueCount: missed.assignment.checkpointOverdueCount ?? missed.missedCount,
            }),
            deliveryBarrier: "after_response",
          });
        } catch (error) {
          log.error("Task checkpoint reminder failed", { taskId: task.id, error });
        }
      }

      if (reminders > 0) {
        log.info("Task checkpoint reminders emitted", { reminders });
      }

      return reminders;
    } catch (error) {
      log.error("Task checkpoint sweep failed", { error });
      return reminders;
    } finally {
      this.sweeping = false;
    }
  }
}

let runner: TaskCheckpointRunner | null = null;

export function getTaskCheckpointRunner(): TaskCheckpointRunner {
  if (!runner) {
    runner = new TaskCheckpointRunner();
  }
  return runner;
}

export async function startTaskCheckpointRunner(): Promise<void> {
  await getTaskCheckpointRunner().start();
}

export async function stopTaskCheckpointRunner(): Promise<void> {
  await getTaskCheckpointRunner().stop();
}

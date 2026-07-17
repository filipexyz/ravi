import { logger } from "../utils/logger.js";

const log = logger.child("runtime:provider-quota");
type TaskRuntime = typeof import("../tasks/index.js");

export async function blockTaskForProviderQuota(input: {
  taskId: string;
  agentId: string;
  sessionName: string;
  error: string;
  emitEvents?: boolean;
}): Promise<boolean> {
  let result: ReturnType<TaskRuntime["blockTask"]>;
  let emitTaskEvent: TaskRuntime["emitTaskEvent"];
  try {
    const taskRuntime = await import("../tasks/index.js");
    emitTaskEvent = taskRuntime.emitTaskEvent;
    const detail = input.error
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    result = taskRuntime.blockTask(input.taskId, {
      actor: "runtime:provider-quota",
      agentId: input.agentId,
      sessionName: input.sessionName,
      message: `Provider quota exhausted: ${detail || "quota exhausted"}`,
    });
  } catch (error) {
    log.warn("Failed to persist task block after provider quota exhaustion", {
      taskId: input.taskId,
      sessionName: input.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (result.wasNoop) return result.task.status === "blocked";
  if (input.emitEvents === false) return true;
  try {
    await emitTaskEvent(result.task, result.event);
    for (const relatedEvent of result.relatedEvents) {
      await emitTaskEvent(relatedEvent.task, relatedEvent.event);
    }
  } catch (error) {
    log.warn("Task was blocked for provider quota, but event publication failed", {
      taskId: input.taskId,
      sessionName: input.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

export async function failTaskForRuntimeStartFailure(input: {
  taskId: string;
  agentId: string;
  sessionName: string;
  error: string;
  emitEvents?: boolean;
}): Promise<boolean> {
  let result: ReturnType<TaskRuntime["failTask"]>;
  let emitTaskEvent: TaskRuntime["emitTaskEvent"];
  try {
    const taskRuntime = await import("../tasks/index.js");
    emitTaskEvent = taskRuntime.emitTaskEvent;
    const detail = input.error
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    result = taskRuntime.failTask(input.taskId, {
      actor: "runtime:start-failure",
      agentId: input.agentId,
      sessionName: input.sessionName,
      message: `Runtime start failed: ${detail || "startup failed"}`,
    });
  } catch (error) {
    log.warn("Failed to persist task failure after runtime start failure", {
      taskId: input.taskId,
      sessionName: input.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (result.wasNoop) return result.task.status === "failed";
  if (input.emitEvents === false) return true;
  try {
    await emitTaskEvent(result.task, result.event);
    for (const relatedEvent of result.relatedEvents) {
      await emitTaskEvent(relatedEvent.task, relatedEvent.event);
    }
  } catch (error) {
    log.warn("Task was failed for runtime start failure, but event publication failed", {
      taskId: input.taskId,
      sessionName: input.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

import type { AgentConfig, SessionEntry } from "../router/index.js";
import { resolveTaskProfileForTask } from "../tasks/profiles.js";
import { resolveTaskRuntimeOptions } from "../tasks/runtime-options.js";
import { emitTaskEvent } from "../tasks/service.js";
import { dbMarkTaskAcceptedForSession, dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { logger } from "../utils/logger.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";

const log = logger.child("runtime:task-context");

export function resolveRuntimeForPrompt(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  session: SessionEntry | null | undefined;
  agent: AgentConfig;
  configModel: string;
}): TaskRuntimeResolution {
  const binding = options.prompt.taskBarrierTaskId
    ? dbResolveActiveTaskBindingForSession(options.sessionName, options.prompt.taskBarrierTaskId)
    : null;
  const profile = (() => {
    if (!binding) {
      return null;
    }
    try {
      return resolveTaskProfileForTask(binding.task);
    } catch (error) {
      log.warn("Task runtime profile unavailable while resolving runtime options", {
        sessionName: options.sessionName,
        taskId: binding.task.id,
        profileId: binding.task.profileId,
        error,
      });
      return null;
    }
  })();

  const promptOverride =
    options.prompt._observation && options.prompt._runtimeModel ? { model: options.prompt._runtimeModel } : undefined;

  return resolveTaskRuntimeOptions({
    promptOverride,
    task: binding?.task,
    assignment: binding?.assignment,
    profile,
    sessionModelOverride: options.session?.modelOverride,
    sessionThinkingLevel: options.session?.thinkingLevel,
    agentModel: options.agent.model,
    configModel: options.configModel,
  });
}

export function runtimePromptRequiresRestart(
  streaming: RuntimeHostStreamingSession,
  runtime: TaskRuntimeResolution,
  prompt: RuntimeLaunchPrompt,
): boolean {
  return (
    streaming.currentTaskBarrierTaskId !== normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ||
    streaming.currentEffort !== runtime.options.effort ||
    streaming.currentThinking !== runtime.options.thinking
  );
}

export async function markRuntimeTaskAcceptedForPrompt(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
): Promise<void> {
  if (!prompt.taskBarrierTaskId) {
    return;
  }

  const acceptedTask = dbMarkTaskAcceptedForSession(sessionName, prompt.taskBarrierTaskId);
  if (!acceptedTask?.event) {
    return;
  }

  try {
    await emitTaskEvent(acceptedTask.task, acceptedTask.event);
  } catch (error) {
    log.warn("Failed to emit task bootstrap event", {
      taskId: acceptedTask.task.id,
      sessionName,
      error,
    });
  }
}

import { DEFAULT_DELIVERY_BARRIER } from "../delivery-barriers.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import { resolveTaskProfileForTask } from "../tasks/profiles.js";
import { resolveTaskRuntimeOptions } from "../tasks/runtime-options.js";
import { emitTaskEvent } from "../tasks/service.js";
import { dbGetTask, dbMarkTaskAcceptedForSession, dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import type { TaskRuntimeOptionsSource, TaskRuntimeResolution } from "../tasks/types.js";
import { logger } from "../utils/logger.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveAgentModelSelection } from "./model-preset-resolver.js";
import { resolveRuntimeDefaults } from "./runtime-defaults.js";
import { assertUsableAgentModelPreset } from "./runtime-selection.js";

const log = logger.child("runtime:task-context");

export function resolveRuntimeForPrompt(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  session: SessionEntry | null | undefined;
  agent: AgentConfig;
  configModel?: string;
  configModelSource?: Extract<TaskRuntimeOptionsSource, "global_default" | "env_fallback" | "runtime_default">;
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

  const agentSelection = resolveAgentModelSelection(options.agent);
  if (agentSelection.warning) {
    log.warn("Agent model selection drift", {
      sessionName: options.sessionName,
      agentId: options.agent.id,
      warning: agentSelection.warning,
    });
  }
  if (agentSelection.error) {
    log.warn("Agent model preset unusable; not applying agent-level model", {
      sessionName: options.sessionName,
      agentId: options.agent.id,
      modelPresetId: agentSelection.modelPresetId,
      error: agentSelection.error,
    });
  }

  const hasHigherPriorityModel = Boolean(
    promptOverride?.model ||
      binding?.assignment?.runtimeOverride?.model ||
      binding?.task?.runtimeOverride?.model ||
      profile?.runtimeDefaults?.model ||
      options.session?.modelOverride,
  );
  assertUsableAgentModelPreset({
    error: agentSelection.error,
    modelPresetId: agentSelection.modelPresetId,
    shadowedByHigherModel: hasHigherPriorityModel,
  });

  const agentModelPreset =
    agentSelection.modelSource === "agent_preset" &&
    agentSelection.effectiveModel &&
    agentSelection.modelPresetId &&
    agentSelection.modelPresetVersion !== null
      ? {
          model: agentSelection.effectiveModel,
          presetId: agentSelection.modelPresetId,
          version: agentSelection.modelPresetVersion,
        }
      : null;
  const agentModel = agentSelection.modelSource === "agent_default" ? agentSelection.effectiveModel : undefined;
  const defaults = resolveRuntimeDefaults();
  const configModel = options.configModel ?? defaults.model.value;
  const configModelSource =
    options.configModelSource ??
    (options.configModel && options.configModel !== defaults.model.value ? "global_default" : defaults.model.source);

  return resolveTaskRuntimeOptions({
    promptOverride,
    task: binding?.task,
    assignment: binding?.assignment,
    profile,
    sessionModelOverride: options.session?.modelOverride,
    sessionEffortOverride: options.session?.effortOverride,
    sessionThinkingLevel: options.session?.thinkingLevel,
    agentModel,
    agentModelPreset,
    agentEffort: options.agent.effort,
    configModel,
    configModelSource,
    configEffort: defaults.effort.source === "global_default" ? defaults.effort.value : undefined,
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

/** Task states whose binding a task-less prompt inherits. A blocked task waits for its own resume. */
const INHERITABLE_TASK_STATUSES = new Set(["dispatched", "in_progress"]);

export function isInheritableTaskBinding(taskId: string | undefined): boolean {
  const normalized = normalizePromptTaskBarrierTaskId(taskId);
  if (!normalized) return false;
  const task = dbGetTask(normalized);
  return Boolean(task && INHERITABLE_TASK_STATUSES.has(task.status));
}

/**
 * A prompt without a task binding (inform, send, ask, task comment, checkpoint
 * reminder) that reaches a session holding a dispatched or in-progress task
 * runs inside that task's binding, so it never relaunches the session without
 * `RAVI_TASK_*`, the task's runtime options or its capabilities. `after_task`
 * prompts keep no binding: they wait for the task to end, and a task id on
 * them would exempt them from that wait.
 */
export function resolveInheritedTaskBindingTaskId(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  liveTaskBarrierTaskId?: string;
}): string | undefined {
  const { prompt } = options;
  if (normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId)) return undefined;
  if (prompt._observation || prompt._resumeStashedMessages || prompt._daemonRestartResume) return undefined;
  if ((prompt.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER) === "after_task") return undefined;

  const liveTaskId = normalizePromptTaskBarrierTaskId(options.liveTaskBarrierTaskId);
  const binding = liveTaskId
    ? dbResolveActiveTaskBindingForSession(options.sessionName, liveTaskId)
    : dbResolveActiveTaskBindingForSession(options.sessionName);
  if (!binding || binding.assignment.status === "blocked") return undefined;
  return INHERITABLE_TASK_STATUSES.has(binding.task.status) ? binding.task.id : undefined;
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

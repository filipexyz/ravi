import type {
  TaskAssignment,
  TaskLaunchPlan,
  TaskProfileDefinition,
  TaskRecord,
  TaskRuntimeEffort,
  TaskRuntimeOptions,
  TaskRuntimeOptionsSource,
  TaskRuntimeResolution,
  TaskRuntimeThinking,
} from "./types.js";

export const TASK_RUNTIME_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TASK_RUNTIME_THINKING_LEVELS = ["off", "normal", "verbose"] as const;

function normalizeTaskRuntimeString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function normalizeTaskRuntimeEffort(value?: string | null): TaskRuntimeEffort | undefined {
  const normalized = normalizeTaskRuntimeString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!TASK_RUNTIME_EFFORT_LEVELS.includes(normalized as TaskRuntimeEffort)) {
    throw new Error(`Invalid runtime effort: ${value}. Use ${TASK_RUNTIME_EFFORT_LEVELS.join("|")}.`);
  }
  return normalized as TaskRuntimeEffort;
}

export function normalizeTaskRuntimeThinking(value?: string | null): TaskRuntimeThinking | undefined {
  const normalized = normalizeTaskRuntimeString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!TASK_RUNTIME_THINKING_LEVELS.includes(normalized as TaskRuntimeThinking)) {
    throw new Error(`Invalid runtime thinking: ${value}. Use ${TASK_RUNTIME_THINKING_LEVELS.join("|")}.`);
  }
  return normalized as TaskRuntimeThinking;
}

export function normalizeTaskRuntimeOptions(
  input?: Partial<TaskRuntimeOptions> | null,
): TaskRuntimeOptions | undefined {
  if (!input) {
    return undefined;
  }

  const model = normalizeTaskRuntimeString(input.model);
  const effort = normalizeTaskRuntimeEffort(input.effort);
  const thinking = normalizeTaskRuntimeThinking(input.thinking);
  const normalized: TaskRuntimeOptions = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeTaskRuntimeOptions(
  base?: TaskRuntimeOptions | null,
  override?: TaskRuntimeOptions | null,
): TaskRuntimeOptions | undefined {
  return normalizeTaskRuntimeOptions({
    ...(base ?? {}),
    ...(override ?? {}),
  });
}

function getRuntimeOptionSource(
  source: TaskRuntimeOptionsSource,
  options: TaskRuntimeOptions | undefined,
  key: keyof TaskRuntimeOptions,
): TaskRuntimeOptionsSource | null {
  return options?.[key] ? source : null;
}

export function formatTaskRuntimeOptions(options?: TaskRuntimeOptions | null): string {
  const normalized = normalizeTaskRuntimeOptions(options);
  if (!normalized) {
    return "-";
  }
  return [
    normalized.model ? `model=${normalized.model}` : null,
    normalized.effort ? `effort=${normalized.effort}` : null,
    normalized.thinking ? `thinking=${normalized.thinking}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

export function resolveTaskRuntimeOptions(input: {
  task?: Pick<TaskRecord, "runtimeOverride"> | null;
  profile?: Pick<TaskProfileDefinition, "runtimeDefaults"> | null;
  assignment?: Pick<TaskAssignment, "runtimeOverride"> | null;
  launchPlan?: Pick<TaskLaunchPlan, "runtimeOverride"> | null;
  sessionModelOverride?: string | null;
  sessionThinkingLevel?: TaskRuntimeThinking | string | null;
  agentModel?: string | null;
  configModel?: string | null;
}): TaskRuntimeResolution {
  const dispatchOverride = normalizeTaskRuntimeOptions(
    input.assignment?.runtimeOverride ?? input.launchPlan?.runtimeOverride,
  );
  const taskOverride = normalizeTaskRuntimeOptions(input.task?.runtimeOverride);
  const profileDefaults = normalizeTaskRuntimeOptions(input.profile?.runtimeDefaults);
  const sessionThinking = normalizeTaskRuntimeThinking(input.sessionThinkingLevel);
  const sessionOptions = normalizeTaskRuntimeOptions({
    model: input.sessionModelOverride ?? undefined,
    ...(sessionThinking ? { thinking: sessionThinking } : {}),
  });
  const agentOptions = normalizeTaskRuntimeOptions({ model: input.agentModel ?? undefined });
  const configOptions = normalizeTaskRuntimeOptions({ model: input.configModel ?? undefined });

  const sources: Array<[TaskRuntimeOptionsSource, TaskRuntimeOptions | undefined]> = [
    ["dispatch_override", dispatchOverride],
    ["task_override", taskOverride],
    ["profile_default", profileDefaults],
    ["session_override", sessionOptions],
    ["agent_default", agentOptions],
    ["global_default", configOptions],
  ];

  const pick = (key: keyof TaskRuntimeOptions): { value?: string; source: TaskRuntimeOptionsSource | null } => {
    for (const [source, options] of sources) {
      const optionSource = getRuntimeOptionSource(source, options, key);
      if (optionSource) {
        return { value: options?.[key], source };
      }
    }
    return { source: null };
  };

  const model = pick("model");
  const effort = pick("effort");
  const thinking = pick("thinking");

  return {
    options: {
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value as TaskRuntimeEffort } : {}),
      ...(thinking.value ? { thinking: thinking.value as TaskRuntimeThinking } : {}),
    },
    sources: {
      model: model.source,
      effort: effort.source,
      thinking: thinking.source,
    },
    hasTaskRuntimeContext: Boolean(dispatchOverride || taskOverride || profileDefaults),
  };
}

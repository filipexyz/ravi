export const RUNTIME_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type RuntimeEffort = (typeof RUNTIME_EFFORT_LEVELS)[number];

export const DEFAULT_RUNTIME_EFFORT: RuntimeEffort = "xhigh";

export type StrongestCompatibleRuntimeEffort = Exclude<RuntimeEffort, "xhigh"> | "max";

function normalizeRuntimeString(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function formatRuntimeEffortLevels(): string {
  return RUNTIME_EFFORT_LEVELS.join("|");
}

export function normalizeRuntimeEffort(value?: string | null): RuntimeEffort | undefined {
  const normalized = normalizeRuntimeString(value);
  if (!normalized) {
    return undefined;
  }

  if (!RUNTIME_EFFORT_LEVELS.includes(normalized as RuntimeEffort)) {
    return DEFAULT_RUNTIME_EFFORT;
  }
  return normalized as RuntimeEffort;
}

export function resolveRuntimeEffort(value?: string | null): RuntimeEffort {
  return normalizeRuntimeEffort(value) ?? DEFAULT_RUNTIME_EFFORT;
}

export function toCodexRuntimeEffort(value?: string | null): RuntimeEffort {
  return resolveRuntimeEffort(value);
}

export function toStrongestCompatibleRuntimeEffort(value?: string | null): StrongestCompatibleRuntimeEffort {
  const effort = resolveRuntimeEffort(value);
  return effort === "xhigh" ? "max" : effort;
}

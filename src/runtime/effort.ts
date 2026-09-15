export const RUNTIME_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type RuntimeEffort = (typeof RUNTIME_EFFORT_LEVELS)[number];

export const DEFAULT_RUNTIME_EFFORT: RuntimeEffort = "xhigh";

/** CLI-only session bootstrap. Do not change the global WhatsApp/Slack default. */
export const CLI_SESSION_BOOTSTRAP_EFFORT: RuntimeEffort = "high";

export type StrongestCompatibleRuntimeEffort = "low" | "medium" | "high" | "max";

const STRONGEST_COMPATIBLE_BY_EFFORT: Record<RuntimeEffort, StrongestCompatibleRuntimeEffort> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
  ultra: "max",
};

function normalizeRuntimeString(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function formatRuntimeEffortLevels(): string {
  return RUNTIME_EFFORT_LEVELS.join("|");
}

export function isRuntimeEffort(value: string): value is RuntimeEffort {
  return (RUNTIME_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function normalizeRuntimeEffort(value?: string | null): RuntimeEffort | undefined {
  const normalized = normalizeRuntimeString(value);
  if (!normalized) {
    return undefined;
  }
  return isRuntimeEffort(normalized) ? normalized : undefined;
}

export function parseRuntimeEffort(value?: string | null): RuntimeEffort | undefined {
  const normalized = normalizeRuntimeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!isRuntimeEffort(normalized)) {
    throw new Error(`Invalid runtime effort: ${value}. Use ${formatRuntimeEffortLevels()}.`);
  }
  return normalized;
}

export function resolveRuntimeEffort(value?: string | null): RuntimeEffort {
  return normalizeRuntimeEffort(value) ?? DEFAULT_RUNTIME_EFFORT;
}

export function toCodexRuntimeEffort(value?: string | null): RuntimeEffort {
  return resolveRuntimeEffort(value);
}

export function toStrongestCompatibleRuntimeEffort(value?: string | null): StrongestCompatibleRuntimeEffort {
  return STRONGEST_COMPATIBLE_BY_EFFORT[resolveRuntimeEffort(value)];
}
